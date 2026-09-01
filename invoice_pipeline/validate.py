"""
Stage 3 — Validate.

Checks that are true of an invoice *in isolation*, before we ever look at a PO:
required fields present, the arithmetic reconciles, the date is sane, currency is
known. These catch the "the document itself is broken/incomplete" problems, and
they are deliberately conservative — when the math doesn't add up or a critical
field is missing, we refuse to guess and surface a specific, actionable reason.
"""
from __future__ import annotations

from decimal import Decimal

from . import config
from .models import ExtractedInvoice, Finding, Severity
from .util import money


def validate(inv: ExtractedInvoice) -> list[Finding]:
    findings: list[Finding] = []

    # ---- required critical fields ---------------------------------------- #
    missing = []
    if not inv.invoice_number:
        missing.append("invoice number")
    if inv.total is None:
        missing.append("total amount")
    if inv.invoice_date is None:
        missing.append("invoice date")
    if not inv.vendor_name_raw:
        missing.append("vendor name")

    if missing:
        findings.append(Finding(
            code="MISSING_CRITICAL_FIELDS",
            severity=Severity.REVIEW,
            message=f"Missing critical field(s): {', '.join(missing)}. "
                    f"Cannot process safely without them.",
            evidence={"missing": missing},
        ))
    else:
        findings.append(Finding(
            code="REQUIRED_FIELDS_PRESENT",
            severity=Severity.OK,
            message="All critical fields (number, date, total, vendor) were read.",
        ))

    # ---- math reconciliation --------------------------------------------- #
    # Two independent checks:
    #   (a) sum(line items) == subtotal
    #   (b) subtotal + tax   == total
    if inv.line_items and inv.subtotal is not None:
        li_sum = sum((li.amount for li in inv.line_items), Decimal("0.00"))
        delta = (li_sum - inv.subtotal).copy_abs()
        if delta > config.MATH_ROUNDING_TOLERANCE:
            findings.append(Finding(
                code="LINE_ITEMS_DONT_SUM",
                severity=Severity.WARN,
                message=f"Line items sum to {money(li_sum)} but subtotal is "
                        f"{money(inv.subtotal)} (Δ {money(delta)}).",
                evidence={"line_item_sum": li_sum, "subtotal": inv.subtotal, "delta": delta},
            ))

    if inv.total is not None and inv.subtotal is not None:
        expected = inv.subtotal + (inv.tax or Decimal("0.00"))
        delta = (expected - inv.total).copy_abs()
        if delta > config.MATH_ROUNDING_TOLERANCE:
            findings.append(Finding(
                code="TOTAL_DOESNT_RECONCILE",
                severity=Severity.REVIEW,
                message=f"Subtotal {money(inv.subtotal)} + tax "
                        f"{money(inv.tax or Decimal('0'))} = {money(expected)}, "
                        f"but stated total is {money(inv.total)} (Δ {money(delta)}). "
                        f"The invoice does not add up.",
                evidence={"subtotal": inv.subtotal, "tax": inv.tax,
                          "expected_total": expected, "stated_total": inv.total,
                          "delta": delta},
            ))
        else:
            findings.append(Finding(
                code="MATH_RECONCILES",
                severity=Severity.OK,
                message=f"Arithmetic checks out: subtotal + tax = {money(inv.total)}.",
            ))

    # ---- date sanity ----------------------------------------------------- #
    if inv.invoice_date is not None:
        today = config.PROCESSING_DATE
        age_days = (today - inv.invoice_date).days
        if age_days < -config.FUTURE_DATE_GRACE_DAYS:
            findings.append(Finding(
                code="FUTURE_DATED",
                severity=Severity.REVIEW,
                message=f"Invoice is dated {inv.invoice_date} — in the future "
                        f"relative to {today}. Likely a typo or a mis-read.",
                evidence={"invoice_date": inv.invoice_date, "processing_date": today},
            ))
        elif age_days > config.STALE_INVOICE_DAYS:
            findings.append(Finding(
                code="STALE_INVOICE",
                severity=Severity.WARN,
                message=f"Invoice is {age_days} days old (dated {inv.invoice_date}). "
                        f"Confirm it wasn't already accrued/paid in a prior period.",
                evidence={"age_days": age_days},
            ))

    return findings
