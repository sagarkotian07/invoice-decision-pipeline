'use strict';
/*
 * nanonets_probe.js — prove the whole chain works on your machine, with your real
 * Nanonets models, WITHOUT n8n.
 *
 *   export NANONETS_API_KEY=...            # your key (username; password is blank)
 *   export NANONETS_INVOICE_MODEL=...      # model_id of the pretrained "Invoices" model
 *   export NANONETS_PO_MODEL=...           # model_id of the pretrained "Purchase Orders" model
 *   node tests/nanonets_probe.js [invoice.pdf] [po.pdf]
 *
 * It POSTs the two PDFs to Nanonets, prints the RAW response (so you can see the real
 * field labels), maps them to canonical, runs the two-way match, and writes the CSV to
 * samples/out/probe_result.csv. If a label differs from workflow/code/ocr_nanonets.js,
 * add the alias there and re-run.
 *
 * Set NANONETS_MOCK=1 to run the full chain against built-in synthetic responses
 * (no network, no key) — handy for a quick smoke test.
 */
const fs = require('fs');
const path = require('path');

const { nanonetsToCanonical } = require('../workflow/code/ocr_nanonets.js');
const { normalize } = require('../workflow/code/normalize.js');
const { runMatch } = require('../workflow/code/matcher.js');
const { toRows } = require('../workflow/code/to_rows.js');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'samples', 'out');
fs.mkdirSync(OUT, { recursive: true });

const invPdf = process.argv[2] || path.join(ROOT, 'samples', 'invoice_sample.pdf');
const poPdf = process.argv[3] || path.join(ROOT, 'samples', 'po_sample.pdf');

const NANONETS_URL = (model) => `https://app.nanonets.com/api/v2/OCR/Model/${model}/LabelFile/`;

async function callNanonets(pdfPath, model, apiKey) {
  const buf = fs.readFileSync(pdfPath);
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: 'application/pdf' }), path.basename(pdfPath));
  const res = await fetch(NANONETS_URL(model), {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(apiKey + ':').toString('base64') },
    body: fd,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Nanonets HTTP ${res.status}: ${text.slice(0, 400)}`);
  return JSON.parse(text);
}

// built-in synthetic responses for NANONETS_MOCK=1
const MOCK = {
  invoice: { result: [{ prediction: [
    { label: 'invoice_number', ocr_text: 'INV-1001' }, { label: 'invoice_date', ocr_text: '2025-06-10' },
    { label: 'seller_name', ocr_text: 'Sri Lakshmi Traders' }, { label: 'seller_gstin', ocr_text: '29AABCS1429B1ZX' },
    { label: 'po_number', ocr_text: 'PO2279' }, { label: 'cgst_amount', ocr_text: '900.00' },
    { label: 'sgst_amount', ocr_text: '900.00' }, { label: 'total_amount', ocr_text: '11,800.00' },
  ], cells: [
    { row: 1, col: 0, label: 'description', ocr_text: 'CPVC Pipe 1 inch' }, { row: 1, col: 1, label: 'hsn', ocr_text: '3917' },
    { row: 1, col: 2, label: 'quantity', ocr_text: '100' }, { row: 1, col: 3, label: 'unit_price', ocr_text: '100.00' },
    { row: 1, col: 4, label: 'gst_rate', ocr_text: '18%' }, { row: 1, col: 5, label: 'line_amount', ocr_text: '11,800.00' },
  ] }] },
  po: { result: [{ prediction: [
    { label: 'po_number', ocr_text: 'PO2279' }, { label: 'pr_number', ocr_text: 'PR2390' },
    { label: 'vendor_name', ocr_text: 'Sri Lakshmi Traders' }, { label: 'vendor_gstin', ocr_text: '29AABCS1429B1ZX' },
    { label: 'po_date', ocr_text: '2025-06-01' }, { label: 'total_amount', ocr_text: '11,800.00' },
  ], cells: [
    { row: 1, col: 0, label: 'description', ocr_text: 'CPVC Pipe 1 inch' }, { row: 1, col: 1, label: 'quantity', ocr_text: '100' },
    { row: 1, col: 2, label: 'unit_price', ocr_text: '100.00' }, { row: 1, col: 3, label: 'amount', ocr_text: '10,000.00' },
  ] }] },
};

async function main() {
  const mock = process.env.NANONETS_MOCK === '1';
  let invResp, poResp;

  if (mock) {
    console.log('NANONETS_MOCK=1 → using built-in synthetic responses (no network).\n');
    invResp = MOCK.invoice; poResp = MOCK.po;
  } else {
    const key = process.env.NANONETS_API_KEY;
    const invModel = process.env.NANONETS_INVOICE_MODEL;
    const poModel = process.env.NANONETS_PO_MODEL;
    const missing = [['NANONETS_API_KEY', key], ['NANONETS_INVOICE_MODEL', invModel], ['NANONETS_PO_MODEL', poModel]]
      .filter(([, v]) => !v).map(([k]) => k);
    if (missing.length) {
      console.error('Missing env var(s): ' + missing.join(', '));
      console.error('Set them (or run with NANONETS_MOCK=1) — see the header of this file.');
      process.exit(2);
    }
    console.log(`Calling Nanonets…\n  invoice: ${invPdf}\n  PO     : ${poPdf}\n`);
    [invResp, poResp] = await Promise.all([
      callNanonets(invPdf, invModel, key),
      callNanonets(poPdf, poModel, key),
    ]);
    fs.writeFileSync(path.join(OUT, 'nanonets_invoice_raw.json'), JSON.stringify(invResp, null, 2));
    fs.writeFileSync(path.join(OUT, 'nanonets_po_raw.json'), JSON.stringify(poResp, null, 2));
    console.log('Raw responses written to samples/out/nanonets_*_raw.json');
    console.log('\n--- INVOICE labels seen ---');
    console.log(labelSummary(invResp));
    console.log('--- PO labels seen ---');
    console.log(labelSummary(poResp));
  }

  const invoice = nanonetsToCanonical(invResp, 'invoice');
  const po = nanonetsToCanonical(poResp, 'po');
  console.log('\nMapped invoice:', JSON.stringify(invoice));
  console.log('Mapped PO     :', JSON.stringify(po));

  const norm = normalize({ invoice, pos: [po], opts: {} });
  const result = runMatch(norm, {});
  const rows = toRows(result);
  fs.writeFileSync(path.join(OUT, 'probe_result.csv'), rows.combined_csv);

  const h = result.header;
  console.log('\n==============================================');
  console.log('  VERDICT :', h.result, '  (basis:', h.match_basis + ',', h.confidence + ')');
  console.log('  vendor:', h.vendor_match, '| total:', h.total_match, '| dates_fy:', h.dates_fy);
  console.log('  flags  :', h.flags.length ? h.flags.join(' | ') : '(none)');
  if (h.reason) console.log('  reason :', h.reason);
  console.log('  CSV    : samples/out/probe_result.csv');
  console.log('==============================================');
}

function labelSummary(resp) {
  const r = (resp.result && resp.result[0]) || {};
  const preds = (r.prediction || []).map((p) => `${p.label}="${(p.ocr_text || '').slice(0, 24)}"`);
  const cellLabels = [...new Set((r.cells || []).map((c) => c.label))];
  return '  fields: ' + (preds.join(', ') || '(none)') + '\n  table cols: ' + (cellLabels.join(', ') || '(none)') + '\n';
}

main().catch((e) => { console.error('\nERROR:', e.message); process.exit(1); });
