import { describe, expect, it } from 'vitest';

import { buildLayout, laneStackHeightM, normalizeDoc, validateLayout } from '../compile.js';
import { migrateToCurrent, CURRENT_SCHEMA_VERSION } from '../migrate.js';

const WAREHOUSE = { code: 'WH1', name: 'Test', lengthM: 40, widthM: 20, heightM: 8 };
const RACK_TYPE = {
  id: 'rt1',
  code: 'STD',
  name: 'Standard',
  bayWidthM: 2.7,
  depthM: 1.1,
  uprightWidthM: 0.12,
  uprightDepthM: 0.12,
};
const LEVELS_3 = [
  { clearHeightM: 1.6, binDepthM: 1, beamHeightM: 0.08 },
  { clearHeightM: 1.6, binDepthM: 1, beamHeightM: 0.08 },
  { clearHeightM: 1.6, binDepthM: 1, beamHeightM: 0.08 },
];

function docWithLanes(lanes: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    warehouse: WAREHOUSE,
    obstacles: [],
    rackTypes: [RACK_TYPE],
    aisles: [
      {
        id: 'a1',
        code: 'A01',
        orientation: 'X',
        centerline: { x1: 2, z1: 10, x2: 38, z2: 10 },
        widthM: 3,
        lanes,
        ...overrides,
      },
    ],
  };
}

function lane(overrides: Record<string, unknown> = {}) {
  return {
    id: 'l1',
    code: 'A01-L',
    side: 'LEFT',
    rackTypeId: 'rt1',
    startOffsetM: 0,
    lengthM: 27,
    levels: LEVELS_3,
    ...overrides,
  };
}

describe('buildLayout', () => {
  it('derives 10 bays x 3 levels from parametric inputs', () => {
    const graph = buildLayout(docWithLanes([lane()]));
    expect(graph.bays).toHaveLength(10);
    expect(graph.bins).toHaveLength(30);
    expect(graph.publishable).toBe(true);
  });

  it('places the first LEFT bin at the documented coordinates', () => {
    const graph = buildLayout(docWithLanes([lane()]));
    const first = graph.bins[0];
    // along = (0 + 0.5) * 2.7 = 1.35 from x=2 -> 3.35
    // perpendicular offset = aisle width/2 + rack depth/2 = 1.5 + 0.55 = 2.05, LEFT of +X is -Z
    // centre Y = beam 0.08 + clear/2 0.8 = 0.88
    expect(first?.center).toEqual({ x: 3.35, y: 0.88, z: 7.95 });
    expect(first?.code).toBe('WH1/A01/L/B001/L1');
    expect(first?.rotationDeg).toBe(0);
  });

  it('stacks levels on cumulative beam + clear height', () => {
    const graph = buildLayout(docWithLanes([lane()]));
    const ys = graph.bins.slice(0, 3).map((b) => b.center.y);
    expect(ys).toEqual([0.88, 2.56, 4.24]);
    expect(laneStackHeightM(LEVELS_3)).toBe(5.04);
  });

  it('computes usable capacity with the utilisation factor', () => {
    const graph = buildLayout(docWithLanes([lane()]));
    // 2.7 * 1.6 * 1.0 * 0.85
    expect(graph.bins[0]?.capacityM3).toBe(3.672);
    expect(graph.bins[0]?.maxWeightKg).toBeNull();
  });

  it('derives orientation from the centerline and rotates by 90 for Z aisles', () => {
    const graph = buildLayout({
      schemaVersion: 1,
      warehouse: { code: 'WH1', lengthM: 25, widthM: 25, heightM: 8 },
      rackTypes: [RACK_TYPE],
      aisles: [
        {
          id: 'a2',
          code: 'A02',
          orientation: 'Z',
          centerline: { x1: 10, z1: 2, x2: 10, z2: 18 },
          widthM: 3.2,
          lanes: [
            lane({ id: 'l-l', code: 'A02-L', side: 'LEFT', lengthM: 10.8, levels: LEVELS_3.slice(0, 1) }),
            lane({ id: 'l-r', code: 'A02-R', side: 'RIGHT', lengthM: 10.8, levels: LEVELS_3.slice(0, 1) }),
          ],
        },
      ],
    });

    expect(graph.diagnostics.map((d) => d.code)).not.toContain('AISLE_ORIENTATION_MISMATCH');

    const left = graph.bins.find((b) => b.side === 'LEFT');
    const right = graph.bins.find((b) => b.side === 'RIGHT');

    // forward = +Z, so left = +X and right = -X. Offset = 1.6 + 0.55 = 2.15.
    expect(left?.center.x).toBe(12.15);
    expect(left?.center.z).toBe(3.35);
    expect(right?.center.x).toBe(7.85);
    expect(left?.rotationDeg).toBe(90);
    expect(graph.bins).toHaveLength(8);
  });

  it('flags a declared orientation that contradicts the centerline', () => {
    const graph = buildLayout(docWithLanes([lane()], { orientation: 'Z' }));
    expect(graph.diagnostics.map((d) => d.code)).toContain('AISLE_ORIENTATION_MISMATCH');
    expect(graph.publishable).toBe(false);
  });

  it('is deterministic: same document, same hash and same bins', () => {
    const a = buildLayout(docWithLanes([lane()]));
    const b = buildLayout(docWithLanes([lane()]));
    expect(a.hash).toBe(b.hash);
    expect(a.bins).toEqual(b.bins);
  });

  it('hashes omitted segments the same as one explicit RACK segment', () => {
    const omitted = buildLayout(docWithLanes([lane()]));
    const explicit = buildLayout(
      docWithLanes([lane({ segments: [{ kind: 'RACK', startM: 0, endM: 27 }] })]),
    );
    expect(explicit.hash).toBe(omitted.hash);
    expect(explicit.bins).toEqual(omitted.bins);
  });

  it('excludes bays inside a GAP segment and skipped bays', () => {
    const graph = buildLayout(
      docWithLanes([
        lane({
          segments: [
            { kind: 'RACK', startM: 0, endM: 10.8 },
            { kind: 'GAP', startM: 10.8, endM: 16.2 },
            { kind: 'RACK', startM: 16.2, endM: 27 },
          ],
          skipBays: [1],
          levels: LEVELS_3.slice(0, 1),
        }),
      ]),
    );

    // Bays 1 (skipped), 5 and 6 (inside the doorway gap) produce no bins.
    expect(graph.bays).toHaveLength(10);
    expect(graph.bins).toHaveLength(7);
    expect(graph.bays.filter((b) => !b.inRackRun).map((b) => b.seq)).toEqual([5, 6]);
    expect(graph.bays.filter((b) => b.isSkipped).map((b) => b.seq)).toEqual([1]);
    expect(graph.bins.map((b) => b.baySeq)).toEqual([2, 3, 4, 7, 8, 9, 10]);
  });

  it('errors when two lanes produce the same bin code', () => {
    const graph = buildLayout(
      docWithLanes([
        lane({ id: 'l1', code: 'A01-LA' }),
        lane({ id: 'l2', code: 'A01-LB', levels: LEVELS_3.slice(0, 1) }),
      ]),
    );
    expect(graph.diagnostics.map((d) => d.code)).toContain('BIN_CODE_DUPLICATE');
    expect(graph.publishable).toBe(false);
  });

  it('errors when the level stack exceeds the warehouse height', () => {
    const graph = buildLayout({
      schemaVersion: 1,
      warehouse: { code: 'WH1', lengthM: 20, widthM: 12, heightM: 5 },
      rackTypes: [RACK_TYPE],
      aisles: [
        {
          id: 'a5',
          code: 'A05',
          orientation: 'X',
          centerline: { x1: 1, z1: 6, x2: 19, z2: 6 },
          widthM: 2,
          lanes: [lane({ lengthM: 16.2 })],
        },
      ],
    });

    const codes = graph.diagnostics.map((d) => d.code);
    expect(codes).toContain('LEVEL_STACK_EXCEEDS_HEIGHT');
    expect(codes).toContain('AISLE_TOO_NARROW');
    expect(graph.publishable).toBe(false);
  });

  it('errors when a bay collides with an obstacle', () => {
    const graph = buildLayout({
      schemaVersion: 1,
      warehouse: { code: 'WH1', lengthM: 30, widthM: 20, heightM: 8 },
      obstacles: [{ id: 'ob1', kind: 'COLUMN', x: 12, z: 7.4, widthM: 1, depthM: 1, heightM: 3 }],
      rackTypes: [RACK_TYPE],
      aisles: [
        {
          id: 'a4',
          code: 'A04',
          orientation: 'X',
          centerline: { x1: 2, z1: 10, x2: 28, z2: 10 },
          widthM: 3,
          lanes: [lane({ lengthM: 24.3, levels: LEVELS_3.slice(0, 1) })],
        },
      ],
    });

    expect(graph.diagnostics.map((d) => d.code)).toContain('BAY_OBSTACLE_OVERLAP');
    expect(graph.publishable).toBe(false);
  });

  it('errors when two lanes occupy the same floor space', () => {
    const graph = buildLayout(
      docWithLanes([
        lane({ id: 'l1', code: 'A01-L', levels: LEVELS_3.slice(0, 1) }),
        lane({ id: 'l2', code: 'A01-L-DUP', levels: LEVELS_3.slice(0, 1) }),
      ]),
    );
    expect(graph.diagnostics.map((d) => d.code)).toContain('LANE_OVERLAP');
    expect(graph.publishable).toBe(false);
  });

  it('warns when a level is deeper than the rack frame', () => {
    const graph = buildLayout(
      docWithLanes([lane({ levels: [{ clearHeightM: 1.2, binDepthM: 1.5, beamHeightM: 0.08 }] })]),
    );
    const codes = graph.diagnostics.map((d) => d.code);
    expect(codes).toContain('LEVEL_DEPTH_EXCEEDS_RACK');
    expect(graph.publishable).toBe(true);
  });

  it('errors on an unknown rack type without throwing', () => {
    const graph = buildLayout(docWithLanes([lane({ rackTypeId: 'nope' })]));
    expect(graph.diagnostics.map((d) => d.code)).toContain('LANE_UNKNOWN_RACK_TYPE');
    expect(graph.bins).toHaveLength(0);
  });

  it('reports diagnostics consistently through validateLayout', () => {
    const doc = docWithLanes([lane({ rackTypeId: 'nope' })]);
    expect(validateLayout(doc).map((d) => d.code)).toEqual(
      buildLayout(doc).diagnostics.map((d) => d.code),
    );
  });
});

describe('normalizeDoc', () => {
  it('applies every schema default', () => {
    const doc = normalizeDoc({
      schemaVersion: 1,
      warehouse: { code: 'WH1', lengthM: 10, widthM: 10, heightM: 6 },
      aisles: [
        {
          id: 'a1',
          code: 'A01',
          orientation: 'X',
          centerline: { x1: 0, z1: 0, x2: 10, z2: 0 },
          widthM: 3,
          lanes: [
            {
              id: 'l1',
              code: 'L1',
              side: 'LEFT',
              rackTypeId: 'rt1',
              lengthM: 5.4,
              levels: [{ clearHeightM: 1.5, binDepthM: 1 }],
            },
          ],
        },
      ],
    });

    expect(doc.warehouse.origin).toEqual({ x: 0, z: 0 });
    expect(doc.obstacles).toEqual([]);
    expect(doc.aisles[0]?.travelDirection).toBe('BOTH');
    const normalizedLane = doc.aisles[0]?.lanes[0];
    expect(normalizedLane?.startOffsetM).toBe(0);
    expect(normalizedLane?.skipBays).toEqual([]);
    expect(normalizedLane?.binCodePattern).toBe('{warehouse}/{aisle}/{side}/B{bay:03}/L{level}');
    expect(normalizedLane?.segments).toEqual([{ kind: 'RACK', startM: 0, endM: 5.4 }]);
    expect(normalizedLane?.levels[0]?.beamHeightM).toBe(0.08);
  });

  it('gives each document its own default objects', () => {
    const make = () =>
      normalizeDoc({ schemaVersion: 1, warehouse: { code: 'W', lengthM: 1, widthM: 1, heightM: 1 } });
    const first = make();
    first.obstacles.push({
      id: 'x',
      kind: 'CUSTOM',
      x: 0,
      z: 0,
      widthM: 1,
      depthM: 1,
      heightM: 1,
      metadata: {},
    });
    expect(make().obstacles).toHaveLength(0);
  });

  it('rejects a bad bin code pattern', () => {
    expect(() =>
      normalizeDoc(
        docWithLanes([lane({ binCodePattern: '{warehouse}/{nonsense}' })]),
      ),
    ).toThrow();
  });

  it('rejects non-finite numbers', () => {
    expect(() =>
      normalizeDoc({ schemaVersion: 1, warehouse: { code: 'W', lengthM: Infinity, widthM: 1, heightM: 1 } }),
    ).toThrow();
  });
});

describe('migrateToCurrent', () => {
  it('accepts the current version', () => {
    const result = migrateToCurrent({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      warehouse: { code: 'WH1', lengthM: 1, widthM: 1, heightM: 1 },
    });
    expect(result.migratedFrom).toBeNull();
  });

  it('rejects a missing or non-integer version', () => {
    expect(() => migrateToCurrent({ warehouse: {} })).toThrow(/schemaVersion/);
    expect(() => migrateToCurrent({ schemaVersion: 1.5 })).toThrow(/integer/);
  });

  it('rejects a future version', () => {
    expect(() =>
      migrateToCurrent({
        schemaVersion: CURRENT_SCHEMA_VERSION + 1,
        warehouse: { code: 'WH1', lengthM: 1, widthM: 1, heightM: 1 },
      }),
    ).toThrow(/newer than this build/);
  });
});
