---
name: purchase-invoice-vouching-v3
description: >
  Vouches vendor tax-invoices against their purchase orders for a buyer, then
  writes a two-sheet exception workpaper into the open workbook — every value
  clickable back to its source PDF. Matches each invoice to its PO by PR/PO
  number (printed or handwritten) or, failing that, by a vendor-GSTIN + total
  fingerprint, then by a vendor-name + total fingerprint; runs a three-tier check
  battery (reconciliation spine, per-line
  invoice compliance, conditional per-unit rate match). Use when the user asks
  to vouch / verify / reconcile purchase invoices against POs, or attaches a
  batch of vendor bills with their POs. Do NOT use for plain invoice
  digitisation with no PO — that is invoice-extraction-v5. Reports findings
  only; never approves anything for payment.
---

# Purchase-Invoice Vouching v3 → exception workpaper

You orchestrate purchase-invoice vouching on the open workbook. For each vendor
invoice: match it to its PO, run a fixed three-tier check battery, and surface
findings — every compared value a click-to-source citation, every verdict one of
three states (**✓ agrees · ✗ fails · — couldn't verify**). Pipeline:

**extract → match (ladder) → check (3 tiers) → write back.**

Output: two linked sheets, both **data-first** — a bill-level **Overview** (one row
per invoice, columns banded **BILL → PURCHASE ORDER → CHECKS**, headline verdict
**"Match" / "No match"**) and a **Lines** sheet (every bill line beside its matched
PO line). You **report findings; you never approve for payment.**

The skill is vendor- and buyer-agnostic. The buyer (whose stamp the invoices must
carry) is **detected from the POs** — every PO in a batch is raised by the same
buyer; take that buyer's name + GSTIN from the PO header. Never hardcode a buyer,
vendor, HSN, or rate.

## Design spine — enumerate → structure → judge

- **Enumerate** (deterministic): every **invoice** = each attachment classified
  `invoice`; every **line** = each printed line row. The attachment-ID set is the
  coverage ground truth — no invoice drops before the workpaper.
- **Structure** (extraction + citations): borrow `invoice-extraction-v5`'s cascade
  + gate; each field carries `{value, page, source_text}`.
- **Judge** (narrowest question per unit): the match ladder + the three tiers.
  Most checks are deterministic comparisons in `container_python`; only the
  fingerprint tie-break, the handwritten-PR read, and the buyer-stamp read need a
  narrow LLM / `read_image`.

## Two governing rules

### A. User-facing language hides internals
Auditors care about findings, not tooling. Never say `pdf_agent`, `index.json`,
`content.md`, `read_image`, `generate_code`, `operationsFilePath`, `--cite-pdf`, or
"sub-agent" in chat. A scanned/handwritten invoice is an "image-based invoice".

### B. Every question uses `ask_clarification`
Start/skip, the FY window, the GST rate source — via `ask_clarification`, never
inline chat. Message is *only* attachments → first action is `ask_clarification`.
Files are not consent.

## Orchestrator vs sub-agents — who reads what

You are the **orchestrator**. The extractor and voucher playbooks under
`references/` are for fresh sub-agents — **do not open them yourself** (reading
them loads sub-agent instructions and drags document text into your context). For
each fan-out phase you **`spawn_subagent`** a `general_purpose` agent and tell it,
in its task text, to read its own playbook first. The only reference file **you**
read is `references/writeback.md` (your Phase 4 job).

```
spawn_subagent(agent_id="general_purpose", name="Extract invoices 1–6",
  description="Extract a batch of vendor invoices for vouching",
  task="Read your playbook at /home/sandbox/skills/purchase-invoice-vouching-v3/references/bill-extractor.md via container_bash, then follow it. Inputs: file_stems=[…this batch…], start_rung='content_md'. Write output to /home/sandbox/outputs/pv3-bill-extract-0.json.")
```

## Quick checklist

```
[ ] Phase 0 — Proactive? ask_clarification first. Collect FY window + GST source. Detect the buyer from a PO.
[ ] Phase 1 — inventory attachments; classify each by CONTENT into invoice | po | other; reconcile coverage.
[ ] Phase 2 — spawn extractors (they read their own playbooks): invoice (borrows v5) + po → one JSON each.
[ ] Phase 3 — spawn one voucher per invoice-batch (reads voucher.md + check-rules.md): match ladder + 3 tiers → findings.
[ ] Phase 3d — coverage reconcile: every invoice has exactly one findings record. Else re-dispatch / hard-stop.
[ ] Phase 4 — write Lines sheet, then banded Overview, with cross-links. Verify. Report findings.
```

## Phase 0 — Confirm + parameters

Strip `<context file="…"/>` tags from the latest message. Empty residue or no
vouching verb → **proactive**: first action is `ask_clarification` ("I see N
vendor invoices with purchase orders — shall I vouch them and build an exception
workpaper?", 2-3 filenames). Settle: **FY window** (default 2025-04-01 …
2026-03-31) and **GST rate source** (bundled `references/gst-hsn-rates.csv`, or
the user's attached rate master). **Yes** → Phase 1. **No** → stand down.

## Phase 1 — Classify by content, not filename

- **1a inventory** (deterministic): one `container_python` pass over
  `/home/sandbox/attachments/*/index.json` → `{id, filename, page_count,
  total_chars}` = coverage ground truth. `total_chars` is only a rung **hint**:
  `≈0` (scanned) → `start_rung="content_md"` (content.md holds the OCR — **never
  pass "image"**); `>0` → may pass `"index_text"`. There is no "image" rung;
  `read_image` is an internal last resort the extractor uses for fields content.md
  misses and for the stamp.
  - **Attachment paths.** A `<stem>` is the **hashed** attachment name (e.g.
    `4643-d359`). `content.md`/`index.json` live in the folder
    `/home/sandbox/attachments/<stem>/`; the raw PDF (for `read_image`) is the file
    `/home/sandbox/attachments/<stem>.pdf`. Pass the hashed `<stem>` as `file_stems`.
- **1b classify**: read each doc's head and assign `doc_type`:
  - `po` — "Purchase Order", a vendor block + a Level-1/2 **approval status**
    table, a buyer header (the recurring entity across the batch).
  - `invoice` — "Tax Invoice", a vendor→buyer bill that **charges** tax (CGST/
    SGST/IGST) with a total due.
  - `other` — neither.
  Small batch (≤15) classify directly; large batch fan out a classifier shard.
- **1c coverage reconcile**: every attachment lands in exactly one bucket; missing
  → one targeted re-classify, then hard-stop with the list.
- **Detect the buyer**: from any PO header, capture buyer name + GSTIN (the same
  across the batch). This identity drives the Tier-1 stamp check.

## Phase 2 — Extract (fan-out, parallel)

| Bucket | Playbook | Output |
|---|---|---|
| `invoice` | `references/bill-extractor.md` (borrows v5; line items always in scope; capture PR/PO printed+handwritten, GSTIN, buyer-stamp-present) | `pv3-bill-extract-<k>.json` |
| `po` | `references/po-extractor.md` (PR/PO, GSTIN, both dates, approval status, lines + itemized/lump flag) | `pv3-po-extract-<k>.json` |

Shard ~10/batch, spawn in parallel, load returned JSON with `container_python`.

## Phase 3 — Match + check (fan-out, parallel)

For each invoice-batch, `spawn_subagent` one **voucher** (`general_purpose`); it
reads `references/voucher.md` (and the `check-rules.md` it points to) — you don't
read them. Pass, in the task text: this batch's invoice-extract path(s), **all**
PO-extract paths (any invoice may fingerprint-match any PO), the FY window, the
GST source path, and the detected buyer {name, gstin}. It:

1. **Matches** each invoice to a PO via the ladder (rules §1) — PR/PO number
   (printed/handwritten) → GSTIN+total fingerprint → name+total fingerprint → possible
   → none — recording a **match basis + confidence**; **ignores vendor-printed PO numbers**.
2. Runs the **three tiers** (rules §2): Tier-1 reconciliation spine, Tier-2 per-line
   invoice compliance, Tier-3 conditional per-unit rate match (only when the PO
   itemizes).
3. Emits one findings record per invoice — every compared value with its citation
   coordinates, every verdict a three-state (`agrees`/`fails`/`unverified`), a
   **header-driven Match result** ("Match"/"No match" — only the Tier-1 spine flips it;
   date-order, line/rate/HSN/GST are flags that never flip), the match
   basis+confidence, the PO type (itemized/lump-sum), the `line_items_summary` flag
   ("N/A — PO lump-sum" for a lump-sum PO), a `flag_note` summarising the per-line flags,
   and a one-line `reason` (only when "No match").

Output: `pv3-findings-<batch>.json`. `status` always `ok`; problems in `diagnostics[]`.

## Phase 3d — Coverage reconcile

Every enumerated invoice ID has exactly one findings record. Shortfall → one
re-dispatch, then hard-stop with the list.

## Phase 4 — Write back (orchestrator only)

Read all `pv3-findings-*.json`, then follow **`references/writeback.md`**:
**detect-or-create** the two sheets (`execute_excel_code`) — if they already exist (a
prior batch), **keep them and append below** the last used row; never recreate. Read
the existing keys (`read_range`) and **skip any invoice already on the Overview** (same
Vendor GSTIN + Bill No) so re-running a batch is a no-op. Then in **one
`container_python` pass build the full DSL for each sheet** (Lines first — record each
invoice's start row — then the banded data-first **Overview**, sorted **No-match-first**
within the run, each row linking into its Lines block) and **write one ops JSON per
sheet** to `/home/sandbox/outputs/` with keys `{operations, sheet, boundingRange,
summary}`. **Apply each with `generate_code` via `operationsFilePath`** — Lines, then
Overview. No chunking, no op cap; `--cite-pdf` is preserved through the JSON. Verify
with one `read_range`. Sheets **accumulate across batched runs** (e.g. 50 pairs × 6);
to redo a batch, clear the two sheets first.

## Tool discipline

| Operation | Tool |
|---|---|
| Attachment inventory / read sub-agent JSONs | `container_python` (`json.load`) |
| Read a playbook / the GST table | `container_bash cat` |
| Classify / extract / read handwriting + stamps | sub-agents over index.json + content.md; `read_image` |
| Match ladder, fingerprint, all tier comparisons | `container_python` (inside the voucher) |
| Detect-or-create the two sheets (append across runs) | `execute_excel_code` (create-if-missing; read used-range extent) |
| Build the full DSL for each sheet → write one ops JSON to `/home/sandbox/outputs/` | `container_python` |
| Apply a sheet's ops JSON (cells, formats, `=HYPERLINK`, `--cite-pdf`) | `generate_code` with `operationsFilePath` (no chunking) |
| Read existing keys (dedup, append runs) + verify the written sheets | `read_range` |

**Banned, with reason:** never mutate cells directly via `execute_excel_code`/
`container_python` (cells are applied only by `generate_code` from the ops JSON, which
preserves `--cite-pdf`); never hardcode a buyer/vendor/HSN/rate — the buyer is
detected from the PO, GST rates live in the CSV.

## Hard rules

- **Match basis vs Match result are independent.** A fingerprint-matched invoice can
  be a "Match"; a PR-matched invoice can be a "No match". Show both — and the basis
  must name the rung that fired (GSTIN fingerprint → "GSTIN + total"; name fingerprint →
  "Name + total").
- **Match result = "Match" / "No match"** (no "flag" wording), decided by the
  **header (Tier-1) checks only** — Total=PO · Vendor GSTIN · PO approved · Buyer
  stamp · Dates in FY (or an unresolved match). **Line match, rate match, HSN
  validity and GST correctness are flags that NEVER flip the verdict**; date-order ✗
  renders red but never flips. An invoice whose header reconciles is a Match.
- **Vendor identity = the seller's GSTIN, not the name** (legal-suffix/spelling vary);
  an invoice prints the buyer's GSTIN too — use the **seller-block** one. Ignore
  vendor-printed PO numbers; match on the buyer's PR/PO, the GSTIN+total fingerprint, or
  the name+total fingerprint.
- **Buyer stamp = the client's stamp** (Bill-To party), not a vendor seal.
- **HSN valid + GST correct are invoice-level — checked + flagged on EVERY invoice
  line** (lump-sum or itemized); they're about the invoice, not the PO. **Line match +
  rate match are PO-relationship — only where the PO itemizes** (more than one line, or
  a single line with qty > 1 and a per-unit price; a single line with qty 1.00 is
  lump-sum even if a Unit Price is printed). **PO lump-sum → show the PO lump line** (labelled "Line items
  not matched — PO lump sum") **plus each invoice line with its HSN/GST flags**; skip
  only the matching, never the HSN/GST checks. Never fake a line match.
- **Three states, always:** ✓ agrees, ✗ fails, **—** couldn't verify (e.g. invoice
  has no HSN, handwriting unreadable). Never force a missing value into a pass/fail.
- A reference exists only where a value exists in a document → `--cite-pdf`; a rule
  (correct GST %, FY window) → plain text; an absent value → "Not found"/"—", no link.
- Report findings only. Do **not** approve anything for payment.

## Reference files

- **You read only:** [references/writeback.md](references/writeback.md)
- **Sub-agent playbooks — do NOT open; spawn the sub-agent to read its own:**
  `references/bill-extractor.md` · `references/po-extractor.md` · `references/voucher.md`
  · `references/check-rules.md` (read by the voucher) · `references/field-catalog.md`
  (read by extractors) · `references/gst-hsn-rates.csv` (read by the voucher) ·
  `references/examples.md` (orientation)
- **GST authority:** `references/gst-hsn-rates.csv` (the bundled FY 2025-26 table). A
  larger goods-HSN master may be wired in (lookup-only) in a future GST round — it is
  **not** bundled in the skill until it is actually used.

## Success criteria

- Every invoice on the Overview with a correct match basis + confidence (the rung that
  fired); coverage == count; sorted No-match-first.
- **The verdict is header-driven:** Tier-1 spine (total=PO, vendor (seller) GSTIN,
  approval, client stamp, FY) decides Match/No-match. Date-order is a hard red ✗ that
  does **not** flip; line/rate/HSN/GST are flags that do **not** flip.
- Tier-2 per line (**every invoice**, lump-sum or itemized): HSN structural validity +
  GST correctness shown as flags — "—" where HSN is absent. **No footing / no CGST=SGST
  split** (dropped in v3).
- Tier-3 line/rate matching runs only where the PO itemizes; **lump-sum POs show the
  PO lump line** (Line match "Line items not matched — PO lump sum") **plus each
  invoice line with its HSN/GST flags** — Tier-2 is never skipped.
- Overview headline reads **"Match" / "No match"**; the PO band carries a **PO Type**
  (itemized/lump-sum) column; the **Line items check** flag column reads
  **"N/A — PO lump-sum"** for lump-sum POs; the **Reason** column surfaces any per-line
  flag (e.g. invalid HSN) **even on a Match**.
- Three-state cells render; failures red; **every raw bill AND PO value clicks to its
  own PDF** (no blank PO cell on a matched line).
- **Idempotent / append-safe:** re-running a batch adds nothing (invoices already on the
  Overview — same Vendor GSTIN + Bill No — are skipped); a new batch appends below
  without disturbing prior rows or duplicating the header.
