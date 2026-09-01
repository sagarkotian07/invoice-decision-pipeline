"""
render.py — a small, self-contained renderer for realistic-looking invoices and
purchase orders (letterhead + logo, bill-to / vendor blocks, a bordered
line-item table, a totals panel, and a footer). Used by generate.py.

Everything is vector PDF via reportlab, except one photographed/scanned invoice
which is rasterised with Pillow to prove Claude's OCR on a phone-photo document.
"""
from reportlab.lib.pagesizes import LETTER
from reportlab.pdfgen import canvas
from reportlab.lib.colors import HexColor, Color

W, H = LETTER            # 612 x 792 pt
M = 54                   # page margin
CONTENT = W - 2 * M      # 504 pt
INK = HexColor('#1f2937')
MUTE = HexColor('#6b7280')
LINE = HexColor('#e5e7eb')
ZEBRA = HexColor('#f8fafc')

# Fictional parties (no real companies). initials → drawn as a logo tile.
PARTIES = {
    'contoso':   dict(name='Contoso Manufacturing Inc.', addr=['2100 Industrial Parkway', 'Austin, TX 78744', 'ap@contoso-mfg.example'], color='#2563eb', ini='CM'),
    'northgate': dict(name='Northgate Retail Pvt Ltd', addr=['4th Floor, Trade Tower, BKC', 'Mumbai, MH 400051', 'accounts@northgate.example'], color='#0f766e', ini='NR'),
    'acme':      dict(name='Acme Industrial Supplies', addr=['48 Foundry Road', 'Cleveland, OH 44113', 'billing@acme-ind.example'], color='#b91c1c', ini='AI'),
    'northwind': dict(name='Northwind Traders', addr=['901 Harbour Street', 'Seattle, WA 98104', 'billing@northwind.example'], color='#7c3aed', ini='NW'),
    'globex':    dict(name='Globex Corporation', addr=['42 Grid Avenue', 'Austin, TX 78701', 'ar@globex.example'], color='#c2410c', ini='GX'),
    'initech':   dict(name='Initech Software', addr=['77 Cubicle Court', 'Austin, TX 78729', 'ar@initech.example'], color='#0369a1', ini='IS'),
    'summit':    dict(name='Summit Components', addr=['15 Alpine Way', 'Denver, CO 80202', 'sales@summit-cmp.example'], color='#4338ca', ini='SC'),
    'riverstone':dict(name='Riverstone Hardware', addr=['320 Mill Lane', 'Portland, OR 97204', 'billing@riverstone.example'], color='#166534', ini='RH'),
    'zylker':    dict(name='Zylker Foods', addr=['5 Orchard Road', 'Fresno, CA 93650', 'ar@zylker.example'], color='#a16207', ini='ZF'),
    'vertex':    dict(name='Vertex Traders', addr=['210 Market Street', 'Columbus, OH 43215', 'billing@vertex.example'], color='#9333ea', ini='VT'),
    'apex':      dict(name='Apex Distributors', addr=['88 Commerce Blvd', 'Columbus, OH 43004', 'ar@apex-dist.example'], color='#be123c', ini='AD'),
    'bharat':    dict(name='Bharat Traders', addr=['Plot 14, MIDC Industrial Area', 'Pune, MH 411019', 'accounts@bharattraders.example'], color='#0d9488', ini='BT'),
    'konkan':    dict(name='Konkan Supplies', addr=['Shop 6, Market Yard', 'Ratnagiri, MH 415612', 'sales@konkansupplies.example'], color='#0e7490', ini='KS'),
    'deccan':    dict(name='Deccan Traders', addr=['22 Residency Road', 'Hyderabad, TS 500001', 'billing@deccantraders.example'], color='#15803d', ini='DT'),
}


def _fmt(n, cur='$'):
    return cur + format(round(float(n), 2), ',.2f')


def _logo(c, x, y, party):
    col = HexColor(party['color'])
    c.setFillColor(col)
    c.roundRect(x, y - 34, 34, 34, 6, fill=1, stroke=0)
    c.setFillColor(HexColor('#ffffff'))
    c.setFont('Helvetica-Bold', 13)
    c.drawCentredString(x + 17, y - 22, party['ini'])


def _header(c, issuer, title, meta_rows):
    col = HexColor(issuer['color'])
    y = H - M
    _logo(c, M, y, issuer)
    c.setFillColor(INK); c.setFont('Helvetica-Bold', 14)
    c.drawString(M + 44, y - 11, issuer['name'])
    c.setFillColor(MUTE); c.setFont('Helvetica', 8.3)
    for i, ln in enumerate(issuer['addr']):
        c.drawString(M + 44, y - 22 - i * 10, ln)
    # title (right)
    c.setFillColor(col); c.setFont('Helvetica-Bold', 22)
    c.drawRightString(W - M, y - 6, title)
    # meta rows (right)
    my = y - 26
    c.setFont('Helvetica', 8.6)
    for label, val in meta_rows:
        c.setFillColor(MUTE); c.drawRightString(W - M - 96, my, label)
        c.setFillColor(INK); c.setFont('Helvetica-Bold', 8.6); c.drawRightString(W - M, my, val)
        c.setFont('Helvetica', 8.6); my -= 12
    # accent rule
    c.setStrokeColor(col); c.setLineWidth(2)
    c.line(M, y - 58, W - M, y - 58)
    return y - 76


def _party(c, x, y, label, name, addr, gstin=None, w=CONTENT / 2 - 8):
    c.setFillColor(MUTE); c.setFont('Helvetica-Bold', 7.6)
    c.drawString(x, y, label.upper())
    c.setFillColor(INK); c.setFont('Helvetica-Bold', 10.5)
    c.drawString(x, y - 14, name)
    c.setFillColor(MUTE); c.setFont('Helvetica', 8.3)
    yy = y - 26
    for ln in addr:
        c.drawString(x, yy, ln); yy -= 10
    if gstin:
        c.setFillColor(INK); c.setFont('Helvetica-Bold', 8.3)
        c.drawString(x, yy, 'GSTIN: ' + gstin); yy -= 10
    return yy


def _table(c, y, cols, rows, color):
    """cols = [(title, width, align)]; rows = list of [cell,...]. align: 'l'/'r'."""
    col = HexColor(color)
    x0 = M
    hh = 20
    # header
    c.setFillColor(col); c.rect(x0, y - hh, CONTENT, hh, fill=1, stroke=0)
    c.setFillColor(HexColor('#ffffff')); c.setFont('Helvetica-Bold', 8.2)
    cx = x0
    for title, w, al in cols:
        if al == 'r': c.drawRightString(cx + w - 6, y - 13, title)
        else: c.drawString(cx + 6, y - 13, title)
        cx += w
    y -= hh
    # rows
    rh = 18
    for ri, row in enumerate(rows):
        if ri % 2 == 1:
            c.setFillColor(ZEBRA); c.rect(x0, y - rh, CONTENT, rh, fill=1, stroke=0)
        c.setFillColor(INK); c.setFont('Helvetica', 8.4)
        cx = x0
        for (title, w, al), cell in zip(cols, row):
            if al == 'r': c.drawRightString(cx + w - 6, y - 12, str(cell))
            else: c.drawString(cx + 6, y - 12, str(cell))
            cx += w
        c.setStrokeColor(LINE); c.setLineWidth(0.5); c.line(x0, y - rh, x0 + CONTENT, y - rh)
        y -= rh
    return y - 8


def _totals(c, y, rows, color):
    """rows = [(label, value, emphatic?)]; right-aligned panel."""
    col = HexColor(color)
    bx = W - M - 232
    for label, val, emph in rows:
        if emph:
            c.setFillColor(col); c.rect(bx, y - 20, 232, 20, fill=1, stroke=0)
            c.setFillColor(HexColor('#ffffff')); c.setFont('Helvetica-Bold', 10.5)
            c.drawString(bx + 8, y - 14, label)
            c.drawRightString(W - M - 8, y - 14, val); y -= 22
        else:
            c.setFillColor(MUTE); c.setFont('Helvetica', 9)
            c.drawString(bx + 8, y - 13, label)
            c.setFillColor(INK); c.setFont('Helvetica-Bold', 9)
            c.drawRightString(W - M - 8, y - 13, val); y -= 16
    return y


def _footer(c, note, signatory=None):
    c.setStrokeColor(LINE); c.setLineWidth(0.75); c.line(M, 70, W - M, 70)
    c.setFillColor(MUTE); c.setFont('Helvetica-Oblique', 8)
    c.drawString(M, 58, note)
    if signatory:
        c.setFont('Helvetica', 8.2); c.setFillColor(INK)
        c.drawRightString(W - M, 92, '__________________________')
        c.setFillColor(MUTE); c.drawRightString(W - M, 80, signatory)


# ---------------------------------------------------------------- public API --
def invoice(path, *, seller, buyer, number, date, po_ref, items, currency='$',
            gst=False, seller_gstin=None, buyer_gstin=None, taxable=None, tax=None,
            total=None, cgst=None, sgst=None, note='Payment due within 30 days. Thank you for your business.'):
    s, b = PARTIES[seller], PARTIES[buyer]
    c = canvas.Canvas(path, pagesize=LETTER)
    meta = [('Invoice No.', number), ('Invoice Date', date)]
    if po_ref: meta.append(('Purchase Order', po_ref))
    y = _header(c, s, 'TAX INVOICE' if gst else 'INVOICE', meta)
    yb = _party(c, M, y, 'Bill To', b['name'], b['addr'], gstin=buyer_gstin)
    _party(c, M + CONTENT / 2 + 8, y, 'Supplier', s['name'], s['addr'], gstin=seller_gstin)
    y = min(yb, y - 46) - 10
    sub = sum(round(it['qty'] * it['rate'], 2) for it in items)
    if gst:
        cols = [('#', 24, 'l'), ('Description', 168, 'l'), ('HSN/SAC', 66, 'l'), ('Qty', 40, 'r'), ('Rate', 70, 'r'), ('GST%', 44, 'r'), ('Amount', 92, 'r')]
        rows = [[i + 1, it['desc'], it.get('hsn', ''), it['qty'], _fmt(it['rate'], currency), str(it.get('gst_rate', '')) + '%', _fmt(it['qty'] * it['rate'], currency)] for i, it in enumerate(items)]
    else:
        cols = [('#', 26, 'l'), ('Description', 250, 'l'), ('Qty', 54, 'r'), ('Rate', 82, 'r'), ('Amount', 92, 'r')]
        rows = [[i + 1, it['desc'], it['qty'], _fmt(it['rate'], currency), _fmt(it['qty'] * it['rate'], currency)] for i, it in enumerate(items)]
    y = _table(c, y, cols, rows, s['color'])
    tx = taxable if taxable is not None else sub
    grand = total if total is not None else (tx + (tax or 0) if gst else sub)
    trows = []
    if gst:
        trows.append(('Taxable Value', _fmt(tx, currency), False))
        trows.append(('CGST', _fmt(cgst if cgst is not None else (tax or 0) / 2, currency), False))
        trows.append(('SGST', _fmt(sgst if sgst is not None else (tax or 0) / 2, currency), False))
    trows.append(('TOTAL', _fmt(grand, currency), True))
    _totals(c, y, trows, s['color'])
    _footer(c, note)
    c.save()


def po(path, *, buyer, seller, number, date, items, currency='$', seller_gstin=None,
       buyer_gstin=None, note='Goods to be supplied per agreed terms. This is a computer-generated purchase order.'):
    bp, sp = PARTIES[buyer], PARTIES[seller]
    c = canvas.Canvas(path, pagesize=LETTER)
    y = _header(c, bp, 'PURCHASE ORDER', [('PO Number', number), ('PO Date', date)])
    yb = _party(c, M, y, 'Vendor', sp['name'], sp['addr'], gstin=seller_gstin)
    _party(c, M + CONTENT / 2 + 8, y, 'Ship To', bp['name'], bp['addr'], gstin=buyer_gstin)
    y = min(yb, y - 46) - 10
    cols = [('#', 26, 'l'), ('Description', 250, 'l'), ('Qty', 54, 'r'), ('Unit Price', 82, 'r'), ('Amount', 92, 'r')]
    rows = [[i + 1, it['desc'], it['qty'], _fmt(it['rate'], currency), _fmt(it['qty'] * it['rate'], currency)] for i, it in enumerate(items)]
    y = _table(c, y, cols, rows, bp['color'])
    total = sum(round(it['qty'] * it['rate'], 2) for it in items)
    _totals(c, y, [('PO Total', _fmt(total, currency), True)], bp['color'])
    _footer(c, note, signatory='Authorised Signatory · ' + bp['name'])
    c.save()


def plain(path, title, lines):
    """A non-invoice/PO document (e.g. a delivery note) → should be UNREADABLE."""
    c = canvas.Canvas(path, pagesize=LETTER)
    y = _header(c, PARTIES['acme'], title, [('Note No.', 'DN-2207'), ('Date', '18 Jun 2026')])
    c.setFillColor(INK); c.setFont('Helvetica', 10)
    for ln in lines:
        c.drawString(M, y, ln); y -= 16
    _footer(c, 'Delivery note — please check goods on receipt.')
    c.save()


def scanned_invoice(path, *, seller, buyer, number, date, po_ref, items, total, currency='$'):
    """A photographed/scanned paper invoice (skewed, grainy, off-white) → tests OCR."""
    from PIL import Image, ImageDraw, ImageFont, ImageFilter
    import random
    random.seed(number)  # deterministic look (no Date/random reliance elsewhere)
    s = PARTIES[seller]; b = PARTIES[buyer]
    SC = 2
    pw, ph = 1000, 1300
    img = Image.new('RGB', (pw, ph), (250, 249, 246))
    d = ImageDraw.Draw(img)

    def F(sz, bold=False):
        p = '/System/Library/Fonts/Supplemental/Arial Bold.ttf' if bold else '/System/Library/Fonts/Supplemental/Arial.ttf'
        try: return ImageFont.truetype(p, sz)
        except Exception: return ImageFont.truetype('/System/Library/Fonts/Helvetica.ttc', sz)

    ink = (33, 37, 41); mut = (90, 96, 104)
    d.rectangle([60, 60, 940, 150], fill=tuple(int(s['color'][i:i+2], 16) for i in (1, 3, 5)))
    d.text((80, 88), s['name'], font=F(34, True), fill=(255, 255, 255))
    d.text((80, 175), s['addr'][0], font=F(20), fill=mut)
    d.text((80, 202), s['addr'][1], font=F(20), fill=mut)
    d.text((640, 180), 'TAX INVOICE', font=F(40, True), fill=ink)
    d.text((640, 240), 'Invoice No: ' + number, font=F(21), fill=ink)
    d.text((640, 270), 'Date: ' + date, font=F(21), fill=ink)
    d.text((640, 300), 'PO Ref: ' + po_ref, font=F(21), fill=ink)
    d.text((80, 300), 'BILL TO', font=F(18, True), fill=mut)
    d.text((80, 328), b['name'], font=F(24, True), fill=ink)
    d.text((80, 360), b['addr'][0], font=F(20), fill=mut)
    y = 430
    d.rectangle([60, y, 940, y + 44], fill=(238, 240, 243))
    d.text((80, y + 12), 'Description', font=F(21, True), fill=ink)
    d.text((640, y + 12), 'Qty', font=F(21, True), fill=ink)
    d.text((760, y + 12), 'Rate', font=F(21, True), fill=ink)
    d.text((870, y + 12), 'Amount', font=F(21, True), fill=ink)
    y += 60
    for it in items:
        d.text((80, y), it['desc'], font=F(21), fill=ink)
        d.text((640, y), str(it['qty']), font=F(21), fill=ink)
        d.text((760, y), currency + format(it['rate'], ',.2f'), font=F(21), fill=ink)
        d.text((858, y), currency + format(it['qty'] * it['rate'], ',.2f'), font=F(21), fill=ink)
        y += 40
    y += 30
    d.line([600, y, 940, y], fill=(180, 180, 180), width=2)
    d.text((640, y + 16), 'TOTAL DUE', font=F(26, True), fill=ink)
    d.text((820, y + 14), currency + format(total, ',.2f'), font=F(28, True), fill=tuple(int(s['color'][i:i+2], 16) for i in (1, 3, 5)))
    d.text((80, 1180), 'Payment due within 30 days.  Thank you.', font=F(19), fill=mut)

    # photograph it: soft shadow, slight skew, grain, blur, warm cast
    img = img.rotate(-1.6, expand=1, fillcolor=(247, 246, 243), resample=Image.BICUBIC)
    img = img.filter(ImageFilter.GaussianBlur(0.6))
    px = img.load()
    for _ in range(9000):
        xx = random.randint(0, img.size[0] - 1); yy = random.randint(0, img.size[1] - 1)
        v = random.randint(-16, 16); r, g, bl = px[xx, yy]
        px[xx, yy] = (max(0, min(255, r + v)), max(0, min(255, g + v)), max(0, min(255, bl + v)))
    # vignette-ish darkening on one corner (uneven lighting)
    shade = Image.new('L', img.size, 0); sd = ImageDraw.Draw(shade)
    sd.ellipse([-300, -300, img.size[0] + 120, img.size[1] + 500], fill=28)
    img = Image.composite(Image.new('RGB', img.size, (0, 0, 0)), img, shade.filter(ImageFilter.GaussianBlur(120)))
    img.save(path, 'PNG')
