"""SKU and placement services.

The capacity arithmetic here does one thing that is worth stating plainly: a bin's
*remaining* capacity is expressed as a `CapacityTarget` with the bin's real opening
dimensions but the leftover volume and weight. `item_fits` then applies unchanged,
which means placement uses the identical code path — and produces the identical
diagnostic codes — as the TypeScript client's drag ghost. Nothing about fit checking is
reimplemented here.

Placements are inventory, never geometry (P5): nothing in this module writes a bin, an
aisle or a level.
"""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..layout import CapacityTarget, Diagnostic, FitItem, validate_placement
from ..layout.units import js_round
from ..models import Bin, Placement, SkuTemplate


class InventoryError(Exception):
    """Base for the refusals the inventory routes turn into status codes."""


class SkuMissing(InventoryError):
    def __init__(self, sku_id: object) -> None:
        super().__init__(f"No SKU with id '{sku_id}'")
        self.sku_id = sku_id


class SkuCodeTaken(InventoryError):
    def __init__(self, warehouse_id: object, sku: str) -> None:
        super().__init__(f"SKU '{sku}' already exists in this warehouse")
        self.sku = sku


class BinMissing(InventoryError):
    def __init__(self, bin_id: object) -> None:
        super().__init__(f"No bin with id '{bin_id}'")
        self.bin_id = bin_id


class PlacementMissing(InventoryError):
    def __init__(self, placement_id: object) -> None:
        super().__init__(f"No placement with id '{placement_id}'")
        self.placement_id = placement_id


class SkuInUse(InventoryError):
    def __init__(self, sku: str, count: int) -> None:
        super().__init__(
            f"SKU '{sku}' is placed in {count} bin{'' if count == 1 else 's'}; "
            "unassign it before deleting"
        )
        self.sku = sku
        self.count = count


class WrongWarehouse(InventoryError):
    def __init__(self, message: str) -> None:
        super().__init__(message)


class PlacementRejected(InventoryError):
    """A capacity refusal, carrying the diagnostics the shared rules produced."""

    def __init__(self, diagnostics: list[Diagnostic]) -> None:
        first = diagnostics[0]
        super().__init__(first.message)
        self.diagnostics = diagnostics
        self.code = first.code
        self.message = first.message

    code: str
    message: str


# --- Capacity ----------------------------------------------------------------


def capacity_target(
    bin_row: Bin,
    existing: list[Placement],
    *,
    replacing_sku_id: uuid.UUID | None = None,
) -> CapacityTarget:
    """The bin's leftover capacity, keeping its true opening dimensions.

    `replacing_sku_id` excludes that SKU's existing row, because an upsert replaces it
    rather than adding to it — without this, re-dropping the same SKU onto a full bin
    would be refused for space it is about to free.
    """
    used_volume = 0.0
    used_weight = 0.0

    for placement in existing:
        if replacing_sku_id is not None and placement.sku_id == replacing_sku_id:
            continue
        used_volume += placement.volume_used_m3
        used_weight += placement.weight_used_kg

    return CapacityTarget(
        width_m=bin_row.width_m,
        height_m=bin_row.height_m,
        depth_m=bin_row.depth_m,
        # The opening is the bin's own; only the *available* volume shrinks.
        capacity_m3=max(bin_row.capacity_m3 - used_volume, 0.0),
        max_weight_kg=(
            None if bin_row.max_weight_kg is None else max(bin_row.max_weight_kg - used_weight, 0.0)
        ),
    )


def evaluate_placement(
    bin_row: Bin,
    sku: SkuTemplate,
    qty: int,
    existing: list[Placement],
) -> tuple[list[Diagnostic], CapacityTarget]:
    """Fit-check a placement against a bin, returning diagnostics when it is refused."""
    target = capacity_target(bin_row, existing, replacing_sku_id=sku.id)
    item = FitItem(
        width_m=sku.width_m,
        height_m=sku.height_m,
        depth_m=sku.depth_m,
        weight_kg=sku.weight_kg,
        rotatable=sku.rotatable,
    )

    diagnostics = validate_placement(target, item, qty, {"binCode": bin_row.code, "sku": sku.sku})
    return diagnostics, target


def usage_of(sku: SkuTemplate, qty: int) -> tuple[float, float]:
    """Volume and weight for a quantity, rounded the way the client rounds it.

    `js_round` rather than `round`: these values are cached and compared against the
    client's, so "identical to JavaScript" matters more than "nearest double".
    """
    volume = js_round(sku.width_m * sku.height_m * sku.depth_m * qty)
    weight = js_round(sku.weight_kg * qty)
    return volume, weight


# --- Lookups -----------------------------------------------------------------


def get_sku(session: Session, sku_id: uuid.UUID) -> SkuTemplate:
    sku = session.get(SkuTemplate, sku_id)
    if sku is None:
        raise SkuMissing(sku_id)
    return sku


def get_bin(session: Session, bin_id: uuid.UUID) -> Bin:
    bin_row = session.get(Bin, bin_id)
    if bin_row is None:
        raise BinMissing(bin_id)
    return bin_row


def placements_in_bin(session: Session, bin_id: uuid.UUID) -> list[Placement]:
    return list(session.scalars(select(Placement).where(Placement.bin_id == bin_id)).all())


def list_placements(session: Session, warehouse_id: uuid.UUID) -> list[Placement]:
    return list(
        session.scalars(
            select(Placement)
            .join(Bin, Bin.id == Placement.bin_id)
            .where(Bin.warehouse_id == warehouse_id)
            .order_by(Bin.code, Placement.sku_id)
        ).all()
    )


def _assert_same_warehouse(session: Session, bin_row: Bin, sku: SkuTemplate) -> None:
    """Both sides must belong to the same warehouse, or an id from one could be
    combined with a bin from another."""
    warehouse_of_sku = session.scalar(
        select(SkuTemplate.warehouse_id).where(SkuTemplate.id == sku.id)
    )
    if warehouse_of_sku != bin_row.warehouse_id:
        raise WrongWarehouse(
            f"SKU '{sku.sku}' and bin '{bin_row.code}' belong to different warehouses"
        )


# --- Mutations ---------------------------------------------------------------


def place(
    session: Session, bin_id: uuid.UUID, sku_id: uuid.UUID, qty: int
) -> tuple[Bin, Placement]:
    """Place (or re-place) a quantity of one SKU in one bin.

    Upsert, because `(bin_id, sku_id)` is unique: dropping the same SKU again sets the
    quantity rather than creating a second row.
    """
    bin_row = get_bin(session, bin_id)
    sku = get_sku(session, sku_id)
    _assert_same_warehouse(session, bin_row, sku)

    existing = placements_in_bin(session, bin_id)
    diagnostics, _ = evaluate_placement(bin_row, sku, qty, existing)
    if diagnostics:
        raise PlacementRejected(diagnostics)

    volume, weight = usage_of(sku, qty)
    current = next((placement for placement in existing if placement.sku_id == sku.id), None)
    if current is None:
        current = Placement(bin_id=bin_row.id, sku_id=sku.id, qty=qty)
        session.add(current)

    current.qty = qty
    current.volume_used_m3 = volume
    current.weight_used_kg = weight

    session.flush()
    return bin_row, current


def unplace(session: Session, placement_id: uuid.UUID) -> None:
    placement = session.get(Placement, placement_id)
    if placement is None:
        raise PlacementMissing(placement_id)
    session.delete(placement)
    session.flush()


def bulk_place(
    session: Session, warehouse_id: uuid.UUID, sku_id: uuid.UUID, qty: int, bin_ids: list[uuid.UUID]
) -> list[tuple[uuid.UUID, Bin | None, Diagnostic | None, Placement | None]]:
    """Fill many bins with one SKU, reporting a verdict per bin.

    Deliberately not all-or-nothing. A bulk fill across a selection is expected to be
    partly refused — some bins are shorter, some are full, some have a lower beam limit
    — and rolling the whole thing back would make the operation unusable. Each bin is
    validated independently and the failures are reported with their codes.
    """
    sku = get_sku(session, sku_id)
    if session.scalar(select(SkuTemplate.warehouse_id).where(SkuTemplate.id == sku.id)) != (
        warehouse_id
    ):
        raise WrongWarehouse(f"SKU '{sku.sku}' does not belong to this warehouse")

    results: list[tuple[uuid.UUID, Bin | None, Diagnostic | None, Placement | None]] = []

    for bin_id in bin_ids:
        bin_row = session.get(Bin, bin_id)
        if bin_row is None or bin_row.warehouse_id != warehouse_id:
            results.append((bin_id, None, None, None))
            continue

        existing = placements_in_bin(session, bin_id)
        diagnostics, _ = evaluate_placement(bin_row, sku, qty, existing)
        if diagnostics:
            results.append((bin_id, bin_row, diagnostics[0], None))
            continue

        volume, weight = usage_of(sku, qty)
        current = next((p for p in existing if p.sku_id == sku.id), None)
        if current is None:
            current = Placement(bin_id=bin_row.id, sku_id=sku.id, qty=qty)
            session.add(current)
        current.qty = qty
        current.volume_used_m3 = volume
        current.weight_used_kg = weight
        results.append((bin_id, bin_row, None, current))

    session.flush()
    return results


def bin_summary(bin_row: Bin, existing: list[Placement]) -> dict[str, Any]:
    """A bin plus the capacity arithmetic, so the client renders the same numbers."""
    used_volume = sum(placement.volume_used_m3 for placement in existing)
    used_weight = sum(placement.weight_used_kg for placement in existing)

    return {
        "binId": bin_row.id,
        "binCode": bin_row.code,
        "capacityM3": bin_row.capacity_m3,
        "maxWeightKg": bin_row.max_weight_kg,
        "usedVolumeM3": round(used_volume, 6),
        "usedWeightKg": round(used_weight, 6),
        "remainingVolumeM3": round(max(bin_row.capacity_m3 - used_volume, 0.0), 6),
        "remainingWeightKg": (
            None
            if bin_row.max_weight_kg is None
            else round(max(bin_row.max_weight_kg - used_weight, 0.0), 6)
        ),
        "utilization": (
            0.0 if bin_row.capacity_m3 <= 0 else round(used_volume / bin_row.capacity_m3, 4)
        ),
        "placements": existing,
    }


def utilization_report(session: Session, warehouse_id: uuid.UUID) -> dict[str, Any]:
    bins = list(
        session.scalars(
            select(Bin).where(Bin.warehouse_id == warehouse_id).order_by(Bin.code)
        ).all()
    )
    placed = {
        row.bin_id: row.total
        for row in session.execute(
            select(Placement.bin_id, func.sum(Placement.volume_used_m3).label("total"))
            .join(Bin, Bin.id == Placement.bin_id)
            .where(Bin.warehouse_id == warehouse_id)
            .group_by(Placement.bin_id)
        ).all()
    }

    entries = [
        {
            "binId": str(bin_row.id),
            "binCode": bin_row.code,
            "utilization": (
                0.0
                if bin_row.capacity_m3 <= 0
                else round(placed.get(bin_row.id, 0.0) / bin_row.capacity_m3, 4)
            ),
        }
        for bin_row in bins
    ]

    utilized = sum(1 for entry in entries if entry["utilization"] > 0)
    return {
        "warehouseId": warehouse_id,
        "binCount": len(bins),
        "utilizedBins": utilized,
        "emptyBins": len(bins) - utilized,
        "entries": entries,
    }
