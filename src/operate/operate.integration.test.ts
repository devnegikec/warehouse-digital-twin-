/**
 * The Phase 9 DoD, end to end: *a layout designed in Design mode renders identically in
 * Operate mode.*
 *
 * The two modes reach the canvas by different routes — one through the compiler in the
 * browser, the other through the publish transaction, the database, and `GET /layout` —
 * so "identical" is exactly the kind of claim that quietly stops being true. This test
 * takes a real layout, publishes it to a real server, loads it back as an operator would,
 * and compares the two projections slot by slot.
 *
 * A difference would show up here as a wrong position, a wrong size, a missing bin or a
 * changed capacity — the things that would make the viewer a lie.
 *
 * Skipped when the API is not running, so `npm run test:app` still works without it.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import { buildLayout } from 'layout-core';

import { createInitialDoc } from '../design/initialDoc';
import { apiBaseUrl } from '../design/persistence/apiClient';
import { connect, disconnect, publishLayout } from '../design/persistence/session';
import { designStore } from '../design/store/designStore';
import { getLayoutSource, loadLayoutSource } from './layoutSource';
import { deriveSlots } from './slots';

const API = apiBaseUrl();

async function apiIsUp(): Promise<boolean> {
  try {
    const response = await fetch(`${API}/health`, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

let reachable = false;

beforeAll(async () => {
  reachable = await apiIsUp();
  return () => disconnect();
});

describe('a designed layout renders identically in Operate mode', () => {
  it('produces the same slots from the published layout as from the compiler', async () => {
    if (!reachable) {
      console.warn(`Skipping the operate/design comparison: no API at ${API}`);
      return;
    }

    // A unique warehouse code, so repeated runs cannot collide on the code the server
    // keys on — and so the document the two sides compare is unambiguous.
    const code = `WH-OPS-${Math.floor(Math.random() * 1_000_000)}`;
    const doc = createInitialDoc();
    doc.warehouse.code = code;

    designStore.getState().loadDocument(doc);

    await connect(code);
    const published = await publishLayout('operate-test');
    expect(published.ok, JSON.stringify(published)).toBe(true);

    await loadLayoutSource();
    const source = getLayoutSource();
    expect(source.mode).toBe('published');

    // What Design mode shows: the compiler's own output for the same document.
    const localSlots = deriveSlots(designStore.getState().graph.bins, new Map());

    expect(source.slots).toHaveLength(localSlots.length);

    const publishedByCode = new Map(source.slots.map((slot) => [slot.binCode, slot]));
    expect(publishedByCode.size).toBe(source.slots.length);

    for (const local of localSlots) {
      const remote = publishedByCode.get(local.binCode);
      // Same bins, by the natural key both sides are joined on.
      expect(remote, `bin ${local.binCode} is missing from the published layout`).toBeDefined();
      if (!remote) continue;

      expect(remote.position).toEqual(local.position);
      expect(remote.size).toEqual(local.size);
      expect(remote.rotationDeg).toBe(local.rotationDeg);
      expect(remote.capacityM3).toBe(local.capacityM3);
      expect(remote.maxWeightKg).toBe(local.maxWeightKg);
      expect(remote.aisleCode).toBe(local.aisleCode);
      expect(remote.laneCode).toBe(local.laneCode);
      expect(remote.baySeq).toBe(local.baySeq);
      expect(remote.levelIndex).toBe(local.levelIndex);
    }

    // The published path carries ids; the compiler's bins do not, by design.
    expect(source.slots.every((slot) => slot.binId !== null)).toBe(true);
    expect(localSlots.every((slot) => slot.binId === null)).toBe(true);

    // Nothing is placed yet, so every bin is empty in both views.
    expect(source.summary.occupiedBins).toBe(0);
    expect(source.summary.bins).toBe(localSlots.length);

    // Publishing promotes the draft, so there is nothing left to discard.
    disconnect();
  });
});
