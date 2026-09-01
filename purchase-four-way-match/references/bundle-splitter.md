---
name: bundle-splitter
description: Segments a batch of attachments into their constituent documents for the four-way match — a single PDF may be a bundle concatenating an invoice + GRN + PO (possibly several such triples, possibly partial). Reads each attachment's content.md page heads, assigns a doc_type per page, and groups contiguous pages into document segments at document-start boundaries. Emits one segment list per attachment (single-doc PDFs yield one segment). Read-only; the orchestrator dispatches extraction per segment.
---

# Bundle splitter (four-way match fan-out sub-agent)

You take a batch of attachment stems and **classify + segment** them. This is the four-way
skill's **always-on** first pass over every attachment (not just suspected bundles) — the
orchestrator never reads `content.md` itself, so you do it here and hand back a compact list.
Per attachment, decide whether it is a **single document** or a **bundle** — a PDF that
concatenates several documents (e.g. invoice + GRN + PO, possibly several such sets, possibly
partial) — and **segment** it into constituent documents as **page ranges**, each tagged with a
`doc_type` (`po | grn | invoice | other`). A single-document PDF yields exactly one segment. You
do **not** extract field values — that is the extractors' job, later, scoped to your page
ranges. Run in your own context; write to a file.

A bundle is just concatenated PDFs, so each constituent document starts on a fresh page with
its own **document title** at the head ("Tax Invoice" / "Purchase Order" / "Goods Receipt
Note"). Your whole job: read each page's head, mark **document-start boundaries**, and group
the pages between boundaries into segments.

## Container isolation
First `container_python` call passes `create_new_context: true`; capture the `contextId` and
pass `context_id: "<uuid>"` on every later call.

## Inputs (from the task text)
- `file_stems` — the attachment stems for this batch (the hashed names; `content.md` lives at
  `/home/sandbox/attachments/<stem>/content.md`).
- `output_path` — where to write the batch JSON.

## How to work
1. For each stem, read its `content.md` (`cat /home/sandbox/attachments/<stem>/content.md`).
   It is paginated with `## Page N` anchors (OCR for scanned pages, plus reconstructed tables).
2. Split on the `## Page N` anchors → one head block per page. For each page, read its **head**
   (the first ~15 non-empty lines) and assign a `doc_type` from its **document title**:
   - `invoice` — "Tax Invoice", "GST Invoice", "Bill of Supply", "Invoice" (a vendor→buyer bill
     that charges tax).
   - `po` — "Purchase Order", "PO No"/"P.O.", a buyer-header + Level-1/2 approval table.
   - `grn` — "Goods Receipt Note", "GRN", "Material Receipt", "Goods Received Note", "MRN".
   - `continuation` — no fresh document title at the head → this page **continues** the previous
     document (a multi-page invoice/PO/GRN).
3. **Document-start boundaries:** the first page is always a start. A later page is a start when
   its head carries a document title (any of the three types). Each start opens a new segment;
   `continuation` pages (and pages with no fresh title) extend the current segment. **This
   correctly splits two same-type documents back-to-back** (two POs in a row = two starts = two
   segments), which a naive "group by doc_type" would wrongly merge.
4. Build the per-attachment segment list. `is_bundle = (len(segments) > 1)`.

Commit to this parser:
```python
import re, json, glob
OUTPUT_PATH = "/home/sandbox/outputs/4w-segments-0.json"
file_stems = ["bundle-abc", "single-inv-xyz"]   # from the task text

TITLES = [
    ("invoice", re.compile(r"\b(tax invoice|gst invoice|bill of supply|^invoice\b)", re.I)),
    ("grn",     re.compile(r"\b(goods receipt note|goods received note|material receipt|\bgrn\b|\bmrn\b)", re.I)),
    ("po",      re.compile(r"\b(purchase order|^p\.?\s*o\.?\b|po number|po no\b)", re.I)),
]
def classify_head(head):
    for dt, rx in TITLES:
        if rx.search(head): return dt
    return "continuation"

attachments, diags = [], []
for stem in file_stems:
    paths = glob.glob(f"/home/sandbox/attachments/{stem}/content.md")
    if not paths:
        diags.append({"stem": stem, "type": "no_content_md"}); continue
    raw = open(paths[0]).read()
    # split into (page_no, page_text) on "## Page N" anchors
    parts = re.split(r"(?mi)^##\s*Page\s+(\d+)\s*$", raw)
    pages = []                                   # [(page_no:int, text)]
    for i in range(1, len(parts), 2):
        pages.append((int(parts[i]), parts[i+1]))
    if not pages:                                # no anchors → treat whole file as page 1
        pages = [(1, raw)]
    segs, cur = [], None
    for pno, text in pages:
        head = "\n".join([l for l in text.splitlines() if l.strip()][:15])
        dt = classify_head(head)
        is_start = (cur is None) or (dt != "continuation")
        if is_start:
            if cur: segs.append(cur)
            cur = {"segment_index": len(segs), "doc_type": dt if dt != "continuation" else "other",
                   "first_page": pno, "last_page": pno,
                   "start_header": head.splitlines()[0][:80] if head.strip() else ""}
        else:
            cur["last_page"] = pno               # continuation extends the current segment
    if cur: segs.append(cur)
    for s in segs:                               # render pages as "a" or "a-b"
        s["pages"] = str(s["first_page"]) if s["first_page"] == s["last_page"] else f'{s["first_page"]}-{s["last_page"]}'
        del s["first_page"]; del s["last_page"]
        if s["doc_type"] == "other":
            diags.append({"stem": stem, "type": "unclassified_segment", "segment": s["segment_index"]})
    attachments.append({"stem": stem, "page_count": len(pages),
                        "is_bundle": len(segs) > 1, "segments": segs})

out = {"agent": "bundle_splitter_4w", "attachments": attachments, "diagnostics": diags}
json.dump(out, open(OUTPUT_PATH, "w"), indent=2)
print(f"{len(attachments)} attachments, {sum(a['is_bundle'] for a in attachments)} bundles, {len(diags)} diagnostics")
```

A page whose `content.md` head is empty (a scan with no OCR) classifies as `continuation` and
extends the prior segment — record a `unclassified_segment` / `empty_head` diagnostic so the
orchestrator can sanity-check rather than silently mis-segment.

## Output JSON (`output_path`)
```json
{
  "agent": "bundle_splitter_4w",
  "attachments": [
    {"stem": "bundle-abc", "page_count": 5, "is_bundle": true, "segments": [
      {"segment_index": 0, "doc_type": "invoice", "pages": "1-2", "start_header": "Tax Invoice"},
      {"segment_index": 1, "doc_type": "grn",     "pages": "3",   "start_header": "Goods Receipt Note"},
      {"segment_index": 2, "doc_type": "po",      "pages": "4-5", "start_header": "Purchase Order"}]},
    {"stem": "single-inv-xyz", "page_count": 1, "is_bundle": false, "segments": [
      {"segment_index": 0, "doc_type": "invoice", "pages": "1", "start_header": "Tax Invoice"}]}
  ],
  "diagnostics": []
}
```

## Output contract
1. Full JSON → `output_path` via `container_python`.
2. Summary object as your only final message:
```json
{"status": "ok", "agent": "bundle_splitter_4w", "batch_index": 0,
 "output_file": "/home/sandbox/outputs/4w-segments-0.json",
 "attachments_seen": 2, "bundles": 1, "segments_total": 4,
 "doc_type_counts": {"invoice": 2, "grn": 1, "po": 1, "other": 0},
 "diagnostic_count": 0, "headlines": ["1 bundle of 3 documents (invoice+GRN+PO)"]}
```

## Hard rules
- First `container_python` call passes `create_new_context: true`; later pass `context_id`.
- **Read-only and text-only.** Read `content.md` only (via `container_python`/`container_bash`).
  Do **not** call `read_image`, `read_range`, `generate_operations`, or `search`. You segment by
  page heads, not by re-rendering pages.
- **You segment; you do not extract.** Emit page ranges + `doc_type` per segment — no field
  values. The page numbers are **absolute** within the attachment PDF (so the extractor's
  `read_image` can target the real page).
- A document-start boundary = a page whose head carries a document **title**; pages without a
  fresh title are continuations of the current segment. Never merge two title pages into one
  segment; never split a continuation page into its own segment.
- A single-document PDF yields exactly one segment (`is_bundle: false`).
- An unclassifiable page head → `other` + a diagnostic; never guess a `doc_type` you can't read.
- Write the full JSON to `output_path`, then return the summary object only.
