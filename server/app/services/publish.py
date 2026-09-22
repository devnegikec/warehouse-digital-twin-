"""Persistence services: draft autosave and publish.

Everything that writes layout state lives here rather than in the route handlers, so
the transaction boundaries and the invariants are in one readable place.

The invariants this module exists to hold:

* **Publishing is idempotent on ``doc_hash``.** Re-publishing an unchanged document
  must be a no-op, not a new version. Without this a debounced autosave that also
  triggered a publish would fill the version table with identical rows.
* **One PUBLISHED version per warehouse.** A partial unique index enforces it in the
  database; this code archives the previous one first so the index is never violated
  mid-transaction.
* **Bins survive a re-publish.** They are upserted by ``code`` rather than deleted and
  recreated, which is what keeps placement rows (Phase 8) attached to the same bin
  across publishes (P3: the code is the natural key).
* **Orphaned placements are reported, never silently discarded.** If a bin disappears
  its placements cannot remain, so they are snapshotted into the new version's
  ``orphaned_placements`` before the cascade removes them.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..layout import DocumentInvalid, LayoutGraph, build_layout, validate_document
from ..models import Aisle, Bay, Bin, Lane, LayoutVersion, VersionStatus, Warehouse


class PersistenceError(Exception):
    """Base for the refusals the API turns into specific status codes."""


class WarehouseMissing(PersistenceError):
    def __init__(self, warehouse_id: object) -> None:
        super().__init__(f"No warehouse with id '{warehouse_id}'")
        self.warehouse_id = warehouse_id


class CompilerDrift(PersistenceError):
    def __init__(self, client_doc_hash: str, server_doc_hash: str) -> None:
        super().__init__("The TypeScript and Python compilers disagree on this document")
        self.client_doc_hash = client_doc_hash
        self.server_doc_hash = server_doc_hash


class LayoutNotPublishable(PersistenceError):
    def __init__(self, diagnostics: list[dict[str, Any]]) -> None:
        super().__init__("The layout has errors, so it cannot be published")
        self.diagnostics = diagnostics


class StaleDraft(PersistenceError):
    def __init__(self, expected: int, actual: int) -> None:
        super().__init__(f"Draft revision {expected} is stale; the server is at {actual}")
        self.expected = expected
        self.actual = actual


@dataclass
class PublishResult:
    version: int
    doc_hash: str
    changed: bool
    bin_count: int
    bay_count: int
    diagnostics: list[dict[str, Any]] = field(default_factory=list)
    orphaned: list[dict[str, Any]] = field(default_factory=list)


# --- Lookups -----------------------------------------------------------------


def get_warehouse(session: Session, warehouse_id: uuid.UUID) -> Warehouse:
    warehouse = session.get(Warehouse, warehouse_id)
    if warehouse is None:
        raise WarehouseMissing(warehouse_id)
    return warehouse


def _version_with_status(
    session: Session, warehouse_id: uuid.UUID, status: VersionStatus
) -> LayoutVersion | None:
    return session.scalars(
        select(LayoutVersion)
        .where(LayoutVersion.warehouse_id == warehouse_id, LayoutVersion.status == status)
        .order_by(LayoutVersion.version.desc())
        .limit(1)
    ).first()


def current_draft(session: Session, warehouse_id: uuid.UUID) -> LayoutVersion | None:
    return _version_with_status(session, warehouse_id, VersionStatus.DRAFT)


def current_published(session: Session, warehouse_id: uuid.UUID) -> LayoutVersion | None:
    return _version_with_status(session, warehouse_id, VersionStatus.PUBLISHED)


def next_version_number(session: Session, warehouse_id: uuid.UUID) -> int:
    highest = session.scalar(
        select(func.max(LayoutVersion.version)).where(LayoutVersion.warehouse_id == warehouse_id)
    )
    return (highest or 0) + 1


# --- Compilation -------------------------------------------------------------


def compile_document(doc: dict[str, Any], client_doc_hash: str | None) -> LayoutGraph:
    """Validate, compile, and check the client's hash.

    The drift check is the whole reason the dual implementation is safe (P9): two
    compilers disagreeing is how wrong bins reach the database, so a mismatch is a
    hard refusal rather than a warning.
    """
    try:
        validate_document(doc)
    except DocumentInvalid:
        raise

    graph = build_layout(doc)

    if client_doc_hash and client_doc_hash != graph.hash:
        raise CompilerDrift(client_doc_hash, graph.hash)

    return graph


def sync_footprint(warehouse: Warehouse, graph: LayoutGraph) -> None:
    """Mirror the document's footprint onto the ``warehouse`` row.

    The document is the source of truth; these columns exist so a warehouse list can
    be rendered without compiling every layout.
    """
    doc_warehouse = graph.doc["warehouse"]
    warehouse.name = doc_warehouse.get("name") or warehouse.name
    warehouse.length_m = float(doc_warehouse["lengthM"])
    warehouse.width_m = float(doc_warehouse["widthM"])
    warehouse.height_m = float(doc_warehouse["heightM"])


# --- Draft ------------------------------------------------------------------


def save_draft(
    session: Session,
    warehouse_id: uuid.UUID,
    doc: dict[str, Any],
    client_doc_hash: str | None,
    expected_revision: int | None,
) -> tuple[Warehouse, LayoutVersion, LayoutGraph]:
    """Write the autosaved document, guarded by the revision token.

    ``expected_revision=None`` means the client did not send ``If-Match``. That is
    refused by the route rather than treated as "no check", because a last-write-wins
    autosave is exactly the behaviour the token exists to prevent.
    """
    warehouse = get_warehouse(session, warehouse_id)

    if expected_revision is not None and expected_revision != warehouse.draft_revision:
        raise StaleDraft(expected_revision, warehouse.draft_revision)

    graph = compile_document(doc, client_doc_hash)

    draft = current_draft(session, warehouse_id)
    if draft is None:
        draft = LayoutVersion(
            warehouse_id=warehouse.id,
            version=next_version_number(session, warehouse_id),
            status=VersionStatus.DRAFT,
        )
        session.add(draft)

    draft.doc = doc
    draft.doc_hash = graph.hash
    draft.diagnostics = [diagnostic.to_json() for diagnostic in graph.diagnostics]
    draft.orphaned_placements = draft.orphaned_placements or []

    sync_footprint(warehouse, graph)
    warehouse.draft_revision += 1

    session.flush()
    return warehouse, draft, graph


# --- Publish ----------------------------------------------------------------


def publish(
    session: Session,
    warehouse_id: uuid.UUID,
    doc: dict[str, Any],
    client_doc_hash: str | None,
    created_by: str | None = None,
) -> PublishResult:
    """Validate, materialise and publish, in one transaction.

    Idempotent on ``doc_hash``: publishing the document that is already published
    returns the existing version and writes nothing.
    """
    warehouse = get_warehouse(session, warehouse_id)
    graph = compile_document(doc, client_doc_hash)

    if not graph.publishable:
        raise LayoutNotPublishable([diagnostic.to_json() for diagnostic in graph.diagnostics])

    already_published = current_published(session, warehouse_id)
    if already_published is not None and already_published.doc_hash == graph.hash:
        # Idempotent: the same bytes are already live. No new version, no rewrite.
        return PublishResult(
            version=already_published.version,
            doc_hash=graph.hash,
            changed=False,
            bin_count=session.scalar(
                select(func.count()).select_from(Bin).where(Bin.warehouse_id == warehouse_id)
            )
            or 0,
            bay_count=len(graph.bays),
            diagnostics=[diagnostic.to_json() for diagnostic in graph.diagnostics],
            orphaned=list(already_published.orphaned_placements or []),
        )

    # Archive before inserting: the partial unique index allows only one PUBLISHED
    # row per warehouse, so the old one must step aside within the same transaction.
    if already_published is not None:
        already_published.status = VersionStatus.ARCHIVED

    draft = current_draft(session, warehouse_id)
    diagnostics = [diagnostic.to_json() for diagnostic in graph.diagnostics]

    if draft is not None and draft.doc_hash == graph.hash:
        # The stored draft *is* what is being published, so it becomes the version
        # rather than being deleted while a fresh row is inserted. Otherwise a
        # warehouse whose draft was autosaved would publish as version 2 with nothing
        # at version 1, which reads as lost history.
        version = draft
        version.status = VersionStatus.PUBLISHED
        version.doc = doc
        version.diagnostics = diagnostics
        version.created_by = created_by
        version.published_at = datetime.now(UTC)
    else:
        # The client published something other than its last autosave (unsaved edits,
        # or a different editor), so the stale draft is superseded.
        if draft is not None:
            session.delete(draft)
        version = LayoutVersion(
            warehouse_id=warehouse.id,
            version=next_version_number(session, warehouse_id),
            status=VersionStatus.PUBLISHED,
            doc=doc,
            doc_hash=graph.hash,
            diagnostics=diagnostics,
            created_by=created_by,
            published_at=datetime.now(UTC),
        )
        session.add(version)

    session.flush()

    orphaned = materialize(session, warehouse, graph)
    version.orphaned_placements = orphaned

    sync_footprint(warehouse, graph)
    warehouse.draft_revision += 1
    session.flush()

    return PublishResult(
        version=version.version,
        doc_hash=graph.hash,
        changed=True,
        bin_count=len(graph.bins),
        bay_count=len(graph.bays),
        diagnostics=[diagnostic.to_json() for diagnostic in graph.diagnostics],
        orphaned=orphaned,
    )


def materialize(session: Session, warehouse: Warehouse, graph: LayoutGraph) -> list[dict[str, Any]]:
    """Write the derived structure, upserting by natural key.

    Bins are matched by ``code`` so a re-publish updates the row it already has. That
    matters beyond tidiness: placement rows point at a bin id, so delete-and-recreate
    would silently detach every placement on every publish.

    Returns the placements that could not survive because their bin is gone.
    """
    warehouse_id = warehouse.id

    existing_aisles = {
        aisle.code: aisle
        for aisle in session.scalars(select(Aisle).where(Aisle.warehouse_id == warehouse_id))
    }
    existing_bins = {
        bin_.code: bin_
        for bin_ in session.scalars(select(Bin).where(Bin.warehouse_id == warehouse_id))
    }

    bays_by_lane: dict[str, list[Any]] = {}
    for bay in graph.bays:
        bays_by_lane.setdefault(bay.lane_code, []).append(bay)

    kept_aisles: set[str] = set()
    kept_bins: set[str] = set()
    # Rows to remove once everything has been upserted, and *in this order*. Deleting
    # a lane cascades into its bays, which cascades into their bins, so removing
    # parents first would leave the explicit bin deletions below trying to delete rows
    # that no longer exist.
    stale_bays: list[Bay] = []
    stale_lanes: list[Lane] = []
    stale_aisles: list[Aisle] = []
    # Collected as the tree is written rather than queried back afterwards. A newly
    # created aisle's `lanes` collection is empty in memory (`lane_id` was set
    # directly), so reading the tree back through the relationships would miss
    # exactly the rows this function just created.
    bay_rows: dict[tuple[str, int], Bay] = {}

    for aisle_seq, aisle_doc in enumerate(graph.doc["aisles"]):
        aisle = existing_aisles.get(aisle_doc["code"])
        if aisle is None:
            aisle = Aisle(warehouse_id=warehouse_id, code=aisle_doc["code"])
            session.add(aisle)
        centerline = aisle_doc["centerline"]
        aisle.orientation = aisle_doc["orientation"]
        aisle.x1 = float(centerline["x1"])
        aisle.z1 = float(centerline["z1"])
        aisle.x2 = float(centerline["x2"])
        aisle.z2 = float(centerline["z2"])
        aisle.width_m = float(aisle_doc["widthM"])
        aisle.travel_direction = aisle_doc.get("travelDirection", "BOTH")
        aisle.seq = aisle_seq
        kept_aisles.add(aisle.code)
        session.flush()

        existing_lanes = {lane.code: lane for lane in aisle.lanes}
        kept_lanes: set[str] = set()

        for lane_seq, lane_doc in enumerate(aisle_doc.get("lanes", [])):
            lane = existing_lanes.get(lane_doc["code"])
            if lane is None:
                lane = Lane(aisle_id=aisle.id, code=lane_doc["code"])
                session.add(lane)
            lane.side = lane_doc["side"]
            lane.rack_type_code = _rack_type_code(graph, lane_doc.get("rackTypeId"))
            lane.start_offset_m = float(lane_doc.get("startOffsetM", 0))
            lane.length_m = float(lane_doc["lengthM"])
            lane.levels = lane_doc["levels"]
            lane.segments = lane_doc.get("segments") or []
            lane.bin_code_pattern = lane_doc["binCodePattern"]
            lane.seq = lane_seq
            kept_lanes.add(lane.code)
            session.flush()

            existing_bays = {bay.seq: bay for bay in lane.bays}
            kept_bays: set[int] = set()

            for bay_doc in bays_by_lane.get(lane.code, []):
                bay = existing_bays.get(bay_doc.seq)
                if bay is None:
                    bay = Bay(lane_id=lane.id, seq=bay_doc.seq)
                    session.add(bay)
                bay.start_m = float(
                    bay_doc.center["x"] if bay_doc.rotation_deg == 0 else bay_doc.center["z"]
                )
                bay.width_m = float(bay_doc.width_m)
                bay.is_skipped = bool(bay_doc.is_skipped)
                kept_bays.add(bay_doc.seq)
                session.flush()
                # Registered here, not read back from the ORM afterwards: a lane created
                # in this transaction has an empty in-memory `bays` collection, so a
                # lookup through the relationships would miss exactly these rows.
                bay_rows[(lane.code, bay_doc.seq)] = bay

            # Bays whose number no longer exists on this lane.
            stale_bays.extend(bay for seq, bay in existing_bays.items() if seq not in kept_bays)

        # Lanes removed from the document.
        stale_lanes.extend(lane for code, lane in existing_lanes.items() if code not in kept_lanes)

    # Aisles removed from the document.
    stale_aisles.extend(aisle for code, aisle in existing_aisles.items() if code not in kept_aisles)

    # Bins are matched by code across the whole warehouse, because the code is the
    # stable natural key (P3) and a bay can move between lanes without changing it.
    for derived in graph.bins:
        key = (derived.lane_code, derived.bay_seq)
        bay_row = bay_rows.get(key)
        if bay_row is None:
            # The compiler only produces bins for bays it also derived, so a missing
            # bay row means the materialiser above and the compiler disagree.
            raise PersistenceError(
                f"Compiler derived bin '{derived.code}' for bay {key} with no bay row"
            )

        bin_ = existing_bins.get(derived.code)
        if bin_ is None:
            bin_ = Bin(warehouse_id=warehouse_id, code=derived.code)
            session.add(bin_)
        bin_.bay_id = bay_row.id
        bin_.level_index = derived.level_index
        bin_.center_x = float(derived.center["x"])
        bin_.center_y = float(derived.center["y"])
        bin_.center_z = float(derived.center["z"])
        bin_.width_m = derived.width_m
        bin_.height_m = derived.height_m
        bin_.depth_m = derived.depth_m
        bin_.rotation_deg = derived.rotation_deg
        bin_.capacity_m3 = derived.capacity_m3
        bin_.max_weight_kg = derived.max_weight_kg
        kept_bins.add(derived.code)

    session.flush()

    orphaned: list[dict[str, Any]] = []
    for code, bin_ in existing_bins.items():
        if code in kept_bins:
            continue
        # The bin no longer exists in the layout, so its placements cannot point
        # anywhere. They are reported before the cascade removes them — flagged,
        # never silently discarded (§1 row 14). Re-mapping arrives in Phase 8.
        for placement in bin_.placements:
            orphaned.append(
                {
                    "binCode": code,
                    "skuId": str(placement.sku_id),
                    "qty": placement.qty,
                    "volumeUsedM3": placement.volume_used_m3,
                    "weightUsedKg": placement.weight_used_kg,
                }
            )
        session.delete(bin_)

    session.flush()

    # Now the structural removals, child-first, so each cascade has nothing left to
    # do and no row is deleted twice.
    for bay in stale_bays:
        session.delete(bay)
    for lane in stale_lanes:
        session.delete(lane)
    for aisle in stale_aisles:
        session.delete(aisle)

    session.flush()
    return orphaned


def _rack_type_code(graph: LayoutGraph, rack_type_id: str | None) -> str | None:
    if rack_type_id is None:
        return None
    for rack_type in graph.doc.get("rackTypes", []):
        if rack_type.get("id") == rack_type_id:
            return rack_type.get("code")
    return None
