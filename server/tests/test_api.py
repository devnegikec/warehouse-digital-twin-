"""End-to-end API tests.

The COMPILER_DRIFT case is the important one: it is the mechanism that turns a
silent TypeScript/Python divergence into a loud failure (P9).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.main import app

FIXTURES_DIR = Path(__file__).resolve().parents[2] / "fixtures" / "layout-conformance"
FIXTURE = json.loads((FIXTURES_DIR / "001_single_aisle_left.json").read_text(encoding="utf-8"))
DOC: dict[str, Any] = FIXTURE["doc"]
EXPECTED_HASH: str = FIXTURE["expected"]["docHash"]

client = TestClient(app)


def test_health() -> None:
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_compile_returns_the_typescript_expected_bin_count() -> None:
    response = client.post("/api/layout/compile", json={"doc": DOC})
    assert response.status_code == 200

    body = response.json()
    assert body["binCount"] == FIXTURE["expected"]["binCount"]
    assert body["bayCount"] == FIXTURE["expected"]["bayCount"]
    assert body["docHash"] == EXPECTED_HASH
    assert body["publishable"] is True
    assert body["bins"][0]["code"] == FIXTURE["expected"]["firstBinCode"]


def test_validate_omits_bins_but_returns_diagnostics() -> None:
    response = client.post("/api/layout/validate", json={"doc": DOC})
    assert response.status_code == 200

    body = response.json()
    assert body["bins"] is None
    assert body["binCount"] == FIXTURE["expected"]["binCount"]


def test_matching_client_hash_is_accepted() -> None:
    response = client.post("/api/layout/compile", json={"doc": DOC, "clientDocHash": EXPECTED_HASH})
    assert response.status_code == 200


def test_mismatched_client_hash_is_rejected_as_compiler_drift() -> None:
    wrong = "0" * 64
    response = client.post("/api/layout/compile", json={"doc": DOC, "clientDocHash": wrong})

    assert response.status_code == 409
    detail = response.json()["detail"]
    assert detail["code"] == "COMPILER_DRIFT"
    assert detail["clientDocHash"] == wrong
    assert detail["serverDocHash"] == EXPECTED_HASH


def test_schema_violation_is_a_422_not_a_500() -> None:
    broken = json.loads(json.dumps(DOC))
    del broken["warehouse"]["heightM"]

    response = client.post("/api/layout/compile", json={"doc": broken})

    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "DOCUMENT_INVALID"


def test_unpublishable_layout_still_compiles_and_reports_errors() -> None:
    fixture = json.loads(
        (FIXTURES_DIR / "004_bay_obstacle_overlap.json").read_text(encoding="utf-8")
    )

    response = client.post("/api/layout/compile", json={"doc": fixture["doc"]})

    # Compiling a layout with errors is deliberate: the editor needs the geometry
    # to show the user *where* the problem is. Only Publish is blocked.
    assert response.status_code == 200
    body = response.json()
    assert body["publishable"] is False
    assert body["binCount"] == fixture["expected"]["binCount"]
    assert "BAY_OBSTACLE_OVERLAP" in {diagnostic["code"] for diagnostic in body["diagnostics"]}


@pytest.mark.parametrize("path", sorted(FIXTURES_DIR.glob("*.json")), ids=lambda p: p.name)
def test_every_fixture_round_trips_through_the_api(path: Path) -> None:
    fixture = json.loads(path.read_text(encoding="utf-8"))

    response = client.post("/api/layout/compile", json={"doc": fixture["doc"]})

    assert response.status_code == 200
    body = response.json()
    assert body["docHash"] == fixture["expected"]["docHash"]
    assert body["binCount"] == fixture["expected"]["binCount"]
    assert body["publishable"] == fixture["expected"]["publishable"]
