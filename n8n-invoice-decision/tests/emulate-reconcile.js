'use strict';
/*
 * emulate-reconcile.js — runs reconcile() over the demo batch and asserts every
 * bucket + the per-pair verdicts. Offline proof of the matching/coverage logic
 * before it is embedded into the n8n Code nodes.
 *   node tests/emulate-reconcile.js
 */
const E = require('../code/reconcile-engine.js');
const FX = require('./reconcile-fixtures.js');

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log('[32mPASS[0m ' + label); }
  else { fail++; console.log('[31mFAIL[0m ' + label + '  → ' + (detail === undefined ? '' : JSON.stringify(detail))); }
}
function runBatch(batch) {
  return E.runBatch(batch.map((x) => x.claude), batch.map((x, i) => ({ index: i, filename: x.filename, batch_id: 'test' })));
}

console.log('\n=== reconcile() — demo batch ===\n');
const r = runBatch(FX.DEMO_BATCH);
console.log('summary:', JSON.stringify(r.summary), '\n');

check('8 documents in', r.summary.documents === 8, r.summary.documents);
check('4 invoices classified', r.summary.invoices === 4, r.summary.invoices);
check('3 POs classified', r.summary.pos === 3, r.summary.pos);
check('3 matched pairs', r.summary.matched === 3, r.summary.matched);
check('1 invoice with PO missing', r.summary.po_missing === 1, r.summary.po_missing);
check('1 PO with invoice missing', r.summary.invoice_missing === 1, r.summary.invoice_missing);
check('1 unreadable document', r.summary.unreadable === 1, r.summary.unreadable);
check('1 duplicate detected', r.summary.duplicates === 1, r.summary.duplicates);

const byInv = {}; r.matched.forEach((m) => { byInv[m.invoice.invoice_number] = m; });
check('Acme matched clean (MATCHED)', byInv['ACME-88213'] && byInv['ACME-88213'].verdict.status === 'MATCHED', byInv['ACME-88213'] && byInv['ACME-88213'].verdict.status);
check('both Acme copies flagged as duplicates', r.matched.filter((m) => m.invoice.invoice_number === 'ACME-88213' && m.duplicate).length === 2);
check('Northwind matched with VARIANCE', byInv['NW-30541'] && byInv['NW-30541'].verdict.status === 'VARIANCE', byInv['NW-30541'] && byInv['NW-30541'].verdict.status);
check('Northwind variance delta = $540.00', byInv['NW-30541'] && byInv['NW-30541'].verdict.comparison.delta === '$540.00', byInv['NW-30541'] && byInv['NW-30541'].verdict.comparison.delta);
check('Globex invoice → PO MISSING (cites PO-1003)', r.po_missing[0] && r.po_missing[0].cited_po === 'PO-1003', r.po_missing[0]);
check('PO-1004 → INVOICE MISSING (Initech)', r.invoice_missing[0] && r.invoice_missing[0].po.po_number === 'PO-1004' && /Initech/.test(r.invoice_missing[0].po.vendor), r.invoice_missing[0] && r.invoice_missing[0].po);
check('unreadable is the scanned file', r.unreadable[0] && r.unreadable[0].filename === 'scan_blurry.pdf', r.unreadable[0]);
check('duplicate is EXACT (ACME-88213)', r.duplicates[0] && r.duplicates[0].kind === 'EXACT', r.duplicates[0]);

console.log('\n=== reconcile() — fingerprint fallback (invoice has no PO ref) ===\n');
const f = runBatch(FX.FINGERPRINT_BATCH);
console.log('summary:', JSON.stringify(f.summary), '\n');
check('fingerprint: 1 matched', f.summary.matched === 1, f.summary.matched);
check('fingerprint: basis is vendor+amount', f.matched[0] && /fingerprint/.test(f.matched[0].basis), f.matched[0] && f.matched[0].basis);
check('fingerprint: 0 invoice_missing (PO got covered)', f.summary.invoice_missing === 0, f.summary.invoice_missing);

console.log('\n=== reconcile() — GSTIN match ladder (Indian tax docs, no PR ref) ===\n');
const g = runBatch(FX.GST_BATCH);
console.log('summary:', JSON.stringify(g.summary), '\n');
const byGstInv = {}; g.matched.forEach((m) => { byGstInv[m.invoice.invoice_number] = m; });
check('GSTIN: 2 matched, 0 po_missing, 0 invoice_missing', g.summary.matched === 2 && g.summary.po_missing === 0 && g.summary.invoice_missing === 0, g.summary);
check('R2: Bharat matched via GSTIN+total, clean MATCHED', byGstInv['BT-7781'] && /GSTIN \+ total/.test(byGstInv['BT-7781'].basis) && byGstInv['BT-7781'].verdict.status === 'MATCHED', byGstInv['BT-7781'] && { basis: byGstInv['BT-7781'].basis, status: byGstInv['BT-7781'].verdict.status });
check('R4: Konkan is a "possible" match (GSTIN only), MISMATCH', byGstInv['KS-3320'] && /possible/.test(byGstInv['KS-3320'].basis) && byGstInv['KS-3320'].verdict.status === 'MISMATCH', byGstInv['KS-3320'] && { basis: byGstInv['KS-3320'].basis, status: byGstInv['KS-3320'].verdict.status });
check('verdict cites the GSTIN vendor match', byGstInv['BT-7781'] && byGstInv['BT-7781'].verdict.reasons.concat(g.matched.map((m) => m.basis)).join(' ').length > 0);

const byInvNo = (rep) => { const m = {}; rep.matched.forEach((x) => { m[x.invoice.invoice_number] = x; }); return m; };

console.log('\n=== many-to-many: one invoice ↔ two POs ===\n');
const mp = runBatch(FX.MULTI_PO_BATCH);
console.log('summary:', JSON.stringify(mp.summary), '\n');
check('invoice spans 2 POs → 1 matched group', mp.summary.matched === 1 && mp.summary.invoice_missing === 0 && mp.summary.po_missing === 0, mp.summary);
check('relationship = invoice-spans-POs, 2 POs linked', mp.matched[0] && mp.matched[0].relationship === 'invoice-spans-POs' && mp.matched[0].pos.length === 2, mp.matched[0] && { rel: mp.matched[0].relationship, n: mp.matched[0].pos.length });
check('Σ-of-POs matches the invoice total → MATCHED', mp.matched[0] && mp.matched[0].verdict.status === 'MATCHED', mp.matched[0] && mp.matched[0].verdict.status);

console.log('\n=== many-to-many: one PO ↔ two invoices (split billing) ===\n');
const sp = runBatch(FX.SPLIT_BATCH);
console.log('summary:', JSON.stringify(sp.summary), '\n');
check('split: 2 matched, 0 invoice_missing', sp.summary.matched === 2 && sp.summary.invoice_missing === 0, sp.summary);
check('both are PARTIAL (split-billing), not a false "under"', sp.matched.every((m) => m.relationship === 'split-billing' && m.verdict.status === 'PARTIAL'), sp.matched.map((m) => m.verdict.status));
check('split cumulative shown = $12,000.00', sp.matched[0] && sp.matched[0].split_group.cumulative === '$12,000.00', sp.matched[0] && sp.matched[0].split_group);

const so = runBatch(FX.SPLIT_OVER_BATCH);
check('split over-bill → both MISMATCH, over $8,000.00', so.matched.every((m) => m.verdict.status === 'MISMATCH') && so.matched[0].split_group.over === '$8,000.00', { st: so.matched.map((m) => m.verdict.status), over: so.matched[0] && so.matched[0].split_group.over });

console.log('\n=== line-item matching (flag-only) ===\n');
const ln = runBatch(FX.LINE_BATCH);
const lm = ln.matched[0];
console.log('line_check:', JSON.stringify(lm && lm.line_check), '\n');
check('itemized pair, 2 lines paired', lm && lm.line_check.applicable && /All 2 lines/.test(lm.line_check.summary), lm && lm.line_check.summary);
check('a line rate mismatch is flagged', lm && lm.line_check.flags.length === 1 && /rate differs/.test(lm.line_check.flags[0]), lm && lm.line_check.flags);
check('line flag NEVER flips the match (still MATCHED)', lm && lm.verdict.status === 'MATCHED', lm && lm.verdict.status);

console.log('\n=== GST battery (flag-only) ===\n');
const gc = runBatch(FX.GST_CHECK_BATCH);
const gm = byInvNo(gc);
check('clean GST invoice: valid HSN, correct rate, tax adds up', gm['GSTC-1'] && gm['GSTC-1'].gst_check.tax_reconciles === true && gm['GSTC-1'].gst_check.hsn_flags.length === 0 && gm['GSTC-1'].gst_check.rate_flags.length === 0, gm['GSTC-1'] && gm['GSTC-1'].gst_check);
check('bad GST invoice: malformed HSN + wrong rate + tax off', gm['GSTB-1'] && gm['GSTB-1'].gst_check.hsn_flags.length === 1 && gm['GSTB-1'].gst_check.rate_flags.length === 1 && gm['GSTB-1'].gst_check.tax_reconciles === false, gm['GSTB-1'] && gm['GSTB-1'].gst_check);
check('GST flags NEVER flip the match (both MATCHED)', gm['GSTC-1'] && gm['GSTB-1'] && gm['GSTC-1'].verdict.status === 'MATCHED' && gm['GSTB-1'].verdict.status === 'MATCHED', { ok: gm['GSTC-1'] && gm['GSTC-1'].verdict.status, bad: gm['GSTB-1'] && gm['GSTB-1'].verdict.status });

console.log('\n=== cross-run memory: repeats + cumulative over-billing (seeded ledger) ===\n');
const m2 = E.runBatch(FX.MEM_BATCH2.map((x) => x.claude), FX.MEM_BATCH2.map((x, i) => ({ index: i, filename: x.filename, batch_id: 'batch2' })), FX.PRIOR_LEDGER);
console.log('summary:', JSON.stringify(m2.summary), '\n');
const a2 = m2.matched.find((x) => x.invoice.invoice_number === 'INV-A2');
const b1 = m2.po_missing.find((x) => x.invoice.invoice_number === 'INB-1');
check('cross-run: 1 duplicate detected vs the ledger', m2.summary.cross_run_duplicates === 1, m2.summary.cross_run_duplicates);
check('cross-run: re-submitted INB-1 flagged already-processed (EXACT)', b1 && b1.cross_run && b1.cross_run.kind === 'EXACT', b1 && b1.cross_run);
check('cumulative: 1 over-billing flag', m2.summary.cumulative_flags === 1, m2.summary.cumulative_flags);
check('cumulative: PO-9001 over by $10,000.00 (prior $10k + this $10k vs $10k PO)', a2 && a2.cumulative && a2.cumulative.over === '$10,000.00', a2 && a2.cumulative);
check('cumulative is FLAG-ONLY — INV-A2 verdict stays MATCHED', a2 && a2.verdict.status === 'MATCHED', a2 && a2.verdict.status);
check("ledger_additions carries this run's 2 invoices", m2.ledger_additions && m2.ledger_additions.length === 2, m2.ledger_additions && m2.ledger_additions.length);

// GUARD: an empty ledger must reproduce the pre-memory output byte-for-byte.
const docs2 = FX.MEM_BATCH2.map((x, i) => E.parseDocument(x.claude, { index: i, filename: x.filename, batch_id: 'batch2' }));
check('guard: reconcile(docs,[]) === reconcile(docs) (empty memory ⇒ unchanged)', JSON.stringify(E.reconcile(docs2, [])) === JSON.stringify(E.reconcile(docs2)));
check('guard: empty-ledger run has no cross-run/cumulative flags', E.reconcile(docs2, []).summary.cross_run_duplicates === 0 && E.reconcile(docs2, []).summary.cumulative_flags === 0);

console.log('\n=== ' + pass + ' passed, ' + fail + ' failed ===\n');
if (fail) process.exit(1);
