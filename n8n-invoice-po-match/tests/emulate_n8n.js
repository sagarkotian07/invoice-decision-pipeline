'use strict';
/*
 * Emulate n8n's Code-node execution to prove the embedded workflow code runs
 * end-to-end (Webhook → Prepare → Normalize → Match → Build CSV → Respond) using
 * the ACTUAL jsCode stored in invoice_po_match.workflow.json.  node tests/emulate_n8n.js
 */
const fs = require('fs');
const path = require('path');

const wf = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'workflow', 'invoice_po_match.workflow.json'), 'utf8'));
const scenarios = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'samples', 'scenarios.json'), 'utf8'));

const codeOf = (name) => wf.nodes.find((n) => n.name === name).parameters.jsCode;

// Minimal n8n Code-node runtime: build $input over a list of items and run jsCode.
function runCode(jsCode, items, nodeOutputs) {
  const $input = {
    first: () => items[0],
    last: () => items[items.length - 1],
    all: () => items,
    item: items[0],
  };
  // $('Node Name') accessor for cross-node refs (unused on the main path)
  const $ = (n) => ({ first: () => (nodeOutputs[n] || [{ json: {} }])[0], all: () => nodeOutputs[n] || [] });
  const fn = new Function('$input', '$', 'Buffer', `${jsCode}`);
  return fn($input, $, Buffer);
}

// --- happy path scenario through the real node code ---
const sc = scenarios[0]; // 01_happy_match
const outputs = {};
let items = [{ json: { body: { payload: { invoice: sc.invoice, pos: sc.pos, opts: sc.opts || {} } } } }];

for (const nodeName of ['Prepare payload', 'Normalize', 'Match (2-way GST)', 'Build CSV rows']) {
  items = runCode(codeOf(nodeName), items, outputs);
  outputs[nodeName] = items;
}
const final = items[0].json;

console.log('Ran workflow node code on', sc.name);
console.log('  result       :', final.result);
console.log('  matched PO   :', final.header.matched_po_numbers);
console.log('  filename     :', final.filename);
console.log('  csv_base64 ok:', typeof final.csv_base64 === 'string' && final.csv_base64.length > 0);
console.log('  binary ok    :', !!items[0].binary && !!items[0].binary.data);

const csv = Buffer.from(final.csv_base64, 'base64').toString('utf8');
console.log('\n--- decoded CSV (first 3 lines) ---');
console.log(csv.split('\n').slice(0, 3).join('\n'));

// --- FREE upload path: Extract → Parse text → canonical → Match (real node code) ---
const cp = require('child_process');
const P = require('path');
const pdfText = (f) => cp.execFileSync('python3', ['-c',
  'import sys;from pypdf import PdfReader;print("\\n".join((p.extract_text() or "") for p in PdfReader(sys.argv[1]).pages))',
  P.join(__dirname, '..', 'samples', f)], { encoding: 'utf8' });

const extractOutputs = {
  'Extract invoice text': [{ json: { text: pdfText('invoice_sample.pdf') } }],
  'Extract PO text': [{ json: { text: pdfText('po_sample.pdf') } }],
};
let up = runCode(codeOf('Parse text → canonical'), [{ json: {} }], extractOutputs); // reads via $()
for (const n of ['Normalize', 'Match (2-way GST)', 'Build CSV rows']) up = runCode(codeOf(n), up, {});
const upFinal = up[0].json;
console.log('\nFREE upload path (Extract→Parse→Match):', upFinal.result, '| PO', upFinal.header.matched_po_numbers);
const uploadOk = upFinal.result === 'Match' && upFinal.csv_base64;

// --- error path: no payload should throw a helpful message ---
let threw = '';
try { runCode(codeOf('Prepare payload'), [{ json: { body: {} } }], {}); }
catch (e) { threw = e.message; }
const helpful = /ocr|payload/i.test(threw);
console.log('no-payload error path:', helpful ? 'OK (helpful error)' : 'UNEXPECTED: ' + threw);

const ok = final.result === 'Match' && final.csv_base64 && items[0].binary && helpful && uploadOk;
console.log('\n' + (ok ? 'PASS — n8n code path works end-to-end' : 'FAIL'));
process.exit(ok ? 0 : 1);
