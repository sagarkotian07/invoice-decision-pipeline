'use strict';
/*
 * post_batch.js — POST a folder of PDFs (a batch of invoices + POs) to the live
 * reconciliation webhook and pretty-print the report. Live smoke test.
 *   node tests/post_batch.js <webhookUrl> [pdfDir]
 */
const fs = require('fs');
const path = require('path');

const url = process.argv[2];
const dir = process.argv[3] || path.join(__dirname, '..', 'demo-batches', '1-core');
if (!url) { console.error('usage: node tests/post_batch.js <webhookUrl> [pdfDir]'); process.exit(2); }

const MT = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
const files = fs.readdirSync(dir).filter((f) => MT[path.extname(f).toLowerCase()]).sort()
  .map((f) => ({ filename: f, content_type: MT[path.extname(f).toLowerCase()], content_base64: fs.readFileSync(path.join(dir, f)).toString('base64') }));
if (!files.length) { console.error('no PDFs in ' + dir); process.exit(2); }

(async () => {
  console.log('→ POST ' + url + '  (' + files.length + ' files from ' + path.basename(dir) + ')');
  const t0 = Date.now();
  let resp, text;
  try { resp = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ files }) }); text = await resp.text(); }
  catch (e) { console.error('✗ request failed: ' + e.message); process.exit(1); }
  console.log('← HTTP ' + resp.status + '  (' + (Date.now() - t0) + ' ms)\n');
  let r; try { r = JSON.parse(text); } catch (e) { console.log(text.slice(0, 1500)); process.exit(resp.ok ? 0 : 1); }
  if (!r.summary) { console.log(JSON.stringify(r, null, 2).slice(0, 1500)); process.exit(1); }

  const s = r.summary;
  console.log('SUMMARY  ' + s.documents + ' docs · ' + s.invoices + ' invoices · ' + s.pos + ' POs  →  ' +
    s.matched + ' matched · ' + s.po_missing + ' PO-missing · ' + s.invoice_missing + ' invoice-missing · ' +
    s.unreadable + ' unreadable · ' + s.duplicates + ' duplicate\n');
  console.log('MATCHED');
  (r.matched || []).forEach((m) => {
    const poShow = (m.pos && m.pos.length > 1) ? m.pos.map((p) => p.po_number).join('+') : m.po.po_number;
    console.log('  ' + pad(m.verdict.status, 9) + ' ' + (m.invoice.invoice_number || '?') + ' ↔ ' + poShow + '  via ' + m.basis
      + (m.relationship && m.relationship !== 'one-to-one' ? '  [' + m.relationship + ']' : '') + (m.duplicate ? '  [DUPLICATE]' : ''));
    if (m.line_check && m.line_check.applicable) console.log('             line: ' + m.line_check.summary + (m.line_check.flags.length ? ' — ' + m.line_check.flags.join('; ') : ''));
    if (m.gst_check && m.gst_check.applicable) console.log('             gst:  ' + m.gst_check.summary + (m.gst_check.rate_flags.concat(m.gst_check.hsn_flags).length ? ' — ' + m.gst_check.rate_flags.concat(m.gst_check.hsn_flags).join('; ') : ''));
    if (m.split_group) console.log('             split: ' + m.split_group.invoices + ' invoices = ' + m.split_group.cumulative + (m.split_group.over ? ' (over by ' + m.split_group.over + ')' : ''));
    if (m.cross_run) console.log('             ⚠ already processed: ' + m.cross_run.reason);
    if (m.cumulative) console.log('             ⚠ cumulative over-bill on ' + m.cumulative.po_number + ': prior ' + m.cumulative.prior_billed + ' + this ' + m.cumulative.this_batch + ' vs PO ' + m.cumulative.po_total + ' → over ' + m.cumulative.over);
  });
  if ((r.po_missing || []).length) { console.log('\nINVOICE WITH NO PO'); r.po_missing.forEach((x) => console.log('  ' + (x.invoice.invoice_number || x.invoice.filename) + '  — ' + x.reason)); }
  if ((r.invoice_missing || []).length) { console.log('\nPO WITH NO INVOICE'); r.invoice_missing.forEach((x) => console.log('  ' + x.po.po_number + ' (' + x.po.vendor + ')  — ' + x.reason)); }
  if ((r.unreadable || []).length) { console.log('\nUNREADABLE'); r.unreadable.forEach((x) => console.log('  ' + x.filename + '  — ' + x.reason)); }
  if ((r.duplicates || []).length) { console.log('\nDUPLICATES'); r.duplicates.forEach((x) => console.log('  [' + x.kind + '] ' + x.reason)); }
  if ((r.cross_run_duplicates || []).length) { console.log('\nALREADY PROCESSED (prior run)'); r.cross_run_duplicates.forEach((x) => console.log('  [' + x.kind + '] ' + (x.invoice.invoice_number || x.invoice.filename) + ' — ' + x.reason)); }
  if ((r.cumulative_flags || []).length) { console.log('\nCUMULATIVE OVER-BILLING'); r.cumulative_flags.forEach((x) => console.log('  PO ' + x.po_number + ': prior ' + x.prior_billed + ' + this ' + x.this_batch + ' vs PO ' + x.po_total + ' → over ' + x.over)); }
  if (r.memory_size !== undefined) console.log('\nMEMORY  ' + r.memory_size + ' invoice(s) remembered');
})();

function pad(s, n) { s = String(s); return s + ' '.repeat(Math.max(0, n - s.length)); }
