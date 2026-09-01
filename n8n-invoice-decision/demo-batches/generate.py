"""
generate.py — four self-contained demo batches of realistic invoices & POs that
together exercise every edge case the workflow handles. Distinct POs/invoices in
each batch, so you can run them in order for a holistic demo.

Run:   python3 demo-batches/generate.py
Demo:  Clear memory, then POST 1-core → 2-many-to-many → 3-gst-india → 4-memory.

Coverage:
  1-core           MATCHED · DUPLICATE · VARIANCE · MISMATCH · scanned-photo OCR
                   · PO-missing · invoice-missing · UNREADABLE
  2-many-to-many   invoice→2 POs · PO→2 invoices (PARTIAL) · split over-bill
                   (MISMATCH) · line-item rate flags · vendor-mismatch REVIEW
  3-gst-india      GSTIN fingerprint match · GSTIN "possible" (MISMATCH) ·
                   GST battery clean · GST battery (bad HSN + wrong rate + tax off)
  4-memory         cross-run duplicate · cumulative over-billing  (run AFTER 1-core)
"""
from pathlib import Path
import render as R

ROOT = Path(__file__).parent
def D(name):
    d = ROOT / name; d.mkdir(parents=True, exist_ok=True); return d

B1, B2, B3, B4 = D('1-core'), D('2-many-to-many'), D('3-gst-india'), D('4-memory')

# ============================ BATCH 1 — core ================================ #
acme_items = [{'desc': 'CNC steel fittings (Grade A)', 'qty': 50, 'rate': 180},
              {'desc': 'Assembly hardware kit', 'qty': 5, 'rate': 700}]           # = 12,500
R.invoice(str(B1 / 'inv_acme.pdf'), seller='acme', buyer='contoso', number='AC-4021',
          date='12 Jun 2026', po_ref='PO-2201', items=acme_items)
R.po(str(B1 / 'po_2201.pdf'), buyer='contoso', seller='acme', number='PO-2201',
     date='01 Jun 2026', items=acme_items)
R.invoice(str(B1 / 'inv_acme_DUPLICATE.pdf'), seller='acme', buyer='contoso', number='AC-4021',
          date='12 Jun 2026', po_ref='PO-2201', items=acme_items)                # exact duplicate

R.invoice(str(B1 / 'inv_northwind.pdf'), seller='northwind', buyer='contoso', number='NW-8830',
          date='20 Jun 2026', po_ref='PO-2202', items=[{'desc': 'Warehouse shelving units', 'qty': 20, 'rate': 424}])  # 8,480
R.po(str(B1 / 'po_2202.pdf'), buyer='contoso', seller='northwind', number='PO-2202',
     date='02 Jun 2026', items=[{'desc': 'Warehouse shelving units', 'qty': 20, 'rate': 400}])  # 8,000 → VARIANCE

R.invoice(str(B1 / 'inv_globex.pdf'), seller='globex', buyer='contoso', number='GX-1150',
          date='25 Jun 2026', po_ref='PO-2203', items=[{'desc': 'Server rack cabinets', 'qty': 10, 'rate': 2200}])  # 22,000
R.po(str(B1 / 'po_2203.pdf'), buyer='contoso', seller='globex', number='PO-2203',
     date='03 Jun 2026', items=[{'desc': 'Server rack cabinets', 'qty': 10, 'rate': 1800}])  # 18,000 → MISMATCH

# scanned/photographed paper invoice → matched via OCR only
R.scanned_invoice(str(B1 / 'inv_riverstone_SCAN.png'), seller='riverstone', buyer='contoso',
                  number='RS-7742', date='19 Jun 2026', po_ref='PO-2207',
                  items=[{'desc': 'Power tool sets', 'qty': 9, 'rate': 700}], total=6300)
R.po(str(B1 / 'po_2207.pdf'), buyer='contoso', seller='riverstone', number='PO-2207',
     date='05 Jun 2026', items=[{'desc': 'Power tool sets', 'qty': 9, 'rate': 700}])  # 6,300 → MATCHED (OCR)

R.invoice(str(B1 / 'inv_initech.pdf'), seller='initech', buyer='contoso', number='IT-3300',
          date='22 Jun 2026', po_ref='PO-2299', items=[{'desc': 'Annual software licences', 'qty': 30, 'rate': 300}])  # PO-2299 absent → PO MISSING
R.po(str(B1 / 'po_2205.pdf'), buyer='contoso', seller='zylker', number='PO-2205',
     date='04 Jun 2026', items=[{'desc': 'Packaged goods (assorted)', 'qty': 45, 'rate': 150}])  # no invoice → INVOICE MISSING

R.plain(str(B1 / 'delivery_note.pdf'), 'DELIVERY NOTE',
        ['Packing list for shipment DN-2207 (carrier: BlueDart).',
         'Cartons: 12    Gross weight: 340 kg', '',
         'Goods delivered against the purchase order on file.',
         'No prices shown — this is a goods-received note, not a bill.'])  # → UNREADABLE

# ===================== BATCH 2 — many-to-many + lines ======================= #
R.invoice(str(B2 / 'inv_span_two_POs.pdf'), seller='summit', buyer='contoso', number='SP-9001',
          date='20 Jun 2026', po_ref='PO-3301, PO-3302',
          items=[{'desc': 'Precision bearings (bulk)', 'qty': 300, 'rate': 30},
                 {'desc': 'Drive belts', 'qty': 120, 'rate': 50}])              # 15,000 spanning 2 POs
R.po(str(B2 / 'po_3301.pdf'), buyer='contoso', seller='summit', number='PO-3301',
     date='02 Jun 2026', items=[{'desc': 'Precision bearings (bulk)', 'qty': 300, 'rate': 30}])   # 9,000
R.po(str(B2 / 'po_3302.pdf'), buyer='contoso', seller='summit', number='PO-3302',
     date='02 Jun 2026', items=[{'desc': 'Drive belts', 'qty': 120, 'rate': 50}])                 # 6,000

R.invoice(str(B2 / 'inv_split_1.pdf'), seller='initech', buyer='contoso', number='SL-1001',
          date='10 Jun 2026', po_ref='PO-3303', items=[{'desc': 'Implementation services (phase 1)', 'qty': 1, 'rate': 5000}])
R.invoice(str(B2 / 'inv_split_2.pdf'), seller='initech', buyer='contoso', number='SL-1002',
          date='18 Jun 2026', po_ref='PO-3303', items=[{'desc': 'Implementation services (phase 2)', 'qty': 1, 'rate': 7000}])
R.po(str(B2 / 'po_3303.pdf'), buyer='contoso', seller='initech', number='PO-3303',
     date='01 Jun 2026', items=[{'desc': 'Implementation services (2 phases)', 'qty': 1, 'rate': 12000}])  # split PARTIAL

R.invoice(str(B2 / 'inv_overbill_1.pdf'), seller='globex', buyer='contoso', number='OV-2001',
          date='12 Jun 2026', po_ref='PO-3305', items=[{'desc': 'Networking equipment', 'qty': 1, 'rate': 9000}])
R.invoice(str(B2 / 'inv_overbill_2.pdf'), seller='globex', buyer='contoso', number='OV-2002',
          date='15 Jun 2026', po_ref='PO-3305', items=[{'desc': 'Networking equipment (additional)', 'qty': 1, 'rate': 9000}])
R.po(str(B2 / 'po_3305.pdf'), buyer='contoso', seller='globex', number='PO-3305',
     date='01 Jun 2026', items=[{'desc': 'Networking equipment', 'qty': 1, 'rate': 10000}])  # 9k+9k > 10k → MISMATCH

R.invoice(str(B2 / 'inv_lineitems.pdf'), seller='northwind', buyer='contoso', number='LN-2200',
          date='16 Jun 2026', po_ref='PO-3304',
          items=[{'desc': 'Widget A', 'qty': 10, 'rate': 45}, {'desc': 'Gadget B', 'qty': 5, 'rate': 150}])   # 1,200 (rates differ vs PO)
R.po(str(B2 / 'po_3304.pdf'), buyer='contoso', seller='northwind', number='PO-3304',
     date='01 Jun 2026', items=[{'desc': 'Widget A', 'qty': 10, 'rate': 50}, {'desc': 'Gadget B', 'qty': 5, 'rate': 140}])  # 1,200 total → MATCHED + line flags

R.invoice(str(B2 / 'inv_review.pdf'), seller='vertex', buyer='contoso', number='RV-5100',
          date='14 Jun 2026', po_ref='PO-3306', items=[{'desc': 'Assorted fasteners', 'qty': 1, 'rate': 5000}])
R.po(str(B2 / 'po_3306.pdf'), buyer='contoso', seller='apex', number='PO-3306',
     date='01 Jun 2026', items=[{'desc': 'Assorted fasteners', 'qty': 1, 'rate': 5000}])  # vendor ≠ invoice → REVIEW

# ========================== BATCH 3 — India / GST =========================== #
BUYER_GST = '27NRTGT4567H1Z8'
R.invoice(str(B3 / 'inv_bharat_GST.pdf'), seller='bharat', buyer='northgate', number='BT-2050',
          date='18 Jun 2026', po_ref=None, currency='Rs.', gst=True,
          seller_gstin='29ABCDE1234F1Z5', buyer_gstin=BUYER_GST,
          items=[{'desc': 'PVC conduit pipes', 'hsn': '3917', 'qty': 400, 'rate': 100, 'gst_rate': 18}],
          taxable=40000, cgst=3600, sgst=3600, tax=7200, total=47200)          # HSN valid, rate ok, tax adds up
R.po(str(B3 / 'po_bharat.pdf'), buyer='northgate', seller='bharat', number='PO-8801',
     date='02 Jun 2026', currency='Rs.', seller_gstin='29ABCDE1234F1Z5', buyer_gstin=BUYER_GST,
     items=[{'desc': 'PVC conduit pipes (bulk order)', 'qty': 1, 'rate': 47200}])  # no PR ref → R2 GSTIN+total

R.invoice(str(B3 / 'inv_konkan.pdf'), seller='konkan', buyer='northgate', number='KK-8801',
          date='22 Jun 2026', po_ref=None, currency='Rs.',
          seller_gstin='27PQRS5678K1Z2', buyer_gstin=BUYER_GST,
          items=[{'desc': 'Marine rope and fittings', 'qty': 1, 'rate': 30000}])   # 30,000
R.po(str(B3 / 'po_konkan.pdf'), buyer='northgate', seller='konkan', number='PO-8802',
     date='02 Jun 2026', currency='Rs.', seller_gstin='27PQRS5678K1Z2', buyer_gstin=BUYER_GST,
     items=[{'desc': 'Marine rope and fittings', 'qty': 1, 'rate': 27000}])        # 27,000 → R4 "possible" MISMATCH

R.invoice(str(B3 / 'inv_deccan_BADGST.pdf'), seller='deccan', buyer='northgate', number='DT-3300',
          date='21 Jun 2026', po_ref='PO-4403', currency='Rs.', gst=True,
          seller_gstin='29XYZAB9876C1Z3', buyer_gstin=BUYER_GST,
          items=[{'desc': 'Steel brackets', 'hsn': '12345', 'qty': 100, 'rate': 60, 'gst_rate': 18},
                 {'desc': 'Office chairs', 'hsn': '9401', 'qty': 8, 'rate': 500, 'gst_rate': 12}],
          taxable=10000, cgst=750, sgst=750, tax=1500, total=11800)             # bad HSN + wrong rate + tax off
R.po(str(B3 / 'po_4403.pdf'), buyer='northgate', seller='deccan', number='PO-4403',
     date='03 Jun 2026', currency='Rs.', seller_gstin='29XYZAB9876C1Z3', buyer_gstin=BUYER_GST,
     items=[{'desc': 'Steel brackets and office chairs', 'qty': 1, 'rate': 11800}])  # matches by number → GST flags only

# ===================== BATCH 4 — cross-run memory =========================== #
# Run AFTER 1-core: NW-8830 was processed there (→ duplicate), and PO-2201 was
# already fully billed there by AC-4021 (→ cumulative over-bill on a NEW invoice).
R.invoice(str(B4 / 'inv_northwind_RESUBMIT.pdf'), seller='northwind', buyer='contoso', number='NW-8830',
          date='20 Jun 2026', po_ref='PO-2202', items=[{'desc': 'Warehouse shelving units', 'qty': 20, 'rate': 424}])  # already processed
R.invoice(str(B4 / 'inv_acme_second.pdf'), seller='acme', buyer='contoso', number='AC-4099',
          date='28 Jun 2026', po_ref='PO-2201', items=acme_items)              # PO-2201 already billed → over-bill
R.po(str(B4 / 'po_2201.pdf'), buyer='contoso', seller='acme', number='PO-2201',
     date='01 Jun 2026', items=acme_items)

# ------------------------------------------------------------------ report -- #
for d in (B1, B2, B3, B4):
    n = len(list(d.glob('*.pdf'))) + len(list(d.glob('*.png')))
    print(f'  {d.name:16s} → {n} documents')
print('Done. Demo order: Clear memory, then 1-core → 2-many-to-many → 3-gst-india → 4-memory.')
