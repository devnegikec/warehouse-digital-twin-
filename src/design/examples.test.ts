/**
 * The example designs are part of the contract, not documentation.
 *
 * Each file in `examples/designs/` must parse, migrate and compile to **zero
 * diagnostics** — no errors and no warnings. A layout that is "almost" valid teaches the
 * wrong shape, and a warning means the example is demonstrating something a designer
 * would be told off for.
 *
 * The coverage test is the other half: the point of these files is to show every knob the
 * document has, so if a new enum value or lane field is added and no example exercises it,
 * this suite says so.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildLayout, migrateToCurrent, type LayoutDoc } from 'layout-core';
import { describe, expect, it } from 'vitest';

const EXAMPLES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../examples/designs');

function exampleFiles(): string[] {
  return readdirSync(EXAMPLES_DIR)
    .filter((name) => name.endsWith('.json'))
    .sort();
}

const files = exampleFiles();

function readExample(file: string): LayoutDoc {
  const raw: unknown = JSON.parse(readFileSync(join(EXAMPLES_DIR, file), 'utf8'));
  return migrateToCurrent(raw).doc;
}

describe('example designs', () => {
  it('ships at least one example', () => {
    expect(files.length).toBeGreaterThanOrEqual(3);
  });

  for (const file of files) {
    it(`${file} compiles cleanly and is publishable`, () => {
      const doc = readExample(file);
      const graph = buildLayout(doc);

      const report = graph.diagnostics
        .map((d) => `${d.severity.toUpperCase()} ${d.code} — ${d.message}`)
        .join('\n');

      expect(graph.diagnostics, `\n${file} produced diagnostics:\n${report}\n`).toEqual([]);
      expect(graph.publishable, `${file} is not publishable`).toBe(true);
      expect(graph.bins.length, `${file} produced no bins`).toBeGreaterThan(0);
      expect(graph.bays.length).toBeGreaterThan(0);

      // Every bin must be reachable by a unique code or publishing would orphan inventory.
      expect(new Set(graph.bins.map((bin) => bin.code)).size).toBe(graph.bins.length);
    });
  }

  /**
   * The headline numbers, pinned.
   *
   * These are not decoration: they are what proves the gaps and skips in the examples do
   * what their labels say. A cross-aisle that silently stops removing a bay would show up
   * here as an unexpected bin count, and the committed total in this file is the only
   * place that discrepancy would be noticed.
   */
  const expected: Record<string, { bins: number; bays: number }> = {
    // 3 aisles x 2 lanes x (10 bays - 2 in the cross-aisle) x 5 levels.
    '01-cross-aisle-two-way.json': { bins: 240, bays: 60 },
    // A01-L loses its last bay to a doorway and A01-R reserves one, so the six lanes
    // hold 28 bays between them: 5 + 2 + 5 + 4 + 4 + 6 active, all at 5 levels.
    '02-vertical-one-way-doorways.json': { bins: 130, bays: 28 },
    // 4 lanes x (8 bays - 2 in the two cross-aisles); A01 has 7 levels, A02 has 6.
    '03-high-bay-freezer-deep.json': { bins: 156, bays: 32 },
  };

  for (const [file, totals] of Object.entries(expected)) {
    it(`${file} compiles to ${totals.bins} bins over ${totals.bays} bays`, () => {
      const graph = buildLayout(readExample(file));

      expect(graph.bins.length).toBe(totals.bins);
      expect(graph.bays.length).toBe(totals.bays);
    });
  }

  it('splits each lane into real runs, not one continuous shelf', () => {
    const crossAisle = buildLayout(readExample('01-cross-aisle-two-way.json'));

    // Every lane: 10 bays, 2 of them lost to the cross-aisle, and two rack runs either side.
    const perLane = new Map<string, { bays: number; active: number }>();
    for (const bay of crossAisle.bays) {
      const entry = perLane.get(bay.laneCode) ?? { bays: 0, active: 0 };
      entry.bays += 1;
      if (bay.inRackRun && !bay.isSkipped) entry.active += 1;
      perLane.set(bay.laneCode, entry);
    }

    expect(perLane.size).toBe(6);
    for (const [laneCode, entry] of perLane) {
      expect(entry, laneCode).toEqual({ bays: 10, active: 8 });
    }

    // The two runs are either side of the gap, so bays 5 and 6 must be the missing ones.
    const lane = crossAisle.bays.filter((bay) => bay.laneCode === 'A01-L');
    const idleBays = lane.filter((bay) => !bay.inRackRun).map((bay) => bay.seq).sort((a, b) => a - b);
    expect(idleBays).toEqual([5, 6]);
  });

  it('between them, exercises every feature the document offers', () => {    const docs = files.map(readExample);
    const obstacles = docs.flatMap((doc) => doc.obstacles);
    const aisles = docs.flatMap((doc) => doc.aisles);
    const lanes = aisles.flatMap((aisle) => aisle.lanes);
    const rackTypes = docs.flatMap((doc) => doc.rackTypes);

    const values = <T>(items: readonly T[], pick: (item: T) => string) =>
      new Set(items.map(pick));

    // Obstacle kinds — all five exist, so all five are shown.
    expect(values(obstacles, (o) => o.kind)).toEqual(
      new Set(['COLUMN', 'PILLAR', 'WALL', 'OFFICE', 'CUSTOM']),
    );
    // Aisle orientation and travel direction.
    expect(values(aisles, (a) => a.orientation)).toEqual(new Set(['X', 'Z']));
    expect(values(aisles, (a) => a.travelDirection)).toEqual(
      new Set(['BOTH', 'FORWARD', 'REVERSE']),
    );
    // Both rack faces, and rack types that differ in bay width and depth.
    expect(values(lanes, (l) => l.side)).toEqual(new Set(['LEFT', 'RIGHT']));
    expect(new Set(rackTypes.map((r) => r.bayWidthM)).size).toBeGreaterThan(1);
    expect(new Set(rackTypes.map((r) => r.depthM)).size).toBeGreaterThan(1);

    // Lane features: inset runs, reserved bays, custom bin codes and level weights.
    expect(lanes.some((lane) => lane.startOffsetM > 0), 'no lane uses startOffsetM').toBe(true);
    expect(lanes.some((lane) => (lane.skipBays ?? []).length > 0), 'no lane skips a bay').toBe(true);
    expect(
      lanes.some((lane) => lane.binCodePattern !== undefined),
      'no lane sets a binCodePattern',
    ).toBe(true);
    expect(
      lanes.some((lane) => lane.levels.some((level) => level.maxWeightKg !== undefined)),
      'no level sets a weight limit',
    ).toBe(true);
    // Per-lane level counts that differ, which is the point of levels being per lane.
    expect(new Set(lanes.map((lane) => lane.levels.length)).size).toBeGreaterThan(1);

    // Runs: at least one lane is split by two gaps, i.e. really divided rather than just
    // having something removed from one end.
    const gapCounts = lanes.map(
      (lane) => (lane.segments ?? []).filter((segment) => segment.kind === 'GAP').length,
    );
    expect(Math.max(...gapCounts), 'no lane has two cross-aisles').toBeGreaterThanOrEqual(2);
    expect(Math.max(...gapCounts), 'no lane has a gap').toBeGreaterThan(0);

    // Custom fields, on every entity that supports them.
    expect(docs.some((doc) => Object.keys(doc.warehouse.metadata).length > 0)).toBe(true);
    expect(rackTypes.some((rt) => Object.keys(rt.metadata).length > 0)).toBe(true);
    expect(aisles.some((aisle) => Object.keys(aisle.metadata).length > 0)).toBe(true);
    expect(lanes.some((lane) => Object.keys(lane.metadata).length > 0)).toBe(true);
    expect(obstacles.some((obstacle) => Object.keys(obstacle.metadata).length > 0)).toBe(true);
  });
});
