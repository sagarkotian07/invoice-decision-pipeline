---
name: writeback
description: How the orchestrator writes the two vouching-v3 sheets, data-first — an Overview (all BILL columns → all PO columns → CHECKS) and a Lines sheet (all bill-line columns → matched PO-line columns → CHECKS), three-state cells. Builds the whole DSL with container_python, writes it to ONE ops JSON per sheet, and applies it with generate_code via operationsFilePath (no chunking). Orchestrator-only.
---

# Writeback — the two sheets (v3, data-first, single-shot)

The orchestrator (only) writes the workbook. Read all `pv3-findings-*.json`, then
build two sheets, each laid out **data first, checks last**:

- **`PI Vouching v3 — Overview`** — one row per invoice (No-match first):
  **[all BILL columns] → [all PO columns] → [CHECKS]**.
- **`PI Vouching v3 — Lines`** — every bill line AND every PO line:
  **[bill-line columns] → [matched PO-line columns] → [CHECKS]**. Built **first**.

**Append mode (batched runs).** These two sheets **accumulate** — run the skill on the
same workbook N times (e.g. 50 pairs each) and every run **appends below** the existing
rows; it never recreates them. A run **skips** any invoice already on the Overview (same
**Vendor GSTIN + Bill No**), so re-running a batch is a no-op. Sorting is **per-run**
(each run's rows are No-match-first), so the sheet ends up as one block per run — not a
single global sort. To redo a batch, clear the two sheets first.

## How cells get applied (v3 mechanism — no chunking)

You build the **entire** operation set for a sheet as newline-delimited DSL in
`container_python`, write it to a **single JSON file** under `/home/sandbox/outputs/`,
then apply it with **`generate_code` pointed at that file** via `operationsFilePath`.
There is **no op limit and no chunking** — one JSON, one `generate_code`, per sheet.

The ops JSON for each sheet has exactly these keys:
```json
{"operations": "<newline-delimited DSL lines>",
 "sheet": "PI Vouching v3 — Overview",
 "boundingRange": "A1:Z40",
 "summary": "one-line human summary"}
```
The DSL inside `operations` is the same vocabulary as before —
`write CELL value --cite-pdf "file|page|source_text"`, `format CELL bg-#RRGGBB`,
`numberFormat`, `=HYPERLINK(...)`, `freezePane`. **Citations are preserved through
this path** — that is the whole point of routing through the file: every raw value
(bill AND PO) is written cited, in one go. Bill values cite the invoice PDF; PO
values cite the PO PDF — both compared values keep their own cited cell.

## Three states + colours
- Glyph: `agrees → "✓"`, `fails → "✗"`, `unverified → "—"`. **No "soft" glyph** —
  date-order is a hard ✓/✗ like any other.
- Fill `format CELL bg-#RRGGBB`: agrees `#C6EFCE`, fails `#FFC7CE`, unverified
  `#D9D9D9`. Band-label fills: BILL `#DDEBF7`, PO `#E2EFDA`, CHECKS `#FCE4D6`.

## Sheet 1 — `PI Vouching v3 — Overview`
Row 1 title; row 2 band labels; row 3 headers; invoices from row 4.

| Col | Header | Block | Notes |
|---|---|---|---|
| A | # | | sequence |
| B | Bill No | BILL | cite invoice; also =HYPERLINK to its Lines block |
| C | Vendor | BILL | cite invoice |
| D | Vendor GSTIN | BILL | the **seller** GSTIN (cite invoice) |
| E | Inv Date | BILL | cite invoice |
| F | Inv Total | BILL | cite invoice |
| G | Buyer stamp | BILL | value e.g. "Present (PLHHOA)" (cite invoice) |
| H | Ref on inv | BILL | value (cite invoice) |
| I | PO No | PO | cite PO |
| J | PR No | PO | cite PO |
| K | PO Vendor GSTIN | PO | cite PO |
| L | PO Req Date | PO | cite PO |
| M | PO Approval | PO | value (cite PO) |
| N | PO Total | PO | cite PO |
| O | PO Type | PO | "Itemized" / "Lump-sum" (derived from `po_itemized`; no cite) |
| P | Match basis | CHECKS | the rung that fired + confidence |
| Q | Total=PO | CHECKS | verdict ✓/✗/— |
| R | Vendor GSTIN match | CHECKS | verdict |
| S | PO approved | CHECKS | verdict |
| T | Buyer stamp ok | CHECKS | verdict |
| U | Dates in FY | CHECKS | verdict |
| V | **Match result** | CHECKS | **"Match"** (green) / **"No match"** (red) |
| W | Date order | CHECKS | hard ✓/✗ (red on ✗); **does not change V** |
| X | Line items check | CHECKS | "All matched (m/m)" / "n of m matched" / **"N/A — PO lump-sum"** |
| Y | Reason | CHECKS | the No-match cause (when "No match") **and** any per-line flag note (e.g. invalid HSN) — shown even on a "Match" |
| Z | Auditor decision | CHECKS | blank |

Band labels (row 2): `B2`="◄ BILL (invoice) ►" (fill B2:H2 `#DDEBF7`),
`I2`="◄ PURCHASE ORDER ►" (fill I2:O2 `#E2EFDA`), `P2`="◄ CHECKS ►" (fill P2:Z2
`#FCE4D6`). Title `A1`. `freezePane column-2 row-3`. **No Footing / GST-split column.**

## Sheet 2 — `PI Vouching v3 — Lines`
Row 1 band labels; row 2 headers; data from row 3.
- **Itemized PO:** one row per bill line; the matched PO line sits on the same row;
  PO lines that paired to nothing are appended as their own rows.
- **Lump-sum PO:** the voucher emits a `lump_sum` row first (the PO lump-sum line,
  cited in the PO columns, Line match **"Line items not matched — PO lump sum"**), then
  a `bill_only` row **per invoice line** carrying that line's bill data + its
  **HSN valid / GST correct** flags (Rate/Line match "—"). The invoice lines ARE
  shown — that's where HSN/GST get flagged; only the *matching* is skipped. The
  builder just renders whatever rows it's given, so no special-casing here.

| Col | Header | Block |
|---|---|---|
| A | Bill No (cite invoice, repeated) | BILL LINE |
| B | Line# | BILL LINE |
| C | Description (cite invoice) | BILL LINE |
| D | HSN/SAC (cite invoice) | BILL LINE |
| E | Qty (cite invoice) | BILL LINE |
| F | Rate (cite invoice) | BILL LINE |
| G | GST% (cite invoice) | BILL LINE |
| H | Amount (cite invoice) | BILL LINE |
| I | PO Line# | PO LINE |
| J | PO Description (cite PO) | PO LINE |
| K | PO Rate (cite PO) | PO LINE |
| L | PO Amount (cite PO) | PO LINE |
| M | PO GST% (cite PO, if any) | PO LINE |
| N | HSN valid (verdict) | CHECKS |
| O | GST correct (verdict) | CHECKS |
| P | Rate match (verdict) | CHECKS |
| Q | Line match (label + colour) | CHECKS |

Band labels (row 1): `A1`="◄ BILL LINE ►" (fill A1:H1 `#DDEBF7`), `I1`="◄ PO LINE ►"
(fill I1:M1 `#E2EFDA`), `N1`="◄ CHECKS ►" (fill N1:Q1 `#FCE4D6`).
`freezePane column-2 row-2`. The matched PO line's **PO Description / PO Rate / PO
Amount** must be filled and cited whenever a line paired (the `pair` rows from the
findings) — these columns are not allowed to be blank for a matched line.

## Step 1 — Detect-or-create the sheets + read their extent (`execute_excel_code`)
Create a sheet **only if it is missing**; if it already exists (a prior batch),
**keep it** and report its last used row so Step 2 appends below. Returns
`{overview:{existed,last_row}, lines:{existed,last_row}}`.
```javascript
async function main() {
  const md = { logs: [], success: false, error: null,
               overview: { existed: false, last_row: 0 },
               lines:    { existed: false, last_row: 0 } };
  try {
    await Excel.run(async (context) => {
      const ws = context.workbook.worksheets;
      for (const [name, tag] of [["PI Vouching v3 — Lines","lines"], ["PI Vouching v3 — Overview","overview"]]) {
        const cur = ws.getItemOrNullObject(name); cur.load("name"); await context.sync();
        if (cur.isNullObject) {                                   // first run — add-before-delete-safe create
          const sheet = ws.add(name + "__tmp"); await context.sync();
          sheet.name = name; await context.sync();
          md[tag] = { existed: false, last_row: 0 };
        } else {                                                  // exists — keep it, read its extent (values only)
          const used = cur.getUsedRangeOrNullObject(true); used.load("rowIndex,rowCount"); await context.sync();
          md[tag] = { existed: true, last_row: used.isNullObject ? 0 : used.rowIndex + used.rowCount };
        }
      }
      ws.getItem("PI Vouching v3 — Overview").activate(); await context.sync();
      md.success = true;
    });
  } catch (e) { md.error = e.toString(); md.logs.push("ERROR: " + md.error); }
  finally { return JSON.stringify(md); }
}
return main();
```

## Step 1b — Dedup read (`read_range`, append runs only)
If Step 1 reports the **Overview existed**, read its already-written keys so a re-run
doesn't double rows: `read_range` `'PI Vouching v3 — Overview'!B4:I<overview.last_row>`
(values). From each row take **Bill No** (col B — the HYPERLINK cell's *value* is the
bill number) and **Vendor GSTIN** (col D) → build
`existing_keys = [[vendor_gstin, bill_no], …]`. Skip this read when the sheet is new
(`existing_keys = []`).

## Step 2 — Build the ops and write one JSON per sheet (`container_python`)
Set before this block: `findings_paths`, `buyer`, `fy_start`, `fy_end`, **and the
append inputs** — `base_overview_row`, `base_lines_row` (Step 1 `last_row`s),
`existed_overview`, `existed_lines`, and `existing_keys` (Step 1b; `[]` on a fresh run).
The block writes two JSON files and prints their paths plus the new/skipped counts.
```python
import json
LINES, OVER = "PI Vouching v3 — Lines", "PI Vouching v3 — Overview"
GREEN, RED, GREY = "#C6EFCE", "#FFC7CE", "#D9D9D9"
BILLBG, POBG, CHKBG = "#DDEBF7", "#E2EFDA", "#FCE4D6"
GLYPH = {"agrees": "✓", "fails": "✗", "unverified": "—", "—": "—"}
VC    = {"agrees": GREEN, "fails": RED, "unverified": GREY, "—": GREY}

def safe(s):  return str(s).replace('"', "'").replace("\n", " ").replace("|", "/").strip()
def cite(c):  return f' --cite-pdf "{c["file"]}|{c["page"]}|{safe(c["source_text"])}"' if c else ""
def w(cell, val, c=None, g="", d="", num=False):
    v = str(val) if (num or str(val).startswith("=")) else f'"{val}"'
    return f'write {cell} {v}{cite(c)} --group "{g}" --description "{d}"'
def fld(x):                                   # {value,cite} | scalar | None -> (value, cite)
    if x is None: return ("", None)
    if isinstance(x, dict): return (x.get("value", ""), x.get("cite"))
    return (x, None)
def vstate(x):                                # verdict object or string -> state string
    return x.get("state", "—") if isinstance(x, dict) else x
def vcell(cell, x, g, d):                      # write glyph + fill; returns (write, fmt). No soft.
    st = vstate(x)
    return w(cell, GLYPH.get(st, "—"), None, g, d), f'format {cell} bg-{VC.get(st, GREY)} --group "{g}" --description "{d} fill"'

def isnum(v):  return str(v).replace('.', '', 1).isdigit()

# Append-mode inputs (orchestrator sets these from Step 1 + Step 1b; defaults = fresh run)
try: existing_keys
except NameError:
    base_overview_row = base_lines_row = 0; existed_overview = existed_lines = False; existing_keys = []
seen = {(str(k[0]).strip(), str(k[1]).strip()) for k in existing_keys}
fresh_overview = (not existed_overview) or base_overview_row < 3   # sheet exists with header rows?
fresh_lines    = (not existed_lines)    or base_lines_row    < 2

invs = []
for p in findings_paths:
    invs += json.load(open(p))["invoices"]
def keyof(b):                                   # idempotency key = (Vendor GSTIN, Bill No)
    return (str(b["overview"]["bill"]["gstin"]["value"]).strip(),
            str(b["overview"]["bill"]["bill_no"]["value"]).strip())
skipped = sum(keyof(b) in seen for b in invs)
invs    = [b for b in invs if keyof(b) not in seen]               # skip invoices already on the sheet
# No match first, then by vendor (sort is per-run — see "Append mode" note)
invs.sort(key=lambda b: (b["result"] == "Match", b["overview"]["bill"]["vendor"]["value"]))
print(f"append: {len(invs)} new row(s), {skipped} skipped (already present)")

# ============ LINES (built first; record each invoice's first row for the link) ============
LBANDS = [("A1","◄ BILL LINE ►","A1:H1",BILLBG),("I1","◄ PO LINE ►","I1:M1",POBG),("N1","◄ CHECKS ►","N1:Q1",CHKBG)]
LHDR = ["Bill No","Line#","Description","HSN/SAC","Qty","Rate","GST%","Amount",
        "PO Line#","PO Description","PO Rate","PO Amount","PO GST%",
        "HSN valid","GST correct","Rate match","Line match"]            # A..Q
lops, lf = [], []
if fresh_lines:                                 # first run only — bands (row 1) + header (row 2)
    for cell, label, rng, bg in LBANDS:
        lops.append(w(cell, label, None, "band", "band")); lf.append(f'format {rng} bg-{bg} --group "band" --description "b"')
    for col, h in zip("ABCDEFGHIJKLMNOPQ", LHDR):
        lops.append(f'write {col}2 "{h}" --group "hdr" --description "header"')
    lf.append('format A2:Q2 bold --group "hdr" --description "header bold"')
r = 2 if fresh_lines else base_lines_row        # append below the last used row
start = {}
for b in invs:
    bn = b["overview"]["bill"]["bill_no"]; g = f'Inv {bn["value"]}'
    first = True
    for row in b["lines"]:
        r += 1
        if first: start[b["file"]] = r; first = False
        lops.append(w(f"A{r}", bn["value"], bn.get("cite"), g, "bill no"))
        bl, po, ch = row.get("bill"), row.get("po"), row["checks"]
        if bl:
            lops.append(w(f"B{r}", bl.get("line_no",""), None, g, "line#"))
            for col, k, num in [("C","description",0),("D","hsn",0),("E","qty",1),
                                ("F","rate",1),("G","gst",1),("H","amount",1)]:
                val, c = fld(bl.get(k))
                if val != "": lops.append(w(f"{col}{r}", val, c, g, k, num=num and isnum(val)))
            lf += [f'numberFormat G{r} 0% --group "{g}" --description "gst pct"',
                   f'numberFormat F{r} #,##0.00 --group "{g}" --description "rate"',
                   f'numberFormat H{r} #,##0.00 --group "{g}" --description "amount"']
        if po:                                    # matched PO line (pair) OR appended po_only line — always cited
            lops.append(w(f"I{r}", po.get("line_no",""), None, g, "po line#"))
            for col, k, num in [("J","description",0),("K","rate",1),("L","amount",1),("M","gst",1)]:
                val, c = fld(po.get(k))
                if val != "": lops.append(w(f"{col}{r}", val, c, g, k, num=num and isnum(val)))
            lf += [f'numberFormat K{r} #,##0.00 --group "{g}" --description "po rate"',
                   f'numberFormat L{r} #,##0.00 --group "{g}" --description "po amount"']
        wv, wf = vcell(f"N{r}", ch.get("hsn_valid","—"), g, "hsn valid"); lops.append(wv); lf.append(wf)
        wv, wf = vcell(f"O{r}", ch.get("gst_correct", {}), g, "gst correct"); lops.append(wv); lf.append(wf)
        wv, wf = vcell(f"P{r}", ch.get("rate_match","—"), g, "rate match"); lops.append(wv); lf.append(wf)
        lm = ch.get("line_match", {}); lmlabel = lm.get("label","") if isinstance(lm, dict) else lm
        lops.append(w(f"Q{r}", lmlabel or GLYPH.get(vstate(lm),"—"), None, g, "line match"))
        lf.append(f'format Q{r} bg-{VC.get(vstate(lm), GREY)} --group "{g}" --description "line match fill"')
lines_block = lops + lf + (['freezePane column-2 row-2'] if fresh_lines else [])
last_l = r

# ============ OVERVIEW (uses start[...] for the Lines hyperlink) ============
OBANDS = [("B2","◄ BILL (invoice) ►","B2:H2",BILLBG),("I2","◄ PURCHASE ORDER ►","I2:O2",POBG),("P2","◄ CHECKS ►","P2:Z2",CHKBG)]
OHDR = ["#","Bill No","Vendor","Vendor GSTIN","Inv Date","Inv Total","Buyer stamp","Ref on inv",
        "PO No","PR No","PO Vendor GSTIN","PO Req Date","PO Approval","PO Total","PO Type",
        "Match basis","Total=PO","Vendor GSTIN match","PO approved","Buyer stamp ok","Dates in FY",
        "Match result","Date order","Line items check","Reason","Auditor decision"]   # A..Z
oops, of = [], []
if fresh_overview:                              # first run only — title (row 1), bands (row 2), header (row 3)
    oops.append(w("A1", f"PURCHASE-INVOICE VOUCHING — {buyer} | FY {fy_start}–{fy_end}", None, "title", "title"))
    of += ['format A1 bold --group "title" --description "t"', 'format A1 size-14 --group "title" --description "t"']
    for cell, label, rng, bg in OBANDS:
        oops.append(w(cell, label, None, "band", "band")); of += [f'format {rng} bg-{bg} --group "band" --description "b"', f'format {rng} bold --group "band" --description "b"']
    for col, h in zip("ABCDEFGHIJKLMNOPQRSTUVWXYZ", OHDR):
        oops.append(f'write {col}3 "{h}" --group "hdr" --description "header"')
    of.append('format A3:Z3 bold --group "hdr" --description "header bold"')
rr = 3 if fresh_overview else base_overview_row              # append below the last used row
seq0 = 0 if fresh_overview else base_overview_row - 3         # continue the # sequence across runs
for i, b in enumerate(invs, start=seq0 + 1):
    rr += 1; bl = b["overview"]["bill"]; po = b["overview"]["po"]; ch = b["overview"]["checks"]; g = f'Inv {bl["vendor"]["value"]}'
    def W(col, obj, key, num=False):
        val, c = fld(obj.get(key)); return w(f"{col}{rr}", val if val != "" else "—", c, g, key, num=num and isnum(val))
    oops.append(w(f"A{rr}", i, None, g, "seq", num=True))
    # BILL block (B is written below — cited value then HYPERLINK overwrite)
    for col, key, num in [("C","vendor",0),("D","gstin",0),("E","date",0),("F","total",1),("G","stamp",0),("H","ref",0)]:
        oops.append(W(col, bl, key, num=num))
    # PO block (O = PO Type, a derived label — no cite)
    for col, key, num in [("I","po_number",0),("J","pr_number",0),("K","gstin",0),("L","req_date",0),("M","approval",0),("N","total",1),("O","po_type",0)]:
        oops.append(W(col, po, key, num=num))
    # CHECKS block
    oops.append(w(f"P{rr}", f'{b["match"]["basis"]} ({b["match"]["confidence"]})', None, g, "match basis"))
    for col, key in [("Q","total_match"),("R","vendor_match"),("S","po_approved"),
                     ("T","stamp"),("U","dates_fy"),("W","date_order")]:
        wv, wf = vcell(f"{col}{rr}", ch.get(key,"—"), g, key); oops.append(wv); of.append(wf)
    res = b["result"]                                   # "Match" | "No match"
    oops.append(w(f"V{rr}", res, None, g, "match result"))
    of.append(f'format V{rr} bg-{GREEN if res == "Match" else RED} --group "{g}" --description "match result fill"')
    oops.append(w(f"X{rr}", ch.get("line_items_summary","—"), None, g, "line items check"))
    # Reason (Y) = No-match header reason (when No match) + any per-line flag note (always)
    rparts = []
    if res == "No match" and b.get("reason",""): rparts.append(b["reason"])
    if ch.get("flag_note",""): rparts.append(ch["flag_note"])
    oops.append(w(f"Y{rr}", "; ".join(rparts), None, g, "reason"))
    # Bill No cell = cited value, then HYPERLINK overwrite to its Lines block
    oops.append(w(f"B{rr}", bl["bill_no"]["value"], bl["bill_no"].get("cite"), g, "bill no"))
    if b["file"] in start:
        oops.append(f'write B{rr} =HYPERLINK("#\'{LINES}\'!A{start[b["file"]]}","{bl["bill_no"]["value"]}") --group "{g}" --description "bill no link"')
    of += [f'numberFormat F{rr} #,##0.00 --group "{g}" --description "amt"',
           f'numberFormat N{rr} #,##0.00 --group "{g}" --description "amt"']
over_block = oops + of + (['freezePane column-2 row-3'] if fresh_overview else [])
last_o = rr

# ============ write one ops JSON per sheet (no chunking) ============
def write_ops(path, ops, sheet, brange, summary):
    json.dump({"operations": "\n".join(ops), "sheet": sheet, "boundingRange": brange, "summary": summary}, open(path, "w"))
    print(path, "→", len(ops), "ops,", brange)

write_ops("/home/sandbox/outputs/pv3-lines-ops.json",    lines_block, LINES, f"A1:Q{last_l}", f"{len(invs)} invoices — every bill + PO line, cited")
write_ops("/home/sandbox/outputs/pv3-overview-ops.json", over_block,  OVER,  f"A1:Z{last_o}", f"{len(invs)} invoices — data-first overview")
```

## Step 3 — Apply each sheet with `generate_code` (operationsFilePath)
Apply **Lines first** (so the hyperlink targets exist), then the Overview — one call
each, pointing at the JSON written in Step 2. No chunking, no `generate_operations`.
```
generate_code  operationsFilePath="/home/sandbox/outputs/pv3-lines-ops.json"
generate_code  operationsFilePath="/home/sandbox/outputs/pv3-overview-ops.json"
```
Each call reads `operations` (with `--cite-pdf` intact), `sheet`, and `boundingRange`
from its file and applies the whole set at once.

## Step 4 — Verify
One `read_range` over `'PI Vouching v3 — Overview'!B4:Z<last>` and a Lines spot range
(include a `pair` row to confirm PO Description / PO Rate / **PO Amount (col L)** are
populated). Checks:
- Bands read left-to-right: BILL → PO → CHECKS on both sheets.
- Sorted **No-match first**; `V` reads "Match"/"No match" (no "Flagged"); date-order
  `W` shows a red ✗ on after-billing rows **without** turning `V` to "No match"; and a
  line/rate/HSN/GST flag never turns `V` to "No match" either (header-driven verdict).
  The PO-block **`O` (PO Type)** reads "Itemized"/"Lump-sum"; **`X` (Line items check)**
  reads **"N/A — PO lump-sum"** for a lump-sum PO (never "k of m matched"); the **Reason
  `Y`** shows any per-line flag note (e.g. invalid HSN) **even on a "Match"** row.
- Every raw bill cell and every raw PO cell carries a citation (no blank PO cells on a
  matched line); a **lump-sum** invoice shows the PO lump-line row (Line match "Line
  items not matched — PO lump sum") **plus a cited row per invoice line with its HSN
  valid / GST correct flags** — Tier-2 is never skipped.
- `#REF!`/`#NAME?` in a HYPERLINK → single-quote the em-dash sheet name in the target.
- **Append runs:** new rows landed **below** the prior batch (earlier rows untouched, no
  duplicated header/bands), the Step-2 print shows the expected new/skipped counts (a
  re-run of an already-written batch prints `0 new`), and the `#` sequence continues. Read
  a window spanning the seam (last prior row + first new rows).
