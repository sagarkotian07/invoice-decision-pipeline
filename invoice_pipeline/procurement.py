"""
The procurement system.

Wraps the PO master, the vendor master, and the invoice ledger, and exposes the
few questions the pipeline actually needs to ask:

  * who is this vendor, and are they approved?      -> resolve_vendor()
  * which PO does this belong to?                    -> find_po() / pos_for_vendor()
  * how much of that PO is already spent?            -> loaded onto PurchaseOrder
  * have we seen this invoice before?                -> find_duplicates()

Keeping these behind one object means the rest of the pipeline never touches raw
JSON, and a real ERP integration would only need to reimplement this file.
"""
from __future__ import annotations

import json
from decimal import Decimal
from difflib import SequenceMatcher
from pathlib import Path
from typing import Optional

from . import config
from .models import LedgerEntry, PurchaseOrder, Vendor
from .util import parse_date


def _norm(name: str) -> str:
    """Normalise a company name for comparison: lowercase, strip legal suffixes."""
    s = name.lower().strip()
    for junk in [",", ".", "  "]:
        s = s.replace(junk, " ")
    for suffix in [" inc", " incorporated", " llc", " ltd", " limited",
                   " corp", " corporation", " co", " company", " gmbh"]:
        if s.endswith(suffix):
            s = s[: -len(suffix)]
    return " ".join(s.split())


class Procurement:
    def __init__(self, po_path: Path, ledger_path: Path) -> None:
        po_raw = json.loads(Path(po_path).read_text())
        ledger_raw = json.loads(Path(ledger_path).read_text())

        self.vendors: dict[str, Vendor] = {
            v["vendor_id"]: Vendor(
                vendor_id=v["vendor_id"],
                name=v["name"],
                aliases=v.get("aliases", []),
                approved=v.get("approved", True),
                payment_terms=v.get("payment_terms", "NET30"),
            )
            for v in po_raw["vendors"]
        }

        self.ledger: list[LedgerEntry] = [
            LedgerEntry(
                invoice_number=e.get("invoice_number"),
                vendor_id=e.get("vendor_id"),
                po_number=e.get("po_number"),
                total=Decimal(e["total"]) if e.get("total") else None,
                invoice_date=parse_date(e.get("invoice_date")),
                amount_applied=Decimal(e.get("amount_applied", "0")),
                decision=e.get("decision", ""),
            )
            for e in ledger_raw["entries"]
        ]

        # Load POs and fold in how much each has already been billed (statefulness).
        self.purchase_orders: dict[str, PurchaseOrder] = {}
        for p in po_raw["purchase_orders"]:
            po = PurchaseOrder(
                po_number=p["po_number"],
                vendor_id=p["vendor_id"],
                total_amount=Decimal(p["total_amount"]),
                currency=p.get("currency", "USD"),
                status=p.get("status", "open"),
                allow_partial=p.get("allow_partial", False),
                description=p.get("description", ""),
            )
            po.amount_already_billed = sum(
                (e.amount_applied for e in self.ledger if e.po_number == po.po_number),
                Decimal("0.00"),
            )
            self.purchase_orders[po.po_number] = po

    # ---- vendor resolution ------------------------------------------------- #
    def resolve_vendor(self, raw_name: Optional[str]) -> tuple[Optional[Vendor], float]:
        """
        Map a free-text vendor name off the invoice to an approved vendor.
        Returns (vendor_or_None, match_confidence). Exact/alias match -> 1.0;
        fuzzy match above threshold -> the ratio; otherwise (None, best_ratio).
        """
        if not raw_name:
            return None, 0.0
        target = _norm(raw_name)
        best: tuple[Optional[Vendor], float] = (None, 0.0)
        for v in self.vendors.values():
            candidates = [v.name] + v.aliases
            for cand in candidates:
                ratio = SequenceMatcher(None, target, _norm(cand)).ratio()
                if _norm(cand) == target:
                    ratio = 1.0
                if ratio > best[1]:
                    best = (v, ratio)
        vendor, ratio = best
        if ratio >= config.VENDOR_FUZZY_THRESHOLD:
            return vendor, ratio
        return None, ratio

    # ---- PO lookup --------------------------------------------------------- #
    def find_po(self, po_number: Optional[str]) -> Optional[PurchaseOrder]:
        if not po_number:
            return None
        # tolerate formatting drift: "PO1001", "po-1001", "1001"
        key = po_number.upper().replace(" ", "").replace("PO", "").lstrip("-#")
        for po_num, po in self.purchase_orders.items():
            norm = po_num.upper().replace(" ", "").replace("PO", "").lstrip("-#")
            if norm == key:
                return po
        return None

    def pos_for_vendor(self, vendor_id: Optional[str]) -> list[PurchaseOrder]:
        if not vendor_id:
            return []
        return [
            po
            for po in self.purchase_orders.values()
            if po.vendor_id == vendor_id and po.status == "open"
        ]

    # ---- duplicate detection ---------------------------------------------- #
    def find_duplicates(
        self,
        vendor_id: Optional[str],
        invoice_number: Optional[str],
        total: Optional[Decimal],
        invoice_date,
    ) -> list[tuple[str, LedgerEntry]]:
        """
        Return (kind, ledger_entry) pairs, where kind is "EXACT" or "NEAR".

          EXACT: same vendor + same invoice number  -> almost certainly a resubmission.
          NEAR : same vendor + same total + same date but a different invoice
                 number -> the fingerprint of an accidental double-billing.
        """
        hits: list[tuple[str, LedgerEntry]] = []
        for e in self.ledger:
            if vendor_id and e.vendor_id != vendor_id:
                continue
            if (
                invoice_number
                and e.invoice_number
                and e.invoice_number.upper() == invoice_number.upper()
            ):
                hits.append(("EXACT", e))
                continue
            same_total = (
                total is not None
                and e.total is not None
                and abs(e.total - total) <= config.NEAR_DUP_AMOUNT_TOLERANCE
            )
            same_date = invoice_date is not None and e.invoice_date == invoice_date
            diff_number = (
                not invoice_number
                or not e.invoice_number
                or e.invoice_number.upper() != invoice_number.upper()
            )
            if same_total and same_date and diff_number:
                hits.append(("NEAR", e))
        return hits
