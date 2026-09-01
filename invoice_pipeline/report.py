"""Render a PipelineResult as a readable console report (the human-facing view)."""
from __future__ import annotations

from .models import Severity
from .pipeline import PipelineResult
from .util import money

_OUTCOME_BADGE = {
    "AUTO_APPROVE": "✅ AUTO-APPROVE",
    "HOLD_FOR_APPROVAL": "🟡 HOLD FOR APPROVAL",
    "NEEDS_REVIEW": "🔵 NEEDS REVIEW",
    "REJECT": "⛔ REJECT",
}

_SEV_MARK = {
    Severity.OK: "  ✓",
    Severity.INFO: "  ·",
    Severity.WARN: "  ⚠",
    Severity.HOLD: "  ▲",
    Severity.REVIEW: "  ?",
    Severity.REJECT: "  ✗",
}

_W = 78


def render(res: PipelineResult) -> str:
    d = res.decision
    inv = res.invoice
    out: list[str] = []
    bar = "═" * _W

    out.append(bar)
    out.append(f" {_OUTCOME_BADGE.get(d.outcome, d.outcome)}   "
               f"(decision confidence {d.confidence:.0%})")
    out.append(f" {res.source_file}")
    out.append(bar)
    out.append(f" {d.headline}")
    out.append("")

    # --- what we read -------------------------------------------------------
    out.append(" EXTRACTED")
    out.append(f"   Vendor      : {inv.vendor_name_raw or '—'}"
               + (f"  →  {inv.vendor_name_canonical} ({inv.vendor_id})"
                  if inv.vendor_id else "  →  UNRESOLVED"))
    out.append(f"   Invoice #   : {inv.invoice_number or '—'}")
    out.append(f"   Date        : {inv.invoice_date or '—'}")
    out.append(f"   PO ref      : {inv.po_reference or '—'}"
               + (f"  →  matched {res.match.po.po_number}"
                  f" (remaining {money(res.match.po.remaining_balance)})"
                  if res.match.po else ""))
    out.append(f"   Subtotal    : {money(inv.subtotal)}")
    out.append(f"   Tax         : {money(inv.tax)}")
    out.append(f"   Total       : {money(inv.total)}")
    out.append(f"   Confidence  : {inv.extraction_confidence:.0%}  "
               f"(source: {res.ingest.source_kind})")
    out.append("")

    # --- the trace ----------------------------------------------------------
    out.append(" TRACE  (every step, in order)")
    for ev in res.trace.events:
        out.append(f"   ▸ {ev.stage.upper():<9} {ev.summary}")
        for f in ev.findings:
            mark = _SEV_MARK.get(f.severity, "  ·")
            out.append(f"     {mark} [{f.severity.name}] {f.message}")
    out.append("")

    # --- decision -----------------------------------------------------------
    out.append(" DECISION")
    out.append(f"   Outcome     : {d.outcome}")
    out.append("   Why         :")
    for r in d.primary_reasons:
        out.append(f"                 • {r}")
    out.append(f"   Next step   : {d.recommended_action}")
    out.append(bar)
    return "\n".join(out)
