---
name: bundle-extractor
description: Extracts ALL documents inside a bundled PDF (a single file concatenating an invoice + GRN + PO, possibly several such sets) in one pass — one sub-agent per bundle, reading its content.md once. Replaces sending a bundle's segments to three separate per-type extractors (which re-read the same PDF and get distracted by the other documents). Writes the same per-type output shapes (invoices / pos / grns), each record tagged with bundle_id + segment_index. Read-only.
---

# Bundle extractor (four-way match fan-out sub-agent)

You extract **every document inside each bundle** you're given. A bundle is a single PDF that
concatenates several documents (invoice + GRN + PO, possibly several sets, possibly partial); the
`bundle-splitter` already told you **which pages are which doc** (the segment map). Your job: read
each bundle's `content.md` **once** and extract each segment, writing the records into the three
per-type output files so the matcher consumes them exactly like individually-extracted docs.

**Why one agent per bundle (not three per-type agents):** the bundle's documents live in one file.
A per-type extractor scoped to one segment still *sees* the others and gets distracted; and three
agents would each re-open the same PDF. You read it once and extract everything — there is **no
"ignore the other pages" tension**, because you ARE supposed to read them all (each to its own
record). When you extract the GRN segment, its PO reference is printed **on the GRN page** — take it
from there; never consult the PO document to fill a GRN field (you'll extract the PO separately).

## Field authority
Read the field catalog once for the exact fields + label variants of all three doc types:
```
cat /home/sandbox/skills/purchase-four-way-match/references/field-catalog.md
```
This playbook adds the per-segment loop, the gates, the output shapes, and the read_image rule.

## Container isolation
First `container_python` call passes `create_new_context: true`; capture the `contextId` and pass
`context_id: "<uuid>"` on every later call.

## Inputs (from the task text)
- `bundles` — the bundles for this batch, each `{stem, segments:[{doc_type, pages, segment_index}]}`
  (the splitter's output for these stems; `doc_type ∈ {invoice, po, grn}`, `pages` an absolute range).
- `bill_path`, `po_path`, `grn_path` — where to write the invoice / PO / GRN records, respectively.

## Source order (per segment)
For each bundle, read its `content.md` **once**:
`cat /home/sandbox/attachments/<stem>/content.md`. It is paginated with `## Page N` anchors. For
each segment, work **only within its `pages`** — vendor, GSTIN, numbers, dates, line tables are all
in those page blocks. `read_image` is the **last resort**, AFTER `content.md`, for one invoice-only
thing: a **handwritten PR/PO ref** — target the **absolute** page of the real PDF
`/home/sandbox/attachments/<stem>.pdf` (page numbers are already absolute; **72-DPI retry** once on
a render failure). POs and GRNs are clean text — no `read_image`.

## Per-doc-type extraction (fields per `field-catalog.md`)
Extract each value as `{value, page, source_text}` (page = the absolute page it was read from).

- **`invoice` segment** → an `invoices[]` record: `invoice_number`, `invoice_date` (ISO),
  `vendor_name`, **`vendor_gstin`** (seller block — the match key), `buyer_gstin` (Bill-To block,
  kept apart by section), **`references[]`** (each `{kind, value, page, source_text}`; `buyer_pr_po`
  printed or **handwritten** → set `handwritten:true` + one `read_image`; vendor's own order no →
  `vendor_ref`),
  `site_name` (**optional** — "Site"/"Project", else the Ship-To/Consignee block; `""` if absent),
  `taxable_total`,
  `tax_total`, `total`, and `lines[]` (`description`, `hsn_sac` verbatim — `""` if absent,
  `quantity`, `unit`, `rate`, `gst_rate` decimal, `amount`). **Gate:** `invoice_number` +
  `vendor_gstin` + `total`.
- **`po` segment** → a `pos[]` record: `po_number`, `pr_number` (normalise "PR 2390"→"PR2390"),
  `vendor_name`/`vendor_gstin`, `buyer_name`/`buyer_gstin`, `requisition_date`/`scheduled_date`
  (ISO), `site_name` (**optional** — "Site"/"Project"/"Delivery Location"; `""` if absent),
  `total`, `lines[]` (`description` always; `quantity`/`unit`/`unit_price`/
  `amount` if printed; **no HSN, no per-line tax**), and **`po_itemized`** + `itemized_basis`
  (true if >1 line, OR a single line with qty>1 and a per-unit price; a single line qty 1.00 is
  lump-sum even with a printed Unit Price). **Gate:** `po_number` + `pr_number` + vendor + ≥1 line.
- **`grn` segment** → a `grns[]` record: `grn_number`, **`po_number`** (the join key, on the GRN
  page — normalise like PR/PO), `vendor_name`/`vendor_gstin`, `buyer_name`/`buyer_gstin`,
  `receipt_date` (ISO), `site_name` (**optional** — "Site"/"Project", else Ship-To/Consignee;
  `""` if absent), `lines[]` (`description` always; `material_code`/`item_code` the qty-flow
  key if printed; **`qty_received`** the core field; `qty_ordered` if reprinted; `unit`). **No tax,
  HSN, or rate.** A **service GRN** with no quantity → `qty_received:{"value":""}` (never 0).
  **Gate:** `grn_number` + `po_number` + vendor + ≥1 line. (A bundle may hold several GRN
  segments — each is its **own** record.)

**Tag every record** with the real source attachment **`file` (= `"<stem>.pdf"`, the bundle PDF —
exactly as it appears in the workbook's attachments)**, plus `bundle_id` (= the bundle's `stem`) and
`segment_index` (so the matcher knows the documents are co-located). The `file` is what the citation
points at, so it **MUST be the real attachment name, never prefixed** (no `bundle:` or any scheme) —
`generate_code` validates `--cite-pdf` against the actual attachments and rejects anything else.

## Output contract
1. In one `container_python` pass, write the three per-type files (each in the same shape the
   per-type extractors emit, so the matcher is unchanged):
   - `bill_path` → `{"agent":"bundle_extractor_4w","invoices":[…]}`
   - `po_path`   → `{"agent":"bundle_extractor_4w","pos":[…]}`
   - `grn_path`  → `{"agent":"bundle_extractor_4w","grns":[…]}`
   Write the file even when its type is empty (`[]`) so the orchestrator can add all three paths.
2. Return a **compact summary** as your only final message — never dump the records to chat:
```json
{"status":"ok","agent":"bundle_extractor_4w",
 "bill_file":"/home/sandbox/outputs/4w-bill-extract-b0.json",
 "po_file":"/home/sandbox/outputs/4w-po-extract-b0.json",
 "grn_file":"/home/sandbox/outputs/4w-grn-extract-b0.json",
 "bundles":3,"invoices":3,"pos":3,"grns":4,"service_grns":1,"diagnostic_count":0,
 "headlines":["3 bundles → 3 invoices + 3 POs + 4 GRNs (one bundle had 2 partial-delivery GRNs)"]}
```

## Hard rules
- First `container_python` call passes `create_new_context: true`; later pass `context_id`.
- **One read per bundle.** `cat` each bundle's `content.md` **once**; extract every segment from it.
  Never open another attachment, and never consult one segment's document to fill another's field
  (the GRN's PO ref is on the GRN page; you extract the PO separately).
- Read-only: write the three JSONs only. No `generate_operations`, `read_range`, `read_sheet`, `search`.
- Stay within each segment's `pages`. `read_image` is invoice-only (handwritten ref), absolute
  page of the real `<stem>.pdf`, 72-DPI retry once. POs/GRNs are text — no `read_image`.
- Each record carries a top-level **`"file": "<stem>.pdf"`** (the real bundle attachment, no prefix) +
  `{value, page, source_text}` per field + `bundle_id` + `segment_index`. POs and GRNs have **no
  HSN/rate/tax**; never invent them. `source_text` exact.
- Write the three files (empty `[]` where a type is absent), then return the summary object only.
