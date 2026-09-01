---
name: purchase-four-way-match
description: >
  Four-way purchase reconciliation for a buyer — matches the procurement chain
  PO → GRN → Invoice → Purchase Register (ordered → arrived → billed → booked),
  then augments the user's Purchase Register sheet IN PLACE with cited INVOICE /
  PO / GRN / CHECKS bands, and writes a quantity-flow Lines sheet. Register-anchored:
  one row per register posting, resolved backwards to its invoice, PO, and GRN(s).
  Verdict is reconciliation-driven (identity + amount vs PO and vs the register
  flip Match / No match; quantity over-receipt/over-billing and all date-sanity
  checks are flags). Every compared value clicks back to its source — invoice/PO/GRN
  to the PDF, register figures to their cell. Handles both individual document PDFs
  and bundled PDFs (a single file concatenating an invoice + GRN + PO, possibly several
  sets) — auto-detected and segmented per file. Use when the user asks to do a
  three/four-way match, vouch a purchase register against bills + POs + GRNs, or
  reconcile booked purchases to their supporting documents. Reports findings only;
  never approves anything for payment.
---

# Purchase Four-Way Match → augmented register + quantity-flow Lines sheet

You orchestrate a four-way purchase reconciliation on the open workbook. For each
**register posting** (the books), resolve its evidence chain **backwards** — to the
invoice, the PO, and the GRN(s) — run a fixed check battery, and surface findings: every
compared value a click-to-source citation, every verdict one of three states (**✓ agrees ·
✗ fails · — couldn't verify**). Pipeline:

**extract → match (backwards ladder) → check (4 tiers) → write back.**

Output: the user's **Purchase Register sheet, augmented in place** — cited bands
**[INVOICE] → [PURCHASE ORDER] → [GRN] → [CHECKS]** appended to the right of their columns
(their cells untouched), headline verdict **"Match" / "No match"** — plus a **Lines** sheet
(every invoice line beside its matched PO line and GRN line, the ordered → received → billed
quantity flow). You **report findings; you never approve for payment.**

The skill is vendor- and buyer-agnostic. Never hardcode a buyer, vendor, HSN, or rate.

## Design spine — enumerate → structure → judge

- **Enumerate** (deterministic): every **register posting** = each data row of the register
  sheet; every **document** = each attachment classified `po | grn | invoice`. The register
  row set is the coverage ground truth — no posting drops before the workpaper.
- **Structure** (extraction + citations): POs/GRNs/invoices via the PDF cascade + gate
  (each field `{value, page, source_text}`); the register via `read_sheet` (structure +
  encoding) + `read_range` (values), each field cited to its **cell**.
- **Judge** (narrowest question per unit): the backwards match ladder + the four tiers —
  deterministic comparisons in `container_python`; only the fingerprint tie-breaks, the
  handwritten-PR read, and the register column mapping need narrow judgment.

## Two governing rules

### A. User-facing language hides internals
Auditors care about findings, not tooling. Never say `pdf_agent`, `index.json`,
`content.md`, `read_image`, `read_sheet`, `read_range`, `generate_code`,
`operationsFilePath`, `--cite-pdf`, or "sub-agent" in chat. A scanned/handwritten invoice is
an "image-based invoice".

### B. Every question uses `ask_clarification`
Start/skip, the FY window, the GST rate source, **which worksheet is the Purchase Register**,
and any ambiguous register money-column mapping — via `ask_clarification`, never inline chat.
Message is *only* attachments → first action is `ask_clarification`. Files are not consent.

## Orchestrator vs sub-agents — who reads what
You are the **orchestrator** — a **thin coordinator**. **Never read raw document or sheet text
into your own context; hold only compact JSON + the DSL you build.** Every heavy read is a
fan-out sub-agent: **classify/segment** (`bundle-splitter`), **register extraction**
(`register-extractor`), **document extraction** (po/grn/bill), and **matching** (`matcher`).
For each, `spawn_subagent` a `general_purpose` agent and tell it, in its task text, to read its
own playbook first. **The only `references/` file you open is `references/writeback.md`**
(Phase 4) — `register-extractor.md`, `bundle-splitter.md`, the extractors, and `matcher.md` are
sub-agent playbooks you never open.

```
spawn_subagent(agent_id="general_purpose", name="Extract GRNs 1–6",
  description="Extract a batch of goods-receipt notes for the four-way match",
  task="Read your playbook at /home/sandbox/skills/purchase-four-way-match/references/grn-extractor.md via container_bash, then follow it. Inputs: file_stems=[…this batch…]. Write output to /home/sandbox/outputs/4w-grn-extract-0.json.")
```

## Quick checklist
```
[ ] Phase 0  — Proactive? ask_clarification first. Collect FY window + GST source + WHICH SHEET is the register + any custom checks (today: site-name) → custom_checks.
[ ] Phase 1  — inventory (light); FAN OUT bundle-splitter to classify+segment (NEVER inline) → compact segment lists; flatten to virtual docs; reconcile page coverage.
[ ] Phase 1.5— spawn register-extractor SUB-AGENT (∥ Phase 1): reads the sheet in its own context → compact summary + 4w-register JSON. Ambiguous money col → ask once, re-dispatch.
[ ] Phase 2  — TWO LANES: individual docs → per-type extractors (whole file); bundles → ONE bundle-extractor per bundle (reads it once, all segments). Hand the matcher BOTH lanes' files.
[ ] Phase 3  — spawn one matcher per register-batch (~15–20 postings, NOT all-in-one): backwards ladder + 4 tiers (+ custom_checks) → findings; exact-key-then-judged line pairing (no similarity-tuning); single pass; loads records under invoices/pos/grns + line items under rec["lines"] (NOT line_items); a matched itemized posting MUST emit ≥1 Lines row (never lines=[]); never fabricates a missing doc.
[ ] Phase 3d — coverage reconcile: every posting has exactly one findings record; compute invoices_not_in_register (booked-not-… inverse: billed-not-booked); LINE-ITEM/ROW-SCHEMA gate — auto re-dispatch any batch flagged EMPTY_LINES_ON_MATCH or SCHEMA_INCOMPLETE (capped once). Else re-dispatch / hard-stop.
[ ] Phase 4  — augment the register in place (append cited bands; pass custom_checks for the opt-in Site col), build the Lines sheet, cross-link. Verify. Report findings.
```

## Phase 0 — Confirm + parameters
Strip `<context file="…"/>` tags from the latest message. Empty residue or no matching verb
→ **proactive**: first action is `ask_clarification` ("I see N vendor invoices with POs and
goods-receipt notes, plus a purchase register — shall I run a four-way match and annotate the
register?", 2-3 filenames). Settle: **FY window** (default 2025-04-01 … 2026-03-31), **GST
rate source** (bundled `references/gst-hsn-rates.csv`, or the user's master), **which open
worksheet is the Purchase Register** (list the sheet names; pre-suggest the tab whose headers
best match, but the user confirms), the **register reconciliation tolerance** (default
±₹1 or ±1%), and **any custom checks beyond the standard battery** — offer the available ones
(today only **Site-name consistency**: verify every matched document references the same
site/project; **verdict-driving** when chosen) and record the selection as `custom_checks`
(default `[]`). **Yes** → Phase 1. **No** → stand down.

## Phase 1 — Classify + segment by content, not filename
A single PDF may be **one document** or a **bundle** — invoice + GRN + PO concatenated
(possibly several such sets, possibly partial). So Phase 1 both classifies and **segments**.
- **1a inventory** (deterministic): one `container_python` pass over
  `/home/sandbox/attachments/*/index.json` → `{id, filename, page_count, total_chars}` =
  coverage ground truth. `total_chars` is only a **hint**: `≈ 0` (scanned/image-only) →
  `start_rung="content_md"` — **`content.md` is the OCR of those pages and the source of truth;
  never route an image-only PDF to `read_image`, and there is no "image" rung**. `> 0` → may
  pass `"index_text"`. `read_image` is an **extractor-only last resort** for a handwritten
  ref that `content.md` misses — **never for classification or segmentation**. Pass the hashed
  `<stem>`.
- **1b classify + segment (fan-out — never inline):** **always** dispatch classify+segment to
  `bundle-splitter` sub-agent(s) (`references/bundle-splitter.md`, shard ~10 attachments each) —
  **the orchestrator never reads `content.md`.** Each shard reads its attachments' page heads,
  splits at **document-start boundaries** (a page whose head is a document **title** opens a new
  segment — "Tax Invoice" → `invoice`, "Purchase Order" → `po`, "Goods Receipt Note"/"GRN" →
  `grn`; a page with no fresh title continues the current segment, so two same-type docs
  back-to-back split correctly), and returns a compact `{stem, is_bundle, segments:[{doc_type,
  pages, segment_index}]}`. A single-document PDF → one segment.
- **1c flatten + coverage reconcile**: flatten the returned lists into a **virtual-document
  list** `[{stem, bundle_id, doc_type, pages, segment_index}]` — `bundle_id = stem` when the
  attachment had >1 segment, else `null`; `pages` is the absolute range. Assert **every page of
  every attachment lands in exactly one segment** and every segment is `po | grn | invoice`
  (a stray `other` → one targeted re-segment, then hard-stop with the list).

## Phase 1.5 — Register extraction (fan-out sub-agent, ∥ with Phase 1)
**Spawn a `register-extractor` sub-agent** (it reads its own `references/register-extractor.md`)
— do **not** read the register yourself; that would dump 30–40+ rows into your context. Pass
`register_sheet` (the tab from Phase 0) and `output_path`. It reads the sheet in **its own
context** (`read_sheet` + `read_range`), judges the columns, writes `4w-register-<k>.json`, and
returns a **compact summary** (`sheet`, `header_row`, `last_used_column`, `column_map`, posting
count, `ambiguous`, diagnostics). **Independent of Phase 1 → spawn it in the same turn
(parallel).**
- **Ambiguous money column:** if the summary has `ambiguous: true`, surface **one**
  `ask_clarification` with the candidate headers it returned, then **re-dispatch** the sub-agent
  with `forced_column_map` = the user's choice.
- Keep `header_row` / `last_used_column` / `column_map` from the summary — **Phase 4 reuses
  them**, so the register sheet is never re-read.

## Phase 2 — Extract (fan-out, parallel) — TWO LANES
Split the virtual-document list (Phase 1) by **individual vs bundle**, and run both lanes in
parallel.

**Lane A — individual docs** (`bundle_id = null`), grouped by `doc_type`, ~10/batch (whole file each):
| Bucket | Playbook | Output |
|---|---|---|
| `invoice` | `references/bill-extractor.md` (borrows v5; GSTIN, PR/PO refs, lines, taxable/tax/total) | `4w-bill-extract-<k>.json` |
| `po` | `references/po-extractor.md` (PR/PO, GSTIN, dates, lines + itemized/lump flag) | `4w-po-extract-<k>.json` |
| `grn` | `references/grn-extractor.md` (GRN no, PO ref, receipt date, lines + qty received) | `4w-grn-extract-<k>.json` |

**Lane B — bundles** (`bundle_id ≠ null`): **one `bundle-extractor` per bundle** (`references/
bundle-extractor.md`, batch ~N bundles per sub-agent). It reads each bundle's `content.md`
**once** and extracts **all** its segments (invoice + GRN + PO) in a single pass — **no per-type
extractor ever touches a bundle** (this is what avoids re-reading the same PDF three times and the
GRN getting distracted by the PO/invoice on the other pages). Pass it each bundle's `{stem,
segments}` (from the splitter) + the three output paths; it writes the **same per-type shapes**
(`4w-bill-extract-b<k>.json` / `…-po-…` / `…-grn-…`), records tagged `bundle_id`/`segment_index`.

Load all returned JSON with `container_python`. **Hand the matcher BOTH lanes' files** — Lane A's
per-type files **and** Lane B's bundle files — in the respective `invoice_paths`/`po_paths`/
`grn_paths` lists. (The matcher is unchanged; bundled docs carry a real `bundle_id` so it prefers
same-bundle pairings.)

## Phase 3 — Match + check (fan-out, parallel)
**Batch the register into ~15–20 postings each** and `spawn_subagent` **one matcher**
(`general_purpose`) per batch — **never one matcher over all postings** (an overloaded context is
where the load-contract slips and PO data gets mis-keyed). Each reads `references/matcher.md` (and
the `check-rules.md` it points to) — you don't read them. Pass, in the task text: this batch's
`register_paths`, **all** `invoice_paths`, **all** `po_paths`, **all** `grn_paths` (any posting may
match any document), the FY window, the GST source path, **and `custom_checks`** (the Phase-0
opt-in list — `["site_name"]` enables the verdict-driving site check). It loads records under the
keys `invoices` / `pos` / `grns` and **never fabricates a missing document** (a zero-load is a
diagnostic, not a licence to invent). It:
1. **Resolves the chain backwards** (rules §1): register→invoice (invoice no + vendor →
   fingerprint → none), invoice→PO (PR/PO → GSTIN+total), PO→GRN(s) — recording per-hop
   bases + confidence. **No invoice traced → the whole appended row is left blank** (Match
   result + Reason empty; still counted).
2. Runs the **four tiers** (rules §2): Tier-1 reconciliation spine (verdict-driving: vendor,
   total=PO, dates-in-FY, **and the three register members** taxable/GST/total vs invoice),
   Tier-2 per-line HSN/GST (flags), Tier-3 quantity flow over-receipt / over-billing + sanity
   dates (flags), Tier-4 line pairing (flags, itemized PO only). *(PO-approval + buyer-stamp
   checks were removed — too unreliable to drive a verdict.)*
3. Emits one findings record per posting — every compared value with its citation, every
   verdict a three-state, a **header-driven Match result** (only the Tier-1 spine flips it;
   quantity/date/line flags never flip; a no-invoice posting is blank, not "No match"), the
   chain basis, the `qty_flow_summary`, the `line_items_summary`, a `flag_note`, and a one-line
   `reason` (only when "No match").
Output: `4w-findings-<batch>.json`. `status` always `ok`; problems in `diagnostics[]`.

## Phase 3d — Coverage reconcile
Every enumerated **register posting** has exactly one findings record. Shortfall → one
re-dispatch, then hard-stop with the list. **Also compute the inverse coverage gap:**
`invoices_not_in_register` = every extracted invoice that no posting matched (received /
billed but **never booked**). Register-anchoring cannot show these as rows — so **surface
the count + invoice numbers in the final chat summary** (and in `diagnostics`). A booked
purchase with no invoice is a Phase-3 "No match"; an invoice with no booking is this gap —
both are findings, neither is hidden.

**Line-item & row-schema coverage gate (auto re-dispatch).** Each matcher batch is an independent instance;
one can silently ship a matched posting with **empty line items** (the 16-bundle bug: an instance
read the wrong nested key `line_items` instead of `lines`, saw `[]` everywhere, and hardcoded
`lines = []` for all its matches). After combining, scan every findings `diagnostics` for the
matcher's `EMPTY_LINES_ON_MATCH` **and `SCHEMA_INCOMPLETE`** tripwires — `SCHEMA_INCOMPLETE: <row_type>
row <r> missing <part>.<key>` flags a Lines row that lost a contract field (this run: `line_no` ×3 + PO
`qty_ordered`, because each instance hand-rolled its own row assembly). Belt-and-suspenders, also recompute:
a posting with `match.invoice != "No invoice found"` + empty `lines`. Collect the **deficient batch indices**;
for each, **re-dispatch that one matcher batch once** (same inputs — it now reads the locked `lines`
key), overwrite its `4w-findings-<batch>.json`, and re-combine. **Cap at one re-dispatch per batch**;
if still deficient, **hard-stop and surface a loud chat diagnostic** naming the rows (don't loop). Only
proceed to Phase 4 once every matched, itemized posting carries its line items **with the full row
contract** (`line_no` on invoice/PO/GRN, PO `qty_ordered`, …).

## Phase 4 — Write back (orchestrator only)
Read all `4w-findings-*.json`, then follow **`references/writeback.md`**: detect-or-create
the hidden `4W Match — _meta` sheet and the `4W Match — Lines` sheet; decide **augment vs
standalone** (merged cells / no clean header / failed re-run sentinel → standalone fallback).
Build the **Lines** DSL first (records each posting's first row), then the **augmented
register** DSL (cited INVOICE/PO/GRN/CHECKS bands appended from the stored `append_col0`,
each posting on its `register_row`; the user's cells untouched). Write one ops JSON per sheet
and **apply each with `generate_code` via `operationsFilePath`** — Lines, then register;
`--cite-pdf` and register cell-links preserved. **One file per sheet, one `generate_code` —
never `generate_operations`, never chunking, never raw `execute_excel_code` literals (any of
those strips citations and drops cells).** The Lines sheet fans each invoice line into **one row
per GRN delivery** (Σ drives the over-receipt/over-billing checks) and tags each line's source
PO#; the register PO band shows the aggregate (listed PO#s, **Σ** PO total). Persist
`append_col0` in `_meta`. Verify with one `read_range`. **Idempotent:** re-running overwrites the same bands in place (the
re-extracted `register_row` keeps placement correct); to fully redo, delete the appended
columns + the Lines sheet + the `_meta` sheet.
**Check transparency:** deterministic checks (Total=PO, the three register reconciliations,
HSN, rate, over-receipt/over-billing) render as **live in-cell formulas** that reference the
actual cells (incl. the user's register cell); judged/lookup checks (vendor, PO# consistency,
item/line match, GST correct) stay computed glyphs. **Every check header carries a note**
explaining how it's computed. Promoted identity checks (`PO# consistent`,
cross-doc `Vendor`, Lines `Item match`) are explicit cells.
**Pass `custom_checks` into the writeback** so the **Site consistent** column is built only when
opted in (it sits just before MATCH RESULT and is verdict-driving). The CHECKS tail now reads
**Qty flow → Date sanity → MATCH RESULT**; the INVOICE band carries `PO No (on inv)`, the GRN
band `PO No` + `GRN GSTIN`, and `Received Qty` is the summed quantity (never a GRN count). The
column offsets are **derived from the band lengths**, so these additions need no manual renumber.

## Tool discipline
| Operation | Tool |
|---|---|
| Attachment inventory / read sub-agent JSONs | `container_python` (`json.load`) |
| Read a playbook / the GST table | `container_bash cat` |
| Classify + segment attachments (content.md OCR only — never read_image; never inline) | **`bundle-splitter` sub-agent(s)** → compact segment lists |
| Extract **individual** PO·GRN·invoice; read handwriting | per-type sub-agents over content.md; `read_image` last resort for a handwritten ref only |
| Extract a **whole bundle's** docs (one read, all segments) | **`bundle-extractor` sub-agent** → the three per-type files |
| Read the register sheet | **`register-extractor` sub-agent** (`read_sheet` + `read_range` in its own context) → compact JSON |
| Backwards ladder, fingerprints, all tier comparisons | `container_python` (inside the matcher) |
| Detect-or-create `_meta` + the Lines sheet; read `_meta!A1`; persist `append_col0` | `execute_excel_code` |
| Build the full DSL for each sheet → write one ops JSON to `/home/sandbox/outputs/` | `container_python` |
| Apply a sheet's ops JSON (cells, formats, `=HYPERLINK`, `--cite-pdf`) | `generate_code` with `operationsFilePath` |
| Sentinel/extent checks + verify the written sheets | `read_range` |

**Banned, with reason:** never mutate a **cited** cell directly via `execute_excel_code` /
`container_python` (cited cells are applied only by `generate_code` from the ops JSON, which
preserves `--cite-pdf`); never **rewrite the user's register cells** (reference them, append
to the right); never hardcode a buyer/vendor/HSN/rate, or a fixed register column layout
(judge the columns from `read_sheet`).

## Hard rules
- **Lean orchestrator (context isolation).** You hold only compact JSON + the DSL you build —
  **never** raw `content.md` or register rows. Classify/segment, register extraction, document
  extraction, and matching are **all sub-agents**; only the Phase-4 writeback (and its light
  sentinel/verify reads) runs in your context. Reading the register sheet or a doc's `content.md`
  yourself is a **bug** — spawn the sub-agent instead.
- **Register-anchored.** The population is the register postings; one augmented row per
  posting on its `register_row`. A posting with **no traceable invoice** is left **blank** (no
  Match result, no Reason, no bands — it can't be reconciled; in a partial doc set it usually
  just means the invoice wasn't attached) but **still counted** in the summary, never a silent
  Match. An invoice with **no posting** is the inverse gap → reported in Phase 3d, not dropped.
- **Bundles are segmented, not special-cased.** A single PDF may hold several documents; Phase
  1 splits it into per-document page ranges (`bundle_id` + `pages`), and the extractors scope to
  those pages. `bundle_id` is a **co-location preference** in the matcher (same-bundle PO/GRN
  tried first), never a forced 1:1 join — the printed PR/PO ref still decides, and a same-bundle
  ref disagreement is a flag ("bundle PO ref mismatch"), not a silent pairing. Partial bundles
  (missing GRN/PO) fall through to the existing three-state behaviour.
- **Verdict = reconciliation-only, header-driven.** "Match"/"No match" is decided by the
  Tier-1 spine — Vendor · Total=PO · Dates in FY · **Register Taxable=Inv · Register GST=Inv ·
  Register Total=Inv**. A **no-invoice** posting is left blank (not "No match"). **Over-receipt,
  over-billing, every sanity date (receipt/invoice/booking/date-order), HSN, GST, line/rate match
  are flags that NEVER flip.** `unverified` never flips (a missing GRN, an absent register column,
  a missing PO → "—" on a found row, not No-match). *(PO-approval + buyer-stamp were dropped from
  the spine — the underlying reads were too unreliable to drive a verdict.)*
- **Chain basis vs Match result are independent.** Record the rung that fired at each hop
  (register→invoice, invoice→PO, PO→GRN); a fingerprint-resolved chain can still be a Match.
- **Vendor identity = the seller's GSTIN, not the name.** The register may have no GSTIN →
  fall back to normalized name (flagged); ignore vendor-printed PO numbers.
- **Quantity flow is per item** (material code, else normalized description): ordered (PO) →
  received (Σ GRN) → billed (invoice). Aggregate received across multiple GRNs; never coerce
  a missing quantity to 0. Lump-sum PO / service GRN → "N/A — PO lump-sum" / "—".
- **Three states, always:** ✓ agrees, ✗ fails, **—** couldn't verify. Never force a missing
  value into a pass/fail.
- A reference exists only where a value exists → `--cite-pdf` (PDF) or `=HYPERLINK` (register
  cell); a rule (correct GST %, FY) → plain text; an absent value → "Not found"/"—", no link.
- **Augment in place; never overwrite the user's register cells.** Append bands to the right
  from the stored `append_col0`; fall back to a standalone `4W Match — Register` sheet when
  the sheet can't be safely augmented (merged cells / no clean header / shifted bands).
- Report findings only. Do **not** approve anything for payment.

## Reference files
- **You read ONLY:** [references/writeback.md](references/writeback.md) (Phase 4). Nothing else
  — every other read is a sub-agent's job (keeps your context lean).
- **Sub-agent playbooks — do NOT open; spawn the sub-agent to read its own:**
  `references/bundle-splitter.md` (classify+segment, Phase 1) · `references/register-extractor.md`
  (register read, Phase 1.5) · `references/bill-extractor.md` · `references/po-extractor.md` ·
  `references/grn-extractor.md` (individual docs) · `references/bundle-extractor.md` (a whole
  bundle's docs, Phase 2) · `references/matcher.md` · `references/check-rules.md` (read by the
  matcher) · `references/field-catalog.md` (read by extractors) · `references/gst-hsn-rates.csv`
  (read by the matcher).
- **GST authority:** `references/gst-hsn-rates.csv` (the bundled FY 2025-26 table).

## Success criteria
- Every register posting augmented in place with its chain basis + confidence; coverage ==
  posting count; the user's own columns untouched; `invoices_not_in_register` reported.
- **The verdict is reconciliation-driven:** the Tier-1 spine (Vendor, Total=PO, Dates-in-FY, the
  three register members, **plus `Site consistent` when the auditor opted into the site-name
  check**) decides Match/No-match; a **no-invoice posting is left blank** (not "No match").
  Over-receipt, over-billing, all sanity dates, line/rate/HSN/GST are flags that do **not** flip.
  PO-approval + buyer-stamp are **not** computed or shown (removed — too unreliable).
- The quantity flow (ordered → received → billed) renders per item on the Lines sheet, with
  **multi-GRN receipts shown one row per delivery** (Σ for the over-receipt/over-billing checks)
  and cited, and **multiple POs fanned out per invoice line** (each line names its PO#); lump-sum
  POs keep their "N/A — PO lump-sum" label and service GRNs degrade to **blank**, never faked. POs/GRNs are never fabricated from a
  reference — a missing doc is "—", a zero-load is a diagnostic.
- **Every matched, itemized posting appears on the Lines sheet WITH the full row contract** — the
  matcher reads line items under `rec["lines"]` (never `line_items`), assembles each row with the
  **given** `make_line_row`/`build_lines` (so `line_no` on invoice/PO/GRN and PO `qty_ordered` are
  always emitted — never hand-rolled per instance), and never ships `lines = []` for a match; a batch
  that trips `EMPTY_LINES_ON_MATCH` or `SCHEMA_INCOMPLETE` is **auto-re-dispatched once** before
  writeback (Phase 3d), so a scaled run (e.g. 16 bundles) shows all matched invoices' complete lines,
  not a fraction with missing columns.
- **Transparency columns:** the INVOICE band shows the invoice's own PO/PR ref
  (`PO No (on inv)`), the GRN band its referenced `PO No` + `GRN GSTIN`, and `Received Qty` is
  the **summed received quantity** (never a GRN count). There is **no Buyer-stamp column and no
  PO-Approval column** (both removed). On a **found** row, a value/check we couldn't verify shows
  **"—"** (e.g. `PO No (on inv)` / `PO# consistent` when the invoice prints no PO ref); a
  **no-invoice** row is **entirely blank** (no doc linked — blank ≠ "—"). The CHECKS tail orders
  **Qty flow → Date sanity → MATCH RESULT**; the optional **Site consistent** column appears (just
  before MATCH RESULT) only when opted in.
- **Line pairing is exact-key-first, then one bounded judgment pass** — functionally-different
  items stay apart (an elbow ≠ a bend), with **no** string-similarity tuning loop and no per-row
  hand-investigation; the matcher processes its batch in a single pass.
- Three-state cells render; failures red; **every appended invoice/PO/GRN value clicks to its
  PDF**, register figures referenced in the Reason point at their cell.
- **Idempotent / append-safe:** re-running overwrites the same bands in place (no duplicate
  bands, no shifted columns — `append_col0` persisted in `_meta`), the Lines sheet doesn't
  double, and the user's register data is never altered.
