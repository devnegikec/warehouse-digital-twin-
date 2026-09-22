"""Axis-aligned 2D geometry — Python mirror of ``layout-core/src/geometry.ts``."""

from __future__ import annotations

import math
from dataclasses import dataclass

from .units import EPS

Vec2 = tuple[float, float]


@dataclass(frozen=True, slots=True)
class AABB:
    """Axis-aligned bounding box on the ground plane."""

    min_x: float
    max_x: float
    min_z: float
    max_z: float

    @property
    def width(self) -> float:
        return self.max_x - self.min_x

    @property
    def depth(self) -> float:
        return self.max_z - self.min_z


def aabb(min_x: float, min_z: float, max_x: float, max_z: float) -> AABB:
    return AABB(min_x=min_x, max_x=max_x, min_z=min_z, max_z=max_z)


def aabb_overlap_area(a: AABB, b: AABB) -> float:
    dx = min(a.max_x, b.max_x) - max(a.min_x, b.min_x)
    dz = min(a.max_z, b.max_z) - max(a.min_z, b.min_z)
    if dx <= EPS or dz <= EPS:
        return 0.0
    return dx * dz


def aabb_overlaps(a: AABB, b: AABB) -> bool:
    return aabb_overlap_area(a, b) > 0.0


def aabb_contains(outer: AABB, inner: AABB, eps: float = EPS) -> bool:
    return (
        inner.min_x >= outer.min_x - eps
        and inner.max_x <= outer.max_x + eps
        and inner.min_z >= outer.min_z - eps
        and inner.max_z <= outer.max_z + eps
    )


def normalize2(v: Vec2) -> Vec2 | None:
    """Unit vector, or ``None`` when the input is degenerate."""
    length = math.hypot(v[0], v[1])
    if length <= EPS:
        return None
    return (v[0] / length, v[1] / length)


def perpendicular_left(f: Vec2) -> Vec2:
    """Left of ``f`` in a right-handed Y-up frame (``left = up x forward``)."""
    return (f[1], -f[0])


def perpendicular_right(f: Vec2) -> Vec2:
    return (-f[1], f[0])


def is_axis_aligned(f: Vec2) -> bool:
    return abs(f[0]) <= EPS or abs(f[1]) <= EPS


def oriented_rect_aabb(
    origin: Vec2,
    forward: Vec2,
    perp: Vec2,
    along_from: float,
    along_to: float,
    perp_from: float,
    perp_to: float,
) -> AABB:
    """AABB of an oriented rectangle in (along, perpendicular) lane-local space."""
    xs: list[float] = []
    zs: list[float] = []
    for along, perp_offset in (
        (along_from, perp_from),
        (along_from, perp_to),
        (along_to, perp_from),
        (along_to, perp_to),
    ):
        xs.append(origin[0] + forward[0] * along + perp[0] * perp_offset)
        zs.append(origin[1] + forward[1] * along + perp[1] * perp_offset)
    return AABB(min_x=min(xs), max_x=max(xs), min_z=min(zs), max_z=max(zs))


def find_overlapping_pairs(rects: list[tuple[AABB, str]]) -> list[tuple[str, str]]:
    """Sweep-line pairwise overlap detection over rectangles sorted by ``min_x``.

    Pairs sharing the same key are skipped: bays within one lane never collide.
    """
    ordered = sorted(rects, key=lambda item: item[0].min_x)
    found: list[tuple[str, str]] = []
    seen: set[tuple[str, str]] = set()

    for i, (rect, key) in enumerate(ordered):
        for other_rect, other_key in ordered[i + 1 :]:
            # Break only once a candidate starts beyond our far edge by more than
            # the tolerance. Anything closer can still be a positive-area overlap.
            if other_rect.min_x > rect.max_x + EPS:
                break
            if key == other_key:
                continue
            if not aabb_overlaps(rect, other_rect):
                continue
            pair = (key, other_key) if key < other_key else (other_key, key)
            if pair in seen:
                continue
            seen.add(pair)
            found.append(pair)

    return found
