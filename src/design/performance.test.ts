/**
 * Performance guards, at the scale the design targets.
 *
 * Frame time cannot be measured here — that needs a GPU and a browser — so these tests
 * cover the part that *can* regress silently: the work done per update on the main thread.
 * The bugs they exist to catch are algorithmic, not micro-optimisations:
 *
 *  - grouping bays once per lane instead of once per layout (O(bays × lanes));
 *  - rebuilding every instance transform on hover, when only the colours changed;
 *  - drawing one plan-view rectangle per bay, so the DOM — not the GPU — is the limit.
 *
 * ## How the guards are written, and why
 *
 * Every budget here is a **ceiling, not a target**, and each test also sets an explicit
 * `timeout` well above that ceiling. That combination is the whole design: a test whose
 * budget sits near vitest's default 5 s timeout fails as an opaque "Test timed out" and
 * never runs its own assertion, so the failure says nothing about which number was
 * exceeded. A guard that cannot report its own measurement is not a guard.
 *
 * Where a claim can be expressed as a **ratio between two runs on the same machine**, it
 * is, because that survives a loaded CI box in a way an absolute budget cannot. A ratio is
 * used only where the operation really is linear — run grouping is — because a ratio against
 * a superlinear baseline has no margin between "normal" and "broken" (see the note on the
 * compile test). The absolute ceilings exist to catch a catastrophic blow-up, so they sit
 * several times above any measurement taken on an idle machine.
 *
 * Each budget is recorded next to the measurement it was set from. Without that, a future
 * reader cannot tell a regression from a machine having a bad day, and the usual response to
 * an unexplained failure is to raise the number.
 *
 * For the same reason the timings use the **minimum of a few runs**. A minimum approximates
 * the true cost of the code; a mean measures the machine.
 */
import { describe, expect, it } from 'vitest';

import { buildLayout } from 'layout-core';

import { createInitialDoc } from './initialDoc';
import { largeDoc } from './perfFixtures';
import { rackRuns } from './scene/rackRuns';
import { deriveSlots, summarize, type OperateBin } from '../operate/slots';

const testTimeout = 90_000;

function elapsed(fn: () => void): number {
  const started = performance.now();
  fn();
  return performance.now() - started;
}

/** The fastest of `runs` attempts: closer to the cost of the code than the machine. */
function bestOf(runs: number, fn: () => void): number {
  let best = Infinity;
  for (let index = 0; index < runs; index += 1) best = Math.min(best, elapsed(fn));
  return best;
}

/**
 * The 100k-bin graph, compiled once for the whole file.
 *
 * Building it per test would make this suite cost ~10s of setup for the same result, and
 * a slow suite is a suite that gets skipped.
 */
let cachedGraph: ReturnType<typeof buildLayout> | null = null;
function hundredK() {
  cachedGraph ??= buildLayout(largeDoc(100_000));
  return cachedGraph;
}

describe('a 100k-bin layout stays workable', () => {
  it(
    'compiles 100k bins in the time the design assumes',
    () => {
      const large = largeDoc(100_000);

      // The first compile is also the warm-up, and seeds the shared graph so the rest of
      // the file does not pay for another one.
      const graph = buildLayout(large);
      expect(graph.bins.length).toBeGreaterThan(90_000);
      cachedGraph = graph;

      const duration = Math.max(bestOf(2, () => buildLayout(large)), 1);

      // Measured on an idle machine: **1769 ms**, and about 5.3 s on a busy one.
      //
      // There is deliberately no ratio guard here. Compiling is not linear at this scale —
      // measured as roughly n^1.7 (4.2x the bins costs 11.9x the time, 8.3x costs 32.7x),
      // which is allocation and cache pressure rather than one hot spot. Against that
      // baseline a quadratic regression would be about 69x, i.e. barely distinguishable
      // from normal, so a ratio budget would be either meaningless or flaky. The guards
      // with real teeth in this file are the structural ones — run count and plan-view
      // rectangle count — which hold regardless of the machine.
      expect(duration, `compile took ${duration.toFixed(0)} ms`).toBeLessThan(15_000);
    },
    testTimeout,
  );

  it(
    'projects to operate slots in one pass over the bins',
    () => {
      const bins = hundredK().bins as OperateBin[];
      expect(bins.length).toBeGreaterThan(90_000);

      let slots: ReturnType<typeof deriveSlots> = [];
      const duration = bestOf(2, () => {
        slots = deriveSlots(bins, new Map());
      });

      expect(slots).toHaveLength(bins.length);
      // Measured on an idle machine: 12 ms. A quadratic projection would be minutes, so
      // this still discriminates by two orders of magnitude.
      expect(duration, `projection took ${duration.toFixed(0)} ms`).toBeLessThan(1500);
    },
    testTimeout,
  );

  it(
    'summarises 100k slots in one pass',
    () => {
      const slots = deriveSlots(hundredK().bins as OperateBin[], new Map());
      const duration = bestOf(2, () => summarize(slots));

      // Measured on an idle machine: 3 ms.
      expect(duration, `summary took ${duration.toFixed(0)} ms`).toBeLessThan(500);
    },
    testTimeout,
  );

  it(
    'groups bays into runs without re-grouping per lane',
    () => {
      const graph = hundredK();
      const lanes = new Set(graph.bays.map((bay) => bay.laneCode));
      expect(lanes.size).toBeGreaterThan(100);

      let runs: ReturnType<typeof rackRuns> = [];
      const duration = bestOf(2, () => {
        runs = rackRuns(graph.bays);
      });

      // One run per lane when the racks are continuous: the grouping must not multiply the
      // bay count by the lane count. This structural assertion is the real guard — it is
      // true or false regardless of how busy the machine is.
      expect(runs.length).toBeLessThanOrEqual(lanes.size);
      expect(runs.length).toBeGreaterThan(0);
      // Measured on an idle machine: 2 ms.
      expect(duration, `run grouping took ${duration.toFixed(0)} ms`).toBeLessThan(500);
    },
    testTimeout,
  );

  it('aggregates the plan view to a handful of rectangles per lane, not one per bay', () => {
    const graph = hundredK();
    const lanes = new Set(graph.bays.map((bay) => bay.laneCode));
    const runs = rackRuns(graph.bays);

    // This is the number that decides whether the plan view is a DOM hazard. No timing is
    // involved, so this test cannot be flaky on any machine.
    expect(runs.length).toBeLessThan(lanes.size * 4);
    expect(graph.bays.length / runs.length).toBeGreaterThan(10);
  });

  it(
    'scales linearly rather than quadratically when aisles are added',
    () => {
      // The old grouping was O(bays × lanes). Quadrupling the layout would then have cost
      // roughly sixteen times as much; the ratio here must stay well under that.
      const small = buildLayout(largeDoc(12_000));
      const large = buildLayout(largeDoc(48_000));

      expect(large.bays.length).toBeGreaterThan(small.bays.length * 3.5);

      // Warm both paths first, so the ratio compares the algorithm rather than the JIT.
      rackRuns(small.bays);
      rackRuns(large.bays);

      const smallTime = Math.max(bestOf(3, () => rackRuns(small.bays)), 0.5);
      const largeTime = bestOf(3, () => rackRuns(large.bays));
      const ratio = largeTime / smallTime;

      expect(ratio, `4x the bays cost ${ratio.toFixed(1)}x the time`).toBeLessThan(10);
    },
    testTimeout,
  );
});

describe('the small layout the designer opens with', () => {
  it(
    'stays in the millisecond range, so the editor never feels slow to start',
    () => {
      const doc = createInitialDoc();
      const duration = bestOf(3, () => {
        const graph = buildLayout(doc);
        deriveSlots(graph.bins as OperateBin[], new Map());
        rackRuns(graph.bays);
      });

      // Measured on an idle machine: 1.4 ms for compile + projection + grouping together.
      // The budget leaves room for a slow machine while still catching anything that would
      // be noticeable at all.
      expect(duration, `first compile took ${duration.toFixed(0)} ms`).toBeLessThan(250);
    },
    testTimeout,
  );
});
