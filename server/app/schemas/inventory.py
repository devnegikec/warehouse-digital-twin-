"""Pydantic DTOs for SKUs and placements (Phase 8).

A placement refusal returns the *diagnostic* code as the envelope's `code`. That is the
whole point of §7.4's design: the client and the server run the same capacity module,
so an oversized drop must produce the identical code on both sides — and a test can
assert it by comparing two strings rather than by pattern-matching prose.
"""

from __future__ import annotations

from typing import Any
from uuid import UUID

from pydantic import BaseModel, Field


class SkuIn(BaseModel):
    sku: str = Field(min_length=1, max_length=64)
    name: str = ""
    widthM: float = Field(gt=0)
    heightM: float = Field(gt=0)
    depthM: float = Field(gt=0)
    weightKg: float = Field(ge=0)
    stackable: bool = True
    rotatable: bool = True
    """When false, only the authored orientation is legal — mirrored by `orientationsOf`."""
    hazmat: bool = False


class SkuOut(SkuIn):
    id: UUID
    placedQty: int = 0
    """Total quantity of this SKU placed across the warehouse."""


class PlacementIn(BaseModel):
    skuId: UUID
    qty: int = Field(gt=0)


class PlacementOut(BaseModel):
    id: UUID
    binId: UUID
    binCode: str
    skuId: UUID
    sku: str
    qty: int
    volumeUsedM3: float
    weightUsedKg: float


class BinPlacementsOut(BaseModel):
    """A bin and everything in it, with the capacity arithmetic already done.

    `remaining*` is computed from the *other* placements, so the client can render a
    drag ghost from the same numbers the server checks rather than re-deriving them.
    """

    binId: UUID
    binCode: str
    capacityM3: float
    maxWeightKg: float | None
    usedVolumeM3: float
    usedWeightKg: float
    remainingVolumeM3: float
    remainingWeightKg: float | None
    utilization: float
    placements: list[PlacementOut]


class BulkPlacementIn(BaseModel):
    skuId: UUID
    qty: int = Field(gt=0)
    binIds: list[UUID] = Field(min_length=1)


class BulkPlacementItem(BaseModel):
    binId: UUID
    binCode: str | None = None
    ok: bool
    code: str | None = None
    message: str = ""
    placement: PlacementOut | None = None


class BulkPlacementOut(BaseModel):
    """Every bin gets its own verdict: a bulk fill is per-bin, not all-or-nothing."""

    placed: int
    rejected: int
    results: list[BulkPlacementItem]


class UtilizationOut(BaseModel):
    """Heatmap input: utilisation per bin, and the bins that hold nothing."""

    warehouseId: UUID
    binCount: int
    utilizedBins: int
    emptyBins: int
    entries: list[dict[str, Any]]
