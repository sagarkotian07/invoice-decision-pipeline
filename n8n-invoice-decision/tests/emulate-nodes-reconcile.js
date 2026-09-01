'use strict';
/*
 * emulate-nodes-reconcile.js — executes the ACTUAL jsCode embedded in
 * reconcile.workflow.json (Split Files → [mock Claude per file] → Parse Doc →
 * Reconcile) through a mock n8n runtime. Proves the shipped node strings work
 * end-to-end, including per-item order pairing AND the cross-run memory that the
 * Reconcile node persists via $getWorkflowStaticData('global').
 *   node tests/emulate-nodes-reconcile.js
 */
const fs = require('fs');
const path = require('path');
const FX = require('./reconcile-fixtures.js');

const WF = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'reconcile.workflow.json'), 'utf8'));
const nodeByName = {}; WF.nodes.forEach((n) => { nodeByName[n.name] = n; });

// `sd` is the persistent static-data object, shared across executions like n8n
// keeps it per-workflow. $getWorkflowStaticData('global') returns sd.global.
function runCode(node, inputItems, outputs, sd) {
  const fn = new Function('$input', '$json', '$', '$execution', '$env', '$getWorkflowStaticData', node.parameters.jsCode);
  const $input = { first: () => inputItems[0], all: () => inputItems, item: inputItems[0] };
  const $json = inputItems[0] ? inputItems[0].json : {};
  const $ = (name) => ({ first: () => (outputs[name] || [{ json: {} }])[0], all: () => outputs[name] || [] });
  const gwsd = (scope) => { const k = scope || 'global'; return sd[k] || (sd[k] = {}); };
  return fn($input, $json, $, { id: 'exec-test' }, {}, gwsd) || [];
}

// One full production execution over a batch, sharing the static-data object `sd`.
function runPipeline(batch, sd) {
  const outputs = {};
  const files = batch.map((x) => ({ filename: x.filename, content_base64: 'JVBERi0xLjQK' }));
  outputs['Webhook (batch)'] = [{ json: { body: { files } } }];
  outputs['Split Files'] = runCode(nodeByName['Split Files'], outputs['Webhook (batch)'], outputs, sd);
  outputs['Claude Extract'] = outputs['Split Files'].map((item, i) => ({ json: { content: [{ type: 'tool_use', name: 'emit_document', input: batch[i].claude }] } }));
  outputs['Parse Doc'] = runCode(nodeByName['Parse Doc'], outputs['Claude Extract'], outputs, sd);
  outputs['Reconcile'] = runCode(nodeByName['Reconcile'], outputs['Parse Doc'], outputs, sd);
  return { report: outputs['Reconcile'][0].json, splits: outputs['Split Files'] };
}

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log('[32mPASS[0m ' + label); }
  else { fail++; console.log('[31mFAIL[0m ' + label + '  → ' + JSON.stringify(detail)); }
}

console.log('\n=== node-level: real embedded jsCode over the demo batch ===\n');
const demo = runPipeline(FX.DEMO_BATCH, {});
const report = demo.report;
console.log('summary:', JSON.stringify(report.summary), '\n');
check('Split Files fanned out to 8 items', demo.splits.length === 8, demo.splits.length);
check('Split Files attached a claude_request', !!demo.splits[0].json.claude_request);
check('3 matched pairs', report.summary.matched === 3, report.summary.matched);
check('1 PO missing', report.summary.po_missing === 1, report.summary.po_missing);
check('1 invoice missing', report.summary.invoice_missing === 1, report.summary.invoice_missing);
check('1 unreadable', report.summary.unreadable === 1, report.summary.unreadable);
check('1 duplicate', report.summary.duplicates === 1, report.summary.duplicates);
check('Northwind pair = VARIANCE', report.matched.some((m) => m.invoice.invoice_number === 'NW-30541' && m.verdict.status === 'VARIANCE'));
check('Globex → PO MISSING (PO-1003)', report.po_missing[0] && report.po_missing[0].cited_po === 'PO-1003', report.po_missing[0]);
check('PO-1004 → INVOICE MISSING', report.invoice_missing[0] && report.invoice_missing[0].po.po_number === 'PO-1004', report.invoice_missing[0]);

console.log('\n=== node-level: cross-run memory persists via $getWorkflowStaticData ===\n');
const memSD = {}; // one persistent store shared by the two executions
const r1 = runPipeline(FX.MEM_BATCH1, memSD).report;
console.log('run1 summary:', JSON.stringify(r1.summary), '\n');
check('run 1 all clean, no cross-run flags yet', r1.summary.cross_run_duplicates === 0 && r1.summary.cumulative_flags === 0, r1.summary);
check('run 1 node WROTE the ledger — memory_size 2', r1.memory_size === 2, r1.memory_size);
const r2 = runPipeline(FX.MEM_BATCH2, memSD).report;
console.log('run2 summary:', JSON.stringify(r2.summary), '\n');
check('run 2 node READ the ledger — 1 cross-run duplicate', r2.summary.cross_run_duplicates === 1, r2.summary.cross_run_duplicates);
check('run 2 — 1 cumulative over-bill', r2.summary.cumulative_flags === 1, r2.summary.cumulative_flags);
check('INV-A2 flagged over-billed, verdict still MATCHED (flag-only)', r2.matched.some((m) => m.invoice.invoice_number === 'INV-A2' && m.cumulative && m.verdict.status === 'MATCHED'));
check('ledger persisted + grew to 3 (INV-A2 added, INB-1 idempotent)', r2.memory_size === 3, r2.memory_size);
check('memory echoed in the response (3 rows)', Array.isArray(r2.memory) && r2.memory.length === 3, r2.memory && r2.memory.length);

console.log('\n=== node-level: reset_memory wipes the ledger ===\n');
const outputs = {};
outputs['Webhook (batch)'] = [{ json: { body: { reset_memory: true, files: [{ filename: 'x.pdf', content_base64: 'JVBERi0xLjQK' }] } } }];
runCode(nodeByName['Split Files'], outputs['Webhook (batch)'], outputs, memSD);
check('reset_memory cleared the ledger', Array.isArray(memSD.global.ledger) && memSD.global.ledger.length === 0, memSD.global.ledger && memSD.global.ledger.length);

console.log('\n=== ' + pass + ' passed, ' + fail + ' failed ===\n');
if (fail) process.exit(1);
