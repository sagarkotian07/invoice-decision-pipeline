---
name: register-extractor
description: Reads the Purchase Register worksheet in the open workbook (read_sheet for structure/encoding, read_range for values), judges which column is which canonical field, and emits one cited posting per register row. A fan-out sub-agent — it reads the live workbook in its OWN context and returns a compact JSON, so the register's bulk never lands in the orchestrator. Register values cite to cell addresses, not PDF pages.
---

# Register extractor (four-way match — fan-out sub-agent)

The Purchase Register is the buyer's **books** — a worksheet already in the open workbook
(a Tally / Zoho / SAP ledger export), **header-only** (one row per posting, no line items).
It is the **population**: every posting becomes one unit of work for the matcher.

You run **in your own context** and read the live workbook directly — sub-agents read the
workbook fine via `read_sheet`/`read_range`; only *writing* it is the orchestrator's job. The
point of isolating you is to keep the register's bulk (30–40+ rows) OUT of the orchestrator:
read it here, parse it here, and return a **compact JSON** the orchestrator loads back. There
is no PDF cascade — the runtime already structures the sheet via `read_sheet`; your job is to
**judge** which column means what, pull cited values, and write the JSON.

## Container isolation
First `container_python` call passes `create_new_context: true`; capture the `contextId` and
pass `context_id: "<uuid>"` on every later call.

## Inputs (from the task text)
- `register_sheet` — the exact worksheet name (the orchestrator asked the user in Phase 0).
- `output_path` — where to write the postings JSON.
- `forced_column_map` — **optional**. On a re-dispatch (after the orchestrator resolved an
  ambiguous money column with the user), the confirmed `{canonical → column letter}` to use
  **verbatim** instead of re-judging.

## The spine — `read_sheet` → `read_range` → judge

`read_sheet` and `read_range` are **tool calls** (not Python functions): you issue them
directly, then paste their raw responses into `container_python` to parse.

### Step 1 — `read_sheet` the register tab → see its structure
The register sheet name comes from the task text (`register_sheet`).
```
read_sheet(sheet_name="<the register tab, exact>")
```
The response gives the sheet's **structure + encoding**: column labels (letter → header
text), row labels, and per-column type hints. From this you **judge**, by reading the
headers:
- the **header row** (the row carrying the column titles — not always row 1; a register
  may have a title/blank rows above it),
- the **data extent** (first data row after the header; last data row — stop at the first
  fully-blank row; a trailing "Total"/"Grand Total" row is **not** a posting),
- the **last used column** (for the writeback append edge — record it),
- the **column map**: each canonical field → its column letter. Use `field-catalog.md`'s
  synonym list as **guidance for the judgment, not a lookup table** — read the actual
  headers and decide. Canonical fields:
  `vendor_name`, `vendor_gstin` (opt), `invoice_no` (the anchor key), `booking_date`,
  `po_no` (opt), `site_name` (opt — a "Site Name" / "Project" column; only consumed by the
  site-name custom check, cite it like any other cell), `taxable`,
  `cgst`/`sgst`/`igst` **or** `gst_total`, `total`.

**If a money column is genuinely ambiguous** (two columns both plausibly `taxable` or
`total`) → **do not guess silently.** You're a sub-agent — you cannot `ask_clarification`. So
map your best guess provisionally, set `"ambiguous": true` at the top level, and record a
diagnostic `{type:"ambiguous_money_column", field, candidates:[{header, col}, …]}`. The
orchestrator surfaces one `ask_clarification` with those candidate headers and **re-dispatches
you with `forced_column_map`** — which you then use verbatim (skip all column judgment). A
wrong `taxable`/`total` mapping silently corrupts every reconciliation verdict downstream.

Record the judgment as `column_map`, `header_row`, `data_start_row`, `last_data_row`,
`last_used_column`.

### Step 2 — `read_range` the data region → cited values
Read the values across the mapped columns, header row through last data row:
```
read_range(sheet="<register tab>", range="<A><header_row>:<lastcol><last_data_row>", type="values")
```
The response carries `<ColumnLabels>` (letter → header), `<RowLabels>`, and a `<Values>`
block of `«row» «col» «value»` lines — each line is one cell, so the cell address is
`«col»«row»` (e.g. `F7`). That address is the **citation** for that value.

Read in one call when the register is small; shard into a few `read_range` calls (by row
band) for a large register, and `log` how many rows you read so nothing is silently
dropped.

### Step 3 — `container_python`: parse the blob into cited postings
Paste the raw `read_range` response into `container_python` and build one posting per data
row. Commit to this parser (do not reach for a different tool mid-step):

```python
import re, json

# ---- inputs you set from Step 1/2 ----
RAW = """<paste the read_range values response here>"""
REGISTER_SHEET = "<the register tab>"
column_map = {          # the letters YOU judged in Step 1 (example)
    "vendor_name": "B", "vendor_gstin": "", "invoice_no": "C", "booking_date": "D",
    "po_no": "", "site_name": "", "taxable": "F", "cgst": "G", "sgst": "H", "igst": "", "gst_total": "",
    "total": "I",
}
header_row, data_start_row, last_data_row = 6, 7, 14
OUTPUT_PATH = "/home/sandbox/outputs/4w-register-0.json"

# ---- parse the <Values> block: each line is `row col value...` ----
cells = {}                                   # (row:int, col:str) -> source_text:str
in_values = False
for line in RAW.splitlines():
    s = line.strip()
    if s == "<Values>": in_values = True; continue
    if s.startswith("</Values>"): in_values = False; continue
    if not in_values or not s: continue
    m = re.match(r"^(\d+)\s+([A-Z]+)\s+(.*)$", s)
    if not m: continue
    cells[(int(m.group(1)), m.group(2))] = m.group(3).strip()

def at(row, col):                            # cited field {value, cite} or absent
    if not col: return {"value": "", "source": "absent"}
    txt = cells.get((row, col), "")
    if txt == "": return {"value": ""}
    return {"value": txt, "cite": {"sheet": REGISTER_SHEET, "cell": f"{col}{row}",
                                   "source_text": txt}}

def num(field):                              # parse a money/qty string -> float or None
    v = str(field.get("value", "")).replace(",", "").replace("₹", "").strip()
    try: return float(v)
    except ValueError: return None

postings = []
for row in range(data_start_row, last_data_row + 1):
    vendor   = at(row, column_map["vendor_name"])
    inv_no   = at(row, column_map["invoice_no"])
    total    = at(row, column_map["total"])
    # end-of-data / total-row sentinel: vendor AND invoice AND total all blank-or-label
    if vendor.get("value","") == "" and inv_no.get("value","") == "":
        continue
    label = str(vendor.get("value","")).strip().lower()
    if label in ("total", "grand total", "g.total") or inv_no.get("value","") == "" and num(total) is not None:
        postings.append({"register_row": row, "row_type": "register_total"}); continue

    taxable = at(row, column_map["taxable"])
    # GST: single column, else sum the split, citing constituents
    if column_map.get("gst_total"):
        gst = at(row, column_map["gst_total"])
    else:
        parts = [at(row, column_map[k]) for k in ("cgst","sgst","igst") if column_map.get(k)]
        nums  = [num(p) for p in parts if p.get("value","") != ""]
        if nums:
            joined = " + ".join(p["cite"]["source_text"] for p in parts if p.get("cite"))
            cell0  = next((p["cite"]["cell"] for p in parts if p.get("cite")), "")
            gst = {"value": f"{sum(n for n in nums if n is not None):.2f}",
                   "cite": {"sheet": REGISTER_SHEET, "cell": cell0, "source_text": joined}}
        else:
            gst = {"value": ""}
    # derive total if absent but taxable+gst present
    if total.get("value","") == "" and num(taxable) is not None and num(gst) is not None:
        total = {"value": f"{num(taxable)+num(gst):.2f}", "source": "derived",
                 "cite": {"sheet": REGISTER_SHEET, "cell": column_map['taxable']+str(row)+'+gst',
                          "source_text": "taxable + gst (derived)"}}

    postings.append({
        "register_row": row, "row_type": "posting",
        "vendor_name": vendor, "vendor_gstin": at(row, column_map["vendor_gstin"]),
        "invoice_no": inv_no, "booking_date": at(row, column_map["booking_date"]),
        "po_no": at(row, column_map["po_no"]),
        "site_name": at(row, column_map.get("site_name", "")),
        "taxable": taxable, "gst_total": gst, "total": total,
    })

out = {"agent": "register_extractor_4w", "sheet": REGISTER_SHEET,
       "header_row": header_row, "data_start_row": data_start_row,
       "last_data_row": last_data_row, "last_used_column": "<from Step 1>",
       "column_map": column_map,
       "postings": [p for p in postings if p["row_type"] == "posting"],
       "skipped_rows": [p["register_row"] for p in postings if p["row_type"] == "register_total"],
       "diagnostics": []}
json.dump(out, open(OUTPUT_PATH, "w"), indent=2)
print(f"{len(out['postings'])} postings, {len(out['skipped_rows'])} skipped (total/blank rows)")
```

Normalise `booking_date` to ISO and `invoice_no` for the match key in the matcher (Hop 1),
not here — keep the verbatim `source_text` for the cite. `vendor_gstin` absent → the
matcher falls back to name-based vendor matching (lower confidence, flagged).

## Output JSON (`4w-register-<k>.json`)
```json
{
  "agent": "register_extractor_4w",
  "sheet": "Purchase Register",
  "header_row": 6, "data_start_row": 7, "last_data_row": 14,
  "last_used_column": "I",
  "column_map": {"vendor_name":"B","invoice_no":"C","booking_date":"D","po_no":"","site_name":"",
                 "taxable":"F","cgst":"G","sgst":"H","gst_total":"","total":"I","vendor_gstin":""},
  "postings": [
    {"register_row": 7, "row_type": "posting",
     "vendor_name": {"value":"Pest Doctor","cite":{"sheet":"Purchase Register","cell":"B7","source_text":"Pest Doctor"}},
     "vendor_gstin": {"value":"","source":"absent"},
     "invoice_no": {"value":"372","cite":{"sheet":"Purchase Register","cell":"C7","source_text":"372"}},
     "booking_date": {"value":"03-04-2025","cite":{"sheet":"Purchase Register","cell":"D7","source_text":"03-04-2025"}},
     "po_no": {"value":"","source":"absent"},
     "site_name": {"value":"PALASH HOMES","cite":{"sheet":"Purchase Register","cell":"E7","source_text":"PALASH HOMES"}},
     "taxable": {"value":"68000.00","cite":{"sheet":"Purchase Register","cell":"F7","source_text":"68,000.00"}},
     "gst_total": {"value":"12240.00","cite":{"sheet":"Purchase Register","cell":"G7","source_text":"CGST 6,120 + SGST 6,120"}},
     "total": {"value":"80240.00","cite":{"sheet":"Purchase Register","cell":"I7","source_text":"80,240.00"}}}
  ],
  "skipped_rows": [15],
  "diagnostics": []
}
```

`register_row` (the absolute sheet row) is the **augment anchor** the writeback uses to
place each finding's bands back on the right register row (§writeback). The top-level JSON also
carries `sheet`, `header_row`, `last_used_column`, `column_map`, and `ambiguous` — the
orchestrator hands these to the writeback so Phase 4 needn't re-read the sheet.

## Output contract
1. Write the full postings JSON to `output_path` via `container_python` (with `sheet`,
   `header_row`, `data_start_row`, `last_data_row`, `last_used_column`, `column_map`,
   `postings[]`, `skipped_rows`, `ambiguous`, `diagnostics`).
2. Return a **compact summary** as your only final message — **never dump the rows to chat**:
```json
{"status":"ok","agent":"register_extractor_4w","output_file":"/home/sandbox/outputs/4w-register-0.json",
 "sheet":"Purchase Register","header_row":6,"last_used_column":"I","column_map":{"...":"..."},
 "postings":35,"skipped_rows":1,"ambiguous":false,"diagnostic_count":0,
 "headlines":["35 postings; split CGST+SGST summed; no GSTIN column → name-based vendor"]}
```

## Hard rules
- **Fan-out sub-agent in your own context.** First `container_python` call passes
  `create_new_context: true`; later calls pass `context_id`. Read the register here so the
  orchestrator never holds the rows.
- `read_sheet` / `read_range` are **tool calls** — issue them directly, paste raw responses
  into `container_python`. Do not call them from inside `container_python`. You may **read** the
  workbook; you must **not** write it (that's the orchestrator's Phase 4).
- **Judge the columns; never hardcode a fixed layout.** Read the headers (`read_sheet`) and map.
  Ambiguous money column → set `ambiguous: true` + a diagnostic + a provisional map (the
  orchestrator confirms and re-dispatches with `forced_column_map`); use `forced_column_map`
  verbatim when it's supplied.
- **Never rewrite the user's register cells.** You only read them; the cell *is* the source.
  Every register value carries a cell cite `{sheet, cell, source_text}`.
- No GSTIN column → name-based vendor match (flagged). Split CGST/SGST/IGST → sum, cite
  constituents. No PO column → the matcher uses the invoice's PR/PO ref. `total` absent →
  derive from taxable+gst, flag derived.
- A **"Site Name" / "Project"** column → map to `site_name` (cited like any cell); absent →
  `""`. It is **optional** — only the site-name custom check consumes it; never required.
- A trailing "Total"/"Grand Total"/blank row is `register_total` — skip it, never post it.
- Write the full JSON to `output_path`, then return the **summary object only**.
