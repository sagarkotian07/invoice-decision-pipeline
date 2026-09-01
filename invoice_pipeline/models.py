"""
Typed data structures shared across the pipeline.

Design notes
------------
* Money is ``Decimal``, never ``float``. Floating point is disqualifying for an
  accounts-payable system ($0.10 + $0.20 != $0.30 in float).
* Almost every extracted field carries a ``confidence`` and a ``source`` so the
  final report can explain *how* it knew each value — not just what the value was.
* ``Finding`` is the atomic unit of reasoning. Every rule produces Findings, and
  the final decision is a pure function of the Findings. Nothing decides in secret.
"""
from __future__ import annotations

import enum
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from typing import Any, Optional


# --------------------------------------------------------------------------- #
# Extraction outputs                                                          #
# --------------------------------------------------------------------------- #
@dataclass
class Field:
    """A single extracted value plus the evidence for it."""
    value: Any
    confidence: float = 0.0
    source: str = ""          # e.g. "label:'Invoice No.'", "heuristic:trailing-amount"

    def __bool__(self) -> bool:
        return self.value is not None


@dataclass
class LineItem:
    description: str
    quantity: Optional[Decimal]
    unit_price: Optional[Decimal]
    amount: Decimal


@dataclass
class ExtractedInvoice:
    """Structured invoice, as read off the page (pre-validation, pre-matching)."""
    invoice_number: Optional[str] = None
    invoice_date: Optional[date] = None
    vendor_name_raw: Optional[str] = None
    po_reference: Optional[str] = None
    currency: str = "USD"
    line_items: list[LineItem] = field(default_factory=list)
    subtotal: Optional[Decimal] = None
    tax: Optional[Decimal] = None
    total: Optional[Decimal] = None

    # per-field provenance, keyed by field name -> Field
    fields: dict[str, Field] = field(default_factory=dict)

    # overall confidence that the document was read correctly (0..1)
    extraction_confidence: float = 0.0

    # resolved during matching
    vendor_id: Optional[str] = None
    vendor_name_canonical: Optional[str] = None


# --------------------------------------------------------------------------- #
# Procurement-system objects                                                  #
# --------------------------------------------------------------------------- #
@dataclass
class Vendor:
    vendor_id: str
    name: str
    aliases: list[str] = field(default_factory=list)
    approved: bool = True
    payment_terms: str = "NET30"


@dataclass
class PurchaseOrder:
    po_number: str
    vendor_id: str
    total_amount: Decimal
    currency: str = "USD"
    status: str = "open"              # open | closed
    allow_partial: bool = False       # may this PO be billed across several invoices?
    description: str = ""

    # populated at load time from the ledger: how much has already been billed.
    amount_already_billed: Decimal = Decimal("0.00")

    @property
    def remaining_balance(self) -> Decimal:
        return self.total_amount - self.amount_already_billed


@dataclass
class LedgerEntry:
    """A previously-processed invoice (the AP system's memory)."""
    invoice_number: Optional[str]
    vendor_id: Optional[str]
    po_number: Optional[str]
    total: Optional[Decimal]
    invoice_date: Optional[date]
    amount_applied: Decimal
    decision: str


# --------------------------------------------------------------------------- #
# Reasoning + decision                                                        #
# --------------------------------------------------------------------------- #
class Severity(enum.IntEnum):
    """Ordered so that ``max()`` over a set of findings gives the worst one."""
    OK = 0        # positive confirmation ("vendor is approved")
    INFO = 1      # neutral context
    WARN = 2      # noted, doesn't change the outcome on its own
    HOLD = 3      # matched, but a human must approve a bounded variance
    REVIEW = 4    # cannot decide automatically — needs human eyes / more data
    REJECT = 5    # hard stop — must not be paid as-is


# Which decision each blocking severity maps to.
SEVERITY_TO_DECISION = {
    Severity.HOLD: "HOLD_FOR_APPROVAL",
    Severity.REVIEW: "NEEDS_REVIEW",
    Severity.REJECT: "REJECT",
}


@dataclass
class Finding:
    """One check's result: what was checked, the verdict, and the evidence."""
    code: str
    severity: Severity
    message: str
    evidence: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "severity": self.severity.name,
            "message": self.message,
            "evidence": _jsonable(self.evidence),
        }


@dataclass
class Decision:
    outcome: str                       # AUTO_APPROVE | HOLD_FOR_APPROVAL | NEEDS_REVIEW | REJECT
    confidence: float
    headline: str                      # one-line human summary
    primary_reasons: list[str]         # the findings that drove the outcome
    recommended_action: str            # concrete next step for the AP team


# --------------------------------------------------------------------------- #
# helpers                                                                     #
# --------------------------------------------------------------------------- #
def _jsonable(obj: Any) -> Any:
    """Best-effort conversion of Decimals/dates inside evidence dicts for JSON."""
    if isinstance(obj, dict):
        return {k: _jsonable(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_jsonable(v) for v in obj]
    if isinstance(obj, Decimal):
        return str(obj)
    if isinstance(obj, date):
        return obj.isoformat()
    return obj
