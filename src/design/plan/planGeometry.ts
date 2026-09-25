/**
 * Plan-space geometry shared by the plan editor and the mini-map.
 *
 * Plan coordinates are metres, and — as in the mini-map — SVG `y` is the document's
 * `z`. Both views therefore draw the floor the same way round, and a rectangle
 * computed here cannot be right in one and mirrored in the other.
 */
import { clamp, type Aisle } from 'layout-core';

/** A rectangle in plan space: `x`/`z` is the minimum corner. */
export type PlanRect = { x: number; z: number; width: number; height: number };

/** Clear footprint of an aisle's corridor, in plan coordinates. */
export function corridorRect(aisle: Aisle): PlanRect {
  const { x1, z1, x2, z2 } = aisle.centerline;
  const half = aisle.widthM / 2;
  const alongX = Math.abs(x2 - x1) >= Math.abs(z2 - z1);

  if (alongX) {
    return { x: Math.min(x1, x2), z: z1 - half, width: Math.abs(x2 - x1), height: aisle.widthM };
  }
  return { x: x1 - half, z: Math.min(z1, z2), width: aisle.widthM, height: Math.abs(z2 - z1) };
}

export type PlanPoint = { x: number; z: number };

/** True when a plan point lies inside a rectangle, with a tolerance in metres. */
export function rectContains(rect: PlanRect, point: PlanPoint, toleranceM = 0): boolean {
  return (
    point.x >= rect.x - toleranceM &&
    point.x <= rect.x + rect.width + toleranceM &&
    point.z >= rect.z - toleranceM &&
    point.z <= rect.z + rect.height + toleranceM
  );
}

/** Distance from a point to an aisle's centreline segment, in metres. */
export function distanceToAisle(aisle: Aisle, point: PlanPoint): number {
  const { x1, z1, x2, z2 } = aisle.centerline;
  const dx = x2 - x1;
  const dz = z2 - z1;
  const lengthSq = dx * dx + dz * dz;
  if (lengthSq === 0) return Math.hypot(point.x - x1, point.z - z1);

  const t = clamp(((point.x - x1) * dx + (point.z - z1) * dz) / lengthSq, 0, 1);
  return Math.hypot(point.x - (x1 + dx * t), point.z - (z1 + dz * t));
}

/**
 * How far along an aisle a point sits, as a 0–1 fraction of its centreline.
 *
 * This is the coordinate a cross-aisle is positioned by, so it is also the projection
 * used to decide *where* a clicked route crosses.
 */
export function ratioAlongAisle(aisle: Aisle, point: PlanPoint): number {
  const { x1, z1, x2, z2 } = aisle.centerline;
  const dx = x2 - x1;
  const dz = z2 - z1;
  const lengthSq = dx * dx + dz * dz;
  if (lengthSq === 0) return 0.5;

  return clamp(((point.x - x1) * dx + (point.z - z1) * dz) / lengthSq, 0, 1);
}

/** The aisle a plan point refers to: the one under it, else the nearest corridor. */
export function aisleAt(aisles: readonly Aisle[], point: PlanPoint): Aisle | null {
  const inside = aisles.find((aisle) => rectContains(corridorRect(aisle), point));
  if (inside) return inside;

  let nearest: Aisle | null = null;
  let best = Number.POSITIVE_INFINITY;
  for (const aisle of aisles) {
    const distance = distanceToAisle(aisle, point);
    if (distance < best) {
      best = distance;
      nearest = aisle;
    }
  }
  return nearest;
}
