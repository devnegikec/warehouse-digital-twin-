/**
 * The wire contract for `LayoutDoc`, expressed with Zod (P9 / §6).
 *
 * This file is the authored source; `scripts/gen-schema.ts` emits
 * `schema/layout-doc.v1.json` from it, and the Python side validates incoming
 * documents against that emitted file. Never hand-edit the JSON.
 */
import { z } from 'zod';
import { DEFAULT_BIN_CODE_PATTERN, isValidCodePattern } from './ids.js';

type NumOpts = { positive?: boolean; nonnegative?: boolean; int?: boolean };

/**
 * JSON cannot carry NaN or Infinity, but programmatic callers can, and those
 * values would poison the canonical hash. Every numeric field goes through here.
 */
function num(opts: NumOpts = {}) {
  let schema = z.number();
  if (opts.int) schema = schema.int();
  if (opts.positive) schema = schema.positive();
  else if (opts.nonnegative) schema = schema.nonnegative();
  return schema.refine((n) => Number.isFinite(n), { message: 'Must be a finite number' });
}

const metadata = () => z.record(z.string(), z.unknown()).default(() => ({}));

export const LaneSideSchema = z.enum(['LEFT', 'RIGHT']);
export const AisleOrientationSchema = z.enum(['X', 'Z']);
export const TravelDirectionSchema = z.enum(['BOTH', 'FORWARD', 'REVERSE']);
export const ObstacleKindSchema = z.enum(['COLUMN', 'PILLAR', 'WALL', 'OFFICE', 'CUSTOM']);
export const SegmentKindSchema = z.enum(['RACK', 'GAP']);

export const RackLevelSchema = z.object({
  /** Usable opening height of this level. */
  clearHeightM: num({ positive: true }),
  /** Usable depth of this level. Per-level, not per-rack (locked decision §1 row 4). */
  binDepthM: num({ positive: true }),
  /** Structural beam thickness under this level. */
  beamHeightM: num({ nonnegative: true }).default(0.08),
  /** Beam UDL for this level — enforced during placement (locked decision §1 row 13). */
  maxWeightKg: num({ positive: true }).optional(),
});

export const RackTypeSchema = z.object({
  id: z.string().min(1),
  code: z.string().min(1),
  name: z.string().default(''),
  bayWidthM: num({ positive: true }),
  depthM: num({ positive: true }),
  uprightWidthM: num({ positive: true }).default(0.12),
  uprightDepthM: num({ positive: true }).default(0.12),
  metadata: metadata(),
});

export const LaneSegmentSchema = z
  .object({
    kind: SegmentKindSchema,
    startM: num({ nonnegative: true }),
    endM: num({ positive: true }),
    label: z.string().optional(),
  })
  .refine((s) => s.endM > s.startM, { message: 'Lane segment endM must be greater than startM' });

export const CenterlineSchema = z.object({
  x1: num(),
  z1: num(),
  x2: num(),
  z2: num(),
});

export const LaneSchema = z.object({
  id: z.string().min(1),
  code: z.string().min(1),
  side: LaneSideSchema,
  rackTypeId: z.string().min(1),
  /** Where the rack run begins, measured along the aisle from its centerline start. */
  startOffsetM: num({ nonnegative: true }).default(0),
  lengthM: num({ positive: true }),
  levels: z.array(RackLevelSchema).min(1),
  /** Omitted means one continuous RACK run covering `lengthM`. */
  segments: z.array(LaneSegmentSchema).optional(),
  /** 1-based bay numbers to leave empty (reserved / damaged / blocked). */
  skipBays: z.array(num({ int: true, positive: true })).default(() => []),
  binCodePattern: z
    .string()
    .refine(isValidCodePattern, {
      message:
        'Bin code pattern must contain at least one placeholder and only use ' +
        '{warehouse} {aisle} {lane} {side} {bay} {level}',
    })
    .default(DEFAULT_BIN_CODE_PATTERN),
  metadata: metadata(),
});

export const AisleSchema = z.object({
  id: z.string().min(1),
  code: z.string().min(1),
  /** Denormalised hint. The compiler derives orientation from `centerline` and errors on mismatch. */
  orientation: AisleOrientationSchema,
  centerline: CenterlineSchema,
  /** Clear corridor width between the two rack faces. */
  widthM: num({ positive: true }),
  travelDirection: TravelDirectionSchema.default('BOTH'),
  lanes: z.array(LaneSchema).default(() => []),
  metadata: metadata(),
});

export const ObstacleSchema = z.object({
  id: z.string().min(1),
  kind: ObstacleKindSchema.default('CUSTOM'),
  /** Minimum corner. */
  x: num(),
  z: num(),
  widthM: num({ positive: true }),
  depthM: num({ positive: true }),
  heightM: num({ positive: true }),
  metadata: metadata(),
});

export const WarehouseSchema = z.object({
  id: z.string().optional(),
  code: z.string().min(1),
  name: z.string().default(''),
  lengthM: num({ positive: true }),
  widthM: num({ positive: true }),
  heightM: num({ positive: true }),
  /** Floor-level origin corner; defaults to (0, 0). */
  origin: z
    .object({ x: num().default(0), z: num().default(0) })
    .default(() => ({ x: 0, z: 0 })),
  metadata: metadata(),
});

export const LayoutDocSchema = z.object({
  /** Bump only alongside a migration in `migrate.ts` and `migrate.py`. */
  schemaVersion: z.literal(1),
  warehouse: WarehouseSchema,
  obstacles: z.array(ObstacleSchema).default(() => []),
  rackTypes: z.array(RackTypeSchema).default(() => []),
  aisles: z.array(AisleSchema).default(() => []),
});

/**
 * The implicit "one continuous rack run" a lane has when `segments` is omitted.
 *
 * Single-sourced because both the document normalizer and the `lane.add` command
 * need it. If they disagreed, a stored document could omit `segments` while the
 * compiler treated it as present — meaning the same document would have two
 * readings, and the editor would have to know that `undefined` means
 * "one RACK run". Materializing it at every entry point removes that ambiguity.
 */
export function defaultLaneSegments(lengthM: number): LaneSegment[] {
  return [{ kind: 'RACK', startM: 0, endM: lengthM }];
}

export type LaneSide = z.infer<typeof LaneSideSchema>;export type AisleOrientation = z.infer<typeof AisleOrientationSchema>;
export type TravelDirection = z.infer<typeof TravelDirectionSchema>;
export type ObstacleKind = z.infer<typeof ObstacleKindSchema>;
export type SegmentKind = z.infer<typeof SegmentKindSchema>;
export type RackLevel = z.infer<typeof RackLevelSchema>;
export type RackType = z.infer<typeof RackTypeSchema>;
export type LaneSegment = z.infer<typeof LaneSegmentSchema>;
export type Centerline = z.infer<typeof CenterlineSchema>;
export type Lane = z.infer<typeof LaneSchema>;
export type Aisle = z.infer<typeof AisleSchema>;
export type Obstacle = z.infer<typeof ObstacleSchema>;
export type Warehouse = z.infer<typeof WarehouseSchema>;
export type LayoutDoc = z.infer<typeof LayoutDocSchema>;
/** Input shape, before defaults are applied. */
export type LayoutDocInput = z.input<typeof LayoutDocSchema>;
