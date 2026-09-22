/**
 * Axis-aligned 2D geometry (the XZ ground plane).
 *
 * v1 restricts every structure to axis-aligned rectangles with orientation 0 or 90 degrees,
 * which makes collision detection cheap rectangle overlap rather than a full 3D SAT test.
 * Positions are 2D here; Y (height) is tracked separately by the compiler.
 */
import { EPS } from './units.js';

export type Vec2 = { x: number; z: number };

/** Axis-aligned bounding box on the ground plane. */
export type AABB = { minX: number; maxX: number; minZ: number; maxZ: number };

export function aabb(minX: number, minZ: number, maxX: number, maxZ: number): AABB {
  return { minX, maxX, minZ, maxZ };
}

export function aabbOfCenter(cx: number, cz: number, sizeX: number, sizeZ: number): AABB {
  const hx = sizeX / 2;
  const hz = sizeZ / 2;
  return { minX: cx - hx, maxX: cx + hx, minZ: cz - hz, maxZ: cz + hz };
}

export function aabbWidth(a: AABB): number {
  return a.maxX - a.minX;
}

export function aabbDepth(a: AABB): number {
  return a.maxZ - a.minZ;
}

/** Overlap area, zero when the rectangles only touch. */
export function aabbOverlapArea(a: AABB, b: AABB): number {
  const dx = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
  const dz = Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ);
  if (dx <= EPS || dz <= EPS) return 0;
  return dx * dz;
}

export function aabbOverlaps(a: AABB, b: AABB): boolean {
  return aabbOverlapArea(a, b) > 0;
}

export function aabbContains(outer: AABB, inner: AABB, eps = EPS): boolean {
  return (
    inner.minX >= outer.minX - eps &&
    inner.maxX <= outer.maxX + eps &&
    inner.minZ >= outer.minZ - eps &&
    inner.maxZ <= outer.maxZ + eps
  );
}

/** Unit vector, or null when the input is degenerate (zero length). */
export function normalize2(v: Vec2): Vec2 | null {
  const len = Math.hypot(v.x, v.z);
  if (len <= EPS) return null;
  return { x: v.x / len, z: v.z / len };
}

/**
 * Left-hand perpendicular when walking along `f`, in a right-handed Y-up frame
 * (`left = up x forward`). For forward = +X this yields -Z.
 */
export function perpendicularLeft(f: Vec2): Vec2 {
  return { x: f.z, z: -f.x };
}

export function perpendicularRight(f: Vec2): Vec2 {
  return { x: -f.z, z: f.x };
}

export function isAxisAligned(f: Vec2): boolean {
  return Math.abs(f.x) <= EPS || Math.abs(f.z) <= EPS;
}

/**
 * AABB of an oriented rectangle described in (along, perpendicular) lane-local space.
 * Handles 0/90 degree rotation naturally because both basis vectors are axis-aligned.
 */
export function orientedRectAABB(
  origin: Vec2,
  forward: Vec2,
  perp: Vec2,
  alongFrom: number,
  alongTo: number,
  perpFrom: number,
  perpTo: number,
): AABB {
  const corners = [
    [alongFrom, perpFrom],
    [alongFrom, perpTo],
    [alongTo, perpFrom],
    [alongTo, perpTo],
  ] as const;

  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;

  for (const [along, perpOffset] of corners) {
    const x = origin.x + forward.x * along + perp.x * perpOffset;
    const z = origin.z + forward.z * along + perp.z * perpOffset;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }

  return { minX, maxX, minZ, maxZ };
}

export type RectWithKey = { rect: AABB; key: string };

/**
 * Sweep-line pairwise overlap detection over rectangles sorted by minX.
 * Because the input is sorted, the inner loop can stop as soon as a candidate
 * starts beyond the current rect's far edge — every later candidate does too.
 * Pairs sharing the same `key` are skipped: bays within one lane never collide.
 */
export function findOverlappingPairs(rects: RectWithKey[]): Array<{ a: string; b: string }> {
  const sorted = [...rects].sort((p, q) => p.rect.minX - q.rect.minX);
  const found: Array<{ a: string; b: string }> = [];
  const seen = new Set<string>();

  for (let i = 0; i < sorted.length; i++) {
    const current = sorted[i];
    if (!current) continue;

    for (let j = i + 1; j < sorted.length; j++) {
      const other = sorted[j];
      if (!other) continue;
      // Break only once a candidate starts beyond our far edge by more than the
      // tolerance. Anything closer can still be a real (positive-area) overlap.
      if (other.rect.minX > current.rect.maxX + EPS) break;
      if (current.key === other.key) continue;
      if (!aabbOverlaps(current.rect, other.rect)) continue;

      const pairKey = current.key < other.key
        ? `${current.key}\u0000${other.key}`
        : `${other.key}\u0000${current.key}`;
      if (seen.has(pairKey)) continue;
      seen.add(pairKey);
      found.push({ a: current.key, b: other.key });
    }
  }

  return found;
}
