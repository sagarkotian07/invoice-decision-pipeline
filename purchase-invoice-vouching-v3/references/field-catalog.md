# Field catalog — invoices & POs (vouching v3)

Field meanings and label variants for this document family: **mygate-generated POs**
(buyer header + vendor block + Level-1/2 approval table) and **vendor tax-invoices**
(Vyapar / Tally / custom templates, often scanned with handwritten refs and stamps).
For core invoice fields and party disambiguation, the authority is the v5 catalog:

```
cat /home/sandbox/skills/invoice-extraction-v5/references/field-catalog.md
```

This file adds what v3's match ladder + tiers need.

## Invoice (tax invoice)

| Key | Label variants / cue | Notes |
|---|---|---|
| `invoice_number` | "Invoice No", "No", "Invoice Number" | verbatim |
| `invoice_date` | "Date", "Dated", "Invoice Date" | → ISO; DMY (₹/GSTIN) |
| `vendor_name` | seller block / letterhead | the identity is the GSTIN, not this |
| `vendor_gstin` | "GSTIN", "GSTIN/UIN" in the **seller / letterhead** block | **the match key** — the party *issuing* the invoice |
| `buyer_gstin` | "GSTIN" in the **Bill-To / Consignee** block | the client's GSTIN; an invoice prints **both** — keep them apart by section |
| `references[]` | see below — capture ALL, tagged | the join keys |
| `buyer_stamp` | the **buyer's** round rubber stamp / handwritten sign-off (the Bill-To party's name) | distinct from the vendor's "Authorised Signatory" seal; visual |
| `taxable_total` / `tax_total` / `total` | "Taxable", "Sub Total", "Total", "Grand Total", "Invoice Amount" | capture round-off if printed |
| line `description` | "Description of Goods", "Item name", "Particulars" | |
| line `hsn_sac` | "HSN/SAC", "HSN/SAC code" | verbatim; **may be absent** (→ "") |
| line `quantity` / `unit` | "Quantity", "Qty"; "Nos", "pc", "load" | |
| line `rate` | "Rate", "Price/ unit", "Unit Price" | per-unit, plain number |
| line `gst_rate` | "GST(%)", "Rate %", "CGST%+SGST%" | decimal (0.18) |
| line `amount` | "Amount" | |

### `references[]` — the order references (capture every one, tagged)
| `kind` | Where it appears | Used as match key? |
|---|---|---|
| `buyer_pr_po` | the buyer's PR/PO — **handwritten** top-of-page ("PR2390", "PR 2394"), or printed in "Buyer's Order No" / "Cust PO Date" | **yes** (rung 1) |
| `vendor_ref` | the vendor's own order no in their template ("Cust PO No: PO1963") | **no** — ignored |

Handwritten ref → `read_image` that page; set `handwritten: true`.

## Purchase order (mygate)

| Key | Label | Notes |
|---|---|---|
| `po_number` | "PO Number" (PO2279) | buyer's PO |
| `pr_number` | "PR Number" (PR 2390) | normalise → "PR2390" |
| `vendor_name` / `vendor_gstin` | Vendor block "Name" / "GST No" | GSTIN = identity |
| `buyer_name` / `buyer_gstin` | top header + "GST Number" | same across the batch → the detected buyer |
| `requisition_date` | "Requisition Date" | → ISO; **the PO date** for date checks |
| `scheduled_date` | "Scheduled Date" | → ISO; captured too |
| `approval` | the "Level / Approver / Status / Date & Time" table | status = Approved only if **all** levels are |
| `total` | "Total" | |
| line `quantity` / `unit` / `unit_price` / `amount` | the Purchase-Order line table | drives `po_itemized` |

**`po_itemized`**: true when **either** — (1) the PO lists **more than one line item**
(any qty — 3 lines each "qty 1.00 @ its own Unit Price" is itemized), OR (2) a line has
**quantity > 1 AND a per-unit `unit_price`/rate** (a genuine per-unit line). False
otherwise — in particular a **single line with qty 1.00 is lump-sum even if a Unit Price
is printed** (that figure is the lump total; most mygate POs print the Unit Price column
regardless), and a single line with no per-unit price is lump-sum. For a single line,
quantity > 1 is the signal; goods-vs-services never decides it. This flag decides
whether Tier-3 rate-match runs.

## Notes on this family
- POs carry **no HSN/SAC** (the column is blank) — never expect HSN on the PO.
- **An invoice prints two GSTINs** — the vendor's (seller / letterhead block) and the
  buyer's (Bill-To / Consignee block). The **vendor GSTIN is the match key**; tell them
  apart by *section*, not by which appears first. A PO usually prints only the vendor's
  GSTIN in the vendor block (the buyer's sits once in the top header).
- Buyer & vendor are both Karnataka (state code 29) here → intra-state → CGST+SGST.
- Invoices are often scanned/rotated with faint stamps and handwriting → the
  extractor leans on `read_image` for refs and stamps.
