"""The layout compiler — Python mirror of ``layout-core/src/compile.ts``.

    build_layout(doc) -> bins + diagnostics + doc_hash

Pure and deterministic. The TypeScript implementation in
``packages/layout-core`` is the interactive one; this is the authoritative one
for database writes. ``fixtures/layout-conformance`` pins them together (P9).

Validation shares this single pass rather than being a separate traversal,
because every geometric rule needs the compiled geometry anyway.
"""

from __future__ import annotations

from dataclasses import dataclass
from math import hypot
from typing import Any

from . import geometry as geo
from .canonical import doc_hash
from .capacity import usable_volume_m3
from .diagnostics import Diagnostic, DiagnosticCollector, EntityRef
from .ids import BinCodeParts, format_bin_code
from .schema import normalize_document
from .units import EPS, MIN_AISLE_WIDTH_M, js_round


@dataclass(frozen=True, slots=True)
class DerivedBin:
    code: str
    warehouse_code: str
    aisle_code: str
    lane_code: str
    side: str
    bay_seq: int
    """1-based, as humans count."""
    level_index: int
    """0-based; codes render ``L{level_index + 1}``."""
    center: dict[str, float]
    width_m: float
    """Local width, measured along the lane run."""
    height_m: float
    depth_m: float
    """Local depth, measured perpendicular to the lane run."""
    rotation_deg: float
    """0 when the aisle runs along X, 90 when along Z."""
    capacity_m3: float
    max_weight_kg: float | None

    def to_json(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "warehouseCode": self.warehouse_code,
            "aisleCode": self.aisle_code,
            "laneCode": self.lane_code,
            "side": self.side,
            "baySeq": self.bay_seq,
            "levelIndex": self.level_index,
            "center": self.center,
            "widthM": self.width_m,
            "heightM": self.height_m,
            "depthM": self.depth_m,
            "rotationDeg": self.rotation_deg,
            "capacityM3": self.capacity_m3,
            "maxWeightKg": self.max_weight_kg,
        }


@dataclass(frozen=True, slots=True)
class DerivedBay:
    aisle_code: str
    lane_code: str
    seq: int
    is_skipped: bool
    in_rack_run: bool
    center: dict[str, float]
    width_m: float
    depth_m: float
    rotation_deg: float

    def to_json(self) -> dict[str, Any]:
        return {
            "aisleCode": self.aisle_code,
            "laneCode": self.lane_code,
            "seq": self.seq,
            "isSkipped": self.is_skipped,
            "inRackRun": self.in_rack_run,
            "center": self.center,
            "widthM": self.width_m,
            "depthM": self.depth_m,
            "rotationDeg": self.rotation_deg,
        }


@dataclass(frozen=True, slots=True)
class LayoutGraph:
    doc: dict[str, Any]
    bins: list[DerivedBin]
    bays: list[DerivedBay]
    hash: str
    diagnostics: list[Diagnostic]
    error_count: int
    warning_count: int
    publishable: bool


def lane_stack_height_m(levels: list[dict[str, Any]]) -> float:
    total = sum(level["beamHeightM"] + level["clearHeightM"] for level in levels)
    return js_round(total)


def build_layout(document: Any) -> LayoutGraph:
    doc = normalize_document(document)
    diagnostics = DiagnosticCollector()
    warehouse = doc["warehouse"]

    bins: list[DerivedBin] = []
    bays: list[DerivedBay] = []
    bay_rects: list[tuple[geo.AABB, str]] = []
    code_counts: dict[str, int] = {}
    # First lane that produced each code, so a duplicate can point at a real entity.
    code_first_seen: dict[str, EntityRef] = {}

    footprint = geo.aabb(
        warehouse["origin"]["x"],
        warehouse["origin"]["z"],
        warehouse["origin"]["x"] + warehouse["lengthM"],
        warehouse["origin"]["z"] + warehouse["widthM"],
    )
    warehouse_ref = EntityRef(
        "warehouse", warehouse.get("id") or warehouse["code"], warehouse["code"]
    )

    rack_type_by_id = {rack_type["id"]: rack_type for rack_type in doc["rackTypes"]}
    if not doc["rackTypes"] and any(aisle["lanes"] for aisle in doc["aisles"]):
        diagnostics.error(
            "NO_RACK_TYPES_DEFINED",
            "Aisles have lanes but the document defines no rack types",
            (warehouse_ref,),
        )

    obstacle_rects = [
        (
            obstacle,
            geo.aabb(
                obstacle["x"],
                obstacle["z"],
                obstacle["x"] + obstacle["widthM"],
                obstacle["z"] + obstacle["depthM"],
            ),
        )
        for obstacle in doc["obstacles"]
    ]

    seen_aisle_codes: set[str] = set()

    for aisle in doc["aisles"]:
        aisle_ref = EntityRef("aisle", aisle["id"], aisle["code"])

        if aisle["code"] in seen_aisle_codes:
            diagnostics.error(
                "AISLE_CODE_DUPLICATE",
                f"Aisle code '{aisle['code']}' is used more than once",
                (aisle_ref,),
            )
        seen_aisle_codes.add(aisle["code"])

        centerline = aisle["centerline"]
        delta = (centerline["x2"] - centerline["x1"], centerline["z2"] - centerline["z1"])
        forward = geo.normalize2(delta)
        if forward is None:
            diagnostics.error(
                "AISLE_ZERO_LENGTH",
                f"Aisle '{aisle['code']}' has a zero-length centerline",
                (aisle_ref,),
            )
            continue
        if not geo.is_axis_aligned(forward):
            diagnostics.error(
                "AISLE_NOT_AXIS_ALIGNED",
                f"Aisle '{aisle['code']}' must run exactly along X or Z; "
                "v1 does not support diagonal aisles",
                (aisle_ref,),
            )
            continue

        derived_orientation = "X" if abs(forward[0]) > abs(forward[1]) else "Z"
        if derived_orientation != aisle["orientation"]:
            diagnostics.error(
                "AISLE_ORIENTATION_MISMATCH",
                f"Aisle '{aisle['code']}' declares orientation '{aisle['orientation']}' "
                f"but its centerline runs along {derived_orientation}",
                (aisle_ref,),
                {"declared": aisle["orientation"], "derived": derived_orientation},
            )

        if aisle["widthM"] < MIN_AISLE_WIDTH_M:
            diagnostics.warn(
                "AISLE_TOO_NARROW",
                f"Aisle '{aisle['code']}' is {js_round(aisle['widthM'])} m wide; "
                f"under {MIN_AISLE_WIDTH_M} m is tight for a counterbalance forklift",
                (aisle_ref,),
            )

        if not aisle["lanes"]:
            diagnostics.warn(
                "AISLE_WITHOUT_LANES", f"Aisle '{aisle['code']}' has no lanes", (aisle_ref,)
            )

        aisle_length = hypot(*delta)
        origin = (centerline["x1"], centerline["z1"])
        perp_left = geo.perpendicular_left(forward)
        half_width = aisle["widthM"] / 2

        corridor = geo.oriented_rect_aabb(
            origin, forward, perp_left, 0.0, aisle_length, -half_width, half_width
        )
        if not geo.aabb_contains(footprint, corridor):
            diagnostics.error(
                "AISLE_OUT_OF_FOOTPRINT",
                f"Aisle '{aisle['code']}' extends beyond the warehouse footprint",
                (aisle_ref,),
            )
        for obstacle, rect in obstacle_rects:
            if geo.aabb_overlaps(corridor, rect):
                diagnostics.error(
                    "AISLE_OBSTACLE_OVERLAP",
                    f"Aisle '{aisle['code']}' intersects obstacle '{obstacle['id']}'",
                    (aisle_ref, EntityRef("obstacle", obstacle["id"], obstacle["kind"])),
                )

        for lane in aisle["lanes"]:
            lane_ref = EntityRef("lane", lane["id"], lane["code"])

            rack_type = rack_type_by_id.get(lane["rackTypeId"])
            if rack_type is None:
                diagnostics.error(
                    "LANE_UNKNOWN_RACK_TYPE",
                    f"Lane '{lane['code']}' references unknown rack type '{lane['rackTypeId']}'",
                    (lane_ref,),
                )
                continue

            if lane["startOffsetM"] + lane["lengthM"] > aisle_length + EPS:
                diagnostics.error(
                    "LANE_RUN_EXCEEDS_AISLE",
                    f"Lane '{lane['code']}' runs "
                    f"{js_round(lane['startOffsetM'] + lane['lengthM'])} m but aisle "
                    f"'{aisle['code']}' is only {js_round(aisle_length)} m long",
                    (lane_ref, aisle_ref),
                )

            stack_height = 0.0
            for level_index, level in enumerate(lane["levels"]):
                if level["binDepthM"] > rack_type["depthM"] + EPS:
                    diagnostics.warn(
                        "LEVEL_DEPTH_EXCEEDS_RACK",
                        f"Level {level_index + 1} of lane '{lane['code']}' is "
                        f"{js_round(level['binDepthM'])} m deep but rack type "
                        f"'{rack_type['code']}' is {js_round(rack_type['depthM'])} m deep",
                        (
                            lane_ref,
                            EntityRef(
                                "level", f"{lane['id']}:{level_index}", f"L{level_index + 1}"
                            ),
                        ),
                    )
                stack_height += level["beamHeightM"] + level["clearHeightM"]

            if stack_height > warehouse["heightM"] + EPS:
                diagnostics.error(
                    "LEVEL_STACK_EXCEEDS_HEIGHT",
                    f"Lane '{lane['code']}' stacks to {js_round(stack_height)} m but the "
                    f"warehouse is {js_round(warehouse['heightM'])} m tall",
                    (lane_ref, warehouse_ref),
                    {
                        "stackHeightM": js_round(stack_height),
                        "warehouseHeightM": warehouse["heightM"],
                    },
                )

            perp = perp_left if lane["side"] == "LEFT" else geo.perpendicular_right(forward)
            lane_offset = half_width + rack_type["depthM"] / 2
            rotation_deg = 0.0 if derived_orientation == "X" else 90.0

            bay_count = int((lane["lengthM"] + EPS) // rack_type["bayWidthM"])
            if bay_count == 0:
                diagnostics.warn(
                    "LANE_ZERO_BAYS",
                    f"Lane '{lane['code']}' is shorter than one "
                    f"{js_round(rack_type['bayWidthM'])} m bay",
                    (lane_ref,),
                )
                continue

            rack_segments = [s for s in lane["segments"] if s["kind"] == "RACK"]
            if not rack_segments:
                diagnostics.warn(
                    "LANE_HAS_NO_RACK_SEGMENT",
                    f"Lane '{lane['code']}' has no RACK segment, so it produces no bins",
                    (lane_ref,),
                )

            for bay_index in range(bay_count):
                bay_seq = bay_index + 1
                center_along = (bay_index + 0.5) * rack_type["bayWidthM"]
                in_rack_run = any(
                    segment["startM"] - EPS <= center_along <= segment["endM"] + EPS
                    for segment in rack_segments
                )
                is_skipped = bay_seq in lane["skipBays"]

                cx = (
                    origin[0]
                    + forward[0] * (lane["startOffsetM"] + center_along)
                    + perp[0] * lane_offset
                )
                cz = (
                    origin[1]
                    + forward[1] * (lane["startOffsetM"] + center_along)
                    + perp[1] * lane_offset
                )

                bays.append(
                    DerivedBay(
                        aisle_code=aisle["code"],
                        lane_code=lane["code"],
                        seq=bay_seq,
                        is_skipped=is_skipped,
                        in_rack_run=in_rack_run,
                        center={"x": js_round(cx), "z": js_round(cz)},
                        width_m=rack_type["bayWidthM"],
                        depth_m=rack_type["depthM"],
                        rotation_deg=rotation_deg,
                    )
                )

                half_along = rack_type["bayWidthM"] / 2
                bay_rect = geo.oriented_rect_aabb(
                    origin,
                    forward,
                    perp,
                    lane["startOffsetM"] + center_along - half_along,
                    lane["startOffsetM"] + center_along + half_along,
                    lane_offset - rack_type["depthM"] / 2,
                    lane_offset + rack_type["depthM"] / 2,
                )
                bay_rects.append((bay_rect, f"{aisle['code']}/{lane['code']}"))

                if not in_rack_run or is_skipped:
                    continue

                if not geo.aabb_contains(footprint, bay_rect):
                    diagnostics.error(
                        "BIN_OUT_OF_FOOTPRINT",
                        f"Bay {bay_seq} of lane '{lane['code']}' extends beyond the "
                        "warehouse footprint",
                        (lane_ref, EntityRef("bay", f"{lane['id']}:{bay_seq}", f"B{bay_seq}")),
                    )

                for obstacle, rect in obstacle_rects:
                    if geo.aabb_overlaps(bay_rect, rect):
                        diagnostics.error(
                            "BAY_OBSTACLE_OVERLAP",
                            f"Bay {bay_seq} of lane '{lane['code']}' collides with "
                            f"obstacle '{obstacle['id']}'",
                            (lane_ref, EntityRef("obstacle", obstacle["id"], obstacle["kind"])),
                            {"baySeq": bay_seq},
                        )

                y = 0.0
                for level_index, level in enumerate(lane["levels"]):
                    bottom = y + level["beamHeightM"]
                    center_y = bottom + level["clearHeightM"] / 2
                    y = bottom + level["clearHeightM"]

                    code = format_bin_code(
                        lane["binCodePattern"],
                        BinCodeParts(
                            warehouse=warehouse["code"],
                            aisle=aisle["code"],
                            lane=lane["code"],
                            side=lane["side"],
                            bay_seq=bay_seq,
                            level_index=level_index,
                        ),
                    )

                    count = code_counts.get(code, 0) + 1
                    code_counts[code] = count
                    code_first_seen.setdefault(code, lane_ref)

                    bins.append(
                        DerivedBin(
                            code=code,
                            warehouse_code=warehouse["code"],
                            aisle_code=aisle["code"],
                            lane_code=lane["code"],
                            side=lane["side"],
                            bay_seq=bay_seq,
                            level_index=level_index,
                            center={
                                "x": js_round(cx),
                                "y": js_round(center_y),
                                "z": js_round(cz),
                            },
                            width_m=rack_type["bayWidthM"],
                            height_m=level["clearHeightM"],
                            depth_m=level["binDepthM"],
                            rotation_deg=rotation_deg,
                            capacity_m3=usable_volume_m3(
                                rack_type["bayWidthM"], level["clearHeightM"], level["binDepthM"]
                            ),
                            max_weight_kg=level.get("maxWeightKg"),
                        )
                    )

    # Reported after the full pass so each offending code is named once, with its
    # total count, rather than once per colliding bin. Sorted by code so the output
    # is deterministic (matching the plain code-unit sort on the TypeScript side).
    for code, count in sorted(code_counts.items()):
        if count <= 1:
            continue
        diagnostics.error(
            "BIN_CODE_DUPLICATE",
            f"Bin code '{code}' is produced {count} times; "
            "the lane bin code pattern is not unique enough",
            (code_first_seen.get(code, warehouse_ref),),
            {"code": code, "count": count},
        )

    for key_a, key_b in geo.find_overlapping_pairs(bay_rects):
        diagnostics.error(
            "LANE_OVERLAP",
            f"Lanes '{key_a}' and '{key_b}' occupy overlapping floor space",
            (EntityRef("lane", key_a, key_a), EntityRef("lane", key_b, key_b)),
        )

    all_diagnostics = diagnostics.all()

    return LayoutGraph(
        doc=doc,
        bins=bins,
        bays=bays,
        hash=doc_hash(doc),
        diagnostics=all_diagnostics,
        error_count=sum(1 for d in all_diagnostics if d.severity == "error"),
        warning_count=sum(1 for d in all_diagnostics if d.severity == "warning"),
        publishable=not any(d.severity == "error" for d in all_diagnostics),
    )


def validate_layout(document: Any) -> list[Diagnostic]:
    """Read-only facade for the ``/validate`` endpoint: run the pass, drop the geometry."""
    return build_layout(document).diagnostics
