"""
Central configuration for the invoice-processing pipeline.

Every threshold that drives a decision lives here (not buried in code) so that a
finance/AP lead can read and tune the policy without touching logic. Each value
is annotated with *why* it exists and *what outcome* it influences.
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

# --------------------------------------------------------------------------- #
# Deterministic "today".                                                       #
#                                                                              #
# Real AP systems use the wall clock, but for a reproducible demo we pin the   #
# processing date so that "is this invoice stale / future-dated?" checks give  #
# the same answer no matter when you run it.                                   #
# --------------------------------------------------------------------------- #
PROCESSING_DATE: date = date(2026, 7, 1)

# --------------------------------------------------------------------------- #
# Amount tolerance — how far an invoice may deviate from its PO.               #
#                                                                              #
# Two-tier policy:                                                             #
#   * Within AUTO tolerance          -> can auto-approve.                      #
#   * Beyond AUTO but within APPROVER -> hold for a human approver's sign-off. #
#   * Beyond APPROVER band            -> reject (materially wrong).            #
#                                                                              #
# Each tier is "percentage OR absolute, whichever is more generous", because a #
# 2% wobble on a $50 PO is noise but 2% on a $500k PO is real money.           #
# --------------------------------------------------------------------------- #
AUTO_TOLERANCE_PCT: Decimal = Decimal("0.02")      # 2%
AUTO_TOLERANCE_ABS: Decimal = Decimal("100.00")    # or $100

APPROVER_BAND_PCT: Decimal = Decimal("0.10")       # 10%
APPROVER_BAND_ABS: Decimal = Decimal("2500.00")    # or $2,500

# --------------------------------------------------------------------------- #
# Extraction confidence gate.                                                  #
#                                                                              #
# The pipeline is only allowed to make an *automated* money decision when it   #
# is confident it read the invoice correctly. Below this it routes to a human  #
# rather than acting on a guess. This is the safety valve for scanned images   #
# and garbled OCR.                                                             #
# --------------------------------------------------------------------------- #
MIN_EXTRACTION_CONFIDENCE: Decimal = Decimal("0.75")

# --------------------------------------------------------------------------- #
# Duplicate detection.                                                         #
#                                                                              #
# EXACT   : same vendor + same invoice number already in the ledger  -> reject #
# NEAR    : same vendor + same total + same date, different number    -> flag   #
#           (a classic accidental double-submission; unsafe to auto-pay,       #
#            but not certain enough to auto-reject)                            #
# --------------------------------------------------------------------------- #
NEAR_DUP_AMOUNT_TOLERANCE: Decimal = Decimal("0.01")   # totals equal to the cent

# --------------------------------------------------------------------------- #
# Date sanity.                                                                 #
# --------------------------------------------------------------------------- #
FUTURE_DATE_GRACE_DAYS: int = 2      # tiny grace for timezone / clock skew
STALE_INVOICE_DAYS: int = 365        # older than this is suspicious (accrual risk)

# --------------------------------------------------------------------------- #
# Math reconciliation.                                                         #
#                                                                              #
# sum(line items) should equal subtotal, and subtotal + tax should equal the   #
# stated total. Allow a small rounding wobble before we call it a mismatch.    #
# --------------------------------------------------------------------------- #
MATH_ROUNDING_TOLERANCE: Decimal = Decimal("0.05")

# --------------------------------------------------------------------------- #
# Vendor name matching. Below this fuzzy ratio we treat the vendor as          #
# unresolved rather than silently binding to the closest approved vendor.      #
# --------------------------------------------------------------------------- #
VENDOR_FUZZY_THRESHOLD: float = 0.82
