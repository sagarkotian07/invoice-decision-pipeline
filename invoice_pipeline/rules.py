"""
Stage 5 — Business rules.

Everything that requires the procurement context: does the money line up with the
PO, is this a duplicate, would it overbill the PO, is the read trustworthy enough
to act on. Each rule emits Findings; nothing here decides the outcome — that's
``decide.py``'s job, purely from the Findings produced here and upstream.

The amount logic branches on the PO's billing model, because "is this amount OK?"
means different things for the two:

  * NON-PARTIAL PO  -> billed once, in full. Compare the invoice to the PO total.
                       A *second* invoice on a one-shot PO is itself a red flag.
  * PARTIAL PO      -> billed across several invoices. Compare the running
                       cumulative (already billed + this invoice) to the PO total.
                       This is the stateful case where overbilling creeps in.
"""
from __future__ import annotations

from decimal import Decimal

from . import config
from .match import MatchResult
from .models import ExtractedInvoice, Finding, PurchaseOrder, Severity
from .procurement import Procurement
from .util import money


def _auto_tol(po: PurchaseOrder) -> Decimal:
    return max(po.total_amount * config.AUTO_TOLERANCE_PCT, config.AUTO_TOLERANCE_ABS)


def _approver_band(po: PurchaseOrder) -> Decimal:
    return max(po.total_amount * config.APPROVER_BAND_PCT, config.APPROVER_BAND_ABS)


def apply_rules(
    inv: ExtractedInvoice,
    mr: MatchResult,
    proc: Procurement,
    ingest_kind: str,
) -> list[Finding]:
    findings: list[Finding] = []

    # ---- 0. extraction confidence gate ----------------------------------- #
    if inv.extraction_confidence < float(config.MIN_EXTRACTION_CONFIDENCE):
        findings.append(Finding(
            code="LOW_EXTRACTION_CONFIDENCE",
            severity=Severity.REVIEW,
            message=f"Extraction confidence {inv.extraction_confidence:.0%} is below "
                    f"the {float(config.MIN_EXTRACTION_CONFIDENCE):.0%} threshold "
                    f"required to act automatically"
                    + (" (document was a scanned image — OCR needed)."
                       if ingest_kind == "scanned-image"
                       else " — some fields are uncertain."),
            evidence={"extraction_confidence": inv.extraction_confidence,
                      "threshold": float(config.MIN_EXTRACTION_CONFIDENCE),
                      "source_kind": ingest_kind},
        ))
    else:
        findings.append(Finding(
            code="EXTRACTION_TRUSTED",
            severity=Severity.OK,
            message=f"Extraction confidence {inv.extraction_confidence:.0%} clears the "
                    f"automation threshold.",
        ))

    # ---- 1. duplicate detection ------------------------------------------ #
    dups = proc.find_duplicates(
        vendor_id=mr.vendor_id,
        invoice_number=inv.invoice_number,
        total=inv.total,
        invoice_date=inv.invoice_date,
    )
    for kind, entry in dups:
        if kind == "EXACT":
            findings.append(Finding(
                code="DUPLICATE_EXACT",
                severity=Severity.REJECT,
                message=f"Exact duplicate: invoice #{inv.invoice_number} from this "
                        f"vendor was already processed ({money(entry.total)}, "
                        f"decision {entry.decision}). Blocking to prevent double payment.",
                evidence={"prior_invoice": entry.invoice_number,
                          "prior_amount": entry.total, "prior_decision": entry.decision},
            ))
        else:  # NEAR
            findings.append(Finding(
                code="DUPLICATE_NEAR",
                severity=Severity.REVIEW,
                message=f"Possible duplicate: same vendor, same amount "
                        f"({money(inv.total)}) and same date ({inv.invoice_date}) as "
                        f"already-processed invoice #{entry.invoice_number}, but a "
                        f"different invoice number (#{inv.invoice_number}). Classic "
                        f"accidental double-billing — needs a human to confirm.",
                evidence={"this_invoice": inv.invoice_number,
                          "matched_prior": entry.invoice_number,
                          "amount": inv.total, "date": inv.invoice_date},
            ))
    if not dups:
        findings.append(Finding(
            code="NO_DUPLICATE",
            severity=Severity.OK,
            message="No matching invoice found in the ledger — not a duplicate.",
        ))

    # ---- 2. PO-dependent checks ------------------------------------------ #
    po = mr.po
    if po is None:
        return findings  # matching stage already explained why there's no PO

    # currency
    if inv.currency != po.currency:
        findings.append(Finding(
            code="CURRENCY_MISMATCH",
            severity=Severity.REJECT,
            message=f"Invoice currency {inv.currency} != PO currency {po.currency}.",
            evidence={"invoice_currency": inv.currency, "po_currency": po.currency},
        ))

    if inv.total is None:
        return findings

    # amount vs PO — branch on billing model
    if po.allow_partial:
        findings.extend(_check_partial(inv, po, proc))
    else:
        findings.extend(_check_single(inv, po))

    return findings


def _check_single(inv: ExtractedInvoice, po: PurchaseOrder) -> list[Finding]:
    """Non-partial PO: expected to be billed exactly once, in full."""
    out: list[Finding] = []

    # A second invoice against a one-shot PO is suspicious in its own right.
    if po.amount_already_billed > 0:
        out.append(Finding(
            code="SECOND_INVOICE_ON_SINGLE_PO",
            severity=Severity.REVIEW,
            message=f"PO {po.po_number} is not marked for partial billing but "
                    f"{money(po.amount_already_billed)} has already been billed "
                    f"against it. A second invoice here needs a human to confirm it "
                    f"isn't a duplicate or to raise a change order.",
            evidence={"already_billed": po.amount_already_billed,
                      "po_total": po.total_amount},
        ))

    variance = inv.total - po.total_amount
    av = variance.copy_abs()
    out.append(_variance_finding(inv, po, variance, av, base=po.total_amount,
                                 base_label="PO total"))
    return out


def _check_partial(inv: ExtractedInvoice, po: PurchaseOrder,
                   proc: Procurement) -> list[Finding]:
    """Partial PO: compare the running cumulative to the PO ceiling."""
    out: list[Finding] = []
    remaining = po.remaining_balance
    cumulative = po.amount_already_billed + inv.total
    over = cumulative - po.total_amount     # >0 means this invoice overbills the PO

    prior = [e for e in proc.ledger if e.po_number == po.po_number]
    prior_desc = ", ".join(f"#{e.invoice_number} {money(e.total)}" for e in prior) or "none"

    if over <= config.MATH_ROUNDING_TOLERANCE:
        # fits within the PO
        new_remaining = po.total_amount - cumulative
        out.append(Finding(
            code="PARTIAL_BILLING_OK",
            severity=Severity.OK,
            message=f"Partial billing OK: {money(po.amount_already_billed)} already "
                    f"billed + this {money(inv.total)} = {money(cumulative)} of a "
                    f"{money(po.total_amount)} PO. {money(new_remaining)} would remain.",
            evidence={"already_billed": po.amount_already_billed,
                      "this_invoice": inv.total, "cumulative": cumulative,
                      "remaining_after": new_remaining, "prior_invoices": prior_desc},
        ))
        return out

    # overbills — is it within an approver's band, or beyond?
    band = _approver_band(po)
    if over <= band:
        out.append(Finding(
            code="CUMULATIVE_OVERBILL_APPROVABLE",
            severity=Severity.HOLD,
            message=f"This invoice would push cumulative billing to "
                    f"{money(cumulative)} on a {money(po.total_amount)} PO — "
                    f"{money(over)} over (prior: {prior_desc}). Within the approver "
                    f"band; needs sign-off to raise the PO.",
            evidence={"cumulative": cumulative, "po_total": po.total_amount,
                      "overage": over, "prior_invoices": prior_desc},
        ))
    else:
        out.append(Finding(
            code="CUMULATIVE_OVERBILL",
            severity=Severity.REJECT,
            message=f"Cumulative overbilling: {money(po.amount_already_billed)} already "
                    f"billed across [{prior_desc}] + this {money(inv.total)} = "
                    f"{money(cumulative)}, which exceeds PO {po.po_number} "
                    f"({money(po.total_amount)}) by {money(over)} — beyond the "
                    f"approver band ({money(band)}). Blocking.",
            evidence={"already_billed": po.amount_already_billed,
                      "this_invoice": inv.total, "cumulative": cumulative,
                      "po_total": po.total_amount, "overage": over,
                      "approver_band": band, "prior_invoices": prior_desc},
        ))
    return out


def _variance_finding(inv, po, variance, av, base, base_label) -> Finding:
    auto = _auto_tol(po)
    band = _approver_band(po)
    pct = (av / base * 100) if base else Decimal("0")
    direction = "over" if variance > 0 else "under"

    if av <= auto:
        return Finding(
            code="AMOUNT_WITHIN_TOLERANCE",
            severity=Severity.OK,
            message=f"Invoice {money(inv.total)} is within tolerance of the "
                    f"{base_label} {money(base)} (Δ {money(av)}, {pct:.1f}%).",
            evidence={"invoice_total": inv.total, "po_total": base, "delta": av},
        )
    if av <= band:
        return Finding(
            code="AMOUNT_OVER_TOLERANCE",
            severity=Severity.HOLD,
            message=f"Invoice {money(inv.total)} is {money(av)} ({pct:.1f}%) "
                    f"{direction} the {base_label} {money(base)} — beyond auto "
                    f"tolerance ({money(auto)}) but within the approver band "
                    f"({money(band)}). Route to an approver for variance sign-off.",
            evidence={"invoice_total": inv.total, "po_total": base, "delta": av,
                      "auto_tolerance": auto, "approver_band": band},
        )
    return Finding(
        code="AMOUNT_EXCEEDS_BAND",
        severity=Severity.REJECT,
        message=f"Invoice {money(inv.total)} is {money(av)} ({pct:.1f}%) {direction} "
                f"the {base_label} {money(base)} — beyond the approver band "
                f"({money(band)}). This is not a rounding difference; blocking.",
        evidence={"invoice_total": inv.total, "po_total": base, "delta": av,
                  "approver_band": band},
    )
