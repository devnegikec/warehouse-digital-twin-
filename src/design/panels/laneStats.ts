/**
 * Per-lane tallies, indexed once per compile.
 *
 * The structure tree, the bay grid and the mini-map all need to answer "what did
 * this lane produce". Doing that by filtering `graph.bins` inside each row would be
 * O(lanes × bins) on every render, which stops being acceptable at the 100k-bin
 * target. This builds the index once, keyed on the graph's identity — and the graph
 * is cached on document identity, so it only changes when the layout recompiles.
 */
import { useMemo } from 'react';

import type { DerivedBay } from 'layout-core';

import { useDesignStore } from '../store/designStore';

export type LaneStats = {
  /** Every bay the lane is long enough to have, including gap and skipped ones. */
  bays: DerivedBay[];
  /** Bays that actually produce bins: inside a RACK run and not skipped. */
  activeBays: number;
  /** Bins produced, which is `activeBays × levels`. */
  bins: number;
  skipped: number;
};

const EMPTY: LaneStats = { bays: [], activeBays: 0, bins: 0, skipped: 0 };

export function useLaneStats(): Map<string, LaneStats> {
  const graph = useDesignStore((state) => state.graph);

  return useMemo(() => {
    const map = new Map<string, LaneStats>();

    const bucket = (laneCode: string): LaneStats => {
      const existing = map.get(laneCode);
      if (existing) return existing;
      const created: LaneStats = { bays: [], activeBays: 0, bins: 0, skipped: 0 };
      map.set(laneCode, created);
      return created;
    };

    // `graph.bays` is already grouped per lane and ordered by `seq`, so pushing in
    // order keeps each lane's list sorted without a second pass.
    for (const bay of graph.bays) {
      const stats = bucket(bay.laneCode);
      stats.bays.push(bay);
      if (bay.isSkipped) stats.skipped += 1;
      else if (bay.inRackRun) stats.activeBays += 1;
    }

    for (const bin of graph.bins) bucket(bin.laneCode).bins += 1;

    return map;
  }, [graph]);
}

export function laneStatsOf(stats: Map<string, LaneStats>, laneCode: string): LaneStats {
  return stats.get(laneCode) ?? EMPTY;
}
