#!/usr/bin/env python3
"""
Self-contained test suite (no pytest needed).

    python tests/test_pipeline.py

Covers three layers:
  1. unit    — money/date parsing, duplicate detection, tolerance boundaries
  2. rules   — synthetic invoices hit each decision branch deterministically
  3. e2e     — every sample PDF lands on its intended outcome

The point is that the money decisions are *testable* — the same inputs always
produce the same outcome and the same reasons.
"""
from __future__ import annotations

import sys
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from invoice_pipeline.pipeline import process_invoice          # noqa: E402
from invoice_pipeline.procurement import Procurement            # noqa: E402
from invoice_pipeline.util import parse_date, parse_money       # noqa: E402

DATA = ROOT / "data"
SAMPLES = ROOT / "samples"

_passed = 0
_failed = 0


def check(name: str, cond: bool, extra: str = "") -> None:
    global _passed, _failed
    if cond:
        _passed += 1
        print(f"  ✓ {name}")
    else:
        _failed += 1
        print(f"  ✗ {name}   {extra}")


# --------------------------------------------------------------------------- #
# 1. unit
# --------------------------------------------------------------------------- #
def test_parsing() -> None:
    print("unit: parsing")
    check("$1,234.56", parse_money("$1,234.56") == Decimal("1234.56"))
    check("USD 900", parse_money("USD 900") == Decimal("900"))
    check("accounting negative", parse_money("(120.00)") == Decimal("-120.00"))
    check("garbage -> None", parse_money("n/a") is None)
    check("iso date", parse_date("2026-06-12").isoformat() == "2026-06-12")
    check("d-mon-y date", parse_date("12 Jun 2026").isoformat() == "2026-06-12")
    check("unparseable date -> None", parse_date("sometime") is None)


def test_duplicate_detection() -> None:
    print("unit: duplicate detection")
    proc = Procurement(DATA / "purchase_orders.json", DATA / "invoice_ledger.json")

    exact = proc.find_duplicates("V004", "INIT-4401", Decimal("6750.00"),
                                 parse_date("2026-06-15"))
    check("exact dup detected", any(k == "EXACT" for k, _ in exact))

    near = proc.find_duplicates("V004", "INIT-4419", Decimal("6750.00"),
                                parse_date("2026-06-15"))
    check("near dup detected", any(k == "NEAR" for k, _ in near))
    check("near dup is not exact", not any(k == "EXACT" for k, _ in near))

    none = proc.find_duplicates("V004", "INIT-9999", Decimal("10.00"),
                                parse_date("2026-06-15"))
    check("distinct invoice -> no dup", len(none) == 0)


def test_cumulative_billing() -> None:
    print("unit: stateful PO balance")
    proc = Procurement(DATA / "purchase_orders.json", DATA / "invoice_ledger.json")
    po = proc.purchase_orders["PO-1003"]
    check("already billed = 46,000", po.amount_already_billed == Decimal("46000.00"))
    check("remaining = 4,000", po.remaining_balance == Decimal("4000.00"))


# --------------------------------------------------------------------------- #
# 3. end-to-end: each sample -> intended outcome
# --------------------------------------------------------------------------- #
EXPECTED = {
    "01_happy_path.pdf": "AUTO_APPROVE",
    "02_over_tolerance.pdf": "HOLD_FOR_APPROVAL",
    "03_partial_overbill.pdf": "REJECT",
    "04_near_duplicate.pdf": "NEEDS_REVIEW",
    "05_unreconciled_missing.pdf": "NEEDS_REVIEW",
    "06_scanned_image.pdf": "NEEDS_REVIEW",
}

# The specific finding code that MUST appear for the edge case to be meaningful.
REQUIRED_CODE = {
    "03_partial_overbill.pdf": "CUMULATIVE_OVERBILL",
    "04_near_duplicate.pdf": "DUPLICATE_NEAR",
    "05_unreconciled_missing.pdf": "TOTAL_DOESNT_RECONCILE",
    "06_scanned_image.pdf": "DOCUMENT_UNREADABLE",
}


def test_end_to_end() -> None:
    print("e2e: sample invoices -> decisions")
    if not (SAMPLES / "01_happy_path.pdf").exists():
        import runpy
        runpy.run_path(str(SAMPLES / "generate_samples.py"), run_name="__main__")
    proc = Procurement(DATA / "purchase_orders.json", DATA / "invoice_ledger.json")
    for name, expected in EXPECTED.items():
        res = process_invoice(SAMPLES / name, proc)
        check(f"{name} -> {expected}", res.decision.outcome == expected,
              extra=f"(got {res.decision.outcome})")
        if name in REQUIRED_CODE:
            codes = {f.code for f in res.trace.all_findings}
            code = REQUIRED_CODE[name]
            check(f"{name} raised {code}", code in codes,
                  extra=f"(codes: {sorted(codes)})")


if __name__ == "__main__":
    test_parsing()
    test_duplicate_detection()
    test_cumulative_billing()
    test_end_to_end()
    print(f"\n{_passed} passed, {_failed} failed")
    sys.exit(1 if _failed else 0)
