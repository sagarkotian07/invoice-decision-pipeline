"""
Stage 1 — Ingest.

Turn a PDF on disk into raw text, and — critically — decide *how much to trust*
that text. A born-digital PDF has a real text layer we can read losslessly. A
scanned image has none; extracting from it would require OCR, and OCR is fallible.

We don't pretend OCR is free. If there's no text layer we say so, hand back an
``ocr_needed`` signal and low confidence, and let the confidence gate downstream
route the document to a human instead of hallucinating fields off a picture.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from pypdf import PdfReader


@dataclass
class IngestResult:
    raw_text: str
    source_kind: str        # "text-pdf" | "scanned-image" | "text-file"
    ocr_needed: bool
    ingest_confidence: float
    page_count: int
    notes: str = ""


def ingest(path: str | Path) -> IngestResult:
    path = Path(path)

    # A convenience for testing: a plain .txt is treated as an already-extracted
    # text layer (confidence 1.0). Everything else is parsed as a PDF.
    if path.suffix.lower() == ".txt":
        text = path.read_text()
        return IngestResult(
            raw_text=text,
            source_kind="text-file",
            ocr_needed=False,
            ingest_confidence=1.0,
            page_count=1,
            notes="Plain-text input treated as a clean text layer.",
        )

    reader = PdfReader(str(path))
    pages = reader.pages
    text_parts = [(p.extract_text() or "") for p in pages]
    text = "\n".join(text_parts).strip()

    # Heuristic: a genuine invoice text layer has a decent amount of text and
    # several digits (amounts, dates). Near-empty extraction => image-only scan.
    char_count = len(text)
    digit_count = sum(c.isdigit() for c in text)

    if char_count < 40 or digit_count < 5:
        return IngestResult(
            raw_text=text,
            source_kind="scanned-image",
            ocr_needed=True,
            ingest_confidence=0.15,
            page_count=len(pages),
            notes=(
                f"No usable text layer (chars={char_count}, digits={digit_count}). "
                "Document appears to be a scanned image; OCR required."
            ),
        )

    return IngestResult(
        raw_text=text,
        source_kind="text-pdf",
        ocr_needed=False,
        ingest_confidence=0.98,
        page_count=len(pages),
        notes=f"Extracted {char_count} chars from a born-digital PDF text layer.",
    )
