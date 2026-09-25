/**
 * Grouping derived bays into contiguous rack runs.
 *
 * A lane's bays are a flat list, and a GAP segment is expressed by the *absence* of a bay
 * between two sequences. Turning them into runs is what lets both the 3D racks and the
 * plan view show a real break in the racking rather than a continuous shelf.
 *
 * Written as a single grouping pass over the bays with a `Set` of wanted lanes. The
 * earlier version called `laneCodes.includes(...)` inside the bay loop, which is
 * O(bays × lanes) — invisible at 72 bays and fatal at 100k, which is the target.
 */
import type { DerivedBay } from 'layout-core';

export type RackRun = {
  key: string;
  laneCode: string;
  /** Centre of the run, in plan coordinates (x, z); y is filled in by the caller. */
  center: { x: number; z: number };
  /** Extent of the run: width along the lane, depth across it. */
  widthM: number;
  depthM: number;
  rotationDeg: number;
  /** How many bays were merged into this run. */
  bayCount: number;
};

/**
 * Merge contiguous bays per lane.
 *
 * `laneCodes` is optional: omit it to group every lane. Bays are grouped in one pass and
 * sorted per lane, so the cost is O(bays) plus a sort of each lane's own list.
 */
export function rackRuns(bays: readonly DerivedBay[], laneCodes?: Iterable<string>): RackRun[] {
  const wanted = laneCodes ? new Set(laneCodes) : null;

  const grouped = new Map<string, DerivedBay[]>();
  for (const bay of bays) {
    if (wanted && !wanted.has(bay.laneCode)) continue;
    const list = grouped.get(bay.laneCode);
    if (list) list.push(bay);
    else grouped.set(bay.laneCode, [bay]);
  }

  const runs: RackRun[] = [];

  for (const [laneCode, list] of grouped) {
    // The compiler emits bays per lane in bay order, but sorting explicitly means the
    // grouping cannot depend on that promise holding.
    const sorted = [...list].sort((a, b) => a.seq - b.seq);

    let first: DerivedBay | null = null;
    let last: DerivedBay | null = null;
    let count = 0;

    const flush = () => {
      if (!first || !last) return;
      const alongX = first.rotationDeg === 0;
      // Measured centre-to-centre plus one bay, so a multi-bay run spans its bays
      // exactly rather than from centre to centre.
      const span = count * first.widthM;
      const distance = Math.abs(
        alongX ? last.center.x - first.center.x : last.center.z - first.center.z,
      );

      runs.push({
        key: `${laneCode}:${first.seq}`,
        laneCode,
        center: {
          x: alongX ? (first.center.x + last.center.x) / 2 : first.center.x,
          z: alongX ? first.center.z : (first.center.z + last.center.z) / 2,
        },
        widthM: Math.max(count > 1 ? distance + first.widthM : span, 0.1),
        depthM: first.depthM,
        rotationDeg: first.rotationDeg,
        bayCount: count,
      });

      first = null;
      last = null;
      count = 0;
    };

    for (const bay of sorted) {
      if (last && bay.seq !== last.seq + 1) flush();
      if (!first) first = bay;
      last = bay;
      count += 1;
    }
    flush();
  }

  return runs;
}
