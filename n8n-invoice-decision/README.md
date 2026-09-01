# PS-1 · Invoice ↔ PO Reconciliation (n8n)

Drop a **batch of PDFs — a mix of invoices and purchase orders — and it reconciles them**:
matches each invoice to its PO, flags any **invoice with no PO** and any **PO with no invoice**,
and gives every matched pair a reasoned amount verdict. Everything is self-contained and provable:
the POs are uploaded inputs, not hidden data.

## The one idea that matters

> **Claude classifies + reads each document. Deterministic code does all the reasoning.**

Claude does *perception only* — it decides "invoice vs PO" and pulls the fields off each PDF. The
moment the batch is extracted, **hand-written deterministic code** does the matching, the
missing-on-both-sides coverage, and the amount verdict. The LLM never decides. Money is integer
**cents** (never float); vendor similarity uses a faithful `difflib.SequenceMatcher.ratio()` port.

## Pipeline (8 nodes)

```
Chat UI ──POST {files:[{filename, content_base64}]}──► Webhook (/invoice-decision)
        ▸ Split Files (1 item / PDF) ▸ Claude Extract (per file: classify + read)
        ▸ Parse Doc (→ canonical) ▸ Reconcile (match + coverage + verdicts) ▸ Respond
```

`reconcile()` produces three buckets — **matched** (with a per-pair verdict), **invoice-with-no-PO**,
**PO-with-no-invoice** — plus **duplicates** (within the batch) and **unreadable/unrecognized** docs.

### Match ladder (from the Superjoin skills)
Each invoice is matched to a PO by trying, in order — **vendor identity = the seller's GSTIN, not the printed name**:
1. **PR/PO number** (the buyer's ref; the vendor's own "Cust PO No" is ignored)
2. **seller-GSTIN + exact total** fingerprint
3. **name + exact total** fingerprint
4. **"possible"** — seller-GSTIN matches a PO but the total is off → surfaced (not hidden) as a flagged mismatch
5. **none** → the invoice lands in *PO-missing*

The GSTIN rungs only fire when both sides carry a GSTIN, so US/no-GSTIN batches use the number/name paths unchanged. A small Claude **`system` prompt** guides *extraction* (seller-vs-buyer GSTIN by section, tax-invoice layout, ignore vendor refs) — but the ladder, tolerances and verdict stay in deterministic code.

### Advanced checks (additive, flag-only — never change a match)
- **Many-to-many:** one invoice ↔ **several POs** (total vs Σ of PO totals) and one PO ↔ **several invoices** (split billing → each `PARTIAL`; combined over the PO → over-billing flag).
- **Line-item matching:** pairs invoice lines to PO lines (HSN → description → token overlap) and flags rate/quantity differences — a flag, never a re-match.
- **GST battery:** HSN structural validity + GST-rate-vs-table (bundled FY 2025-26 rates, indicative) + `taxable + tax = total`.
All three are **guarded** (absent inputs ⇒ today's behavior) and surface in the matched-card **details** in the UI. Try them live with `samples-mm/` (many-to-many) and `samples-checks/` (line + GST).

### Cross-run memory (persistent, additive, flag-only)
The workflow remembers every invoice it has processed — in the workflow's **own static data** (`$getWorkflowStaticData('global')`; no external store), so signals span **separate uploads**, even weeks apart:
- **Cross-run duplicate** — a re-submitted invoice (same vendor + invoice number, or same vendor + amount + date) is flagged *"already processed in a prior run"* → don't pay it twice.
- **Cumulative over-billing** — a PO whose prior billing + this batch exceeds the PO value is flagged, even when each invoice looks fine on its own.
Both are **flag-only** — they raise a badge/section but never change a verdict. A **Memory** tab lists the ledger and a **Clear memory** button (POST `{reset_memory:true}`) wipes it for a fresh demo. Prove it live by POSTing `samples-mem1/` then `samples-mem2/` (no redeploy between).

## Verdicts (matched pairs)
| Status | When |
|---|---|
| **MATCHED** | amount within ±2%/$100, vendor + currency agree |
| **VARIANCE** | amount within the approver band (±10%/$2,500) — needs sign-off |
| **REVIEW** | vendor mismatch on a matched PO number (possible wrong PO) |
| **MISMATCH** | amount beyond the band, or currency mismatch |

## What's in here

| Path | What |
|------|------|
| `code/reconcile-engine.js` | **The whole reconciliation engine** (single source of truth) — `buildDocRequest` (classify+extract tool), `parseDocument`, `reconcile`, `pairVerdict`. Embedded verbatim into the n8n Code nodes. |
| `build_reconcile.js` | Assembles `reconcile.workflow.json` from the engine + the Claude Header Auth credential (`deploy.local.json`). |
| `reconcile.workflow.json` | The importable/deployable workflow (8 nodes: 6 functional + 2 sticky notes). |
| `web/index.html` | Dashboard UI — drop a batch → reconciliation report, a batch-history view, and a **Memory** ledger. |
| `demo-batches/` (`generate.py` + `render.py`) | **Four realistic demo batches** (invoices + POs) covering every edge case — run in order. |
| `tests/reconcile-fixtures.js` | Offline stand-ins for Claude's extraction, one per scenario. |
| `tests/emulate-reconcile.js` | `reconcile()` over the fixtures — asserts every bucket, verdict, and memory flag. |
| `tests/emulate-nodes-reconcile.js` | Runs the **actual jsCode from the workflow JSON** through a mock n8n runtime (mock Claude + a mock static-data store, proving cross-run memory persists). |
| `tests/post_batch.js` / `tests/deploy.js` | Live batch smoke test / deploy-via-API (by workflow id). |

## Run it

```bash
npm run build     # → reconcile.workflow.json
npm test          # 44 engine + 18 node-level assertions, offline
npm run samples   # (re)generate the four demo-batch PDFs

# deploy to a live n8n + smoke test (n8n API key required)
N8N_API_KEY=<key> N8N_WORKFLOW_ID=<id> npm run deploy
N8N_API_KEY=<key> npm run smoke
```

**Live:** once deployed, the workflow answers on `https://<your-n8n-host>/webhook/invoice-decision`
(set `N8N_BASE` for the deploy and smoke scripts). Claude auth uses an
n8n **Header Auth credential** (the instance blocks `$env` in nodes); its id is recorded in
`deploy.local.json` so every build keeps it wired.

## Demo — four batches cover every case

Run them in order on the **Reconcile** tab (or with `tests/post_batch.js`). **Clear memory first**
(Memory tab → *Clear memory*), because batch 4 relies on batch 1 already being in memory.

**1 · `demo-batches/1-core`** — the classic buckets:
- Acme ↔ PO-2201 → **MATCHED** (+ its second copy → **DUPLICATE**)
- Northwind $8,480 ↔ PO-2202 $8,000 → **VARIANCE**; Globex $22,000 ↔ PO-2203 $18,000 → **MISMATCH**
- Riverstone (a **scanned phone photo**) ↔ PO-2207 → **MATCHED via OCR**
- Initech cites PO-2299 (absent) → **PO MISSING**; Zylker PO-2205 → **INVOICE MISSING**; delivery note → **UNREADABLE**

**2 · `demo-batches/2-many-to-many`** — the relationship cases:
- Summit invoice cites **two POs** (PO-3301 + PO-3302) → matched vs their **sum** → MATCHED
- Initech PO-3303 billed by **two invoices** → **PARTIAL** ×2 (split billing)
- Globex PO-3305 billed **over** by two invoices → **MISMATCH** (over-billing)
- Northwind line items with mismatched rates → **line-item flags** (verdict still MATCHED)
- Vertex invoice vs an **Apex** PO (same number, different vendor) → **REVIEW**

**3 · `demo-batches/3-gst-india`** — India / GST:
- Bharat matched by **GSTIN + total** (cites no PO number) → MATCHED, GST clean
- Konkan GSTIN matches a PO but the total is off → **"possible" → MISMATCH**
- Deccan → MATCHED, with **GST flags**: malformed HSN + wrong rate + tax that doesn't reconcile

**4 · `demo-batches/4-memory`** — cross-run memory (run **after** batch 1):
- Northwind NW-8830 (already seen in batch 1) → **ALREADY PROCESSED** (cross-run duplicate)
- Acme AC-4099 on PO-2201 (already fully billed in batch 1) → MATCHED + **cumulative over-billing**

## Design notes / honest limits
- **Perception vs decision split** — the defensible core: Claude reads, code reconciles.
- **One document per PDF** in v1. Bundled multi-doc PDFs would need a splitter (the four-way `bundle-splitter` pattern) — a documented extension.
- **Batch size** — N files = N Claude calls (synchronous); the demo batches run ~12 files in ~10s. For scale, parallelize the HTTP node / use an async `202 + poll`.
- **Currency display** — amounts render with a `$` sign regardless of currency (the India batch prints `Rs.` on the PDFs but the result shows `$`). A cosmetic limitation; matching itself is currency-aware (a currency mismatch is flagged).
- **Cross-run memory** persists in the workflow's static data across production runs; a workflow *redeploy* can reset it, so run a demo sequence without redeploying in the middle.
- **Dashboard** history is client-side (localStorage); the Memory ledger is server-side. Both are fine for the demo.
