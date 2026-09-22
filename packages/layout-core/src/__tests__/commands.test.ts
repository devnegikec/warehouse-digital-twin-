import { applyPatches } from 'immer';
import { describe, expect, it } from 'vitest';

import {
  COMMAND_LABELS,
  applyCommand,
  command,
  createSequentialIdFactory,
  defaultLevel,
  nextAisleCode,
  nextLaneCode,
  type CommandType,
} from '../commands.js';
import { buildLayout } from '../compile.js';
import {
  aisleInput,
  emptyDoc,
  laneInput,
  obstacleInput,
  rackTypeInput,
  richDoc,
  sampleCommands,
  testContext,
} from './helpers.js';

describe('aisle codes and ids', () => {
  it('generates the next free aisle code', () => {
    const doc = applyCommand(
      emptyDoc(),
      command({ type: 'aisle.add', aisle: aisleInput() }),
      testContext,
    ).doc;

    expect(doc.aisles[0]?.code).toBe('A01');
    expect(nextAisleCode(doc)).toBe('A02');
  });

  it('skips codes that are already taken', () => {
    const doc = applyCommand(
      emptyDoc(),
      command({ type: 'aisle.add', aisle: aisleInput({ code: 'A01' }) }),
      testContext,
    ).doc;
    const withA03 = applyCommand(
      doc,
      command({ type: 'aisle.add', aisle: aisleInput({ code: 'A03', centerline: { x1: 2, z1: 16, x2: 38, z2: 16 } }) }),
      testContext,
    ).doc;

    expect(nextAisleCode(withA03)).toBe('A02');
  });

  it('assigns ids from the injected factory', () => {
    const first = applyCommand(
      emptyDoc(),
      command({ type: 'aisle.add', aisle: aisleInput() }),
      { idFactory: createSequentialIdFactory('x') },
    );
    expect(first.doc.aisles[0]?.id).toBe('x-1');
  });

  it('gives two lanes on the same side distinct codes', () => {
    const result = applyCommand(
      emptyDoc(),
      command({
        type: 'aisle.add',
        aisle: aisleInput({
          lanes: [laneInput(), laneInput({ lengthM: 13.5 })],
        }),
      }),
      testContext,
    );

    expect(result.ok).toBe(true);
    const codes = result.doc.aisles[0]?.lanes.map((lane) => lane.code);
    expect(codes).toEqual(['A01-L1', 'A01-L2']);
  });

  it('derives lane codes from the aisle code and side', () => {
    const aisle = { code: 'A07', lanes: [{ code: 'A07-L1' }] };
    expect(nextLaneCode(aisle, 'LEFT')).toBe('A07-L2');
    expect(nextLaneCode(aisle, 'RIGHT')).toBe('A07-R1');
  });
});

describe('command coverage', () => {
  const samples = sampleCommands();

  it('has a sample for every command type', () => {
    // Adding a command type without a sample fails here.
    expect(Object.keys(samples).sort()).toEqual(Object.keys(COMMAND_LABELS).sort());
  });

  it('has a label for every command type', () => {
    for (const type of Object.keys(samples) as CommandType[]) {
      expect(COMMAND_LABELS[type], `${type} needs a label`).toBeTruthy();
    }
  });

  it.each(Object.entries(samples))('%s applies successfully to a rich document', (type, cmd) => {
    const before = richDoc();
    const result = applyCommand(before, cmd, testContext);

    expect(result.reason).toBeUndefined();
    expect(result.ok, `${String(type)} failed: ${result.reason ?? ''}`).toBe(true);
    expect(result.patches.length).toBeGreaterThan(0);
    expect(result.inversePatches.length).toBeGreaterThan(0);
  });

  it.each(Object.entries(samples))('%s is reversible patch-for-patch', (type, cmd) => {
    const before = richDoc();
    const result = applyCommand(before, cmd, testContext);
    expect(result.ok, `${String(type)} failed`).toBe(true);

    // Replaying the inverse patches must land exactly back on the original.
    expect(applyPatches(result.doc, result.inversePatches)).toEqual(before);
  });
});

describe('aisle commands', () => {
  it('updates only the aisle, leaving its lanes intact', () => {
    const result = applyCommand(
      richDoc(),
      command({ type: 'aisle.update', aisleId: 'a1', patch: { widthM: 4.2 } }),
      testContext,
    );

    expect(result.ok).toBe(true);
    expect(result.doc.aisles[0]?.widthM).toBe(4.2);
    expect(result.doc.aisles[0]?.lanes).toHaveLength(1);
  });

  it('translates both ends of the centerline together', () => {
    const result = applyCommand(
      richDoc(),
      command({ type: 'aisle.translate', aisleId: 'a1', deltaX: 2, deltaZ: -3 }),
      testContext,
    );

    expect(result.doc.aisles[0]?.centerline).toEqual({ x1: 4, z1: 7, x2: 40, z2: 7 });
  });

  it('rejects an update to a missing aisle without changing the document', () => {
    const before = richDoc();
    const result = applyCommand(
      before,
      command({ type: 'aisle.update', aisleId: 'nope', patch: { widthM: 4 } }),
      testContext,
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/No aisle with id 'nope'/);
    expect(result.doc).toBe(before);
  });
});

describe('lane commands', () => {
  it('reports a missing lane with the operation name', () => {
    const result = applyCommand(
      richDoc(),
      command({ type: 'lane.update', laneId: 'nope', patch: { lengthM: 5 } }),
      testContext,
    );

    expect(result.reason).toMatch(/No lane with id 'nope' \(lane.update\)/);
  });

  it('refuses to remove the last level', () => {
    const oneLevel = applyCommand(
      richDoc(),
      command({ type: 'lane.removeLevel', laneId: 'l1', levelIndex: 0 }),
      testContext,
    ).doc;

    const result = applyCommand(
      oneLevel,
      command({ type: 'lane.removeLevel', laneId: 'l1', levelIndex: 0 }),
      testContext,
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/at least one level/);
  });

  it('clamps segments when a lane is shortened', () => {
    const result = applyCommand(
      richDoc(),
      command({ type: 'lane.update', laneId: 'l1', patch: { lengthM: 21.6 } }),
      testContext,
    );

    expect(result.doc.aisles[0]?.lanes[0]?.segments).toEqual([
      { kind: 'RACK', startM: 0, endM: 21.6 },
    ]);
  });

  it('sorts segments and rejects overlaps', () => {
    const sorted = applyCommand(
      richDoc(),
      command({
        type: 'lane.setSegments',
        laneId: 'l1',
        segments: [
          { kind: 'RACK', startM: 16.2, endM: 27 },
          { kind: 'RACK', startM: 0, endM: 10.8 },
        ],
      }),
      testContext,
    );
    expect(sorted.doc.aisles[0]?.lanes[0]?.segments?.map((s) => s.startM)).toEqual([0, 16.2]);

    const overlapping = applyCommand(
      richDoc(),
      command({
        type: 'lane.setSegments',
        laneId: 'l1',
        segments: [
          { kind: 'RACK', startM: 0, endM: 10.8 },
          { kind: 'GAP', startM: 5, endM: 12 },
        ],
      }),
      testContext,
    );
    expect(overlapping.ok).toBe(false);
    expect(overlapping.reason).toMatch(/overlap/);
  });

  it('rejects a segment past the end of the lane', () => {
    const result = applyCommand(
      richDoc(),
      command({
        type: 'lane.setSegments',
        laneId: 'l1',
        segments: [{ kind: 'RACK', startM: 0, endM: 999 }],
      }),
      testContext,
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/exceeds lane/);
  });

  it('refuses to empty a lane of its runs', () => {
    // `normalizeDoc` reads an empty `segments` list as "one continuous run", so a lane
    // left with no runs would hash differently after a save-and-reload round trip.
    const result = applyCommand(
      richDoc(),
      command({ type: 'lane.setSegments', laneId: 'l1', segments: [] }),
      testContext,
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/at least one run/);
  });

  it('toggles skip bays and keeps them sorted', () => {
    let doc = richDoc();
    for (const baySeq of [5, 2, 9]) {
      doc = applyCommand(doc, command({ type: 'lane.toggleSkipBay', laneId: 'l1', baySeq }), testContext).doc;
    }
    expect(doc.aisles[0]?.lanes[0]?.skipBays).toEqual([2, 5, 9]);

    doc = applyCommand(doc, command({ type: 'lane.toggleSkipBay', laneId: 'l1', baySeq: 5 }), testContext).doc;
    expect(doc.aisles[0]?.lanes[0]?.skipBays).toEqual([2, 9]);
  });

  it('applies a default level when adding one', () => {
    const result = applyCommand(
      richDoc(),
      command({ type: 'lane.addLevel', laneId: 'l1' }),
      testContext,
    );

    const levels = result.doc.aisles[0]?.lanes[0]?.levels ?? [];
    expect(levels).toHaveLength(3);
    expect(levels[2]).toMatchObject(defaultLevel());
    expect(levels[2]?.beamHeightM).toBe(0.08);
  });

  it('inserts a level at a given index', () => {
    const result = applyCommand(
      richDoc(),
      command({
        type: 'lane.addLevel',
        laneId: 'l1',
        index: 0,
        level: { clearHeightM: 0.5, binDepthM: 0.5 },
      }),
      testContext,
    );

    expect(result.doc.aisles[0]?.lanes[0]?.levels[0]?.clearHeightM).toBe(0.5);
  });

  it('rejects an invalid payload with a field path rather than throwing', () => {
    const result = applyCommand(
      richDoc(),
      command({ type: 'lane.update', laneId: 'l1', patch: { lengthM: -5 } }),
      testContext,
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/Invalid lane\.update/);
    expect(result.reason).toMatch(/lengthM/);
  });
});

describe('rack type and obstacle commands', () => {
  it('removes a rack type without touching lanes that referenced it', () => {
    const result = applyCommand(
      richDoc(),
      command({ type: 'rackType.remove', rackTypeId: 'rt1' }),
      testContext,
    );

    expect(result.doc.rackTypes).toHaveLength(0);
    expect(result.doc.aisles[0]?.lanes).toHaveLength(1);

    // The dangling reference is reported by the validator, not prevented by the command.
    const codes = buildLayout(result.doc).diagnostics.map((d) => d.code);
    expect(codes).toContain('LANE_UNKNOWN_RACK_TYPE');
    expect(codes).toContain('NO_RACK_TYPES_DEFINED');
  });

  it('rejects a duplicate rack type id', () => {
    const result = applyCommand(
      richDoc(),
      command({ type: 'rackType.add', rackType: rackTypeInput() }),
      testContext,
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/already exists/);
  });

  it('adds, updates and removes an obstacle', () => {
    let doc = applyCommand(
      richDoc(),
      command({ type: 'obstacle.add', obstacle: obstacleInput({ id: 'ob2' }) }),
      testContext,
    ).doc;
    expect(doc.obstacles).toHaveLength(2);

    doc = applyCommand(
      doc,
      command({ type: 'obstacle.update', obstacleId: 'ob2', patch: { heightM: 6 } }),
      testContext,
    ).doc;
    expect(doc.obstacles[1]?.heightM).toBe(6);

    doc = applyCommand(
      doc,
      command({ type: 'obstacle.remove', obstacleId: 'ob2' }),
      testContext,
    ).doc;
    expect(doc.obstacles).toHaveLength(1);
  });
});

describe('document.update and document.replace', () => {
  it('updates the warehouse footprint', () => {
    const result = applyCommand(
      richDoc(),
      command({ type: 'warehouse.update', patch: { name: 'Renamed', widthM: 25 } }),
      testContext,
    );

    expect(result.doc.warehouse.name).toBe('Renamed');
    expect(result.doc.warehouse.widthM).toBe(25);
    expect(result.doc.warehouse.lengthM).toBe(40);
  });

  it('replaces the whole document from unknown input', () => {
    const result = applyCommand(
      richDoc(),
      command({
        type: 'document.replace',
        doc: { schemaVersion: 1, warehouse: { code: 'WH9', lengthM: 5, widthM: 5, heightM: 3 } },
      }),
      testContext,
    );

    expect(result.ok).toBe(true);
    expect(result.doc.warehouse.code).toBe('WH9');
    expect(result.doc.aisles).toEqual([]);
  });

  it('rejects a document that violates the contract', () => {
    const result = applyCommand(
      richDoc(),
      command({ type: 'document.replace', doc: { schemaVersion: 1 } }),
      testContext,
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/Invalid document\.replace/);
  });
});
