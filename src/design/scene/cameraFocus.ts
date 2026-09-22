/**
 * Camera focus: turning an `EntityRef` into a point worth looking at.
 *
 * `entityRefs` are what makes this possible without prose. A validator says
 * "BAY_OBSTACLE_OVERLAP on lane a-3-l, bay 7" instead of "something overlaps
 * something" (P6), so the editor can put the camera on the bay that is actually
 * wrong, whether or not it is currently on screen.
 *
 * The bus exists because the R3F `<Canvas>` renders into its own React root: it
 * cannot receive props or context from the panel tree that the diagnostics live in,
 * so a module-level subscription is the only channel between them.
 */
import type { EntityRef, LayoutGraph, Lane, Aisle } from 'layout-core';

export type FocusTarget = {
  x: number;
  y: number;
  z: number;
  /** Half-extent of the subject, used to pick a viewing distance. */
  radius: number;
};

type Listener = (target: FocusTarget) => void;

const listeners = new Set<Listener>();

export function requestFocus(target: FocusTarget): void {
  for (const listener of listeners) listener(target);
}

export function subscribeFocus(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// --- Resolution --------------------------------------------------------------

/**
 * The most specific entity among a diagnostic's refs.
 *
 * A rule like BAY_OBSTACLE_OVERLAP cites the lane *and* the bay *and* the obstacle.
 * Selecting the lane would lose the bay, so the narrowest entity wins.
 */
const SPECIFICITY: EntityRef['kind'][] = [
  'bin',
  'bay',
  'level',
  'lane',
  'aisle',
  'obstacle',
  'rackType',
  'warehouse',
];

export function mostSpecificRef(refs: EntityRef[]): EntityRef | null {
  if (refs.length === 0) return null;
  return [...refs].sort(
    (a, b) => SPECIFICITY.indexOf(a.kind) - SPECIFICITY.indexOf(b.kind),
  )[0]!;
}

/** Entity refs for bay and level carry `${laneId}:${n}`, so the lane is the prefix. */
function laneFromRefId(doc: LayoutGraph['doc'], refId: string): { aisle: Aisle; lane: Lane } | null {
  const laneId = refId.includes(':') ? refId.slice(0, refId.lastIndexOf(':')) : refId;
  for (const aisle of doc.aisles) {
    const lane = aisle.lanes.find((candidate) => candidate.id === laneId);
    if (lane) return { aisle, lane };
  }
  return null;
}

function indexFromRefId(refId: string): number | null {
  const tail = refId.includes(':') ? refId.slice(refId.lastIndexOf(':') + 1) : '';
  const parsed = Number(tail);
  return Number.isInteger(parsed) ? parsed : null;
}

/** Centre and extent of a lane's racking, taken from the bays the compiler derived. */
function laneFocus(graph: LayoutGraph, lane: Lane, aisle: Aisle): FocusTarget {
  const bays = graph.bays.filter((bay) => bay.laneCode === lane.code);

  if (bays.length > 0) {
    const minX = Math.min(...bays.map((bay) => bay.center.x));
    const maxX = Math.max(...bays.map((bay) => bay.center.x));
    const minZ = Math.min(...bays.map((bay) => bay.center.z));
    const maxZ = Math.max(...bays.map((bay) => bay.center.z));
    return {
      x: (minX + maxX) / 2,
      y: 2,
      z: (minZ + maxZ) / 2,
      radius: Math.max(Math.hypot(maxX - minX, maxZ - minZ) / 2, 3),
    };
  }

  // A lane with no bays (too short, or all gaps) has no derived geometry to point at.
  return aisleFocus(aisle, graph);
}

function aisleFocus(aisle: Aisle, graph: LayoutGraph): FocusTarget {
  const bays = graph.bays.filter((bay) => bay.aisleCode === aisle.code);
  if (bays.length > 0) {
    const minX = Math.min(...bays.map((bay) => bay.center.x));
    const maxX = Math.max(...bays.map((bay) => bay.center.x));
    const minZ = Math.min(...bays.map((bay) => bay.center.z));
    const maxZ = Math.max(...bays.map((bay) => bay.center.z));
    return {
      x: (minX + maxX) / 2,
      y: 2,
      z: (minZ + maxZ) / 2,
      radius: Math.max(Math.hypot(maxX - minX, maxZ - minZ) / 2, 4),
    };
  }

  const { centerline } = aisle;
  return {
    x: (centerline.x1 + centerline.x2) / 2,
    y: 2,
    z: (centerline.z1 + centerline.z2) / 2,
    radius: Math.max(
      Math.hypot(centerline.x2 - centerline.x1, centerline.z2 - centerline.z1) / 2,
      4,
    ),
  };
}

export function resolveFocus(graph: LayoutGraph, ref: EntityRef): FocusTarget | null {
  // The graph carries the *normalized* document — schema defaults applied. Taking it
  // from here rather than as a second argument means callers cannot hand over a raw
  // document, which is what would otherwise make `warehouse.origin` undefined.
  const { doc } = graph;
  const { warehouse } = doc;

  switch (ref.kind) {
    case 'warehouse':
    case 'rackType':
      return {
        x: warehouse.origin.x + warehouse.lengthM / 2,
        y: warehouse.heightM / 3,
        z: warehouse.origin.z + warehouse.widthM / 2,
        radius: Math.hypot(warehouse.lengthM, warehouse.widthM) / 2,
      };

    case 'obstacle': {
      const obstacle = doc.obstacles.find((candidate) => candidate.id === ref.id);
      if (!obstacle) return null;
      return {
        x: obstacle.x + obstacle.widthM / 2,
        y: obstacle.heightM / 2,
        z: obstacle.z + obstacle.depthM / 2,
        radius: Math.max(obstacle.widthM, obstacle.depthM, 2),
      };
    }

    case 'aisle': {
      const aisle = doc.aisles.find((candidate) => candidate.id === ref.id);
      return aisle ? aisleFocus(aisle, graph) : null;
    }

    case 'lane': {
      const hit = laneFromRefId(doc, ref.id);
      return hit ? laneFocus(graph, hit.lane, hit.aisle) : null;
    }

    case 'bay': {
      const hit = laneFromRefId(doc, ref.id);
      const seq = indexFromRefId(ref.id);
      if (!hit || seq === null) return null;
      const bay = graph.bays.find(
        (candidate) => candidate.laneCode === hit.lane.code && candidate.seq === seq,
      );
      if (!bay) return laneFocus(graph, hit.lane, hit.aisle);
      return { x: bay.center.x, y: 1.5, z: bay.center.z, radius: Math.max(bay.widthM, 2) };
    }

    case 'level': {
      const hit = laneFromRefId(doc, ref.id);
      const levelIndex = indexFromRefId(ref.id);
      if (!hit || levelIndex === null) return null;
      // Stand at the height the level sits at, so an over-height stack is obvious.
      let y = 0;
      for (let index = 0; index <= levelIndex; index += 1) {
        const level = hit.lane.levels[index];
        if (!level) break;
        y += level.beamHeightM + level.clearHeightM;
      }
      const base = laneFocus(graph, hit.lane, hit.aisle);
      return { ...base, y: Math.max(y - 0.7, 1) };
    }

    case 'bin': {
      const bin = graph.bins.find((candidate) => candidate.code === ref.id);
      if (!bin) return null;
      return {
        x: bin.center.x,
        y: bin.center.y,
        z: bin.center.z,
        radius: Math.max(bin.widthM, bin.heightM, bin.depthM, 1.5) * 2,
      };
    }

    default:
      return null;
  }
}
