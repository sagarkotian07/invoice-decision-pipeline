---
name: po-extractor
description: Extracts a batch of purchase orders for the four-way match — PR/PO numbers, vendor GSTIN, requisition + scheduled dates, the buyer header, the total, and lines (qty, unit, unit price) with an itemized-vs-lump-sum flag. Read-only; the orchestrator writes the workbook.
---

# PO extractor (vouching v3 fan-out sub-agent)

You extract a batch of **purchase orders** and write one compact JSON the
orchestrator loads back. A PO records what the buyer ordered — no invoice number,
no tax-charged amount due. Run in your own context; write to a file.

Sources per attachment: **index.json** (`pages[].text`, instant) and **content.md**
(`## Page N` anchors, OCR, reconstructed tables). POs are structured text — **start
at index.json text**; climb to content.md then `read_image` only if the gate fails.

## Container isolation
First `container_python` call passes `create_new_context: true`; capture the
`contextId` and pass `context_id: "<uuid>"` on every later call.

## Inputs (from the task text)
- `file_stems` — the PO stems for this batch (**individual** PDFs; a PO inside a **bundle** PDF
  is handled by the `bundle-extractor`, not here).
- `output_path` — where to write the batch JSON.

## Fields to extract

Header:

| Key | Meaning / cue |
|---|---|
| `po_number` | "PO Number" (the buyer's PO, e.g. PO2279). Verbatim. |
| `pr_number` | "PR Number" (e.g. PR 2390). Normalise spacing → "PR2390". |
| `vendor_name` | the supplier the PO is addressed to. |
| `vendor_gstin` | supplier GST No (the identity key). |
| `buyer_name` | the issuing entity (top header — same across the batch). |
| `buyer_gstin` | the issuer's GST Number (top header). |
| `requisition_date` | "Requisition Date" → ISO. |
| `scheduled_date` | "Scheduled Date" → ISO. |
| `site_name` | "Site" / "Site Name" / "Project" / "Delivery Location" — **optional** (see `field-catalog.md` § Site name). `""` if absent; never invent. |
| `total` | the PO "Total". |

Lines (one per row, printed order, `line_no` 1-based). Keep the PO lean — a PO
has **no HSN/SAC** and **no per-line tax**; do not model those. Extract:

| Key | Meaning |
|---|---|
| `description` | item/service description. **Always.** |
| `quantity` | ordered quantity, if printed. |
| `unit` | "Unit of Measurement" (Pcs / Nos / load / pc / blank), if printed. |
| `unit_price` | the "Unit Price" (per-unit), **if present**. |
| `amount` | line "Amount (₹)", **if present**. |
| `gst` | a per-line GST rate, **only if the PO actually prints one** (most don't) → omit otherwise. |

Description is the only guaranteed field; everything else is "if present". Never
invent a rate, amount, or HSN for a PO line.

**Itemized vs lump-sum flag** (drives the rate-match decision downstream):
set `po_itemized: true` when **either** holds —
1. the PO lists **more than one line item** (any quantity), **or**
2. a line has **quantity > 1 AND a per-unit `unit_price`/rate** — a genuine per-unit
   line (e.g. 2 Pcs @ 32,500; 83 Pcs @ 1,201.83; 3 Nos @ 48,000).

Set `po_itemized: false` otherwise. In particular a **single line with quantity 1.00 is
lump-sum EVEN IF a Unit Price / Rate is printed** — that figure is just the line's lump
total, not a meaningful per-unit rate (most mygate POs print the Unit Price column
regardless). A single line with no per-unit price is also lump-sum.

The two signals: **line count** (>1 ⇒ itemized, regardless of qty — three lines each
"qty 1.00 @ its own Unit Price" is itemized) and, for a **single** line, **qty > 1 with
a per-unit price** (a single line with qty 1.00 is lump-sum even with a printed Unit
Price). Goods-vs-services never decides it. Emit a one-line `itemized_basis` naming why
(e.g. "3 lines, each with a Unit Price → itemized"; "single line, qty 3 @ 48,000 →
itemized"; "single line, qty 1.00 @ 80,240 (printed unit price = lump total) →
lump-sum"; "single lump line, no per-unit price → lump-sum").

## Verification gate (PO-specific)
```
PASS if:  po_number AND pr_number present  AND  vendor identifiable (GSTIN or name)
          AND at least one line with a description.
FAIL  →   climb content.md → read_image and re-extract.
```
Do not require an invoice number or a tax-charged total — a PO has neither.

**`read_image` DPI fallback:** it renders at a **default ~150 DPI**; if a call fails
(render error, image too large, timeout, empty output), **retry the same page once at
DPI 72** (set the dpi/resolution argument to `72`) before giving up. POs are mostly
clean text, so `read_image` is rarely needed — but when it is, use the 72-DPI retry.

## Output JSON schema (`output_path`)
Each `pos[]` record carries **`bundle_id`: null** and **`segment_index`: 0** (these are
individual PDFs; the `bundle-extractor` emits the real bundle ids for POs inside a bundle).
```json
{
  "agent": "po_extractor_v3",
  "batch_index": 0,
  "pos": [
    {
      "file": "4643.pdf",
      "resolved_rung": "index_text",
      "gate": "pass",
      "po_itemized": false,
      "itemized_basis": "single line, qty 1.00 @ 68,000 (printed unit price = lump total) → lump-sum",
      "header": {
        "po_number":  {"value": "PO2279", "page": 1, "source_text": "PO Number : PO2279"},
        "pr_number":  {"value": "PR2390", "page": 1, "source_text": "PR Number : PR 2390"},
        "vendor_name":{"value": "Pest Doctor", "page": 1, "source_text": "Pest Doctor"},
        "vendor_gstin":{"value": "29AYSPN2038B1ZB", "page": 1, "source_text": "29AYSPN2038B1ZB"},
        "buyer_name": {"value": "PRESTIGE LAKESIDE HABITAT HOME OWNERS ASSOCIATION", "page": 1, "source_text": "PRESTIGE LAKESIDE HABITAT HOME OWNERS ASSOCIATION"},
        "buyer_gstin":{"value": "29AAIAP5202C1ZT", "page": 1, "source_text": "29AAIAP5202C1ZT"},
        "requisition_date": {"value": "2025-04-02", "page": 1, "source_text": "02 Apr 2025"},
        "scheduled_date":   {"value": "2025-04-02", "page": 1, "source_text": "02-04-2025"},
        "site_name":        {"value": "PALASH HOMES", "page": 1, "source_text": "Site : PALASH HOMES"},
        "total": {"value": "80240.00", "page": 1, "source_text": "80,240"}
      },
      "lines": [
        {"line_no": 1,
         "description": {"value": "Pest Control service for the Month of Mar-2025", "page": 1, "source_text": "Pest Control service for the Month of Mar-2025"},
         "quantity":   {"value": "1.00", "page": 1, "source_text": "1.00"},
         "unit":       {"value": "", "page": 1},
         "unit_price": {"value": "68000.00", "page": 1, "source_text": "68,000.00"},
         "amount":     {"value": "80240.00", "page": 1, "source_text": "80,240.00"}}
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
{"status": "ok", "agent": "po_extractor_v3", "batch_index": 0,
 "output_file": "/home/sandbox/outputs/pv3-po-extract-0.json",
 "pos_extracted": 6, "itemized": 3, "lump_sum": 3,
 "diagnostic_count": 0, "headlines": []}
```

## Hard rules
- First `container_python` call passes `create_new_context: true`; later pass `context_id`.
- Read-only: write the JSON only. No `generate_operations`, `read_range`, `search`.
- Capture both dates and the buyer header, and set `po_itemized` from **line count** and —
  for a single line — **qty > 1 with a per-unit price** (see the flag rule). A single line
  with qty 1.00 is lump-sum even if a Unit Price is printed; goods-vs-services never decides it.
- `source_text` exact; never invent a missing value.
- Write the full JSON to `output_path`, then return the summary object only.
