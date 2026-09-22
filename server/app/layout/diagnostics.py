"""Structured diagnostics — Python mirror of ``layout-core/src/diagnostics.ts``.

Severity comes from the rule registry rather than from the call site, so a rule
cannot be an error in one place and a warning in another.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

from .rules import rule_severity
from .units import MAX_DIAGNOSTICS_PER_CODE

EntityKind = Literal[
    "warehouse",
    "rackType",
    "aisle",
    "lane",
    "level",
    "bay",
    "bin",
    "obstacle",
    "sku",
]
Severity = Literal["error", "warning"]


@dataclass(frozen=True, slots=True)
class EntityRef:
    kind: EntityKind
    id: str
    label: str | None = None

    def to_json(self) -> dict[str, Any]:
        payload: dict[str, Any] = {"kind": self.kind, "id": self.id}
        if self.label is not None:
            payload["label"] = self.label
        return payload


@dataclass(frozen=True, slots=True)
class Diagnostic:
    severity: Severity
    code: str
    message: str
    entity_refs: tuple[EntityRef, ...] = ()
    data: dict[str, Any] | None = None

    def to_json(self) -> dict[str, Any]:
        """Full API shape, including the human-readable message."""
        payload: dict[str, Any] = {
            "severity": self.severity,
            "code": self.code,
            "message": self.message,
            "entityRefs": [ref.to_json() for ref in self.entity_refs],
        }
        if self.data is not None:
            payload["data"] = self.data
        return payload


def summarize_diagnostic(diagnostic: Diagnostic) -> dict[str, Any]:
    """The comparable projection used by the cross-language fixture suite.

    Must match ``summarizeDiagnostic()`` in TypeScript exactly, including the
    *absence* of ``message`` — the fixture files carry this shape.
    """
    payload: dict[str, Any] = {
        "severity": diagnostic.severity,
        "code": diagnostic.code,
        "entityRefs": [ref.to_json() for ref in diagnostic.entity_refs],
    }
    if diagnostic.data is not None:
        payload["data"] = diagnostic.data
    return payload


def _assert_severity(code: str, expected: Severity) -> None:
    """Guards the ``error()`` / ``warn()`` helpers against the registry."""
    actual = rule_severity(code)
    if actual != expected:
        raise AssertionError(
            f"Rule '{code}' is registered as '{actual}' but was reported through "
            f"{expected}(); fix the call site or the registry entry in rules.ts"
        )


@dataclass
class DiagnosticCollector:
    """Collects diagnostics, de-duplicating floods."""

    _items: list[Diagnostic] = field(default_factory=list)
    _counts: dict[str, int] = field(default_factory=dict)
    _suppressed: dict[str, int] = field(default_factory=dict)

    def report(
        self,
        code: str,
        message: str,
        entity_refs: tuple[EntityRef, ...] = (),
        data: dict[str, Any] | None = None,
    ) -> None:
        seen = self._counts.get(code, 0)
        self._counts[code] = seen + 1

        if seen >= MAX_DIAGNOSTICS_PER_CODE:
            self._suppressed[code] = self._suppressed.get(code, 0) + 1
            return

        self._items.append(Diagnostic(rule_severity(code), code, message, entity_refs, data))

    def error(
        self,
        code: str,
        message: str,
        entity_refs: tuple[EntityRef, ...] = (),
        data: dict[str, Any] | None = None,
    ) -> None:
        """Report an error-severity rule. Severity still comes from the registry."""
        _assert_severity(code, "error")
        self.report(code, message, entity_refs, data)

    def warn(
        self,
        code: str,
        message: str,
        entity_refs: tuple[EntityRef, ...] = (),
        data: dict[str, Any] | None = None,
    ) -> None:
        """Report a warning-severity rule. See ``error()``."""
        _assert_severity(code, "warning")
        self.report(code, message, entity_refs, data)

    def all(self) -> list[Diagnostic]:
        """Insertion-ordered, so output is deterministic for a given document."""
        truncated = [
            Diagnostic(
                "warning",
                "DIAGNOSTICS_TRUNCATED",
                f"{count} further '{code}' issue(s) suppressed",
                (),
                {"originalCode": code, "suppressed": count},
            )
            for code, count in self._suppressed.items()
        ]
        return [*self._items, *truncated]

    def count(self, severity: Severity) -> int:
        return sum(1 for item in self._items if item.severity == severity)

    @property
    def has_errors(self) -> bool:
        return any(item.severity == "error" for item in self._items)

    def suppressed_counts(self) -> dict[str, int]:
        return dict(self._suppressed)


def codes_of(diagnostics: list[Diagnostic]) -> list[str]:
    """All rule codes present, sorted and unique."""
    return sorted({diagnostic.code for diagnostic in diagnostics})


def blocks_publish(diagnostics: list[Diagnostic]) -> bool:
    """Errors block Publish. Warnings do not (P6)."""
    return any(item.severity == "error" for item in diagnostics)
