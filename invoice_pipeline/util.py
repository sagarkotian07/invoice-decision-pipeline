"""Small, well-tested parsing helpers shared across stages."""
from __future__ import annotations

import re
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from typing import Optional

# Symbols we recognise and the currency they imply.
CURRENCY_SYMBOLS = {"$": "USD", "€": "EUR", "£": "GBP", "₹": "INR"}


def parse_money(text: Optional[str]) -> Optional[Decimal]:
    """
    Parse a monetary string into Decimal, tolerating the mess real invoices carry:
    '$1,234.56', 'USD 1234.56', '1,234.56', '(120.00)' (accounting negative).
    Returns None if there is no parseable number.
    """
    if text is None:
        return None
    s = str(text).strip()
    if not s:
        return None
    negative = s.startswith("(") and s.endswith(")")
    s = s.strip("()")
    # drop currency words/symbols
    s = re.sub(r"(?i)\b(usd|eur|gbp|inr|rs)\b", "", s)
    for sym in CURRENCY_SYMBOLS:
        s = s.replace(sym, "")
    s = s.strip()
    # keep only digits, separators, sign
    s = re.sub(r"[^0-9.,\-]", "", s)
    if not s:
        return None
    # Normalise thousands/decimal separators. We assume '.' is the decimal point
    # when both separators appear; strip ',' as thousands.
    if "," in s and "." in s:
        s = s.replace(",", "")
    elif "," in s and "." not in s:
        # could be european decimal comma; treat as thousands only if it groups by 3
        if re.match(r"^\d{1,3}(,\d{3})+$", s):
            s = s.replace(",", "")
        else:
            s = s.replace(",", ".")
    try:
        val = Decimal(s)
    except (InvalidOperation, ValueError):
        return None
    return -val if negative else val


def detect_currency(text: str) -> Optional[str]:
    for sym, code in CURRENCY_SYMBOLS.items():
        if sym in text:
            return code
    m = re.search(r"\b(USD|EUR|GBP|INR)\b", text)
    return m.group(1) if m else None


_DATE_FORMATS = [
    "%Y-%m-%d", "%d/%m/%Y", "%m/%d/%Y", "%d-%m-%Y", "%m-%d-%Y",
    "%d %b %Y", "%d %B %Y", "%b %d, %Y", "%B %d, %Y", "%d.%m.%Y",
    "%Y/%m/%d", "%d-%b-%Y",
]


def parse_date(text: Optional[str]) -> Optional[date]:
    """Parse a date across the formats vendors actually use. None if unparseable."""
    if not text:
        return None
    if isinstance(text, date):
        return text
    s = str(text).strip()
    for fmt in _DATE_FORMATS:
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    return None


def money(d: Optional[Decimal]) -> str:
    """Human-format a Decimal as money, or '—' if missing."""
    if d is None:
        return "—"
    return f"${d:,.2f}"
