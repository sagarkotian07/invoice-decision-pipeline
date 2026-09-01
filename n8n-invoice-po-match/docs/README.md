# Invoice ↔ PO two-way match — n8n workflow + upload UI

Upload an **invoice** and a **PO**, parse them, run a **two-way (invoice↔PO) match**
using GST rules derived from the four-way reference skill, and get a **CSV** for
Excel. The matching + CSV logic runs inside n8n Code nodes; a custom `index.html`
is the upload front-end.

```
web/index.html ─POST─▶ n8n Webhook ─▶ Route (mode?)
  (upload/sample)          ├─ upload ─▶ Extract invoice text + Extract PO text ─▶ Merge ─▶ Parse text ─┐
                           └─ sample ─▶ Prepare payload ──────────────────────────────────────────────┴▶ Normalize ─▶ Match ─▶ Build CSV ─▶ Respond (JSON+CSV)
```

**FREE by default.** PDF parsing uses n8n's built-in *Extract from File* (PDF text) +
a Code node — **no OCR service, no API key, no cost** for born-digital (text-layer)
PDFs. A Nanonets OCR sub-graph is included but *disconnected* (optional, for scanned
images) — see the workflow sticky note. If you use it, keep the key in an n8n
*HTTP Basic Auth* credential, never in a file.

## What's in here

```
workflow/
  invoice_po_match.workflow.json   ← import this into n8n
  build_workflow.js                ← regenerates the JSON from the code files
  gst-hsn-rates.csv                ← HSN→GST% table (reused from the reference skill)
  code/normalize.js                ← OCR/mock JSON → canonical schema
  code/matcher.js                  ← the two-way GST match (ladder + tiers + tolerances)
  code/to_rows.js                  ← result → CSV rows + base64
  code/parse_text.js               ← FREE: PDF text → canonical schema (regex, no key)
  code/ocr_nanonets.js             ← OPTIONAL: Nanonets OCR prediction → canonical
web/index.html                     ← custom upload UI (verdict, flags, line table, CSV download)
samples/
  scenarios.json                   ← 13 edge-case scenarios (canonical parsed JSON)
  mock_parsed.json                 ← one happy-path payload for a quick curl test
  invoice_sample.pdf, po_sample.pdf ← GST-style sample PDFs
tests/
  run.js                           ← runs the matcher over every scenario (26 assertions)
  emulate_n8n.js                   ← runs the ACTUAL embedded node code end-to-end (sample + upload)
  local_probe.js                   ← FREE: parses the sample PDFs and matches them, offline
  test_ocr_map.js / nanonets_probe.js ← optional Nanonets OCR mapping + live probe
docs/
  edge-cases-two-way.md            ← the derived two-way edge-case catalog
  README.md                        ← this file
```

## Verify the logic offline (no n8n, no OCR key)

```bash
cd n8n-invoice-po-match
node tests/run.js            # 26 passed — matcher vs every edge case
node tests/emulate_n8n.js    # PASS — the workflow's embedded node code (sample + upload paths)
node tests/local_probe.js    # parses the two sample PDFs (FREE, no key) → Match + CSV
```

`tests/emulate_n8n.js` runs the *exact jsCode stored in the workflow JSON*, so a green
result here means the same code will run in n8n.

## Import & run in n8n (sample mode — works immediately)

1. **Import**: n8n → *Workflows* → *Import from File* → `workflow/invoice_po_match.workflow.json`.
2. **Activate** (or open the editor and use the test webhook URL).
3. Copy the **production webhook URL** for `POST /webhook/invoice-po-match`.
4. **Try it from the page**: open `web/index.html`, paste the webhook URL, pick a
   sample scenario, **Run match**. You'll see the verdict, the three header checks,
   the flags, the line table, and a **Download CSV** button.

Or straight from the shell:

```bash
curl -s -X POST "$WEBHOOK_URL" \
  -F "mode=sample" \
  -F "payload=$(cat samples/mock_parsed.json)" | jq '.result, .header.flags'
```

## Parse real PDFs — FREE (no API key)

The upload path is already wired: **Route → Extract invoice/PO text → Parse text →
canonical → Match**. It uses n8n's built-in *Extract from File* node for PDF text and
a Code node (`parse_text.js`) for the field parsing. Nothing else to configure.

1. **Prove it locally first** (no n8n): `node tests/local_probe.js` → parses
   `samples/invoice_sample.pdf` + `samples/po_sample.pdf` and prints `Match`, writing
   `samples/out/local_result.csv`. Try your own: `node tests/local_probe.js inv.pdf po.pdf`.
   If a field is mis-read, tweak the regexes in `workflow/code/parse_text.js` and
   re-run — then `node workflow/build_workflow.js` to push it into the workflow JSON.
2. **Import** `workflow/invoice_po_match.workflow.json` into n8n → **Activate**.
3. Copy the production URL for `POST /webhook/invoice-po-match`.
4. Open `web/index.html`, paste the URL. **Run a sample** first, then **Upload PDFs**
   → invoice + PO → **Parse & match** → verdict + **Download CSV**.

> **Works on text-layer (born-digital) PDFs.** Scanned/photographed PDFs have no text
> layer — for those, enable the optional OCR sub-graph below.

## Optional — OCR for scanned PDFs (Nanonets)

The workflow ships three disconnected **OCR** nodes for image-only PDFs. To enable:
set env `NANONETS_INVOICE_MODEL` / `NANONETS_PO_MODEL`, add an *HTTP Basic Auth*
credential (a **valid Nanonets *extraction* API key** — from the document-extraction
product, not the Agents workspace), select it on both OCR nodes, and connect
`Route(false) → OCR invoice + OCR PO → Merge → Map OCR → Normalize`. Validate the
mapping with `NANONETS_MOCK=1 node tests/nanonets_probe.js`, or against your real key
with `NANONETS_API_KEY=… NANONETS_INVOICE_MODEL=… NANONETS_PO_MODEL=… node tests/nanonets_probe.js`.

## Config

- **FY window** — default `2025-04-01 … 2026-03-31`; override per request via
  `opts.fy_start` / `opts.fy_end` in the payload.
- **HSN→GST% table** — `workflow/gst-hsn-rates.csv` (embedded in `matcher.js` as
  `DEFAULT_RATE_TABLE`); pass `opts.rateTable` to override.
- **Duplicate detection** — pass `opts.ledger: [{invoice_number, vendor_gstin, total, invoice_date}, …]`
  of already-processed invoices to flag exact/near duplicates.
- **CORS** — the Webhook node sets `Allowed Origins = *` and the Respond node adds
  `Access-Control-Allow-Origin: *`, so the page can call it from any origin
  (including `file://`). Tighten to your domain for production.

## Editing the logic

Edit the files in `workflow/code/`, then regenerate the workflow so the embedded
code matches:

```bash
node workflow/build_workflow.js   # rewrites invoice_po_match.workflow.json from code/*.js
node tests/run.js && node tests/emulate_n8n.js && node tests/test_ocr_map.js
```

The **OCR field mapping** lives in `workflow/code/ocr_nanonets.js` (aliases →
canonical). After editing it, re-run `build_workflow.js` so the *Map OCR → canonical*
node picks up the change.

## The rules (short version)

Two-way reduction of the reference skill (`../purchase-four-way-match/`). The
**verdict** is driven only by three Tier-1 checks — **vendor GSTIN**, **total = Σ PO
(±₹1/0.5%)**, **dates in FY**. Everything else (over-billing, rate/line/qty variance,
HSN/GST, date order, duplicates, lump-sum, multi-PO) is a **flag** that explains the
result without overruling it. Full catalog: [`edge-cases-two-way.md`](./edge-cases-two-way.md).
