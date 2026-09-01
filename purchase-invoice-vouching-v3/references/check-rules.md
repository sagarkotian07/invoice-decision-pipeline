---
name: check-rules
description: The deterministic logic for vouching v3 — the match ladder (PR/PO → GSTIN+total → name+total fingerprint → possible → none), the three check tiers (reconciliation spine, per-line invoice compliance, conditional rate match), the GST-table lookup, round-off tolerance, three-state semantics, and reason templates. Read by the voucher.
---

# Vouching v3 — match & check rules

Every verdict is a mechanical comparison — do it in `container_python`, never by
eye. **Three states only:**

- **`agrees`** (✓) — verified equal / present / correct.
- **`fails`** (✗) — verified wrong / absent-when-required.
- **`unverified`** (—) — couldn't check (value not on the document, handwriting/
  stamp unreadable, HSN not in the rate table). Not a failure; a gap to review.

Tolerances + comparators (one place):
```python
import re
def amounts_equal(a, b):  return abs(a - b) <= max(1.00, 0.005 * abs(b))   # ₹1 or 0.5% (round-off)
def rates_equal(a, b):    return abs(round(a,2) - round(b,2)) <= 0.01
def pct_equal(a, b):      return abs(a - b) <= 0.0001                       # 0.18 == 0.18

# Vendor-name fingerprint key (rung 3). Identity is still the GSTIN — names vary by
# legal suffix / spelling, so normalise hard and let the EXACT total tie be the gate.
_LEGAL = re.compile(r"\b(PVT|PRIVATE|LTD|LIMITED|LLP|INC|CORP|CO|COMPANY|ENTERPRISES?|INDUSTRIES|TRADERS?|AND|&)\b")
def norm_name(s):
    s = _LEGAL.sub(" ", (s or "").upper())
    return re.sub(r"[^A-Z0-9]", "", s)                                     # drop suffixes/punct/space
def vendor_names_match(a, b):
    na, nb = norm_name(a), norm_name(b)
    return bool(na) and na == nb            # normalized-exact; if close-but-not-equal, the voucher may judge
```

---

## 1. Match ladder (sets PO match + basis + confidence)

Run per invoice; **stop at the first rung that fits**; record `match_basis` and
`confidence`. Normalise PR/PO refs (uppercase, strip spaces: "PR 2390" → "PR2390").

| Rung | Condition | basis / confidence |
|---|---|---|
| 1 | A `references[]` entry of kind `buyer_pr_po` equals a PO's `pr_number` or `po_number` | "PR/PO number" / **high** (printed) — or "PR (handwritten, review)" / **medium** if `handwritten: true` |
| 2 | No buyer PR/PO matches → **GSTIN fingerprint**: invoice `vendor_gstin` == PO `vendor_gstin` **and** `amounts_equal(invoice.total, po.total)` **and** the period is plausible | "GSTIN + total" / **medium** |
| 3 | Neither rung 1 nor rung 2 fires → **name fingerprint**: `vendor_names_match(invoice.vendor_name, po.vendor_name)` **and** `amounts_equal(invoice.total, po.total)` **and** the period is plausible | "Name + total" / **low** |
| 4 | GSTIN matches a PO but the total is off beyond tolerance | "possible match (GSTIN only)" / **low** → flag |
| 5 | Nothing ties | "No PO found" / — → flag |

- **Ignore `kind: "vendor_ref"`** entries (the vendor's own order number, e.g.
  Maini's "PO1963"). They are not the buyer's keys — never match on them.
- Rung 2 / rung 3 tie-break: if several POs share the same fingerprint (GSTIN+total,
  or name+total), pick the closest period; if still ambiguous, mark "possible match" /
  low and flag.
- **Rung 3 fires only after rungs 1–2 miss** and is gated on an **exact total tie**
  (`amounts_equal`) — never on the name alone. The name compare is the deterministic
  `vendor_names_match` (normalised, legal-suffix-stripped); if the names are clearly the
  same entity but not normalised-equal, you (the narrow judge) may confirm — default to
  not-match. A rung-3 hit is a **genuine** match (it runs the tiers and can be a "Match"),
  not a "possible"; the Tier-1 vendor-GSTIN check is what surfaces any GSTIN discrepancy.
- **Record the basis of the rung that actually fired.** A GSTIN fingerprint records
  `"GSTIN + total"`; a name fingerprint records `"Name + total"`; a printed-PR match
  records `"PR/PO number"`. Never write the basis of a rung that did not resolve this
  invoice — the written basis must equal the rung that fired.
- Match basis is **independent of the Match result** — a fingerprint (medium/low) match
  can still be a Match; a printed-PR (high) match can still be a No match on a tier
  check.

---

## 2. The three check tiers

### Tier 1 — Reconciliation spine (runs on every invoice)

| Check | Compare | agrees | fails | unverified |
|---|---|---|---|---|
| **Vendor (GSTIN)** | invoice `vendor_gstin` == matched PO `vendor_gstin` | equal | differ | no PO matched / GSTIN absent |
| **Total = PO** | `amounts_equal(invoice.total, po.total)` | equal (within round-off) | differ | no PO matched |
| **PO approved** | PO `approval.status` == "Approved" (all levels) | yes | any level not Approved | approval table unreadable |
| **Buyer stamp** | invoice `buyer_stamp.present == "yes"` AND the stamp is the **buyer's** (its text = the detected buyer; a **vendor seal does not count**) | buyer's stamp present | `"no"` (no buyer stamp) | `"unclear"` (stamp visible but not confirmed the buyer's) |
| **Dates in FY** | invoice_date ∈ FY **and** po_date ∈ FY (po_date = `requisition_date`) | both in FY | either outside FY (name which) | a date missing |
| **Date order** | invoice_date ≥ po_date | on/after | invoice before PO → **hard ✗ (shown red)** — but **does NOT flip the Match result** (POs here are routinely raised after billing) | a date missing |

### Tier 2 — Invoice compliance (per line, **invoice-level**)

**These are about the invoice itself, NOT the PO** — so they run on **every invoice
line, lump-sum or itemized.** They are **flags only**: they are checked and shown,
but they **never flip the Match result** (§5).

| Check | Logic | agrees | fails | unverified |
|---|---|---|---|---|
| **HSN/SAC valid** | structural: numeric and length ∈ {4,6,8} (SAC = 6 digits starting "99") | valid length | wrong length (e.g. 9-digit "388089191") or non-numeric | line has no HSN/SAC |
| **GST correct** | invoice `gst_rate` vs the correct rate for that HSN/SAC (§5) | `pct_equal` | differ | HSN absent, or HSN not in the table |

*(Footing and CGST=SGST split are **not** run or shown in v3 — see the Dropped note below.)*

### Tier 3 — Line pairing → Line match + Rate match (per bill line)

**These are the PO-relationship checks** — only meaningful when a bill line's
description actually pairs to a PO line. **Tier-3 (Line/Rate match) runs only when the
PO is itemized** (`po_itemized:true`); **Tier-2 (HSN/GST) still runs regardless.**
Like Tier-2, Tier-3 is **flag only** — it never flips the Match result (§5).

For an itemized PO, first **pair** each bill line to a PO line (HSN exact/prefix, else
description similarity — you are the narrow judge), then emit two per-line verdicts:

| Check | agrees | fails | unverified |
|---|---|---|---|
| **Line match** | bill line pairs to a PO line | no PO line pairs — an extra bill line not on the itemized PO → "No match" | no PO matched at all |
| **Rate match** | line paired **and** `rates_equal(invoice.rate, po.unit_price)` | paired but rates differ | line not paired, or no per-unit rate on the PO line → "—" |

- **Itemized PO** (`po_itemized:true`): pair each bill line to a PO line; emit Line
  match + Rate match per line; write every bill line **beside** its matched PO line,
  and append any PO line that matched no bill line as a row (Line match = "PO line
  not billed"). **Never fake a per-line match.**
- **Lump-sum PO** (`po_itemized:false`): per-line **matching** is meaningless (the PO
  has one lump line) → **skip Tier-3 (Line/Rate match)**. **Tier-2 (HSN valid + GST
  correct) STILL runs on every invoice line** — those are invoice-level and don't
  depend on the PO. Lines-sheet layout: write the **PO lump-sum line as the first
  row** (cited, in the PO columns), Line match = **"Line items not matched — PO lump
  sum"**; then write **each invoice line** as a row with **HSN valid + GST correct
  flagged**, Rate match = "—", Line match = "—". The lump line AND the invoice's
  per-line HSN/GST are all visible and cited; only the *matching* is skipped.

**Per-invoice `line_items_summary`** (one phrase for the Overview "Line items check"
column). Let `n` = bill lines that paired to a PO line, `m` = total bill lines:
- PO is lump-sum (`po_itemized:false`) → `"N/A — PO lump-sum"` (no count — a lump-sum
  PO has nothing to pair against, so **never** emit "k of m matched" here).
- itemized and `n == m` → `"All matched (m/m)"`.
- itemized and `0 < n < m` → `"n of m matched"`.
- itemized and `n == 0` → `"No line matched (0/m)"`.
- no PO matched at all → `"—"`.

This phrase is the **Overview** column only. The **Lines** sheet keeps its own per-row
`line_match.label` — the lump-sum row there still reads "Line items not matched — PO
lump sum". The two cells are intentionally worded differently; do not change the Lines
sheet.

**The `line_items_summary` is a FLAG only — it never affects the Match result** (§5).

**Dropped from v1 (do not run):** goods-vs-services classification, HSN
invoice-vs-PO matching, quantity match, arithmetic qty×rate-vs-total.
**Dropped in v3 (do not run, do not write):** invoice **footing** (Σ lines = total)
and the **CGST=SGST split** check — neither is a verdict, a column, or a flip cause.

---

## 3. GST rate lookup (§5 — the "correct rate" authority)

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
    if not hsn: return None                  # no HSN -> unverified
    if hsn in rates: return rates[hsn]
    if hsn[:4] in rates: return rates[hsn[:4]]  # 4-digit heading fallback
    return None                              # not in table -> unverified
```
- Path: the user override, else `…/purchase-invoice-vouching-v3/references/gst-hsn-rates.csv`.
- The correct rate is a **rule** → plain text on the workpaper (e.g. "18% (HSN 9405)"), no link.
- The table is **indicative, as of FY 2025-26** — surface once in the report:
  "GST checked against the bundled FY 2025-26 table; confirm against the current
  notification." **Advisory caveat:** vendors here often bill a *service* under a
  *goods* HSN (3808, 8516). When the GST check fails only because the HSN looks
  misclassified, say so in the line note rather than asserting the rate is wrong.

---

## 4. Reason templates (fill the braces; ≤ ~12 words)
```
Vendor:   "Invoice GSTIN {a} ≠ PO GSTIN {b}"
Total:    "Invoice {inv} vs PO {po} (diff {d})"
Approval: "PO not fully approved — {level}: {status}"
Stamp:    "Buyer stamp/signature not found on invoice"   |  "(stamp unclear — review)"
FY:       "{which} date {date} outside FY {fy_start}–{fy_end}"
HSN:      "HSN '{hsn}' is {len}-digit — not a valid 4/6/8-digit code"
GST:      "Charged {bill}%; correct for HSN {hsn} is {correct}%"  | "(HSN looks misclassified)"
Rate:     "Invoice {inv_rate} vs PO {po_rate} per unit"
NoPO:     "No PO matched"   |  "Possible match only (GSTIN, total off)"
```
The Overview `reason` is **why the Match result is "No match"** — built **only from
the header fails** that flip it (Vendor, Total, Approval, Stamp, FY, NoPO). The
**HSN / GST / Rate / Line-match** templates are **line-level flags** — they do **not**
flip the verdict, but they ARE surfaced (see `flag_note` below). Date-order is never a
reason (it does not flip) and shows only in its own column.

**`flag_note`** (`overview.checks.flag_note`) — a compact, **always-computed** summary
of the per-line flags that were raised but did NOT flip the verdict, so a clean-header
**Match** still surfaces e.g. its invalid-HSN finding. Count, across the invoice's lines:
HSN invalid (`hsn_valid == "fails"`), GST incorrect (`gst_correct.state == "fails"`),
rate mismatch (`rate_match == "fails"`), unmatched bill line (`line_match.state ==
"fails"`). Emit a short phrase joining the present flags with "; " — e.g.
`"Flag: HSN invalid on 2 line(s)"` or `"Flag: HSN invalid on 1 line(s); GST off on 1
line(s)"`; **empty string** when there are no flags. The Overview **Reason** column
shows `flag_note` **regardless of the Match result**; on a "No match" row the header
`reason` is shown first, then the `flag_note`.

---

## 5. Match result ("Match" / "No match")

The headline verdict. **No "flag" terminology** — the column reads **"Match"** or
**"No match"**. The verdict is **header-driven** — it is decided by the Tier-1
reconciliation spine alone.
```
HEADER_FAILS = any of these Tier-1 verdicts == "fails":
    total_match, vendor_match, po_approved, stamp, dates_fy        # NOT date_order

result = "No match"  if HEADER_FAILS  OR  match in {"possible", "No PO found"}
       = "Match"     otherwise
```
A **rung-3 "Name + total"** match is a genuine match — it is **not** in the forced-
No-match set above. It reconciles like a GSTIN fingerprint: if the invoice GSTIN is
absent/unreadable, `vendor_match` is "—" (no flip) and a clean header → "Match"; if the
invoice GSTIN is present but **differs** from the matched PO, `vendor_match` = "fails"
→ HEADER_FAILS → "No match" (correctly surfacing the GSTIN discrepancy).

**Per-line checks never flip the result.** Line match, rate match, HSN validity and
GST correctness are **flags only** — they are shown/surfaced for the auditor but an
invoice whose header reconciles is a **Match** even if a line is unmatched, a rate
differs, an HSN is malformed, or a GST rate looks off. (This is the v3 rule the user
locked: the line-items summary must not affect match/unmatch.)
- **`date_order` never flips the result** — it renders as a hard red ✗ in its own
  column, but an invoice dated before its PO stays a **Match** if the header reconciles.
- **`unverified` (—) never flips it** — a missing HSN, an unclear stamp, an
  un-pairable lump-sum line are gaps, not failures. Shown as "—" / their label and
  named for review.
- Match basis/confidence is reported **independently** of the result.
- `reason` (the No-match cause) is populated **only when result == "No match"**, from
  the §4 templates of whichever **header** checks failed. The Overview **Reason** column
  shows `reason` (when "No match") **and** the `flag_note` (always, even on a "Match") —
  so per-line HSN/GST/rate/line flags are visible there without ever flipping the verdict.
