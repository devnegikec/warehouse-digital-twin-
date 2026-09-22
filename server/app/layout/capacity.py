"""Capacity and fit checking — Python mirror of ``layout-core/src/capacity.ts``.

Failures are returned as *codes*, not prose, so placement validation can raise
them as ordinary diagnostics with no string parsing.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

from .diagnostics import Diagnostic, EntityRef
from .rules import rule_severity
from .units import DEFAULT_UTILIZATION, EPS, js_round

FitFailureCode = Literal[
    "QTY_NOT_POSITIVE",
    "ITEM_DOES_NOT_FIT_OPENING",
    "EXCEEDS_BIN_VOLUME",
    "EXCEEDS_BIN_WEIGHT",
]


def usable_volume_m3(
    width: float, height: float, depth: float, utilization: float = DEFAULT_UTILIZATION
) -> float:
    """Raw bin volume with the utilization factor applied."""
    return js_round(width * height * depth * utilization)


@dataclass(frozen=True, slots=True)
class CapacityTarget:
    width_m: float
    height_m: float
    depth_m: float
    capacity_m3: float
    max_weight_kg: float | None


@dataclass(frozen=True, slots=True)
class FitItem:
    width_m: float
    height_m: float
    depth_m: float
    weight_kg: float
    rotatable: bool = True


@dataclass(frozen=True, slots=True)
class FitFailure:
    code: FitFailureCode
    message: str


@dataclass(frozen=True, slots=True)
class FitResult:
    fits: bool
    failure: FitFailure | None = None
    orientation: tuple[float, float, float] | None = None


def orientations_of(item: FitItem) -> list[tuple[float, float, float]]:
    """The distinct axis-aligned orientations to try.

    Mirrors the TypeScript order exactly so both sides pick the same orientation.
    """
    dims = (item.width_m, item.height_m, item.depth_m)
    if not item.rotatable:
        return [dims]

    ordered: list[tuple[float, float, float]] = [
        dims,
        (dims[0], dims[2], dims[1]),
        (dims[1], dims[0], dims[2]),
        (dims[1], dims[2], dims[0]),
        (dims[2], dims[0], dims[1]),
        (dims[2], dims[1], dims[0]),
    ]

    seen: set[tuple[float, float, float]] = set()
    unique: list[tuple[float, float, float]] = []
    for orientation in ordered:
        if orientation in seen:
            continue
        seen.add(orientation)
        unique.append(orientation)
    return unique


def item_fits(bin_: CapacityTarget, item: FitItem, qty: int) -> FitResult:
    """Full fit check: opening geometry, then aggregate volume, then weight."""
    if qty <= 0:
        return FitResult(
            fits=False,
            failure=FitFailure("QTY_NOT_POSITIVE", "Quantity must be greater than zero"),
        )

    def fits_opening(o: tuple[float, float, float]) -> bool:
        return (
            o[0] <= bin_.width_m + EPS
            and o[1] <= bin_.height_m + EPS
            and o[2] <= bin_.depth_m + EPS
        )

    candidate = next((o for o in orientations_of(item) if fits_opening(o)), None)
    if candidate is None:
        return FitResult(
            fits=False,
            failure=FitFailure(
                "ITEM_DOES_NOT_FIT_OPENING",
                f"Item {item.width_m} x {item.height_m} x {item.depth_m} m does not fit the "
                f"{bin_.width_m} x {bin_.height_m} x {bin_.depth_m} m opening in any legal "
                "orientation",
            ),
        )

    total_volume = js_round(item.width_m * item.height_m * item.depth_m * qty)
    if total_volume > bin_.capacity_m3 + EPS:
        return FitResult(
            fits=False,
            failure=FitFailure(
                "EXCEEDS_BIN_VOLUME",
                f"Needs {total_volume} m3 but the bin holds {bin_.capacity_m3} m3",
            ),
            orientation=candidate,
        )

    if bin_.max_weight_kg is not None:
        total_weight = js_round(item.weight_kg * qty)
        if total_weight > bin_.max_weight_kg + EPS:
            return FitResult(
                fits=False,
                failure=FitFailure(
                    "EXCEEDS_BIN_WEIGHT",
                    f"Needs {total_weight} kg but the level limit is {bin_.max_weight_kg} kg",
                ),
                orientation=candidate,
            )

    return FitResult(fits=True, orientation=candidate)


def validate_placement(
    bin_: CapacityTarget,
    item: FitItem,
    qty: int,
    ctx: dict[str, str],
) -> list[Diagnostic]:
    """Placement validation, expressed as the same diagnostics a bad layout raises."""
    result = item_fits(bin_, item, qty)
    if result.fits or result.failure is None:
        return []

    entity_refs = (
        EntityRef("bin", ctx["binCode"], ctx["binCode"]),
        EntityRef("sku", ctx["sku"], ctx["sku"]),
    )
    data: dict[str, Any] = {"qty": qty, "binCode": ctx["binCode"], "sku": ctx["sku"]}

    return [
        Diagnostic(
            severity=rule_severity(result.failure.code),
            code=result.failure.code,
            message=result.failure.message,
            entity_refs=entity_refs,
            data=data,
        )
    ]


def utilization(bin_: CapacityTarget, item_volume_m3: float, qty: int) -> float:
    if bin_.capacity_m3 <= 0:
        return 0.0
    return js_round(item_volume_m3 * qty / bin_.capacity_m3, 4)


__all__ = [
    "CapacityTarget",
    "FitFailure",
    "FitFailureCode",
    "FitItem",
    "FitResult",
    "item_fits",
    "orientations_of",
    "usable_volume_m3",
    "utilization",
    "validate_placement",
]
