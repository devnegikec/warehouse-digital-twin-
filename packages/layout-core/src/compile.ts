/**
 * The layout compiler (P2).
 *
 *   buildLayout(doc) -> bins + diagnostics + doc_hash
 *
 * Pure and deterministic: the same document always produces the same bins and the
 * same hash. Nothing here touches three.js, React, the DOM, or the database.
 *
 * A Python mirror lives in `server/app/layout/compile.py`. The two are pinned
 * together by `fixtures/layout-conformance/`, which both test suites run (P9).
 *
 * Note: validation shares this single pass rather than being a separate traversal,
 * because every geometric rule needs the compiled geometry anyway. `validateLayout`
 * is the read-only facade over it, used by the `/validate` endpoint.
 */
import { itemFits, usableVolumeM3 } from './capacity.js';
import { docHash } from './canonical.js';
import { DiagnosticCollector, type Diagnostic, type EntityRef } from './diagnostics.js';
import {
  EPS,
  MIN_AISLE_WIDTH_M,
  round,
} from './units.js';
import {
  aabb,
  aabbContains,
  aabbOverlaps,
  findOverlappingPairs,
  isAxisAligned,
  normalize2,
  orientedRectAABB,
  perpendicularLeft,
  perpendicularRight,
  type AABB,
  type RectWithKey,
  type Vec2,
} from './geometry.js';
import { formatBinCode } from './ids.js';
import {
  LayoutDocSchema,
  defaultLaneSegments,
  type Aisle,
  type Lane,
  type LaneSegment,
  type LaneSide,
  type LayoutDoc,
} from './schema.js';

// --- Output types ------------------------------------------------------------

/**
 * A lane after normalization: `segments` is guaranteed present, so the compiler
 * never has to defend against `undefined` in its inner loops.
 */
export type NormalizedLane = Lane & { segments: LaneSegment[] };

export type NormalizedAisle = Omit<Aisle, 'lanes'> & { lanes: NormalizedLane[] };

export type NormalizedDoc = Omit<LayoutDoc, 'aisles'> & { aisles: NormalizedAisle[] };

/**
 * A derived bin. `id` is intentionally absent: the database assigns a surrogate
 * UUID and keys upserts on `code` (P3).
 */
export type DerivedBin = {
  code: string;
  warehouseCode: string;
  aisleCode: string;
  laneCode: string;
  side: LaneSide;
  /** 1-based, as humans count. */
  baySeq: number;
  /** 0-based; codes render `L{levelIndex + 1}`. */
  levelIndex: number;
  center: { x: number; y: number; z: number };
  /** Local width, measured along the lane run. */
  widthM: number;
  heightM: number;
  /** Local depth, measured perpendicular to the lane run. */
  depthM: number;
  /** 0 when the aisle runs along X, 90 when along Z. */
  rotationDeg: number;
  /** Usable volume, utilization factor already applied. */
  capacityM3: number;
  maxWeightKg: number | null;
};

export type DerivedBay = {
  aisleCode: string;
  laneCode: string;
  seq: number;
  /** Author explicitly reserved this bay. */
  isSkipped: boolean;
  /** False when the bay falls inside a GAP segment or past the end of every RACK run. */
  inRackRun: boolean;
  center: { x: number; z: number };
  widthM: number;
  depthM: number;
  rotationDeg: number;
};

export type LayoutGraph = {
  /** The document with all schema and structural defaults applied. */
  doc: NormalizedDoc;
  bins: DerivedBin[];
  bays: DerivedBay[];
  /** sha256 of the canonical form of `doc`. Identical in TS and Python. */
  hash: string;
  diagnostics: Diagnostic[];
  errorCount: number;
  warningCount: number;
  /** True when the layout may be published. */
  publishable: boolean;
};

// --- Normalisation -----------------------------------------------------------

/**
 * Parse and apply structural defaults. Hashing happens on this output, never on
 * raw input, so "segments omitted" and "segments spelled out" hash identically.
 */
export function normalizeDoc(input: unknown): NormalizedDoc {
  const parsed = LayoutDocSchema.parse(input);

  return {
    ...parsed,
    aisles: parsed.aisles.map((aisle) => ({
      ...aisle,
      lanes: aisle.lanes.map((lane) => ({
        ...lane,
        segments:
          lane.segments && lane.segments.length > 0
            ? lane.segments
            : defaultLaneSegments(lane.lengthM),
      })),
    })),
  };
}

// --- Compiler ----------------------------------------------------------------

export function buildLayout(input: unknown): LayoutGraph {
  const doc = normalizeDoc(input);
  const diagnostics = new DiagnosticCollector();
  const { warehouse } = doc;

  const bins: DerivedBin[] = [];
  const bays: DerivedBay[] = [];
  const bayRects: RectWithKey[] = [];
  const codeCounts = new Map<string, number>();
  /** First lane that produced each code, so a duplicate can point at a real entity. */
  const codeFirstSeen = new Map<string, EntityRef>();

  const footprint: AABB = aabb(
    warehouse.origin.x,
    warehouse.origin.z,
    warehouse.origin.x + warehouse.lengthM,
    warehouse.origin.z + warehouse.widthM,
  );
  const warehouseRef: EntityRef = { kind: 'warehouse', id: warehouse.id ?? warehouse.code, label: warehouse.code };

  const rackTypeById = new Map(doc.rackTypes.map((r) => [r.id, r]));
  if (doc.rackTypes.length === 0 && doc.aisles.some((a) => a.lanes.length > 0)) {
    diagnostics.error('NO_RACK_TYPES_DEFINED', 'Aisles have lanes but the document defines no rack types', [warehouseRef]);
  }

  const obstacleRects = doc.obstacles.map((obstacle) => ({
    obstacle,
    rect: aabb(obstacle.x, obstacle.z, obstacle.x + obstacle.widthM, obstacle.z + obstacle.depthM),
  }));

  const seenAisleCodes = new Set<string>();

  for (const aisle of doc.aisles) {
    const aisleRef: EntityRef = { kind: 'aisle', id: aisle.id, label: aisle.code };

    if (seenAisleCodes.has(aisle.code)) {
      diagnostics.error('AISLE_CODE_DUPLICATE', `Aisle code '${aisle.code}' is used more than once`, [aisleRef]);
    }
    seenAisleCodes.add(aisle.code);

    const delta = {
      x: aisle.centerline.x2 - aisle.centerline.x1,
      z: aisle.centerline.z2 - aisle.centerline.z1,
    };
    const forward = normalize2(delta);
    if (!forward) {
      diagnostics.error('AISLE_ZERO_LENGTH', `Aisle '${aisle.code}' has a zero-length centerline`, [aisleRef]);
      continue;
    }
    if (!isAxisAligned(forward)) {
      diagnostics.error(
        'AISLE_NOT_AXIS_ALIGNED',
        `Aisle '${aisle.code}' must run exactly along X or Z; v1 does not support diagonal aisles`,
        [aisleRef],
      );
      continue;
    }

    const derivedOrientation = Math.abs(forward.x) > Math.abs(forward.z) ? 'X' : 'Z';
    if (derivedOrientation !== aisle.orientation) {
      diagnostics.error(
        'AISLE_ORIENTATION_MISMATCH',
        `Aisle '${aisle.code}' declares orientation '${aisle.orientation}' but its centerline runs along ${derivedOrientation}`,
        [aisleRef],
        { declared: aisle.orientation, derived: derivedOrientation },
      );
    }

    if (aisle.widthM < MIN_AISLE_WIDTH_M) {
      diagnostics.warn(
        'AISLE_TOO_NARROW',
        `Aisle '${aisle.code}' is ${round(aisle.widthM)} m wide; under ${MIN_AISLE_WIDTH_M} m is tight for a counterbalance forklift`,
        [aisleRef],
      );
    }

    if (aisle.lanes.length === 0) {
      diagnostics.warn('AISLE_WITHOUT_LANES', `Aisle '${aisle.code}' has no lanes`, [aisleRef]);
    }

    const aisleLength = Math.hypot(delta.x, delta.z);
    const origin: Vec2 = { x: aisle.centerline.x1, z: aisle.centerline.z1 };
    const perpLeft = perpendicularLeft(forward);
    const halfWidth = aisle.widthM / 2;

    // Corridor footprint checks
    const corridor = orientedRectAABB(origin, forward, perpLeft, 0, aisleLength, -halfWidth, halfWidth);
    if (!aabbContains(footprint, corridor)) {
      diagnostics.error('AISLE_OUT_OF_FOOTPRINT', `Aisle '${aisle.code}' extends beyond the warehouse footprint`, [aisleRef]);
    }
    for (const { obstacle, rect } of obstacleRects) {
      if (aabbOverlaps(corridor, rect)) {
        diagnostics.error(
          'AISLE_OBSTACLE_OVERLAP',
          `Aisle '${aisle.code}' intersects obstacle '${obstacle.id}'`,
          [aisleRef, { kind: 'obstacle', id: obstacle.id, label: obstacle.kind }],
        );
      }
    }

    for (const lane of aisle.lanes) {
      const laneRef: EntityRef = { kind: 'lane', id: lane.id, label: lane.code };

      const rackType = rackTypeById.get(lane.rackTypeId);
      if (!rackType) {
        diagnostics.error(
          'LANE_UNKNOWN_RACK_TYPE',
          `Lane '${lane.code}' references unknown rack type '${lane.rackTypeId}'`,
          [laneRef],
        );
        continue;
      }

      if (lane.startOffsetM + lane.lengthM > aisleLength + EPS) {
        diagnostics.error(
          'LANE_RUN_EXCEEDS_AISLE',
          `Lane '${lane.code}' runs ${round(lane.startOffsetM + lane.lengthM)} m but aisle '${aisle.code}' is only ${round(aisleLength)} m long`,
          [laneRef, aisleRef],
        );
      }

      let stackHeight = 0;
      lane.levels.forEach((level, levelIndex) => {
        if (level.binDepthM > rackType.depthM + EPS) {
          diagnostics.warn(
            'LEVEL_DEPTH_EXCEEDS_RACK',
            `Level ${levelIndex + 1} of lane '${lane.code}' is ${round(level.binDepthM)} m deep but rack type '${rackType.code}' is ${round(rackType.depthM)} m deep`,
            [laneRef, { kind: 'level', id: `${lane.id}:${levelIndex}`, label: `L${levelIndex + 1}` }],
          );
        }
        stackHeight += level.beamHeightM + level.clearHeightM;
      });

      if (stackHeight > warehouse.heightM + EPS) {
        diagnostics.error(
          'LEVEL_STACK_EXCEEDS_HEIGHT',
          `Lane '${lane.code}' stacks to ${round(stackHeight)} m but the warehouse is ${round(warehouse.heightM)} m tall`,
          [laneRef, warehouseRef],
          { stackHeightM: round(stackHeight), warehouseHeightM: warehouse.heightM },
        );
      }

      const perp = lane.side === 'LEFT' ? perpLeft : perpendicularRight(forward);
      const laneOffset = halfWidth + rackType.depthM / 2;
      const rotationDeg = derivedOrientation === 'X' ? 0 : 90;

      const bayCount = Math.floor((lane.lengthM + EPS) / rackType.bayWidthM);
      if (bayCount === 0) {
        diagnostics.warn(
          'LANE_ZERO_BAYS',
          `Lane '${lane.code}' is shorter than one ${round(rackType.bayWidthM)} m bay`,
          [laneRef],
        );
        continue;
      }

      const rackSegments = lane.segments.filter((s) => s.kind === 'RACK');
      if (rackSegments.length === 0) {
        diagnostics.warn('LANE_HAS_NO_RACK_SEGMENT', `Lane '${lane.code}' has no RACK segment, so it produces no bins`, [laneRef]);
      }

      for (let b = 0; b < bayCount; b++) {
        const baySeq = b + 1;
        const centerAlong = (b + 0.5) * rackType.bayWidthM;
        const inRackRun = rackSegments.some(
          (s) => centerAlong >= s.startM - EPS && centerAlong <= s.endM + EPS,
        );
        const isSkipped = lane.skipBays.includes(baySeq);

        const cx = origin.x + forward.x * (lane.startOffsetM + centerAlong) + perp.x * laneOffset;
        const cz = origin.z + forward.z * (lane.startOffsetM + centerAlong) + perp.z * laneOffset;

        bays.push({
          aisleCode: aisle.code,
          laneCode: lane.code,
          seq: baySeq,
          isSkipped,
          inRackRun,
          center: { x: round(cx), z: round(cz) },
          widthM: rackType.bayWidthM,
          depthM: rackType.depthM,
          rotationDeg,
        });

        const halfAlong = rackType.bayWidthM / 2;
        const bayRect = orientedRectAABB(
          origin,
          forward,
          perp,
          lane.startOffsetM + centerAlong - halfAlong,
          lane.startOffsetM + centerAlong + halfAlong,
          laneOffset - rackType.depthM / 2,
          laneOffset + rackType.depthM / 2,
        );
        bayRects.push({ rect: bayRect, key: `${aisle.code}/${lane.code}` });

        if (!inRackRun || isSkipped) continue;

        if (!aabbContains(footprint, bayRect)) {
          diagnostics.error(
            'BIN_OUT_OF_FOOTPRINT',
            `Bay ${baySeq} of lane '${lane.code}' extends beyond the warehouse footprint`,
            [laneRef, { kind: 'bay', id: `${lane.id}:${baySeq}`, label: `B${baySeq}` }],
          );
        }

        for (const { obstacle, rect } of obstacleRects) {
          if (aabbOverlaps(bayRect, rect)) {
            diagnostics.error(
              'BAY_OBSTACLE_OVERLAP',
              `Bay ${baySeq} of lane '${lane.code}' collides with obstacle '${obstacle.id}'`,
              [laneRef, { kind: 'obstacle', id: obstacle.id, label: obstacle.kind }],
              { baySeq },
            );
          }
        }

        let y = 0;
        lane.levels.forEach((level, levelIndex) => {
          const bottom = y + level.beamHeightM;
          const centerY = bottom + level.clearHeightM / 2;
          y = bottom + level.clearHeightM;

          const code = formatBinCode(lane.binCodePattern, {
            warehouse: warehouse.code,
            aisle: aisle.code,
            lane: lane.code,
            side: lane.side,
            baySeq,
            levelIndex,
          });

          const count = (codeCounts.get(code) ?? 0) + 1;
          codeCounts.set(code, count);
          if (!codeFirstSeen.has(code)) codeFirstSeen.set(code, laneRef);

          bins.push({
            code,
            warehouseCode: warehouse.code,
            aisleCode: aisle.code,
            laneCode: lane.code,
            side: lane.side,
            baySeq,
            levelIndex,
            center: { x: round(cx), y: round(centerY), z: round(cz) },
            widthM: rackType.bayWidthM,
            heightM: level.clearHeightM,
            depthM: level.binDepthM,
            rotationDeg,
            capacityM3: usableVolumeM3(rackType.bayWidthM, level.clearHeightM, level.binDepthM),
            maxWeightKg: level.maxWeightKg ?? null,
          });
        });
      }
    }
  }

  // Reported after the full pass so each offending code is named once, with its
  // total count, rather than once per colliding bin. Sorted by code so the output
  // is deterministic (plain code-unit comparison, matching Python's `sorted`).
  const duplicateCodes = [...codeCounts.entries()]
    .filter(([, count]) => count > 1)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  for (const [code, count] of duplicateCodes) {
    diagnostics.error(
      'BIN_CODE_DUPLICATE',
      `Bin code '${code}' is produced ${count} times; the lane bin code pattern is not unique enough`,
      [codeFirstSeen.get(code) ?? warehouseRef],
      { code, count },
    );
  }

  // Lanes that occupy the same floor space — catches aisles placed too close.
  for (const { a, b } of findOverlappingPairs(bayRects)) {
    diagnostics.error(
      'LANE_OVERLAP',
      `Lanes '${a}' and '${b}' occupy overlapping floor space`,
      [
        { kind: 'lane', id: a, label: a },
        { kind: 'lane', id: b, label: b },
      ],
    );
  }

  const all = diagnostics.all();

  return {
    doc,
    bins,
    bays,
    hash: docHash(doc),
    diagnostics: all,
    errorCount: all.filter((d) => d.severity === 'error').length,
    warningCount: all.filter((d) => d.severity === 'warning').length,
    publishable: !all.some((d) => d.severity === 'error'),
  };
}

/**
 * Read-only facade for the `/validate` endpoint: runs the same single pass and
 * discards the geometry. Guarantees the editor and the server agree, because
 * there is only one implementation of the rules per language.
 */
export function validateLayout(input: unknown): Diagnostic[] {
  return buildLayout(input).diagnostics;
}

/** Highest-stack check for a single lane, used by the level editor's inline error. */
export function laneStackHeightM(levels: Array<{ clearHeightM: number; beamHeightM: number }>): number {
  return round(levels.reduce((total, level) => total + level.beamHeightM + level.clearHeightM, 0));
}

export { itemFits };
