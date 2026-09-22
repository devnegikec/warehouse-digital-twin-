"""The rule registry, loaded from the generated cross-language contract.

`packages/layout-core/src/rules.ts` is the source; `npm run gen:schema` emits
`schema/rule-codes.json`, which this module loads. That means the two runtimes
cannot disagree about *which* rules exist or *how severe* they are — the fixture
suite then pins how well each implements them (P6, P9).

An unknown code raises `UnknownRuleError` rather than silently producing a
severity-less diagnostic. TypeScript gets the same guarantee at compile time from
the `RuleCode` union.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from types import MappingProxyType
from typing import Final, Literal

RuleSeverity = Literal["error", "warning"]


class UnknownRuleError(KeyError):
    """Raised when a diagnostic is reported with a code absent from the registry."""


@dataclass(frozen=True, slots=True)
class RuleDefinition:
    code: str
    severity: RuleSeverity
    description: str


def _repo_root() -> Path:
    # app/layout/rules.py -> layout, app, server, <root>
    return Path(__file__).resolve().parents[3]


def rule_codes_path() -> Path:
    return _repo_root() / "packages" / "layout-core" / "schema" / "rule-codes.json"


def _load() -> dict[str, RuleDefinition]:
    payload = json.loads(rule_codes_path().read_text(encoding="utf-8"))
    registry: dict[str, RuleDefinition] = {}
    for entry in payload["rules"]:
        code = entry["code"]
        registry[code] = RuleDefinition(
            code=code,
            severity=entry["severity"],
            description=entry["description"],
        )
    return registry


RULES: Final = MappingProxyType(_load())

RULE_CODES: Final[tuple[str, ...]] = tuple(sorted(RULES))

BLOCKING_RULE_CODES: Final[tuple[str, ...]] = tuple(
    code for code in RULE_CODES if RULES[code].severity == "error"
)


def rule_severity(code: str) -> RuleSeverity:
    definition = RULES.get(code)
    if definition is None:
        raise UnknownRuleError(
            f"Rule '{code}' is not in {rule_codes_path().name}; "
            "add it to packages/layout-core/src/rules.ts and run `npm run gen:schema`"
        )
    return definition.severity


__all__ = [
    "BLOCKING_RULE_CODES",
    "RULES",
    "RULE_CODES",
    "RuleDefinition",
    "RuleSeverity",
    "UnknownRuleError",
    "rule_codes_path",
    "rule_severity",
]
