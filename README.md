# Invoice processing — from PDF to decision

A pipeline that takes a vendor invoice (PDF) and produces a **clear, reasoned,
auditable decision** — `AUTO_APPROVE`, `HOLD_FOR_APPROVAL`, `NEEDS_REVIEW`, or
`REJECT` — with *every step in between visible*.

The design goal isn't "extract fields." It's to replicate the judgement of a good
AP clerk — *and be able to explain that judgement afterwards*. Every decision is a
pure function of a list of **findings**, and every finding carries its evidence,
so the "why" can never drift from the "what."

---

## What is in this repository

The Python pipeline documented below is the core, but the repo also carries two
n8n workflow implementations and the reference skills they were derived from.

| Path | What it is | Start here |
|------|------------|-----------|
| `invoice_pipeline/`, `run.py` | The Python invoice-to-decision pipeline described in the rest of this README. Six stages, one audit trace, four outcomes. | this file |
| `n8n-invoice-decision/` | The same idea as an importable n8n workflow: Claude extraction plus a deterministic decision engine, with a browser UI and node-level emulation tests. | `n8n-invoice-decision/README.md` |
| `n8n-invoice-po-match/` | A two-way invoice ↔ PO match workflow (OCR → normalize → match → rows) with 13 scenario fixtures and GST/HSN rate data. | `n8n-invoice-po-match/docs/README.md` |
| `purchase-four-way-match/` | Reference skill for the full four-way match (bill, PO, GRN, register), including the check-rules and field catalogue the workflows follow. | `purchase-four-way-match/SKILL.md` |
| `purchase-invoice-vouching-v3/` | Reference skill for purchase-invoice vouching and write-back. | `purchase-invoice-vouching-v3/SKILL.md` |
| `samples/`, `data/`, `out/` | Generated demo invoices, the mock procurement ledger, and committed example output for all six scenarios. | `out/01_happy_path.json` |
| `samples/bulk-batch/` | Six real-shaped invoice/PO PDF pairs for trying the pipeline on a batch. | — |

Three things worth knowing before you run anything:

- **You must supply your own n8n webhook URL.** The deployment-specific endpoints
  were removed from the shipped defaults. Both web UIs have a field for it, and the
  deploy/smoke scripts read `N8N_BASE`.
- **`n8n-invoice-decision/workflow-exports/` holds historical n8n exports** kept for
  reference. They reflect the original deployment, not this repo's defaults.
- **The credential IDs in the workflow JSONs are references, not secrets.** n8n stores
  the actual API keys encrypted on the instance; an ID on its own grants nothing.

---

## Quickstart

```bash
pip install -r requirements.txt
python samples/generate_samples.py     # writes 6 demo invoice PDFs
python run.py --all                    # process them all; prints reports
python tests/test_pipeline.py          # 23 assertions, no pytest needed
```

Process a single invoice:

```bash
python run.py samples/03_partial_overbill.pdf
```

Each run prints a human-readable report (extraction → full trace → decision) and
writes machine-readable JSON to `out/<name>.json`.

---

## How it works

Six stages. Each one appends to a single audit **trace**; the report is rendered
*from* that trace, so nothing happens off the record.

```
 PDF ─▶ 1.Ingest ─▶ 2.Extract ─▶ 3.Validate ─▶ 4.Match ─▶ 5.Rules ─▶ 6.Decide ─▶ report
        │           │            │             │          │          │
        text vs     fields +     math,         vendor +   business   4 outcomes,
        scanned     confidence   required,     PO (+ bal- rules →     ranked reasons,
        (OCR gate)  per field    date sanity   ance)      findings    next action
```

| Stage | File | Responsibility |
|-------|------|----------------|
| 1. Ingest | `ingest.py` | Get text out of the PDF; detect a scanned image (no text layer) and flag it for OCR instead of guessing. |
| 2. Extract | `extract.py` | Vendor-agnostic field extraction with a **confidence per field**. Tries ordered labelled patterns ("Invoice No." / "Bill Number" / "Inv #"), falls back to positional heuristics. |
| 3. Validate | `validate.py` | The invoice *in isolation*: required fields, arithmetic reconciliation (line items → subtotal → tax → total), date sanity. |
| 4. Match | `match.py` | Bind to the procurement system: resolve the vendor (exact/alias/fuzzy), find the PO (explicit, or unambiguously inferred). |
| 5. Rules | `rules.py` | Everything needing PO context: amount vs tolerance, **cumulative/partial billing**, **duplicate detection**, currency, and the **extraction-confidence gate**. |
| 6. Decide | `decide.py` | Fold all findings into one outcome by strict precedence, with ranked reasons and a concrete next step. |

### The four outcomes (why four, not "approve/reject")

Real AP isn't binary. The interesting failures live between yes and no.

| Outcome | Meaning | Example trigger |
|---------|---------|-----------------|
| `AUTO_APPROVE` | Safe to pay, no human needed | clean invoice, exact PO match, in tolerance |
| `HOLD_FOR_APPROVAL` | Matched, but a **bounded, quantified** variance needs an approver's sign-off | 6.8% over PO, within the approver band |
| `NEEDS_REVIEW` | Can't decide automatically — missing/low-confidence data or an ambiguous match | no invoice number; scanned image; possible duplicate |
| `REJECT` | Hard stop — must not be paid as-is | unapproved vendor, confirmed duplicate, overbilling beyond band |

Precedence (worst wins): `REJECT` > `NEEDS_REVIEW` > `HOLD_FOR_APPROVAL` > `AUTO_APPROVE`.

### The "procurement system"

Two JSON files under `data/` stand in for an ERP:

- **`purchase_orders.json`** — approved vendor master (+ aliases) and open POs, each
  with its own `allow_partial` flag and currency.
- **`invoice_ledger.json`** — everything already processed. This gives the system
  **memory**, which powers two things at once: duplicate detection, and *stateful*
  cumulative billing against a PO (how much of the PO is already spent).

Swapping in a real ERP means reimplementing one file: `procurement.py`.

### Policy lives in one place

Every threshold that changes a decision is in `config.py` with a comment on *why*
it exists — auto tolerance (2% or $100), approver band (10% or $2,500), the
confidence gate (75%), duplicate rules, date sanity. An AP lead can tune policy
without reading logic.

---

## The edge cases (the interesting part)

Four scenarios, each chosen to force the pipeline down a *different* branch and
reveal a different kind of judgement. All four are in `samples/` and asserted in
the test suite.

### 1 — Cumulative overbilling on a split PO  → `REJECT`
`samples/03_partial_overbill.pdf`

A vendor splits one $50,000 PO across several invoices. Two are already in the
ledger ($22k + $24k = $46k). A **third** $12k invoice arrives — perfectly valid
on its own, references the right PO, from an approved vendor. In isolation it
looks fine. It isn't: it pushes cumulative billing to **$58k, $8k over the PO**.

> *Why it matters:* this is only catchable with **state**. Each invoice is
> individually clean; the problem only exists across the set. The decision cites
> the two prior invoices by number and amount. This is the difference between
> checking a document and understanding a relationship.

### 2 — Near-duplicate (accidental double-pay)  → `NEEDS_REVIEW`
`samples/04_near_duplicate.pdf`

Same vendor, same $6,750, same date as an already-paid invoice — but a **different
invoice number**. Exact-match dedup misses this; it's the fingerprint of a vendor
(or clerk) accidentally submitting twice.

> *Why it matters:* it's flagged, not auto-rejected. A *different* number means it
> *could* be a legitimate second charge, so the safe action is "human confirms,"
> not "machine refuses." An exact duplicate (same number) *would* hard-reject —
> the system distinguishes "certainly a duplicate" from "probably a duplicate."

### 3 — Unreconciled totals + missing invoice number  → `NEEDS_REVIEW`
`samples/05_unreconciled_missing.pdf`

No invoice number, no PO, and subtotal + tax ($3,350) ≠ the stated total ($3,520).
The pipeline **refuses to guess**. It won't invent an invoice number, and it
won't silently attach the vendor's one unrelated PO just because the vendor
matches.

> *Why it matters:* the failure is *specific and actionable* — it names the four
> problems (missing number, Δ$170 that doesn't add up, no resolvable PO, low
> confidence) so a human fixes the right things. A system that guessed here would
> be worse than useless; it would be confidently wrong.

### 4 — Scanned image (no text layer)  → `NEEDS_REVIEW`
`samples/06_scanned_image.pdf`

An image-only PDF. Ingest finds no text layer, the confidence gate trips, and the
pipeline routes it to manual key-entry **without** running vendor/PO matching on
empty data (which would have fired a misleading "vendor not approved" reject).

> *Why it matters:* honesty about uncertainty. The system knows the difference
> between "I read this and the vendor is unapproved" and "I couldn't read this."
> Only the first is a rejection; the second is a request for help. Acting on a bad
> OCR read is how you pay the wrong amount to the wrong vendor.

---

## Design decisions & trade-offs

- **Findings-as-data, decision-as-pure-function.** The outcome is derived from the
  findings by one small function (`decide.py`). This guarantees the explanation
  and the decision agree, and makes every branch unit-testable.
- **`Decimal`, never `float`, for money.** Non-negotiable in AP.
- **Confidence is first-class.** Extraction attaches a confidence to every field;
  the pipeline only makes automated money decisions above a threshold. Below it,
  a human decides. This is the whole safety story for messy/scanned inputs.
- **Refuse to guess.** Ambiguity (no PO, unresolved vendor, broken math) routes to
  a human with a specific reason rather than a best-effort guess.
- **Extraction is deterministic & offline** so the demo is fully reproducible.
  It's also **pluggable**: `extract.py` has one clear seam. Dropping in an
  LLM/vision extractor (e.g. Claude with the PDF) for the hard/scanned cases would
  be a drop-in replacement that returns the same `ExtractedInvoice` + confidences
  — everything downstream is unchanged. Real OCR (Textract/Tesseract) plugs into
  `ingest.py` the same way.

### What I'd add next
- LLM/vision extractor behind the existing seam, for scanned + weird layouts.
- Line-item ↔ PO-line matching (3-way match), not just header totals.
- Write approved/near-dup outcomes back to the ledger to close the loop.
- Vendor-bank-detail change detection (a classic fraud vector).
- FX handling for multi-currency POs.

---

## Layout

```
run.py                     CLI entrypoint
config.py                  all decision thresholds (policy)
invoice_pipeline/
  ingest.py  extract.py  validate.py  match.py  rules.py  decide.py
  procurement.py           ERP stand-in: vendors, POs, ledger, dup detection
  pipeline.py              orchestrator (threads the trace through all stages)
  report.py                human-readable rendering
  models.py  trace.py  util.py
data/                      purchase_orders.json, invoice_ledger.json
samples/generate_samples.py  builds the 6 demo PDFs
tests/test_pipeline.py     23 assertions, dependency-free
out/                       decision JSON written here
```
