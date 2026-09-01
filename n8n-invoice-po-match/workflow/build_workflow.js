'use strict';
/*
 * build_workflow.js — assemble invoice_po_match.workflow.json from the tested code
 * files, so the code embedded in the n8n Code nodes is byte-identical to what the
 * Node test harness validates. Run:  node workflow/build_workflow.js
 *
 * Graph (FREE path — no API key):
 *   Webhook ─▶ Route (mode==sample?)
 *      ├─ true  ▶ Prepare payload ───────────────────────────────────┐
 *      └─ false ▶ Extract invoice text ─┐                            │
 *                Extract PO text ───────┴▶ Merge ▶ Parse text → canonical ─┴▶ Normalize ▶ Match ▶ Build CSV ▶ Respond
 *
 * The Nanonets OCR nodes are included but DISCONNECTED (optional, for scanned PDFs
 * once you have a valid extraction key — see the sticky note).
 */
const fs = require('fs');
const path = require('path');

const here = __dirname;
const read = (f) => fs.readFileSync(path.join(here, 'code', f), 'utf8');
const normalizeJs = read('normalize.js');
const matcherJs = read('matcher.js');
const toRowsJs = read('to_rows.js');
const parseTextJs = read('parse_text.js');
const ocrMapJs = read('ocr_nanonets.js');

const PREPARE_JS = `// Sample / JSON-payload mode. index.html posts a form field "payload"
// containing canonical {invoice, pos, opts}.
const body = ($input.first().json.body) || {};
let payload = body.payload;
if (!payload) { throw new Error('No JSON payload. Send {payload:{...}} (sample), or upload PDFs.'); }
if (typeof payload === 'string') payload = JSON.parse(payload);
return [{ json: payload }];`;

const PREP_FILES_JS = `// The webhook stores uploaded files under binary keys that vary by n8n version
// (invoice/po, or file0/file1, or data/data1...). Normalise them to 'invoice' and
// 'po' so the two Extract-from-File nodes have a stable field to read.
// Strategy: filename hint first (…invoice…, …po/purchase/order…), else upload order
// (the front-end always sends the invoice first, the PO second).
const item = $input.first();
const bin = item.binary || {};
const keys = Object.keys(bin);
if (keys.length < 2) {
  throw new Error('Expected 2 uploaded files (invoice + PO). Binary keys present: [' + keys.join(', ') + ']');
}
let invKey, poKey;
for (const k of keys) {
  const n = String(bin[k].fileName || '').toLowerCase();
  if (!invKey && /inv/.test(n)) invKey = k;
  else if (!poKey && /(purchase|order|\\bpo\\b|_po|po[-_ ])/.test(n)) poKey = k;
}
invKey = invKey || keys[0];
poKey = poKey || keys.find((k) => k !== invKey) || keys[1];
return [{ json: item.json, binary: { invoice: bin[invKey], po: bin[poKey] } }];`;

const codeNode = (name, id, pos, jsCode) => ({
  parameters: { jsCode }, id, name,
  type: 'n8n-nodes-base.code', typeVersion: 2, position: pos,
});

const extractNode = (name, id, pos, field) => ({
  parameters: { operation: 'pdf', binaryPropertyName: field, options: {} },
  id, name, type: 'n8n-nodes-base.extractFromFile', typeVersion: 1, position: pos,
});

const httpOcr = (name, id, pos, field, envVar) => ({
  parameters: {
    method: 'POST',
    url: `=https://app.nanonets.com/api/v2/OCR/Model/{{ $env.${envVar} }}/LabelFile/`,
    authentication: 'genericCredentialType', genericAuthType: 'httpBasicAuth',
    sendBody: true, contentType: 'multipart-form-data',
    bodyParameters: { parameters: [{ parameterType: 'formBinaryData', name: 'file', inputDataFieldName: field }] },
    options: {},
  },
  id, name, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: pos,
});

const nodes = [
  {
    parameters: {
      httpMethod: 'POST', path: 'invoice-po-match', responseMode: 'responseNode',
      options: { allowedOrigins: '*' },
    },
    id: 'node-webhook', name: 'Webhook (upload)', type: 'n8n-nodes-base.webhook',
    typeVersion: 2, position: [160, 420], webhookId: 'invoice-po-match',
  },
  {
    parameters: {
      conditions: {
        options: { caseSensitive: true, typeValidation: 'loose', version: 2 },
        combinator: 'and',
        conditions: [{ id: 'c-sample', leftValue: '={{ $json.body.mode }}', rightValue: 'sample',
          operator: { type: 'string', operation: 'equals' } }],
      }, options: {},
    },
    id: 'node-route', name: 'Route (mode==sample?)', type: 'n8n-nodes-base.if',
    typeVersion: 2, position: [400, 420],
  },
  codeNode('Prepare payload', 'node-prepare', [640, 260], PREPARE_JS),
  codeNode('Prep uploaded files', 'node-prep', [640, 480], PREP_FILES_JS),
  extractNode('Extract invoice text', 'node-xinv', [860, 420], 'invoice'),
  extractNode('Extract PO text', 'node-xpo', [860, 560], 'po'),
  {
    parameters: { mode: 'combine', combineBy: 'combineByPosition', options: {} },
    id: 'node-merge', name: 'Merge', type: 'n8n-nodes-base.merge',
    typeVersion: 3, position: [1100, 520],
  },
  codeNode('Parse text → canonical', 'node-parse', [1320, 520], parseTextJs),
  codeNode('Normalize', 'node-normalize', [1540, 420], normalizeJs),
  codeNode('Match (2-way GST)', 'node-match', [1760, 420], matcherJs),
  codeNode('Build CSV rows', 'node-rows', [1980, 420], toRowsJs),
  {
    parameters: {
      respondWith: 'json', responseBody: '={{ $json }}',
      options: { responseHeaders: { entries: [{ name: 'Access-Control-Allow-Origin', value: '*' }] } },
    },
    id: 'node-respond', name: 'Respond (JSON + CSV)',
    type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1.1, position: [2200, 420],
  },
  // --- optional OCR sub-graph (DISCONNECTED template, for scanned PDFs) --- //
  httpOcr('OCR: parse invoice', 'node-ocr-inv', [640, 820], 'invoice', 'NANONETS_INVOICE_MODEL'),
  httpOcr('OCR: parse PO', 'node-ocr-po', [640, 960], 'po', 'NANONETS_PO_MODEL'),
  codeNode('Map OCR → canonical', 'node-ocr-map', [880, 890], ocrMapJs),
  {
    parameters: {
      content: [
        '## How it works (FREE — no API key)',
        'Uploaded PDFs go **Route → Extract invoice/PO text → Parse text → canonical**',
        'using n8n\'s built-in *Extract from File* (PDF text) + a Code node. No OCR',
        'service needed for born-digital (text-layer) PDFs.',
        '',
        '`mode=sample` runs canonical JSON directly (*Prepare payload*).',
        '',
        '### Optional OCR (scanned/image PDFs)',
        'The three **OCR** nodes below are a disconnected template. If you later get a',
        'valid Nanonets *extraction* key, set env `NANONETS_INVOICE_MODEL` /',
        '`NANONETS_PO_MODEL`, add an HTTP Basic Auth credential, and connect',
        'Route(false) → OCR nodes → Map OCR → Normalize instead of the Extract path.',
      ].join('\n'),
      height: 340, width: 430,
    },
    id: 'node-note', name: 'Notes', type: 'n8n-nodes-base.stickyNote',
    typeVersion: 1, position: [1100, 780],
  },
];

const connections = {
  'Webhook (upload)': { main: [[{ node: 'Route (mode==sample?)', type: 'main', index: 0 }]] },
  'Route (mode==sample?)': { main: [
    [{ node: 'Prepare payload', type: 'main', index: 0 }],                                  // true  → sample
    [{ node: 'Prep uploaded files', type: 'main', index: 0 }],                              // false → free extract
  ] },
  'Prep uploaded files': { main: [[
    { node: 'Extract invoice text', type: 'main', index: 0 },
    { node: 'Extract PO text', type: 'main', index: 0 },
  ]] },
  'Extract invoice text': { main: [[{ node: 'Merge', type: 'main', index: 0 }]] },
  'Extract PO text': { main: [[{ node: 'Merge', type: 'main', index: 1 }]] },
  'Merge': { main: [[{ node: 'Parse text → canonical', type: 'main', index: 0 }]] },
  'Parse text → canonical': { main: [[{ node: 'Normalize', type: 'main', index: 0 }]] },
  'Prepare payload': { main: [[{ node: 'Normalize', type: 'main', index: 0 }]] },
  'Normalize': { main: [[{ node: 'Match (2-way GST)', type: 'main', index: 0 }]] },
  'Match (2-way GST)': { main: [[{ node: 'Build CSV rows', type: 'main', index: 0 }]] },
  'Build CSV rows': { main: [[{ node: 'Respond (JSON + CSV)', type: 'main', index: 0 }]] },
};

const workflow = {
  name: 'Invoice ↔ PO two-way match (GST, free parser)',
  nodes, connections, settings: { executionOrder: 'v1' }, active: false,
};

const out = path.join(here, 'invoice_po_match.workflow.json');
fs.writeFileSync(out, JSON.stringify(workflow, null, 2));
JSON.parse(fs.readFileSync(out, 'utf8'));
console.log('wrote', out, '(' + nodes.length + ' nodes)');
