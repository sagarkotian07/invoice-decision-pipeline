'use strict';
/*
 * Node test harness — runs the pipeline (normalize → matcher → to_rows) over every
 * scenario in samples/scenarios.json and checks the expected verdict + flags.
 *
 *   node tests/run.js
 *
 * This is the offline proof that the matching logic is correct, independent of the
 * OCR service and n8n. The same code files run unchanged inside the n8n Code nodes.
 */
const fs = require('fs');
const path = require('path');

const { normalize } = require('../workflow/code/normalize.js');
const { runMatch } = require('../workflow/code/matcher.js');
const { toRows } = require('../workflow/code/to_rows.js');

const scenarios = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'samples', 'scenarios.json'), 'utf8'));

let pass = 0, fail = 0;
const outDir = path.join(__dirname, '..', 'samples', 'out');
fs.mkdirSync(outDir, { recursive: true });

function check(name, cond, extra = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}   ${extra}`); }
}

for (const sc of scenarios) {
  const norm = normalize({ invoice: sc.invoice, pos: sc.pos, opts: sc.opts || {} });
  const result = runMatch(norm, norm.opts);
  const rows = toRows(result);
  fs.writeFileSync(path.join(outDir, `${sc.name}.csv`), rows.combined_csv);

  const h = result.header;
  const e = sc.expect || {};
  console.log(`\n${sc.name}  →  ${h.result || '(blank)'}   [${h.match_basis}]`);
  if (h.flags.length) console.log(`   flags: ${h.flags.join(' | ')}`);

  if (e.result !== undefined) check(`${sc.name}: result = ${e.result}`, h.result === e.result, `(got ${h.result})`);
  for (const f of e.flagsInclude || [])
    check(`${sc.name}: flag ~ "${f}"`, h.flags.some((x) => x.includes(f)), `(flags: ${h.flags.join('; ')})`);
  if (e.reasonInclude)
    check(`${sc.name}: reason ~ "${e.reasonInclude}"`, (h.reason || '').toLowerCase().includes(e.reasonInclude.toLowerCase()), `(reason: ${h.reason})`);
  if (e.basisInclude)
    check(`${sc.name}: basis ~ "${e.basisInclude}"`, h.match_basis.includes(e.basisInclude), `(basis: ${h.match_basis})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
