"""Units and numeric tolerances — Python mirror of ``layout-core/src/units.ts``.

The canonical unit is METRES everywhere. These constants and the rounding
behaviour must match the TypeScript side exactly, because both feed the same
content hash (P9).
"""

import math

#: Geometry comparison tolerance: 0.1 mm.
EPS = 1e-4

#: Decimals retained in canonical output.
PRECISION = 6

#: Share of a bin's raw volume considered usable.
DEFAULT_UTILIZATION = 0.85

#: Below this clear corridor width we warn.
MIN_AISLE_WIDTH_M = 2.5

#: Cap repeated diagnostics so one bad parameter cannot emit 10k messages.
MAX_DIAGNOSTICS_PER_CODE = 25

#: Number.prototype.toFixed switches to exponential notation at this magnitude.
_TO_FIXED_CUTOFF = 1e21


def js_round(value: float, decimals: int = PRECISION) -> float:
    """Round like JavaScript's ``Number(x.toFixed(decimals))``.

    Python's ``format`` and JS's ``toFixed`` both round the *exact binary value*
    to the requested number of decimals. They differ only on exact decimal ties
    (JS rounds toward +infinity, Python rounds half-to-even), and for
    ``decimals=6`` no IEEE-754 double lands on such a tie: a tie would require
    the value to be exactly ``n * 1e-6 + 5e-7``, which is not a dyadic rational.
    """
    result = float(f"{value:.{decimals}f}")
    return 0.0 if result == 0 else result


def nearly_equal(a: float, b: float, eps: float = EPS) -> bool:
    return abs(a - b) <= eps


def nearly_zero(value: float, eps: float = EPS) -> bool:
    return abs(value) <= eps


def clamp(value: float, low: float, high: float) -> float:
    return min(max(value, low), high)


def snap(value: float, step: float) -> float:
    """Snap to the editor grid. ``step <= 0`` disables snapping."""
    return js_round(round(value / step) * step) if step > 0 else value


__all__ = [
    "EPS",
    "PRECISION",
    "DEFAULT_UTILIZATION",
    "MIN_AISLE_WIDTH_M",
    "MAX_DIAGNOSTICS_PER_CODE",
    "js_round",
    "nearly_equal",
    "nearly_zero",
    "clamp",
    "snap",
    "math",
]
