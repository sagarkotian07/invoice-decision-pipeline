'use strict';
/*
 * local_probe.js — parse two real PDFs and match them, FREE and offline.
 * No Nanonets, no API key, no network.
 *
 *   node tests/local_probe.js [invoice.pdf] [po.pdf]
 *
 * PDF → text is done with pypdf (already installed: `python3 -c "from pypdf ..."`),
 * then the JS chain parse_text → normalize → matcher → to_rows produces the CSV
 * (samples/out/local_result.csv). The same JS runs in n8n behind its built-in
 * "Extract from File" node.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { parseInvoice, parsePo } = require('../workflow/code/parse_text.js');
const { normalize } = require('../workflow/code/normalize.js');
const { runMatch } = require('../workflow/code/matcher.js');
const { toRows } = require('../workflow/code/to_rows.js');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'samples', 'out');
fs.mkdirSync(OUT, { recursive: true });

const invPdf = process.argv[2] || path.join(ROOT, 'samples', 'invoice_sample.pdf');
const poPdf = process.argv[3] || path.join(ROOT, 'samples', 'po_sample.pdf');

function pdfText(p) {
  const py = 'import sys;from pypdf import PdfReader;' +
    'print("\\n".join((pg.extract_text() or "") for pg in PdfReader(sys.argv[1]).pages))';
  return execFileSync('python3', ['-c', py, p], { encoding: 'utf8' });
}

const invText = pdfText(invPdf);
const poText = pdfText(poPdf);

const invoice = parseInvoice(invText);
const po = parsePo(poText);
console.log('Parsed invoice:', JSON.stringify(invoice));
console.log('Parsed PO     :', JSON.stringify(po));

const result = runMatch(normalize({ invoice, pos: [po], opts: {} }), {});
const rows = toRows(result);
fs.writeFileSync(path.join(OUT, 'local_result.csv'), rows.combined_csv);

const h = result.header;
console.log('\n==============================================');
console.log('  VERDICT :', h.result, '  (basis:', h.match_basis + ',', h.confidence + ')');
console.log('  vendor:', h.vendor_match, '| total:', h.total_match, '| dates_fy:', h.dates_fy);
console.log('  matched PO:', h.matched_po_numbers, '| invoice total:', h.invoice_total, 'vs PO', h.po_total_sum);
console.log('  flags  :', h.flags.length ? h.flags.join(' | ') : '(none)');
if (h.reason) console.log('  reason :', h.reason);
console.log('  CSV    : samples/out/local_result.csv');
console.log('==============================================');
