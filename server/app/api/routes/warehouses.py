"""Warehouse persistence routes (Phase 7).

Ordering that matters here, not just in the services:

* Every refusal is turned into a specific status code *and* a machine-readable
  ``code`` in the body, because the client branches on the code, not the number.
  ``COMPILER_DRIFT`` in particular must never be reachable as a generic 500: it is
  the alarm that makes the dual compiler safe (P9), and an alarm nobody can read is
  not an alarm.
* ``If-Match`` is required for draft writes. A missing header is refused rather than
  treated as "no concurrency check", because silently accepting a stale autosave is
  exactly the failure the token exists to prevent.
"""

from __future__ import annotations

import uuid
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Header, HTTPException, Response, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from ...db import get_session
from ...layout import DocumentInvalid, build_layout
from ...models import Aisle, Bay, Bin, Lane, LayoutVersion, VersionStatus, Warehouse
from ...schemas import (
    DraftOut,
    DraftPut,
    PublishedLayoutOut,
    PublishOut,
    PublishRequest,
    VersionOut,
    WarehouseCreate,
    WarehouseOut,
)
from ...services import (
    CompilerDrift,
    LayoutNotPublishable,
    PersistenceError,
    StaleDraft,
    WarehouseMissing,
    compile_document,
    current_draft,
    current_published,
    get_warehouse,
    save_draft,
)
from ...services import publish as publish_service

SessionDep = Annotated[Session, Depends(get_session)]
IfMatch = Annotated[str | None, Header(alias="If-Match")]

router = APIRouter(prefix="/warehouses", tags=["warehouses"])


# --- Error mapping -----------------------------------------------------------


def _refuse(exc: PersistenceError) -> HTTPException:
    """Translate a service refusal into a status code and a readable code."""
    if isinstance(exc, WarehouseMissing):
        return HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "WAREHOUSE_NOT_FOUND", "message": str(exc)},
        )
    if isinstance(exc, CompilerDrift):
        return HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "COMPILER_DRIFT",
                "message": str(exc),
                "clientDocHash": exc.client_doc_hash,
                "serverDocHash": exc.server_doc_hash,
            },
        )
    if isinstance(exc, StaleDraft):
        return HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "STALE_DRAFT",
                "message": str(exc),
                "expectedRevision": exc.expected,
                "actualRevision": exc.actual,
            },
        )
    if isinstance(exc, LayoutNotPublishable):
        return HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail={
                "code": "LAYOUT_NOT_PUBLISHABLE",
                "message": str(exc),
                "diagnostics": exc.diagnostics,
            },
        )
    return HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail={"code": "PERSISTENCE_ERROR", "message": str(exc)},
    )


def _parse_if_match(value: str | None) -> int:
    """``If-Match`` carries the draft revision, as a quoted or bare integer."""
    if value is None or value.strip() == "":
        raise HTTPException(
            status_code=status.HTTP_428_PRECONDITION_REQUIRED,
            detail={
                "code": "PRECONDITION_REQUIRED",
                "message": (
                    "Draft writes require If-Match with the current draftRevision. "
                    "The token is returned by GET /api/warehouses/{id} after creation."
                ),
            },
        )

    raw = value.strip().strip('"')
    # A wildcard would mean "match anything", which is the opposite of the point.
    if raw == "*":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "INVALID_IF_MATCH", "message": "If-Match: * is not accepted here"},
        )

    try:
        revision = int(raw)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "code": "INVALID_IF_MATCH",
                "message": f"If-Match must be an integer draft revision; received '{value}'",
            },
        ) from exc

    if revision < 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "INVALID_IF_MATCH", "message": "If-Match must not be negative"},
        )
    return revision


def _version_out(version: LayoutVersion) -> VersionOut:
    diagnostics = version.diagnostics or []
    return VersionOut(
        version=version.version,
        status=str(version.status),
        docHash=version.doc_hash,
        createdAt=version.created_at,
        publishedAt=version.published_at,
        createdBy=version.created_by,
        errorCount=sum(1 for item in diagnostics if item.get("severity") == "error"),
        warningCount=sum(1 for item in diagnostics if item.get("severity") == "warning"),
        orphanedPlacements=list(version.orphaned_placements or []),
    )


def _warehouse_out(session: Session, warehouse: Warehouse) -> WarehouseOut:
    draft = current_draft(session, warehouse.id)
    published = current_published(session, warehouse.id)
    return WarehouseOut(
        id=warehouse.id,
        code=warehouse.code,
        name=warehouse.name,
        lengthM=warehouse.length_m,
        widthM=warehouse.width_m,
        heightM=warehouse.height_m,
        draftRevision=warehouse.draft_revision,
        draft=_version_out(draft) if draft else None,
        published=_version_out(published) if published else None,
    )


def _blank_document(create: WarehouseCreate) -> dict[str, Any]:
    """A valid, empty layout for a new warehouse.

    Deliberately empty rather than a sample layout: a designer should not have to
    delete someone else's example before starting, and an empty document is
    publishable so the first publish is never blocked by a rule about having no
    racking.
    """
    warehouse: dict[str, Any] = {
        "code": create.code,
        "name": create.name,
        "lengthM": create.lengthM,
        "widthM": create.widthM,
        "heightM": create.heightM,
    }
    if create.origin is not None:
        warehouse["origin"] = create.origin

    return {
        "schemaVersion": 1,
        "warehouse": warehouse,
        "obstacles": [],
        "rackTypes": [],
        "aisles": [],
    }


# --- Routes ------------------------------------------------------------------


@router.get("", response_model=list[WarehouseOut])
def list_warehouses(session: SessionDep) -> list[WarehouseOut]:
    warehouses = session.scalars(select(Warehouse).order_by(Warehouse.code)).all()
    return [_warehouse_out(session, warehouse) for warehouse in warehouses]


@router.post("", response_model=WarehouseOut, status_code=status.HTTP_201_CREATED)
def create_warehouse(payload: WarehouseCreate, session: SessionDep) -> WarehouseOut:
    """Create a warehouse, optionally seeding it with a document.

    When ``doc`` is supplied it wins outright — including its own footprint — because
    the document is the source of truth and a payload whose footprint disagreed with
    its document would otherwise create two conflicting records.
    """
    doc = payload.doc if payload.doc is not None else _blank_document(payload)

    try:
        graph = compile_document(doc, None)
    except DocumentInvalid as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail={"code": "DOCUMENT_INVALID", "errors": exc.errors},
        ) from exc

    doc_warehouse = graph.doc["warehouse"]

    # Uniqueness is checked against the *document's* code, because that is what gets
    # inserted. Checking the payload's code instead lets a document whose warehouse
    # disagrees with the request slip past this guard and hit the unique constraint as
    # a 500 instead of a 409.
    existing = session.scalars(
        select(Warehouse).where(Warehouse.code == doc_warehouse["code"])
    ).first()
    if existing is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "WAREHOUSE_CODE_TAKEN",
                "message": f"A warehouse with code '{doc_warehouse['code']}' already exists",
            },
        )

    warehouse = Warehouse(
        code=doc_warehouse["code"],
        name=doc_warehouse.get("name") or "",
        length_m=float(doc_warehouse["lengthM"]),
        width_m=float(doc_warehouse["widthM"]),
        height_m=float(doc_warehouse["heightM"]),
        draft_revision=0,
    )
    session.add(warehouse)
    session.flush()

    # The supplied document becomes the first draft, so the client can immediately
    # autosave it with If-Match: 1 without an extra round trip.
    draft = LayoutVersion(
        warehouse_id=warehouse.id,
        version=1,
        status=VersionStatus.DRAFT,
        doc=doc,
        doc_hash=graph.hash,
        diagnostics=[diagnostic.to_json() for diagnostic in graph.diagnostics],
    )
    session.add(draft)
    session.commit()

    return _warehouse_out(session, warehouse)


@router.get("/{warehouse_id}", response_model=WarehouseOut)
def get_warehouse_detail(warehouse_id: uuid.UUID, session: SessionDep) -> WarehouseOut:
    try:
        warehouse = get_warehouse(session, warehouse_id)
    except WarehouseMissing as exc:
        raise _refuse(exc) from exc
    return _warehouse_out(session, warehouse)


@router.put("/{warehouse_id}/draft", response_model=DraftOut)
def put_draft(
    warehouse_id: uuid.UUID,
    payload: DraftPut,
    session: SessionDep,
    if_match: IfMatch = None,
) -> DraftOut:
    """Autosave. Debounced by the client; guarded by the revision token here."""
    revision = _parse_if_match(if_match)

    try:
        warehouse, draft, graph = save_draft(
            session,
            warehouse_id,
            payload.doc,
            payload.clientDocHash,
            revision,
        )
        session.commit()
    except DocumentInvalid as exc:
        session.rollback()
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail={"code": "DOCUMENT_INVALID", "errors": exc.errors},
        ) from exc
    except PersistenceError as exc:
        session.rollback()
        raise _refuse(exc) from exc

    return DraftOut(
        warehouseId=warehouse.id,
        version=draft.version,
        draftRevision=warehouse.draft_revision,
        docHash=graph.hash,
        publishable=graph.publishable,
        errorCount=graph.error_count,
        warningCount=graph.warning_count,
        diagnostics=[diagnostic.to_json() for diagnostic in graph.diagnostics],
        savedAt=draft.updated_at,
    )


@router.delete("/{warehouse_id}/draft", status_code=status.HTTP_204_NO_CONTENT)
def discard_draft(
    warehouse_id: uuid.UUID, session: SessionDep, if_match: IfMatch = None
) -> Response:
    """Throw the draft away, keeping any published version intact.

    A discard bumps the revision too: a client that still holds the old token must
    find out that its working copy is no longer the server's.
    """
    revision = _parse_if_match(if_match)

    try:
        warehouse = get_warehouse(session, warehouse_id)
        if revision != warehouse.draft_revision:
            raise StaleDraft(revision, warehouse.draft_revision)

        draft = current_draft(session, warehouse_id)
        if draft is not None:
            session.delete(draft)

        warehouse.draft_revision += 1
        session.commit()
    except PersistenceError as exc:
        session.rollback()
        raise _refuse(exc) from exc

    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{warehouse_id}/validate")
def validate_warehouse_layout(
    warehouse_id: uuid.UUID, payload: PublishRequest, session: SessionDep
) -> dict[str, Any]:
    """Compile without writing. The editor's pre-flight for a save or a publish."""
    try:
        get_warehouse(session, warehouse_id)
        graph = compile_document(payload.doc, payload.clientDocHash)
    except PersistenceError as exc:
        raise _refuse(exc) from exc

    return {
        "docHash": graph.hash,
        "publishable": graph.publishable,
        "binCount": len(graph.bins),
        "bayCount": len(graph.bays),
        "errorCount": graph.error_count,
        "warningCount": graph.warning_count,
        "diagnostics": [diagnostic.to_json() for diagnostic in graph.diagnostics],
    }


@router.post("/{warehouse_id}/publish", response_model=PublishOut)
def publish_warehouse_layout(
    warehouse_id: uuid.UUID, payload: PublishRequest, session: SessionDep
) -> PublishOut:
    """Validate, materialise and publish in one transaction.

    Idempotent on ``doc_hash``: publishing the document that is already live returns
    the existing version with ``changed: false``.
    """
    try:
        result = publish_service(
            session,
            warehouse_id,
            payload.doc,
            payload.clientDocHash,
            payload.createdBy,
        )
        session.commit()
    except DocumentInvalid as exc:
        session.rollback()
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail={"code": "DOCUMENT_INVALID", "errors": exc.errors},
        ) from exc
    except PersistenceError as exc:
        session.rollback()
        raise _refuse(exc) from exc

    return PublishOut(
        warehouseId=warehouse_id,
        version=result.version,
        docHash=result.doc_hash,
        status=str(VersionStatus.PUBLISHED),
        changed=result.changed,
        binCount=result.bin_count,
        bayCount=result.bay_count,
        errorCount=0,
        warningCount=sum(
            1 for diagnostic in result.diagnostics if diagnostic.get("severity") == "warning"
        ),
        diagnostics=result.diagnostics,
        orphanedPlacements=result.orphaned,
    )


@router.get("/{warehouse_id}/versions", response_model=list[VersionOut])
def list_versions(warehouse_id: uuid.UUID, session: SessionDep) -> list[VersionOut]:
    try:
        get_warehouse(session, warehouse_id)
    except WarehouseMissing as exc:
        raise _refuse(exc) from exc

    versions = session.scalars(
        select(LayoutVersion)
        .where(LayoutVersion.warehouse_id == warehouse_id)
        .order_by(LayoutVersion.version.desc())
    ).all()
    return [_version_out(version) for version in versions]


@router.get("/{warehouse_id}/layout", response_model=PublishedLayoutOut)
def get_published_layout(warehouse_id: uuid.UUID, session: SessionDep) -> PublishedLayoutOut:
    """The published layout for Operate mode.

    Bins are read from the materialised rows rather than recompiled, because those
    rows carry the surrogate ids that placements reference. The document is also
    recompiled and its hash returned alongside, so a snapshot that no longer matches
    what the compiler would produce today is visible as ``conflicts`` instead of
    being silently served.
    """
    try:
        warehouse = get_warehouse(session, warehouse_id)
    except WarehouseMissing as exc:
        raise _refuse(exc) from exc

    published = current_published(session, warehouse_id)
    if published is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={
                "code": "NO_PUBLISHED_LAYOUT",
                "message": f"Warehouse '{warehouse.code}' has never been published",
            },
        )

    bins = session.scalars(
        select(Bin).where(Bin.warehouse_id == warehouse_id).order_by(Bin.code)
    ).all()

    # Aisle and lane identity is joined in rather than parsed back out of the bin code:
    # the code pattern is per-lane and configurable, so parsing it would work for the
    # default layout and quietly break for a custom one.
    identity = {
        row[0]: (row[1], row[2], row[3], row[4])
        for row in session.execute(
            select(Bin.id, Aisle.code, Lane.code, Lane.side, Bay.seq)
            .join(Bay, Bay.id == Bin.bay_id)
            .join(Lane, Lane.id == Bay.lane_id)
            .join(Aisle, Aisle.id == Lane.aisle_id)
            .where(Bin.warehouse_id == warehouse_id)
        ).all()
    }

    recompiled = build_layout(published.doc)
    conflicts: list[str] = []
    if recompiled.hash != published.doc_hash:
        conflicts.append(
            "The stored document no longer compiles to the hash it was published with "
            "(stored "
            f"{published.doc_hash[:12]}…, now {recompiled.hash[:12]}…). The compiler "
            "changed after this version was published."
        )

    return PublishedLayoutOut(
        warehouseId=warehouse.id,
        code=warehouse.code,
        version=published.version,
        docHash=published.doc_hash,
        recompiledDocHash=recompiled.hash,
        publishedAt=published.published_at,
        bins=[
            {
                "id": str(bin_.id),
                "code": bin_.code,
                "aisleCode": identity.get(bin_.id, ("", "", "", 0))[0],
                "laneCode": identity.get(bin_.id, ("", "", "", 0))[1],
                "side": identity.get(bin_.id, ("", "", "", 0))[2],
                "baySeq": identity.get(bin_.id, ("", "", "", 0))[3],
                "levelIndex": bin_.level_index,
                "center": {"x": bin_.center_x, "y": bin_.center_y, "z": bin_.center_z},
                "widthM": bin_.width_m,
                "heightM": bin_.height_m,
                "depthM": bin_.depth_m,
                "rotationDeg": bin_.rotation_deg,
                "capacityM3": bin_.capacity_m3,
                "maxWeightKg": bin_.max_weight_kg,
            }
            for bin_ in bins
        ],
        conflicts=conflicts,
    )
