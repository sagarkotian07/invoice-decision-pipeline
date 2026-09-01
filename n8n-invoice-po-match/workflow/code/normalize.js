'use strict';
/*
 * normalize.js — map raw parsed input (OCR output or mock JSON) to the canonical
 * schema that matcher.js expects. Tolerates the alternate field names OCR services
 * and different vendors emit ("invoice_no" vs "invoice_number", "₹1,234.50" vs a
 * number, "line_items" vs "lines"). Numbers are cleaned to plain floats; dates are
 * left as ISO strings (the OCR step should already have normalised them).
 *
 * Accepts a payload shaped as { invoice, pos|po, opts? } where invoice/po may use
 * loose field names, and returns { invoice, pos, opts } in canonical form.
 */

const toNum = (v) => {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return v;
  const s = String(v).replace(/[₹$€£,\s]/g, '').replace(/[()]/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

const pick = (obj, keys) => {
  for (const k of keys) if (obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  return undefined;
};

function normRefs(raw) {
  // Accept: array of {value,kind,handwritten} | array of strings | a single "po_reference"
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr.map((r) =>
    typeof r === 'string'
      ? { value: r, kind: 'buyer_pr_po', handwritten: false }
      : { value: r.value ?? r.ref ?? '', kind: r.kind || 'buyer_pr_po', handwritten: !!r.handwritten }
  ).filter((r) => r.value);
}

function normLines(raw) {
  const arr = raw || [];
  return arr.map((l, i) => ({
    line_no: l.line_no ?? i + 1,
    description: pick(l, ['description', 'desc', 'item', 'particulars', 'name']) || '',
    hsn_sac: pick(l, ['hsn_sac', 'hsn', 'sac', 'hsn_code']) || '',
    quantity: toNum(pick(l, ['quantity', 'qty'])),
    unit: pick(l, ['unit', 'uom']) || '',
    rate: toNum(pick(l, ['rate', 'unit_price', 'price'])),
    unit_price: toNum(pick(l, ['unit_price', 'rate', 'price'])),
    gst_rate: toNum(pick(l, ['gst_rate', 'gst', 'tax_rate'])),
    amount: toNum(pick(l, ['amount', 'line_total', 'total'])),
  }));
}

function normInvoice(raw) {
  if (!raw) return {};
  return {
    invoice_number: pick(raw, ['invoice_number', 'invoice_no', 'invoice', 'bill_no']) || '',
    invoice_date: pick(raw, ['invoice_date', 'date', 'invoice_dt']) || '',
    vendor_name: pick(raw, ['vendor_name', 'seller', 'supplier', 'vendor']) || '',
    vendor_gstin: pick(raw, ['vendor_gstin', 'seller_gstin', 'gstin', 'supplier_gstin']) || '',
    buyer_gstin: pick(raw, ['buyer_gstin', 'consignee_gstin']) || '',
    references: normRefs(raw.references || raw.po_reference || raw.buyer_pr_po),
    taxable_total: toNum(pick(raw, ['taxable_total', 'taxable', 'sub_total', 'subtotal'])),
    tax_total: toNum(pick(raw, ['tax_total', 'gst', 'tax', 'gst_total'])),
    total: toNum(pick(raw, ['total', 'grand_total', 'invoice_amount', 'amount_due'])),
    lines: normLines(raw.lines || raw.line_items || raw.items),
  };
}

function normPo(raw) {
  if (!raw) return null;
  const lines = normLines(raw.lines || raw.line_items || raw.items);
  // po_itemized: >1 line, OR a single line with qty>1 AND a per-unit price
  let itemized = raw.po_itemized;
  if (itemized === undefined) {
    if (lines.length > 1) itemized = true;
    else if (lines.length === 1) itemized = (lines[0].quantity > 1 && lines[0].unit_price != null);
    else itemized = false;
  }
  return {
    po_number: pick(raw, ['po_number', 'po_no', 'po']) || '',
    pr_number: pick(raw, ['pr_number', 'pr_no', 'pr']) || '',
    vendor_name: pick(raw, ['vendor_name', 'supplier', 'vendor']) || '',
    vendor_gstin: pick(raw, ['vendor_gstin', 'supplier_gstin', 'gstin']) || '',
    buyer_gstin: pick(raw, ['buyer_gstin']) || '',
    requisition_date: pick(raw, ['requisition_date', 'po_date', 'date']) || '',
    scheduled_date: pick(raw, ['scheduled_date']) || '',
    total: toNum(pick(raw, ['total', 'grand_total', 'po_total'])),
    po_itemized: !!itemized,
    lines,
  };
}

function normalize(payload) {
  const invoice = normInvoice(payload.invoice);
  const posRaw = payload.pos || (payload.po ? [payload.po] : []);
  const pos = posRaw.map(normPo).filter(Boolean);
  return { invoice, pos, opts: payload.opts || {} };
}

if (typeof $input !== 'undefined') {
  const out = $input.all().map((it) => ({ json: normalize(it.json) }));
  return out;                                                   // eslint-disable-line
}
if (typeof module !== 'undefined' && module.exports) module.exports = { normalize, toNum };
