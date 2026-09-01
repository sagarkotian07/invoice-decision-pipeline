# Field catalog — PO · GRN · Invoice · Purchase Register (four-way match)

Field meanings and label variants for the four-way document family. This forks the
vouching-v3 catalog (invoice + PO unchanged) and adds **GRN** (goods receipt) and the
**Purchase Register** (the buyer's books, a worksheet in the open workbook). For core
invoice fields and party disambiguation the authority is the v5 catalog:

```
cat /home/sandbox/skills/invoice-extraction-v5/references/field-catalog.md
```

The chain is **PO → GRN → Invoice → Register** — ordered → arrived → billed → booked.
The skill is **register-anchored**: the register posting is the unit of work; everything
else is the evidence chain behind it.

## Invoice (tax invoice)

| Key | Label variants / cue | Notes |
|---|---|---|
| `invoice_number` | "Invoice No", "No", "Invoice Number" | verbatim; the register's anchor key |
| `invoice_date` | "Date", "Dated", "Invoice Date" | → ISO; DMY (₹/GSTIN) |
| `vendor_name` | seller block / letterhead | the identity is the GSTIN, not this |
| `vendor_gstin` | "GSTIN", "GSTIN/UIN" in the **seller / letterhead** block | **the match key** — the party *issuing* the invoice |
| `buyer_gstin` | "GSTIN" in the **Bill-To / Consignee** block | the client's GSTIN; an invoice prints **both** — keep them apart by section |
| `references[]` | see below — capture ALL, tagged | the join keys to the PO |
| `site_name` | "Site", "Site Name", "Project", "Project Site"; fallback "Delivery Address" / "Ship To" / "Consignee" block | optional — see **Site name** below; "" when absent |
| `taxable_total` / `tax_total` / `total` | "Taxable", "Sub Total", "Total", "Grand Total", "Invoice Amount" | **the three register-reconciliation members** compare against these |
| line `description` | "Description of Goods", "Item name", "Particulars" | |
| line `hsn_sac` | "HSN/SAC", "HSN/SAC code" | verbatim; **may be absent** (→ "") |
| line `quantity` / `unit` | "Quantity", "Qty"; "Nos", "pc", "load" | the **billed** quantity in the qty flow |
| line `rate` | "Rate", "Price/ unit", "Unit Price" | per-unit, plain number |
| line `gst_rate` | "GST(%)", "Rate %", "CGST%+SGST%" | decimal (0.18) |
| line `amount` | "Amount" | |

### `references[]` — the order references (capture every one, tagged)
| `kind` | Where it appears | Used as match key? |
|---|---|---|
| `buyer_pr_po` | the buyer's PR/PO — **handwritten** top-of-page ("PR2390", "PR 2394"), or printed in "Buyer's Order No" / "Cust PO Date" | **yes** (Hop-2 rung 1) |
| `vendor_ref` | the vendor's own order no in their template ("Cust PO No: PO1963") | **no** — ignored |

Handwritten ref → `read_image` that page; set `handwritten: true`.

## Purchase order (mygate)

| Key | Label | Notes |
|---|---|---|
| `po_number` | "PO Number" (PO2279) | buyer's PO; the GRN's join key |
| `pr_number` | "PR Number" (PR 2390) | normalise → "PR2390" |
| `vendor_name` / `vendor_gstin` | Vendor block "Name" / "GST No" | GSTIN = identity |
| `buyer_name` / `buyer_gstin` | top header + "GST Number" | same across the batch → the detected buyer |
| `requisition_date` | "Requisition Date" | → ISO; **the PO date** for date checks |
| `scheduled_date` | "Scheduled Date" | → ISO; captured too |
| `site_name` | "Site", "Site Name", "Project", "Project Site", "Delivery Location" | optional — see **Site name** below; "" when absent |
| `total` | "Total" | |
| line `quantity` / `unit` / `unit_price` / `amount` | the Purchase-Order line table | `quantity` = the **ordered** quantity in the qty flow; drives `po_itemized` |

**`po_itemized`**: true when **either** — (1) the PO lists **more than one line item**
(any qty), OR (2) a single line has **quantity > 1 AND a per-unit `unit_price`/rate**.
False otherwise — a **single line with qty 1.00 is lump-sum even if a Unit Price is
printed**. A lump-sum PO has no per-item ordered quantity → the **quantity-flow tier
degrades to `unverified`** ("N/A — PO lump-sum"); reconciliation still runs.

## Goods Receipt Note (GRN) — what arrived

A GRN records receipt of goods against a PO. It carries **no tax, no HSN, no rates, no
amount due** — like a PO has no HSN. Its one guaranteed numeric is the received quantity.

| Key | Label variants / cue | Notes |
|---|---|---|
| `grn_number` | "GRN No", "Goods Receipt No", "Receipt No", "MRN No" | verbatim |
| `po_number` | "PO No", "Against PO", "Order No", "Ref PO" | **the join key to the PO** — normalise like PR/PO (uppercase, strip spaces) |
| `vendor_name` / `vendor_gstin` | supplier block | GSTIN = identity (may be absent on a GRN) |
| `buyer_name` / `buyer_gstin` | receiving-entity header | same buyer across the batch |
| `receipt_date` | "GRN Date", "Receipt Date", "Date of Receipt", "Received On" | → ISO; the GRN date for the sanity checks |
| `site_name` | "Site", "Site Name", "Project"; fallback "Delivery Address" / "Ship To" / "Consignee" | optional — see **Site name** below; "" when absent |
| line `description` | "Material", "Item", "Description" | **always**; the qty-flow keying fallback |
| line `material_code` / `item_code` | "Material Code", "Item Code", "SKU", "Part No" | the **primary** qty-flow keying field — capture if printed |
| line `qty_received` | "Qty Received", "Received Qty", "Accepted Qty", "GRN Qty" | **the core field** |
| line `qty_ordered` | "Ordered Qty", "PO Qty" (if the GRN reprints it) | optional corroboration |
| line `unit` | "UoM", "Unit" | if printed |

**Service GRNs** may carry no quantity ("service rendered" / a checkbox) → set
`qty_received` to `{"value": ""}`; the qty-flow check for that line is **`unverified`**,
never invented as 0. **Multi-GRN:** one PO can have several partial-delivery GRNs — the
extractor emits **one record per GRN document** (carrying `po_number`); the matcher
groups and aggregates by PO.

## Purchase Register — the books (a worksheet in the open workbook)

The register is **not a PDF** — it is a tab in the open workbook (e.g. a Tally / Zoho /
SAP purchase ledger export). It is **header-only** (one row per posting; no line items),
so it does **not** appear on the Lines sheet. Columns are **user-defined and vary** — the
register extractor reads the sheet's structure via `read_sheet` and **judges** which
column means what. The list below is **guidance for that judgment, not a coded
fuzzy-matcher** — read the headers and decide.

| Canonical field | Common header synonyms (case/punctuation-insensitive) | Required? |
|---|---|---|
| `vendor_name` | Vendor, Supplier, Party, Party Name, Name, Account | yes |
| `vendor_gstin` | GSTIN, GST No, GST Number, GSTIN/UIN | optional |
| `invoice_no` | Invoice No, Inv No, Bill No, Bill #, Voucher No, Document No, Ref No | **yes — the anchor key** |
| `booking_date` | Date, Invoice Date, Bill Date, Voucher Date, Posting Date, Booking Date | yes |
| `po_no` | PO No, PO Number, Purchase Order, Order No | optional |
| `site_name` | Site, Site Name, Project, Project Site | optional — see **Site name** below |
| `taxable` | Taxable, Taxable Value, Basic, Net, Net Amount, Sub Total, Amount | yes |
| `cgst` / `sgst` / `igst` | CGST, SGST, IGST, Central Tax, State Tax, Integrated Tax | conditional |
| `gst_total` | GST, Tax, Tax Amount, Total Tax, GST Amount | conditional |
| `total` | Total, Grand Total, Invoice Amount, Amount Payable, Gross, Net Payable | yes |

**Variance rules (the only real logic the extractor writes):**
- **No GSTIN column** → vendor identity degrades to the **normalized name** (uppercase,
  strip legal suffixes/punctuation); the register→invoice vendor match is then name-based
  and **flagged lower-confidence** — unreconcilable name → `unverified`, not `fails`.
- **Split CGST + SGST + IGST** (no single GST column) → `gst_total = cgst + sgst + igst`,
  cited to the **constituent cells** (`source_text` = "CGST 6,120 + SGST 6,120"). A single
  GST/tax column → use directly. Neither present → `gst_total` is `""` → register-GST
  reconciliation is `unverified`.
- **No PO column** → fall back to the invoice's PR/PO ref for the PO join; the register's
  PO-no is corroboration only, never the only path.
- **`total` absent** but taxable + gst present → derive `total = taxable + gst_total`,
  cite both constituents, flag as derived.
- **Ambiguous money column** (two columns both plausibly "amount"/"total") → never guess;
  one `ask_clarification` confirming the mapping. A wrong `taxable`/`total` mapping
  silently corrupts every reconciliation verdict.

**Register citations are cell-based**, the sibling of the PDF cite
`{file, page, source_text}`:
```json
"taxable": {"value": "68000.00",
            "cite": {"sheet": "Purchase Register", "cell": "F7", "source_text": "68,000.00"}}
```
We **never rewrite** the user's register cells — the cell *is* the source.

## Bundled PDFs

A single attachment may be a **bundle** — one PDF that concatenates several documents (e.g.
invoice + GRN + PO, possibly several such sets, possibly partial). Each constituent document
starts on a fresh page with its own **document title** at the head ("Tax Invoice" / "Purchase
Order" / "Goods Receipt Note"), so a bundle is segmented by **document-start boundaries**
(`bundle-splitter.md`). Each extracted document then carries:
- **`bundle_id`** — the bundle's stem (or `null` for an individual PDF). Documents sharing a
  non-null `bundle_id` were filed together — the matcher prefers same-bundle pairings.
- **`segment_index`** — 0-based position within the bundle.
- citations still use the **absolute** page within the bundle PDF (so `read_image` works).

A bundle is a *co-location* signal, not an automatic 1:1 join: the printed PR/PO ref still
picks the right PO when a bundle holds several, and a same-bundle PO whose ref disagrees with
the invoice is a **flag** ("bundle PO ref mismatch"), not a silent pairing.

**One extractor per bundle.** A bundle's documents are extracted by the **`bundle-extractor`**
(not the per-type extractors) — it reads the bundle once and extracts every segment, using this
catalog as its field authority for all three doc types. (Individual PDFs go to the per-type
extractors.) This catalog is therefore the shared field reference for both.

## Site name (optional — for the site-consistency custom check)

Some buyers run one register across several project **sites** and want every document in a
chain to name the **same** site. All four document types may print it — the register as a
**"Site Name"** column, a PO/GRN/invoice as a "Site" / "Project" header or, failing that, in
the **Delivery Address / Ship To / Consignee** block (use that only when no explicit site
label exists). Capture it verbatim as `site_name` `{value, page/cell, source_text}` whenever
present; `""` when absent.

Capturing the field is **cheap and always-on** (like `buyer_gstin`) — but it is only
**compared and shown** when the auditor turned on the **site-name custom check** in Phase 0
(`custom_checks` includes `"site_name"`). With the check off, the field is simply unused; you
never invent a site, and a missing site is `""` (the matcher reads it as `unverified`, never a
failure).

The matcher compares sites **semantically**, not by exact string — the same physical site counts
even across a trailing qualifier ("MANIPUR", "Phase 2"), an abbreviation, or reordered words (so
"AKALPYA" and "AKALPYA MANIPUR" are the same site). Capture the site **verbatim** and let the
matcher judge; never normalise or trim it yourself.

## Notes on this family

- **Line items live under the nested key `lines`.** Every invoice / PO / GRN extract record
  carries its per-line detail under `record["lines"]` (each line a `{value, page, source_text}`
  per field) — the matcher reads `record.get("lines", [])`, **never `line_items` or `items`** (a
  wrong key returns `[]` and silently reads as "no line items"). The register is header-only (no
  `lines`).
- **POs and GRNs carry no HSN/SAC** (the column is blank) — never expect HSN off them.
- **An invoice prints two GSTINs** — the vendor's (seller / letterhead block) and the
  buyer's (Bill-To block). The **vendor GSTIN is the match key**; tell them apart by
  *section*, not by which appears first.
- The quantity flow keys on **`material_code` when present, else the normalized
  description** — the same narrow-judge pairing used for invoice↔PO line matching.
- Buyer & vendor here are both Karnataka (state code 29) → intra-state → CGST+SGST.
- Invoices are often scanned/rotated with faint handwriting → the invoice extractor leans on
  `read_image` for a **handwritten PR/PO ref**. POs, GRNs, and the register are structured text.
