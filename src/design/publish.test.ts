/**
 * The publish gate and payload.
 *
 * The gate is the whole point of Phase 6: a layout with an error must not be
 * publishable, and fixing the error must be the only thing needed to make it
 * publishable. These tests pin both directions, so the gate cannot quietly become a
 * formality.
 */
import { describe, expect, it } from 'vitest';

import { buildLayout, sha256Hex, type LayoutDocInput } from 'layout-core';

import { createInitialDoc } from './initialDoc';
import {
  buildPublishPayload,
  canonicalJson,
  publishSummary,
  readableJson,
} from './publish';

/** The starting document, with one lane made too long for the building. */
function outOfBoundsDoc(): LayoutDocInput {
  const doc = createInitialDoc();
  doc.warehouse.lengthM = 12; // the aisles still run 3 → 37
  return doc;
}

/**
 * Input documents have optional collections (the schema supplies the defaults), so
 * reaching into one needs a check rather than an assertion.
 */
function firstLane(doc: LayoutDocInput) {
  const lane = doc.aisles?.[0]?.lanes?.[0];
  if (!lane) throw new Error('expected the starting document to have a first lane');
  return lane;
}

describe('publishSummary', () => {
  it('counts what the compiler derived, not what the document declares', () => {
    const graph = buildLayout(createInitialDoc());
    const summary = publishSummary(graph);

    expect(summary.warehouseCode).toBe('WH1');
    expect(summary.aisles).toBe(3);
    expect(summary.lanes).toBe(6);
    expect(summary.levels).toBe(30); // 6 lanes × 5 levels
    expect(summary.bays).toBe(72); // 6 lanes × 12 bays
    expect(summary.activeBays).toBe(72);
    expect(summary.bins).toBe(360); // 72 bays × 5 levels
    expect(summary.bins).toBe(graph.bins.length);
  });

  it('separates active bays from gap and reserved ones', () => {
    const doc = createInitialDoc();
    const lane = firstLane(doc);
    lane.skipBays = [1, 2];
    lane.segments = [
      { kind: 'RACK', startM: 0, endM: 10.8 },
      { kind: 'GAP', startM: 10.8, endM: 16.2 },
      { kind: 'RACK', startM: 16.2, endM: 32.4 },
    ];

    const summary = publishSummary(buildLayout(doc));
    expect(summary.bays).toBe(72); // the lane is still 12 bays long
    expect(summary.activeBays).toBeLessThan(72);
    expect(summary.bins).toBeLessThan(360);
  });
});

describe('the publish gate', () => {
  it('allows the starting layout', () => {
    const graph = buildLayout(createInitialDoc());
    expect(graph.errorCount).toBe(0);
    expect(graph.publishable).toBe(true);
  });

  it('blocks a lane that runs outside the building, and says which bay', () => {
    const graph = buildLayout(outOfBoundsDoc());

    expect(graph.publishable).toBe(false);
    expect(graph.errorCount).toBeGreaterThan(0);

    const outOfFootprint = graph.diagnostics.filter(
      (diagnostic) => diagnostic.code === 'BIN_OUT_OF_FOOTPRINT',
    );
    expect(outOfFootprint.length).toBeGreaterThan(0);
    expect(outOfFootprint[0]!.severity).toBe('error');
    expect(outOfFootprint[0]!.entityRefs.some((ref) => ref.kind === 'bay')).toBe(true);
  });

  it('becomes publishable again once the building is big enough — the only change', () => {
    const broken = outOfBoundsDoc();
    expect(buildLayout(broken).publishable).toBe(false);

    broken.warehouse.lengthM = 40;
    expect(buildLayout(broken).publishable).toBe(true);
  });

  it('does not block on warnings alone', () => {
    // A lane shorter than one bay is a warning (LANE_ZERO_BAYS), not an error.
    const doc = createInitialDoc();
    firstLane(doc).lengthM = 1;

    const graph = buildLayout(doc);
    expect(graph.warningCount).toBeGreaterThan(0);
    expect(graph.errorCount).toBe(0);
    expect(graph.publishable).toBe(true);
  });
});

describe('the payload', () => {
  it('carries the compiler hash, and the canonical form still hashes to it', () => {
    const graph = buildLayout(createInitialDoc());
    const payload = buildPublishPayload(graph);

    expect(payload.docHash).toBe(graph.hash);
    // The invariant the server relies on: hash(canonical(doc)) === docHash.
    expect(sha256Hex(canonicalJson(graph))).toBe(graph.hash);
  });

  it('is stable for the same document', () => {
    const first = canonicalJson(buildLayout(createInitialDoc()));
    const second = canonicalJson(buildLayout(createInitialDoc()));
    expect(first).toBe(second);
  });

  it('reads back as JSON containing the document and the hash', () => {
    const graph = buildLayout(createInitialDoc());
    const parsed = JSON.parse(readableJson(graph)) as { docHash: string; doc: unknown };
    expect(parsed.docHash).toBe(graph.hash);
    expect(parsed.doc).toBeTruthy();
  });
});
