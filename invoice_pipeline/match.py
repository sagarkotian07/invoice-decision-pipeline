"""
Stage 4 — Match.

Bind the invoice to the procurement system:

  1. Resolve the free-text vendor name to an approved vendor (exact, alias, or
     fuzzy). An unapproved / unresolvable vendor is a hard stop.
  2. Find the PO. Prefer the explicit PO reference on the invoice; if it's
     missing, *try* to infer one from the vendor's open POs — but only accept an
     inferred match when it's unambiguous. We never silently pick "the closest"
     PO when several are plausible; ambiguity routes to a human.

Returns the chosen PurchaseOrder (or None) plus findings explaining the choice.
"""
from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Optional

from . import config
from .models import ExtractedInvoice, Finding, PurchaseOrder, Severity
from .procurement import Procurement
from .util import money


@dataclass
class MatchResult:
    vendor_id: Optional[str]
    vendor_name: Optional[str]
    po: Optional[PurchaseOrder]
    po_match_basis: str            # "explicit-reference" | "inferred-unique" | "none"


def match(inv: ExtractedInvoice, proc: Procurement) -> tuple[MatchResult, list[Finding]]:
    findings: list[Finding] = []

    # ---- 1. vendor ------------------------------------------------------- #
    vendor, ratio = proc.resolve_vendor(inv.vendor_name_raw)
    if vendor is None:
        findings.append(Finding(
            code="VENDOR_NOT_APPROVED",
            severity=Severity.REJECT,
            message=f"Vendor '{inv.vendor_name_raw}' does not match any approved "
                    f"vendor (best similarity {ratio:.0%}). Payments to "
                    f"un-onboarded vendors are blocked.",
            evidence={"raw_vendor": inv.vendor_name_raw, "best_ratio": round(ratio, 3)},
        ))
        return MatchResult(None, None, None, "none"), findings

    inv.vendor_id = vendor.vendor_id
    inv.vendor_name_canonical = vendor.name
    basis = "exact/alias" if ratio >= 0.999 else f"fuzzy {ratio:.0%}"
    findings.append(Finding(
        code="VENDOR_APPROVED",
        severity=Severity.OK,
        message=f"Vendor resolved to {vendor.name} ({vendor.vendor_id}) [{basis}].",
        evidence={"vendor_id": vendor.vendor_id, "match_ratio": round(ratio, 3)},
    ))

    # ---- 2. purchase order ----------------------------------------------- #
    po = proc.find_po(inv.po_reference)
    match_basis = "none"

    if po is not None:
        match_basis = "explicit-reference"
        findings.append(Finding(
            code="PO_FOUND_EXPLICIT",
            severity=Severity.OK,
            message=f"Matched explicit PO reference {po.po_number} "
                    f"({money(po.total_amount)}, {po.description}).",
            evidence={"po_number": po.po_number, "basis": "explicit-reference"},
        ))
    else:
        if inv.po_reference:
            findings.append(Finding(
                code="PO_REFERENCE_UNKNOWN",
                severity=Severity.REVIEW,
                message=f"Invoice cites PO '{inv.po_reference}' but no such PO "
                        f"exists in the procurement system.",
                evidence={"cited_po": inv.po_reference},
            ))
        # try to infer from the vendor's open POs
        candidates = proc.pos_for_vendor(vendor.vendor_id)
        plausible = [c for c in candidates if _amount_plausible(inv.total, c)]
        if len(plausible) == 1 and inv.po_reference is None:
            po = plausible[0]
            match_basis = "inferred-unique"
            findings.append(Finding(
                code="PO_INFERRED",
                severity=Severity.WARN,
                message=f"No PO on the invoice, but exactly one open PO for this "
                        f"vendor plausibly fits the amount: {po.po_number}. "
                        f"Inferred (flagged for confirmation).",
                evidence={"po_number": po.po_number, "basis": "inferred-unique"},
            ))
        elif inv.po_reference is None:
            findings.append(Finding(
                code="PO_UNRESOLVED",
                severity=Severity.REVIEW,
                message=f"No PO reference on the invoice and it can't be inferred "
                        f"unambiguously ({len(plausible)} open PO(s) for "
                        f"{vendor.name} could fit {money(inv.total)}). Needs a human "
                        f"to attach the correct PO.",
                evidence={"vendor_open_pos": [c.po_number for c in candidates],
                          "plausible": [c.po_number for c in plausible]},
            ))

    # ---- 3. sanity: PO belongs to this vendor & is open ------------------ #
    if po is not None:
        if po.vendor_id != vendor.vendor_id:
            findings.append(Finding(
                code="PO_VENDOR_MISMATCH",
                severity=Severity.REJECT,
                message=f"PO {po.po_number} belongs to a different vendor than "
                        f"the invoice ({vendor.name}).",
                evidence={"po_vendor": po.vendor_id, "invoice_vendor": vendor.vendor_id},
            ))
        if po.status != "open":
            findings.append(Finding(
                code="PO_CLOSED",
                severity=Severity.REJECT,
                message=f"PO {po.po_number} is {po.status}; it cannot accept new "
                        f"invoices.",
                evidence={"po_status": po.status},
            ))

    return MatchResult(vendor.vendor_id, vendor.name, po, match_basis), findings


def _amount_plausible(total: Optional[Decimal], po: PurchaseOrder) -> bool:
    """Would this invoice amount plausibly belong to this PO? Depends on the
    billing model:
      * partial PO     -> any positive amount up to the remaining balance + band.
      * non-partial PO -> should be roughly the *full* PO amount (billed once),
        so it must land within the approver band of the PO total. This stops us
        from inferring, say, a $3.5k invoice onto an unrelated $8k one-shot PO."""
    if total is None:
        return False
    band = max(po.total_amount * config.APPROVER_BAND_PCT, config.APPROVER_BAND_ABS)
    if po.allow_partial:
        return Decimal("0") < total <= po.remaining_balance + band
    return (total - po.total_amount).copy_abs() <= band
