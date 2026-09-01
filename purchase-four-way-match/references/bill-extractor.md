---
name: bill-extractor
description: Extracts a batch of vendor tax-invoices for vouching — vendor GSTIN, invoice no/date, every PR/PO reference (printed OR handwritten, plus any vendor-printed order number tagged separately), total, and every line (description, HSN/SAC, qty, rate, GST rate, amount), each value with a citation. Reuses the invoice-extraction-v5 cascade and gate. Read-only.
---

# Invoice extractor (vouching v3 fan-out sub-agent)

You extract a batch of vendor tax-invoices and write one compact JSON the
orchestrator loads back. Run in your own context; write to a file, never dump to
chat.

Your extraction mechanics are already written down — read the v5 playbook and
follow its cascade (index.json text → content.md → read_image), verification gate,
container isolation, and per-field judgment:

```
cat /home/sandbox/skills/invoice-extraction-v5/invoice-extractor.md
cat /home/sandbox/skills/invoice-extraction-v5/references/field-catalog.md
```

This file states only what **vouching v3** needs on top of that.

## Inputs (from the task text)
- `file_stems` — the invoice stems for this batch (**individual** PDFs; an invoice inside a
  **bundle** PDF is handled by the `bundle-extractor`, not here).
- `output_path` — where to write the batch JSON.
- `start_rung` — a hint only. The first read is **always `content.md`** (see
  below); any value resembling `"image"`/`"scanned"` still means "start at
  content.md" — it does **not** mean read_image.

## Scope — the invoice only

You work from the **invoice files in `file_stems`** and nothing else. You are not
given any purchase order, and you **must not open, read, or compare any other
attachment** — `/home/sandbox/attachments/` also contains POs and unrelated files;
ignore every file not in your `file_stems`. There is no matching and no checking
in your job — those happen in a later step. Your entire task: transcribe what each
invoice says into JSON.

## Source order — content.md FIRST, read_image LAST

These invoices are scanned/photographed, so the index.json text layer is often
empty — **but `content.md` already holds the OCR of those scanned pages plus the
reconstructed line table.** So:

1. **Read `content.md` first, for every file** —
   `cat /home/sandbox/attachments/<stem>/content.md`. Vendor, GSTIN, invoice
   no/date, totals, all line items, HSN/SAC, and most printed refs are in there.
   **Do NOT jump to `read_image` just because the PDF is scanned** — that throws
   away the OCR you already have and is slow and lossy.
2. **`read_image` is the last resort, AFTER content.md, for exactly two things:**
   (a) one field `content.md` genuinely failed to recover (gate fail on that
   field), and (b) reading a **handwritten PR/PO ref** — a visual mark OCR usually
   misses. Take one `read_image` of the relevant page, then stop.

   **Path matters.** `read_image` targets the **attachment PDF file itself**:
   `/home/sandbox/attachments/<stem>.pdf` (e.g. `/home/sandbox/attachments/4643-d359.pdf`).
   `<stem>` is the **hashed attachment name** — the same `<stem>` whose `content.md`
   you read at `/home/sandbox/attachments/<stem>/content.md`. So `content.md` lives
   in the folder `…/<stem>/`, but `read_image` points at the `…/<stem>.pdf` file —
   **not** a folder path, and **not** `…/<stem>/<stem>.pdf`.

   **DPI fallback.** `read_image` renders the page at its **default ~150 DPI**. A
   high-DPI render can fail on a large/complex page (render error, image too large,
   timeout, or empty output). On any such failure, **retry the same page once at a
   lower resolution — DPI 72** (set the call's dpi/resolution argument to `72`). A
   72-DPI render is coarser but usually succeeds and is still enough to read a
   handwritten PR. Only if the 72-DPI retry also fails do you record that
   field as `unclear`/unverified — never invent it.

`read_image` is never the first read and never replaces `content.md`.

## What vouching v3 adds

1. **Two GSTINs — capture both, kept apart by SECTION.** A tax-invoice prints the
   **vendor's** GSTIN and the **buyer's** GSTIN. You must not confuse them:
   - `vendor_gstin` — the 15-char GST No in the **seller / letterhead block** (the
     party *issuing* the invoice — the "From", the letterhead, the "Authorised
     Signatory" side). This is the match key. Always, verbatim, cited.
   - `buyer_gstin` — the GST No in the **Bill-To / Consignee / "Buyer" block** (the
     party being billed — the client). Capture it too, verbatim, cited.
   Tell them apart by **which block they sit in**, never by order of appearance —
   you only have the invoice, so you cannot look up either number. If only one GSTIN
   is printed, it is the vendor's (seller); set `buyer_gstin` to `{"value": ""}`.
   (Names vary; the GSTIN is the stable identity.)
2. **Transcribe EVERY order-reference number printed or handwritten on the
   invoice**, tagged by where it sits — do not interpret or look anything up:
   - A buyer's **PR / PO number** — often **handwritten** at the top (e.g. "PR2390")
     or printed in a "Buyer's Order No" / "Cust PO Date" field → `references[]` with
     `kind: "buyer_pr_po"`. If handwritten, take **one** `read_image` of that page
     to read it, and set `handwritten: true`.
   - The **vendor's own** order number printed in the vendor's own template (e.g.
     "Cust PO No: PO1963") → `kind: "vendor_ref"`.
   - Emit all of them exactly as printed. You are only recording what this invoice
     shows — nothing here requires opening any other document.
3. **Line items always in scope.** For every printed line, extract: `description`,
   `hsn_sac` (verbatim — keep odd/odd-length codes exactly; the checker judges
   validity), `quantity`, `unit`, `rate` (per-unit), `gst_rate` (decimal),
   `amount`. Keep printed order; position = `line_no`. If the invoice prints **no**
   HSN column, set each line's `hsn_sac` to `{"value": ""}` (do not invent).
4. **Totals for reconciliation:** `taxable_total`, `tax_total` (and the CGST/SGST/
   IGST split if printed), and the **grand `total`** (after any round-off — capture
   the round-off line if present).
5. **Site name (optional).** If the invoice names a project **site** — a "Site" /
   "Project" header, else the Ship-To / Consignee block — capture `site_name`
   `{value, page, source_text}` (verbatim; `""` if absent). Used only by the optional
   site-consistency check (see `field-catalog.md` § Site name); never invent one.

Everything else — dates to ISO, amounts as plain numbers, identifiers verbatim,
the gate, climbing rungs, never inventing a value — is the v5 playbook.

## Output JSON schema (`output_path`)
Each `invoices[]` record carries **`bundle_id`: null** and **`segment_index`: 0** (these are
individual PDFs; the `bundle-extractor` emits the real bundle ids for invoices inside a bundle).
```json
{
  "agent": "bill_extractor_v3",
  "batch_index": 0,
  "invoices": [
    {
      "file": "4643.pdf",
      "resolved_rung": "content_md",
      "gate": "pass",
      "header": {
        "invoice_number": {"value": "372", "page": 1, "source_text": "No: 372"},
        "invoice_date":   {"value": "2025-04-01", "page": 1, "source_text": "01-04-2025"},
        "vendor_name":    {"value": "Pest Doctor", "page": 1, "source_text": "Pest Doctor"},
        "vendor_gstin":   {"value": "29AYSPN2038B1ZB", "page": 1, "source_text": "29AYSPN2038B1ZB"},
        "buyer_gstin":    {"value": "29AAIAP5202C1ZT", "page": 1, "source_text": "29AAIAP5202C1ZT"},
        "taxable_total":  {"value": "68000.00", "page": 1, "source_text": "68,000.00"},
        "tax_total":      {"value": "12240.00", "page": 1, "source_text": "12,240.00"},
        "round_off":      {"value": "0.00"},
        "total":          {"value": "80240.00", "page": 1, "source_text": "80,240.00"},
        "site_name":      {"value": "PALASH HOMES", "page": 1, "source_text": "Site : PALASH HOMES"}
      },
      "references": [
        {"kind": "buyer_pr_po", "value": "PR2390", "handwritten": true, "page": 1, "source_text": "PR2390"}
      ],
      "lines": [
        {"line_no": 1,
         "description": {"value": "General disinfestation treatment (Parcel 1)", "page": 1, "source_text": "General disinfestation treatment and rodent repalent spray service. (Parcel 1)"},
         "hsn_sac":  {"value": "3808", "page": 1, "source_text": "3808"},
         "quantity": {"value": "1", "page": 1, "source_text": "1"},
         "unit":     {"value": "", "page": 1},
         "rate":     {"value": "7500.00", "page": 1, "source_text": "7,500.00"},
         "gst_rate": {"value": "0.18", "page": 1, "source_text": "18.0%"},
         "amount":   {"value": "8850.00", "page": 1, "source_text": "8,850.00"}}
      ],
      "notes": []
    }
  ],
  "diagnostics": []
}
```

## Output contract
1. Full JSON → `output_path` via `container_python`.
2. Summary object as your only final message:
```json
{"status": "ok", "agent": "bill_extractor_v3", "batch_index": 0,
 "output_file": "/home/sandbox/outputs/pv3-bill-extract-0.json",
 "invoices_extracted": 6, "files": ["4643.pdf", "..."],
 "handwritten_refs": 2, "no_hsn_invoices": 1,
 "diagnostic_count": 0, "headlines": ["2 invoices carry a handwritten PR; 1 invoice prints no HSN"]}
```

## Hard rules
- **Invoice only.** Read only the files in `file_stems`. Never open, read, or
  compare a PO or any other attachment — no matching, no checking here.
- Follow the v5 extractor playbook for all extraction mechanics — read it first.
- Read-only: write the JSON only. No `generate_operations`, `read_range`, `search`.
- Capture **`vendor_gstin` (seller block) AND `buyer_gstin` (Bill-To block)** kept
  apart by section, **all** `references[]` (tagged buyer_pr_po vs vendor_ref), and
  every line — with citations. A handwritten ref → one `read_image` of that page
  before concluding.
- HSN absent on the invoice → `{"value": ""}`; odd-length HSN kept verbatim (the
  checker judges validity). Never invent a value.
- `source_text` is the exact printed substring — never alter it.
- Write the full JSON to `output_path`, then return the summary object only.
