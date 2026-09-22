/**
 * The rule registry (P6).
 *
 * Every diagnostic code this system can emit is declared here, exactly once,
 * with its severity. Two consequences that matter:
 *
 * 1. **Severity is policy, declared centrally.** Call sites report a *code*; they
 *    cannot accidentally declare the same rule as a warning in one place and an
 *    error in another.
 * 2. **Codes are a closed union.** `RuleCode` is derived from this object, so a
 *    typo in a call site is a compile error rather than a silently dead rule.
 *
 * `scripts/gen-schema.ts` emits this registry to `schema/rule-codes.json`, which
 * the Python side loads. Combined with the fixture suite, that means the two
 * runtimes cannot disagree about *which* rules exist or *how severe* they are —
 * only about how well they implement them, which the fixtures catch.
 */

export type RuleSeverity = 'error' | 'warning';

export type RuleDefinition = {
  code: string;
  severity: RuleSeverity;
  description: string;
};

export const RULES = {
  // --- Document structure -------------------------------------------------
  NO_RACK_TYPES_DEFINED: {
    code: 'NO_RACK_TYPES_DEFINED',
    severity: 'error',
    description: 'Aisles have lanes but the document defines no rack types.',
  },
  AISLE_CODE_DUPLICATE: {
    code: 'AISLE_CODE_DUPLICATE',
    severity: 'error',
    description: 'Two aisles share a code, which breaks bin-code uniqueness.',
  },
  LANE_UNKNOWN_RACK_TYPE: {
    code: 'LANE_UNKNOWN_RACK_TYPE',
    severity: 'error',
    description: 'A lane references a rackTypeId that is not in the document.',
  },

  // --- Aisle geometry -----------------------------------------------------
  AISLE_ZERO_LENGTH: {
    code: 'AISLE_ZERO_LENGTH',
    severity: 'error',
    description: 'Aisle centerline start and end coincide.',
  },
  AISLE_NOT_AXIS_ALIGNED: {
    code: 'AISLE_NOT_AXIS_ALIGNED',
    severity: 'error',
    description: 'Aisle runs diagonally; v1 supports only exactly X or Z aligned aisles.',
  },
  AISLE_ORIENTATION_MISMATCH: {
    code: 'AISLE_ORIENTATION_MISMATCH',
    severity: 'error',
    description: 'Declared orientation contradicts the centerline direction.',
  },
  AISLE_OUT_OF_FOOTPRINT: {
    code: 'AISLE_OUT_OF_FOOTPRINT',
    severity: 'error',
    description: 'The clear corridor extends beyond the warehouse footprint.',
  },
  AISLE_OBSTACLE_OVERLAP: {
    code: 'AISLE_OBSTACLE_OVERLAP',
    severity: 'error',
    description: 'The clear corridor passes through a column, wall or other obstacle.',
  },
  AISLE_TOO_NARROW: {
    code: 'AISLE_TOO_NARROW',
    severity: 'warning',
    description: 'Corridor is narrower than a counterbalance forklift realistically needs.',
  },
  AISLE_WITHOUT_LANES: {
    code: 'AISLE_WITHOUT_LANES',
    severity: 'warning',
    description: 'Aisle has no rack rows, so it stores nothing.',
  },

  // --- Lane geometry ------------------------------------------------------
  LANE_RUN_EXCEEDS_AISLE: {
    code: 'LANE_RUN_EXCEEDS_AISLE',
    severity: 'error',
    description: 'A lane run starts or ends beyond the aisle centerline.',
  },
  LANE_OVERLAP: {
    code: 'LANE_OVERLAP',
    severity: 'error',
    description: 'Two lanes occupy the same floor space, which usually means aisles are too close.',
  },
  LANE_ZERO_BAYS: {
    code: 'LANE_ZERO_BAYS',
    severity: 'warning',
    description: 'A lane is shorter than one bay, so it yields no bins.',
  },
  LANE_HAS_NO_RACK_SEGMENT: {
    code: 'LANE_HAS_NO_RACK_SEGMENT',
    severity: 'warning',
    description: 'Every segment of a lane is a GAP, so it yields no bins.',
  },
  LEVEL_DEPTH_EXCEEDS_RACK: {
    code: 'LEVEL_DEPTH_EXCEEDS_RACK',
    severity: 'warning',
    description: 'A level is configured deeper than the structural rack frame.',
  },
  LEVEL_STACK_EXCEEDS_HEIGHT: {
    code: 'LEVEL_STACK_EXCEEDS_HEIGHT',
    severity: 'error',
    description: 'The level stack (beams plus clear heights) is taller than the building.',
  },

  // --- Bins ---------------------------------------------------------------
  BIN_OUT_OF_FOOTPRINT: {
    code: 'BIN_OUT_OF_FOOTPRINT',
    severity: 'error',
    description: 'A bay extends beyond the warehouse footprint.',
  },
  BAY_OBSTACLE_OVERLAP: {
    code: 'BAY_OBSTACLE_OVERLAP',
    severity: 'error',
    description: 'A bay collides with a column, wall or other obstacle.',
  },
  BIN_CODE_DUPLICATE: {
    code: 'BIN_CODE_DUPLICATE',
    severity: 'error',
    description: 'Two bins resolve to the same code; the bin code pattern is not unique enough.',
  },

  // --- Placement (run when inventory is assigned, not at layout publish) ---
  QTY_NOT_POSITIVE: {
    code: 'QTY_NOT_POSITIVE',
    severity: 'error',
    description: 'Placement quantity must be greater than zero.',
  },
  ITEM_DOES_NOT_FIT_OPENING: {
    code: 'ITEM_DOES_NOT_FIT_OPENING',
    severity: 'error',
    description: 'The item does not fit the bin opening in any legal orientation.',
  },
  EXCEEDS_BIN_VOLUME: {
    code: 'EXCEEDS_BIN_VOLUME',
    severity: 'error',
    description: 'The placed quantity exceeds the bin usable volume.',
  },
  EXCEEDS_BIN_WEIGHT: {
    code: 'EXCEEDS_BIN_WEIGHT',
    severity: 'error',
    description: 'The placed quantity exceeds the level beam load limit.',
  },

  // --- Meta ---------------------------------------------------------------
  DIAGNOSTICS_TRUNCATED: {
    code: 'DIAGNOSTICS_TRUNCATED',
    severity: 'warning',
    description: 'Further instances of a repeated issue were suppressed to avoid flooding.',
  },
} as const satisfies Record<string, RuleDefinition>;

export type RuleCode = keyof typeof RULES;

/** Sorted list of every code, for coverage assertions. */
export const RULE_CODES: readonly RuleCode[] = Object.freeze(
  (Object.keys(RULES) as RuleCode[]).sort(),
);

export function ruleSeverity(code: RuleCode): RuleSeverity {
  return RULES[code].severity;
}

/** Rules that block Publish when present. Warnings never do (P6). */
export const BLOCKING_RULE_CODES: readonly RuleCode[] = Object.freeze(
  RULE_CODES.filter((code) => RULES[code].severity === 'error'),
);
