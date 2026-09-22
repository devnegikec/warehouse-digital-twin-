"""Persistence tests: draft autosave, the publish transaction, version history.

These are the only tests that need a database. They are skipped rather than failed
when Postgres is unreachable, so `pytest` still runs on a machine without Docker —
but they are *not* optional in `npm run verify`, which brings the database up first.

Everything runs inside an outer transaction that is rolled back afterwards, so the
tests never depend on, or disturb, whatever is in the development database. Each
route commits internally, so the session is bound with ``create_savepoint``: a route's
``commit()`` releases a savepoint inside our transaction rather than ending it. That
also lets the tests assert against the same session the routes used — a second session
would not see uncommitted rows.
"""

from __future__ import annotations

import copy
import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any
from uuid import UUID

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func, select, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session

from app.config import settings
from app.db import get_session
from app.layout import build_layout
from app.main import app
from app.models import Base, Bin, LayoutVersion, Warehouse

FIXTURES_DIR = Path(__file__).resolve().parents[2] / "fixtures" / "layout-conformance"


def _fixture(name: str) -> dict[str, Any]:
    return json.loads((FIXTURES_DIR / name).read_text(encoding="utf-8"))


BASE_DOC: dict[str, Any] = _fixture("001_single_aisle_left.json")["doc"]


def make_doc(code: str = "WH-TEST") -> dict[str, Any]:
    """The fixture document, re-coded to the warehouse under test.

    The warehouse code is part of every bin code and of the document hash, so the
    tests build the document and derive their expectations from it rather than
    hard-coding the fixture's own code and hash.
    """
    doc = copy.deepcopy(BASE_DOC)
    doc["warehouse"]["code"] = code
    return doc


def doc_hash(doc: dict[str, Any]) -> str:
    return build_layout(doc).hash


def expected_bins(doc: dict[str, Any]) -> dict[str, Any]:
    return {bin_.code: bin_ for bin_ in build_layout(doc).bins}


# --- Fixtures ----------------------------------------------------------------


@pytest.fixture(scope="session")
def engine() -> Engine:
    created = create_engine(settings.database_url, pool_pre_ping=True, future=True)
    try:
        with created.connect() as connection:
            connection.execute(text("SELECT 1"))
    except Exception:  # noqa: BLE001 — any connection failure means "no database here"
        pytest.skip(
            "Postgres is not reachable; start it with `npm run db:up` to run persistence tests"
        )

    # Safety net: the migrations normally own the schema, but a database left at
    # `base` by an interrupted downgrade should not produce confusing failures.
    Base.metadata.create_all(created)
    return created


@pytest.fixture
def db(engine: Engine) -> Iterator[Session]:
    connection = engine.connect()
    transaction = connection.begin()
    session = Session(bind=connection, join_transaction_mode="create_savepoint")
    try:
        yield session
    finally:
        session.close()
        transaction.rollback()
        connection.close()


@pytest.fixture
def client(db: Session) -> Iterator[TestClient]:
    def override() -> Iterator[Session]:
        yield db

    app.dependency_overrides[get_session] = override
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()


def create_warehouse(client: TestClient, code: str = "WH-TEST", **overrides: Any) -> dict[str, Any]:
    doc = overrides.pop("doc", None) or make_doc(code)
    payload: dict[str, Any] = {
        "code": code,
        "name": "Test warehouse",
        "lengthM": 40,
        "widthM": 20,
        "heightM": 8,
        "doc": doc,
    }
    payload.update(overrides)
    response = client.post("/api/warehouses", json=payload)
    assert response.status_code == 201, response.text
    return {"body": response.json(), "doc": doc, "id": response.json()["id"]}


def bins_for(db: Session, warehouse_id: str) -> list[Bin]:
    return list(db.scalars(select(Bin).where(Bin.warehouse_id == UUID(warehouse_id))).all())


# --- Creation and reading ----------------------------------------------------


def test_create_returns_a_warehouse_with_its_footprint_and_first_draft(
    client: TestClient,
) -> None:
    created = create_warehouse(client)
    body = created["body"]

    assert body["code"] == "WH-TEST"
    assert body["lengthM"] == 40
    assert body["draftRevision"] == 0
    assert body["draft"] is not None
    assert body["draft"]["version"] == 1
    assert body["draft"]["status"] == "DRAFT"
    assert body["draft"]["docHash"] == doc_hash(created["doc"])
    assert body["published"] is None


def test_a_duplicate_code_is_refused(client: TestClient) -> None:
    create_warehouse(client, code="WH-DUP")
    response = client.post(
        "/api/warehouses",
        json={"code": "WH-DUP", "lengthM": 10, "widthM": 10, "heightM": 5},
    )
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "WAREHOUSE_CODE_TAKEN"


def test_a_document_whose_code_is_taken_is_refused_as_a_conflict_not_a_crash(
    client: TestClient,
) -> None:
    """The document's code is what gets inserted, so that is what must be checked.

    Checking the payload's code instead (as an earlier version did) let a document
    whose warehouse code disagreed with the request reach the unique constraint and
    surface as a 500 — which is both wrong and untraceable for a client.
    """
    create_warehouse(client, code="WH-TAKEN")

    # Payload claims a free code, the document carries the taken one.
    response = client.post(
        "/api/warehouses",
        json={
            "code": "WH-FREE",
            "lengthM": 40,
            "widthM": 20,
            "heightM": 8,
            "doc": make_doc("WH-TAKEN"),
        },
    )

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "WAREHOUSE_CODE_TAKEN"


def test_creating_without_a_document_builds_an_empty_publishable_layout(
    client: TestClient,
) -> None:
    response = client.post(
        "/api/warehouses",
        json={"code": "WH-BLANK", "name": "Blank", "lengthM": 30, "widthM": 15, "heightM": 6},
    )
    assert response.status_code == 201
    warehouse_id = response.json()["id"]

    detail = client.get(f"/api/warehouses/{warehouse_id}").json()
    assert detail["draft"] is not None
    assert detail["draft"]["docHash"]

    # An empty layout must be publishable: starting a warehouse should not require
    # having already designed one.
    publish = client.post(
        f"/api/warehouses/{warehouse_id}/publish",
        json={
            "doc": {
                "schemaVersion": 1,
                "warehouse": {"code": "WH-BLANK", "lengthM": 30, "widthM": 15, "heightM": 6},
                "aisles": [],
            }
        },
    )
    assert publish.status_code == 200, publish.text
    assert publish.json()["binCount"] == 0


def test_a_missing_warehouse_is_a_404_not_a_500(client: TestClient) -> None:
    response = client.get("/api/warehouses/00000000-0000-0000-0000-000000000000")
    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "WAREHOUSE_NOT_FOUND"


def test_list_includes_what_was_created(client: TestClient) -> None:
    create_warehouse(client, code="WH-LIST")
    response = client.get("/api/warehouses")
    assert response.status_code == 200
    assert "WH-LIST" in {item["code"] for item in response.json()}


# --- Draft autosave ----------------------------------------------------------


def test_draft_save_advances_the_revision(client: TestClient) -> None:
    created = create_warehouse(client)

    response = client.put(
        f"/api/warehouses/{created['id']}/draft",
        json={"doc": created["doc"], "clientDocHash": doc_hash(created["doc"])},
        headers={"If-Match": str(created["body"]["draftRevision"])},
    )

    assert response.status_code == 200, response.text
    saved = response.json()
    assert saved["docHash"] == doc_hash(created["doc"])
    assert saved["publishable"] is True
    assert saved["draftRevision"] == created["body"]["draftRevision"] + 1


def test_a_stale_revision_is_refused_rather_than_overwritten(client: TestClient) -> None:
    created = create_warehouse(client)
    stale = created["body"]["draftRevision"]

    first = client.put(
        f"/api/warehouses/{created['id']}/draft",
        json={"doc": created["doc"]},
        headers={"If-Match": str(stale)},
    )
    assert first.status_code == 200

    # A second editor still holding the old token must be told, not believed.
    second = client.put(
        f"/api/warehouses/{created['id']}/draft",
        json={"doc": created["doc"]},
        headers={"If-Match": str(stale)},
    )

    assert second.status_code == 409
    detail = second.json()["detail"]
    assert detail["code"] == "STALE_DRAFT"
    assert detail["expectedRevision"] == stale
    assert detail["actualRevision"] == stale + 1


def test_draft_save_without_if_match_is_refused(client: TestClient) -> None:
    created = create_warehouse(client)

    response = client.put(f"/api/warehouses/{created['id']}/draft", json={"doc": created["doc"]})

    assert response.status_code == 428
    assert response.json()["detail"]["code"] == "PRECONDITION_REQUIRED"


def test_a_wildcard_if_match_is_not_accepted(client: TestClient) -> None:
    created = create_warehouse(client)

    response = client.put(
        f"/api/warehouses/{created['id']}/draft",
        json={"doc": created["doc"]},
        headers={"If-Match": "*"},
    )

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "INVALID_IF_MATCH"


def test_a_quoted_if_match_is_accepted(client: TestClient) -> None:
    """ETags are quoted; a client that sets the header properly must not be punished."""
    created = create_warehouse(client)

    response = client.put(
        f"/api/warehouses/{created['id']}/draft",
        json={"doc": created["doc"]},
        headers={"If-Match": f'"{created["body"]["draftRevision"]}"'},
    )
    assert response.status_code == 200


def test_a_non_numeric_if_match_is_refused(client: TestClient) -> None:
    created = create_warehouse(client)

    response = client.put(
        f"/api/warehouses/{created['id']}/draft",
        json={"doc": created["doc"]},
        headers={"If-Match": "etag-please"},
    )

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "INVALID_IF_MATCH"


def test_draft_save_refuses_compiler_drift(client: TestClient) -> None:
    created = create_warehouse(client)

    response = client.put(
        f"/api/warehouses/{created['id']}/draft",
        json={"doc": created["doc"], "clientDocHash": "0" * 64},
        headers={"If-Match": str(created["body"]["draftRevision"])},
    )

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "COMPILER_DRIFT"


def test_an_invalid_document_is_refused_and_nothing_is_written(client: TestClient) -> None:
    created = create_warehouse(client)
    broken = copy.deepcopy(created["doc"])
    del broken["warehouse"]["heightM"]

    response = client.put(
        f"/api/warehouses/{created['id']}/draft",
        json={"doc": broken},
        headers={"If-Match": str(created["body"]["draftRevision"])},
    )

    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "DOCUMENT_INVALID"

    # A refused write is not a write: the token must not have moved.
    detail = client.get(f"/api/warehouses/{created['id']}").json()
    assert detail["draftRevision"] == created["body"]["draftRevision"]


def test_discarding_a_draft_keeps_the_warehouse_and_moves_the_token(client: TestClient) -> None:
    created = create_warehouse(client)

    response = client.delete(
        f"/api/warehouses/{created['id']}/draft",
        headers={"If-Match": str(created["body"]["draftRevision"])},
    )
    assert response.status_code == 204

    detail = client.get(f"/api/warehouses/{created['id']}").json()
    assert detail["draft"] is None
    assert detail["draftRevision"] == created["body"]["draftRevision"] + 1


# --- Publish -----------------------------------------------------------------


def test_publish_materialises_bins_matching_the_compiler_one_to_one(
    client: TestClient, db: Session
) -> None:
    """The bin table is a faithful projection of the compiler's output (P2, P5).

    The Python compiler is the mirror pinned to TypeScript by the conformance
    fixtures, so matching it is matching what the editor showed the user.
    """
    created = create_warehouse(client, code="WH-PUB")
    derived = expected_bins(created["doc"])

    response = client.post(
        f"/api/warehouses/{created['id']}/publish",
        json={"doc": created["doc"], "clientDocHash": doc_hash(created["doc"])},
    )
    assert response.status_code == 200, response.text
    assert response.json()["changed"] is True
    assert response.json()["binCount"] == len(derived)

    rows = bins_for(db, created["id"])
    assert {row.code for row in rows} == set(derived)
    for row in rows:
        source = derived[row.code]
        assert row.center_x == source.center["x"]
        assert row.center_y == source.center["y"]
        assert row.center_z == source.center["z"]
        assert row.capacity_m3 == source.capacity_m3
        assert row.level_index == source.level_index
        assert row.max_weight_kg == source.max_weight_kg


def test_publishing_an_unchanged_document_is_a_no_op(client: TestClient) -> None:
    created = create_warehouse(client, code="WH-IDEMP")

    first = client.post(f"/api/warehouses/{created['id']}/publish", json={"doc": created["doc"]})
    assert first.status_code == 200
    assert first.json()["changed"] is True

    second = client.post(f"/api/warehouses/{created['id']}/publish", json={"doc": created["doc"]})
    assert second.status_code == 200
    assert second.json()["changed"] is False
    assert second.json()["version"] == first.json()["version"]

    versions = client.get(f"/api/warehouses/{created['id']}/versions").json()
    published = [item for item in versions if item["status"] == "PUBLISHED"]
    assert len(published) == 1, "an idempotent re-publish must not add a version"


def test_publishing_blocks_on_errors_and_says_which_ones(client: TestClient) -> None:
    created = create_warehouse(client, code="WH-BLOCK")

    broken = copy.deepcopy(created["doc"])
    broken["warehouse"]["lengthM"] = 5  # the lane still runs its full length

    response = client.post(f"/api/warehouses/{created['id']}/publish", json={"doc": broken})

    assert response.status_code == 422
    detail = response.json()["detail"]
    assert detail["code"] == "LAYOUT_NOT_PUBLISHABLE"
    assert detail["diagnostics"], "the refusal must carry the diagnostics that caused it"
    assert any(item["severity"] == "error" for item in detail["diagnostics"])

    # And nothing was published.
    assert client.get(f"/api/warehouses/{created['id']}/layout").status_code == 404


def test_publishing_becomes_possible_once_the_error_is_fixed(client: TestClient) -> None:
    """The publish DoD, end to end: blocked, then unblocked by one real change."""
    created = create_warehouse(client, code="WH-FIX")

    too_small = copy.deepcopy(created["doc"])
    too_small["warehouse"]["lengthM"] = 5
    blocked = client.post(f"/api/warehouses/{created['id']}/publish", json={"doc": too_small})
    assert blocked.status_code == 422

    fixed = copy.deepcopy(created["doc"])
    fixed["warehouse"]["lengthM"] = 40
    response = client.post(f"/api/warehouses/{created['id']}/publish", json={"doc": fixed})

    assert response.status_code == 200, response.text
    assert response.json()["changed"] is True
    assert client.get(f"/api/warehouses/{created['id']}/layout").status_code == 200


def test_warnings_do_not_block_a_publish(client: TestClient) -> None:
    created = create_warehouse(client, code="WH-WARN")

    short = copy.deepcopy(created["doc"])
    short["aisles"][0]["lanes"][0]["lengthM"] = 1  # shorter than one bay: LANE_ZERO_BAYS

    response = client.post(f"/api/warehouses/{created['id']}/publish", json={"doc": short})

    assert response.status_code == 200, response.text
    assert response.json()["warningCount"] > 0


def test_publish_refuses_compiler_drift(client: TestClient) -> None:
    created = create_warehouse(client, code="WH-DRIFT")

    response = client.post(
        f"/api/warehouses/{created['id']}/publish",
        json={"doc": created["doc"], "clientDocHash": "0" * 64},
    )

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "COMPILER_DRIFT"


def test_republishing_a_changed_layout_archives_the_previous_version_and_keeps_bin_ids(
    client: TestClient, db: Session
) -> None:
    """Bins are upserted by code, not recreated — that is what keeps placements attached."""
    created = create_warehouse(client, code="WH-SURV")

    first = client.post(f"/api/warehouses/{created['id']}/publish", json={"doc": created["doc"]})
    assert first.status_code == 200
    ids_before = {row.code: row.id for row in bins_for(db, created["id"])}
    assert ids_before, "expected the first publish to create bins"

    # Move the aisle: the bins change position but keep their codes.
    moved = copy.deepcopy(created["doc"])
    moved["aisles"][0]["centerline"]["z1"] += 2
    moved["aisles"][0]["centerline"]["z2"] += 2

    second = client.post(f"/api/warehouses/{created['id']}/publish", json={"doc": moved})
    assert second.status_code == 200, second.text
    assert second.json()["changed"] is True

    versions = client.get(f"/api/warehouses/{created['id']}/versions").json()
    counts: dict[str, int] = {}
    for item in versions:
        counts[item["status"]] = counts.get(item["status"], 0) + 1
    assert counts["PUBLISHED"] == 1, "exactly one published version may exist"
    assert counts["ARCHIVED"] == 1

    ids_after = {row.code: row.id for row in bins_for(db, created["id"])}
    assert ids_after == ids_before


def test_removing_a_lane_removes_its_bins(client: TestClient, db: Session) -> None:
    created = create_warehouse(client, code="WH-SHRINK")

    client.post(f"/api/warehouses/{created['id']}/publish", json={"doc": created["doc"]})
    assert bins_for(db, created["id"])

    without_lanes = copy.deepcopy(created["doc"])
    without_lanes["aisles"][0]["lanes"] = []

    response = client.post(f"/api/warehouses/{created['id']}/publish", json={"doc": without_lanes})
    assert response.status_code == 200, response.text
    assert response.json()["binCount"] == 0
    assert bins_for(db, created["id"]) == []


def test_a_lane_turned_into_one_gap_stops_producing_bins(client: TestClient, db: Session) -> None:
    """Run editing reaches the database, not just the 3D view."""
    created = create_warehouse(client, code="WH-GAP")

    client.post(f"/api/warehouses/{created['id']}/publish", json={"doc": created["doc"]})
    assert bins_for(db, created["id"])

    gapped = copy.deepcopy(created["doc"])
    lane = gapped["aisles"][0]["lanes"][0]
    lane["segments"] = [{"kind": "GAP", "startM": 0, "endM": lane["lengthM"]}]

    response = client.post(f"/api/warehouses/{created['id']}/publish", json={"doc": gapped})

    assert response.status_code == 200, response.text
    assert response.json()["binCount"] == 0
    assert bins_for(db, created["id"]) == []


def test_a_bin_count_shrinks_with_the_level_count(client: TestClient, db: Session) -> None:
    created = create_warehouse(client, code="WH-COUNT")

    trimmed = copy.deepcopy(created["doc"])
    levels = trimmed["aisles"][0]["lanes"][0]["levels"]
    trimmed["aisles"][0]["lanes"][0]["levels"] = levels[:2]

    response = client.post(f"/api/warehouses/{created['id']}/publish", json={"doc": trimmed})
    assert response.status_code == 200, response.text

    stored = db.scalar(
        select(func.count()).select_from(Bin).where(Bin.warehouse_id == UUID(created["id"]))
    )
    assert stored == response.json()["binCount"]
    assert stored == len(build_layout(trimmed).bins)


# --- Version history and the published layout --------------------------------


def test_versions_are_listed_newest_first_with_their_hashes(client: TestClient) -> None:
    created = create_warehouse(client, code="WH-VER")
    client.post(f"/api/warehouses/{created['id']}/publish", json={"doc": created["doc"]})

    versions = client.get(f"/api/warehouses/{created['id']}/versions").json()

    assert [item["version"] for item in versions] == sorted(
        (item["version"] for item in versions), reverse=True
    )
    published = next(item for item in versions if item["status"] == "PUBLISHED")
    assert published["docHash"] == doc_hash(created["doc"])
    assert published["publishedAt"] is not None
    # Publishing supersedes the draft, leaving one row rather than two copies of the
    # same document.
    assert all(item["status"] != "DRAFT" for item in versions)


def test_the_published_layout_serves_materialised_bins_with_ids(client: TestClient) -> None:
    created = create_warehouse(client, code="WH-LAYOUT")
    client.post(f"/api/warehouses/{created['id']}/publish", json={"doc": created["doc"]})

    response = client.get(f"/api/warehouses/{created['id']}/layout")
    assert response.status_code == 200, response.text

    body = response.json()
    assert body["version"] == 1
    assert body["docHash"] == doc_hash(created["doc"])
    # The stored document still compiles to the hash it was published with.
    assert body["recompiledDocHash"] == body["docHash"]
    assert body["conflicts"] == []
    assert {item["code"] for item in body["bins"]} == set(expected_bins(created["doc"]))
    # Ids matter: placements reference them.
    assert all(item["id"] for item in body["bins"])


def test_the_published_layout_is_a_404_before_the_first_publish(client: TestClient) -> None:
    created = create_warehouse(client, code="WH-UNPUB")

    response = client.get(f"/api/warehouses/{created['id']}/layout")

    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "NO_PUBLISHED_LAYOUT"


def test_a_draft_never_becomes_the_published_layout(client: TestClient) -> None:
    """Autosaving must not leak into Operate mode."""
    created = create_warehouse(client, code="WH-DRAFTONLY")

    saved = client.put(
        f"/api/warehouses/{created['id']}/draft",
        json={"doc": created["doc"]},
        headers={"If-Match": "0"},
    )
    assert saved.status_code == 200

    assert client.get(f"/api/warehouses/{created['id']}/layout").status_code == 404

    detail = client.get(f"/api/warehouses/{created['id']}").json()
    assert detail["draft"] is not None
    assert detail["published"] is None


def test_a_published_version_row_records_the_document(client: TestClient, db: Session) -> None:
    created = create_warehouse(client, code="WH-ROW")
    client.post(f"/api/warehouses/{created['id']}/publish", json={"doc": created["doc"]})

    published = db.scalars(
        select(LayoutVersion).where(
            LayoutVersion.warehouse_id == UUID(created["id"]),
            LayoutVersion.status == "PUBLISHED",
        )
    ).one()

    assert published.doc["warehouse"]["code"] == "WH-ROW"
    assert published.doc_hash == doc_hash(created["doc"])
    assert published.published_at is not None


def test_the_warehouse_row_is_a_projection_of_the_document(client: TestClient, db: Session) -> None:
    """The footprint columns are a denormalised cache, so an accepted write refreshes them."""
    created = create_warehouse(client, code="WH-FOOT")

    larger = copy.deepcopy(created["doc"])
    larger["warehouse"]["lengthM"] = 60
    larger["warehouse"]["name"] = "Enlarged"

    response = client.put(
        f"/api/warehouses/{created['id']}/draft",
        json={"doc": larger},
        headers={"If-Match": "0"},
    )
    assert response.status_code == 200, response.text

    row = db.scalars(select(Warehouse).where(Warehouse.code == "WH-FOOT")).one()
    assert row.length_m == 60
    assert row.name == "Enlarged"
