'use strict';
/*
 * deploy.js — push a workflow JSON to a live n8n instance via the public API,
 * then activate it. Targets by N8N_WORKFLOW_ID (so a renamed workflow still
 * updates the SAME live workflow + webhook URL), else falls back to matching by
 * name. Re-runnable after any build.
 *
 *   N8N_API_KEY=<key> N8N_WORKFLOW_ID=<id> node tests/deploy.js [workflowJsonPath]
 *   N8N_API_KEY=<key> node tests/deploy.js reconcile.workflow.json     (match by name)
 */
const fs = require('fs');
const path = require('path');

const KEY = process.env.N8N_API_KEY;
const BASE = (process.env.N8N_BASE || 'https://your-n8n-host.example.com').replace(/\/$/, '');
const WFID = process.env.N8N_WORKFLOW_ID || '';
if (!KEY) { console.error('set N8N_API_KEY'); process.exit(2); }

const wfPath = process.argv[2] || path.join(__dirname, '..', 'reconcile.workflow.json');
const wf = JSON.parse(fs.readFileSync(wfPath, 'utf8'));
const H = { 'X-N8N-API-KEY': KEY, accept: 'application/json', 'content-type': 'application/json' };

(async () => {
  let id = WFID;
  if (id) {
    const g = await fetch(BASE + '/api/v1/workflows/' + id, { headers: H });
    if (!g.ok) { console.error('✗ workflow id ' + id + ' not found (' + g.status + ')'); process.exit(1); }
    const cur = await g.json();
    console.log('target (by id): ' + id + '  | active=' + cur.active + '  | current name: ' + cur.name);
  } else {
    const list = await (await fetch(BASE + '/api/v1/workflows?limit=250', { headers: H })).json();
    const match = (list.data || []).find((w) => w.name === wf.name);
    if (!match) { console.error('✗ no workflow named "' + wf.name + '" on ' + BASE); process.exit(1); }
    id = match.id;
    console.log('target (by name): ' + id + '  | active=' + match.active + '  | ' + match.name);
  }
  const match = { id };

  // The public API only accepts these fields on update (extra keys are rejected).
  const body = { name: wf.name, nodes: wf.nodes, connections: wf.connections, settings: wf.settings || { executionOrder: 'v1' } };
  const put = await fetch(BASE + '/api/v1/workflows/' + match.id, { method: 'PUT', headers: H, body: JSON.stringify(body) });
  const putText = await put.text();
  console.log('PUT      → ' + put.status + (put.ok ? '  (nodes/connections updated: ' + wf.nodes.length + ' nodes)' : '  ' + putText.slice(0, 400)));
  if (!put.ok) process.exit(1);

  const act = await fetch(BASE + '/api/v1/workflows/' + match.id + '/activate', { method: 'POST', headers: H });
  const actText = await act.text();
  console.log('activate → ' + act.status + (act.ok ? '  (active)' : '  ' + actText.slice(0, 300)));
  process.exit(act.ok ? 0 : 1);
})().catch((e) => { console.error('✗ ' + e.message); process.exit(1); });
