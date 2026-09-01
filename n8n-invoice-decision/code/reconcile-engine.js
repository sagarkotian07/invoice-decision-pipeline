'use strict';
/*
 * reconcile-engine.js — two-way Invoice ↔ PO reconciliation over a BATCH of
 * uploaded documents. Single source of truth: the local tests require it, and
 * build_reconcile.js embeds it verbatim into every n8n Code node.
 *
 * Model: the user uploads many PDFs (a mix of invoices and POs). Claude only
 * CLASSIFIES + READS each PDF (perception). Everything below is deterministic:
 *   - match each invoice to its PO (by cited PO number, else vendor+amount),
 *   - report the gaps on BOTH sides (invoice with no PO; PO with no invoice),
 *   - give each matched pair a reasoned amount verdict.
 * The LLM never decides. Money is integer CENTS (never float). The vendor
 * similarity uses a faithful difflib.SequenceMatcher.ratio() port.
 */

// ===== config (all money in cents) ========================================= //
var CONFIG = {
  AUTO_TOLERANCE_PCT: 0.02, AUTO_TOLERANCE_ABS: 10000,   // ±2% or ±$100 → clean match
  APPROVER_BAND_PCT: 0.10, APPROVER_BAND_ABS: 250000,    // ±10% or ±$2,500 → variance (sign-off)
  VENDOR_FUZZY_THRESHOLD: 0.82,
  MIN_DOC_CONFIDENCE: 0.6,   // below this we treat the read as unreliable
  NEAR_DUP_AMOUNT_TOLERANCE: 1,
  RATE_EQ_TOLERANCE: 1,      // per-unit rate equal within 1 cent (line-item check)
};

var SEV = { OK: 0, INFO: 1, WARN: 2, HOLD: 3, REVIEW: 4, REJECT: 5 };
var SEV_NAME = ['OK', 'INFO', 'WARN', 'HOLD', 'REVIEW', 'REJECT'];
function F(code, sev, message, evidence) { return { code: code, sev: sev, severity: SEV_NAME[sev], message: message, evidence: evidence || {} }; }

// ===== money ================================================================ //
function toCents(text) {
  if (text === null || text === undefined || text === '') return null;
  var s = String(text).trim();
  if (!s) return null;
  var negative = s.charAt(0) === '(' && s.charAt(s.length - 1) === ')';
  s = s.replace(/^\(|\)$/g, '').replace(/(?:usd|eur|gbp|inr|rs)/gi, '').replace(/[$€£₹]/g, '').replace(/[^0-9.,\-]/g, '');
  if (!s) return null;
  if (s.indexOf(',') !== -1 && s.indexOf('.') !== -1) s = s.replace(/,/g, '');
  else if (s.indexOf(',') !== -1) s = /^\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, '') : s.replace(/,/g, '.');
  if (s === '' || s === '-' || s === '.') return null;
  var v = Number(s);
  if (!isFinite(v)) return null;
  var c = Math.round(v * 100);
  return negative ? -c : c;
}
function money(cents) {
  if (cents === null || cents === undefined) return '—';
  var neg = cents < 0, abs = Math.abs(cents);
  var d = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-$' : '$') + d + '.' + String(abs % 100).padStart(2, '0');
}
function absCents(c) { return c < 0 ? -c : c; }
function autoTol(cents) { return Math.max(Math.round(cents * CONFIG.AUTO_TOLERANCE_PCT), CONFIG.AUTO_TOLERANCE_ABS); }
function approverBand(cents) { return Math.max(Math.round(cents * CONFIG.APPROVER_BAND_PCT), CONFIG.APPROVER_BAND_ABS); }

// ===== dates ================================================================ //
var MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
function parseDate(text) {
  if (!text) return null;
  var s = String(text).trim(), m;
  if ((m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/))) return iso(+m[1], +m[2], +m[3]);
  if ((m = s.match(/^(\d{1,2})[ -]([A-Za-z]{3,})[ -,]+(\d{4})$/)) && MONTHS[m[2].slice(0, 3).toLowerCase()]) return iso(+m[3], MONTHS[m[2].slice(0, 3).toLowerCase()], +m[1]);
  if ((m = s.match(/^([A-Za-z]{3,})[ ]+(\d{1,2}),?[ ]+(\d{4})$/)) && MONTHS[m[1].slice(0, 3).toLowerCase()]) return iso(+m[3], MONTHS[m[1].slice(0, 3).toLowerCase()], +m[2]);
  if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/))) { var a = +m[1], b = +m[2], y = +m[3]; if (a > 12 && b <= 12) return iso(y, b, a); if (b > 12 && a <= 12) return iso(y, a, b); return iso(y, b, a); }
  return null;
}
function iso(y, mo, d) { return (mo < 1 || mo > 12 || d < 1 || d > 31) ? null : y + '-' + String(mo).padStart(2, '0') + '-' + String(d).padStart(2, '0'); }

// ===== fuzzy ratio (difflib.SequenceMatcher.ratio port) ===================== //
function longestMatch(a, b) {
  var b2j = {}; for (var j = 0; j < b.length; j++) (b2j[b[j]] = b2j[b[j]] || []).push(j);
  var bi = 0, bj = 0, bs = 0, j2 = {};
  for (var i = 0; i < a.length; i++) { var nj = {}, js = b2j[a[i]] || []; for (var x = 0; x < js.length; x++) { var jj = js[x], k = (j2[jj - 1] || 0) + 1; nj[jj] = k; if (k > bs) { bi = i - k + 1; bj = jj - k + 1; bs = k; } } j2 = nj; }
  return { a: bi, b: bj, size: bs };
}
function mbTotal(a, b) { var lm = longestMatch(a, b), t = lm.size; if (lm.size > 0) { t += mbTotal(a.slice(0, lm.a), b.slice(0, lm.b)); t += mbTotal(a.slice(lm.a + lm.size), b.slice(lm.b + lm.size)); } return t; }
function ratio(a, b) { var T = (a || '').length + (b || '').length; return T === 0 ? 1 : (2 * mbTotal(a, b)) / T; }
function normName(name) {
  var s = String(name || '').toLowerCase().trim();
  ['﻿', ',', '.', '  '].forEach(function (junk) { s = s.split(junk).join(' '); });
  [' inc', ' incorporated', ' llc', ' ltd', ' limited', ' corp', ' corporation', ' co', ' company', ' gmbh'].forEach(function (suf) { if (s.endsWith(suf)) s = s.slice(0, -suf.length); });
  return s.split(/\s+/).filter(Boolean).join(' ');
}

// ===== PO / PR number + GSTIN helpers ======================================= //
// Accept buyer PR or PO refs; normalize to a digit-core key so "PO-1001",
// "PO1001", "PR 2390" collapse consistently on both the invoice and the PO.
function cleanPO(raw) { if (!raw) return null; var m = String(raw).match(/(P[OR][-\s]?\d+|\d{3,})/i); if (!m) return null; var v = m[1].toUpperCase().replace(/\s/g, ''); return /^P[OR]/.test(v) ? v.replace(/^(P[OR])-?/, '$1-') : 'PO-' + v; }
function poKey(n) { return n ? String(n).toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^P[OR]/, '') : ''; }
function gstinKey(g) { return g ? String(g).toUpperCase().replace(/[^A-Z0-9]/g, '') : ''; }
// Fingerprint total tie: ₹1-equivalent or 0.5% round-off (from the skill). Exact-ish, not the wide approver band.
function amountsEqual(a, b) { if (a === null || b === null) return false; return absCents(a - b) <= Math.max(1, Math.round(0.005 * Math.abs(b))); }

// ===== helpers ============================================================== //
function num(x) { var n = Number(x); return isFinite(n) ? n : 0; }
function round3(x) { return Math.round(x * 1000) / 1000; }
function pct1(av, base) { return base ? (av / base * 100).toFixed(1) : '0.0'; }
function pctInt(r) { return Math.round(r * 100) + '%'; }

// ===== Claude perception request (classify + extract) ======================= //
var CLAUDE_DOC_TOOL = {
  name: 'emit_document',
  description: 'Classify the document as an invoice or a purchase order, then extract its fields. Extraction only — do NOT decide whether anything matches.',
  input_schema: {
    type: 'object',
    properties: {
      doc_type: { type: 'string', enum: ['invoice', 'purchase_order', 'other'], description: 'What kind of document is this? A vendor bill = invoice; a buyer order = purchase_order.' },
      doc_number: { type: ['string', 'null'], description: 'Invoice number (if invoice) OR PO/PR number (if purchase order), exactly as printed.' },
      po_reference: { type: ['string', 'null'], description: "If this is an INVOICE, the BUYER's PR/PO number it cites (handwritten top-of-page, or a printed \"Buyer's Order No\"). Do NOT use the vendor's own order number (a \"Cust PO No\"). null for a PO or if absent." },
      po_references: { type: 'array', items: { type: 'string' }, description: "If this INVOICE cites SEVERAL buyer PR/PO numbers (one invoice against multiple POs), list ALL of them here. Otherwise the single one (or leave empty)." },
      vendor_name: { type: ['string', 'null'], description: 'The seller / supplier name (the invoice issuer; on a PO, the Vendor block name).' },
      seller_gstin: { type: ['string', 'null'], description: "The SELLER's 15-char GSTIN (invoice letterhead/seller block; on a PO the Vendor block 'GST No'). An invoice prints TWO GSTINs — pick the seller by SECTION, not order. null if absent (e.g. US invoices)." },
      buyer_gstin: { type: ['string', 'null'], description: "The BUYER's 15-char GSTIN (invoice Bill-To/Consignee block; on a PO the top-header buyer 'GST Number'). Never put this in seller_gstin. null if absent." },
      total: { type: ['string', 'null'], description: 'Grand total (invoice) or PO amount, as a plain number string like "12500.00".' },
      taxable_total: { type: ['string', 'null'], description: 'Taxable value / net sub-total BEFORE tax, as a plain number string. null if not shown.' },
      tax_total: { type: ['string', 'null'], description: 'Total tax/GST amount (CGST+SGST or IGST), as a plain number string. null if not shown.' },
      cgst: { type: ['string', 'null'] }, sgst: { type: ['string', 'null'] }, igst: { type: ['string', 'null'] },
      currency: { type: 'string' },
      date: { type: ['string', 'null'] },
      line_items: { type: 'array', items: { type: 'object', properties: {
        description: { type: 'string' },
        hsn_sac: { type: ['string', 'null'], description: 'HSN/SAC code for this line, exactly as printed (invoices only; POs carry no HSN). null if absent.' },
        quantity: { type: ['string', 'null'], description: 'Quantity for this line. null if absent — never 0.' },
        unit_price: { type: ['string', 'null'], description: 'Per-unit price / rate for this line, as a plain number string. null if not a per-unit line.' },
        gst_rate: { type: ['string', 'null'], description: 'GST % on this line (e.g. "18" or "18%"). null if absent.' },
        amount: { type: ['string', 'null'], description: 'Line amount (qty × rate) as a plain number string.' },
      } } },
      field_confidence: { type: 'object', properties: { doc_number: { type: 'number' }, vendor: { type: 'number' }, total: { type: 'number' } } },
      text_layer_present: { type: 'boolean', description: 'true if the PDF had selectable text; false if it was a scanned image.' },
    },
    required: ['doc_type', 'field_confidence', 'text_layer_present'],
  },
};
// Map a filename / content-type to a Claude media type. PDFs (text or scanned)
// go in as a `document` block; raw photos (jpg/png/webp/gif) as an `image` block.
// Either way Claude reads them with its own built-in vision/OCR — no external OCR.
function guessMedia(nameOrType) {
  var s = String(nameOrType || '').toLowerCase();
  if (s.indexOf('image/') === 0 || s === 'application/pdf') return s === 'application/pdf' ? 'application/pdf' : s;
  var ext = (s.match(/\.([a-z0-9]+)$/) || [])[1];
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  return 'application/pdf';
}

// A small extraction "skill" — PERCEPTION guidance only (how to read the right
// pixels). It contains NO matching or verdict logic; the deterministic engine
// owns all of that. Sent as the Anthropic `system` field so it caches.
var DOC_SYSTEM_PROMPT = [
  'You read business documents (invoices and purchase orders) into structured fields. You do NOT decide whether anything matches — extraction only.',
  'The file may be a clean PDF, a scanned image, or a phone photo — read it with your vision.',
  'GSTIN (Indian tax docs): an invoice prints TWO GSTINs. Tell them apart by SECTION, not order — the SELLER GSTIN is in the letterhead/seller block; the BUYER GSTIN is in the Bill-To/Consignee block. On a PO, the seller GSTIN is in the Vendor block and the buyer GSTIN is in the top header. Put each in the right field; never swap them.',
  'PO reference: capture the BUYER\'s PR/PO number the invoice cites (often handwritten at the top, or a printed "Buyer\'s Order No"). A "Cust PO No" / the vendor\'s own order number is NOT the buyer\'s reference — do not put it in po_reference. If the invoice cites SEVERAL buyer PR/PO numbers, list ALL of them in po_references.',
  'Indian tax-invoice layout: Taxable/Sub-Total is before tax; GST is CGST+SGST (intra-state) or IGST (inter-state); HSN/SAC codes sit per line. Purchase orders carry NO HSN — never invent one. Capture taxable_total and tax_total (and cgst/sgst/igst if split out).',
  'Line items: for EACH row capture description, hsn_sac (invoices only), quantity, unit_price (per-unit rate), gst_rate, and amount. Read them verbatim; never coerce a missing quantity or price to 0 — use null.',
  'Read, do not compute or judge: emit null when a value is not on the page; never coerce a missing amount or quantity to 0; never invent a GSTIN, stamp, or number.',
  'US-style documents (dollar amounts, no GSTIN/HSN) are perfectly valid — just emit those fields null.',
].join('\n');

function buildDocRequest(base64, mediaType, model) {
  var mt = guessMedia(mediaType || 'application/pdf');
  var block = /^image\//.test(mt)
    ? { type: 'image', source: { type: 'base64', media_type: mt, data: base64 } }
    : { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } };
  return {
    model: model || 'claude-sonnet-4-6', max_tokens: 1500,
    system: DOC_SYSTEM_PROMPT,
    tools: [CLAUDE_DOC_TOOL], tool_choice: { type: 'tool', name: 'emit_document' },
    messages: [{ role: 'user', content: [
      block,
      { type: 'text', text: 'Classify this document (invoice or purchase_order) and extract its fields via emit_document. Money as plain number strings like "12500.00". Report per-field confidence (0-1) and text_layer_present.' },
    ] }],
  };
}

// ===== parse one Claude tool output into a canonical document =============== //
function parseDocument(t, meta) {
  t = t || {}; meta = meta || {};
  var rawType = String(t.doc_type || '').toLowerCase();
  var doc_type = /purchase|order|\bpo\b/.test(rawType) ? 'po' : /invoice|bill/.test(rawType) ? 'invoice' : 'unknown';
  var fc = t.field_confidence || {};
  var conf = (num(fc.doc_number) + num(fc.vendor) + num(fc.total)) / 3;
  var totalCents = toCents(t.total);
  var docNum = t.doc_number || null;
  // All buyer PR/PO numbers this invoice cites (for one-invoice-to-many-POs).
  var refs = (t.po_references && t.po_references.length ? t.po_references : (t.po_reference ? [t.po_reference] : []));
  var poNumbers = doc_type === 'po' ? [cleanPO(docNum)].filter(Boolean)
    : refs.map(cleanPO).filter(function (x, i, a) { return x && a.indexOf(x) === i; });
  var taxableCents = toCents(t.taxable_total);
  var taxCents = toCents(t.tax_total);
  var doc = {
    batch_id: meta.batch_id || null, index: meta.index, filename: meta.filename || ('doc-' + meta.index + '.pdf'),
    doc_type: doc_type,
    invoice_number: doc_type === 'invoice' ? docNum : null,
    po_numbers: poNumbers,
    po_number: poNumbers[0] || null,
    vendor: t.vendor_name || null,
    seller_gstin: t.seller_gstin ? gstinKey(t.seller_gstin) : null,
    buyer_gstin: t.buyer_gstin ? gstinKey(t.buyer_gstin) : null,
    currency: t.currency || 'USD',
    date: t.date ? parseDate(t.date) : null,
    total: totalCents !== null ? money(totalCents) : null,
    total_cents: totalCents,
    taxable_cents: taxableCents, tax_cents: taxCents,
    taxable_total: taxableCents !== null ? money(taxableCents) : null,
    tax_total: taxCents !== null ? money(taxCents) : null,
    line_items: (t.line_items || []).map(function (li) {
      var amtC = li.amount != null && li.amount !== '' ? toCents(li.amount) : null;
      var upC = li.unit_price != null && li.unit_price !== '' ? toCents(li.unit_price) : null;
      return {
        description: li.description || '',
        hsn_sac: li.hsn_sac ? String(li.hsn_sac).replace(/[^0-9A-Za-z]/g, '') : null,
        quantity: li.quantity != null && li.quantity !== '' ? String(li.quantity).replace(/[^0-9.]/g, '') : null,
        unit_price_cents: upC, unit_price: upC !== null ? money(upC) : null,
        gst_rate: li.gst_rate != null && li.gst_rate !== '' ? num(String(li.gst_rate).replace(/[^0-9.]/g, '')) : null,
        amount_cents: amtC, amount: amtC !== null ? money(amtC) : null,
      };
    }),
    confidence: round3(conf),
    text_layer_present: t.text_layer_present !== false,
  };
  var hasKey = doc.total_cents !== null || !!doc.vendor || !!docNum;
  doc.readable = doc_type !== 'unknown' && conf >= CONFIG.MIN_DOC_CONFIDENCE && hasKey;
  return doc;
}

// ===== per-pair verdict (reuses the tolerance ladder) ======================= //
// opts (optional) overrides the AMOUNT comparison for the many-to-many cases:
//   {invCents, poCents, invStr, poStr, poLabel}. Vendor/currency still use inv/po.
function pairVerdict(inv, po, opts) {
  opts = opts || {};
  var findings = [];
  var invC = opts.invCents != null ? opts.invCents : inv.total_cents;
  var poC = opts.poCents != null ? opts.poCents : po.total_cents;
  var poLabel = opts.poLabel || 'PO';
  if (invC === null || poC === null) {
    findings.push(F('AMOUNT_UNVERIFIABLE', SEV.REVIEW, 'Missing an amount on the invoice or ' + poLabel + ' — cannot compare totals.'));
  } else {
    var variance = invC - poC, av = absCents(variance), auto = autoTol(poC), band = approverBand(poC), dir = variance > 0 ? 'over' : 'under';
    if (av <= auto) findings.push(F('AMOUNT_MATCH', SEV.OK, 'Invoice ' + money(invC) + ' matches ' + poLabel + ' ' + money(poC) + ' (Δ ' + money(av) + ').'));
    else if (av <= band) findings.push(F('AMOUNT_VARIANCE', SEV.HOLD, 'Invoice ' + money(invC) + ' is ' + money(av) + ' (' + pct1(av, poC) + '%) ' + dir + ' the ' + poLabel + ' ' + money(poC) + ' — within the approver band; needs sign-off.'));
    else findings.push(F('AMOUNT_MISMATCH', SEV.REJECT, 'Invoice ' + money(invC) + ' is ' + money(av) + ' (' + pct1(av, poC) + '%) ' + dir + ' the ' + poLabel + ' ' + money(poC) + ' — beyond the approver band.'));
  }
  // Vendor identity: the seller's GSTIN is the stable legal id — decide on it
  // when both sides carry one; only fall back to the (fuzzy) name when a GSTIN
  // is absent (and flag that fallback).
  if (inv.seller_gstin && po.seller_gstin) {
    if (inv.seller_gstin === po.seller_gstin) findings.push(F('VENDOR_GSTIN_MATCH', SEV.OK, 'Vendor GSTIN matches: ' + po.seller_gstin + '.'));
    else findings.push(F('VENDOR_GSTIN_MISMATCH', SEV.REVIEW, 'Invoice GSTIN ' + inv.seller_gstin + ' ≠ PO GSTIN ' + po.seller_gstin + ' — different legal entity; possible wrong PO.'));
  } else if (inv.vendor && po.vendor) {
    var vr = ratio(normName(inv.vendor), normName(po.vendor));
    if (vr < CONFIG.VENDOR_FUZZY_THRESHOLD) findings.push(F('VENDOR_MISMATCH', SEV.REVIEW, 'Invoice vendor "' + inv.vendor + '" ≠ PO vendor "' + po.vendor + '" (' + pctInt(vr) + ' similar) — possible wrong PO.'));
    else findings.push(F('VENDOR_OK', SEV.OK, 'Vendor matches: ' + po.vendor + ' (by name; no GSTIN to confirm).'));
  }
  if (inv.currency && po.currency && inv.currency !== po.currency) findings.push(F('CURRENCY_MISMATCH', SEV.REJECT, 'Invoice currency ' + inv.currency + ' ≠ PO currency ' + po.currency + '.'));

  var worst = findings.reduce(function (m, f) { return Math.max(m, f.sev); }, 0);
  var status = worst >= SEV.REJECT ? 'MISMATCH' : worst >= SEV.REVIEW ? 'REVIEW' : worst >= SEV.HOLD ? 'VARIANCE' : 'MATCHED';
  var conf = status === 'MATCHED' ? 0.98 : status === 'MISMATCH' ? 0.9 : status === 'REVIEW' ? 0.6 : 0.8;
  var drivers = findings.filter(function (f) { return f.sev === worst && worst >= SEV.HOLD; });
  if (!drivers.length) drivers = findings.filter(function (f) { return f.sev === SEV.OK; });
  return {
    status: status, confidence: conf,
    reasons: drivers.map(function (f) { return '[' + f.code + '] ' + f.message; }),
    comparison: { invoice_total: opts.invStr || inv.total, po_total: opts.poStr || po.total, delta: (invC !== null && poC !== null) ? money(absCents(invC - poC)) : null },
  };
}

// ===== within-batch duplicate detection ===================================== //
function findBatchDuplicates(invoices) {
  var dups = [];
  for (var i = 0; i < invoices.length; i++) for (var j = i + 1; j < invoices.length; j++) {
    var a = invoices[i], b = invoices[j];
    if (!(a.vendor && b.vendor && ratio(normName(a.vendor), normName(b.vendor)) >= CONFIG.VENDOR_FUZZY_THRESHOLD)) continue;
    var sameNum = a.invoice_number && b.invoice_number && a.invoice_number.toUpperCase() === b.invoice_number.toUpperCase();
    var sameAmt = a.total_cents !== null && b.total_cents !== null && absCents(a.total_cents - b.total_cents) <= CONFIG.NEAR_DUP_AMOUNT_TOLERANCE;
    var sameDate = a.date && b.date && a.date === b.date;
    if (sameNum) dups.push({ kind: 'EXACT', a: a, b: b, reason: 'same vendor + same invoice number ' + a.invoice_number });
    else if (sameAmt && sameDate) dups.push({ kind: 'NEAR', a: a, b: b, reason: 'same vendor, amount (' + money(a.total_cents) + ') and date (' + a.date + '), different invoice numbers' });
  }
  return dups;
}

// ===== GST battery (flag-only, per invoice) ================================= //
// FY 2025-26 HSN/SAC → total-GST% (indicative; from the bundled skill table).
var GST_RATES = {
  '3808': 18, '8516': 18, '85161000': 18, '9405': 18, '996609': 18,
  '3917': 18, '3925': 18, '8481': 18, '7307': 18, '3922': 18,
  '9954': 18, '995469': 18, '9985': 18, '998533': 18, '9987': 18, '99871': 18, '998311': 18, '9983': 18,
  '9401': 18, '9403': 18, '9404': 18, '4418': 18, '8302': 18, '4819': 18,
  '6307': 12, '5208': 5,
};
function pctEqual(a, b) { return Math.abs(num(a) - num(b)) <= 0.01; }
function hsnValid(h) { if (!h) return null; if (!/^[0-9]+$/.test(h)) return false; var n = h.length; if (n === 6 && h.charAt(0) === '9' && h.charAt(1) === '9') return true; return n === 4 || n === 6 || n === 8; }
function rateForHsn(h) { if (GST_RATES[h] != null) return GST_RATES[h]; var h4 = h.slice(0, 4); return GST_RATES[h4] != null ? GST_RATES[h4] : null; }

function gstCheck(inv) {
  var lines = inv.line_items || [];
  var anyHsn = lines.some(function (l) { return l.hsn_sac; });
  var hasTax = inv.taxable_cents !== null && inv.tax_cents !== null;
  if (!anyHsn && !hasTax) return { applicable: false, summary: 'no GST fields on this document', hsn_flags: [], rate_flags: [], tax_reconciles: null };
  var hsn_flags = [], rate_flags = [];
  lines.forEach(function (l) {
    if (!l.hsn_sac) return;
    var v = hsnValid(l.hsn_sac);
    if (v === false) hsn_flags.push('HSN "' + l.hsn_sac + '" is malformed (must be 4/6/8 digits) — ' + (l.description || 'line'));
    if (l.gst_rate != null) {
      var correct = rateForHsn(l.hsn_sac);
      if (correct != null && !pctEqual(l.gst_rate, correct)) rate_flags.push('GST ' + l.gst_rate + '% on HSN ' + l.hsn_sac + ' (' + (l.description || 'line') + ') — table says ' + correct + '%');
    }
  });
  var tax_reconciles = null;
  if (hasTax && inv.total_cents !== null) tax_reconciles = amountsEqual(inv.taxable_cents + inv.tax_cents, inv.total_cents);
  var bits = [];
  if (anyHsn) bits.push(hsn_flags.length ? hsn_flags.length + ' HSN issue(s)' : 'HSN valid');
  if (rate_flags.length) bits.push(rate_flags.length + ' rate flag(s)');
  if (tax_reconciles === true) bits.push('tax adds up'); else if (tax_reconciles === false) bits.push('taxable+tax ≠ total');
  return { applicable: true, summary: bits.join(' · ') || 'checked', hsn_flags: hsn_flags, rate_flags: rate_flags, tax_reconciles: tax_reconciles };
}

// ===== line-item matching (flag-only) ======================================= //
function normDesc(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(function (w) { return w.length >= 3; }); }
function jaccard(a, b) { if (!a.length || !b.length) return 0; var setB = {}; b.forEach(function (w) { setB[w] = 1; }); var inter = 0, seen = {}; a.forEach(function (w) { if (setB[w] && !seen[w]) { inter++; seen[w] = 1; } }); var uni = Object.keys(setB).length; a.forEach(function (w) { if (!setB[w]) uni++; }); return uni ? inter / uni : 0; }
function poItemized(po) {
  var l = po.line_items || [];
  if (l.length > 1) return true;
  if (l.length === 1) { var q = num(l[0].quantity); return q > 1 && l[0].unit_price_cents !== null; }
  return false;
}
function lineCheck(inv, po) {
  var invL = inv.line_items || [], poL = po.line_items || [];
  if (!poItemized(po)) return { applicable: false, po_itemized: false, summary: (poL.length ? 'N/A — PO lump-sum' : 'PO has no line detail'), flags: [], pairs: [] };
  if (!invL.length) return { applicable: false, po_itemized: true, summary: 'no invoice line detail', flags: [], pairs: [] };
  var usedPo = {}, pairs = [], flags = [];
  invL.forEach(function (il) {
    var best = -1, bestScore = 0;
    for (var j = 0; j < poL.length; j++) {
      if (usedPo[j]) continue;
      var pl = poL[j], score = 0;
      if (il.hsn_sac && pl.hsn_sac && il.hsn_sac === pl.hsn_sac) score = 1;
      else if (normDesc(il.description).join(' ') && normDesc(il.description).join(' ') === normDesc(pl.description).join(' ')) score = 0.95;
      else score = jaccard(normDesc(il.description), normDesc(pl.description));
      if (score > bestScore) { bestScore = score; best = j; }
    }
    if (best >= 0 && bestScore >= 0.5) {
      usedPo[best] = true;
      var pl2 = poL[best];
      var rate_ok = (il.unit_price_cents !== null && pl2.unit_price_cents !== null) ? absCents(il.unit_price_cents - pl2.unit_price_cents) <= CONFIG.RATE_EQ_TOLERANCE : null;
      if (rate_ok === false) flags.push('rate differs on "' + (il.description || 'line') + '": invoice ' + il.unit_price + ' vs PO ' + pl2.unit_price);
      pairs.push({ invoice_line: il.description, po_line: pl2.description, invoice_rate: il.unit_price, po_rate: pl2.unit_price, quantity: il.quantity, rate_ok: rate_ok });
    } else {
      flags.push('invoice line "' + (il.description || 'line') + '" not found on the PO');
      pairs.push({ invoice_line: il.description, po_line: null, invoice_rate: il.unit_price, po_rate: null, quantity: il.quantity, rate_ok: null });
    }
  });
  var m = pairs.filter(function (p) { return p.po_line; }).length;
  return { applicable: true, po_itemized: true, summary: (m === invL.length ? 'All ' + m + ' lines matched' : m + ' of ' + invL.length + ' lines matched'), flags: flags, pairs: pairs };
}

// ===== the reconciliation =================================================== //
function pub(d) { return { index: d.index, filename: d.filename, doc_type: d.doc_type, invoice_number: d.invoice_number, po_number: d.po_number, po_numbers: d.po_numbers || (d.po_number ? [d.po_number] : []), vendor: d.vendor, seller_gstin: d.seller_gstin || null, total: d.total, currency: d.currency, date: d.date, confidence: d.confidence, readable: d.readable }; }
function pubDup(d) { return { kind: d.kind, reason: d.reason, a: { filename: d.a.filename, invoice_number: d.a.invoice_number }, b: { filename: d.b.filename, invoice_number: d.b.invoice_number } }; }
// A safe view of a stored ledger record (for surfacing "the prior we matched").
function pubLedger(r) { return { invoice_number: r.invoice_number || null, vendor: r.vendor || null, po_number: r.po_number || null, amount: (r.amount_cents !== null && r.amount_cents !== undefined) ? money(num(r.amount_cents)) : null, date: r.invoice_date || null, run_at: r.run_at || null, batch_id: r.batch_id || null }; }

// priorLedger (optional): array of records from earlier runs — see reconcile().
// Empty/undefined ⇒ cross-run + cumulative-memory checks are skipped entirely and
// the output is byte-for-byte what it was before this parameter existed.
function reconcile(docs, priorLedger) {
  docs = docs || []; priorLedger = priorLedger || [];
  var readable = docs.filter(function (d) { return d.readable; });
  var unreadable = docs.filter(function (d) { return !d.readable; }).map(function (d) {
    return { filename: d.filename, index: d.index, reason: d.doc_type === 'unknown' ? 'could not classify or read the document' : 'low extraction confidence (' + pctInt(d.confidence) + ')', doc: pub(d) };
  });
  var invoices = readable.filter(function (d) { return d.doc_type === 'invoice'; });
  var pos = readable.filter(function (d) { return d.doc_type === 'po'; });

  var poByKey = {};
  pos.forEach(function (p) { var k = poKey(p.po_number); if (k) (poByKey[k] = poByKey[k] || []).push(p); });

  var duplicates = findBatchDuplicates(invoices);
  var dupIdx = {}; duplicates.forEach(function (d) { dupIdx[d.a.index] = true; dupIdx[d.b.index] = true; });

  var covered = {}; // po.index → true once matched by ≥1 invoice
  var invByIndex = {}; invoices.forEach(function (i) { invByIndex[i.index] = i; });
  var matched = [], po_missing = [];

  // Match ladder (from the Superjoin skills), extended for MANY-TO-MANY:
  // an invoice may cite SEVERAL PO numbers (→ one matched group vs Σ of POs),
  // and a PO may be cited by several invoices (→ split billing, handled below).
  // GSTIN rungs only fire when the invoice carries a seller GSTIN, so US/no-GSTIN
  // and single-PO batches behave exactly as before.
  invoices.forEach(function (inv) {
    var matchedPOs = [], basis = 'none';
    // R1 — every buyer PR/PO number the invoice cites (a PO may be cited by many invoices).
    (inv.po_numbers || []).forEach(function (ref) {
      var kk = poKey(ref);
      if (kk && poByKey[kk] && poByKey[kk].length) { var p = poByKey[kk][0]; if (matchedPOs.indexOf(p) < 0) matchedPOs.push(p); }
    });
    if (matchedPOs.length) basis = matchedPOs.length > 1 ? 'PR/PO number (×' + matchedPOs.length + ')' : 'PR/PO number';
    // R2–R4 fingerprint (single PO) only when no buyer ref matched.
    if (!matchedPOs.length && inv.seller_gstin) {
      var g2 = pos.filter(function (p) { return !covered[p.index] && p.seller_gstin && p.seller_gstin === inv.seller_gstin && amountsEqual(inv.total_cents, p.total_cents); });
      if (g2.length === 1) { matchedPOs = [g2[0]]; basis = 'fingerprint (GSTIN + total)'; }
    }
    if (!matchedPOs.length && inv.vendor && normName(inv.vendor) !== '') {
      var n3 = pos.filter(function (p) { return !covered[p.index] && p.vendor && normName(p.vendor) === normName(inv.vendor) && amountsEqual(inv.total_cents, p.total_cents); });
      if (n3.length === 1) { matchedPOs = [n3[0]]; basis = 'fingerprint (name + total)'; }
    }
    if (!matchedPOs.length && inv.seller_gstin) {
      var g4 = pos.filter(function (p) { return !covered[p.index] && p.seller_gstin && p.seller_gstin === inv.seller_gstin; });
      if (g4.length === 1) { matchedPOs = [g4[0]]; basis = 'possible (GSTIN only, total off)'; }
    }
    // R5 — none.
    if (matchedPOs.length) {
      matchedPOs.forEach(function (p) { covered[p.index] = true; });
      var primary = matchedPOs[0], verdict, relationship = 'one-to-one', lcPO = primary;
      if (matchedPOs.length > 1) {
        relationship = 'invoice-spans-POs';
        var sum = matchedPOs.reduce(function (a, p) { return a + (p.total_cents || 0); }, 0);
        verdict = pairVerdict(inv, primary, { poCents: sum, poStr: money(sum), poLabel: matchedPOs.length + ' POs' });
        // line-item check against the UNION of all spanned POs' lines (not just the first).
        lcPO = { line_items: matchedPOs.reduce(function (a, p) { return a.concat(p.line_items || []); }, []) };
      } else {
        verdict = pairVerdict(inv, primary);
      }
      matched.push({
        invoice: pub(inv), po: pub(primary), pos: matchedPOs.map(pub), relationship: relationship, basis: basis,
        verdict: verdict, duplicate: !!dupIdx[inv.index], line_check: lineCheck(inv, lcPO), gst_check: gstCheck(inv), _idx: inv.index,
      });
    } else {
      po_missing.push({
        invoice: pub(inv), cited_po: inv.po_number || null,
        reason: inv.po_number ? ('cites PO ' + inv.po_number + ' — not present in this batch') : 'no buyer PR/PO reference and no unique GSTIN/name + total match',
        duplicate: !!dupIdx[inv.index], gst_check: gstCheck(inv),
      });
    }
  });

  // Split billing: a single PO billed by ≥2 matched invoices with DISTINCT
  // invoice numbers (duplicates — same number — are excluded; the duplicate flag
  // handles those). Compare Σ(invoices) to the PO ceiling; each is a PARTIAL.
  var byPo = {};
  matched.forEach(function (mm) { if (mm.relationship === 'one-to-one' && mm.po.po_number) (byPo[mm.po.po_number] = byPo[mm.po.po_number] || []).push(mm); });
  Object.keys(byPo).forEach(function (pn) {
    var group = byPo[pn], distinct = {};
    group.forEach(function (mm) { if (mm.invoice.invoice_number) distinct[mm.invoice.invoice_number.toUpperCase()] = 1; });
    if (group.length < 2 || Object.keys(distinct).length < 2) return;
    var po = pos.filter(function (p) { return p.po_number === pn; })[0];
    var poTotal = po ? po.total_cents : null, band = poTotal !== null ? approverBand(poTotal) : 0;
    var cumulative = group.reduce(function (a, mm) { var iv = invByIndex[mm._idx]; return a + (iv && iv.total_cents ? iv.total_cents : 0); }, 0);
    var over = poTotal !== null ? cumulative - poTotal : null;
    group.forEach(function (mm) {
      mm.relationship = 'split-billing';
      mm.split_group = { po_number: pn, invoices: group.length, cumulative: money(cumulative), po_total: po ? po.total : null, over: (over !== null && over > 0) ? money(over) : null };
      if (over !== null && over > band) { mm.verdict.status = 'MISMATCH'; mm.verdict.reasons = ['[CUMULATIVE_OVERBILL] Split billing: ' + group.length + ' invoices against PO ' + pn + ' total ' + money(cumulative) + ', exceeding the PO ' + (po ? po.total : '') + ' by ' + money(over) + ' — beyond the band.']; }
      else { mm.verdict.status = 'PARTIAL'; mm.verdict.reasons = ['[PARTIAL_BILLING] Partial billing: ' + group.length + ' invoices against PO ' + pn + '; combined ' + money(cumulative) + (poTotal !== null ? ' of ' + (po ? po.total : '') : '') + '.']; }
    });
  });
  matched.forEach(function (mm) { delete mm._idx; });

  var invoice_missing = pos.filter(function (p) { return !covered[p.index]; }).map(function (p) { return { po: pub(p), reason: 'ordered but no matching invoice in this batch' }; });

  // ===== cross-run MEMORY (guarded on priorLedger; flag-only, never a verdict) =
  // priorLedger holds one record per invoice processed in EARLIER runs. When it
  // is empty every block below is skipped and the report is unchanged. Signals
  // are attached as NEW nested fields — they never touch verdict.status/buckets.
  var cross_run_duplicates = [], cumulative_flags = [];
  // Sum of what earlier runs already billed against each PO (+ remembered PO ceiling).
  var priorByPo = {};
  priorLedger.forEach(function (r) {
    var k = poKey(r.po_number); if (!k) return;
    var slot = priorByPo[k] || (priorByPo[k] = { sum: 0, count: 0, po_total_cents: null, po_number: r.po_number });
    slot.sum += num(r.amount_cents); slot.count += 1;
    if ((r.po_total_cents !== null && r.po_total_cents !== undefined) && slot.po_total_cents === null) slot.po_total_cents = r.po_total_cents;
  });
  if (priorLedger.length) {
    // (a) cross-run duplicate — this invoice was already processed before.
    var findPriorDup = function (inv) {
      for (var i = 0; i < priorLedger.length; i++) {
        var r = priorLedger[i];
        if (!(inv.vendor && r.vendor && ratio(normName(inv.vendor), normName(r.vendor)) >= CONFIG.VENDOR_FUZZY_THRESHOLD)) continue;
        if (inv.invoice_number && r.invoice_number && String(inv.invoice_number).toUpperCase() === String(r.invoice_number).toUpperCase())
          return { kind: 'EXACT', prior: r, reason: 'already processed in a prior run' + (r.run_at ? ' (' + r.run_at + ')' : '') + ' — same vendor + invoice ' + inv.invoice_number };
        var sameAmt = inv.total_cents !== null && r.amount_cents !== null && r.amount_cents !== undefined && absCents(inv.total_cents - num(r.amount_cents)) <= CONFIG.NEAR_DUP_AMOUNT_TOLERANCE;
        var sameDate = inv.date && r.invoice_date && inv.date === r.invoice_date;
        if (sameAmt && sameDate) return { kind: 'NEAR', prior: r, reason: 'probable repeat of a prior-run invoice — same vendor, amount (' + money(inv.total_cents) + ') and date (' + inv.date + '), different number' };
      }
      return null;
    };
    matched.concat(po_missing).forEach(function (entry) {
      var inv = invByIndex[entry.invoice.index]; if (!inv) return;
      var dup = findPriorDup(inv);
      if (dup) { entry.cross_run = { kind: dup.kind, reason: dup.reason, prior: pubLedger(dup.prior) }; cross_run_duplicates.push({ invoice: entry.invoice, kind: dup.kind, reason: dup.reason, prior: pubLedger(dup.prior) }); }
    });
    // (b) cumulative billing across runs — the PO's prior billing + this batch
    // exceeds the PO ceiling, even though each invoice looks fine on its own.
    var thisByPo = {};
    matched.forEach(function (mm) {
      if (mm.relationship === 'invoice-spans-POs') return; // spanning invoices carry their own multi-PO verdict
      var pn = mm.po.po_number; if (!pn) return;
      var k = poKey(pn), inv = invByIndex[mm.invoice.index];
      var slot = thisByPo[k] || (thisByPo[k] = { sum: 0, po_total_cents: null, po_number: pn, entries: [] });
      slot.sum += (inv && inv.total_cents ? inv.total_cents : 0); slot.entries.push(mm);
      var po = pos.filter(function (p) { return p.po_number === pn; })[0];
      if (po && po.total_cents !== null) slot.po_total_cents = po.total_cents;
    });
    Object.keys(thisByPo).forEach(function (k) {
      var slot = thisByPo[k], prior = priorByPo[k];
      if (!prior || !prior.sum) return; // no prior billing for this PO → within-batch split already covers it
      var ceiling = slot.po_total_cents !== null ? slot.po_total_cents : prior.po_total_cents;
      var cumulative = prior.sum + slot.sum, band = ceiling !== null ? approverBand(ceiling) : 0, over = ceiling !== null ? cumulative - ceiling : null;
      if (over === null || over <= band) return; // within the ceiling+band → legitimate cross-run partial billing
      var flag = { po_number: slot.po_number, prior_billed: money(prior.sum), prior_count: prior.count, this_batch: money(slot.sum), cumulative: money(cumulative), po_total: money(ceiling), over: money(over) };
      slot.entries.forEach(function (mm) { mm.cumulative = flag; });
      cumulative_flags.push(flag);
    });
  }
  // What THIS run adds to memory (matched or not); the node persists idempotently.
  var ledger_additions = invoices.map(function (inv) {
    var m = matched.filter(function (mm) { return mm.invoice.index === inv.index; })[0];
    var po_number = inv.po_number, po_total_cents = null;
    if (m) { po_number = m.po.po_number; var po = pos.filter(function (p) { return p.po_number === po_number; })[0]; po_total_cents = po ? po.total_cents : null; }
    return { vendor: inv.vendor, invoice_number: inv.invoice_number, invoice_date: inv.date, amount_cents: inv.total_cents, currency: inv.currency, po_number: po_number, po_total_cents: po_total_cents, seller_gstin: inv.seller_gstin, filename: inv.filename, batch_id: inv.batch_id };
  });

  // Additive summary counters (existing keys untouched).
  var lineFlagN = matched.reduce(function (a, m) { return a + (m.line_check && m.line_check.flags ? m.line_check.flags.length : 0); }, 0);
  var gstFlagN = matched.concat(po_missing).reduce(function (a, m) { var g = m.gst_check; return a + (g ? g.hsn_flags.length + g.rate_flags.length + (g.tax_reconciles === false ? 1 : 0) : 0); }, 0);
  var partials = matched.filter(function (m) { return m.verdict.status === 'PARTIAL'; }).length;
  var multiPo = matched.filter(function (m) { return m.relationship === 'invoice-spans-POs'; }).length;

  return {
    batch_id: docs.length ? docs[0].batch_id : null,
    summary: {
      documents: docs.length, invoices: invoices.length, pos: pos.length, matched: matched.length,
      po_missing: po_missing.length, invoice_missing: invoice_missing.length, unreadable: unreadable.length, duplicates: duplicates.length,
      line_flags: lineFlagN, gst_flags: gstFlagN, partials: partials, invoice_spans_pos: multiPo,
      cross_run_duplicates: cross_run_duplicates.length, cumulative_flags: cumulative_flags.length,
    },
    matched: matched, po_missing: po_missing, invoice_missing: invoice_missing, unreadable: unreadable, duplicates: duplicates.map(pubDup),
    cross_run_duplicates: cross_run_duplicates, cumulative_flags: cumulative_flags, ledger_additions: ledger_additions,
    documents: docs.map(pub),
  };
}

// full offline run (used by the emulator; n8n splits this across nodes)
function runBatch(claudeOutputs, metas, priorLedger) {
  var docs = (claudeOutputs || []).map(function (t, i) { return parseDocument(t, metas && metas[i] ? metas[i] : { index: i }); });
  return reconcile(docs, priorLedger);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    CONFIG: CONFIG, SEV: SEV, money: money, toCents: toCents, ratio: ratio, normName: normName, parseDate: parseDate, cleanPO: cleanPO, poKey: poKey, gstinKey: gstinKey, amountsEqual: amountsEqual,
    CLAUDE_DOC_TOOL: CLAUDE_DOC_TOOL, buildDocRequest: buildDocRequest, guessMedia: guessMedia, parseDocument: parseDocument, DOC_SYSTEM_PROMPT: DOC_SYSTEM_PROMPT,
    pairVerdict: pairVerdict, findBatchDuplicates: findBatchDuplicates, reconcile: reconcile, runBatch: runBatch,
    lineCheck: lineCheck, gstCheck: gstCheck, GST_RATES: GST_RATES,
  };
}
