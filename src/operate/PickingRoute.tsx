/**
 * Picking route.
 *
 * The previous version hardcoded bay numbers against a fixed aisle spacing. Here the
 * waypoints come from the aisles that actually exist: a picker enters the first aisle,
 * travels its length, crosses to the next aisle at the far end, and comes back. With one
 * aisle it degenerates to an out-and-back, which is the honest answer.
 *
 * The route is generated from the slots, so it runs down the *corridor* centreline of a
 * real aisle rather than beside a guessed one.
 */
import { useMemo } from 'react';
import { Line } from '@react-three/drei';

import type { OperateSlot } from './slots';

type Waypoint = [number, number, number];

type Centreline = { code: string; from: [number, number]; to: [number, number] };

/** Aisle centrelines, in the order the aisles are encountered. */
export function aisleCentrelines(slots: readonly OperateSlot[]): Centreline[] {
  const grouped = new Map<string, OperateSlot[]>();
  for (const slot of slots) {
    const list = grouped.get(slot.aisleCode);
    if (list) list.push(slot);
    else grouped.set(slot.aisleCode, [slot]);
  }

  const result: Centreline[] = [];

  for (const [code, inAisle] of grouped) {
    // A slot sits beside the corridor, so the centreline is the bin position mirrored
    // across the aisle's two faces. Averaging the two sides recovers it exactly, and
    // with one lane it lands on that lane, which is still the right place to walk.
    const alongX = inAisle[0]?.rotationDeg === 0;

    const offsets = [...new Set(inAisle.map((slot) => (alongX ? slot.position[2] : slot.position[0])))].sort(
      (a, b) => a - b,
    );
    const corridor = offsets.length > 1 ? (offsets[0]! + offsets[offsets.length - 1]!) / 2 : offsets[0]!;

    const alongs = inAisle.map((slot) => (alongX ? slot.position[0] : slot.position[2]));
    const min = Math.min(...alongs);
    const max = Math.max(...alongs);

    result.push({
      code,
      from: alongX ? [min, corridor] : [corridor, min],
      to: alongX ? [max, corridor] : [corridor, max],
    });
  }

  return result.sort((a, b) => a.code.localeCompare(b.code));
}

export function PickingRoute({ slots }: { slots: readonly OperateSlot[] }) {
  const waypoints = useMemo<Waypoint[]>(() => {
    const aisles = aisleCentrelines(slots);
    if (aisles.length === 0) return [];

    const points: Waypoint[] = [];
    // Down one aisle, up the next, alternating — the classic serpentine pick path.
    aisles.slice(0, 4).forEach((aisle, index) => {
      const reversed = index % 2 === 1;
      const start = reversed ? aisle.to : aisle.from;
      const end = reversed ? aisle.from : aisle.to;

      points.push([start[0], 0.1, start[1]]);
      points.push([end[0], 0.1, end[1]]);

      const next = aisles[index + 1];
      if (next) {
        const nextStart = reversed ? next.from : next.to;
        points.push([nextStart[0], 0.1, nextStart[1]]);
      }
    });

    return points;
  }, [slots]);

  if (waypoints.length < 2) return null;

  return (
    <group>
      <Line points={waypoints} color="#38bdf8" lineWidth={4} dashed={false} />

      <mesh position={waypoints[0]}>
        <cylinderGeometry args={[0.4, 0.4, 0.2]} />
        <meshBasicMaterial color="#34d399" />
      </mesh>
      <mesh position={waypoints[waypoints.length - 1]}>
        <cylinderGeometry args={[0.4, 0.4, 0.2]} />
        <meshBasicMaterial color="#ef4444" />
      </mesh>
    </group>
  );
}
