"""
The audit trail.

The brief is explicit: "with everything that happened in between visible." So the
pipeline never mutates hidden state — every stage appends a ``TraceEvent`` here,
and the report is rendered *from* the trace. If it's not in the trace, it didn't
happen. This is what makes a machine's money decision auditable after the fact.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .models import Finding, _jsonable


@dataclass
class TraceEvent:
    stage: str                       # "ingest", "extract", ...
    summary: str                     # one line
    detail: dict[str, Any] = field(default_factory=dict)
    findings: list[Finding] = field(default_factory=list)


class Trace:
    def __init__(self) -> None:
        self.events: list[TraceEvent] = []

    def add(
        self,
        stage: str,
        summary: str,
        detail: dict[str, Any] | None = None,
        findings: list[Finding] | None = None,
    ) -> None:
        self.events.append(
            TraceEvent(
                stage=stage,
                summary=summary,
                detail=detail or {},
                findings=findings or [],
            )
        )

    @property
    def all_findings(self) -> list[Finding]:
        out: list[Finding] = []
        for ev in self.events:
            out.extend(ev.findings)
        return out

    def to_dict(self) -> list[dict[str, Any]]:
        return [
            {
                "stage": ev.stage,
                "summary": ev.summary,
                "detail": _jsonable(ev.detail),
                "findings": [f.to_dict() for f in ev.findings],
            }
            for ev in self.events
        ]
