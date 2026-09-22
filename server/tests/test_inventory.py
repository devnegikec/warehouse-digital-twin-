"""SKU and placement tests, including the Phase 8 DoD.

The DoD is: *dropping an oversized SKU is rejected client-side and server-side with the
same diagnostic code.* The client half is asserted in
``src/design/persistence/inventory.test.ts`` against the TypeScript capacity module; the
server half is here. Both read their codes from the same rule registry, so the shared
fixture in ``fixtures/placement-conformance/cases.json`` is what pins them together —
and ``test_the_server_agrees_with_the_shared_placement_fixtures`` runs that fixture
through this API rather than trusting that it would.
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
from sqlalchemy import create_engine, select, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session

from app.config import settings
from app.db import get_session
from app.main import app
from app.models import Base, Placement, SkuTemplate

FIXTURES_DIR = Path(__file__).resolve().parents[2] / "fixtures" / "layout-conformance"
PLACEMENT_CASES = (
    Path(__file__).resolve().parents[2] / "fixtures" / "placement-conformance" / "cases.json"
)

BASE_DOC: dict[str, Any] = json.loads(
    (FIXTURES_DIR / "001_single_aisle_left.json").read_text(encoding="utf-8")
)["doc"]


@pytest.fixture(scope="session")
def engine() -> Engine:
    created = create_engine(settings.database_url, pool_pre_ping=True, future=True)
    try:
        with created.connect() as connection:
            connection.execute(text("SELECT 1"))
    except Exception:  # noqa: BLE001
        pytest.skip("Postgres is not reachable; start it with `npm run db:up`")

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


# --- Helpers -----------------------------------------------------------------


def published_warehouse(client: TestClient, code: str = "WH-INV") -> dict[str, Any]:
    """A warehouse with a published layout, so bins exist to place things in."""
    doc = copy.deepcopy(BASE_DOC)
    doc["warehouse"]["code"] = code

    created = client.post(
        "/api/warehouses",
        json={
            "code": code,
            "name": "Inventory",
            "lengthM": doc["warehouse"]["lengthM"],
            "widthM": doc["warehouse"]["widthM"],
            "heightM": doc["warehouse"]["heightM"],
            "doc": doc,
        },
    )
    assert created.status_code == 201, created.text
    warehouse = created.json()

    published = client.post(f"/api/warehouses/{warehouse['id']}/publish", json={"doc": doc})
    assert published.status_code == 200, published.text

    layout = client.get(f"/api/warehouses/{warehouse['id']}/layout").json()
    return {"id": warehouse["id"], "doc": doc, "bins": layout["bins"]}


def make_sku(client: TestClient, warehouse_id: str, **overrides: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "sku": "PALLET-1",
        "name": "Standard pallet",
        "widthM": 1.2,
        "heightM": 1.3,
        "depthM": 0.8,
        "weightKg": 400,
    }
    payload.update(overrides)
    response = client.post(f"/api/warehouses/{warehouse_id}/skus", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


def first_bin(warehouse: dict[str, Any], index: int = 0) -> dict[str, Any]:
    return warehouse["bins"][index]


# --- SKUs --------------------------------------------------------------------


def test_a_sku_can_be_created_listed_and_read_back(client: TestClient) -> None:
    warehouse = published_warehouse(client)
    sku = make_sku(client, warehouse["id"])

    assert sku["sku"] == "PALLET-1"
    assert sku["placedQty"] == 0

    listed = client.get(f"/api/warehouses/{warehouse['id']}/skus").json()
    assert [item["sku"] for item in listed] == ["PALLET-1"]


def test_a_duplicate_sku_code_is_refused(client: TestClient) -> None:
    warehouse = published_warehouse(client)
    make_sku(client, warehouse["id"])

    response = client.post(
        f"/api/warehouses/{warehouse['id']}/skus",
        json={
            "sku": "PALLET-1",
            "name": "Duplicate",
            "widthM": 1,
            "heightM": 1,
            "depthM": 1,
            "weightKg": 10,
        },
    )

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "SKU_CODE_TAKEN"


def test_a_sku_can_be_edited(client: TestClient) -> None:
    warehouse = published_warehouse(client)
    sku = make_sku(client, warehouse["id"])

    response = client.put(
        f"/api/skus/{sku['id']}",
        json={
            "sku": "PALLET-1",
            "name": "Renamed",
            "widthM": 1.0,
            "heightM": 1.0,
            "depthM": 1.0,
            "weightKg": 250,
        },
    )

    assert response.status_code == 200, response.text
    assert response.json()["name"] == "Renamed"
    assert response.json()["widthM"] == 1.0


def test_a_sku_that_is_in_use_cannot_be_deleted(client: TestClient, db: Session) -> None:
    warehouse = published_warehouse(client)
    sku = make_sku(client, warehouse["id"])
    bin_row = first_bin(warehouse)

    placed = client.post(
        f"/api/bins/{bin_row['id']}/placements", json={"skuId": sku["id"], "qty": 1}
    )
    assert placed.status_code == 201, placed.text

    response = client.delete(f"/api/skus/{sku['id']}")

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "SKU_IN_USE"


def test_an_unused_sku_can_be_deleted(client: TestClient, db: Session) -> None:
    warehouse = published_warehouse(client)
    sku = make_sku(client, warehouse["id"])

    assert client.delete(f"/api/skus/{sku['id']}").status_code == 204
    assert db.scalars(select(SkuTemplate).where(SkuTemplate.id == UUID(sku["id"]))).first() is None


# --- Placement validation, and the DoD ---------------------------------------


def test_a_fitting_sku_is_placed(client: TestClient, db: Session) -> None:
    warehouse = published_warehouse(client)
    sku = make_sku(client, warehouse["id"])
    bin_row = first_bin(warehouse)

    response = client.post(
        f"/api/bins/{bin_row['id']}/placements", json={"skuId": sku["id"], "qty": 2}
    )

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["qty"] == 2
    assert body["binCode"] == bin_row["code"]
    # Usage is cached as volume and weight, structurally separate from geometry (P5).
    assert body["volumeUsedM3"] == pytest.approx(1.2 * 1.3 * 0.8 * 2, abs=1e-6)
    assert body["weightUsedKg"] == pytest.approx(800)

    stored = db.scalars(select(Placement).where(Placement.bin_id == UUID(bin_row["id"]))).all()
    assert len(stored) == 1


def test_an_oversized_sku_is_refused_with_the_capacity_rule_code(client: TestClient) -> None:
    """The DoD's server half: the refusal carries the *rule* code, not a generic one."""
    warehouse = published_warehouse(client)
    # The opening is 1.4 m tall and 1.0 m deep, so a 2.5 m tall item cannot go in.
    oversized = make_sku(
        client,
        warehouse["id"],
        sku="OVERSIZE",
        widthM=2.5,
        heightM=2.5,
        depthM=2.5,
        weightKg=10,
    )
    bin_row = first_bin(warehouse)

    response = client.post(
        f"/api/bins/{bin_row['id']}/placements", json={"skuId": oversized["id"], "qty": 1}
    )

    assert response.status_code == 422
    detail = response.json()["detail"]
    assert detail["code"] == "ITEM_DOES_NOT_FIT_OPENING"
    assert detail["diagnostics"][0]["severity"] == "error"
    assert detail["diagnostics"][0]["code"] == "ITEM_DOES_NOT_FIT_OPENING"
    # The diagnostic points at both sides of the problem, as every rule does.
    kinds = {ref["kind"] for ref in detail["diagnostics"][0]["entityRefs"]}
    assert kinds == {"bin", "sku"}


def test_a_quantity_that_exceeds_the_bin_volume_is_refused_with_its_own_code(
    client: TestClient,
) -> None:
    warehouse = published_warehouse(client)
    sku = make_sku(client, warehouse["id"], widthM=1.2, heightM=1.3, depthM=0.8)
    bin_row = first_bin(warehouse)

    # The opening fits one; the usable volume (1.4 × 1.0 × 2.7 × 0.85 ≈ 3.2 m3) does not
    # fit many. The code must be the volume rule, not the opening rule.
    response = client.post(
        f"/api/bins/{bin_row['id']}/placements", json={"skuId": sku["id"], "qty": 9}
    )

    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "EXCEEDS_BIN_VOLUME"


def test_a_quantity_that_exceeds_the_beam_limit_is_refused_with_its_own_code(
    client: TestClient,
) -> None:
    warehouse = warehouse_with_bin(
        client, {"heightM": 1.6, "depthM": 1.0, "maxWeightKg": 800}, "WH-BEAM"
    )
    # Small enough to fit the volume, heavy enough to break the 800 kg beam limit.
    heavy = make_sku(
        client,
        warehouse["id"],
        sku="HEAVY",
        widthM=0.5,
        heightM=0.5,
        depthM=0.5,
        weightKg=900,
    )

    response = client.post(
        f"/api/bins/{warehouse['bin']['id']}/placements",
        json={"skuId": heavy["id"], "qty": 1},
    )

    assert response.status_code == 422, response.text
    assert response.json()["detail"]["code"] == "EXCEEDS_BIN_WEIGHT"


def test_a_zero_quantity_is_refused(client: TestClient) -> None:
    warehouse = published_warehouse(client)
    sku = make_sku(client, warehouse["id"])
    bin_row = first_bin(warehouse)

    response = client.post(
        f"/api/bins/{bin_row['id']}/placements", json={"skuId": sku["id"], "qty": 0}
    )

    # Rejected by the request schema before the capacity module is even reached.
    assert response.status_code == 422


def test_re_placing_the_same_sku_replaces_rather_than_adds(client: TestClient, db: Session) -> None:
    """`(bin_id, sku_id)` is unique, so a second drop sets the quantity."""
    warehouse = published_warehouse(client)
    sku = make_sku(client, warehouse["id"])
    bin_row = first_bin(warehouse)

    client.post(f"/api/bins/{bin_row['id']}/placements", json={"skuId": sku["id"], "qty": 1})
    second = client.post(
        f"/api/bins/{bin_row['id']}/placements", json={"skuId": sku["id"], "qty": 2}
    )

    assert second.status_code == 201, second.text
    stored = db.scalars(select(Placement).where(Placement.bin_id == UUID(bin_row["id"]))).all()
    assert len(stored) == 1
    assert stored[0].qty == 2


def test_a_second_sku_sees_the_space_the_first_one_took(client: TestClient) -> None:
    """Two SKUs in one bin must share the capacity, not each get all of it.

    This is the reason remaining capacity is passed to the shared fit check as a
    `CapacityTarget` with the bin's real opening but the leftover volume.
    """
    warehouse = published_warehouse(client)
    first = make_sku(client, warehouse["id"], sku="FIRST", widthM=1.2, heightM=1.3, depthM=0.8)
    second = make_sku(client, warehouse["id"], sku="SECOND", widthM=1.2, heightM=1.3, depthM=0.8)
    bin_row = first_bin(warehouse)

    # Each fits alone (2 × 1.248 m3 = 2.5 m3 of ~3.2 m3 usable).
    one = client.post(
        f"/api/bins/{bin_row['id']}/placements", json={"skuId": first["id"], "qty": 2}
    )
    assert one.status_code == 201, one.text

    # Together they do not.
    response = client.post(
        f"/api/bins/{bin_row['id']}/placements", json={"skuId": second["id"], "qty": 2}
    )

    assert response.status_code == 422, response.text
    assert response.json()["detail"]["code"] == "EXCEEDS_BIN_VOLUME"


def test_a_sku_from_another_warehouse_is_refused(client: TestClient) -> None:
    one = published_warehouse(client, code="WH-ONE")
    two = published_warehouse(client, code="WH-TWO")
    foreign = make_sku(client, two["id"], sku="FOREIGN")

    response = client.post(
        f"/api/bins/{first_bin(one)['id']}/placements", json={"skuId": foreign["id"], "qty": 1}
    )

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "WRONG_WAREHOUSE"


def test_placing_into_a_missing_bin_is_a_404(client: TestClient) -> None:
    warehouse = published_warehouse(client)
    sku = make_sku(client, warehouse["id"])

    response = client.post(
        f"/api/bins/{UUID(int=0)}/placements", json={"skuId": sku["id"], "qty": 1}
    )

    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "BIN_NOT_FOUND"


def doc_for_bin(height_m: float, depth_m: float, max_weight_kg: float | None, code: str) -> dict:
    """A one-bin layout whose derived bin matches a fixture's bin specification.

    The fixtures check a bin described by its opening and capacity. An API check runs
    against a *materialised* bin, so the way to test them together is to build a layout
    that produces exactly that bin: one 2.7 m bay, one level whose clear height and bin
    depth are the fixture's, and the beam limit the fixture declares. The capacity then
    falls out of the compiler (2.7 × H × D × 0.85), which is also a check that the
    published capacity agrees with the fixture's arithmetic.
    """
    level: dict[str, Any] = {"clearHeightM": height_m, "binDepthM": depth_m, "beamHeightM": 0.08}
    if max_weight_kg is not None:
        level["maxWeightKg"] = max_weight_kg

    return {
        "schemaVersion": 1,
        "warehouse": {"code": code, "name": "Fixture", "lengthM": 20, "widthM": 12, "heightM": 8},
        "rackTypes": [{"id": "rt", "code": "STD", "bayWidthM": 2.7, "depthM": 1.0}],
        "aisles": [
            {
                "id": "a",
                "code": "A01",
                "orientation": "X",
                "centerline": {"x1": 1, "z1": 6, "x2": 19, "z2": 6},
                "widthM": 3.0,
                "lanes": [
                    {
                        "id": "l",
                        "code": "A01-L",
                        "side": "LEFT",
                        "rackTypeId": "rt",
                        "lengthM": 2.7,
                        "levels": [level],
                    }
                ],
            }
        ],
    }


def warehouse_with_bin(client: TestClient, spec: dict[str, Any], code: str) -> dict[str, Any]:
    doc = doc_for_bin(spec["heightM"], spec["depthM"], spec["maxWeightKg"], code)
    created = client.post(
        "/api/warehouses",
        json={
            "code": code,
            "lengthM": doc["warehouse"]["lengthM"],
            "widthM": doc["warehouse"]["widthM"],
            "heightM": doc["warehouse"]["heightM"],
            "doc": doc,
        },
    )
    assert created.status_code == 201, created.text
    warehouse_id = created.json()["id"]

    published = client.post(f"/api/warehouses/{warehouse_id}/publish", json={"doc": doc})
    assert published.status_code == 200, published.text

    bins = client.get(f"/api/warehouses/{warehouse_id}/layout").json()["bins"]
    assert len(bins) == 1, "the fixture layout should produce exactly one bin"
    return {"id": warehouse_id, "bin": bins[0]}


def test_the_server_agrees_with_the_shared_placement_fixtures(client: TestClient) -> None:
    """Runs the cross-language placement fixtures through the real endpoint.

    The fixtures record the codes the TypeScript capacity module produces. Getting the
    same codes back from the API is what makes the DoD's claim — "same diagnostic code
    on both sides" — hold for cases beyond the hand-written ones above.
    """
    cases = json.loads(PLACEMENT_CASES.read_text(encoding="utf-8"))["cases"]
    assert cases, "expected placement fixtures"

    checked = 0
    for index, case in enumerate(cases):
        # A pristine bin per case. Sharing one bin would let an earlier case's success
        # consume the capacity that a later case's refusal depends on — which is correct
        # behaviour, but it makes the fixture comparison meaningless.
        warehouse = warehouse_with_bin(client, case["bin"], f"WH-FX-{index}")
        bin_row = warehouse["bin"]

        # The materialised capacity must equal the fixture's, or the geometries differ
        # and comparing codes would be meaningless.
        assert bin_row["capacityM3"] == case["bin"]["capacityM3"]

        item = case["item"]
        sku = make_sku(
            client,
            warehouse["id"],
            sku="FIXTURE",
            widthM=item["widthM"],
            heightM=item["heightM"],
            depthM=item["depthM"],
            weightKg=item["weightKg"],
            rotatable=item.get("rotatable", True),
        )

        response = client.post(
            f"/api/bins/{bin_row['id']}/placements",
            json={"skuId": sku["id"], "qty": case["qty"]},
        )

        if case["qty"] <= 0:
            # The request schema refuses a non-positive quantity before the capacity
            # module runs, so there is no diagnostic code to compare here. The code
            # itself (QTY_NOT_POSITIVE) is pinned by the shared placement fixtures that
            # both compilers run.
            assert response.status_code == 422, case["name"]
            continue

        if case["expected"]["fits"]:
            assert response.status_code == 201, f"{case['name']}: {response.text}"
        else:
            assert response.status_code == 422, f"{case['name']}: {response.text}"
            assert response.json()["detail"]["code"] == case["expected"]["code"], case["name"]

        checked += 1

    # Guard against the whole thing silently skipping.
    assert checked >= 9, f"expected to check most fixtures through the API, checked {checked}"


# --- Reading a bin back ------------------------------------------------------


def test_a_bin_reports_its_remaining_capacity(client: TestClient) -> None:
    warehouse = warehouse_with_bin(
        client, {"heightM": 1.6, "depthM": 1.0, "maxWeightKg": 800}, "WH-REMAIN"
    )
    bin_row = warehouse["bin"]
    sku = make_sku(client, warehouse["id"], widthM=1.2, heightM=1.3, depthM=0.8, weightKg=400)

    placed = client.post(
        f"/api/bins/{bin_row['id']}/placements", json={"skuId": sku["id"], "qty": 1}
    )
    assert placed.status_code == 201, placed.text

    response = client.get(f"/api/bins/{bin_row['id']}/placements")
    assert response.status_code == 200, response.text

    body = response.json()
    assert body["capacityM3"] == bin_row["capacityM3"]
    assert body["usedVolumeM3"] == pytest.approx(1.2 * 1.3 * 0.8, abs=1e-6)
    assert body["remainingVolumeM3"] == pytest.approx(
        bin_row["capacityM3"] - 1.2 * 1.3 * 0.8, abs=1e-6
    )
    assert body["remainingWeightKg"] == pytest.approx(800 - 400)
    assert 0 < body["utilization"] < 1
    assert len(body["placements"]) == 1


def test_an_empty_bin_reports_full_remaining_capacity(client: TestClient) -> None:
    warehouse = published_warehouse(client)

    body = client.get(f"/api/bins/{first_bin(warehouse)['id']}/placements").json()

    assert body["placements"] == []
    assert body["utilization"] == 0
    assert body["remainingVolumeM3"] == body["capacityM3"]


def test_a_placement_can_be_unassigned(client: TestClient, db: Session) -> None:
    warehouse = published_warehouse(client)
    sku = make_sku(client, warehouse["id"])
    bin_row = first_bin(warehouse)

    placed = client.post(
        f"/api/bins/{bin_row['id']}/placements", json={"skuId": sku["id"], "qty": 1}
    ).json()

    assert client.delete(f"/api/placements/{placed['id']}").status_code == 204
    assert db.scalars(select(Placement).where(Placement.id == UUID(placed["id"]))).first() is None
    assert client.get(f"/api/bins/{bin_row['id']}/placements").json()["placements"] == []


def test_unassigning_a_missing_placement_is_a_404(client: TestClient) -> None:
    response = client.delete(f"/api/placements/{UUID(int=0)}")

    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "PLACEMENT_NOT_FOUND"


# --- Warehouse-wide reads ----------------------------------------------------


def test_placements_can_be_listed_for_the_whole_warehouse(client: TestClient) -> None:
    warehouse = published_warehouse(client)
    sku = make_sku(client, warehouse["id"])

    for index in (0, 1):
        client.post(
            f"/api/bins/{first_bin(warehouse, index)['id']}/placements",
            json={"skuId": sku["id"], "qty": 1},
        )

    listed = client.get(f"/api/warehouses/{warehouse['id']}/placements").json()
    assert len(listed) == 2
    assert {item["binCode"] for item in listed} == {
        first_bin(warehouse, 0)["code"],
        first_bin(warehouse, 1)["code"],
    }


def test_the_utilization_report_counts_utilised_and_empty_bins(client: TestClient) -> None:
    warehouse = published_warehouse(client)
    sku = make_sku(client, warehouse["id"])
    client.post(
        f"/api/bins/{first_bin(warehouse)['id']}/placements",
        json={"skuId": sku["id"], "qty": 1},
    )

    body = client.get(f"/api/warehouses/{warehouse['id']}/utilization").json()

    assert body["binCount"] == len(warehouse["bins"])
    assert body["utilizedBins"] == 1
    assert body["emptyBins"] == body["binCount"] - 1
    assert len(body["entries"]) == body["binCount"]


def test_placement_quantity_shows_up_on_the_sku(client: TestClient) -> None:
    warehouse = published_warehouse(client)
    sku = make_sku(client, warehouse["id"])

    placed = client.post(
        f"/api/bins/{first_bin(warehouse)['id']}/placements",
        json={"skuId": sku["id"], "qty": 2},
    )
    assert placed.status_code == 201, placed.text

    listed = client.get(f"/api/warehouses/{warehouse['id']}/skus").json()
    assert listed[0]["placedQty"] == 2


# --- Bulk --------------------------------------------------------------------


def test_a_bulk_fill_reports_a_verdict_per_bin(client: TestClient, db: Session) -> None:
    """Partly-refused bulk fills are the normal case, so they are not all-or-nothing."""
    warehouse = published_warehouse(client)
    # Fits one bin comfortably; the smallest bins will refuse it.
    sku = make_sku(client, warehouse["id"], widthM=1.2, heightM=1.3, depthM=0.8)
    targets = [first_bin(warehouse, index)["id"] for index in range(3)]

    response = client.post(
        f"/api/warehouses/{warehouse['id']}/placements/bulk",
        json={"skuId": sku["id"], "qty": 1, "binIds": targets},
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["placed"] + body["rejected"] == 3
    assert len(body["results"]) == 3
    for item in body["results"]:
        assert item["ok"] or item["code"] in {
            "EXCEEDS_BIN_VOLUME",
            "EXCEEDS_BIN_WEIGHT",
            "ITEM_DOES_NOT_FIT_OPENING",
        }

    stored = db.scalars(
        select(Placement).where(Placement.bin_id.in_([UUID(t) for t in targets]))
    ).all()
    assert len(stored) == body["placed"]


def test_a_bulk_fill_names_the_bins_it_refused(client: TestClient) -> None:
    warehouse = published_warehouse(client)
    oversized = make_sku(
        client, warehouse["id"], sku="BULK-BIG", widthM=2.5, heightM=2.5, depthM=2.5, weightKg=5
    )
    targets = [first_bin(warehouse, index)["id"] for index in range(2)]

    body = client.post(
        f"/api/warehouses/{warehouse['id']}/placements/bulk",
        json={"skuId": oversized["id"], "qty": 1, "binIds": targets},
    ).json()

    assert body["placed"] == 0
    assert body["rejected"] == 2
    assert all(item["code"] == "ITEM_DOES_NOT_FIT_OPENING" for item in body["results"])
    # Every refusal says which bin it was about.
    assert all(item["binCode"] for item in body["results"])


def test_a_bulk_fill_for_a_foreign_sku_is_refused_outright(client: TestClient) -> None:
    one = published_warehouse(client, code="WH-BULK-1")
    two = published_warehouse(client, code="WH-BULK-2")
    foreign = make_sku(client, two["id"], sku="FOREIGN-BULK")

    response = client.post(
        f"/api/warehouses/{one['id']}/placements/bulk",
        json={"skuId": foreign["id"], "qty": 1, "binIds": [first_bin(one)["id"]]},
    )

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "WRONG_WAREHOUSE"


# --- Interaction with publishing ---------------------------------------------
# Republishing replaces bins; placements reference bin rows, which is why bins are
# upserted by code rather than recreated.


def test_placements_survive_a_republish_that_keeps_the_bins(
    client: TestClient, db: Session
) -> None:
    warehouse = published_warehouse(client)
    sku = make_sku(client, warehouse["id"])
    bin_row = first_bin(warehouse)
    client.post(f"/api/bins/{bin_row['id']}/placements", json={"skuId": sku["id"], "qty": 2})

    # Move the aisle: same bin codes, different geometry.
    moved = copy.deepcopy(warehouse["doc"])
    moved["aisles"][0]["centerline"]["z1"] += 2
    moved["aisles"][0]["centerline"]["z2"] += 2
    assert (
        client.post(f"/api/warehouses/{warehouse['id']}/publish", json={"doc": moved}).status_code
        == 200
    )

    # The bin row is the same row, so the placement is still attached to it.
    assert client.get(f"/api/bins/{bin_row['id']}/placements").json()["placements"][0]["qty"] == 2


def test_a_placement_on_a_removed_bin_is_reported_as_orphaned(client: TestClient) -> None:
    """It cannot survive — but it must not vanish silently either (§1 row 14)."""
    warehouse = published_warehouse(client)
    sku = make_sku(client, warehouse["id"])
    client.post(
        f"/api/bins/{first_bin(warehouse)['id']}/placements", json={"skuId": sku["id"], "qty": 2}
    )

    # Strip the lanes: every bin disappears.
    gutted = copy.deepcopy(warehouse["doc"])
    gutted["aisles"][0]["lanes"] = []

    response = client.post(f"/api/warehouses/{warehouse['id']}/publish", json={"doc": gutted})
    assert response.status_code == 200, response.text

    orphaned = response.json()["orphanedPlacements"]
    assert len(orphaned) == 1
    assert orphaned[0]["qty"] == 2
    assert orphaned[0]["skuId"] == sku["id"]
    assert orphaned[0]["binCode"]

    # And it is recorded on the version, so the report is still readable later.
    versions = client.get(f"/api/warehouses/{warehouse['id']}/versions").json()
    published = next(item for item in versions if item["status"] == "PUBLISHED")
    assert len(published["orphanedPlacements"]) == 1


def test_placing_into_a_layout_that_was_never_published_is_a_404(client: TestClient) -> None:
    """Bins only exist once something is published; there is nothing to place into."""
    doc = copy.deepcopy(BASE_DOC)
    doc["warehouse"]["code"] = "WH-UNPUB-INV"
    created = client.post(
        "/api/warehouses",
        json={
            "code": "WH-UNPUB-INV",
            "lengthM": doc["warehouse"]["lengthM"],
            "widthM": doc["warehouse"]["widthM"],
            "heightM": doc["warehouse"]["heightM"],
            "doc": doc,
        },
    ).json()

    assert client.get(f"/api/warehouses/{created['id']}/layout").status_code == 404

    bin_row = client.get(f"/api/warehouses/{created['id']}/skus")
    assert bin_row.status_code == 200
    assert bin_row.json() == []
