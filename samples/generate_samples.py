"""
Generate the demo invoice PDFs.

Five are born-digital text-layer PDFs (via reportlab); the sixth is an image-only
"scanned" PDF (text rendered to a PIL image and embedded, so it has NO text layer)
to exercise the OCR / low-confidence path.

Crucially, each vendor uses *different* labels and layout — "Invoice Number" vs
"Bill Number" vs "Invoice No.", "Total Due" vs "Amount Payable" vs "Total" — so
the extractor is genuinely tested against format variety, not one template.

Run:  python samples/generate_samples.py
"""
from __future__ import annotations

import io
from pathlib import Path

from reportlab.lib.pagesizes import LETTER
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas
from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).parent


def text_pdf(name: str, lines: list[str]) -> None:
    """Write lines as a real text-layer PDF."""
    path = HERE / name
    c = canvas.Canvas(str(path), pagesize=LETTER)
    width, height = LETTER
    y = height - 72
    for line in lines:
        font = "Helvetica-Bold" if line.startswith("§") else "Helvetica"
        c.setFont(font, 11 if line.startswith("§") else 10)
        c.drawString(72, y, line.lstrip("§"))
        y -= 16
        if y < 72:
            c.showPage()
            y = height - 72
    c.save()
    print(f"  wrote {name}")


def image_pdf(name: str, lines: list[str]) -> None:
    """Write lines as an image embedded in a PDF (no text layer -> 'scanned')."""
    path = HERE / name
    img = Image.new("RGB", (1000, 1300), "white")
    draw = ImageDraw.Draw(img)
    try:
        font = ImageFont.load_default()
    except Exception:
        font = None
    y = 40
    for line in lines:
        draw.text((60, y), line.lstrip("§"), fill="black", font=font)
        y += 26
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)
    c = canvas.Canvas(str(path), pagesize=LETTER)
    width, height = LETTER
    c.drawImage(ImageReader(buf), 0, 0, width=width, height=height)
    c.save()
    print(f"  wrote {name}  (image-only / scanned)")


# --------------------------------------------------------------------------- #
# 01 — HAPPY PATH.  Clean invoice, exact PO match, within tolerance.           #
#      Expect: AUTO_APPROVE.                                                   #
# --------------------------------------------------------------------------- #
def sample_01() -> None:
    text_pdf("01_happy_path.pdf", [
        "§Acme Industrial Supplies",
        "123 Industrial Way, Detroit, MI 48201",
        "",
        "§TAX INVOICE",
        "Invoice Number: ACME-88213",
        "Invoice Date: 12 Jun 2026",
        "Purchase Order: PO-1001",
        "",
        "Description                              Qty      Unit Price        Amount",
        "Warehouse racking system                   1       $8,000.00      $8,000.00",
        "Steel fasteners (bulk carton)              1       $3,500.00      $3,500.00",
        "",
        "Subtotal:                                                        $11,500.00",
        "Sales Tax (8.7%):                                                 $1,000.00",
        "Total Due:                                                       $12,500.00",
        "",
        "Remit within 30 days. Thank you for your business.",
    ])


# --------------------------------------------------------------------------- #
# 02 — OVER TOLERANCE.  Single invoice ~6.75% over its PO (different labels).  #
#      Expect: HOLD_FOR_APPROVAL (variance within the approver band).         #
# --------------------------------------------------------------------------- #
def sample_02() -> None:
    text_pdf("02_over_tolerance.pdf", [
        "§Northwind Traders",
        "Bill Number: NW-30541",
        "Date of Issue: 2026-06-20",
        "PO #: PO-1002",
        "",
        "Item                                     Qty      Unit Price        Amount",
        "Executive reception desk                   1       $5,000.00      $5,000.00",
        "Lounge seating set                         1       $2,900.00      $2,900.00",
        "",
        "Sub Total:                                                        $7,900.00",
        "VAT:                                                                $640.00",
        "Amount Payable:                                                   $8,540.00",
    ])


# --------------------------------------------------------------------------- #
# 03 — CUMULATIVE OVERBILL on a split PO (EDGE CASE 1).  Two prior invoices    #
#      already billed $46k of a $50k PO; this $12k invoice pushes it to $58k.  #
#      Expect: REJECT — beyond the approver band, citing the priors.          #
# --------------------------------------------------------------------------- #
def sample_03() -> None:
    text_pdf("03_partial_overbill.pdf", [
        "§Globex Corporation",
        "Invoice No. GBX-5588",
        "Invoice Date: 25 June 2026",
        "PO Number: PO-1003",
        "",
        "Description                              Qty      Unit Price        Amount",
        "Rack-mount servers (batch 3 of 3)          6       $2,000.00     $12,000.00",
        "",
        "Total:                                                          $12,000.00",
        "Reverse-charge / tax exempt.",
    ])


# --------------------------------------------------------------------------- #
# 04 — NEAR-DUPLICATE (EDGE CASE 2).  Same vendor, same $6,750, same date as   #
#      an already-processed invoice, but a *different* invoice number.         #
#      Expect: NEEDS_REVIEW — flagged as a probable double-billing.           #
# --------------------------------------------------------------------------- #
def sample_04() -> None:
    text_pdf("04_near_duplicate.pdf", [
        "§Initech, Inc.",
        "Invoice #: INIT-4419",
        "Invoice Date: 2026-06-15",
        "PO: PO-1004",
        "",
        "Description                              Qty      Unit Price        Amount",
        "Annual ERP license renewal                 1       $6,750.00      $6,750.00",
        "",
        "Total Due:                                                        $6,750.00",
    ])


# --------------------------------------------------------------------------- #
# 05 — UNRECONCILED + MISSING FIELDS (EDGE CASE 3).  No invoice number, no PO, #
#      and subtotal + tax != stated total.                                    #
#      Expect: NEEDS_REVIEW — refuse to guess; ask for specific fixes.        #
# --------------------------------------------------------------------------- #
def sample_05() -> None:
    text_pdf("05_unreconciled_missing.pdf", [
        "§Northwind Traders",
        "Date: 2026-06-28",
        "",
        "Description                              Qty      Unit Price        Amount",
        "Consulting services (June)                40         $50.00      $2,000.00",
        "Onsite support                             8        $150.00      $1,200.00",
        "",
        "Subtotal:                                                        $3,200.00",
        "Tax:                                                               $150.00",
        "Total Due:                                                       $3,520.00",
        "",
        "Payment terms: net 45 days.",
    ])


# --------------------------------------------------------------------------- #
# 06 — SCANNED IMAGE (EDGE CASE 4).  Same content, but rendered as a picture   #
#      with no text layer.                                                     #
#      Expect: NEEDS_REVIEW — OCR/low-confidence gate; manual key-entry.       #
# --------------------------------------------------------------------------- #
def sample_06() -> None:
    image_pdf("06_scanned_image.pdf", [
        "Acme Industrial Supplies",
        "Invoice Number: ACME-90014",
        "Invoice Date: 30 Jun 2026",
        "Purchase Order: PO-1001",
        "",
        "Warehouse shelving .................. $4,200.00",
        "Total Due: $4,200.00",
    ])


if __name__ == "__main__":
    print("Generating sample invoices...")
    sample_01()
    sample_02()
    sample_03()
    sample_04()
    sample_05()
    sample_06()
    print("Done.")
