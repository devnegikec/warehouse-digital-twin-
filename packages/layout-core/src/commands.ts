/**
 * Typed commands — the only way the document is ever mutated (P7).
 *
 * Why commands rather than direct mutation:
 *  - undo/redo falls out for free, because immer hands back forward and inverse patches;
 *  - components dispatch intent instead of reaching into state (P14);
 *  - every edit is a value that can be logged, replayed or (later) sent to a server.
 *
 * Recipes are pure and framework-free. They construct new entities *through the Zod
 * schemas*, so schema defaults are applied by the schema itself and there is no
 * second list of default values to keep in sync.
 *
 * Commands are deliberately **total**: a recipe does not refuse to create a layout
 * that is geometrically wrong. That is the validators' job (P6), so the user can
 * build a broken layout, see exactly what is wrong, and fix it in place. Recipes
 * only fail when the command itself is impossible — a missing target, or a payload
 * that violates the schema.
 */
import { enablePatches, produceWithPatches, type Draft, type Patch } from 'immer';
import { ZodError } from 'zod';

import { normalizeDoc } from './compile.js';
import { EPS } from './units.js';
import {
  AisleSchema,
  LaneSchema,
  LaneSegmentSchema,
  ObstacleSchema,
  RackLevelSchema,
  RackTypeSchema,
  WarehouseSchema,
  defaultLaneSegments,
  type Aisle,
  type AisleOrientation,
  type Centerline,
  type Lane,
  type LaneSegment,
  type LaneSide,
  type LayoutDoc,
  type Obstacle,
  type ObstacleKind,
  type RackLevel,
  type RackType,
  type TravelDirection,
} from './schema.js';

enablePatches();

// --- Context -----------------------------------------------------------------

export type CommandContext = {
  /** Injected so document ids stay deterministic in tests. */
  idFactory: () => string;
};

export const defaultCommandContext: CommandContext = {
  idFactory: () => globalThis.crypto.randomUUID(),
};

/** Deterministic ids, for tests and for reproducible fixtures. */
export function createSequentialIdFactory(prefix = 'id'): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return `${prefix}-${counter}`;
  };
}

// --- Command payloads --------------------------------------------------------

export type RackLevelInput = {
  clearHeightM: number;
  binDepthM: number;
  beamHeightM?: number;
  maxWeightKg?: number;
};

export type RackTypeInput = {
  id?: string;
  code: string;
  name?: string;
  bayWidthM: number;
  depthM: number;
  uprightWidthM?: number;
  uprightDepthM?: number;
};

export type LaneInput = {
  id?: string;
  code?: string;
  side: LaneSide;
  rackTypeId: string;
  startOffsetM?: number;
  lengthM: number;
  levels?: RackLevelInput[];
  segments?: LaneSegment[];
  skipBays?: number[];
  binCodePattern?: string;
};

export type AisleInput = {
  id?: string;
  code?: string;
  orientation: AisleOrientation;
  centerline: Centerline;
  widthM: number;
  travelDirection?: TravelDirection;
  lanes?: LaneInput[];
};

export type ObstacleInput = {
  id?: string;
  kind?: ObstacleKind;
  x: number;
  z: number;
  widthM: number;
  depthM: number;
  heightM: number;
};

export type Command =
  | { type: 'warehouse.update'; patch: Partial<Pick<LayoutDoc['warehouse'], 'name' | 'lengthM' | 'widthM' | 'heightM' | 'origin'>> }
  | { type: 'rackType.add'; rackType: RackTypeInput }
  | { type: 'rackType.update'; rackTypeId: string; patch: Partial<Omit<RackTypeInput, 'id'>> }
  | { type: 'rackType.remove'; rackTypeId: string }
  | { type: 'aisle.add'; aisle: AisleInput }
  | { type: 'aisle.update'; aisleId: string; patch: Partial<Omit<AisleInput, 'id' | 'lanes'>> }
  | { type: 'aisle.translate'; aisleId: string; deltaX: number; deltaZ: number }
  | { type: 'aisle.remove'; aisleId: string }
  | { type: 'lane.add'; aisleId: string; lane: LaneInput }
  | { type: 'lane.update'; laneId: string; patch: Partial<Omit<LaneInput, 'id' | 'levels' | 'segments'>> }
  | { type: 'lane.remove'; laneId: string }
  | { type: 'lane.setLevel'; laneId: string; levelIndex: number; patch: Partial<RackLevelInput> }
  | { type: 'lane.addLevel'; laneId: string; index?: number; level?: RackLevelInput }
  | { type: 'lane.removeLevel'; laneId: string; levelIndex: number }
  | { type: 'lane.setSegments'; laneId: string; segments: LaneSegment[] }
  | { type: 'lane.toggleSkipBay'; laneId: string; baySeq: number }
  | { type: 'obstacle.add'; obstacle: ObstacleInput }
  | { type: 'obstacle.update'; obstacleId: string; patch: Partial<Omit<ObstacleInput, 'id'>> }
  | { type: 'obstacle.remove'; obstacleId: string }
  | { type: 'document.replace'; doc: unknown };

export type CommandType = Command['type'];

/** Human-readable labels for undo/redo affordances. */
export const COMMAND_LABELS: Record<CommandType, string> = {
  'warehouse.update': 'Edit warehouse',
  'rackType.add': 'Add rack type',
  'rackType.update': 'Edit rack type',
  'rackType.remove': 'Delete rack type',
  'aisle.add': 'Add aisle',
  'aisle.update': 'Edit aisle',
  'aisle.translate': 'Move aisle',
  'aisle.remove': 'Delete aisle',
  'lane.add': 'Add lane',
  'lane.update': 'Edit lane',
  'lane.remove': 'Delete lane',
  'lane.setLevel': 'Edit level',
  'lane.addLevel': 'Add level',
  'lane.removeLevel': 'Delete level',
  'lane.setSegments': 'Edit lane runs',
  'lane.toggleSkipBay': 'Toggle bay',
  'obstacle.add': 'Add obstacle',
  'obstacle.update': 'Edit obstacle',
  'obstacle.remove': 'Delete obstacle',
  'document.replace': 'Load layout',
};

export type CommandOutcome = {
  ok: boolean;
  /** Unchanged when `ok` is false. */
  doc: LayoutDoc;
  patches: Patch[];
  inversePatches: Patch[];
  reason?: string;
};

// --- Defaults & lookups ------------------------------------------------------

export const DEFAULT_LEVEL_CLEAR_HEIGHT_M = 1.6;
export const DEFAULT_LEVEL_BIN_DEPTH_M = 1.0;

export function defaultLevel(): RackLevelInput {
  return { clearHeightM: DEFAULT_LEVEL_CLEAR_HEIGHT_M, binDepthM: DEFAULT_LEVEL_BIN_DEPTH_M };
}

/** Next free aisle code, e.g. `A04`. Read-only: accepts a draft or a plain document. */
export function nextAisleCode(
  doc: { aisles: ReadonlyArray<{ code: string }> },
  prefix = 'A',
): string {
  const taken = new Set(doc.aisles.map((aisle) => aisle.code));
  for (let n = 1; n < 10_000; n += 1) {
    const code = `${prefix}${String(n).padStart(2, '0')}`;
    if (!taken.has(code)) return code;
  }
  abort('Could not find a free aisle code');
}

/** Next free lane code within an aisle, e.g. `A03-L1`. */
export function nextLaneCode(
  aisle: { code: string; lanes: ReadonlyArray<{ code: string }> },
  side: LaneSide,
): string {
  const letter = side === 'LEFT' ? 'L' : 'R';
  const taken = new Set(aisle.lanes.map((lane) => lane.code));
  for (let n = 1; n < 1_000; n += 1) {
    const code = `${aisle.code}-${letter}${n}`;
    if (!taken.has(code)) return code;
  }
  abort('Could not find a free lane code');
}

class RecipeAbort extends Error {}

function abort(reason: string): never {
  throw new RecipeAbort(reason);
}

/**
 * Overwrite every own key of `target` with `source`, deleting keys that `source`
 * does not have.
 *
 * Plain `Object.assign` cannot do this: clearing an optional field (a level's
 * `maxWeightKg`, a segment's `label`) would leave the old value in place, so
 * "remove the weight limit" would silently do nothing.
 */
function replaceInPlace<T extends object>(target: T, source: T): void {
  for (const key of Object.keys(target)) {
    if (!(key in source)) delete (target as Record<string, unknown>)[key];
  }
  Object.assign(target, source);
}

function findAisle(doc: Draft<LayoutDoc>, aisleId: string, op: string): Draft<Aisle> {
  const aisle = doc.aisles.find((candidate) => candidate.id === aisleId);
  if (!aisle) abort(`No aisle with id '${aisleId}' (${op})`);
  return aisle;
}

function findLane(doc: Draft<LayoutDoc>, laneId: string, op: string): Draft<Lane> {
  for (const aisle of doc.aisles) {
    const lane = aisle.lanes.find((candidate) => candidate.id === laneId);
    if (lane) return lane;
  }
  abort(`No lane with id '${laneId}' (${op})`);
}

function findObstacle(doc: Draft<LayoutDoc>, obstacleId: string, op: string): Draft<Obstacle> {
  const obstacle = doc.obstacles.find((candidate) => candidate.id === obstacleId);
  if (!obstacle) abort(`No obstacle with id '${obstacleId}' (${op})`);
  return obstacle;
}

// --- Constructors (schema-validated, defaults applied by the schema) ---------

function makeRackType(input: RackTypeInput, ctx: CommandContext): RackType {
  return RackTypeSchema.parse({ ...input, id: input.id ?? ctx.idFactory() });
}

function makeLevel(input: RackLevelInput): RackLevel {
  return RackLevelSchema.parse(input);
}

function makeLane(
  input: LaneInput,
  aisle: { code: string; lanes: ReadonlyArray<{ code: string }> },
  ctx: CommandContext,
): Lane {
  const levels = (input.levels ?? [defaultLevel()]).map(makeLevel);
  return LaneSchema.parse({
    ...input,
    id: input.id ?? ctx.idFactory(),
    code: input.code ?? nextLaneCode(aisle, input.side),
    levels,
    // Materialized rather than left absent, so every lane in the document has
    // exactly one reading (see `defaultLaneSegments`).
    segments: input.segments ?? defaultLaneSegments(input.lengthM),
  });
}

function makeAisle(
  input: AisleInput,
  doc: { aisles: ReadonlyArray<{ code: string }> },
  ctx: CommandContext,
): Aisle {
  const code = input.code ?? nextAisleCode(doc);
  const id = input.id ?? ctx.idFactory();

  // Lane codes are derived from the aisle code, so the host has to accumulate
  // lanes as they are built — otherwise two lanes on the same side collide.
  const laneHost: { code: string; lanes: Lane[] } = { code, lanes: [] };
  const lanes = (input.lanes ?? []).map((lane) => {
    const built = makeLane(lane, laneHost, ctx);
    laneHost.lanes.push(built);
    return built;
  });

  return AisleSchema.parse({ ...input, id, code, lanes });
}

function makeObstacle(input: ObstacleInput, ctx: CommandContext): Obstacle {
  return ObstacleSchema.parse({ ...input, id: input.id ?? ctx.idFactory() });
}

/** Sorted, non-overlapping, and inside the lane run — the invariants the compiler assumes. */
function normaliseSegments(segments: LaneSegment[], laneLengthM: number, code: string): LaneSegment[] {
  const parsed = segments.map((segment) => LaneSegmentSchema.parse(segment));
  const sorted = [...parsed].sort((a, b) => a.startM - b.startM);

  for (let i = 0; i < sorted.length; i += 1) {
    const segment = sorted[i]!;
    if (segment.endM > laneLengthM + EPS) {
      abort(
        `Segment ending at ${segment.endM} m exceeds lane '${code}' which is ${laneLengthM} m long`,
      );
    }
    const previous = sorted[i - 1];
    if (previous && segment.startM < previous.endM - EPS) {
      abort(`Segments on lane '${code}' overlap at ${segment.startM} m`);
    }
  }
  return sorted;
}

/**
 * Shortening a lane must not leave segments hanging past its end, so they are
 * clamped and empty ones dropped. Preserving the invariant here means the editor
 * never has to defend against out-of-range segments.
 */
function clampSegments(segments: LaneSegment[], laneLengthM: number): LaneSegment[] {
  return segments
    .map((segment) => ({
      ...segment,
      startM: Math.min(segment.startM, laneLengthM),
      endM: Math.min(segment.endM, laneLengthM),
    }))
    .filter((segment) => segment.endM - segment.startM > EPS)
    .map((segment) => LaneSegmentSchema.parse(segment));
}

// --- Recipes -----------------------------------------------------------------

type Recipe<C extends Command> = (
  draft: Draft<LayoutDoc>,
  command: C,
  ctx: CommandContext,
) => void;

type RecipeMap = { [K in CommandType]: Recipe<Extract<Command, { type: K }>> };

const RECIPES: RecipeMap = {
  'warehouse.update': (draft, command) => {
    replaceInPlace(
      draft.warehouse,
      WarehouseSchema.parse({ ...draft.warehouse, ...command.patch }),
    );
  },

  'rackType.add': (draft, command, ctx) => {
    const rackType = makeRackType(command.rackType, ctx);
    if (draft.rackTypes.some((candidate) => candidate.id === rackType.id)) {
      abort(`Rack type id '${rackType.id}' already exists`);
    }
    draft.rackTypes.push(rackType);
  },

  'rackType.update': (draft, command) => {
    const rackType = draft.rackTypes.find((candidate) => candidate.id === command.rackTypeId);
    if (!rackType) abort(`No rack type with id '${command.rackTypeId}'`);
    replaceInPlace(rackType, RackTypeSchema.parse({ ...rackType, ...command.patch }));
  },

  'rackType.remove': (draft, command) => {
    const index = draft.rackTypes.findIndex((candidate) => candidate.id === command.rackTypeId);
    if (index < 0) abort(`No rack type with id '${command.rackTypeId}'`);
    draft.rackTypes.splice(index, 1);
    // Lanes referencing it are deliberately left alone: the validator reports
    // LANE_UNKNOWN_RACK_TYPE, and the user can see exactly which lanes are orphaned.
  },

  'aisle.add': (draft, command, ctx) => {
    const aisle = makeAisle(command.aisle, draft, ctx);
    if (draft.aisles.some((candidate) => candidate.id === aisle.id)) {
      abort(`Aisle id '${aisle.id}' already exists`);
    }
    draft.aisles.push(aisle);
  },

  'aisle.update': (draft, command) => {
    const aisle = findAisle(draft, command.aisleId, 'aisle.update');
    // `patch` cannot contain `lanes`, so this only touches the aisle itself.
    replaceInPlace(aisle, AisleSchema.parse({ ...aisle, ...command.patch }));
  },

  'aisle.translate': (draft, command) => {
    const aisle = findAisle(draft, command.aisleId, 'aisle.translate');
    aisle.centerline.x1 += command.deltaX;
    aisle.centerline.x2 += command.deltaX;
    aisle.centerline.z1 += command.deltaZ;
    aisle.centerline.z2 += command.deltaZ;
  },

  'aisle.remove': (draft, command) => {
    const index = draft.aisles.findIndex((candidate) => candidate.id === command.aisleId);
    if (index < 0) abort(`No aisle with id '${command.aisleId}'`);
    draft.aisles.splice(index, 1);
  },

  'lane.add': (draft, command, ctx) => {
    const aisle = findAisle(draft, command.aisleId, 'lane.add');
    const lane = makeLane(command.lane, aisle, ctx);
    if (aisle.lanes.some((candidate) => candidate.id === lane.id)) {
      abort(`Lane id '${lane.id}' already exists`);
    }
    // Array order is the lane order; there is no separate seq to maintain.
    aisle.lanes.push(lane);
  },

  'lane.update': (draft, command) => {
    const lane = findLane(draft, command.laneId, 'lane.update');
    const merged = LaneSchema.parse({ ...lane, ...command.patch });
    if (merged.id !== lane.id) abort('A lane id cannot be changed');
    if (command.patch.lengthM !== undefined) {
      merged.segments = clampSegments(
        merged.segments ?? [{ kind: 'RACK', startM: 0, endM: merged.lengthM }],
        merged.lengthM,
      );
    }
    replaceInPlace(lane, merged);
  },

  'lane.remove': (draft, command) => {
    for (const aisle of draft.aisles) {
      const index = aisle.lanes.findIndex((candidate) => candidate.id === command.laneId);
      if (index >= 0) {
        aisle.lanes.splice(index, 1);
        return;
      }
    }
    abort(`No lane with id '${command.laneId}'`);
  },

  'lane.setLevel': (draft, command) => {
    const lane = findLane(draft, command.laneId, 'lane.setLevel');
    const level = lane.levels[command.levelIndex];
    if (!level) abort(`Lane '${lane.code}' has no level ${command.levelIndex}`);
    replaceInPlace(level, RackLevelSchema.parse({ ...level, ...command.patch }));
  },

  'lane.addLevel': (draft, command) => {
    const lane = findLane(draft, command.laneId, 'lane.addLevel');
    const level = makeLevel(command.level ?? defaultLevel());
    const index = command.index ?? lane.levels.length;
    if (index < 0 || index > lane.levels.length) {
      abort(`Cannot insert a level at index ${index} on lane '${lane.code}'`);
    }
    lane.levels.splice(index, 0, level);
  },

  'lane.removeLevel': (draft, command) => {
    const lane = findLane(draft, command.laneId, 'lane.removeLevel');
    if (lane.levels.length <= 1) abort(`Lane '${lane.code}' must keep at least one level`);
    if (!lane.levels[command.levelIndex]) {
      abort(`Lane '${lane.code}' has no level ${command.levelIndex}`);
    }
    lane.levels.splice(command.levelIndex, 1);
  },

  'lane.setSegments': (draft, command) => {
    const lane = findLane(draft, command.laneId, 'lane.setSegments');
    // An empty list is not "no runs" — `normalizeDoc` reads it as "one continuous run"
    // and materializes that on the next round trip through the wire. Allowing it would
    // give one document two readings, and two hashes, depending on whether it had been
    // saved and reloaded. Refused at the source instead.
    if (command.segments.length === 0) {
      abort(`Lane '${lane.code}' needs at least one run`);
    }
    lane.segments = normaliseSegments(command.segments, lane.lengthM, lane.code);
  },

  'lane.toggleSkipBay': (draft, command) => {
    const lane = findLane(draft, command.laneId, 'lane.toggleSkipBay');
    if (command.baySeq < 1) abort(`Bay numbers are 1-based; received ${command.baySeq}`);
    const existing = lane.skipBays.indexOf(command.baySeq);
    if (existing >= 0) lane.skipBays.splice(existing, 1);
    else lane.skipBays.push(command.baySeq);
    lane.skipBays.sort((a, b) => a - b);
  },

  'obstacle.add': (draft, command, ctx) => {
    const obstacle = makeObstacle(command.obstacle, ctx);
    if (draft.obstacles.some((candidate) => candidate.id === obstacle.id)) {
      abort(`Obstacle id '${obstacle.id}' already exists`);
    }
    draft.obstacles.push(obstacle);
  },

  'obstacle.update': (draft, command) => {
    const obstacle = findObstacle(draft, command.obstacleId, 'obstacle.update');
    replaceInPlace(obstacle, ObstacleSchema.parse({ ...obstacle, ...command.patch }));
  },

  'obstacle.remove': (draft, command) => {
    const index = draft.obstacles.findIndex((candidate) => candidate.id === command.obstacleId);
    if (index < 0) abort(`No obstacle with id '${command.obstacleId}'`);
    draft.obstacles.splice(index, 1);
  },

  'document.replace': (draft, command) => {
    // Normalized, not just parsed: everything entering the document must be in
    // normalized form, including implicit lane segments.
    const next = normalizeDoc(command.doc);
    draft.schemaVersion = next.schemaVersion;
    draft.warehouse = next.warehouse;
    draft.obstacles = next.obstacles;
    draft.rackTypes = next.rackTypes;
    draft.aisles = next.aisles;
  },
};

// --- Application -------------------------------------------------------------

/**
 * Apply a command, returning the new document plus forward and inverse patches.
 * Never throws for an impossible command; inspect `ok` and `reason` instead.
 */
export function applyCommand(
  doc: LayoutDoc,
  command: Command,
  ctx: CommandContext = defaultCommandContext,
): CommandOutcome {
  const recipe = RECIPES[command.type] as Recipe<Command> | undefined;
  if (!recipe) {
    return {
      ok: false,
      doc,
      patches: [],
      inversePatches: [],
      reason: `Unknown command '${String(command.type)}'`,
    };
  }

  try {
    const [next, patches, inversePatches] = produceWithPatches(doc, (draft) => {
      recipe(draft as Draft<LayoutDoc>, command, ctx);
    });
    return { ok: true, doc: next, patches, inversePatches };
  } catch (error) {
    if (error instanceof RecipeAbort) {
      return { ok: false, doc, patches: [], inversePatches: [], reason: error.message };
    }
    if (error instanceof ZodError) {
      const issue = error.issues[0];
      const path = issue?.path.join('.');
      return {
        ok: false,
        doc,
        patches: [],
        inversePatches: [],
        reason: `Invalid ${command.type}${path ? ` (${path})` : ''}: ${issue?.message ?? 'schema error'}`,
      };
    }
    throw error;
  }
}

/** Typed helper for building a command without repeating its discriminant. */
export function command<C extends Command>(value: C): C {
  return value;
}
