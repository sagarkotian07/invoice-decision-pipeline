---
name: check-rules
description: The deterministic logic for the four-way match — the backwards ladder (register → invoice → PO → GRN), the four check tiers (reconciliation spine, invoice compliance, quantity flow + sanity dates, line pairing), the GST-table lookup, the tolerances, three-state semantics, the reason templates, and the header-driven Match-result formula with the forced no-invoice clause. Read by the matcher.
---

# Four-way match — match & check rules

Every verdict is a mechanical comparison — do it in `container_python`, never by eye.
**Three states only:**

- **`agrees`** (✓) — verified equal / present / correct.
- **`fails`** (✗) — verified wrong / absent-when-required.
- **`unverified`** (—) — couldn't check (value not on the document, a register column
  absent, a GRN missing, handwriting unreadable, HSN not in the rate table). Not a
  failure; a gap to review.

Tolerances (one place):
```python
def amounts_equal(a, b):     return abs(a - b) <= max(1.00, 0.005 * abs(b))  # PO/invoice round-off (₹1 or 0.5%)
def reg_amounts_equal(a, b): return abs(a - b) <= max(1.00, 0.01  * abs(b))  # REGISTER band (₹1 or 1% — the locked tolerance)
def rates_equal(a, b):       return abs(round(a,2) - round(b,2)) <= 0.01
def pct_equal(a, b):         return abs(a - b) <= 0.0001                      # 0.18 == 0.18
def qty_le(a, b):            return a <= b + 1e-9                             # directional qty (received≤ordered, billed≤received)
```

The match is **register-anchored**: the unit of work is one **register posting**, and the
chain resolves **backwards** — posting → Invoice → PO → GRN(s).

---

## 1. The backwards match ladder (sets the chain + basis + confidence)

Run **per register posting**. Resolve each hop; record the rung that fired per hop. The
displayed `confidence` is the **weakest** across the resolved hops. Normalise refs
(uppercase, strip spaces: "PR 2390" → "PR2390"; invoice numbers also strip non-alphanumerics
and leading zeros for the **key**, keep the raw for display).

### Hop 1 — Register → Invoice (the anchor)
| Rung | Condition | basis / confidence |
|---|---|---|
| 1 | posting `invoice_no`(norm) == an invoice `invoice_number`(norm) **AND** vendor reconciles (register `vendor_gstin` == invoice `vendor_gstin`, else normalized names equal) | "Invoice no + vendor" / **high** |
| 2 | `invoice_no` matches but vendor can't be confirmed (register has no GSTIN and names differ) | "Invoice no only" / **medium** → vendor check flagged `unverified` |
| 3 | no `invoice_no` match → **fingerprint**: `reg_amounts_equal(register.total, invoice.total)` **AND** vendor name reconciles **AND** booking period plausible | "Total + vendor (fingerprint)" / **medium** |
| 4 | nothing ties | **"No invoice found"** / — → **forces "No match"** (§5) |

Tie-break: if several invoices share a number (rare, cross-vendor), disambiguate by vendor
then by `amounts_equal(total)`; still ambiguous → "Multiple (n)" / low, **flag** (§7).

### Hop 2 — Invoice → PO (reuse the vouching ladder)
Once Hop 1 resolves an invoice, match it to a PO exactly as vouching v3 does:
| Rung | Condition | basis / confidence |
|---|---|---|
| 1 | an invoice `references[]` entry of kind `buyer_pr_po` equals a PO's `pr_number` or `po_number` (printed or handwritten) | "PR/PO number" / **high** (printed) — or "PR/PO (handwritten, review)" / **medium** if `handwritten` |
| 2 | no buyer PR/PO → **fingerprint**: invoice `vendor_gstin` == PO `vendor_gstin` **AND** `amounts_equal(invoice.total, po.total)` **AND** period plausible | "GSTIN + total" / **medium** |
| 3 | GSTIN matches but total off beyond tolerance | "possible match (GSTIN only)" / **low** → flag |
| 4 | nothing ties | "No PO found" / — → flag (does **not** force No-match — §5) |

**An invoice may legitimately span several POs.** Run rung 1 across **all** the invoice's
`buyer_pr_po` references and **gather every PO that matches** (plus same-bundle POs) →
`matched_pos` (a **list**, not a single PO). Each invoice **line** belongs to one of these POs;
the quantity flow and `Total = PO` (Tier 1) treat the matched POs as **jointly** fulfilling the
one invoice (so `Total = PO` compares the invoice total to the **Σ of the matched POs' totals**).
`matched_pos` empty → "No PO found" (missing-doc semantics below). Record a per-PO basis; the
hop's confidence is the **weakest** across the matched POs.

- **Ignore `kind: "vendor_ref"`** entries (the vendor's own order number) — never match on them.
- If the **register** supplied a `po_no`, use it as a **corroborating** signal only: if it
  disagrees with the PO matched via the invoice's ref, raise a flag — but the primary PO
  join is always the invoice's `buyer_pr_po`.

### Hop 3 — PO → GRN(s)
Once Hop 2 resolves a PO, gather **all** GRNs whose `po_number`(norm) == the matched PO's
`po_number` **and** whose vendor reconciles → `matched_grns` (possibly empty). No fingerprint
fallback — a GRN with no PO ref is unusable (record it in diagnostics).

### Bundle co-location (documents from a bundled PDF)
A **bundle** is one PDF holding several documents; each extracted document carries a
`bundle_id` (the bundle stem) and `segment_index`. When the invoice resolved in Hop 1 has a
non-null `bundle_id`, narrow Hops 2 & 3 to **same-bundle candidates first** — a *preference*,
never a restriction:
- **Hop 2 (invoice→PO):** try POs with the **same `bundle_id`** before the global pool. Apply
  the rung-1 ref match among them (a bundle may hold several POs — the printed PR/PO ref still
  picks the right one). A same-bundle PO that ref-matches → basis **"PR/PO (same bundle)" /
  high**. If a same-bundle PO exists but its number **disagrees** with the invoice's printed
  `buyer_pr_po`, **still pair them** (they were filed together) but raise the flag **"bundle PO
  ref mismatch"** (§4). **No same-bundle PO** (partial bundle, or the PO is a separate PDF) →
  **fall back to the global ladder** (rungs 1–4) unchanged.
- **Hop 3 (PO→GRN):** prefer GRNs with the **same `bundle_id`**; otherwise the normal
  `po_number` match. A same-bundle GRN whose printed `po_number` disagrees with the matched PO
  also raises **"bundle PO ref mismatch"**.
- Co-location **narrows candidates and raises confidence**; it never forces a pairing the refs
  contradict (that becomes the flag), and never excludes a correct cross-PDF match when the
  bundle lacks the counterpart. Record `"(same bundle)"` in the per-hop basis when it fired.

### Missing-document semantics (the three-state model, per hop)
| Missing | Effect on the Match result | Effect on checks |
|---|---|---|
| **No invoice** (Hop-1 rung 4) | **blank** — no verdict written (§5) | the appended row is left **blank** (Match result + Reason empty, every downstream check `unverified`). The posting isn't reconcilable; in a partial doc set it usually just means the invoice wasn't attached. The count is still reported in `diagnostics` / the chat summary. |
| **No PO** (Hop-2 fails) | does **not** flip | Total=PO and the PO↔GRN quantity checks → `unverified`. Register↔invoice reconciliation can still pass → the posting can stay a **Match** with PO checks "—". Flag it in the Reason. |
| **No GRN** (Hop-3 empty) | does **not** flip | quantity-flow checks → `unverified`; raise the flag "No GRN — receipt unconfirmed". |

> **Never fabricate a document from another document's reference.** A GRN prints the `po_number`
> it was received against; an invoice prints its PR/PO ref; a register row prints an invoice no.
> Those are **join keys (pointers), not evidence.** If no PO document loaded, the PO is
> **"No PO found"** and every PO check is `—` — do **not** synthesize a PO out of a GRN's
> `po_number` (and never the reverse). A pointer to a document is not the document. If a whole
> doc-type loads **zero** records, that is a load/contract fault → record it in `diagnostics`
> and degrade via the three-state model; it is never licence to invent.

Record `match`: the per-hop bases and the resolved files, e.g.
`{"invoice": {"file": ..., "basis": "Invoice no + vendor", "confidence": "high"},
  "po": {"file": ..., "basis": "PR/PO number", "confidence": "high"},
  "grns": ["grn-a.pdf", "grn-b.pdf"], "chain_basis": "Inv no+vendor → PR/PO → 2 GRNs",
  "confidence": "high"}`. **Basis names the rung that fired** at each hop, independent of
the Match result.

---

## 2. The four check tiers

### Tier 1 — Reconciliation spine (VERDICT-DRIVING — runs on every posting)

| Check | Compare | agrees | fails | unverified |
|---|---|---|---|---|
| **Vendor** | register vendor reconciles to invoice **seller** GSTIN (GSTIN==GSTIN, else normalized names); invoice GSTIN == PO GSTIN | all reconcile | a pair differs | no invoice matched / register has no GSTIN and names can't be confirmed |
| **Total = PO** | `amounts_equal(invoice.total, Σ(matched-PO totals))` — the matched POs jointly fulfil the one invoice | equal (round-off) | differ | no PO matched |
| **Dates in FY** | invoice_date ∈ FY **and** po_date (`requisition_date`) ∈ FY **and** register `booking_date` ∈ FY | all in FY | one outside FY (name which) | a date missing |
| **Register: Taxable = Invoice** | `reg_amounts_equal(register.taxable, invoice.taxable_total)` | equal (band) | differ | register taxable absent / no invoice |
| **Register: GST = Invoice** | `reg_amounts_equal(register.gst_total, invoice.tax_total)` | equal (band) | differ | register GST absent / no invoice |
| **Register: Total = Invoice** | `reg_amounts_equal(register.total, invoice.total)` | equal (band) | differ | register total absent / no invoice |

The three **Register** members are the new reconciliation spine. They go `unverified`
(not `fails`) when a register column was absent or no invoice was traced — and `unverified`
never flips (§5).

**Custom spine member (opt-in):** when the auditor enabled the site-name check (`custom_checks`
⊇ `{"site_name"}`), **`site_consistent`** joins this Tier-1 spine — **verdict-driving**. It is a
**semantic** judgment of whether the register posting + **every** matched PO / GRN / invoice name
the **same physical site** — tolerant of a trailing qualifier ("MANIPUR", "Phase 2"), an
abbreviation, or reordered words (never exact-string, never a tunable ratio). `agrees` when the
present sites are the same place; **`fails` only when they are confidently DIFFERENT places** (a
`fails` flips the result); `unverified` when fewer than two carry a site or it's genuinely unclear
(and `unverified` never flips). A name **variant never flips** to No match (e.g. "AKALPYA" vs
"AKALPYA MANIPUR" = same site → `agrees`). When the check is off it is absent — no column, no
verdict effect.

### Tier 2 — Invoice compliance (FLAG only — per invoice line, invoice-level)
**About the invoice itself, not the PO/GRN** — runs on **every invoice line**. Flags only;
they never flip the Match result (§5).

| Check | Logic | agrees | fails | unverified |
|---|---|---|---|---|
| **HSN/SAC valid** | structural: numeric, length ∈ {4,6,8} (SAC = 6 digits starting "99") | valid length | wrong length / non-numeric | line has no HSN/SAC |
| **GST correct** | invoice `gst_rate` vs the correct rate for that HSN/SAC (§3) | `pct_equal` | differ | HSN absent, or HSN not in the table |

### Tier 3 — Quantity flow + sanity dates (FLAG only — the core new value)
Runs across PO (ordered) → GRN (received) → Invoice (billed), keyed per item
(**`material_code` when present, else normalized description** — the narrow-judge pairing).
For each item: `ordered` = PO line qty; `received` = Σ `qty_received` across `matched_grns`;
`billed` = invoice line qty.

| Check | Logic | agrees | fails (flag) | unverified |
|---|---|---|---|---|
| **Over-receipt** | `qty_le(received, ordered)` | received ≤ ordered | received > ordered (over-receipt) | no GRN / lump-sum PO / service GRN (no qty) |
| **Over-billing** | `qty_le(billed, received)` | billed ≤ received | billed > received (paying for more than arrived) | received or billed missing |
| **Receipt-date sanity** | each GRN `receipt_date` ≥ PO `requisition_date` | on/after | a GRN before its PO | a date missing / no GRN |
| **Invoice-date sanity** | invoice_date ≥ **earliest** GRN `receipt_date` | on/after first receipt | invoice before goods arrived | a date missing / no GRN |
| **Booking-date sanity** | register `booking_date` ≥ invoice_date **and** ∈ period | on/after, in period | booked before billed / wrong period | a date missing |
| **Date order (PO↔Inv)** | invoice_date ≥ po_date (v3's) | on/after | invoice before PO → **hard ✗ (red)** | a date missing |

Roll the per-item quantity verdicts into a one-phrase **`qty_flow_summary`** for the
Overview (e.g. "Ordered 83 / Received 80 / Billed 80 — clean"; "Over-billed 2 item(s)";
"Over-received 1 item(s)"; "N/A — PO lump-sum"; "—" when no PO). An item that appears in a
GRN but not on the PO → flag "received item not ordered"; an item ordered but in no GRN →
received `unverified` (never 0).

**Per-delivery rendering (the writeback fans this out).** A single invoice line is often
received across **several partial-delivery GRNs**. On the Lines sheet each invoice line shows
**one row per GRN delivery** (that GRN's number + its received qty); `received` for the
over-receipt / over-billing checks is the **Σ across those delivery rows**, evaluated on the sum,
never on any single delivery. So the matcher must emit, per invoice line, the **list** of GRN
deliveries (each with its own `qty_received` + cite) plus the `received_total` Σ — see
`matcher.md` (`lines[].grns[]`).

### Tier 4 — Line pairing → Line match + Rate match (FLAG only — per invoice line)
The PO-relationship line checks, as in vouching v3. **Runs only when the PO is itemized**
(`po_itemized: true`); **Tier-2 (HSN/GST) and Tier-3 (qty flow) still run regardless.**

**Source the line items from the nested key `lines`.** Each invoice / PO / GRN record carries its
line items under `rec["lines"]` — read `rec.get("lines", [])`, **never `line_items` or `items`** (a
wrong key returns `[]` and silently reads as "no line items", which dropped 6 of 16 invoices' lines at
scale). **A matched, itemized posting MUST emit ≥1 Lines row** (one per invoice line, via the
`build_lines` skeleton in `matcher.md`); the **only** legitimate empty-pairing case is a lump-sum PO
(emit a `lump_sum` row + per-line `bill_only`, never `lines = []`).

**Pair the SAME product across invoice ↔ PO ↔ GRN, judged generously.** The three documents
describe one physical item in three different wordings, so verbatim matches are the exception:
1. **Exact key (Python):** pair lines that share an **identical normalized description** OR an
   **exact HSN + exact material/item code**. The easy bulk; remove them.
2. **Same-product judgment:** for the rest, decide **whether two lines are the same product** —
   **drop brand/qualifier words** ("SUPREME", "MAKE", a vendor brand), treat **fitting/material
   synonyms as the same** (a **45° ELBOW = a 45° BEND**: "110MM PVC BEND 45 DEGREE" = "110MM SUPREME
   PVC ELBOW 45"), tolerate size/format/OCR differences, corroborate with HSN + quantity. Keep
   **genuinely different products apart** — an **elbow is NOT a coupler** (different fittings). That
   is the real distinction; do **not** refuse a pair just because the words differ.
3. **Elimination fallback:** if the leftover unmatched invoice / PO / GRN lines are few and line up
   **1-to-1** (a single leftover on each side), **pair them** — they are the only candidates (a
   single-line `CHORIU` invoice pairs to a single-line `FILLING SAND` PO and its GRN line). Don't
   leave the only candidates unpaired.

Only emit `bill_only` / `po_only` / `grn_only` on a genuine **count surplus** with no plausible
counterpart (e.g. a freight "CARTING" invoice line with no PO/GRN line).

> **Don't implement pairing as a tunable string-similarity score you run and re-tune** — that is the
> one wasteful pattern. Reading the handful of lines per posting and judging same-product directly,
> in a single pass, is correct and fast. **Correctness — connecting the same item — comes first.**

**Surface every GRN line.** Attach each matched GRN line to its pair; any GRN line with no
invoice/PO counterpart becomes a **`grn_only` row** — never silently drop a GRN line. Then:

| Check | agrees | fails | unverified |
|---|---|---|---|
| **Line match** | invoice line pairs to a PO line | no PO line pairs — extra billed line not on the PO | no PO matched |
| **Rate match** | line paired **and** `rates_equal(invoice.rate, po.unit_price)` | paired but rates differ | line not paired, or no per-unit rate on the PO line |

- **Itemized PO:** pair each invoice line to a PO line; write every invoice line **beside**
  its matched PO line **and** its matched GRN line (qty received), all cited; append any PO
  line that paired to nothing as a `po_only` row ("PO line not billed"); append any GRN line
  with no PO/invoice pairing as a `grn_only` row ("received item not ordered"). Don't fake a pair
  where the products **genuinely differ** (a real extra/missing item) — but the same item in
  different wordings (brand prefix, elbow/bend synonym, OCR variant) and 1-to-1 only-candidates
  **do** pair (the generous + elimination rules above).
- **Lump-sum PO** (`po_itemized: false`): per-line matching is moot → **skip Tier-4 (Line/Rate
  match) and the per-item quantity flow** (it has no per-item ordered qty → "N/A — PO
  lump-sum"). **Tier-2 (HSN/GST) STILL runs on every invoice line.** Lines-sheet: a `lump_sum`
  row (cited PO lump line, Line match "Line items not matched — PO lump sum"), then one
  `bill_only` row per invoice line with its HSN/GST flags.

**Per-posting `line_items_summary`** (Overview "Line items check" column). Let `n` = invoice
lines paired to a PO line, `m` = total invoice lines:
- lump-sum PO → `"N/A — PO lump-sum"` (no count). · itemized & `n==m` → `"All matched (m/m)"`.
- itemized & `0<n<m` → `"n of m matched"`. · itemized & `n==0` → `"No line matched (0/m)"`.
- no PO matched → `"—"`. A flag only — never flips the result.

**Dropped (do not run, do not write):** invoice footing, CGST=SGST split.

### Identity checks (promoted to explicit cells) + how checks render
Three "exact match" checks that were previously only the join logic are now **explicit verdicts**:
- **`vendor_match`** (Tier 1) — extended to span **all four** docs: register↔invoice (GSTIN,
  else normalized name) **and** invoice↔PO GSTIN **and** the GRN vendor reconciles.
- **`po_num_consistent`** (header) — every invoice PR/PO ref **and** every matched GRN's
  referenced PO# falls **within `matched_pos`** (set membership across the multi-PO chain — not a
  single equality). `agrees` when all **present** refs resolve to a matched PO; `fails` on a stray
  ref that matches none; **`unverified` when no PO matched OR the invoice carries no `buyer_pr_po`
  ref at all** — a fingerprint-only chain (invoice→PO matched by GSTIN+total, no printed PO ref)
  cannot confirm the invoice cites this PO, so the verdict is `—`, **never a green ✓**. (The
  GRN↔PO half is tautologically true for a fingerprint match and must **not** stand in for
  invoice↔PO consistency — that green ✓ is meaningless and misleads the auditor.) Judged from the
  resolved chain (no formula).
- **`item_match`** (per Lines row) — the same item appears across PO, GRN & invoice (by
  material code where present, else description). Judged.

**Rendering (set by the writeback, stated here so the matcher emits the right shape):** the
**deterministic** checks become **live in-cell Excel formulas** — Total=PO, Reg Taxable/GST/
Total (reference the user's register cell via a `formula_ref`), HSN valid, rate
match, over-receipt, over-billing. The **judged/lookup** checks stay **computed glyphs** —
vendor, po_num_consistent, item_match, GST correct (HSN-table lookup), line match,
dates-in-FY. **Every check column header carries a note** explaining its computation. The matcher
still computes *every* verdict (it drives MATCH RESULT + the cell fill); the formula just makes
the deterministic ones live and auditable. So the matcher must emit numeric `qty_received` (Σ,
breakdown in `source_text`) and a `formula_ref` per `overview.register.{taxable,gst,total}`.

---

## 3. GST rate lookup (the "correct rate" authority — Tier 2)
Default = the bundled table; a user master overrides it.
```python
import csv
def load_gst_table(path):
    rates = {}
    for row in csv.reader(open(path)):
        if not row or row[0].lstrip().startswith("#") or row[0] == "hsn_sac":
            continue
        rates[row[0].strip()] = float(row[1].strip()) / 100.0
    return rates
def correct_gst(hsn, rates):
    if not hsn: return None                       # no HSN -> unverified
    if hsn in rates: return rates[hsn]
    if hsn[:4] in rates: return rates[hsn[:4]]    # 4-digit heading fallback
    return None                                   # not in table -> unverified
```
- Path: the user override, else `…/purchase-four-way-match/references/gst-hsn-rates.csv`.
- The correct rate is a **rule** → plain text on the workpaper ("18% (HSN 9405)"), no link.
- Indicative, FY 2025-26 — surface once: "GST checked against the bundled FY 2025-26 table;
  confirm against the current notification." Vendors here often bill a *service* under a
  *goods* HSN (3808, 8516); when GST fails only because the HSN looks misclassified, say so
  rather than asserting the rate is wrong.

---

## 4. Reason templates (fill the braces; ≤ ~12 words)
```
Vendor:    "Register/invoice/PO vendor mismatch ({which})"
TotalPO:   "Invoice {inv} vs PO {po} (diff {d})"
FY:        "{which} date {date} outside FY {fy_start}–{fy_end}"
RegTax:    "Register taxable {r} vs invoice {i} (diff {d})"
RegGST:    "Register GST {r} vs invoice {i} (diff {d})"
RegTotal:  "Register total {r} vs invoice {i} (diff {d})"
NoPO:      "No PO matched (PO checks unverified)"   |  "Possible match only (GSTIN, total off)"
BundleRef: "Bundle PO ref {a} ≠ invoice ref {b} (filed together)"
Site:      "Site mismatch — {which}: {a} ≠ {b}"
```
The Overview `reason` is **why the Match result is "No match"** — built **only from the
header (Tier-1) fails** that flip it (Vendor, Total=PO, FY, the three Register members, **and
Site when the site check is on**). A **no-invoice** posting has **no reason** — its whole row is
left blank (§5). The HSN / GST / Rate / Line-match / over-receipt / over-billing / date templates
are **flags** — they do **not** flip the verdict; they surface in `flag_note`. NoPO and the
date-order ✗ never flip (NoPO leaves PO checks "—"; date-order shows only in its own column).

**`flag_note`** (`overview.checks.flag_note`) — a compact, **always-computed** summary of
the flags raised but not verdict-flipping, so a clean-header **Match** still surfaces its
findings. Count, across the posting: HSN invalid, GST off, rate mismatch, unmatched line,
**over-receipt item(s)**, **over-billing item(s)**, **no GRN**, **bundle PO ref mismatch**.
Join present flags with "; " — e.g. `"Flag: over-billed 1 item(s); bundle PO ref mismatch"`;
empty string when none. The Overview **Reason** column shows `flag_note` **regardless of the Match result**;
on a "No match" row the header `reason` is shown first, then `flag_note`.

---

## 5. Match result ("Match" / "No match")
The headline verdict. **No "flag" wording** — the column reads **"Match"** or **"No match"**.
**Header-driven** — decided by the Tier-1 reconciliation spine alone, plus the two
match-resolution clauses.
```
HEADER_FAILS = any of these Tier-1 verdicts == "fails":
    vendor_match, total_match, dates_fy,
    reg_taxable_match, reg_gst_match, reg_total_match,         # NOT date_order, NOT qty flow
    site_consistent     # ONLY when "site_name" ∈ custom_checks (opt-in custom member, verdict-driving)

result = ""          if match.invoice == "No invoice found"    # NO traceable invoice → leave the
                                                               # whole appended row BLANK (Match
                                                               # result + Reason empty). Nothing to
                                                               # reconcile; in a partial doc set this
                                                               # usually just means the invoice wasn't
                                                               # attached. The count is still surfaced
                                                               # in diagnostics / the chat summary.
       = "No match"  if HEADER_FAILS
       = "Match"     otherwise
# NO no-PO clause: a missing PO leaves the PO checks "—" (unverified never flips) and is
# surfaced via the NoPO flag in the Reason — register↔invoice reconciliation can still pass,
# so the posting may stay a Match. (Harmonised with §1's missing-doc table + SKILL.md; the old
# `match.po in {...}` clause was a v3 invoice-anchored holdover that contradicted this design.)
```
**Per-line and quantity checks never flip the result.** Line match, rate match, HSN
validity, GST correctness, **over-receipt, over-billing**, and **all sanity dates** are
**flags only** — surfaced for the auditor but a posting whose header reconciles is a
**Match** even if goods were over-billed, a line is unmatched, a date is out of order, or an
HSN is malformed.
- **`date_order` never flips** — hard red ✗ in its own column; the posting stays a Match if
  the header reconciles.
- **`unverified` (—) never flips** — a missing GRN, an absent register GST column, a
  lump-sum PO are gaps, not failures. **No-invoice** is the one absence handled specially:
  it doesn't flip to No-match, it **blanks the whole appended row** (§6).
- Match basis/confidence is reported **independently** of the result.
- `reason` is populated **only when result == "No match"**, from the §4 header templates;
  the Overview Reason also always shows `flag_note`. A **no-invoice** posting writes **nothing**
  (blank result + blank reason).

---

## 6. Why no-invoice blanks the row (read this)
A posting with no traceable invoice can't be reconciled at all — vendor, total=PO, and all
three register members are `unverified` because there's nothing to compare against. In this
workflow the document set is typically **partial** (only some invoices attached against a full
register), so a "no invoice found" row almost always means *the invoice simply wasn't in this
batch* — not a real exception. Writing **"No match" + "No invoice traced"** on dozens of such
rows floods the sheet with red noise that drowns the genuine findings. So a no-invoice posting
is left **blank** (no Match result, no Reason, empty bands) — the augmented sheet shows only the
rows where a chain was actually found. **The signal is not lost:** the matcher counts no-invoice
postings into `diagnostics` / its summary, and Phase 3d reports the coverage total, so a genuinely
complete doc set with a still-unmatched posting surfaces in the chat summary rather than on the
sheet. (If a future engagement wants booked-but-unsupported rows flagged ON the sheet, that's a
deliberate opt-in — not the default.)

---

## 7. Edge specifics
- **Multiple invoices per posting** (a consolidated booking): if `reg_amounts_equal(register.total,
  invoice_a.total + invoice_b.total)`, set `match.invoice = "Multiple (n)"`, confidence low,
  **flag**; run reconciliation against the **summed** invoices. Never silently pick one.
- **No GSTIN in the register** → vendor match is name-based; an unreconcilable name is
  `unverified` (not `fails`) — a name typo isn't a false fail, but it is flagged.
- **Partial GRNs**: aggregate received qty across all matched GRNs (carry each constituent
  GRN line's cite). Received < ordered across all GRNs is **informational** (incomplete
  delivery), not a fail — only received **>** ordered (over-receipt) is a flag.
- **Service GRN / lump-sum PO / no-qty invoice line** → the quantity flow degrades to "—"
  per the three-state model; never coerce a missing quantity to 0.
