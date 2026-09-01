#!/usr/bin/env python3
"""
CLI entrypoint — from PDF to decision.

Usage
-----
    python run.py                       # process every invoice in samples/
    python run.py --all                 # same as above
    python run.py samples/01_happy_path.pdf   # process one invoice
    python run.py path/to/invoice.pdf --json  # also print the machine JSON

Each run prints a human-readable report (extraction + full trace + decision) and
writes the machine-readable JSON to out/<name>.json.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from invoice_pipeline.pipeline import process_invoice
from invoice_pipeline.procurement import Procurement
from invoice_pipeline.report import render

ROOT = Path(__file__).parent
DATA = ROOT / "data"
SAMPLES = ROOT / "samples"
OUT = ROOT / "out"


def main() -> int:
    ap = argparse.ArgumentParser(description="Invoice -> reasoned AP decision")
    ap.add_argument("invoice", nargs="?", help="path to a PDF/txt invoice")
    ap.add_argument("--all", action="store_true", help="process all sample invoices")
    ap.add_argument("--json", action="store_true", help="also print machine JSON")
    args = ap.parse_args()

    proc = Procurement(DATA / "purchase_orders.json", DATA / "invoice_ledger.json")
    OUT.mkdir(exist_ok=True)

    if args.invoice and not args.all:
        targets = [Path(args.invoice)]
    else:
        targets = sorted(SAMPLES.glob("*.pdf")) + sorted(SAMPLES.glob("*.txt"))
        if not targets:
            print("No invoices found. Run: python samples/generate_samples.py")
            return 1

    summary: list[tuple[str, str]] = []
    for path in targets:
        if not path.exists():
            print(f"!! not found: {path}")
            continue
        result = process_invoice(path, proc)
        print(render(result))
        print()

        out_path = OUT / f"{path.stem}.json"
        out_path.write_text(json.dumps(result.to_dict(), indent=2))
        if args.json:
            print(json.dumps(result.to_dict(), indent=2))
        summary.append((path.name, result.decision.outcome))

    if len(summary) > 1:
        print("═" * 78)
        print(" SUMMARY")
        for name, outcome in summary:
            print(f"   {outcome:<20} {name}")
        print("═" * 78)
        print(f" JSON written to {OUT}/")
    return 0


if __name__ == "__main__":
    sys.exit(main())
