'use strict';
/*
 * matcher.js — Two-way Invoice ↔ PO match (GST rules).
 *
 * A faithful, two-way-only reduction of the four-way purchase-match skill in
 * ../../purchase-four-way-match/references/check-rules.md. GRN, register and
 * bundle mechanics are dropped; the invoice is the anchor and we match it to one
 * or more POs.
 *
 * Design invariants carried over from the reference:
 *   - THREE STATES everywhere: 'agrees' | 'fails' | 'unverified'. Missing data is
 *     NEVER coerced to 0/false — it is 'unverified', and 'unverified' NEVER flips
 *     the verdict.
 *   - Only Tier-1 header checks (vendor / total / dates-in-FY) drive the verdict.
 *     Everything else (HSN, GST%, over-billing, rate variance, date order, line
 *     pairing) is a FLAG that is reported but never changes Match / No match.
 *   - An invoice may legitimately span several POs → we gather a LIST of matched
 *     POs and reconcile the invoice total against their SUM.
 *
 * Portable: runs unchanged in Node (require) and in an n8n Code node.
 */

// --------------------------------------------------------------------------- //
// Tolerances — verbatim from check-rules.md § "Tolerances (one place)"         //
// --------------------------------------------------------------------------- //
const round2 = (x) => Math.round((Number(x) + Number.EPSILON) * 100) / 100;
const num = (x) => (x === null || x === undefined || x === '' ? null : Number(x));

const amountsEqual = (a, b) => Math.abs(a - b) <= Math.max(1.0, 0.005 * Math.abs(b)); // ₹1 or 0.5%
const ratesEqual = (a, b) => Math.abs(round2(a) - round2(b)) <= 0.01;
const pctEqual = (a, b) => Math.abs(a - b) <= 0.0001;                                  // 0.18 == 0.18
const qtyLe = (a, b) => a <= b + 1e-9;                                                 // directional

// --------------------------------------------------------------------------- //
// HSN/SAC → GST% master (bundled from the reference gst-hsn-rates.csv).         //
// A caller may pass an override map via opts.rateTable.                         //
// --------------------------------------------------------------------------- //
const DEFAULT_RATE_TABLE = {
  '3808': 18, '8516': 18, '85161000': 18, '9405': 18, '996609': 18,
  '3917': 18, '3925': 18, '8481': 18, '7307': 18, '3922': 18,
  '9954': 18, '995469': 18, '9985': 18, '998533': 18, '9987': 18,
  '99871': 18, '998311': 18, '9983': 18, '9401': 18, '9403': 18,
  '9404': 18, '4418': 18, '8302': 18, '4819': 18, '9405XX': 18,
  '6307': 12, '5208': 5,
};

// --------------------------------------------------------------------------- //
// small helpers                                                                //
// --------------------------------------------------------------------------- //
const normGstin = (g) => (g ? String(g).toUpperCase().replace(/\s+/g, '') : '');
const gstinEqual = (a, b) => {
  const x = normGstin(a), y = normGstin(b);
  return x && y ? x === y : null; // null == "can't tell" (one missing)
};

const normName = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\b(private|pvt|limited|ltd|llp|inc|co|company|and|the)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// normalise a PO/PR number for comparison: "PR 2390" ~ "PR2390" ~ "pr-2390"
const normRef = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

const inFY = (d, fyStart, fyEnd) => d >= fyStart && d <= fyEnd;

const SYNONYMS = [['elbow', 'bend']];
const STOP = new Set(['mm', 'inch', 'in', 'approx', 'approximately', 'set', 'sets',
  'pcs', 'pc', 'nos', 'no', 'of', 'the', 'for', 'and', 'with', 'x', 'size', 'grade']);
function normDesc(s) {
  let t = String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ');
  for (const [a, b] of SYNONYMS) t = t.replace(new RegExp('\\b' + b + '\\b', 'g'), a);
  const toks = t.split(/\s+/).filter((w) => w && !STOP.has(w));
  return toks.join(' ').trim();
}
function sameProduct(a, b) {
  const na = normDesc(a), nb = normDesc(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  const A = new Set(na.split(' ')), B = new Set(nb.split(' '));
  let inter = 0;
  for (const w of A) if (B.has(w)) inter += 1;
  const jac = inter / (A.size + B.size - inter);
  return jac >= 0.6;
}

// --------------------------------------------------------------------------- //
// 1. Match ladder (Hop 2) — gather ALL matching POs into matched_pos           //
// --------------------------------------------------------------------------- //
function buildLadder(invoice, pos) {
  const refs = (invoice.references || []).filter((r) => r.kind === 'buyer_pr_po');
  const refVals = refs.map((r) => normRef(r.value));
  const handwritten = refs.some((r) => r.handwritten);

  // Rung 1 — explicit PR/PO reference
  const rung1 = pos.filter((po) =>
    refVals.includes(normRef(po.po_number)) || refVals.includes(normRef(po.pr_number)));
  if (rung1.length) {
    return {
      matched: rung1,
      basis: handwritten ? 'PR/PO (handwritten, review)' : 'PR/PO number',
      confidence: handwritten ? 'medium' : 'high',
      rung: 1,
    };
  }

  // Rung 2 — fingerprint: GSTIN + total
  const rung2 = pos.filter((po) =>
    gstinEqual(invoice.vendor_gstin, po.vendor_gstin) === true &&
    invoice.total != null && po.total != null &&
    amountsEqual(invoice.total, po.total));
  if (rung2.length) {
    return { matched: rung2, basis: 'GSTIN + total', confidence: 'medium', rung: 2 };
  }

  // Rung 3 — GSTIN matches but total off (tentative; total check will fail)
  const rung3 = pos.filter((po) => gstinEqual(invoice.vendor_gstin, po.vendor_gstin) === true);
  if (rung3.length) {
    return { matched: rung3, basis: 'possible match (GSTIN only)', confidence: 'low', rung: 3 };
  }

  // Rung 4 — nothing ties (does NOT force No-match)
  return { matched: [], basis: 'No PO found', confidence: 'none', rung: 4 };
}

// --------------------------------------------------------------------------- //
// 2. Line pairing (Tier 4)                                                     //
// --------------------------------------------------------------------------- //
function pairLines(invLines, poLines) {
  const paired = new Map();       // invoice line_no -> po line ref
  const usedPo = new Set();

  const poKey = (l) => (l.hsn_sac ? String(l.hsn_sac) : '') + '|' + normDesc(l.description);

  // (1) exact key: identical normalised description OR exact HSN
  for (const il of invLines) {
    for (const pl of poLines) {
      if (usedPo.has(pl._ref)) continue;
      const exactHsn = il.hsn_sac && pl.hsn_sac && String(il.hsn_sac) === String(pl.hsn_sac);
      if (normDesc(il.description) === normDesc(pl.description) || exactHsn) {
        paired.set(il.line_no, pl); usedPo.add(pl._ref); break;
      }
    }
  }
  // (2) same-product judgment for the rest
  for (const il of invLines) {
    if (paired.has(il.line_no)) continue;
    for (const pl of poLines) {
      if (usedPo.has(pl._ref)) continue;
      if (sameProduct(il.description, pl.description)) {
        paired.set(il.line_no, pl); usedPo.add(pl._ref); break;
      }
    }
  }
  // (3) 1-to-1 elimination fallback
  const leftInv = invLines.filter((il) => !paired.has(il.line_no));
  const leftPo = poLines.filter((pl) => !usedPo.has(pl._ref));
  if (leftInv.length && leftInv.length === leftPo.length && leftInv.length <= 3) {
    leftInv.forEach((il, i) => { paired.set(il.line_no, leftPo[i]); usedPo.add(leftPo[i]._ref); });
  }
  return { paired, usedPo };
}

// --------------------------------------------------------------------------- //
// main                                                                         //
// --------------------------------------------------------------------------- //
function runMatch(input, opts = {}) {
  const invoice = input.invoice || {};
  const pos = input.pos || (input.po ? [input.po] : []);
  const fyStart = opts.fy_start || '2025-04-01';
  const fyEnd = opts.fy_end || '2026-03-31';
  const rateTable = opts.rateTable || DEFAULT_RATE_TABLE;
  const flags = [];

  // ---- ladder ---------------------------------------------------------- //
  const ladder = buildLadder(invoice, pos);
  const matched = ladder.matched;
  const poTotalSum = matched.reduce((s, p) => s + (num(p.total) || 0), 0);
  const isLumpSum = matched.length === 1 && matched[0].po_itemized === false;

  if (ladder.rung === 4) flags.push('No PO matched (PO checks unverified)');
  if (ladder.rung === 3) flags.push('Possible match only (GSTIN, total off)');
  if (ladder.confidence === 'medium' && ladder.basis.includes('handwritten'))
    flags.push('PR/PO reference is handwritten — review');
  if (matched.length > 1) flags.push(`Invoice spans ${matched.length} POs (total vs Σ POs)`);
  if (isLumpSum) flags.push('PO is lump-sum — per-line checks N/A');

  // ---- Tier 1 header checks (verdict-driving) -------------------------- //
  const checks = {};

  // vendor_match
  if (!matched.length) {
    checks.vendor_match = 'unverified';
  } else {
    let verdict = 'agrees';
    for (const po of matched) {
      const g = gstinEqual(invoice.vendor_gstin, po.vendor_gstin);
      if (g === true) continue;
      if (g === false) { verdict = 'fails'; break; }
      // GSTIN missing → fall back to normalized name
      if (invoice.vendor_name && po.vendor_name) {
        if (normName(invoice.vendor_name) !== normName(po.vendor_name)) { verdict = 'fails'; break; }
      } else { verdict = 'unverified'; }
    }
    checks.vendor_match = verdict;
  }

  // total_match
  if (!matched.length || invoice.total == null) {
    checks.total_match = 'unverified';
  } else {
    checks.total_match = amountsEqual(num(invoice.total), poTotalSum) ? 'agrees' : 'fails';
  }

  // dates_fy
  const dates = [];
  if (invoice.invoice_date) dates.push(['invoice', invoice.invoice_date]);
  for (const po of matched) if (po.requisition_date) dates.push([`PO ${po.po_number}`, po.requisition_date]);
  const outside = dates.find(([, d]) => !inFY(d, fyStart, fyEnd));
  const needMissing = !invoice.invoice_date || matched.some((p) => !p.requisition_date);
  if (outside) checks.dates_fy = 'fails';
  else if (needMissing) checks.dates_fy = 'unverified';
  else checks.dates_fy = 'agrees';

  // ---- verdict --------------------------------------------------------- //
  const headerFails =
    checks.vendor_match === 'fails' ||
    checks.total_match === 'fails' ||
    checks.dates_fy === 'fails';
  const result = !invoice.invoice_number && !invoice.total ? '' : headerFails ? 'No match' : 'Match';

  // ---- po_num_consistent (flag) --------------------------------------- //
  const invRefs = (invoice.references || []).filter((r) => r.kind === 'buyer_pr_po');
  if (!matched.length || invRefs.length === 0) {
    checks.po_num_consistent = 'unverified';
  } else {
    const matchedRefs = new Set();
    matched.forEach((p) => { matchedRefs.add(normRef(p.po_number)); matchedRefs.add(normRef(p.pr_number)); });
    const stray = invRefs.find((r) => !matchedRefs.has(normRef(r.value)));
    checks.po_num_consistent = stray ? 'fails' : 'agrees';
    if (stray) flags.push(`Invoice cites PR/PO ${stray.value} that matches no PO`);
  }

  // ---- date_order (flag, hard red) ------------------------------------ //
  const latestPoDate = matched.map((p) => p.requisition_date).filter(Boolean).sort().pop();
  if (invoice.invoice_date && latestPoDate) {
    checks.date_order = invoice.invoice_date >= latestPoDate ? 'agrees' : 'fails';
    if (checks.date_order === 'fails')
      flags.push(`Invoice dated ${invoice.invoice_date} is BEFORE PO ${latestPoDate}`);
  } else {
    checks.date_order = 'unverified';
  }

  // ---- Tier 2/3/4 per-line ------------------------------------------- //
  const poLines = [];
  matched.forEach((po, pi) =>
    (po.lines || []).forEach((l, li) => poLines.push({ ...l, _ref: `${pi}:${li}`, _po: po.po_number })));
  const invLines = invoice.lines || [];
  const { paired } = isLumpSum ? { paired: new Map() } : pairLines(invLines, poLines);

  let overBilled = 0, rateVar = 0, hsnBad = 0, gstBad = 0, billOnly = 0;
  const lines = invLines.map((il) => {
    const pl = paired.get(il.line_no);

    // Tier 2 — HSN validity + GST correctness (always runs, even lump-sum)
    const hsn = il.hsn_sac ? String(il.hsn_sac).replace(/\s+/g, '') : '';
    let hsn_valid = 'unverified';
    if (hsn) {
      const okLen = [4, 6, 8].includes(hsn.length) && /^[0-9]+$/.test(hsn);
      const sacOk = hsn.length === 6 && hsn.startsWith('99');
      hsn_valid = okLen || sacOk ? 'agrees' : 'fails';
      if (hsn_valid === 'fails') hsnBad += 1;
    }
    let gst_correct = 'unverified';
    if (hsn && rateTable[hsn] != null && il.gst_rate != null) {
      gst_correct = pctEqual(num(il.gst_rate), rateTable[hsn] / 100) ? 'agrees' : 'fails';
      if (gst_correct === 'fails') gstBad += 1;
    }

    // Tier 3/4 — pairing-dependent
    let line_match, rate_match, qty_flag;
    if (isLumpSum) {
      line_match = 'N/A — PO lump-sum'; rate_match = 'unverified'; qty_flag = 'N/A — PO lump-sum';
    } else if (pl) {
      line_match = 'agrees';
      rate_match = pl.unit_price != null && il.rate != null
        ? (ratesEqual(num(il.rate), num(pl.unit_price)) ? 'agrees' : 'fails')
        : 'unverified';
      if (rate_match === 'fails') rateVar += 1;
      if (il.quantity != null && pl.quantity != null) {
        qty_flag = qtyLe(num(il.quantity), num(pl.quantity)) ? 'agrees' : 'fails';
        if (qty_flag === 'fails') overBilled += 1;
      } else qty_flag = 'unverified';
    } else {
      line_match = matched.length ? 'fails' : 'unverified'; // extra billed line not on any PO
      rate_match = 'unverified'; qty_flag = 'unverified';
      if (matched.length) billOnly += 1;
    }

    return {
      line_no: il.line_no, description: il.description, hsn_sac: il.hsn_sac || '',
      quantity: il.quantity ?? '', unit: il.unit || '', rate: il.rate ?? '',
      gst_rate: il.gst_rate ?? '', amount: il.amount ?? '',
      paired_po_line: pl ? `${pl._po}#${pl.line_no}` : '', po_qty: pl ? (pl.quantity ?? '') : '',
      po_unit_price: pl ? (pl.unit_price ?? '') : '',
      line_match, rate_match, qty_flag, hsn_valid, gst_correct,
    };
  });

  // PO-only lines (ordered but not billed) — informational
  const poOnly = poLines.filter((pl) => ![...paired.values()].some((p) => p._ref === pl._ref));

  if (overBilled) flags.push(`Over-billed ${overBilled} line item(s) (billed > ordered)`);
  if (rateVar) flags.push(`Rate variance on ${rateVar} line(s)`);
  if (hsnBad) flags.push(`Invalid HSN/SAC on ${hsnBad} line(s)`);
  if (gstBad) flags.push(`GST% mismatch on ${gstBad} line(s)`);
  if (billOnly) flags.push(`${billOnly} billed line(s) not on any PO`);
  if (!isLumpSum && poOnly.length) flags.push(`${poOnly.length} ordered line(s) not billed`);

  // ---- duplicate detection (optional ledger of prior invoices) -------- //
  if (opts.ledger && opts.ledger.length) {
    for (const e of opts.ledger) {
      const sameVendor = gstinEqual(invoice.vendor_gstin, e.vendor_gstin) === true;
      if (sameVendor && e.invoice_number && invoice.invoice_number &&
          normRef(e.invoice_number) === normRef(invoice.invoice_number)) {
        flags.push(`EXACT DUPLICATE of already-processed invoice ${e.invoice_number}`);
      } else if (sameVendor && e.total != null && invoice.total != null &&
                 amountsEqual(num(invoice.total), num(e.total)) && e.invoice_date === invoice.invoice_date) {
        flags.push(`Possible duplicate: same vendor/amount/date as ${e.invoice_number} (diff number)`);
      }
    }
  }

  // ---- reason (only on No match) -------------------------------------- //
  let reason = '';
  if (result === 'No match') {
    const parts = [];
    if (checks.vendor_match === 'fails') parts.push('Invoice/PO vendor mismatch');
    if (checks.total_match === 'fails') {
      const d = round2(num(invoice.total) - poTotalSum);
      parts.push(`Invoice ${invoice.total} vs PO ${round2(poTotalSum)} (diff ${d})`);
    }
    if (checks.dates_fy === 'fails' && outside)
      parts.push(`${outside[0]} date ${outside[1]} outside FY ${fyStart}–${fyEnd}`);
    reason = parts.join('; ');
  }

  return {
    header: {
      invoice_number: invoice.invoice_number || '',
      invoice_date: invoice.invoice_date || '',
      vendor_name: invoice.vendor_name || '',
      vendor_gstin: invoice.vendor_gstin || '',
      invoice_total: invoice.total ?? '',
      matched_po_numbers: matched.map((p) => p.po_number).join(', ') +
        (matched.length > 1 ? ` (${matched.length})` : ''),
      po_total_sum: round2(poTotalSum),
      result,
      vendor_match: checks.vendor_match,
      total_match: checks.total_match,
      dates_fy: checks.dates_fy,
      po_num_consistent: checks.po_num_consistent,
      date_order: checks.date_order,
      match_basis: ladder.basis,
      confidence: ladder.confidence,
      flags,
      reason,
    },
    lines,
  };
}

// ---- n8n Code-node entrypoint (safe no-op under Node) --------------------- //
if (typeof $input !== 'undefined') {
  const payload = $input.first().json;                          // { invoice, pos|po, opts? }
  const out = runMatch(payload, payload.opts || {});
  return [{ json: out }];                                       // eslint-disable-line
}

// ---- Node export (safe no-op inside n8n) ---------------------------------- //
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { runMatch, amountsEqual, ratesEqual, pctEqual, qtyLe, DEFAULT_RATE_TABLE };
}
