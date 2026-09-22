"""Rule registry and diagnostic-collector behaviour — mirror of `rules.test.ts`.

The registry is loaded from the file the TypeScript side generates, so these tests
also assert that the Python runtime has not diverged from that contract.
"""

from __future__ import annotations

import pytest

from app.layout import (
    BLOCKING_RULE_CODES,
    RULE_CODES,
    RULES,
    Diagnostic,
    DiagnosticCollector,
    UnknownRuleError,
    blocks_publish,
    codes_of,
    rule_severity,
    summarize_diagnostic,
)
from app.layout.units import MAX_DIAGNOSTICS_PER_CODE


class TestRegistry:
    def test_loads_the_generated_contract(self) -> None:
        assert len(RULE_CODES) == 24, "rule-codes.json is stale — run: npm run gen:schema"

    def test_codes_are_sorted_and_unique(self) -> None:
        assert list(RULE_CODES) == sorted(set(RULE_CODES))

    def test_code_field_matches_the_key(self) -> None:
        for code in RULE_CODES:
            assert RULES[code].code == code

    def test_severities_are_only_error_or_warning(self) -> None:
        for code in RULE_CODES:
            assert rule_severity(code) in {"error", "warning"}

    def test_every_rule_has_a_description(self) -> None:
        for code in RULE_CODES:
            assert len(RULES[code].description) > 10, f"{code} needs a description"

    def test_blocking_codes_are_derived_from_severity(self) -> None:
        assert set(BLOCKING_RULE_CODES) == {
            code for code in RULE_CODES if rule_severity(code) == "error"
        }
        assert "DIAGNOSTICS_TRUNCATED" not in BLOCKING_RULE_CODES

    def test_unknown_code_raises_rather_than_defaulting(self) -> None:
        with pytest.raises(UnknownRuleError):
            rule_severity("NOT_A_REAL_RULE")


class TestCollector:
    def test_severity_comes_from_the_registry_not_the_call_site(self) -> None:
        collector = DiagnosticCollector()
        collector.report("AISLE_TOO_NARROW", "narrow")
        collector.report("LANE_OVERLAP", "overlap")

        assert [d.severity for d in collector.all()] == ["warning", "error"]

    def test_refuses_to_report_a_warning_rule_through_error(self) -> None:
        collector = DiagnosticCollector()
        with pytest.raises(AssertionError, match="registered as 'warning'"):
            collector.error("AISLE_TOO_NARROW", "narrow")

    def test_refuses_to_report_an_error_rule_through_warn(self) -> None:
        collector = DiagnosticCollector()
        with pytest.raises(AssertionError, match="registered as 'error'"):
            collector.warn("LANE_OVERLAP", "overlap")

    def test_preserves_insertion_order(self) -> None:
        collector = DiagnosticCollector()
        collector.report("LANE_OVERLAP", "b")
        collector.report("AISLE_TOO_NARROW", "a")
        collector.report("LANE_OVERLAP", "c")

        assert [d.message for d in collector.all()] == ["b", "a", "c"]
        assert codes_of(collector.all()) == ["AISLE_TOO_NARROW", "LANE_OVERLAP"]

    def test_caps_a_repeated_code_and_summarises_the_remainder(self) -> None:
        collector = DiagnosticCollector()
        overflow = 3
        for index in range(MAX_DIAGNOSTICS_PER_CODE + overflow):
            collector.report("BAY_OBSTACLE_OVERLAP", f"bay {index}")

        all_items = collector.all()
        assert len(all_items) == MAX_DIAGNOSTICS_PER_CODE + 1

        summary = all_items[-1]
        assert summary.code == "DIAGNOSTICS_TRUNCATED"
        assert summary.severity == "warning"
        assert summary.data == {"originalCode": "BAY_OBSTACLE_OVERLAP", "suppressed": overflow}

    def test_counts_severities_and_blocks_publish_only_on_errors(self) -> None:
        collector = DiagnosticCollector()
        collector.report("AISLE_TOO_NARROW", "a")
        collector.report("AISLE_TOO_NARROW", "b")

        assert collector.count("warning") == 2
        assert collector.count("error") == 0
        assert collector.has_errors is False
        assert blocks_publish(collector.all()) is False

        collector.report("LANE_OVERLAP", "c")
        assert collector.has_errors is True
        assert blocks_publish(collector.all()) is True


class TestSummarizeDiagnostic:
    def test_matches_the_typescript_shape_exactly(self) -> None:
        diagnostic = Diagnostic(
            severity="error",
            code="LEVEL_STACK_EXCEEDS_HEIGHT",
            message="too tall",
            data={"stackHeightM": 5.04},
        )

        summary = summarize_diagnostic(diagnostic)

        # No `message` key: the fixture files carry this projection.
        assert summary == {
            "severity": "error",
            "code": "LEVEL_STACK_EXCEEDS_HEIGHT",
            "entityRefs": [],
            "data": {"stackHeightM": 5.04},
        }
        assert "message" not in summary
