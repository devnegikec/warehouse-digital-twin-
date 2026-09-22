/**
 * Shared test fixtures for the editor-state suites.
 *
 * Not a `.test.ts` file, so vitest's `include` pattern skips it.
 */
import {
  command,
  createSequentialIdFactory,
  type AisleInput,
  type Command,
  type CommandType,
  type LaneInput,
  type ObstacleInput,
} from '../commands.js';
import { normalizeDoc } from '../compile.js';
import type { LayoutDoc } from '../schema.js';

export const testContext = { idFactory: createSequentialIdFactory('t') };

export function rackTypeInput(overrides: Record<string, unknown> = {}) {
  return { id: 'rt1', code: 'STD', name: 'Standard', bayWidthM: 2.7, depthM: 1.1, ...overrides };
}

export function laneInput(overrides: Partial<LaneInput> = {}): LaneInput {
  return {
    side: 'LEFT',
    rackTypeId: 'rt1',
    lengthM: 27,
    ...overrides,
  };
}

/** An aisle with one LEFT lane. Pass `lanes: []` for a traffic-only aisle. */
export function aisleInput(overrides: Partial<AisleInput> = {}): AisleInput {
  return {
    orientation: 'X',
    centerline: { x1: 2, z1: 10, x2: 38, z2: 10 },
    widthM: 3,
    lanes: [laneInput()],
    ...overrides,
  };
}

export function obstacleInput(overrides: Partial<ObstacleInput> = {}): ObstacleInput {
  return { kind: 'COLUMN', x: 12, z: 2, widthM: 0.6, depthM: 0.6, heightM: 4, ...overrides };
}

/** A document with no aisles. */
export function emptyDoc(overrides: Record<string, unknown> = {}): LayoutDoc {
  return normalizeDoc({
    schemaVersion: 1,
    warehouse: { code: 'WH1', name: 'Test', lengthM: 40, widthM: 20, heightM: 8 },
    rackTypes: [rackTypeInput()],
    aisles: [],
    ...overrides,
  });
}

/**
 * One rack type, one aisle with one lane, one obstacle — enough for every
 * update/remove command in the sample set to find its target.
 */
export function richDoc(): LayoutDoc {
  return normalizeDoc({
    schemaVersion: 1,
    warehouse: { code: 'WH1', name: 'Test', lengthM: 40, widthM: 20, heightM: 8 },
    rackTypes: [rackTypeInput()],
    obstacles: [obstacleInput({ id: 'ob1' })],
    aisles: [
      aisleInput({
        id: 'a1',
        code: 'A01',
        lanes: [
          laneInput({
            id: 'l1',
            code: 'A01-L1',
            // Two levels so `lane.removeLevel` has something it is allowed to remove.
            levels: [
              { clearHeightM: 1.6, binDepthM: 1 },
              { clearHeightM: 1.6, binDepthM: 1 },
            ],
          }),
        ],
      }),
    ],
  });
}

/**
 * A large but realistic layout: 6 aisles x 2 lanes x 25 bays x 5 levels = 1,500 bins.
 * Used for the compile-time budget test.
 */
export function largeDoc(): LayoutDoc {
  return normalizeDoc({
    schemaVersion: 1,
    warehouse: { code: 'WH1', name: 'Large', lengthM: 200, widthM: 100, heightM: 12 },
    rackTypes: [rackTypeInput()],
    aisles: Array.from({ length: 6 }, (_unused, index) => {
      const z = 10 + index * 10;
      return aisleInput({
        id: `a${index}`,
        code: `A${String(index + 1).padStart(2, '0')}`,
        centerline: { x1: 2, z1: z, x2: 72, z2: z },
        widthM: 4,
        lanes: [
          laneInput({
            id: `a${index}-l`,
            code: `A${String(index + 1).padStart(2, '0')}-L`,
            side: 'LEFT',
            lengthM: 67.5,
            levels: Array.from({ length: 5 }, () => ({ clearHeightM: 1.6, binDepthM: 1 })),
          }),
          laneInput({
            id: `a${index}-r`,
            code: `A${String(index + 1).padStart(2, '0')}-R`,
            side: 'RIGHT',
            lengthM: 67.5,
            levels: Array.from({ length: 5 }, () => ({ clearHeightM: 1.6, binDepthM: 1 })),
          }),
        ],
      });
    }),
  });
}

/**
 * One valid command per command type, targeting `richDoc()`.
 *
 * The exhaustiveness test asserts this map has exactly the same keys as
 * `COMMAND_LABELS`, so adding a command type without a sample fails the suite.
 */
export function sampleCommands(): Record<CommandType, Command> {
  return {
    'warehouse.update': command({ type: 'warehouse.update', patch: { lengthM: 45 } }),
    'rackType.add': command({ type: 'rackType.add', rackType: rackTypeInput({ id: 'rt2', code: 'BULK' }) }),
    'rackType.update': command({ type: 'rackType.update', rackTypeId: 'rt1', patch: { bayWidthM: 3.0 } }),
    'rackType.remove': command({ type: 'rackType.remove', rackTypeId: 'rt1' }),
    'aisle.add': command({ type: 'aisle.add', aisle: aisleInput({ centerline: { x1: 2, z1: 16, x2: 38, z2: 16 } }) }),
    'aisle.update': command({ type: 'aisle.update', aisleId: 'a1', patch: { widthM: 3.5 } }),
    'aisle.translate': command({ type: 'aisle.translate', aisleId: 'a1', deltaX: 1, deltaZ: -1 }),
    'aisle.remove': command({ type: 'aisle.remove', aisleId: 'a1' }),
    'lane.add': command({ type: 'lane.add', aisleId: 'a1', lane: laneInput({ side: 'RIGHT' }) }),
    'lane.update': command({ type: 'lane.update', laneId: 'l1', patch: { lengthM: 21.6 } }),
    'lane.remove': command({ type: 'lane.remove', laneId: 'l1' }),
    'lane.setLevel': command({
      type: 'lane.setLevel',
      laneId: 'l1',
      levelIndex: 0,
      patch: { clearHeightM: 1.8 },
    }),
    'lane.addLevel': command({
      type: 'lane.addLevel',
      laneId: 'l1',
      level: { clearHeightM: 1.2, binDepthM: 0.8 },
    }),
    'lane.removeLevel': command({ type: 'lane.removeLevel', laneId: 'l1', levelIndex: 0 }),
    'lane.setSegments': command({
      type: 'lane.setSegments',
      laneId: 'l1',
      segments: [
        { kind: 'RACK', startM: 0, endM: 10.8 },
        { kind: 'GAP', startM: 10.8, endM: 16.2 },
        { kind: 'RACK', startM: 16.2, endM: 27 },
      ],
    }),
    'lane.toggleSkipBay': command({ type: 'lane.toggleSkipBay', laneId: 'l1', baySeq: 3 }),
    'obstacle.add': command({ type: 'obstacle.add', obstacle: obstacleInput({ id: 'ob2' }) }),
    'obstacle.update': command({
      type: 'obstacle.update',
      obstacleId: 'ob1',
      patch: { widthM: 1.2 },
    }),
    'obstacle.remove': command({ type: 'obstacle.remove', obstacleId: 'ob1' }),
    'document.replace': command({
      type: 'document.replace',
      doc: {
        schemaVersion: 1,
        warehouse: { code: 'WH2', lengthM: 10, widthM: 10, heightM: 5 },
        rackTypes: [],
        aisles: [],
      },
    }),
  };
}
