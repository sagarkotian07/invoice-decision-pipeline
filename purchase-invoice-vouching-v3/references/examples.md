# Vouching v3 — worked examples (from the real PLHHOA batch)

Buyer detected from the POs: **PRESTIGE LAKESIDE HABITAT HOA**, GSTIN
`29AAIAP5202C1ZT`. FY 2025-26. Match each shape in production.

**v3 verdict model (read first):** the headline is **"Match" / "No match"** (no
"flag"), decided by the **header (Tier-1) checks ONLY** — vendor GSTIN, total=PO, PO
approved, client stamp, dates-in-FY (or an unresolved match). Everything per-line is a
**flag that never flips the verdict**:
- **HSN valid + GST correct** — *invoice-level* (about the invoice, not the PO).
  Checked + flagged on **every** invoice line, lump-sum or itemized.
- **Line match + rate match** — *PO-relationship*. Run only when the PO itemizes.
- **Date-order** (invoice before PO) — a hard red ✗, shown but never flips.

No footing / no CGST=SGST split column. Vendor GSTIN = the **seller-block** one (an
invoice prints the buyer's too). Stamp must be the **client's** (PLHHOA).

**Overview additions (v3):** the PO block carries a **PO Type** column
("Itemized" / "Lump-sum"); the **Reason** column shows any per-line **flag note**
(e.g. "Flag: HSN invalid on 2 line(s)") **even on a Match**; and a lump-sum PO's
**Line items check** reads **"N/A — PO lump-sum"** (no count). The Lines sheet is
unchanged — its lump-sum row still labels Line match "Line items not matched — PO lump
sum".

---

## Example 1 — Handwritten PR + lump-sum PO + invalid HSN flagged (Pest Doctor)

**Invoice** TI/4643: vendor Pest Doctor (seller GSTIN …2038B1ZB; the buyer GSTIN
…5202C1ZT is also printed in the Bill-To block — don't confuse them), no. 372,
**01-04-2025**, total ₹80,240, a **handwritten "PR2390"**, PLHHOA stamp present, lines
incl. **9-digit HSNs** "388089191"/"38089191". **PO** PO2279/PR2390, **lump-sum** (one
pest-control line, **qty 1.00** — a Unit Price is printed but it's the lump total),
Approved, requisition **02-04-2025**.

- Match: rung 1, buyer PR "PR2390" (handwritten) → basis **"PR/PO (handwritten,
  review)", medium**.
- Tier 1 (header): vendor GSTIN ✓ · total 80,240 = PO 80,240 ✓ · approved ✓ · client
  stamp ✓ · dates-in-FY ✓ · date-order ✗ (red; 01-Apr before PO 02-Apr — **doesn't flip**).
- Tier 2 (invoice-level, still runs): HSN "3808" valid ✓; **"388089191" 9-digit →
  invalid ✗** (flagged); GST 18% correct for 3808 ✓. These are flags only.
- Tier 3 (PO lump-sum → matching skipped): no per-line pairing. Overview Line items
  check = **"N/A — PO lump-sum"** (no count).
- **Match result: Match** — every header check reconciles. The invalid HSN is a
  **flag** (shown on the Lines sheet **and** summarised in the Overview Reason column as
  "Flag: HSN invalid on N line(s)") but does **not** make it "No match" — the Reason
  column carries the flag even though the verdict is a Match.

On the sheets: **Overview** → PO block shows **PO Type "Lump-sum"**; CHECKS (basis
"PR/PO handwritten (medium)" · Total=PO ✓ · Vendor ✓ · PO appr ✓ · Stamp ✓ · Dates FY ✓
· **Match result "Match"** · Date order ✗ red · Line items **"N/A — PO lump-sum"** ·
**Reason "Flag: HSN invalid on 2 line(s)"** — shown even though it's a Match).
**Lines** (unchanged): a first row = the PO lump line (cited, Line match "Line items not
matched — PO lump sum"), then one row per invoice line with **HSN valid / GST correct**
flagged (line 2 shows HSN ✗) and Rate/Line match "—" — every row cited.

---

## Example 2 — Vendor-printed PO ignored → fingerprint (Maini), prior-FY → No match

**Invoice** TI/4651: vendor Maini (seller GSTIN …8922D1ZG), prints **"Cust PO No:
PO1963"** (the vendor's own ref) — **ignored**. No PLHHOA PR clearly printed. Total
₹76,700, line "14-seater buggy rental", SAC 996609, **qty 2 @ 32,500**, PLHHOA stamp
present. **PO** PO2285/PR2393, **itemized** (2 Pcs @ 32,500), Approved.

- Match: rung 1 fails (PO1963 is `vendor_ref`, ignored) → rung 2 **fingerprint**:
  seller GSTIN …8922D1ZG + total 76,700 → matches PO2285. Basis **"GSTIN + total",
  medium** (the basis names the rung that fired — never "PR/PO" here).
- Tier 1 (header): vendor ✓ · total=PO ✓ · approved ✓ · stamp ✓ · **Dates in FY ✗**
  (invoice 28-Mar-2025 falls in prior FY) · date-order ✗ red (doesn't flip).
- Tier 3 (itemized, flags): invoice rate 32,500 = PO 32,500 → rate ✓; Line items
  "All matched (1/1)".
- **Match result: No match** — the **header** fail is the invoice date outside FY.
  (The fingerprint basis is independent of the result.)

---

## Example 3 — Lump-sum PO vs itemized invoice; no HSN; Match (Sri Lakshmi)

**Invoice** TI/4688: vendor Sri Lakshmi (seller GSTIN …2351R1ZZ), no. 55, **34
plumbing lines** across 4 pages, **no HSN column**, total ₹1,79,830.00 (after −0.98
round-off), PLHHOA stamp present. **PO** PO2301, **lump-sum** (one line "Plumbing
material-general"), total ₹1,79,830.98, Approved.

- Match: rung 2 **fingerprint** (seller GSTIN + total within round-off) → "GSTIN + total".
- Tier 1 (header): total 1,79,830.00 ≈ PO 1,79,830.98 ✓ (round-off tolerance);
  approved ✓; stamp ✓; FY ✓; date-order ✗ red (05-Apr before PO 14-Apr — doesn't flip).
- Tier 2 (still runs): every invoice line has **no HSN → HSN "—", GST "—"** (unverified).
- Tier 3 (PO lump-sum → matching skipped): Overview Line items check = **"N/A — PO
  lump-sum"** (no count); PO Type column reads "Lump-sum". Never fake a per-line match.
- **Match result: Match** — header reconciles. **Lines** (unchanged): first row = PO
  lump line (cited, Line match "Line items not matched — PO lump sum"); then the 34
  invoice lines, each cited with HSN/GST "—" (the no-HSN gap is surfaced, not a failure).

---

## Example 4 — Itemized rate-match; PO in prior FY → No match (Liya)

**Invoice** TI/4690: vendor Liya (seller GSTIN …3129G3Z1), LL-1, **02-Apr-2025**,
prints **"Buyer's Order No: PO2240"**, HSN **9405 @ 18%**, **3 Nos @ 48,000**, total
₹1,72,870, PLHHOA stamp present. **PO** PO2240, **itemized** (3 Nos @ 48,000),
requisition **18-Mar-2025**.

- Match: rung 1, printed buyer PO "PO2240" → basis **"PR/PO (high)"**.
- Tier 1 (header): vendor ✓ · total ✓ · approved ✓ · stamp ✓ · **Dates in FY ✗** (PO
  18-Mar-2025 is prior FY) · date-order ✓ (invoice 02-Apr on/after PO 18-Mar).
- Tier 2 (flags): HSN 9405 valid ✓; GST 18% correct ✓.
- Tier 3 (itemized, flags): rate 48,000 = PO 48,000 → rate ✓; Line items "All matched".
- **Match result: No match** — the **header** fail is the PO date in the prior FY.
  Everything else (including the clean line/rate match) is a flag.

---

## Example 5 — Multi-line PO, every qty 1.00 → ITEMIZED (Vaishnavi); Match

**Invoice** TI/4684: vendor Vaishnavi Industries (seller GSTIN …1975H2Z4), no.
"22/25-26", **02-Apr-2025**, total ₹1,94,493.50, PLHHOA stamp present, **3 line items**
(Malina / Leroy / Zephyr clubhouse pool maintenance). **PO** PO2299/PR2410, requisition
**14-Apr-2025**, **3 lines each "qty 1.00 @ its own Unit Price"** (21,125 / 76,700 /
67,000), Approved.

- **po_itemized = TRUE** via the **multiple-lines** rule. The case v2 got wrong: every
  PO qty is 1.00, but the PO has **>1 line** → itemized regardless of qty. (A *single*
  line would need **qty > 1** with a unit price; a single line at qty 1.00 is lump-sum
  even with a printed Unit Price.) So Tier-3 line/rate matching **runs**.
- Tier 1 (header): vendor ✓ · total ✓ · approved ✓ · stamp ✓ · dates-in-FY ✓ ·
  date-order ✗ red (02-Apr before PO 14-Apr — doesn't flip).
- Tier 3 (itemized, flags): each invoice line pairs to its PO line, rate ✓ per line →
  Line items **"All matched (3/3)"**; the Lines sheet shows all three bill lines
  **beside** their matched PO lines (PO Description / PO Rate / **PO Amount**), cited.
- **Match result: Match** — header reconciles; the clean line/rate match and the
  after-billing date-order ✗ are flags only. (Under v2 this wrongly read "lump-sum".)
