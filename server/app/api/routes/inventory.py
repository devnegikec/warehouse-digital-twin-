"""SKU and placement routes (Phase 8).

Two rules shape this file:

* **A placement is validated before it is written, and the refusal keeps the diagnostic
  code.** The envelope's `code` is the rule code (`ITEM_DOES_NOT_FIT_OPENING`,
  `EXCEEDS_BIN_VOLUME`, `EXCEEDS_BIN_WEIGHT`), not a generic `PLACEMENT_REJECTED`, so a
  client can assert that its own pre-flight check produced the same answer.
* **Bulk fills are per-bin.** One bin being too short must not discard the other
  ninety-nine; each gets its own verdict.
"""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ...db import get_session
from ...models import Bin, Placement, SkuTemplate
from ...schemas.inventory import (
    BinPlacementsOut,
    BulkPlacementIn,
    BulkPlacementItem,
    BulkPlacementOut,
    PlacementIn,
    PlacementOut,
    SkuIn,
    SkuOut,
    UtilizationOut,
)
from ...services import (
    BinMissing,
    InventoryError,
    PlacementMissing,
    PlacementRejected,
    SkuCodeTaken,
    SkuInUse,
    SkuMissing,
    WarehouseMissing,
    WrongWarehouse,
    bin_summary,
    bulk_place,
    get_bin,
    get_sku,
    get_warehouse,
    list_placements,
    place,
    placements_in_bin,
    unplace,
    utilization_report,
)

SessionDep = Annotated[Session, Depends(get_session)]

router = APIRouter(tags=["inventory"])


# --- Error mapping -----------------------------------------------------------


def _refuse(exc: InventoryError) -> HTTPException:
    if isinstance(exc, PlacementRejected):
        # The diagnostic code *is* the error code — see the module docstring.
        return HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail={
                "code": exc.code,
                "message": exc.message,
                "diagnostics": [diagnostic.to_json() for diagnostic in exc.diagnostics],
            },
        )
    if isinstance(exc, SkuMissing):
        return HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "SKU_NOT_FOUND", "message": str(exc)},
        )
    if isinstance(exc, BinMissing):
        return HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "BIN_NOT_FOUND", "message": str(exc)},
        )
    if isinstance(exc, PlacementMissing):
        return HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "PLACEMENT_NOT_FOUND", "message": str(exc)},
        )
    if isinstance(exc, SkuCodeTaken):
        return HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "SKU_CODE_TAKEN", "message": str(exc)},
        )
    if isinstance(exc, SkuInUse):
        return HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "SKU_IN_USE",
                "message": str(exc),
                "placements": exc.count,
            },
        )
    if isinstance(exc, WrongWarehouse):
        return HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "WRONG_WAREHOUSE", "message": str(exc)},
        )
    return HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail={"code": "INVENTORY_ERROR", "message": str(exc)},
    )


def _placement_out(bin_code: str, placement: Placement, sku_code: str) -> PlacementOut:
    return PlacementOut(
        id=placement.id,
        binId=placement.bin_id,
        binCode=bin_code,
        skuId=placement.sku_id,
        sku=sku_code,
        qty=placement.qty,
        volumeUsedM3=placement.volume_used_m3,
        weightUsedKg=placement.weight_used_kg,
    )


def _bin_codes(session: Session, bin_ids: list[uuid.UUID]) -> dict[uuid.UUID, str]:
    if not bin_ids:
        return {}
    rows = session.execute(select(Bin.id, Bin.code).where(Bin.id.in_(bin_ids))).all()
    return {row.id: row.code for row in rows}


def _sku_codes(session: Session, sku_ids: list[uuid.UUID]) -> dict[uuid.UUID, str]:
    if not sku_ids:
        return {}
    rows = session.execute(
        select(SkuTemplate.id, SkuTemplate.sku).where(SkuTemplate.id.in_(sku_ids))
    ).all()
    return {row.id: row.sku for row in rows}


def _sku_out(session: Session, sku: SkuTemplate) -> SkuOut:
    placed = session.scalar(
        select(func.coalesce(func.sum(Placement.qty), 0))
        .join(Bin, Bin.id == Placement.bin_id)
        .where(Bin.warehouse_id == sku.warehouse_id, Placement.sku_id == sku.id)
    )
    return SkuOut(
        id=sku.id,
        sku=sku.sku,
        name=sku.name,
        widthM=sku.width_m,
        heightM=sku.height_m,
        depthM=sku.depth_m,
        weightKg=sku.weight_kg,
        stackable=sku.stackable,
        rotatable=sku.rotatable,
        hazmat=sku.hazmat,
        placedQty=int(placed or 0),
    )


# --- SKUs --------------------------------------------------------------------


@router.get("/warehouses/{warehouse_id}/skus", response_model=list[SkuOut])
def list_skus(warehouse_id: uuid.UUID, session: SessionDep) -> list[SkuOut]:
    try:
        get_warehouse(session, warehouse_id)
    except WarehouseMissing as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "WAREHOUSE_NOT_FOUND", "message": str(exc)},
        ) from exc

    skus = session.scalars(
        select(SkuTemplate)
        .where(SkuTemplate.warehouse_id == warehouse_id)
        .order_by(SkuTemplate.sku)
    ).all()
    return [_sku_out(session, sku) for sku in skus]


@router.post(
    "/warehouses/{warehouse_id}/skus",
    response_model=SkuOut,
    status_code=status.HTTP_201_CREATED,
)
def create_sku(warehouse_id: uuid.UUID, payload: SkuIn, session: SessionDep) -> SkuOut:
    try:
        get_warehouse(session, warehouse_id)
    except WarehouseMissing as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "WAREHOUSE_NOT_FOUND", "message": str(exc)},
        ) from exc

    existing = session.scalars(
        select(SkuTemplate).where(
            SkuTemplate.warehouse_id == warehouse_id, SkuTemplate.sku == payload.sku
        )
    ).first()
    if existing is not None:
        raise _refuse(SkuCodeTaken(warehouse_id, payload.sku))

    sku = SkuTemplate(
        warehouse_id=warehouse_id,
        sku=payload.sku,
        name=payload.name,
        width_m=payload.widthM,
        height_m=payload.heightM,
        depth_m=payload.depthM,
        weight_kg=payload.weightKg,
        stackable=payload.stackable,
        rotatable=payload.rotatable,
        hazmat=payload.hazmat,
    )
    session.add(sku)
    session.commit()
    return _sku_out(session, sku)


@router.put("/skus/{sku_id}", response_model=SkuOut)
def update_sku(sku_id: uuid.UUID, payload: SkuIn, session: SessionDep) -> SkuOut:
    """Edit a SKU in place.

    This does **not** re-validate existing placements. Shrinking a SKU cannot invalidate
    anything, but growing one can, and silently deleting inventory because a dimension
    changed would be worse than leaving a placement that a later check flags. The
    placement list reports each bin's utilisation, so an over-capacity bin is visible.
    """
    try:
        sku = get_sku(session, sku_id)

        clash = session.scalars(
            select(SkuTemplate).where(
                SkuTemplate.warehouse_id == sku.warehouse_id,
                SkuTemplate.sku == payload.sku,
                SkuTemplate.id != sku.id,
            )
        ).first()
        if clash is not None:
            raise SkuCodeTaken(sku.warehouse_id, payload.sku)

        sku.sku = payload.sku
        sku.name = payload.name
        sku.width_m = payload.widthM
        sku.height_m = payload.heightM
        sku.depth_m = payload.depthM
        sku.weight_kg = payload.weightKg
        sku.stackable = payload.stackable
        sku.rotatable = payload.rotatable
        sku.hazmat = payload.hazmat
        session.commit()
    except InventoryError as exc:
        session.rollback()
        raise _refuse(exc) from exc

    return _sku_out(session, sku)


@router.delete("/skus/{sku_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_sku(sku_id: uuid.UUID, session: SessionDep) -> None:
    try:
        sku = get_sku(session, sku_id)
        count = session.scalar(
            select(func.count()).select_from(Placement).where(Placement.sku_id == sku.id)
        )
        if count:
            raise SkuInUse(sku.sku, int(count))
        session.delete(sku)
        session.commit()
    except IntegrityError as exc:
        # The foreign key is RESTRICT, so the database is the backstop if the count
        # above ever races with a concurrent placement.
        session.rollback()
        raise _refuse(SkuInUse("?", 1)) from exc
    except InventoryError as exc:
        session.rollback()
        raise _refuse(exc) from exc


# --- Placements --------------------------------------------------------------


@router.get("/warehouses/{warehouse_id}/placements", response_model=list[PlacementOut])
def list_warehouse_placements(warehouse_id: uuid.UUID, session: SessionDep) -> list[PlacementOut]:
    try:
        get_warehouse(session, warehouse_id)
    except WarehouseMissing as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "WAREHOUSE_NOT_FOUND", "message": str(exc)},
        ) from exc

    placements = list_placements(session, warehouse_id)
    bin_codes = _bin_codes(session, [p.bin_id for p in placements])
    sku_codes = _sku_codes(session, [p.sku_id for p in placements])

    return [
        _placement_out(bin_codes.get(p.bin_id, "?"), p, sku_codes.get(p.sku_id, "?"))
        for p in placements
    ]


@router.get("/warehouses/{warehouse_id}/utilization", response_model=UtilizationOut)
def get_utilization(warehouse_id: uuid.UUID, session: SessionDep) -> UtilizationOut:
    try:
        get_warehouse(session, warehouse_id)
    except WarehouseMissing as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "WAREHOUSE_NOT_FOUND", "message": str(exc)},
        ) from exc

    return UtilizationOut(**utilization_report(session, warehouse_id))


@router.get("/bins/{bin_id}/placements", response_model=BinPlacementsOut)
def get_bin_placements(bin_id: uuid.UUID, session: SessionDep) -> BinPlacementsOut:
    try:
        bin_row = get_bin(session, bin_id)
    except BinMissing as exc:
        raise _refuse(exc) from exc

    existing = placements_in_bin(session, bin_id)
    sku_codes = _sku_codes(session, [p.sku_id for p in existing])
    summary = bin_summary(bin_row, existing)

    return BinPlacementsOut(
        **{
            **summary,
            "placements": [
                _placement_out(bin_row.code, p, sku_codes.get(p.sku_id, "?")) for p in existing
            ],
        }
    )


@router.post(
    "/bins/{bin_id}/placements",
    response_model=PlacementOut,
    status_code=status.HTTP_201_CREATED,
)
def create_placement(bin_id: uuid.UUID, payload: PlacementIn, session: SessionDep) -> PlacementOut:
    """Place a SKU in a bin, revalidating on the server.

    The client checks the same thing before the drop, so a 200 here means both sides
    agreed and a 422 means the codes should match what the client computed.
    """
    try:
        bin_row, placement = place(session, bin_id, payload.skuId, payload.qty)
        session.commit()
    except InventoryError as exc:
        session.rollback()
        raise _refuse(exc) from exc

    sku = get_sku(session, payload.skuId)
    return _placement_out(bin_row.code, placement, sku.sku)


@router.delete("/placements/{placement_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_placement(placement_id: uuid.UUID, session: SessionDep) -> None:
    try:
        unplace(session, placement_id)
        session.commit()
    except InventoryError as exc:
        session.rollback()
        raise _refuse(exc) from exc


@router.post("/warehouses/{warehouse_id}/placements/bulk", response_model=BulkPlacementOut)
def bulk_create_placements(
    warehouse_id: uuid.UUID, payload: BulkPlacementIn, session: SessionDep
) -> BulkPlacementOut:
    """Fill many bins at once, with a verdict per bin rather than all-or-nothing."""
    try:
        results = bulk_place(session, warehouse_id, payload.skuId, payload.qty, payload.binIds)
        session.commit()
    except InventoryError as exc:
        session.rollback()
        raise _refuse(exc) from exc

    sku = get_sku(session, payload.skuId)

    items: list[BulkPlacementItem] = []
    placed = 0
    for bin_id, bin_row, diagnostic, placement in results:
        if bin_row is None:
            items.append(
                BulkPlacementItem(
                    binId=bin_id,
                    ok=False,
                    code="BIN_NOT_FOUND",
                    message="That bin is not part of this warehouse",
                )
            )
            continue

        if diagnostic is not None:
            items.append(
                BulkPlacementItem(
                    binId=bin_id,
                    binCode=bin_row.code,
                    ok=False,
                    code=diagnostic.code,
                    message=diagnostic.message,
                )
            )
            continue

        placed += 1
        items.append(
            BulkPlacementItem(
                binId=bin_id,
                binCode=bin_row.code,
                ok=True,
                placement=None
                if placement is None
                else _placement_out(bin_row.code, placement, sku.sku),
            )
        )

    return BulkPlacementOut(placed=placed, rejected=len(items) - placed, results=items)
