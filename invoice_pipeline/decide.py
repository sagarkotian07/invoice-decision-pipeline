"""
Stage 6 — Decide.

The decision is a *pure function of the findings*. Given the same findings you get
the same decision, every time — no hidden state, no side effects. That's what
makes the outcome explainable and auditable.

Precedence (worst wins):
    REJECT  >  NEEDS_REVIEW  >  HOLD_FOR_APPROVAL  >  AUTO_APPROVE

The outcome is driven by the single worst severity among all findings; the
"primary reasons" are exactly the findings at that severity, so the explanation
can never disagree with the decision.
"""
from __future__ import annotations

from .models import Decision, Finding, Severity

_OUTCOME_FOR_SEVERITY = {
    Severity.REJECT: "REJECT",
    Severity.REVIEW: "NEEDS_REVIEW",
    Severity.HOLD: "HOLD_FOR_APPROVAL",
}

_HEADLINE = {
    "AUTO_APPROVE": "Approved automatically — safe to pay.",
    "HOLD_FOR_APPROVAL": "Matched, but a human must approve a bounded variance before payment.",
    "NEEDS_REVIEW": "Cannot decide automatically — routed to a person with specific reasons.",
    "REJECT": "Blocked — must not be paid as-is.",
}

# Concrete next step, keyed by the finding code that drove the decision.
_ACTION_FOR_CODE = {
    "DUPLICATE_EXACT": "Do not pay. Confirm against the original payment and close as a duplicate.",
    "DUPLICATE_NEAR": "Compare against the flagged prior invoice; pay only if it's a genuinely separate charge.",
    "CUMULATIVE_OVERBILL": "Return to the vendor or raise a PO change order before any further payment.",
    "CUMULATIVE_OVERBILL_APPROVABLE": "Send to the PO owner to authorise raising the PO, then release.",
    "AMOUNT_EXCEEDS_BAND": "Query the vendor on the overage; do not pay until the PO or invoice is corrected.",
    "AMOUNT_OVER_TOLERANCE": "Route to the budget approver for variance sign-off.",
    "VENDOR_NOT_APPROVED": "Run vendor onboarding/approval before any payment can be considered.",
    "PO_VENDOR_MISMATCH": "Attach the correct PO for this vendor, or reject.",
    "PO_CLOSED": "Ask procurement whether to reopen the PO or issue a new one.",
    "CURRENCY_MISMATCH": "Confirm the billing currency with the vendor/PO owner.",
    "TOTAL_DOESNT_RECONCILE": "Request a corrected invoice whose line items, tax and total agree.",
    "MISSING_CRITICAL_FIELDS": "Request the missing field(s) from the vendor before re-processing.",
    "LOW_EXTRACTION_CONFIDENCE": "Send to manual key-entry / OCR review; re-run once fields are captured.",
    "PO_UNRESOLVED": "Have AP attach the correct PO, then re-run.",
    "PO_REFERENCE_UNKNOWN": "Verify the PO number with the vendor; attach the correct PO.",
    "SECOND_INVOICE_ON_SINGLE_PO": "Confirm this isn't a duplicate; if legitimate, raise a change order.",
}

_DEFAULT_ACTION = {
    "AUTO_APPROVE": "Release for payment per vendor terms.",
    "HOLD_FOR_APPROVAL": "Route to the appropriate approver.",
    "NEEDS_REVIEW": "Assign to an AP specialist to resolve the flagged items.",
    "REJECT": "Do not pay; return to sender with the reason.",
}


def decide(findings: list[Finding]) -> Decision:
    if not findings:
        # Should never happen, but fail safe (to review, not to approve).
        return Decision("NEEDS_REVIEW", 0.0, _HEADLINE["NEEDS_REVIEW"],
                        ["No checks ran."], _DEFAULT_ACTION["NEEDS_REVIEW"])

    worst = max(f.severity for f in findings)
    outcome = _OUTCOME_FOR_SEVERITY.get(worst, "AUTO_APPROVE")

    drivers = [f for f in findings if f.severity == worst and worst >= Severity.HOLD]
    if not drivers:  # auto-approve: reasons are the positive confirmations
        drivers = [f for f in findings if f.severity == Severity.OK]

    reasons = [f"[{f.code}] {f.message}" for f in drivers]

    # Confidence in the *decision*: high when the drivers are unambiguous (REJECT
    # on a hard rule, or a clean all-OK approve); lower for the judgement calls.
    confidence = _decision_confidence(outcome, drivers, findings)

    action = _DEFAULT_ACTION[outcome]
    for f in drivers:
        if f.code in _ACTION_FOR_CODE:
            action = _ACTION_FOR_CODE[f.code]
            break

    return Decision(
        outcome=outcome,
        confidence=confidence,
        headline=_HEADLINE[outcome],
        primary_reasons=reasons,
        recommended_action=action,
    )


def _decision_confidence(outcome, drivers, findings) -> float:
    if outcome == "AUTO_APPROVE":
        # confidence == how many checks passed cleanly, tempered by any warnings
        warns = sum(1 for f in findings if f.severity == Severity.WARN)
        return round(max(0.80, 0.98 - 0.05 * warns), 2)
    if outcome == "REJECT":
        return 0.95            # hard rules; we're confident it shouldn't be paid
    if outcome == "NEEDS_REVIEW":
        return 0.60            # by definition uncertain — that's why a human looks
    return 0.75                # HOLD: matched, variance is quantified
