---
name: writeback
description: How the orchestrator writes the four-way results — augments the user's Purchase Register sheet IN PLACE (cited INVOICE → PO → GRN → CHECKS bands appended to the right of the user's columns, register cells never rewritten) and builds a fresh quantity-flow Lines sheet (INVOICE LINE → PO LINE → GRN LINE → CHECKS). Builds the whole DSL with container_python, writes one ops JSON per sheet, applies with generate_code via operationsFilePath. Stores the band origin column in a hidden _meta sheet for idempotent re-runs. Orchestrator-only.
---

# Writeback — augment the register + a Lines sheet (four-way, single-shot)

The orchestrator (only) writes the workbook. Read all `4w-findings-*.json`, then produce:

- **The augmented Purchase Register** — the user's register sheet with cited bands
  **[INVOICE] → [PURCHASE ORDER] → [GRN] → [CHECKS]** appended to the **right** of their
  existing columns. The register's own columns are the leftmost **REGISTER band, untouched**
  — we reference them, never rewrite them. One augmented row per posting (placed on its
  `register_row`). This is the Overview equivalent (register-anchored).
- **`4W Match — Lines`** — a fresh, fully-owned sheet: every invoice line beside its matched
  PO line and GRN line, banded **[INVOICE LINE] → [PO LINE] → [GRN LINE] → [CHECKS]**. The
  register has no line items, so it is **absent** here. Built **first** (so the register's
  MATCH RESULT cell can hyperlink into it).

## Two write channels (by citation need)
- **`_meta` bookkeeping** (the band origin column; no citations) → `execute_excel_code`
  directly. This is OUR sheet, no `--cite-pdf` to preserve.
- **Cited evidence cells** (`--cite-pdf` for PDF values; `=HYPERLINK` for register cell
  links) → built as DSL in `container_python`, written to one ops JSON per sheet, applied
  with **`generate_code` via `operationsFilePath`**. Citations are preserved only through
  this path — same invariant as vouching v3. Never mutate a cited cell directly.

## Write discipline — ONE file per sheet, applied by `generate_code` (READ THIS)
This is the proven v3 mechanism and the **only** one that keeps `--cite-pdf` → `=HYPERLINK`:
**build the whole sheet's DSL in `container_python`, write it to one ops JSON, apply it with a
single `generate_code(operationsFilePath=…)`.** That path has **no op cap**.
- **Never** use `generate_operations` for cited cells, and **never** fall back to raw
  `execute_excel_code` with hard-coded literal values — both **strip the citations** and invite
  the slicing / duplicate-row bugs that corrupted the first real run (289 cited cells but only
  3 links; dropped Inv-Date / GSTIN columns; rows 14–15 duplicated).
- **Do not inspect, count, or reason about the op volume.** Do not "split because 42 KB is
  large". Build → write file → `generate_code`. Trust the file path.
- **Only if** a `generate_code` call **actually errors** on size do you split — into **multiple
  ops FILES**, each applied by its own `generate_code`. Still never `generate_operations`, never
  literals. `execute_excel_code` is reserved for the **uncited** `_meta` bookkeeping (Step 0/4).
- **Never cap or truncate a cell's display text.** Reason, descriptions, and chain_basis must
  render **in full** — `safe()` ESCAPES (`"`/newline/`|`) but must **not** shorten. The only thing
  you may shorten is a citation's `source_text` (inside `pcite`, for the `--cite-pdf` arg). A
  `safe(s)[:80]` on cell values silently cut the Reason mid-sentence on a real run — don't reintroduce it.
- **A cite's `page` must be a single positive integer.** `pcite` guards it via `valid_page`: if a
  non-integer reaches it (e.g. a **date** slipped into the page slot — `--cite-pdf "po.pdf|21/4/26|…"`),
  it **drops that one cell's `--cite-pdf`** (the value is still written by `w()`) instead of failing the
  whole sheet. One malformed cite must **NEVER** abort the entire `generate_code` — that fatal coupling
  (1 bad page among 351 ops nuked the whole register) is exactly what this guards against.

## Idempotency model (read this — it differs from v3)
Phase 1.5 **re-reads the live register every run**, so each posting's `register_row` is
always current — the augmented bands land on the right rows by construction, even if the
user re-sorted their register between runs. The **one** thing that must persist across runs
is **`append_col0`** — the column where our bands begin. After run 1 the register's own
`last_used_column` *includes* our bands, so recomputing `last_used_column + 2` on run 2
would drift the bands rightward and duplicate them. So we store `append_col0` in a hidden
**`4W Match — _meta`** sheet on run 1 and reuse it forever.

- **Run 1:** `append_col0 = last_used_column + 2` (one spacer column), where
  `last_used_column` comes from the **register-extractor sub-agent's JSON** (`4w-register-*.json`
  — the orchestrator does **not** re-read the sheet). Store `{register_sheet, header_row,
  append_col0}` in `_meta!A1` as JSON.
- **Re-run:** read `_meta!A1`; reuse the stored `append_col0`. **Sentinel check:** read the
  header cell at `append_col0` on `header_row`; it must read "Inv No". If it doesn't (the
  user inserted/deleted columns and shifted our bands), **abort augment → standalone
  fallback** (below) and warn. Writing the same posting's row again overwrites identical
  values → idempotent; no row is duplicated.

## Standalone fallback (when the register can't be safely augmented)
Use a fresh `4W Match — Register` sheet (NOT the user's sheet) when any of: the register has
**merged cells** in its data region; **no clean header row** was detected; or the re-run
**sentinel check fails**. The fallback sheet is v3-style (one row per posting, the same
INVOICE/PO/GRN/CHECKS bands PLUS a leading REGISTER band that **echoes** the register values
as `=HYPERLINK("#'<sheet>'!F7","68,000.00")` cell-links — using the register cell cites from
the findings). Tell the user in chat that the register sheet was left untouched and why.

## Three states + colours
- Glyph: `agrees → "✓"`, `fails → "✗"`, `unverified → "—"`. The **"—" means "we looked, nothing
  to assert"** — it appears only on a row where a document *was* linked. A row where **no document
  was linked at all** (a no-invoice posting) is **not written** (Step 3 skips it) → it stays truly
  **blank**. That's the distinction: **blank = no doc linked; "—" = doc linked, value unverifiable.**
- Verdict fill: agrees `#C6EFCE`, fails `#FFC7CE`, unverified `#D9D9D9` (grey — carries the "—").
- Band-label / header fills: INVOICE `#DDEBF7`, PO `#E2EFDA`, GRN `#FFF2CC` (amber),
  CHECKS `#FCE4D6`, REGISTER (fallback only) `#EDEDED`.

## Step 0 — Decide augment vs standalone (`execute_excel_code` + the extract JSON)
From the **register-extractor sub-agent's JSON** (`4w-register-*.json`) you already have
`register_sheet`, `header_row`, `last_used_column`, `column_map`, and whether merged cells / a
clean header were found (flagged in its `diagnostics`) — so **no `read_sheet` of the register
here**. Detect-or-create the `_meta` sheet and read `A1`:
```javascript
async function main() {
  const md = {logs: [], success: false, meta_existed: false, meta: null, lines: {existed:false, last_row:0}};
  try {
    await Excel.run(async (context) => {
      const ws = context.workbook.worksheets;
      // _meta (hidden bookkeeping — ours)
      let meta = ws.getItemOrNullObject("4W Match — _meta"); meta.load("name"); await context.sync();
      if (meta.isNullObject) { meta = ws.add("4W Match — _meta"); await context.sync(); meta.visibility = "Hidden"; await context.sync(); }
      else { md.meta_existed = true; const a1 = meta.getRange("A1"); a1.load("values"); await context.sync(); md.meta = a1.values[0][0] || null; }
      // Lines (fresh, owned) — detect-or-create; CLEAR if it exists so we REBUILD from row 1 every run
      for (const [name, tag] of [["4W Match — Lines","lines"]]) {
        const cur = ws.getItemOrNullObject(name); cur.load("name"); await context.sync();
        if (cur.isNullObject) { const s = ws.add(name + "__tmp"); await context.sync(); s.name = name; await context.sync(); }
        else { const u = cur.getUsedRangeOrNullObject(true); await context.sync(); if (!u.isNullObject) { u.clear(); await context.sync(); md.logs.push("Cleared existing Lines sheet"); } }
        md[tag] = {existed:false, last_row:0};   // always rebuild from row 1
      }
      md.success = true;
    });
  } catch (e) { md.error = e.toString(); md.logs.push("ERROR: "+md.error); }
  finally { return JSON.stringify(md); }
}
return main();
```
Bind these from the result (defaults = fresh run):
- `meta = json.loads(md.meta)` if `md.meta_existed` else `{}`. Reuse `append_col0` from it
  (then sentinel-check via one `read_range` of `<append_col0><header_row>` — must read
  "Inv No"); else first run → `append_col0_index = last_used_column_index + 2`.
- The Lines sheet was created/cleared above → it is **rebuilt from row 1 every run**; there is no
  `lines_done` / append state to carry.
- If the extract flagged merged cells / no clean header, or the sentinel check fails →
  `mode = "standalone"`.

## Step 1 — Helpers + band layout (`container_python`)
```python
import json
def colletter(n):                              # 1-based index -> A, Z, AA, AB ...
    s = ""
    while n > 0:
        n, r = divmod(n - 1, 26); s = chr(65 + r) + s
    return s
GREEN, RED, GREY = "#C6EFCE", "#FFC7CE", "#D9D9D9"
INVBG, POBG, GRNBG, CHKBG = "#DDEBF7", "#E2EFDA", "#FFF2CC", "#FCE4D6"
GLYPH = {"agrees":"✓","fails":"✗","unverified":"—","—":"—"}     # "—" = "we looked, nothing to assert" (the doc WAS linked but the value/check is unverifiable). A NO-doc row isn't written at all (see Step 3 skip).
VC    = {"agrees":GREEN,"fails":RED,"unverified":GREY,"—":GREY} # unverified renders grey with a "—"

def safe(s): return str(s).replace('"',"'").replace("\n"," ").replace("|","/").strip()   # ESCAPE only — NEVER truncate a cell's display text
def valid_page(p):                              # a cite page must be a single positive integer — a date in the page slot fails the WHOLE generate_code
    try: return int(str(p).strip()) > 0
    except (ValueError, TypeError): return False
def pcite(c):                                   # cap ONLY the cite arg; drop ONLY this cell's --cite-pdf if its page is unusable — NEVER fail the sheet
    if c and c.get("file") and valid_page(c.get("page")):
        return f' --cite-pdf "{c["file"]}|{int(str(c["page"]).strip())}|{safe(c["source_text"])[:160]}"'
    return ""                                   # w() still writes the value; only the citation link is omitted
def w(cell, val, c=None, g="", d="", num=False):
    v = str(val) if (num or str(val).startswith("=")) else f'"{safe(str(val))}"'   # escape every text value (a stray " would break the DSL); do NOT cap it
    return f'write {cell} {v}{pcite(c)} --group "{g}" --description "{d}"'
def fld(x):                                    # {value,cite}|scalar|None -> (value, pdf_cite_or_None)
    if x is None: return ("", None)
    if isinstance(x, dict):
        c = x.get("cite")
        return (x.get("value",""), c if (c and c.get("file")) else None)   # only PDF cites render on appended cells
    return (x, None)
def vstate(x): return x.get("state","—") if isinstance(x, dict) else x
def vcell(cell, x, g, d):                       # computed glyph + static fill (judged/lookup checks)
    st = vstate(x); return w(cell, GLYPH.get(st,"—"), None, g, d), f'format {cell} bg-{VC.get(st,GREY)} --group "{g}" --description "{d} fill"'
def isnum(v): return str(v).replace(',','').replace('.','',1).replace('-','',1).isdigit()
def note(cell, text, g="hdr", d="check note"):  # DSL: note CELL "text" --group --description (top-left for a range)
    return f'note {cell} "{safe(text)}" --group "{g}" --description "{d}"' if text else None
def fcell(cell, formula, verdict, g, d):        # LIVE formula (the formula IS the verdict) + static fill from the matcher verdict
    st = vstate(verdict)
    return (f'write {cell} {formula} --group "{g}" --description "{d}"',
            f'format {cell} bg-{VC.get(st,GREY)} --group "{g}" --description "{d} fill"')
def ftol(a, b, pct):                            # three-state amount-tolerance formula (₹1 or pct); a,b are cell refs
    return f'=IF(OR({a}="",{b}=""),"—",IF(ABS({a}-{b})<=MAX(1,{pct}*{b}),"✓","✗"))'   # "—" when an operand is missing (the row was found, the value wasn't)

# Appended-register band layout — offsets are DERIVED from the band lengths, so adding or
# reordering a column never needs hand-renumbering. Left-to-right from append_col0 (index c0):
#   INVOICE | PURCHASE ORDER | GRN | CHECKS
# `custom_checks` = the Phase-0 opt-in list (default []); "site_name" adds a Site column below.
INV_COLS = [("inv_no","Inv No"),("date","Inv Date"),("gstin","Vendor GSTIN"),("taxable","Taxable"),("gst","GST"),("total","Inv Total"),("ref","PO No (on inv)")]
PO_COLS  = [("po_number","PO No"),("pr_number","PR No"),("gstin","PO GSTIN"),("req_date","PO Req Date"),("total","PO Total"),("po_type","PO Type")]
GRN_COLS = [("grn_no","GRN No(s)"),("po_number","PO No"),("gstin","GRN GSTIN"),("receipt_date","Receipt Date(s)"),("received","Received Qty"),("vendor","GRN Vendor")]
PO_OFF  = len(INV_COLS)                          # band start offsets, derived
GRN_OFF = len(INV_COLS) + len(PO_COLS)
CHK_OFF = len(INV_COLS) + len(PO_COLS) + len(GRN_COLS)
def bandidx(cols, key): return next(i for i,(k,_) in enumerate(cols) if k==key)   # band-local index by key
INV_NUM = {bandidx(INV_COLS,k) for k in ("taxable","gst","total")}   # write numeric so the live formulas compute
PO_NUM  = {bandidx(PO_COLS,"total")}                                 # PO Total numeric
# CHECKS spec: (key, header, kind, header-note). The LIST POSITION is the band offset — no
# explicit numbers, so inserting/reordering a check needs no renumber. kind ∈ text|glyph|ftol|result|qty|ds
CHECKS_SPEC = [
 ("chain_basis","Chain basis","text","How register→invoice→PO→GRN was matched, with confidence."),
 ("vendor_match","Vendor","glyph","Vendor consistent across register, invoice, PO & GRN (GSTIN; name where GSTIN absent) — judged."),
 ("po_num_consistent","PO# consistent","glyph","Invoice's printed PO/PR ref and each GRN's PO# all resolve to a matched PO — judged; shows '—' when the invoice prints no PO ref."),
 ("total_match","Total=PO","ftol","Invoice total vs PO total (Σ of matched POs), within ±₹1 or 0.5% — live formula."),
 ("dates_fy","Dates FY","glyph","Invoice, PO & booking dates all within the FY window — computed."),
 ("reg_taxable_match","Reg Taxable=Inv","ftol","Your register taxable vs invoice taxable, within ±₹1 or 1% — live formula."),
 ("reg_gst_match","Reg GST=Inv","ftol","Your register GST vs invoice tax, within ±₹1 or 1% — live formula."),
 ("reg_total_match","Reg Total=Inv","ftol","Your register total vs invoice total, within ±₹1 or 1% — live formula."),
 ("qty_flow","Qty flow","qty","Ordered (PO) → received (ΣGRN) → billed (invoice) per item; over-receipt/over-billing are flags."),
 ("date_sanity","Date sanity","ds","Receipt≥PO, invoice≥receipt, booking≥invoice — sanity flags, never flip the verdict."),
 ("result","MATCH RESULT","result","Headline verdict — flips only on the reconciliation spine (amounts + identity), not on flags."),
 ("reason","Reason","text","No-match cause (if any) plus any per-line flags raised."),
 ("auditor","Auditor decision","text","Your sign-off — blank for you to fill."),
]
# Opt-in site-name custom check → one extra verdict-driving glyph column, inserted before MATCH RESULT.
custom_checks = custom_checks if "custom_checks" in globals() else []   # Phase-0 opt-in list; default none
if "site_name" in custom_checks:
    _ri = next(i for i,(k,*_) in enumerate(CHECKS_SPEC) if k == "result")
    CHECKS_SPEC.insert(_ri, ("site_consistent","Site consistent",
        "glyph","All matched docs (register, PO, GRN, invoice) name the same site/project — judged; verdict-driving for this engagement."))
```

## Step 2 — Build the Lines sheet DSL (built first; record each posting's first row)
Fresh sheet, v3-style: row 1 band labels, row 2 headers, data from row 3. The sheet is
**rebuilt from scratch every run** (Step 0 clears it if it existed), so there is no append and
no dedup — every posting is re-rendered. Columns:
```
A Inv No(link) | B Line# | C Description | D HSN/SAC | E Qty billed | F Rate | G GST% | H Amount      ◄ INVOICE LINE ► (cite invoice)
I PO No | J PO Line# | K PO Description | L Qty ordered | M PO Rate | N PO Amount                      ◄ PO LINE ► (cite PO)
O GRN No | P GRN Line# | Q GRN Description | R Qty received | S Receipt date                           ◄ GRN LINE ► (cite GRN)
T HSN valid | U GST correct | V Rate match | W Over-receipt | X Over-billing | Y Line match | Z Item match   ◄ CHECKS ►
```
**One row per GRN delivery.** A single invoice line fans out across **one row per matched GRN
receipt** — each delivery fills the GRN-LINE columns (`O GRN No … S Receipt date`) on its own
row. The INVOICE-LINE + PO-LINE + CHECKS cells are written on the line's **first** sub-row only;
continuation rows leave those columns blank. Multiple POs need no row explosion — each invoice
line names its own `I PO No`. Single-GRN and no-GRN lines are the degenerate 1-row / 0-delivery
cases of the same loop.
Check cells render as **live in-cell formulas** where the comparison is deterministic (HSN
length, rate, over-receipt, over-billing) and as a **computed glyph** where it's judged/looked
up (GST correct, line match, item match). The over-receipt / over-billing formulas **SUM the
line's GRN delivery rows** (`SUM(R_first:R_last)`). Every check header carries a **note**. Numeric
cells (qty/rate/received) are written as **numbers** so the formulas compute.
The sheet was cleared in Step 0, so we **rebuild every posting from row 1** (no append, no skip).
Commit to this builder:
```python
LHDR = ["Inv No","Line#","Description","HSN/SAC","Qty","Rate","GST%","Amount",
        "PO No","PO Line#","PO Description","Qty ordered","PO Rate","PO Amount",
        "GRN No","GRN Line#","GRN Description","Qty received","Receipt date",
        "HSN valid","GST correct","Rate match","Over-receipt","Over-billing","Line match","Item match"]  # A..Z
LBANDS = [("A1","◄ INVOICE LINE ►","A1:H1",INVBG),("I1","◄ PO LINE ►","I1:N1",POBG),
          ("O1","◄ GRN LINE ►","O1:S1",GRNBG),("T1","◄ CHECKS ►","T1:Z1",CHKBG)]
LNOTES = {"T":"HSN/SAC numeric and 4/6/8 digits — live formula.",
          "U":"Invoice GST% vs the correct rate for its HSN (FY25-26 table) — looked up, not a formula.",
          "V":"Invoice rate vs PO rate, within 0.01 — live formula.",
          "W":"Received (Σ of this line's GRN delivery rows) ≤ ordered (PO) — live formula; over = flag.",
          "X":"Billed (invoice) ≤ received (Σ delivery rows) — live formula; over = flag.",
          "Y":"Invoice line paired to a PO line by HSN/description — model-judged.",
          "Z":"Same item across PO, GRN & invoice — model-judged (codes often absent)."}
# The Lines sheet was created/cleared in Step 0 → REBUILD from row 1 every run (no append, no dedup).
lops, lf = [], []
for cell,label,rng,bg in LBANDS:
    lops.append(w(cell,label,None,"band","band")); lf.append(f'format {rng} bg-{bg} --group "band" --description "b"')
for col,h in zip("ABCDEFGHIJKLMNOPQRSTUVWXYZ", LHDR):
    lops.append(f'write {col}2 "{h}" --group "hdr" --description "header"')
lf.append('format A2:Z2 bold --group "hdr" --description "hdr bold"')
for col,txt in LNOTES.items():
    n = note(f"{col}2", txt, "hdr", "lines check note")
    if n: lops.append(n)
rr = 2                                          # rr = last row written so far (data starts at row 3)
start = {}
for b in postings:
    if not b.get("lines"):                      # no-invoice posting → no lines
        continue
    inv_no = b["overview"].get("invoice",{}).get("inv_no")       # link label = invoice no
    g = f'Reg {b["register_row"]}'; posting_first = True
    for row in b["lines"]:
        iv, po, ch = row.get("invoice"), row.get("po"), row["checks"]
        grns = row.get("grns") or []                              # GRN deliveries — one row each
        n = max(1, len(grns))                                     # ≥1 row even with no GRN
        frow, lrow = rr + 1, rr + n                               # this invoice line spans frow..lrow
        if posting_first: start[b["register_row"]] = frow; posting_first = False
        # ---- first sub-row: INVOICE + PO + inv-no link (continuation rows leave A..N blank) ----
        ivv, ivc = fld(inv_no); lops.append(w(f"A{frow}", ivv or "", ivc, g, "inv no"))
        if iv:                                  # numeric cells written as NUMBERS so the formulas compute
            lops.append(w(f"B{frow}", iv.get("line_no",""), None, g, "line#"))
            for col,k,num in [("C","description",0),("D","hsn",0),("E","qty",1),("F","rate",1),("G","gst",1),("H","amount",1)]:
                val,c = fld(iv.get(k))
                if val != "": lops.append(w(f"{col}{frow}", val, c, g, k, num=(num and isnum(val))))
            lf += [f'numberFormat F{frow} #,##0.00 --group "{g}" --description "rate"',
                   f'numberFormat G{frow} 0% --group "{g}" --description "gst"',
                   f'numberFormat H{frow} #,##0.00 --group "{g}" --description "amt"']
        if po:
            pnv, pnc = fld(po.get("po_number")); lops.append(w(f"I{frow}", pnv or "", pnc, g, "po no"))   # which PO this line is from (cited)
            lops.append(w(f"J{frow}", po.get("line_no",""), None, g, "po line#"))
            for col,k,num in [("K","description",0),("L","qty_ordered",1),("M","rate",1),("N","amount",1)]:
                val,c = fld(po.get(k))
                if val != "": lops.append(w(f"{col}{frow}", val, c, g, k, num=(num and isnum(val))))
            lf += [f'numberFormat M{frow} #,##0.00 --group "{g}" --description "po rate"',
                   f'numberFormat N{frow} #,##0.00 --group "{g}" --description "po amt"']
        # ---- one row per GRN delivery (GRN-LINE columns O..S) ----
        for k_i in range(n):
            d = grns[k_i] if k_i < len(grns) else None
            if not d: continue                                    # no-GRN line: leave O..S blank on the single row
            dr = frow + k_i
            gnv, gnc = fld(d.get("grn_number")); lops.append(w(f"O{dr}", gnv or "", gnc, g, "grn no"))   # which GRN (cited)
            lops.append(w(f"P{dr}", d.get("line_no",""), None, g, "grn line#"))
            for col,k,num in [("Q","description",0),("R","qty_received",1),("S","receipt_date",0)]:
                val,c = fld(d.get(k))
                if val != "": lops.append(w(f"{col}{dr}", val, c, g, k, num=(num and isnum(val))))
            lf.append(f'numberFormat R{dr} #,##0.00 --group "{g}" --description "received"')
        # ---- CHECKS on the first sub-row; qty formulas SUM the delivery rows R{frow}:R{lrow} ----
        hsn_f  = f'=IF(D{frow}="","—",IF(AND(ISNUMBER(VALUE(D{frow})),OR(LEN(D{frow})=4,LEN(D{frow})=6,LEN(D{frow})=8)),"✓","✗"))'
        rate_f = f'=IF(OR(F{frow}="",M{frow}=""),"—",IF(ABS(F{frow}-M{frow})<=0.01,"✓","✗"))'
        orec_f = f'=IF(OR(SUM(R{frow}:R{lrow})=0,L{frow}=""),"—",IF(SUM(R{frow}:R{lrow})<=L{frow},"✓","✗"))'
        obil_f = f'=IF(OR(E{frow}="",SUM(R{frow}:R{lrow})=0),"—",IF(E{frow}<=SUM(R{frow}:R{lrow}),"✓","✗"))'
        for cell,formula,key in [("T",hsn_f,"hsn_valid"),("V",rate_f,"rate_match"),("W",orec_f,"over_receipt"),("X",obil_f,"over_billing")]:
            wv,wf = fcell(f"{cell}{frow}", formula, ch.get(key,"—"), g, key); lops.append(wv); lf.append(wf)
        wv,wf = vcell(f"U{frow}", ch.get("gst_correct",{}), g, "gst_correct"); lops.append(wv); lf.append(wf)   # HSN-table lookup → judged
        lm = ch.get("line_match",{}); lmlabel = lm.get("label","") if isinstance(lm,dict) else lm
        lops.append(w(f"Y{frow}", lmlabel or GLYPH.get(vstate(lm),"—"), None, g, "line match"))
        lf.append(f'format Y{frow} bg-{VC.get(vstate(lm),GREY)} --group "{g}" --description "line match fill"')
        wv,wf = vcell(f"Z{frow}", ch.get("item_match","—"), g, "item_match"); lops.append(wv); lf.append(wf)     # item across PO/GRN/Inv → judged
        rr = lrow                                                 # advance past this line's delivery rows
lines_block = lops + lf + ['freezePane column-2 row-2']
last_l = rr
```
The builder renders whatever rows the matcher emitted (`pair` / `bill_only` / `po_only` /
`grn_only` / `lump_sum`) — no special-casing. PO/GRN columns are blank only when that part is
`null`. `start[register_row]` feeds the augmented register's MATCH RESULT hyperlink.

## Step 3 — Build the augmented-register DSL (or the standalone sheet)
`c0` = `append_col0_index`. The four bands sit left-to-right from `c0` with **offsets derived
from the band lengths** (Step 1): INVOICE at `c0 … c0+PO_OFF-1`, PURCHASE ORDER at `c0+PO_OFF …`,
GRN at `c0+GRN_OFF …`, CHECKS at `c0+CHK_OFF …` (one column per `CHECKS_SPEC` entry, in list
order — so the column count follows the lists, including the new `PO No (on inv)`, the GRN `PO No`
+ `GRN GSTIN`, and the opt-in `Site consistent`). Register check cells are **live formulas**
(Total=PO, Reg Taxable/GST/Total) or **computed glyphs** (Vendor, PO# consistent, Site
consistent, Dates FY) — each with a header **note** explaining its computation.
**A no-invoice posting is SKIPPED entirely** (no cells written on its register row — Match
result, Reason, and every band left blank): blank means "no document was linked here". Any cell
on a *found* row that we couldn't verify shows a **"—"** (we looked, nothing to assert) — that's
the distinction (`GLYPH`/`VC` in Step 1; the live formulas return `"—"` on a blank operand).
**Multi-PO/GRN (register band is one summary row — detail lives on Lines):** the PO band shows
the matcher's aggregate — `PO No` lists every matched PO# + count (`"PO2279, PO2281 (2)"`),
`PO Total` is their **Σ** (numeric, so the live `Total=PO` formula reconciles invoice total vs Σ
POs); the GRN band lists the GRN#s, their referenced `PO No`, the `GRN GSTIN`, the receipt dates,
and `Received Qty` = the **summed received quantity** (a number — **never the GRN count**). The
INVOICE band's `PO No (on inv)` shows the PO/PR ref printed on the invoice ("—" when the invoice
prints none — which is also when `PO# consistent` reads `—`). The per-line PO and per-delivery
GRN breakdown is on the Lines sheet, reached via the MATCH RESULT hyperlink. Two header rows:
- **Band labels** at `header_row - 1` (only when `header_row >= 2`): first column of each band,
  filled by band colour. Skip if there is no room above the header.
- **Column headers** at `header_row`, each filled by its band colour (so the banding reads
  even without the label row). The INVOICE block's first header is **"Inv No"** — this is the
  re-run sentinel.

For each posting, place values on its `register_row`:
```python
ops, fmt = [], []
c0 = append_col0_index
def L(off): return colletter(c0 + off)         # band column letter by offset

# ---- headers (idempotent) + a note on every CHECKS header (the transparency layer) ----
hdrs  = [(off,h,INVBG) for off,(_,h) in enumerate(INV_COLS)]
hdrs += [(PO_OFF+off,h,POBG) for off,(_,h) in enumerate(PO_COLS)]
hdrs += [(GRN_OFF+off,h,GRNBG) for off,(_,h) in enumerate(GRN_COLS)]
hdrs += [(CHK_OFF+off,h,CHKBG) for off,(_,h,_,_) in enumerate(CHECKS_SPEC)]
for off,h,bg in hdrs:
    ops.append(f'write {L(off)}{header_row} "{h}" --group "hdr" --description "header"')
    fmt.append(f'format {L(off)}{header_row} bg-{bg} --group "hdr" --description "band hdr"')
for off,(key,h,kind,nt) in enumerate(CHECKS_SPEC):   # explain how each check is computed, in its header note
    n = note(f"{L(CHK_OFF+off)}{header_row}", nt, "hdr", f"{key} note")
    if n: ops.append(n)

for b in postings:
    if not b.get("result"):                    # NO-INVOICE posting → no doc linked → leave its WHOLE appended row blank (skip)
        continue                               #   (matched rows are always "Match"/"No match"; only no-invoice is blank)
    r = b["register_row"]; ov = b["overview"]; ch = ov["checks"]; g = f'Reg row {r}'
    inv, po, grn, reg = ov.get("invoice",{}), ov.get("po",{}), ov.get("grn",{}), ov.get("register",{})
    # evidence on a FOUND row: numeric cells written as NUMBERS (so formulas compute), blank if absent;
    # non-numeric cells show the value or "—" (we looked, nothing there) — NOT blank (blank = no doc linked, the skip above)
    for off,(k,_) in enumerate(INV_COLS):
        val,c = fld(inv.get(k)); isn = off in INV_NUM and isnum(val)
        if off in INV_NUM:
            if isn: ops.append(w(f"{L(off)}{r}", val, c, g, k, num=True))   # else leave blank → formula sees ""
        else:
            ops.append(w(f"{L(off)}{r}", val or "—", c, g, k))   # "—" when absent on a found row
    for off,(k,_) in enumerate(PO_COLS):
        val,c = fld(po.get(k)); isn = off in PO_NUM and isnum(val)
        if off in PO_NUM:
            if isn: ops.append(w(f"{L(PO_OFF+off)}{r}", val, c, g, k, num=True))
        else:
            ops.append(w(f"{L(PO_OFF+off)}{r}", val or "—", c, g, k))   # "—" when absent (e.g. no PO matched)
    for off,(k,_) in enumerate(GRN_COLS):
        val,c = fld(grn.get(k)); ops.append(w(f"{L(GRN_OFF+off)}{r}", val or "—", c, g, k))   # "—" when absent (e.g. no GRN)
    # operand cells the live formulas reference — resolved by NAME so a column move can't break them
    InvTax = f"{L(bandidx(INV_COLS,'taxable'))}{r}"
    InvGST = f"{L(bandidx(INV_COLS,'gst'))}{r}"
    InvTot = f"{L(bandidx(INV_COLS,'total'))}{r}"
    POtot  = f"{L(PO_OFF+bandidx(PO_COLS,'total'))}{r}"
    def regref(field):                          # register operand: matcher's formula_ref (handles split GST), else cite cell, else ""
        rg = reg.get(field,{}) or {}
        return rg.get("formula_ref") or (rg.get("cite",{}) or {}).get("cell","") or '""'
    FRM = {"total_match":     ftol(InvTot, POtot, "0.005"),
           "reg_taxable_match": ftol(InvTax, regref("taxable"), "0.01"),
           "reg_gst_match":     ftol(InvGST, regref("gst"),     "0.01"),
           "reg_total_match":   ftol(InvTot, regref("total"),   "0.01")}
    for off,(key,h,kind,nt) in enumerate(CHECKS_SPEC):   # render each check: live formula | computed glyph | text
        cell = f"{L(CHK_OFF+off)}{r}"
        if kind == "text":
            if key == "chain_basis":
                ops.append(w(cell, f'{b["match"]["chain_basis"]} ({b["match"]["confidence"]})', None, g, key))
            elif key == "reason":
                rp = ([b["reason"]] if (b["result"]=="No match" and b.get("reason")) else []) + ([ch["flag_note"]] if ch.get("flag_note") else [])
                ops.append(w(cell, "; ".join(rp), None, g, key))
            # auditor → leave blank
        elif kind == "ftol":
            wv,wf = fcell(cell, FRM[key], ch.get(key,"—"), g, key); ops.append(wv); fmt.append(wf)
        elif kind == "glyph":
            wv,wf = vcell(cell, ch.get(key,"—"), g, key); ops.append(wv); fmt.append(wf)
        elif kind == "ds":
            ds = ch.get("date_sanity",{"state":"—","label":""})
            ops.append(w(cell, ds.get("label") or GLYPH.get(vstate(ds),"—"), None, g, key))
            fmt.append(f'format {cell} bg-{VC.get(vstate(ds),GREY)} --group "{g}" --description "{key} fill"')
        elif kind == "qty":
            ops.append(w(cell, ch.get("qty_flow_summary","—"), None, g, key))
        elif kind == "result":
            res = b["result"]; ops.append(w(cell, res, None, g, key))
            fmt.append(f'format {cell} bg-{GREEN if res=="Match" else RED} --group "{g}" --description "result fill"')
            if r in start:
                ops.append(f'write {cell} =HYPERLINK("#\'4W Match — Lines\'!A{start[r]}","{res}") --group "{g}" --description "result link"')
    fmt += [f'numberFormat {InvTax} #,##0.00 --group "{g}" --description "tax"',
            f'numberFormat {InvGST} #,##0.00 --group "{g}" --description "gst"',
            f'numberFormat {InvTot} #,##0.00 --group "{g}" --description "inv total"',
            f'numberFormat {POtot} #,##0.00 --group "{g}" --description "po total"']
reg_block = ops + fmt
last_r = max((b["register_row"] for b in postings), default=header_row)   # bottom of the augmented span
```
**Standalone mode:** identical bands, but on a fresh `4W Match — Register` sheet with row 1
title, row 2 bands, row 3 headers, postings from row 4, **plus** a leading REGISTER band
(cols A…) that echoes the register cells as `=HYPERLINK("#'<sheet>'!<cell>","<value>")` from
each finding's `overview.register.*.cite`. No `register_row` placement — sequential rows.

## Step 4 — Write one ops JSON per sheet, apply, persist `_meta`
```python
def write_ops(path, ops, sheet, brange, summary):
    json.dump({"operations":"\n".join(ops),"sheet":sheet,"boundingRange":brange,"summary":summary}, open(path,"w"))
    print(path, "→", len(ops), "ops,", brange)
write_ops("/home/sandbox/outputs/4w-lines-ops.json", lines_block, "4W Match — Lines", f"A1:Z{last_l}", f"{len(postings)} postings — every invoice/PO/GRN-delivery line, cited")
last_col = c0 + CHK_OFF + len(CHECKS_SPEC) - 1     # derived right edge (follows the band lengths + opt-in site col)
write_ops("/home/sandbox/outputs/4w-register-ops.json", reg_block, register_sheet, f"{colletter(c0)}{header_row}:{colletter(last_col)}{last_r}", f"{len(postings)} postings augmented in place")
```
Apply **Lines first**, then the register:
```
generate_code  operationsFilePath="/home/sandbox/outputs/4w-lines-ops.json"
generate_code  operationsFilePath="/home/sandbox/outputs/4w-register-ops.json"
```
**The Lines sheet must already exist** (created/cleared in **Step 0**) before this `generate_code` —
applying ops to a sheet that doesn't exist yet errors `"resource doesn't exist"`. Do Step 0 first.
Then persist bookkeeping in `_meta!A1` via `execute_excel_code` — write the JSON
`{"register_sheet":…, "header_row":…, "append_col0": colletter(c0)}`. `append_col0` stays fixed
across runs (the register band origin + the re-run sentinel). The Lines sheet is rebuilt from
scratch each run, so there is **no** `lines_rows_written` to persist.

## Step 5 — Verify (`read_range`)
- The user's register columns (A … last_used_column) are **unchanged**; our bands start at
  `append_col0` and read left-to-right INVOICE → PO → GRN → CHECKS, header cells band-coloured.
- Every appended INVOICE/PO/GRN value clicks to its PDF (no blank cell on a matched chain);
  MATCH RESULT is green/red and links into the Lines block.
- **Columns + order:** there is **no** `Buyer stamp` column in the INVOICE band and **no** `PO
  Approval` column in the PO band; the CHECKS band has **no** `Buyer stamp ok` and **no** `PO
  approved` cells (both removed — the underlying reads were too unreliable to show). The INVOICE
  band ends with `PO No (on inv)`; the GRN band carries `PO No` + `GRN GSTIN`; `Received Qty` shows
  the **summed quantity**, never a GRN count; the CHECKS tail reads …Reg Total=Inv → **Qty flow →
  Date sanity → MATCH RESULT** → Reason → Auditor. A fingerprint-matched posting with no invoice PO
  ref shows `PO No (on inv)` = **"—"** and `PO# consistent` = **"—"** (doc found, ref absent). With
  the site check **on**, a `Site consistent` glyph sits just before MATCH RESULT and a site mismatch
  turns MATCH RESULT red (verdict-driving); **off** → no such column and no effect.
- A **no-invoice** posting is **entirely blank** in our appended columns — no Match result, no
  Reason, no bands (it was skipped; blank = "no doc linked"). An over-billed posting shows the flag
  in **Reason** but MATCH RESULT stays driven by the header (a quantity flag never turns it red); a
  register-total mismatch beyond tolerance **does** turn it red.
- Lines: a `pair` row has PO **and** GRN columns filled+cited; a **multi-GRN item shows one row
  per delivery** (GRN# + that delivery's qty each), the invoice/PO cells only on the first row,
  and the over-billing formula reads `SUM(R_first:R_last)`; a multi-PO invoice shows each line's
  own `PO No`; a service-GRN line shows received **blank** (not 0); lump-sum PO shows "N/A — PO
  lump-sum" without faking a qty.
- **Re-run:** the sentinel at `append_col0`+`header_row` still reads "Inv No"; bands were
  overwritten in place (no second band block, no duplicated rows); `_meta!A1` unchanged.
- `#REF!`/`#NAME?` in a HYPERLINK → single-quote the em-dash sheet name in the target.
