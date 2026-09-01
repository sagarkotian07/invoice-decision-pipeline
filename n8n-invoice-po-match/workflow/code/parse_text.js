'use strict';
/*
 * parse_text.js — FREE, key-less parser. Turns the plain text of an invoice / PO
 * (from pypdf locally, or n8n's built-in "Extract from File" node) into the
 * canonical schema, using label regexes for the header fields and a header-driven
 * column mapper for line items. No OCR service, no API key, no cost.
 *
 * Works on born-digital (text-layer) PDFs. Scanned images have no text layer — for
 * those you'd add real OCR later (the Nanonets branch is still in the workflow).
 *
 * Portable: runs in Node (require) and in an n8n Code node.
 */

const GSTIN_RE = /\b\d{2}[A-Z]{5}\d{4}[A-Z][0-9A-Z]Z[0-9A-Z]\b/;

const toNum = (s) => {
  if (s == null || s === '') return null;
  // extract the FIRST number token, so trailing text ("11,800.00 (incl. GST)") is ignored
  const m = String(s).match(/-?\d[\d,]*\.?\d*/);
  if (!m) return null;
  const n = Number(m[0].replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};

// grab a specific tax amount (CGST/SGST/IGST), even when several share one line
// ("CGST 9%: 900.00    SGST 9%: 900.00") — take the last decimal number in this
// label's own segment, after dropping the rate% and any following tax label.
function grabTax(text, label) {
  const m = text.match(new RegExp(label + '[^\\n]*', 'i'));
  if (!m) return null;
  let seg = m[0].replace(new RegExp('^' + label, 'i'), '')
    .replace(/\b(cgst|sgst|igst)\b.*/i, '');
  const nums = seg.match(/\d[\d,]*\.\d{2}/g) || seg.match(/\d[\d,]*/g) || [];
  return nums.length ? toNum(nums[nums.length - 1]) : null;
}

// dates: DD-MM-YYYY, DD/MM/YYYY, YYYY-MM-DD, "10 Jun 2025" → ISO
function toIso(s) {
  if (!s) return '';
  s = s.trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  const MON = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
    jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
  m = s.match(/^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})$/);
  if (m && MON[m[2].slice(0, 3).toLowerCase()]) {
    return `${m[3]}-${MON[m[2].slice(0, 3).toLowerCase()]}-${m[1].padStart(2, '0')}`;
  }
  return s;
}

const lines = (t) => String(t || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

// Capture a field value after its label, stopping at the NEXT label (a "Word:"
// pattern) or a 2+ space gap or end of line. Works whether the PDF extractor keeps
// wide gaps (pypdf) or collapses them to single spaces (n8n's Extract from File):
//   "Invoice No: INV-1001 Invoice Date: 10-06-2025" → invoice no = "INV-1001".
const STOP = '(?=\\s{2,}|\\s[A-Za-z][A-Za-z ./]{1,22}:|$)';
function fieldValue(text, labels) {
  for (const lab of labels) {
    const re = new RegExp(lab + '\\s*[:#]?\\s*([^\\n]*?)' + STOP, 'im');
    const m = text.match(re);
    if (m && m[1].trim()) return m[1].trim();
  }
  return '';
}
// For ids (invoice/PO/PR numbers): the value is a single token containing a digit.
function idValue(text, labels) {
  for (const lab of labels) {
    const re = new RegExp(lab + '\\s*[:#]?\\s*([A-Za-z0-9][A-Za-z0-9/_-]*)', 'im');
    const m = text.match(re);
    if (m && m[1] && /\d/.test(m[1])) return m[1].trim();
  }
  return '';
}

// Detect the table columns from the header by KEYWORD POSITION (handles multi-word
// headers like "Unit Price" and single-spaced text), returning them left-to-right.
const COL_SCAN = [
  [/\bsl\b|s\.?\s*no\b|^#/i, 'sl'],
  [/description|item|particular/i, 'description'],
  [/hsn|sac/i, 'hsn_sac'],
  [/qty|quantity/i, 'quantity'],
  [/unit\s*price|\brate\b|\bprice\b/i, 'unit_price'],
  [/gst|tax/i, 'gst_rate'],
  [/amount|value/i, 'amount'],
];
function headerColumns(headerLine) {
  const found = [];
  for (const [re, key] of COL_SCAN) {
    const m = headerLine.match(re);
    if (m && m.index != null) found.push({ key, idx: m.index });
  }
  const seen = new Set();
  return found.sort((a, b) => a.idx - b.idx)
    .filter((f) => !seen.has(f.key) && seen.add(f.key)).map((f) => f.key);
}
function assignCol(rec, key, val) {
  if (!key || key === 'sl' || val == null) return;
  if (key === 'description') rec.description = (rec.description ? rec.description + ' ' : '') + val;
  else if (key === 'hsn_sac') rec.hsn_sac = String(val).replace(/\s/g, '');
  else if (key === 'quantity') rec.quantity = toNum(val);
  else if (key === 'unit_price') { rec.unit_price = toNum(val); rec.rate = toNum(val); }
  else if (key === 'gst_rate') { const n = toNum(val); rec.gst_rate = n == null ? null : (n > 1 ? n / 100 : n); }
  else if (key === 'amount') rec.amount = toNum(val);
}

function parseLineItems(ls) {
  const hIdx = ls.findIndex((l) => /description|item|particular/i.test(l)
    && /(amount|qty|quantity|rate|value)/i.test(l));
  if (hIdx < 0) return [];
  const cols = headerColumns(ls[hIdx]);
  const descIdx = cols.indexOf('description');
  if (descIdx < 0) return [];
  const pre = cols.slice(0, descIdx);        // columns before description (e.g. Sl)
  const post = cols.slice(descIdx + 1);      // columns after description (numbers)
  const items = [];
  let lineNo = 1;
  for (let i = hIdx + 1; i < ls.length; i++) {
    const l = ls[i];
    if (/taxable|grand\s*total|po\s*total|sub\s*total|^total\b|cgst|sgst|igst|amount\s*in\s*words|payment|terms|remit/i.test(l)) break;
    const toks = l.split(/\s+/).filter(Boolean);
    if (toks.length < pre.length + post.length + 1) continue;   // not enough cells → not a data row
    const rec = { line_no: lineNo, description: '', hsn_sac: '', quantity: null,
      unit: '', rate: null, unit_price: null, gst_rate: null, amount: null };
    pre.forEach((k, idx) => assignCol(rec, k, toks[idx]));                    // leading cols
    post.forEach((k, idx) => assignCol(rec, k, toks[toks.length - post.length + idx])); // trailing cols
    rec.description = toks.slice(pre.length, toks.length - post.length).join(' '); // the middle
    if (rec.description || rec.amount != null) { items.push(rec); lineNo++; }
  }
  return items;
}

function allGstins(ls) {
  const out = [];
  ls.forEach((l) => { const m = l.match(GSTIN_RE); if (m) out.push({ gstin: m[0], line: l }); });
  return out;
}

function parseInvoice(text) {
  const ls = lines(text);
  const gs = allGstins(ls);
  const buyer = gs.find((g) => /bill\s*to|buyer|consignee|ship\s*to/i.test(g.line));
  const seller = gs.find((g) => g !== buyer);
  // vendor name = first non-generic header line
  const vname = (ls.find((l) => !/^(tax\s*invoice|invoice|gstin|bill\s*to)/i.test(l)
    && /[A-Za-z]{3,}/.test(l)) || '').replace(/\s{2,}.*$/, '');
  const poref = fieldValue(text, ['buyer\\s*po\\s*ref', 'po\\s*ref', 'p\\.?o\\.?\\s*no', 'purchase\\s*order', 'po']);
  const cgst = grabTax(text, 'cgst');
  const sgst = grabTax(text, 'sgst');
  const igst = grabTax(text, 'igst');
  let tax = toNum(fieldValue(text, ['tax\\s*amount', 'total\\s*tax', 'gst\\s*amount']));
  if (tax == null && (cgst != null || sgst != null || igst != null)) tax = (cgst || 0) + (sgst || 0) + (igst || 0);
  const poval = poref.match(/(PO|PR)?[-\s]?\d+/i);
  return {
    invoice_number: idValue(text, ['invoice\\s*no', 'invoice\\s*number', 'bill\\s*no', 'inv\\s*no']),
    invoice_date: toIso(fieldValue(text, ['invoice\\s*date', 'date\\s*of\\s*issue', 'dated', 'date'])),
    vendor_name: vname,
    vendor_gstin: seller ? seller.gstin : '',
    buyer_gstin: buyer ? buyer.gstin : '',
    references: poval ? [{ value: poval[0].replace(/\s/g, ''), kind: 'buyer_pr_po', handwritten: false }] : [],
    taxable_total: toNum(fieldValue(text, ['taxable\\s*value', 'taxable', 'sub\\s*total', 'net\\s*amount'])),
    tax_total: tax,
    total: toNum(fieldValue(text, ['grand\\s*total', 'total\\s*due', 'amount\\s*payable', 'invoice\\s*total', 'total'])),
    lines: parseLineItems(ls),
  };
}

function parsePo(text) {
  const ls = lines(text);
  const gs = allGstins(ls);
  const vendor = gs.find((g) => /vendor|supplier/i.test(g.line));
  const buyer = gs.find((g) => g !== vendor);
  const vname = fieldValue(text, ['vendor', 'supplier']) || '';
  return {
    po_number: idValue(text, ['po\\s*number', 'po\\s*no', 'purchase\\s*order\\s*no', 'purchase\\s*order']),
    pr_number: idValue(text, ['pr\\s*number', 'pr\\s*no', 'requisition\\s*no']),
    vendor_name: vname.replace(/\s{2,}.*$/, ''),
    vendor_gstin: vendor ? vendor.gstin : (gs[1] ? gs[1].gstin : ''),
    buyer_gstin: buyer ? buyer.gstin : '',
    requisition_date: toIso(fieldValue(text, ['requisition\\s*date', 'po\\s*date', 'order\\s*date', 'date'])),
    total: toNum(fieldValue(text, ['po\\s*total', 'grand\\s*total', 'total'])),
    lines: parseLineItems(ls),
  };
}

function parseDoc(text, kind) { return kind === 'po' ? parsePo(text) : parseInvoice(text); }

// ---- n8n Code-node entrypoint (safe no-op under Node) --------------------- //
if (typeof $input !== 'undefined') {
  // Expects two "Extract from File" nodes upstream named as below, each exposing
  // the extracted text in json.text.
  const invText = $('Extract invoice text').first().json.text;
  const poText = $('Extract PO text').first().json.text;
  return [{ json: { invoice: parseInvoice(invText), pos: [parsePo(poText)], opts: {} } }]; // eslint-disable-line
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseInvoice, parsePo, parseDoc };
}
