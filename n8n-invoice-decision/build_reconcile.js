'use strict';
/*
 * build_reconcile.js — assemble reconcile.workflow.json from the tested
 * reconcile-engine.js, so the logic in the n8n Code nodes is byte-identical to
 * what tests/emulate-reconcile.js + tests/emulate-nodes-reconcile.js validate.
 *
 *   node build_reconcile.js
 *
 * Graph (batch fan-out → aggregate → reconcile):
 *   Webhook ▶ Split Files (1 item/PDF) ▶ Claude Extract (per file) ▶ Parse Doc ▶ Reconcile ▶ Respond
 */
const fs = require('fs');
const path = require('path');

const ENGINE = fs.readFileSync(path.join(__dirname, 'code', 'reconcile-engine.js'), 'utf8');
const ENG = require('./code/reconcile-engine.js'); // for the actual DOC_SYSTEM_PROMPT text (shown on a canvas note)
const body = (driver) => ENGINE + '\n\n// ===== NODE DRIVER =====\n' + driver.trim() + '\n';

// Claude Header Auth credential (from deploy.local.json / env), same as the
// invoice workflow — instance blocks $env, so we authenticate via a credential.
let localCfg = {};
try { localCfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'deploy.local.json'), 'utf8')); } catch (e) { /* portable $env build */ }
const CRED_ID = process.env.CLAUDE_CRED_ID || localCfg.CLAUDE_CRED_ID || '';
const CRED_TYPE = process.env.CLAUDE_CRED_TYPE || localCfg.CLAUDE_CRED_TYPE || 'httpHeaderAuth';
const CRED_NAME = process.env.CLAUDE_CRED_NAME || localCfg.CLAUDE_CRED_NAME || 'Anthropic x-api-key';

// ---------- node drivers -------------------------------------------------- //
const D_SPLIT = `
// Split the uploaded batch into ONE item per PDF, and attach the Claude request
// (classify + extract) for each. The webhook body is {files:[{filename, content_base64}]}.
const first = $input.first();
const b = (first.json && first.json.body) || first.json || {};
// Cross-run memory reset (for a clean demo): {reset_memory:true} wipes the ledger.
if (b.reset_memory) { $getWorkflowStaticData('global').ledger = []; }
const files = b.files || [];
if (!Array.isArray(files) || !files.length) throw new Error('No files. POST {files:[{filename, content_base64}]}');
const batch_id = ($execution && $execution.id ? String($execution.id) : 'batch') + '-' + Date.now();
return files.map((f, i) => {
  const data = String(f.content_base64 || '').replace(/^data:[^;]+;base64,/, '');
  const name = f.filename || ('doc-' + i + '.pdf');
  const media = guessMedia(f.content_type || name); // pdf → document block; jpg/png/… → image block
  return { json: { batch_id, index: i, filename: name, doc_count: files.length, pdf_base64: data, media_type: media, claude_request: buildDocRequest(data, media) } };
});
`;

const D_PARSE = `
// Pair each Claude response with its source file (by index) and turn it into a
// canonical document. Claude only perceives; classification is its output, not a decision.
const splits = $('Split Files').all();
return $input.all().map((item, i) => {
  const meta = splits[i] ? splits[i].json : { index: i };
  const resp = item.json || {};
  let tool = {};
  try { const tu = (resp.content || []).find(x => x.type === 'tool_use'); tool = tu ? tu.input : {}; } catch (e) { tool = {}; }
  return { json: parseDocument(tool, meta) };
});
`;

const D_RECONCILE = `
// Deterministic two-way reconciliation over the batch, PLUS cross-run memory:
// read the persistent ledger from the workflow's own static data, let reconcile()
// flag repeats + cumulative over-billing against it (flag-only), then persist this
// run's invoices (idempotent, stamped). No external store; empty ledger ⇒ today's output.
const sd = $getWorkflowStaticData('global');
const prior = Array.isArray(sd.ledger) ? sd.ledger : [];
const report = reconcile($input.all().map(i => i.json), prior);
const key = r => (String(r.vendor || '').toLowerCase().trim()) + '|' + (String(r.invoice_number || '').toUpperCase());
const seen = {}; prior.forEach(r => { seen[key(r)] = true; });
const stamp = new Date().toISOString();
(report.ledger_additions || []).forEach(rec => { const k = key(rec); if (rec.invoice_number && !seen[k]) { rec.run_at = stamp; prior.push(rec); seen[k] = true; } });
sd.ledger = prior;
report.memory_size = prior.length;
report.memory = prior.slice(-200);
delete report.ledger_additions;
return [{ json: report }];
`;

// ---------- node factories ------------------------------------------------ //
let idn = 0;
const nid = (name) => 'n' + (++idn) + '-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const codeNode = (name, pos, driver) => ({ parameters: { jsCode: body(driver) }, id: nid(name), name, type: 'n8n-nodes-base.code', typeVersion: 2, position: pos });

// Claude Extract HTTP node (runs once per file item).
const claudeHeaders = CRED_ID
  ? [{ name: 'anthropic-version', value: '2023-06-01' }, { name: 'content-type', value: 'application/json' }]
  : [{ name: 'x-api-key', value: '={{ $env.ANTHROPIC_API_KEY }}' }, { name: 'anthropic-version', value: '2023-06-01' }, { name: 'content-type', value: 'application/json' }];
let claudeAuth = {};
if (CRED_ID && CRED_TYPE === 'anthropicApi') claudeAuth = { authentication: 'predefinedCredentialType', nodeCredentialType: 'anthropicApi' };
else if (CRED_ID) claudeAuth = { authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth' };
const claudeNode = {
  parameters: Object.assign({
    method: 'POST', url: 'https://api.anthropic.com/v1/messages',
    sendHeaders: true, headerParameters: { parameters: claudeHeaders },
    sendBody: true, specifyBody: 'json', jsonBody: '={{ JSON.stringify($json.claude_request) }}',
    options: {},
  }, claudeAuth),
  id: nid('Claude Extract'), name: 'Claude Extract', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [500, 300],
  onError: 'continueRegularOutput',
};
if (CRED_ID) claudeNode.credentials = { [CRED_TYPE]: { id: CRED_ID, name: CRED_NAME } };

const nodes = [
  {
    parameters: { httpMethod: 'POST', path: 'invoice-decision', responseMode: 'responseNode', options: { allowedOrigins: '*' } },
    id: nid('Webhook'), name: 'Webhook (batch)', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [100, 300], webhookId: 'invoice-decision',
  },
  codeNode('Split Files', [300, 300], D_SPLIT),
  claudeNode,
  codeNode('Parse Doc', [700, 300], D_PARSE),
  codeNode('Reconcile', [900, 300], D_RECONCILE),
  {
    parameters: {
      respondWith: 'json', responseBody: '={{ $json }}',
      options: { responseHeaders: { entries: [{ name: 'Access-Control-Allow-Origin', value: '*' }, { name: 'Access-Control-Allow-Headers', value: '*' }] } },
    },
    id: nid('Respond'), name: 'Respond to Webhook', type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1.1, position: [1100, 300],
  },
  {
    parameters: {
      content: [
        '## PS-1 · Invoice ↔ PO Reconciliation',
        'Upload a **batch** of PDFs (invoices + POs). Claude **classifies + reads** each',
        'file (perception only); the deterministic **Reconcile** node matches invoices to',
        'POs, flags **PO-missing** and **invoice-missing** on both sides, and gives each',
        'matched pair a reasoned amount verdict. The LLM never decides.',
        '',
        'Body: `{files:[{filename, content_base64}]}`. Auth via the Header Auth credential.',
      ].join('\n'),
      height: 240, width: 440,
    },
    id: nid('Notes'), name: 'Notes', type: 'n8n-nodes-base.stickyNote', typeVersion: 1, position: [100, 20],
  },
  {
    // A visible copy of the exact system prompt Claude is given — sits right above
    // the "Claude Extract" node so it can be pointed at in a demo.
    parameters: {
      content: [
        '## 🧠 System prompt given to Claude',
        'Sent as the `system` field on every "Claude Extract" call. It is **extraction guidance only** —',
        'how to read the page. It contains **no matching or decision logic** (that lives in the *Reconcile* node).',
        '',
        '```',
        ENG.DOC_SYSTEM_PROMPT,
        '```',
      ].join('\n'),
      height: 500, width: 620,
    },
    id: nid('System Prompt Note'), name: 'System prompt (Claude)', type: 'n8n-nodes-base.stickyNote', typeVersion: 1, position: [420, -420],
  },
];

const c = (from, to) => ({ [from]: { main: [[{ node: to, type: 'main', index: 0 }]] } });
const connections = Object.assign(
  c('Webhook (batch)', 'Split Files'),
  c('Split Files', 'Claude Extract'),
  c('Claude Extract', 'Parse Doc'),
  c('Parse Doc', 'Reconcile'),
  c('Reconcile', 'Respond to Webhook'),
);

const workflow = {
  name: 'PS-1 · Invoice ↔ PO Reconciliation (Claude classify + deterministic match)',
  nodes, connections, settings: { executionOrder: 'v1' }, active: false,
};

const out = path.join(__dirname, 'reconcile.workflow.json');
fs.writeFileSync(out, JSON.stringify(workflow, null, 2));
JSON.parse(fs.readFileSync(out, 'utf8'));
console.log('wrote', path.relative(process.cwd(), out), '(' + nodes.length + ' nodes)', CRED_ID ? '· Claude cred ' + CRED_ID : '· $env auth');
