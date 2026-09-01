"""
The orchestrator.

Runs the six stages in order, threading a single ``Trace`` through all of them so
that the report can show exactly what happened at each step. Returns a
``PipelineResult`` — the complete, serialisable record of one invoice's journey
from PDF to decision.
"""
from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path
from typing import Optional

from . import extract as extract_stage
from . import ingest as ingest_stage
from . import validate as validate_stage
from .decide import decide
from .match import MatchResult, match
from .models import Decision, ExtractedInvoice, Finding, Severity
from .procurement import Procurement
from .rules import apply_rules
from .trace import Trace
from .util import money


@dataclass
class PipelineResult:
    source_file: str
    ingest: ingest_stage.IngestResult
    invoice: ExtractedInvoice
    match: MatchResult
    decision: Decision
    trace: Trace

    def to_dict(self) -> dict:
        inv = self.invoice
        return {
            "source_file": self.source_file,
            "decision": {
                "outcome": self.decision.outcome,
                "confidence": self.decision.confidence,
                "headline": self.decision.headline,
                "primary_reasons": self.decision.primary_reasons,
                "recommended_action": self.decision.recommended_action,
            },
            "extracted": {
                "invoice_number": inv.invoice_number,
                "invoice_date": inv.invoice_date.isoformat() if inv.invoice_date else None,
                "vendor_raw": inv.vendor_name_raw,
                "vendor_resolved": inv.vendor_name_canonical,
                "vendor_id": inv.vendor_id,
                "po_reference": inv.po_reference,
                "currency": inv.currency,
                "subtotal": str(inv.subtotal) if inv.subtotal is not None else None,
                "tax": str(inv.tax) if inv.tax is not None else None,
                "total": str(inv.total) if inv.total is not None else None,
                "line_items": [
                    {"description": li.description,
                     "quantity": str(li.quantity) if li.quantity is not None else None,
                     "unit_price": str(li.unit_price) if li.unit_price is not None else None,
                     "amount": str(li.amount)}
                    for li in inv.line_items
                ],
                "extraction_confidence": inv.extraction_confidence,
            },
            "matched_po": self.match.po.po_number if self.match.po else None,
            "ingest": {
                "source_kind": self.ingest.source_kind,
                "ocr_needed": self.ingest.ocr_needed,
                "ingest_confidence": self.ingest.ingest_confidence,
            },
            "trace": self.trace.to_dict(),
        }


def process_invoice(path: str | Path, proc: Procurement) -> PipelineResult:
    trace = Trace()
    path = Path(path)

    # --- Stage 1: ingest --------------------------------------------------- #
    ing = ingest_stage.ingest(path)
    trace.add("ingest", ing.notes, detail={
        "source_kind": ing.source_kind,
        "ocr_needed": ing.ocr_needed,
        "ingest_confidence": ing.ingest_confidence,
        "page_count": ing.page_count,
    })

    # --- Stage 2: extract -------------------------------------------------- #
    inv = extract_stage.extract(ing.raw_text, ing.ingest_confidence)
    trace.add("extract",
              f"Read {sum(1 for f in inv.fields.values() if f)} fields; "
              f"overall confidence {inv.extraction_confidence:.0%}.",
              detail={
                  "invoice_number": inv.invoice_number,
                  "invoice_date": inv.invoice_date.isoformat() if inv.invoice_date else None,
                  "vendor_raw": inv.vendor_name_raw,
                  "po_reference": inv.po_reference,
                  "subtotal": money(inv.subtotal),
                  "tax": money(inv.tax),
                  "total": money(inv.total),
                  "line_item_count": len(inv.line_items),
                  "field_confidence": {k: round(f.confidence, 2)
                                       for k, f in inv.fields.items()},
              })

    # Guard: if the document was unreadable (scanned image / no text layer), we
    # have nothing to validate or match against. Running the normal checks on
    # empty data would fire misleading findings ("vendor not approved", "missing
    # fields — ask the vendor") when the real problem is that we couldn't read
    # it. Route straight to a human with one honest reason.
    readable = (not ing.ocr_needed) and (
        inv.total is not None or inv.vendor_name_raw is not None
        or inv.invoice_number is not None
    )

    if not readable:
        v_findings = []
        trace.add("validate", "Skipped — nothing to validate (document unreadable).")
        mr = MatchResult(None, None, None, "skipped-unreadable")
        m_findings = []
        r_findings = [Finding(
            code="DOCUMENT_UNREADABLE",
            severity=Severity.REVIEW,
            message=(f"Document could not be read automatically "
                     f"({ing.source_kind}; extraction confidence "
                     f"{inv.extraction_confidence:.0%}). Cannot match a vendor or PO "
                     f"without the data — routing to manual key-entry / OCR review."),
            evidence={"source_kind": ing.source_kind,
                      "extraction_confidence": inv.extraction_confidence},
        )]
        trace.add("match", "Skipped — document unreadable, nothing to match.")
        trace.add("rules", "Skipped rule checks — no data to evaluate.",
                  findings=r_findings)
    else:
        # --- Stage 3: validate --------------------------------------------- #
        v_findings = validate_stage.validate(inv)
        trace.add("validate", _summarise(v_findings, "validation"),
                  findings=v_findings)

        # --- Stage 4: match ------------------------------------------------ #
        mr, m_findings = match(inv, proc)
        trace.add("match",
                  f"Vendor: {mr.vendor_name or 'UNRESOLVED'}; "
                  f"PO: {mr.po.po_number if mr.po else 'none'} ({mr.po_match_basis}).",
                  detail={"vendor_id": mr.vendor_id,
                          "po": mr.po.po_number if mr.po else None,
                          "po_remaining_balance":
                              money(mr.po.remaining_balance) if mr.po else None},
                  findings=m_findings)

        # --- Stage 5: rules ------------------------------------------------ #
        r_findings = apply_rules(inv, mr, proc, ing.source_kind)
        trace.add("rules", _summarise(r_findings, "business-rule"), findings=r_findings)

    # --- Stage 6: decide --------------------------------------------------- #
    all_findings = v_findings + m_findings + r_findings
    decision = decide(all_findings)
    trace.add("decide",
              f"{decision.outcome} (confidence {decision.confidence:.0%}) — "
              f"{decision.headline}",
              detail={"primary_reasons": decision.primary_reasons,
                      "recommended_action": decision.recommended_action})

    return PipelineResult(str(path), ing, inv, mr, decision, trace)


def _summarise(findings, kind: str) -> str:
    from .models import Severity
    blocks = [f for f in findings if f.severity >= Severity.HOLD]
    if not blocks:
        return f"All {kind} checks passed ({len(findings)} run)."
    worst = max(f.severity for f in blocks)
    return (f"{len(blocks)} {kind} issue(s); worst = {worst.name} "
            f"({blocks[0].code}).")
