"""
Generate GST-style sample PDFs (a tax invoice + its PO) matching the happy-path
scenario, so the 'Upload PDFs' path has real files to try once OCR is wired.
Run:  python samples/generate_pdfs.py   (needs reportlab)
"""
from pathlib import Path
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

HERE = Path(__file__).parent


def pdf(name, lines):
    c = canvas.Canvas(str(HERE / name), pagesize=A4)
    w, h = A4
    y = h - 60
    for ln in lines:
        bold = ln.startswith("§")
        c.setFont("Helvetica-Bold" if bold else "Helvetica", 12 if bold else 10)
        c.drawString(50, y, ln.lstrip("§"))
        y -= 18
    c.save()
    print("wrote", name)


pdf("invoice_sample.pdf", [
    "§SRI LAKSHMI TRADERS",
    "12 Industrial Estate, Bengaluru, Karnataka 560058",
    "GSTIN: 29AABCS1429B1ZX",
    "",
    "§TAX INVOICE",
    "Invoice No: INV-1001            Invoice Date: 10-06-2025",
    "Buyer PO Ref: PO2279",
    "Bill To: Acme Facilities Pvt Ltd   GSTIN: 29AAACX1234M1Z0",
    "",
    "Sl  Description            HSN    Qty  Rate    GST%   Amount",
    "1   CPVC Pipe 1 inch       3917   100  100.00  18%    10,000.00",
    "",
    "Taxable Value: 10,000.00",
    "CGST 9%: 900.00    SGST 9%: 900.00",
    "Grand Total: 11,800.00",
])

pdf("po_sample.pdf", [
    "§ACME FACILITIES PVT LTD",
    "GSTIN: 29AAACX1234M1Z0",
    "",
    "§PURCHASE ORDER",
    "PO Number: PO2279          PR Number: PR2390",
    "Requisition Date: 01-06-2025",
    "Vendor: Sri Lakshmi Traders   GSTIN: 29AABCS1429B1ZX",
    "",
    "Sl  Description            Qty   Unit Price   Amount",
    "1   CPVC Pipe 1 inch       100   100.00       10,000.00",
    "",
    "PO Total: 11,800.00 (incl. GST)",
])
