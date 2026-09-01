'use strict';
/*
 * to_rows.js — turn a matcher result into (a) flat rows and (b) CSV text, ready
 * for the "Convert to File" node or direct return to the browser. Produces two
 * logical tables: a one-row-per-invoice results table and a one-row-per-line
 * detail table, plus a combined CSV string for each.
 */

const RESULT_COLS = [
  'invoice_number', 'invoice_date', 'vendor_name', 'vendor_gstin', 'invoice_total',
  'matched_po_numbers', 'po_total_sum', 'result', 'vendor_match', 'total_match',
  'dates_fy', 'po_num_consistent', 'date_order', 'match_basis', 'confidence',
  'flags', 'reason',
];
const LINE_COLS = [
  'invoice_number', 'line_no', 'description', 'hsn_sac', 'quantity', 'unit', 'rate',
  'gst_rate', 'amount', 'paired_po_line', 'po_qty', 'po_unit_price', 'line_match',
  'rate_match', 'qty_flag', 'hsn_valid', 'gst_correct',
];

const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const toCsv = (cols, rows) =>
  [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\n');

function toRows(result) {
  const h = result.header;
  const resultRow = { ...h, flags: (h.flags || []).join(' ; ') };
  const lineRows = (result.lines || []).map((l) => ({ invoice_number: h.invoice_number, ...l }));

  const resultsCsv = toCsv(RESULT_COLS, [resultRow]);
  const linesCsv = toCsv(LINE_COLS, lineRows);
  return {
    result: h.result,
    header: resultRow,
    lines: lineRows,
    results_csv: resultsCsv,
    lines_csv: linesCsv,
    // one combined workbook-style CSV (results block, blank line, line detail)
    combined_csv: resultsCsv + '\n\n' + linesCsv,
  };
}

if (typeof $input !== 'undefined') {
  const it = $input.first().json;
  const out = toRows(it);
  const csv = out.combined_csv;
  return [{                                                     // eslint-disable-line
    json: { result: out.result, header: out.header, lines: out.lines,
            csv_base64: Buffer.from(csv, 'utf8').toString('base64'),
            filename: `match_${out.header.invoice_number || 'result'}.csv` },
    binary: { data: { data: Buffer.from(csv, 'utf8').toString('base64'),
              mimeType: 'text/csv', fileName: `match_${out.header.invoice_number || 'result'}.csv` } },
  }];
}
if (typeof module !== 'undefined' && module.exports) module.exports = { toRows, RESULT_COLS, LINE_COLS };
