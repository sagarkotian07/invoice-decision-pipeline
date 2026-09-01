'use strict';
/*
 * ocr_nanonets.js — map a Nanonets /LabelFile/ prediction response to the canonical
 * schema that normalize.js / matcher.js expect.
 *
 * Nanonets response shape (v2 model prediction):
 *   result[0].prediction[] -> [{ label, ocr_text, ... }]   (flat header fields)
 *   result[0].cells[]      -> [{ row, col, label, ocr_text }] (table / line items)
 *
 * Pretrained-model label names vary a little between the Invoice and Purchase-Order
 * models and across account versions, so the label map below is deliberately
 * TOLERANT (many aliases → one canonical key). Run tests/nanonets_probe.js to print
 * the *actual* labels your models emit, then add any missing alias here.
 *
 * Portable: runs in Node (require) and in an n8n Code node.
 */

// canonical key  ->  set of accepted Nanonets labels (lowercased, non-alnum stripped)
const HEADER_ALIASES = {
  invoice_number: ['invoicenumber', 'invoiceno', 'invoiceno', 'billno', 'billnumber'],
  invoice_date: ['invoicedate', 'date', 'billdate'],
  vendor_name: ['vendorname', 'sellername', 'suppliername', 'vendor', 'seller', 'frombusinessname', 'companyname'],
  vendor_gstin: ['vendorgstin', 'sellergstin', 'gstin', 'suppliergstin', 'gstinno', 'gstno', 'sellergstinuin'],
  buyer_gstin: ['buyergstin', 'consigneegstin', 'shiptogstin', 'billtogstin'],
  po_number: ['ponumber', 'pono', 'purchaseordernumber', 'purchaseorderno', 'buyerorderno', 'buyerpo'],
  pr_number: ['prnumber', 'prno', 'requisitionnumber'],
  requisition_date: ['requisitiondate', 'podate', 'purchaseorderdate', 'orderdate'],
  taxable_total: ['taxabletotal', 'taxableamount', 'taxablevalue', 'subtotal', 'nettotal'],
  tax_total: ['taxtotal', 'taxamount', 'gsttotal', 'gstamount', 'totaltax', 'gst'],
  total: ['total', 'totalamount', 'grandtotal', 'invoiceamount', 'invoicetotal', 'pototal', 'amountdue', 'amountpayable'],
};

// invoice/PO can print CGST + SGST separately — sum them into tax_total.
const SPLIT_TAX = ['cgst', 'cgstamount', 'sgst', 'sgstamount', 'igst', 'igstamount'];

const LINE_ALIASES = {
  description: ['description', 'itemdescription', 'lineitemdescription', 'particulars', 'itemname', 'product'],
  hsn_sac: ['hsn', 'sac', 'hsnsac', 'hsncode', 'hsnsaccode'],
  quantity: ['quantity', 'qty'],
  unit: ['unit', 'uom', 'units'],
  unit_price: ['unitprice', 'rate', 'price', 'priceperunit'],
  gst_rate: ['gstrate', 'gst', 'taxrate', 'gstpercent'],
  amount: ['amount', 'lineamount', 'linetotal', 'total', 'value'],
};

const key = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const cleanNum = (s) => {
  if (s === null || s === undefined || s === '') return null;
  const n = Number(String(s).replace(/[₹$€£,%\s]/g, '').replace(/[()]/g, ''));
  return Number.isFinite(n) ? n : null;
};

function findCanonical(labelKey, aliasMap) {
  for (const canon of Object.keys(aliasMap)) {
    if (aliasMap[canon].includes(labelKey)) return canon;
  }
  return null;
}

// pull result[0] (the first page/prediction block) defensively
function firstBlock(resp) {
  if (!resp) return { prediction: [], cells: [] };
  const r = Array.isArray(resp.result) ? resp.result[0] : resp.result || resp;
  return { prediction: r.prediction || [], cells: r.cells || [] };
}

function headerFields(prediction) {
  const out = {}; let splitTax = 0; let sawSplit = false;
  for (const p of prediction) {
    const lk = key(p.label);
    const val = p.ocr_text != null ? p.ocr_text : p.value;
    if (SPLIT_TAX.includes(lk)) { const n = cleanNum(val); if (n != null) { splitTax += n; sawSplit = true; } continue; }
    const canon = findCanonical(lk, HEADER_ALIASES);
    if (canon && out[canon] === undefined) out[canon] = val;
  }
  if (sawSplit && out.tax_total === undefined) out.tax_total = splitTax;
  return out;
}

function lineItems(cells) {
  if (!cells || !cells.length) return [];
  const rows = new Map();
  for (const c of cells) {
    const r = c.row;
    if (r === undefined || r === null) continue;
    if (!rows.has(r)) rows.set(r, {});
    const canon = findCanonical(key(c.label), LINE_ALIASES);
    if (canon) rows.get(r)[canon] = c.ocr_text != null ? c.ocr_text : c.value;
  }
  // Nanonets often includes the header row as row 0 with the column titles — drop any
  // row that has no numeric quantity/amount and whose description looks like a header.
  const items = [];
  let lineNo = 1;
  for (const [, cols] of [...rows.entries()].sort((a, b) => a[0] - b[0])) {
    const hasData = cols.description || cols.amount || cols.quantity;
    if (!hasData) continue;
    const looksHeader = /^(description|item|qty|quantity|rate|amount|hsn|sac|particulars)$/i
      .test(String(cols.description || '').trim());
    if (looksHeader) continue;
    items.push({
      line_no: lineNo++,
      description: cols.description || '',
      hsn_sac: cols.hsn_sac || '',
      quantity: cleanNum(cols.quantity),
      unit: cols.unit || '',
      rate: cleanNum(cols.unit_price),
      unit_price: cleanNum(cols.unit_price),
      gst_rate: normGst(cols.gst_rate),
      amount: cleanNum(cols.amount),
    });
  }
  return items;
}

// GST may come as "18", "18%", or "0.18" — canonical is a fraction (0.18).
function normGst(v) {
  const n = cleanNum(v);
  if (n == null) return null;
  return n > 1 ? n / 100 : n;
}

function nanonetsToCanonical(resp, kind) {
  const { prediction, cells } = firstBlock(resp);
  const h = headerFields(prediction);
  const lines = lineItems(cells);

  if (kind === 'po') {
    const doc = {
      po_number: h.po_number || '',
      pr_number: h.pr_number || '',
      vendor_name: h.vendor_name || '',
      vendor_gstin: h.vendor_gstin || '',
      buyer_gstin: h.buyer_gstin || '',
      requisition_date: h.requisition_date || h.invoice_date || '',
      total: cleanNum(h.total),
      lines,
    };
    return doc;
  }
  // invoice
  return {
    invoice_number: h.invoice_number || '',
    invoice_date: h.invoice_date || '',
    vendor_name: h.vendor_name || '',
    vendor_gstin: h.vendor_gstin || '',
    buyer_gstin: h.buyer_gstin || '',
    // a printed PO number on the invoice becomes a buyer_pr_po reference
    references: h.po_number ? [{ value: h.po_number, kind: 'buyer_pr_po', handwritten: false }] : [],
    taxable_total: cleanNum(h.taxable_total),
    tax_total: cleanNum(h.tax_total),
    total: cleanNum(h.total),
    lines,
  };
}

// ---- n8n Code-node entrypoint (safe no-op under Node) --------------------- //
if (typeof $input !== 'undefined') {
  // Expects the two OCR HTTP nodes upstream, referenced by name.
  const invResp = $('OCR: parse invoice').first().json;
  const poResp = $('OCR: parse PO').first().json;
  const invoice = nanonetsToCanonical(invResp, 'invoice');
  const po = nanonetsToCanonical(poResp, 'po');
  return [{ json: { invoice, pos: [po], opts: {} } }];        // eslint-disable-line
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { nanonetsToCanonical };
}
