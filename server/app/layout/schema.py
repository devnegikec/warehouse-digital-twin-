"""Document schema validation and default application.

Contract handling (P9):

* **Validation** uses the generated ``layout-doc.v1.json`` directly via the
  ``jsonschema`` library. The schema is generated from the TypeScript Zod source,
  so there is exactly one definition of the wire contract — no hand-maintained
  Pydantic duplicate that could drift.
* **Defaults** are applied here to mirror what Zod's ``.default()`` does on the
  TypeScript side. This matters because the document hash is taken over the
  *normalised* document: if the two sides filled different defaults, every hash
  would disagree.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator

from .ids import DEFAULT_BIN_CODE_PATTERN

DEFAULT_BEAM_HEIGHT_M = 0.08
DEFAULT_UPRIGHT_M = 0.12


class DocumentInvalid(ValueError):
    """Raised when a document does not satisfy the JSON Schema contract."""

    def __init__(self, errors: list[str]) -> None:
        self.errors = errors
        super().__init__("; ".join(errors) if errors else "document is invalid")


def _repo_root() -> Path:
    # app/layout/schema.py -> layout, app, server, <root>
    return Path(__file__).resolve().parents[3]


def schema_path() -> Path:
    return _repo_root() / "packages" / "layout-core" / "schema" / "layout-doc.v1.json"


@lru_cache(maxsize=1)
def _validator() -> Draft202012Validator:
    schema = json.loads(schema_path().read_text(encoding="utf-8"))
    return Draft202012Validator(schema)


def validate_document(document: Any) -> None:
    """Raise :class:`DocumentInvalid` if the document violates the contract."""
    errors = []
    for error in sorted(_validator().iter_errors(document), key=lambda e: list(e.absolute_path)):
        location = "/".join(str(part) for part in error.absolute_path) or "<root>"
        errors.append(f"{location}: {error.message}")
    if errors:
        raise DocumentInvalid(errors[:50])


def _number(value: Any) -> float:
    return float(value)


def _flags(value: Any, default: bool) -> bool:
    return default if value is None else bool(value)


def apply_defaults(document: dict[str, Any]) -> dict[str, Any]:
    """Return the normalised document that gets hashed and stored.

    Only keys present in the Zod schema survive, matching Zod's strip behaviour,
    and every ``.default()`` is materialised.
    """
    warehouse = document["warehouse"]
    origin = warehouse.get("origin") or {}

    normalised_warehouse: dict[str, Any] = {
        "code": warehouse["code"],
        "name": warehouse.get("name", ""),
        "lengthM": _number(warehouse["lengthM"]),
        "widthM": _number(warehouse["widthM"]),
        "heightM": _number(warehouse["heightM"]),
        "origin": {"x": _number(origin.get("x", 0)), "z": _number(origin.get("z", 0))},
        "metadata": dict(warehouse.get("metadata") or {}),
    }
    if warehouse.get("id") is not None:
        normalised_warehouse["id"] = warehouse["id"]

    obstacles = []
    for obstacle in document.get("obstacles") or []:
        obstacles.append(
            {
                "id": obstacle["id"],
                "kind": obstacle.get("kind", "CUSTOM"),
                "x": _number(obstacle["x"]),
                "z": _number(obstacle["z"]),
                "widthM": _number(obstacle["widthM"]),
                "depthM": _number(obstacle["depthM"]),
                "heightM": _number(obstacle["heightM"]),
                "metadata": dict(obstacle.get("metadata") or {}),
            }
        )

    rack_types = []
    for rack_type in document.get("rackTypes") or []:
        rack_types.append(
            {
                "id": rack_type["id"],
                "code": rack_type["code"],
                "name": rack_type.get("name", ""),
                "bayWidthM": _number(rack_type["bayWidthM"]),
                "depthM": _number(rack_type["depthM"]),
                "uprightWidthM": _number(rack_type.get("uprightWidthM", DEFAULT_UPRIGHT_M)),
                "uprightDepthM": _number(rack_type.get("uprightDepthM", DEFAULT_UPRIGHT_M)),
                "metadata": dict(rack_type.get("metadata") or {}),
            }
        )

    aisles = []
    for aisle in document.get("aisles") or []:
        centerline = aisle["centerline"]
        lanes = []
        for lane in aisle.get("lanes") or []:
            length_m = _number(lane["lengthM"])
            segments = [
                {
                    "kind": segment["kind"],
                    "startM": _number(segment["startM"]),
                    "endM": _number(segment["endM"]),
                    **({"label": segment["label"]} if segment.get("label") is not None else {}),
                }
                for segment in (lane.get("segments") or [])
            ]
            if not segments:
                segments = [{"kind": "RACK", "startM": 0.0, "endM": length_m}]

            levels = []
            for level in lane["levels"]:
                entry: dict[str, Any] = {
                    "clearHeightM": _number(level["clearHeightM"]),
                    "binDepthM": _number(level["binDepthM"]),
                    "beamHeightM": _number(level.get("beamHeightM", DEFAULT_BEAM_HEIGHT_M)),
                }
                if level.get("maxWeightKg") is not None:
                    entry["maxWeightKg"] = _number(level["maxWeightKg"])
                levels.append(entry)

            lanes.append(
                {
                    "id": lane["id"],
                    "code": lane["code"],
                    "side": lane["side"],
                    "rackTypeId": lane["rackTypeId"],
                    "startOffsetM": _number(lane.get("startOffsetM", 0)),
                    "lengthM": length_m,
                    "levels": levels,
                    "segments": segments,
                    "skipBays": [int(bay) for bay in (lane.get("skipBays") or [])],
                    "binCodePattern": lane.get("binCodePattern", DEFAULT_BIN_CODE_PATTERN),
                    "metadata": dict(lane.get("metadata") or {}),
                }
            )

        aisles.append(
            {
                "id": aisle["id"],
                "code": aisle["code"],
                "orientation": aisle["orientation"],
                "centerline": {
                    "x1": _number(centerline["x1"]),
                    "z1": _number(centerline["z1"]),
                    "x2": _number(centerline["x2"]),
                    "z2": _number(centerline["z2"]),
                },
                "widthM": _number(aisle["widthM"]),
                "travelDirection": aisle.get("travelDirection", "BOTH"),
                "lanes": lanes,
                "metadata": dict(aisle.get("metadata") or {}),
            }
        )

    return {
        "schemaVersion": document["schemaVersion"],
        "warehouse": normalised_warehouse,
        "obstacles": obstacles,
        "rackTypes": rack_types,
        "aisles": aisles,
    }


def normalize_document(document: Any) -> dict[str, Any]:
    """Validate against the contract, then apply defaults."""
    validate_document(document)
    return apply_defaults(document)


__all__ = [
    "DocumentInvalid",
    "validate_document",
    "apply_defaults",
    "normalize_document",
    "schema_path",
    "_flags",
]
