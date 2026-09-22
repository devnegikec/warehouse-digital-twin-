"""Python mirror of ``packages/layout-core``.

Both implementations of the compiler live here and in TypeScript. They are kept
honest by the shared fixture suite in ``fixtures/layout-conformance``, which both
``vitest`` and ``pytest`` run (P9).
"""

from .canonical import canonicalize, doc_hash, format_number, sha256_hex
from .capacity import (
    CapacityTarget,
    FitFailure,
    FitFailureCode,
    FitItem,
    FitResult,
    item_fits,
    orientations_of,
    usable_volume_m3,
    utilization,
    validate_placement,
)
from .compile import (
    DerivedBay,
    DerivedBin,
    LayoutGraph,
    build_layout,
    lane_stack_height_m,
    validate_layout,
)
from .diagnostics import (
    Diagnostic,
    DiagnosticCollector,
    EntityRef,
    blocks_publish,
    codes_of,
    summarize_diagnostic,
)
from .rules import (
    BLOCKING_RULE_CODES,
    RULE_CODES,
    RULES,
    RuleDefinition,
    UnknownRuleError,
    rule_severity,
)
from .schema import (
    DocumentInvalid,
    apply_defaults,
    normalize_document,
    schema_path,
    validate_document,
)

__all__ = [
    "BLOCKING_RULE_CODES",
    "RULES",
    "RULE_CODES",
    "CapacityTarget",
    "DerivedBay",
    "DerivedBin",
    "Diagnostic",
    "DiagnosticCollector",
    "DocumentInvalid",
    "EntityRef",
    "FitFailure",
    "FitFailureCode",
    "FitItem",
    "FitResult",
    "LayoutGraph",
    "RuleDefinition",
    "UnknownRuleError",
    "apply_defaults",
    "blocks_publish",
    "build_layout",
    "canonicalize",
    "codes_of",
    "doc_hash",
    "format_number",
    "item_fits",
    "lane_stack_height_m",
    "normalize_document",
    "orientations_of",
    "rule_severity",
    "schema_path",
    "sha256_hex",
    "summarize_diagnostic",
    "usable_volume_m3",
    "utilization",
    "validate_document",
    "validate_layout",
    "validate_placement",
]
