"""Create a demo warehouse with a large published layout, SKUs and inventory.

    npm run db:up
    npm run api:migrate
    npm run seed                     # or: --aisles 40 --fill 0.8

The designer's starting layout is deliberately small (72 bays) so it is quick to read,
which makes it useless for judging how the editor behaves at scale or for looking at a
populated warehouse in Operate mode. This exists to produce the other thing.

Everything is written through the same service layer the API uses, so the seed cannot
reach a state the API could not, and re-running it is safe: the warehouse is replaced
rather than duplicated.
"""

from __future__ import annotations

import argparse
import random
import sys
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.db import SessionLocal
from app.layout import FitItem, build_layout, item_fits
from app.models import Bin, Placement, SkuTemplate, Warehouse
from app.services import capacity_target, publish, usage_of

BAY_WIDTH_M = 2.7
LEVELS = 5
LEVEL_CLEAR_M = 1.4
LEVEL_DEPTH_M = 1.0
LEVEL_BEAM_M = 0.08
LEVEL_MAX_KG = 800
AISLE_WIDTH_M = 3.4
LANE_BAYS = 12
LANE_LENGTH_M = LANE_BAYS * BAY_WIDTH_M
AISLE_GAP_M = 6.0

#: Sizes and weights that a 2.7 × 1.4 × 1.0 m opening can hold, plus one it cannot.
CATALOGUE: list[tuple[str, str, float, float, float, float]] = [
    ("PALLET-STD", "Standard pallet", 1.2, 1.3, 0.8, 400),
    ("PALLET-EURO", "Euro pallet", 1.2, 1.1, 0.8, 350),
    ("TOTE-SMALL", "Small tote", 0.6, 0.4, 0.4, 25),
    ("TOTE-MED", "Medium tote", 0.8, 0.6, 0.6, 60),
    ("DRUM", "Steel drum", 0.6, 0.9, 0.6, 220),
    ("CRATE-LONG", "Long crate", 2.4, 0.5, 0.5, 120),
    ("OVERSIZE", "Oversized crate (fits no bin)", 3.0, 3.0, 3.0, 50),
]

#: Deliberately excluded from the inventory pass: it exists to be refused.
OVERSIZE_CODE = "OVERSIZE"


def build_document(code: str, aisle_count: int) -> dict[str, Any]:
    """A document with `aisle_count` aisles, each with a left and a right lane."""
    return {
        "schemaVersion": 1,
        "warehouse": {
            "code": code,
            "name": f"Seeded warehouse ({aisle_count} aisles)",
            "lengthM": 40.0,
            "widthM": max(20.0, aisle_count * AISLE_GAP_M + 4.0),
            "heightM": 8.0,
        },
        "rackTypes": [
            {
                "id": "rt-std",
                "code": "STD",
                "name": "Standard pallet rack",
                "bayWidthM": BAY_WIDTH_M,
                "depthM": 1.1,
            }
        ],
        "obstacles": [
            {
                "id": "ob-1",
                "kind": "COLUMN",
                "x": 18,
                "z": 0.6,
                "widthM": 1,
                "depthM": 1,
                "heightM": 6,
            }
        ],
        "aisles": [
            {
                "id": f"a-{index + 1}",
                "code": f"A{index + 1:02d}",
                "orientation": "X",
                "centerline": {
                    "x1": 3.0,
                    "z1": 5.0 + index * AISLE_GAP_M,
                    "x2": 37.0,
                    "z2": 5.0 + index * AISLE_GAP_M,
                },
                "widthM": AISLE_WIDTH_M,
                "travelDirection": "BOTH",
                "lanes": [
                    {
                        "id": f"a-{index + 1}-{side.lower()}",
                        "code": f"A{index + 1:02d}-{side[0]}",
                        "side": side,
                        "rackTypeId": "rt-std",
                        "startOffsetM": 0.0,
                        "lengthM": LANE_LENGTH_M,
                        "levels": [
                            {
                                "clearHeightM": LEVEL_CLEAR_M,
                                "binDepthM": LEVEL_DEPTH_M,
                                "beamHeightM": LEVEL_BEAM_M,
                                "maxWeightKg": LEVEL_MAX_KG,
                            }
                            for _ in range(LEVELS)
                        ],
                    }
                    for side in ("LEFT", "RIGHT")
                ],
            }
            for index in range(aisle_count)
        ],
    }


def reset_warehouse(session: Session, code: str, document: dict[str, Any]) -> Any:
    """Create the warehouse, replacing any previous one with the same code.

    The cascade does the rest: bins, bays, lanes and placements all hang off the warehouse.
    """
    existing = session.scalars(select(Warehouse).where(Warehouse.code == code)).first()
    if existing is not None:
        print(f"replacing existing warehouse {code}")
        session.execute(delete(Warehouse).where(Warehouse.id == existing.id))
        session.flush()

    doc_warehouse = document["warehouse"]
    warehouse = Warehouse(
        code=doc_warehouse["code"],
        name=doc_warehouse["name"],
        length_m=doc_warehouse["lengthM"],
        width_m=doc_warehouse["widthM"],
        height_m=doc_warehouse["heightM"],
        draft_revision=0,
    )
    session.add(warehouse)
    session.flush()
    return warehouse


def seed_skus(session: Session, warehouse_id: Any, count: int) -> list[SkuTemplate]:
    created: list[SkuTemplate] = []
    for code, name, width, height, depth, weight in CATALOGUE[: max(1, count)]:
        sku = SkuTemplate(
            warehouse_id=warehouse_id,
            sku=code,
            name=name,
            width_m=width,
            height_m=height,
            depth_m=depth,
            weight_kg=weight,
            stackable=True,
            rotatable=True,
            hazmat=False,
        )
        session.add(sku)
        created.append(sku)

    session.flush()
    return created


def seed_inventory(
    session: Session, warehouse_id: Any, skus: list[SkuTemplate], fill: float, rng: random.Random
) -> int:
    """Stock a fraction of the bins, using the same fit check the editor and API use."""
    placeable = [sku for sku in skus if sku.sku != OVERSIZE_CODE]
    if not placeable:
        return 0

    bins = list(session.scalars(select(Bin).where(Bin.warehouse_id == warehouse_id)).all())
    rng.shuffle(bins)

    placed = 0
    for bin_row in bins[: int(len(bins) * min(max(fill, 0.0), 1.0))]:
        sku = rng.choice(placeable)
        target = capacity_target(bin_row, [])
        item = FitItem(
            width_m=sku.width_m,
            height_m=sku.height_m,
            depth_m=sku.depth_m,
            weight_kg=sku.weight_kg,
            rotatable=sku.rotatable,
        )

        # Keep the largest quantity the bin actually takes, so the seeded warehouse has a
        # spread of fills instead of every bin holding exactly one item.
        quantity = 0
        for candidate in (1, 2, 3, 6, 10):
            if item_fits(target, item, candidate).fits:
                quantity = candidate
        if quantity == 0:
            continue

        volume, weight = usage_of(sku, quantity)
        session.add(
            Placement(
                bin_id=bin_row.id,
                sku_id=sku.id,
                qty=quantity,
                volume_used_m3=volume,
                weight_used_kg=weight,
            )
        )
        placed += 1

    session.flush()
    return placed


def run(args: argparse.Namespace) -> None:
    rng = random.Random(args.seed)
    document = build_document(args.code, max(1, args.aisles))
    graph = build_layout(document)

    if not graph.publishable:
        codes = sorted({diagnostic.code for diagnostic in graph.diagnostics})
        raise SystemExit(f"the generated document is not publishable: {', '.join(codes)}")

    with SessionLocal() as session:
        warehouse = reset_warehouse(session, args.code, document)
        result = publish(session, warehouse.id, document, None, "seed")
        skus = seed_skus(session, warehouse.id, args.skus)
        placed = seed_inventory(session, warehouse.id, skus, args.fill, rng)
        session.commit()

        print(
            f"seeded {args.code}: {len(document['aisles'])} aisles, "
            f"{result.bin_count} bins, version {result.version}, "
            f"{len(skus)} SKUs, {placed} placements"
        )


def main() -> int:
    parser = argparse.ArgumentParser(description="Seed a demo warehouse")
    parser.add_argument("--code", default="DEMO", help="warehouse code (replaced if it exists)")
    parser.add_argument("--aisles", type=int, default=12, help="number of aisles")
    parser.add_argument("--fill", type=float, default=0.6, help="fraction of bins to stock")
    parser.add_argument("--skus", type=int, default=len(CATALOGUE), help="how many SKUs to create")
    parser.add_argument("--seed", type=int, default=7, help="random seed, for reproducibility")
    run(parser.parse_args())
    return 0


if __name__ == "__main__":
    sys.exit(main())
