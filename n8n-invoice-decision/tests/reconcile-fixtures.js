'use strict';
/*
 * reconcile-fixtures.js — a demo batch of documents as Claude's emit_document
 * tool would return them (classification + fields), plus filenames. Stands in
 * for the live Claude calls so reconcile() can be tested offline. Mirrors the
 * PDFs generated into samples-recon/.
 */
const HIGH = { doc_number: 0.95, vendor: 0.95, total: 0.95 };
const inv = (o) => Object.assign({ doc_type: 'invoice', currency: 'USD', field_confidence: HIGH, text_layer_present: true, line_items: [] }, o);
const po = (o) => Object.assign({ doc_type: 'purchase_order', currency: 'USD', po_reference: null, field_confidence: HIGH, text_layer_present: true, line_items: [] }, o);

// The main demo batch — one upload that exercises every bucket.
const DEMO_BATCH = [
  { filename: 'inv_acme_1001.pdf', claude: inv({ doc_number: 'ACME-88213', po_reference: 'PO-1001', vendor_name: 'Acme Industrial Supplies', total: '12500.00', date: '2026-06-12' }) },
  { filename: 'po_1001.pdf', claude: po({ doc_number: 'PO-1001', vendor_name: 'Acme Industrial Supplies', total: '12500.00', date: '2026-06-01' }) },
  { filename: 'inv_acme_1001_dup.pdf', claude: inv({ doc_number: 'ACME-88213', po_reference: 'PO-1001', vendor_name: 'Acme Industrial Supplies', total: '12500.00', date: '2026-06-12' }) }, // EXACT duplicate of #1
  { filename: 'inv_northwind_1002.pdf', claude: inv({ doc_number: 'NW-30541', po_reference: 'PO-1002', vendor_name: 'Northwind Traders', total: '8540.00', date: '2026-06-20' }) },
  { filename: 'po_1002.pdf', claude: po({ doc_number: 'PO-1002', vendor_name: 'Northwind Traders', total: '8000.00', date: '2026-06-02' }) }, // → variance
  { filename: 'inv_globex_1003.pdf', claude: inv({ doc_number: 'GBX-5588', po_reference: 'PO-1003', vendor_name: 'Globex Corporation', total: '12000.00', date: '2026-06-25' }) }, // → PO missing
  { filename: 'po_1004.pdf', claude: po({ doc_number: 'PO-1004', vendor_name: 'Initech Software', total: '6750.00', date: '2026-06-03' }) }, // → invoice missing
  { filename: 'scan_blurry.pdf', claude: inv({ doc_number: null, po_reference: null, vendor_name: null, total: null, field_confidence: { doc_number: 0.1, vendor: 0.1, total: 0.1 }, text_layer_present: false }) }, // → unreadable
];

// A second mini-batch proving the fingerprint fallback (invoice with no PO ref).
const FINGERPRINT_BATCH = [
  { filename: 'inv_noref.pdf', claude: inv({ doc_number: 'GBX-7001', po_reference: null, vendor_name: 'Globex Corporation', total: '50000.00', date: '2026-06-15' }) },
  { filename: 'po_9999.pdf', claude: po({ doc_number: 'PO-9999', vendor_name: 'Globex Corp', total: '50000.00', date: '2026-06-01' }) },
];

// GST batch — proves the ladder's GSTIN rungs. Indian tax invoices carry a seller
// GSTIN; the invoices cite NO PR/PO number, so matching must fall to the GSTIN
// fingerprint (R2) or the "possible" rung (R4) when the amount is off.
const gi = (o) => Object.assign({ doc_type: 'invoice', currency: 'INR', po_reference: null, field_confidence: HIGH, text_layer_present: true, line_items: [] }, o);
const gp = (o) => Object.assign({ doc_type: 'purchase_order', currency: 'INR', po_reference: null, field_confidence: HIGH, text_layer_present: true, line_items: [] }, o);
const GST_BATCH = [
  // R2: seller GSTIN + exact total, no PR ref on the invoice → clean MATCHED
  { filename: 'inv_bharat.pdf', claude: gi({ doc_number: 'BT-7781', vendor_name: 'Bharat Traders', seller_gstin: '29ABCDE1234F1Z5', buyer_gstin: '29CONTOSO999G2Z1', total: '45000.00', date: '2026-06-18' }) },
  { filename: 'po_bharat.pdf', claude: gp({ doc_number: 'PO-8001', vendor_name: 'Bharat Traders Private Limited', seller_gstin: '29ABCDE1234F1Z5', buyer_gstin: '29CONTOSO999G2Z1', total: '45000.00', date: '2026-06-01' }) },
  // R4: same seller GSTIN but total is off → "possible", surfaced as MISMATCH
  { filename: 'inv_konkan.pdf', claude: gi({ doc_number: 'KS-3320', vendor_name: 'Konkan Supplies', seller_gstin: '27PQRS5678K1Z2', buyer_gstin: '29CONTOSO999G2Z1', total: '30000.00', date: '2026-06-22' }) },
  { filename: 'po_konkan.pdf', claude: gp({ doc_number: 'PO-8002', vendor_name: 'Konkan Supplies', seller_gstin: '27PQRS5678K1Z2', buyer_gstin: '29CONTOSO999G2Z1', total: '27000.00', date: '2026-06-02' }) },
];

// ---- Phase A: many-to-many, line-item, GST ---- //
const li = (o) => Object.assign({ description: '', hsn_sac: null, quantity: null, unit_price: null, gst_rate: null, amount: null }, o);

// One invoice → two POs (total = Σ of both).
const MULTI_PO_BATCH = [
  { filename: 'inv_span.pdf', claude: inv({ doc_number: 'SPAN-1', po_references: ['PO-5001', 'PO-5002'], vendor_name: 'Globex Corporation', total: '15000.00', date: '2026-06-20' }) },
  { filename: 'po_5001.pdf', claude: po({ doc_number: 'PO-5001', vendor_name: 'Globex Corporation', total: '9000.00' }) },
  { filename: 'po_5002.pdf', claude: po({ doc_number: 'PO-5002', vendor_name: 'Globex Corporation', total: '6000.00' }) },
];

// One PO → two invoices (split billing), combined = PO → both PARTIAL.
const SPLIT_BATCH = [
  { filename: 'inv_a.pdf', claude: inv({ doc_number: 'SPA-1', po_reference: 'PO-6001', vendor_name: 'Initech Software', total: '5000.00', date: '2026-06-10' }) },
  { filename: 'inv_b.pdf', claude: inv({ doc_number: 'SPB-2', po_reference: 'PO-6001', vendor_name: 'Initech Software', total: '7000.00', date: '2026-06-12' }) },
  { filename: 'po_6001.pdf', claude: po({ doc_number: 'PO-6001', vendor_name: 'Initech Software', total: '12000.00' }) },
];

// One PO → two invoices, combined far over the PO → over-billing MISMATCH.
const SPLIT_OVER_BATCH = [
  { filename: 'inv_c.pdf', claude: inv({ doc_number: 'SPC-1', po_reference: 'PO-6002', vendor_name: 'Acme Industrial Supplies', total: '9000.00', date: '2026-06-10' }) },
  { filename: 'inv_d.pdf', claude: inv({ doc_number: 'SPD-2', po_reference: 'PO-6002', vendor_name: 'Acme Industrial Supplies', total: '9000.00', date: '2026-06-12' }) },
  { filename: 'po_6002.pdf', claude: po({ doc_number: 'PO-6002', vendor_name: 'Acme Industrial Supplies', total: '10000.00' }) },
];

// Itemized pair: totals equal (MATCHED) but one line's rate is off → flag-only.
const LINE_BATCH = [
  { filename: 'inv_lines.pdf', claude: inv({ doc_number: 'LINE-1', po_reference: 'PO-7001', vendor_name: 'Northwind Traders', total: '1180.00', line_items: [
    li({ description: 'Widget A', hsn_sac: '3917', quantity: '10', unit_price: '50.00', gst_rate: '18', amount: '500.00' }),
    li({ description: 'Gadget B', hsn_sac: '8481', quantity: '5', unit_price: '136.00', gst_rate: '18', amount: '680.00' }),
  ] }) },
  { filename: 'po_7001.pdf', claude: po({ doc_number: 'PO-7001', vendor_name: 'Northwind Traders', total: '1180.00', line_items: [
    li({ description: 'Widget A', quantity: '10', unit_price: '50.00', amount: '500.00' }),
    li({ description: 'Gadget B', quantity: '5', unit_price: '130.00', amount: '680.00' }), // rate differs (130 vs 136)
  ] }) },
];

// GST battery: one clean invoice (valid HSN, correct rate, tax adds up) + one
// bad one (malformed HSN, wrong rate, tax doesn't add up) — all flag-only.
const GST_CHECK_BATCH = [
  { filename: 'inv_gst_ok.pdf', claude: inv({ doc_number: 'GSTC-1', po_reference: 'PO-8001', vendor_name: 'Bharat Traders', total: '11800.00', taxable_total: '10000.00', tax_total: '1800.00', line_items: [
    li({ description: 'PVC pipes', hsn_sac: '3917', quantity: '100', unit_price: '100.00', gst_rate: '18', amount: '10000.00' }),
  ] }) },
  { filename: 'po_8001b.pdf', claude: po({ doc_number: 'PO-8001', vendor_name: 'Bharat Traders', total: '11800.00' }) },
  { filename: 'inv_gst_bad.pdf', claude: inv({ doc_number: 'GSTB-1', po_reference: 'PO-8002', vendor_name: 'Konkan Supplies', total: '11800.00', taxable_total: '10000.00', tax_total: '1500.00', line_items: [
    li({ description: 'Office chairs', hsn_sac: '9401', quantity: '4', unit_price: '2500.00', gst_rate: '12', amount: '10000.00' }), // HSN 9401 → table 18%, billed 12%
    li({ description: 'Misc', hsn_sac: '12345', quantity: '1', unit_price: '0.00', gst_rate: '18', amount: '0.00' }),               // 5-digit HSN → malformed
  ] }) },
  { filename: 'po_8002b.pdf', claude: po({ doc_number: 'PO-8002', vendor_name: 'Konkan Supplies', total: '11800.00' }) },
];

// ===== cross-run memory (Phase B) =========================================== //
// A ledger as it would look AFTER an earlier run (batch 1). Record shape matches
// what the Reconcile node persists into $getWorkflowStaticData('global').ledger.
const PRIOR_LEDGER = [
  { vendor: 'Alpha Supplies', invoice_number: 'INV-A1', invoice_date: '2026-06-01', amount_cents: 1000000, currency: 'USD', po_number: 'PO-9001', po_total_cents: 1000000, seller_gstin: null, filename: 'inv_a1.pdf', batch_id: 'batch1', run_at: '2026-07-05T10:00:00.000Z' },
  { vendor: 'Beta Corp', invoice_number: 'INB-1', invoice_date: '2026-06-02', amount_cents: 200000, currency: 'USD', po_number: 'PO-9002', po_total_cents: 200000, seller_gstin: null, filename: 'inv_b1.pdf', batch_id: 'batch1', run_at: '2026-07-05T10:00:00.000Z' },
];
// Batch 1 as Claude fixtures — the node itself builds the ledger from this run
// (used by the node-level emulator to prove persistence end-to-end).
const MEM_BATCH1 = [
  { filename: 'inv_a1.pdf', claude: inv({ doc_number: 'INV-A1', po_reference: 'PO-9001', vendor_name: 'Alpha Supplies', total: '10000.00', date: '2026-06-01' }) },
  { filename: 'po_9001.pdf', claude: po({ doc_number: 'PO-9001', vendor_name: 'Alpha Supplies', total: '10000.00' }) },
  { filename: 'inv_b1.pdf', claude: inv({ doc_number: 'INB-1', po_reference: 'PO-9002', vendor_name: 'Beta Corp', total: '2000.00', date: '2026-06-02' }) },
  { filename: 'po_9002.pdf', claude: po({ doc_number: 'PO-9002', vendor_name: 'Beta Corp', total: '2000.00' }) },
];
// Batch 2 — each invoice looks fine on its own; memory reveals the problems:
//   INV-A2 matches PO-9001 (MATCHED) but PO-9001 was already fully billed in run 1 → cumulative over-bill.
//   INB-1 is a re-submission of a batch-1 invoice → cross-run duplicate (its PO isn't re-uploaded → po_missing).
const MEM_BATCH2 = [
  { filename: 'inv_a2.pdf', claude: inv({ doc_number: 'INV-A2', po_reference: 'PO-9001', vendor_name: 'Alpha Supplies', total: '10000.00', date: '2026-06-20' }) },
  { filename: 'po_9001.pdf', claude: po({ doc_number: 'PO-9001', vendor_name: 'Alpha Supplies', total: '10000.00' }) },
  { filename: 'inv_b1_again.pdf', claude: inv({ doc_number: 'INB-1', po_reference: 'PO-9002', vendor_name: 'Beta Corp', total: '2000.00', date: '2026-06-02' }) },
];

module.exports = { DEMO_BATCH, FINGERPRINT_BATCH, GST_BATCH, MULTI_PO_BATCH, SPLIT_BATCH, SPLIT_OVER_BATCH, LINE_BATCH, GST_CHECK_BATCH, PRIOR_LEDGER, MEM_BATCH1, MEM_BATCH2 };
