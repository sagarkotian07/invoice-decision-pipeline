"""
Stage 2 — Extract.

Turn raw invoice text into a structured ``ExtractedInvoice``. Different vendors
label the same concept differently ("Invoice No." vs "Bill Number" vs "Inv #";
"Total Due" vs "Amount Payable" vs "Grand Total"), so we don't hard-code one
layout. For each field we try an *ordered* list of labelled patterns, most
specific first, and record which one matched plus a confidence:

  * matched an explicit label            -> high confidence (0.90–0.95)
  * fell back to a positional heuristic  -> medium confidence (0.55–0.70)
  * not found                            -> confidence 0.0

The overall ``extraction_confidence`` blends the ingest confidence with how well
the four critical fields (number, date, total, vendor) came through. That single
number is what the safety gate downstream keys off.
"""
from __future__ import annotations

import re
from decimal import Decimal
from typing import Optional

from .models import ExtractedInvoice, Field, LineItem
from .util import detect_currency, parse_date, parse_money

_MONEY_TOKEN = r"[\$€£₹]?\s?\(?-?\d[\d,]*(?:\.\d{1,2})?\)?"
_GENERIC_TITLES = {"invoice", "tax invoice", "bill", "statement", "receipt"}


def _lines(text: str) -> list[str]:
    return [ln.strip() for ln in text.splitlines() if ln.strip()]


def _find_id(lines: list[str], patterns: list[str], require_digit: bool = True) -> Field:
    """First labelled id/reference match wins. When ``require_digit`` is set we
    reject digit-less captures — this stops prose like 'No invoice number
    printed' from being mistaken for an actual id (invoice/PO numbers always
    carry digits)."""
    for conf, pat in patterns:
        rx = re.compile(pat, re.I)
        for line in lines:
            m = rx.search(line)
            if not (m and m.group(1)):
                continue
            value = m.group(1).strip()
            if require_digit and not any(ch.isdigit() for ch in value):
                continue
            return Field(value=value, confidence=conf,
                         source=f"label:{rx.pattern[:28]}…")
    return Field(value=None, confidence=0.0, source="not-found")


def _money_on_line(line: str) -> Optional[Decimal]:
    toks = re.findall(_MONEY_TOKEN, line)
    toks = [t for t in toks if any(ch.isdigit() for ch in t)]
    if not toks:
        return None
    return parse_money(toks[-1])           # the last money token on a total line


def _find_money(lines: list[str], labels: list[tuple[float, str]],
                exclude: tuple[str, ...] = ()) -> Field:
    for conf, label in labels:
        rx = re.compile(label, re.I)
        for line in lines:
            if any(x in line.lower() for x in exclude):
                continue
            if rx.search(line):
                val = _money_on_line(line)
                if val is not None:
                    return Field(value=val, confidence=conf, source=f"label:'{label}'")
    return Field(value=None, confidence=0.0, source="not-found")


def _find_date(lines: list[str]) -> Field:
    # Prefer explicit "invoice/issue date"; never confuse with "due date".
    labelled = [
        (0.95, r"invoice\s*date"),
        (0.95, r"date\s*of\s*issue"),
        (0.90, r"issue\s*date"),
        (0.80, r"\bdated\b"),
    ]
    for conf, label in labelled:
        rx = re.compile(label, re.I)
        for line in lines:
            if "due" in line.lower():
                continue
            if rx.search(line):
                tail = rx.split(line)[-1]
                for token in re.split(r"[:#]|\s{2,}", tail):
                    d = parse_date(token.strip())
                    if d:
                        return Field(value=d, confidence=conf, source=f"label:'{label}'")
    # Fallback: a bare "Date:" label
    for line in lines:
        if re.match(r"(?i)^date\b", line) and "due" not in line.lower():
            for token in re.split(r"[:#]", line)[1:]:
                d = parse_date(token.strip())
                if d:
                    return Field(value=d, confidence=0.65, source="label:'Date'")
    return Field(value=None, confidence=0.0, source="not-found")


def _find_vendor(lines: list[str]) -> Field:
    # Note: we deliberately do NOT use "Remit To" — that's the payee line and is
    # often noisy (carries terms/addresses); the seller header is more reliable.
    labelled = [
        (0.92, r"(?:bill\s*from|sold\s*by|supplier|vendor)\s*[:#]?\s*(.+)"),
    ]
    for conf, pat in labelled:
        rx = re.compile(pat, re.I)
        for line in lines:
            m = rx.search(line)
            if m and m.group(1).strip():
                return Field(value=m.group(1).strip(), confidence=conf, source="label:vendor")
    # Fallback: the first non-generic header line is almost always the seller.
    for line in lines[:4]:
        if line.lower().strip(" -:") in _GENERIC_TITLES:
            continue
        if re.search(r"[A-Za-z]{3,}", line) and not re.match(r"(?i)^(invoice|bill|date|po)", line):
            return Field(value=line, confidence=0.62, source="heuristic:header-line")
    return Field(value=None, confidence=0.0, source="not-found")


def _extract_line_items(lines: list[str]) -> list[LineItem]:
    header_idx = None
    for i, line in enumerate(lines):
        low = line.lower()
        hits = sum(k in low for k in ("description", "qty", "quantity", "unit",
                                      "price", "amount", "rate", "item"))
        if hits >= 2:
            header_idx = i
            break
    if header_idx is None:
        return []

    items: list[LineItem] = []
    for line in lines[header_idx + 1:]:
        low = line.lower()
        if any(k in low for k in ("subtotal", "sub total", "grand total", "total",
                                  "tax", "vat", "gst", "balance", "amount due")):
            break
        toks = [t for t in re.findall(_MONEY_TOKEN, line) if any(c.isdigit() for c in t)]
        if not toks:
            continue
        amount = parse_money(toks[-1])
        if amount is None:
            continue
        qty = unit = None
        nums = re.findall(r"\d+(?:\.\d+)?", line)
        if len(toks) >= 2:
            unit = parse_money(toks[-2])
        if nums:
            try:
                qty = Decimal(nums[0])
            except Exception:
                qty = None
        desc = re.sub(_MONEY_TOKEN, "", line).strip(" .-\t")
        desc = re.sub(r"^\d+(\.\d+)?\s*", "", desc).strip()
        items.append(LineItem(description=desc or "(unlabelled)",
                              quantity=qty, unit_price=unit, amount=amount))
    return items


def extract(raw_text: str, ingest_confidence: float) -> ExtractedInvoice:
    lines = _lines(raw_text)
    inv = ExtractedInvoice()

    inv.fields["invoice_number"] = _find_id(lines, [
        (0.95, r"invoice\s*(?:number|no\.?|#|num)\s*[:#]?\s*([A-Za-z0-9][A-Za-z0-9\-/]{2,})"),
        (0.93, r"\bbill\s*(?:number|no\.?|#)\s*[:#]?\s*([A-Za-z0-9][A-Za-z0-9\-/]{2,})"),
        (0.90, r"\binv\s*[:#]\s*([A-Za-z0-9][A-Za-z0-9\-/]{2,})"),
    ])
    inv.fields["po_reference"] = _find_id(lines, [
        (0.95, r"(?:purchase\s*order|p\.?o\.?)\s*(?:number|no\.?|#|ref)?\s*[:#]?\s*(PO[-\s]?\d+|\d{3,})"),
        (0.90, r"\bpo\b\s*[:#]?\s*(PO[-\s]?\d+|\d{3,})"),
        (0.85, r"\bref(?:erence)?\s*[:#]?\s*(PO[-\s]?\d+)"),
    ])
    inv.fields["invoice_date"] = _find_date(lines)
    inv.fields["vendor"] = _find_vendor(lines)
    inv.fields["total"] = _find_money(lines, [
        (0.95, r"(?:grand\s*total|total\s*due|amount\s*due|balance\s*due|"
               r"total\s*payable|amount\s*payable|invoice\s*total)"),
        (0.75, r"\btotal\b"),
    ], exclude=("subtotal", "sub total"))
    inv.fields["subtotal"] = _find_money(lines, [
        (0.92, r"(?:sub\s*total|subtotal|net\s*amount|net\s*total)"),
    ])
    inv.fields["tax"] = _find_money(lines, [
        (0.90, r"\b(?:tax|vat|gst|sales\s*tax)\b"),
    ], exclude=("subtotal",))

    # populate typed fields
    inv.invoice_number = inv.fields["invoice_number"].value
    inv.po_reference = _clean_po(inv.fields["po_reference"].value)
    inv.invoice_date = inv.fields["invoice_date"].value
    inv.vendor_name_raw = inv.fields["vendor"].value
    inv.total = inv.fields["total"].value
    inv.subtotal = inv.fields["subtotal"].value
    inv.tax = inv.fields["tax"].value
    inv.currency = detect_currency(raw_text) or "USD"
    inv.line_items = _extract_line_items(lines)

    # ---- overall extraction confidence ----------------------------------- #
    critical = ["invoice_number", "invoice_date", "total", "vendor"]
    confs = [inv.fields[c].confidence for c in critical]
    field_score = sum(confs) / len(confs)
    inv.extraction_confidence = round(ingest_confidence * field_score, 3)
    return inv


def _clean_po(raw: Optional[str]) -> Optional[str]:
    if not raw:
        return None
    m = re.search(r"(PO[-\s]?\d+|\d{3,})", raw, re.I)
    if not m:
        return None
    val = m.group(1).upper().replace(" ", "")
    return val if val.startswith("PO") else f"PO-{val}"
