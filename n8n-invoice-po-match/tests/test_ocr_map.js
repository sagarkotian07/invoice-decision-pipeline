'use strict';
/*
 * Offline test of the Nanonets → canonical mapper, using a synthetic response in the
 * shape the docs describe (result[0].prediction[] + result[0].cells[]). Proves the
 * mapping → normalize → match chain works without calling the API. node tests/test_ocr_map.js
 */
const { nanonetsToCanonical } = require('../workflow/code/ocr_nanonets.js');
const { normalize } = require('../workflow/code/normalize.js');
const { runMatch } = require('../workflow/code/matcher.js');

const invoiceResp = { result: [{ prediction: [
  { label: 'invoice_number', ocr_text: 'INV-1001' },
  { label: 'invoice_date', ocr_text: '2025-06-10' },
  { label: 'seller_name', ocr_text: 'Sri Lakshmi Traders' },
  { label: 'seller_gstin', ocr_text: '29AABCS1429B1ZX' },
  { label: 'po_number', ocr_text: 'PO2279' },
  { label: 'cgst_amount', ocr_text: '900.00' },
  { label: 'sgst_amount', ocr_text: '900.00' },
  { label: 'total_amount', ocr_text: '11,800.00' },
], cells: [
  { row: 0, col: 0, label: 'description', ocr_text: 'Description' },
  { row: 1, col: 0, label: 'description', ocr_text: 'CPVC Pipe 1 inch' },
  { row: 1, col: 1, label: 'hsn', ocr_text: '3917' },
  { row: 1, col: 2, label: 'quantity', ocr_text: '100' },
  { row: 1, col: 3, label: 'unit_price', ocr_text: '100.00' },
  { row: 1, col: 4, label: 'gst_rate', ocr_text: '18%' },
  { row: 1, col: 5, label: 'line_amount', ocr_text: '11,800.00' },
] }] };

const poResp = { result: [{ prediction: [
  { label: 'po_number', ocr_text: 'PO2279' },
  { label: 'pr_number', ocr_text: 'PR2390' },
  { label: 'vendor_name', ocr_text: 'Sri Lakshmi Traders' },
  { label: 'vendor_gstin', ocr_text: '29AABCS1429B1ZX' },
  { label: 'po_date', ocr_text: '2025-06-01' },
  { label: 'total_amount', ocr_text: '11,800.00' },
], cells: [
  { row: 0, col: 0, label: 'description', ocr_text: 'Description' },
  { row: 1, col: 0, label: 'description', ocr_text: 'CPVC Pipe 1 inch' },
  { row: 1, col: 1, label: 'quantity', ocr_text: '100' },
  { row: 1, col: 2, label: 'unit_price', ocr_text: '100.00' },
  { row: 1, col: 3, label: 'amount', ocr_text: '10,000.00' },
] }] };

let pass = 0, fail = 0;
const ck = (n, c, x = '') => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + '  ' + x)); };

const invoice = nanonetsToCanonical(invoiceResp, 'invoice');
const po = nanonetsToCanonical(poResp, 'po');
console.log('mapped invoice:', JSON.stringify(invoice));
console.log('mapped PO     :', JSON.stringify(po));

ck('invoice number parsed', invoice.invoice_number === 'INV-1001');
ck('vendor gstin parsed', invoice.vendor_gstin === '29AABCS1429B1ZX');
ck('total parsed as number', invoice.total === 11800);
ck('split CGST+SGST summed to tax_total', invoice.tax_total === 1800, '(got ' + invoice.tax_total + ')');
ck('PO number → buyer_pr_po ref', invoice.references[0] && invoice.references[0].value === 'PO2279');
ck('invoice line parsed (header row dropped)', invoice.lines.length === 1 && invoice.lines[0].hsn_sac === '3917');
ck('gst_rate normalised to fraction', invoice.lines[0].gst_rate === 0.18, '(got ' + invoice.lines[0].gst_rate + ')');
ck('PO requisition_date from po_date', po.requisition_date === '2025-06-01');
ck('PO total parsed', po.total === 11800);

const norm = normalize({ invoice, pos: [po], opts: {} });
const res = runMatch(norm, {});
console.log('\nverdict:', res.header.result, '| basis:', res.header.match_basis, '| flags:', res.header.flags.join('; ') || '(none)');
ck('end-to-end verdict = Match', res.header.result === 'Match', '(got ' + res.header.result + ')');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
