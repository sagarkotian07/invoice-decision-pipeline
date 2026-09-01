# Two-way (Invoice ↔ PO) matching — edge-case catalog

Derived from the four-way reference skill in `../../purchase-four-way-match/`,
scoped down to **invoice ↔ PO only** (GRN, purchase-register and bundle mechanics
dropped). Citations point at `references/check-rules.md` (`CR`), `references/matcher.md`
(`M`), `references/field-catalog.md` (`FC`) in that skill.

Each edge case lists: the **trigger**, how the matcher **handles** it, and the
**effect** on the verdict. The governing principle, straight from the reference:

> Only the **Tier-1 header checks** (vendor / total / dates-in-FY) drive the
> `Match` / `No match` verdict. Everything else is a **flag** — reported, never
> verdict-flipping. Missing data is `unverified`, never coerced to 0/false, and
> `unverified` never flips the verdict. (`CR §2`, `CR §5`)

Every case below is exercised by a scenario in `../samples/scenarios.json` and
asserted green by `node tests/run.js` (26/26 assertions).

---

## A. Verdict-driving (Tier-1) — these three can flip to `No match`

### 1. Vendor identity mismatch
- **Trigger:** invoice `vendor_gstin` ≠ PO `vendor_gstin` (fallback: normalized names when a GSTIN is absent). (`CR §2 vendor_match`, `FC` — "identity = GSTIN, not name")
- **Handling:** `vendor_match = fails`. Matcher `runMatch → checks.vendor_match`.
- **Effect:** **flip → No match.** Reason: *"Invoice/PO vendor mismatch"*.
- Scenario `02_vendor_mismatch`.

### 2. Total does not reconcile (tax / rounding / wrong amount)
- **Trigger:** `|invoice.total − Σ matched_pos.total| > max(₹1, 0.5%)`. (`CR §Tolerances`: `amounts_equal(a,b)= abs(a-b) <= max(1.00, 0.005*abs(b))`)
- **Handling:** `total_match = fails`. Small rounding/tax differences **inside** the band pass.
- **Effect:** **flip → No match.** Reason: *"Invoice {inv} vs PO {po} (diff {d})"*.
- Scenario `03_total_mismatch`.

### 3. Date outside the financial year
- **Trigger:** invoice date or a matched PO's `requisition_date` falls outside the FY window (default `2025-04-01 … 2026-03-31`, configurable). (`CR §2 Dates in FY`)
- **Handling:** `dates_fy = fails` (names which date/document). A **missing** date is `unverified`, not a fail.
- **Effect:** **flip → No match.** Reason: *"{which} date {date} outside FY …"*.
- Scenario `07_outside_fy`.

---

## B. Match-linking edge cases (how the invoice finds its PO)

### 4. Missing PO (no PO matched at all)
- **Trigger:** rung-4 of the ladder — no PR/PO ref match and no GSTIN+total fingerprint. (`CR §1 rung 4`, `CR "Missing-document semantics"`)
- **Handling:** `matched_pos = []`; Total=PO and vendor checks become `unverified`.
- **Effect:** **does NOT flip** — the invoice can still be `Match` on the checks it *can* verify; flag *"No PO matched (PO checks unverified)"*.
- Scenario `04_missing_po`.

### 5. No PR/PO reference on the invoice (fingerprint match)
- **Trigger:** invoice carries no `kind:"buyer_pr_po"` reference, but vendor GSTIN + total tie it to a PO. (`CR §1 rung 2`, `CR §2 po_num_consistent`)
- **Handling:** matched via **rung 2 (GSTIN + total)**; `po_num_consistent = unverified` — a fingerprint chain *cannot* confirm the invoice cites this PO, so it is never a green ✓.
- **Effect:** flag only; verdict from header checks. Basis reported as *"GSTIN + total"*.
- Scenario `13_fingerprint_no_ref`.

### 6. Invoice spans several POs
- **Trigger:** one invoice references (or fingerprints to) **multiple** POs. (`CR §1` — "An invoice may legitimately span several POs")
- **Handling:** gather **all** matches into a `matched_pos` list; reconcile invoice total against the **Σ** of their totals; pair each line to whichever PO owns it.
- **Effect:** normal verdict on the sum; flag *"Invoice spans N POs"*.
- Scenario `06_multi_po`.

### 7. Handwritten PR/PO reference
- **Trigger:** the matching PR/PO ref is marked `handwritten:true`. (`CR §1 rung 1`)
- **Handling:** still a rung-1 match, but basis *"PR/PO (handwritten, review)"* at **medium** confidence (vs high for printed).
- **Effect:** flag for reviewer; no flip.

### 8. Stray PR/PO reference (cites a PO that doesn't match)
- **Trigger:** an invoice PR/PO ref resolves to no matched PO. (`CR §2 po_num_consistent` — "fails on a stray ref")
- **Handling:** `po_num_consistent = fails`; flag naming the stray ref.
- **Effect:** flag only.

---

## C. Line-level & compliance flags (never flip the verdict)

### 9. Over-billing (billed qty > ordered qty)
- **Trigger:** invoice line quantity exceeds the paired PO line quantity. (`CR §3 Over-billing`: `qty_le(billed, ordered)`; the 2-way analogue of the GRN check)
- **Handling:** per paired line; missing qty → `unverified` (never 0).
- **Effect:** flag *"Over-billed N line item(s)"*.
- Scenario `05_over_billing`.

### 10. Price / rate variance
- **Trigger:** paired line's invoice `rate` ≠ PO `unit_price` beyond `0.01`. (`CR §4 Rate match`: `rates_equal(a,b)= abs(round2(a)-round2(b)) <= 0.01`)
- **Handling:** `rate_match = fails` on that line; `unverified` if the PO line has no per-unit price.
- **Effect:** flag *"Rate variance on N line(s)"*.
- Scenario `09_rate_variance`.

### 11. Line mismatch (extra billed line / ordered-but-unbilled line)
- **Trigger:** an invoice line pairs to no PO line (`bill_only`), or a PO line is never billed (`po_only`). (`CR §4 Line pairing`)
- **Handling:** pairing = exact normalized description **or** exact HSN, then same-product judgment (drop brand words, `elbow≈bend` synonyms), then 1-to-1 elimination. `line_match = fails` for an extra billed line; `unverified` when no PO matched.
- **Effect:** flag *"N billed line(s) not on any PO"* / *"N ordered line(s) not billed"*.

### 12. Invalid HSN/SAC · wrong GST%
- **Trigger:** HSN not numeric or length ∉ {4,6,8} (SAC = 6 digits starting "99"); or the line's GST% ≠ the rate for that HSN in the bundled `gst-hsn-rates.csv`. (`CR §2 HSN/SAC valid`, `CR §3 GST correct`; `pct_equal` @ 0.0001)
- **Handling:** `hsn_valid` / `gst_correct` per line; `unverified` when HSN absent or not in the rate table.
- **Effect:** flags *"Invalid HSN/SAC on N line(s)"*, *"GST% mismatch on N line(s)"*.
- Scenario `10_hsn_gst_bad`.

### 13. Date order (invoice predates its PO)
- **Trigger:** `invoice_date < PO requisition_date`. (`CR §3 Date order (PO↔Inv)` — "hard ✗ (red)")
- **Handling:** `date_order = fails` (a hard red in its own column).
- **Effect:** flag only — **never flips** (distinct from *dates-in-FY*, which does).
- Scenario `11_date_order`.

---

## D. Structural / data-quality edge cases

### 14. Lump-sum PO (single line, qty 1)
- **Trigger:** `po_itemized:false` — a single line of qty 1.00 (even if a "unit price" is printed). (`CR §4 Lump-sum`, `FC "po_itemized"`)
- **Handling:** skip per-line pairing, rate and quantity checks → *"N/A — PO lump-sum"*; **HSN/GST still run** on invoice lines.
- **Effect:** informational; header verdict unaffected.
- Scenario `08_lump_sum_po`.

### 15. Duplicate invoice
- **Trigger (exact):** same vendor + same invoice number already processed. **(near):** same vendor + same total + same date, *different* number. (`CR §7`, `CR §1 tie-break`)
- **Handling:** checked against an optional `opts.ledger` of prior invoices. Exact → flag *"EXACT DUPLICATE of …"*; near → flag *"Possible duplicate …"*. (The reference never silently rejects; it flags for review.)
- **Effect:** flag only.
- Scenario `12_duplicate_invoice`.

### 16. Split CGST + SGST vs single GST column
- **Trigger:** the invoice prints CGST and SGST separately rather than one GST total. (`FC` — "Split CGST + SGST + IGST → gst_total = cgst+sgst+igst")
- **Handling:** normalization sums the constituents into `tax_total`.
- **Effect:** normalization step; no flag.

---

## Summary

| Flips verdict → `No match` | Flag only (verdict unchanged) |
|---|---|
| 1 Vendor mismatch · 2 Total mismatch · 3 Outside FY | 4 Missing PO · 5 Fingerprint-only · 6 Multi-PO · 7 Handwritten ref · 8 Stray ref · 9 Over-billing · 10 Rate variance · 11 Line mismatch · 12 HSN/GST · 13 Date order · 14 Lump-sum · 15 Duplicate · 16 Split GST |

Three checks decide the verdict; the other thirteen make the decision **explainable**
without ever overruling it — exactly the reference skill's design, reduced to two ways.
