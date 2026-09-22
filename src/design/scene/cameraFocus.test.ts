/**
 * Camera focus resolution.
 *
 * These matter because a diagnostic's `entityRefs` are the only link between a
 * message and a place in the layout. If resolution is wrong the camera flies to the
 * wrong thing and the error looks unfixable, which is worse than not flying at all.
 */
import { describe, expect, it } from 'vitest';

import { buildLayout, type EntityRef, type LayoutDocInput } from 'layout-core';

import { createInitialDoc } from '../initialDoc';
import { mostSpecificRef, resolveFocus } from './cameraFocus';

function graphOf(doc: LayoutDocInput) {
  return buildLayout(doc);
}

describe('mostSpecificRef', () => {
  it('picks the narrowest entity, so a bay beats the lane that cites it', () => {
    const refs: EntityRef[] = [
      { kind: 'lane', id: 'a-1-l', label: 'A01-L' },
      { kind: 'bay', id: 'a-1-l:7', label: 'B7' },
      { kind: 'warehouse', id: 'WH1', label: 'WH1' },
    ];
    expect(mostSpecificRef(refs)?.kind).toBe('bay');
  });

  it('falls back to the coarser entity when there is no narrow one', () => {
    const refs: EntityRef[] = [
      { kind: 'warehouse', id: 'WH1' },
      { kind: 'lane', id: 'a-1-l' },
    ];
    expect(mostSpecificRef(refs)?.kind).toBe('lane');
  });

  it('returns null for no refs rather than guessing', () => {
    expect(mostSpecificRef([])).toBeNull();
  });
});

describe('resolveFocus', () => {
  const raw = createInitialDoc();

  it('points at the middle of the footprint for the warehouse', () => {
    const graph = graphOf(raw);
    const target = resolveFocus(graph, { kind: 'warehouse', id: 'WH1' });
    expect(target).not.toBeNull();
    expect(target!.x).toBeCloseTo(20);
    expect(target!.z).toBeCloseTo(10);
  });

  it('lands inside the aisle it is given', () => {
    const graph = graphOf(raw);
    // The middle aisle sits at z = 11.
    const target = resolveFocus(graph, { kind: 'aisle', id: 'a-2' });
    expect(target).not.toBeNull();
    expect(target!.z).toBeCloseTo(11, 0);
  });

  it('lands on the rack band for a lane, not on the corridor centre', () => {
    const graph = graphOf(raw);
    const target = resolveFocus(graph, { kind: 'lane', id: 'a-2-l' })!;
    const aisleZ = 11;
    const rackCentreZ = 11 - (3.4 / 2 + 1.1 / 2); // corridor half-width + rack half-depth
    expect(target.z).toBeCloseTo(rackCentreZ, 1);
    expect(Math.abs(target.z - aisleZ)).toBeGreaterThan(2);
  });

  it('uses the exact derived centre for a bin', () => {
    const graph = graphOf(raw);
    const bin = graph.bins[0]!;
    const target = resolveFocus(graph, { kind: 'bin', id: bin.code })!;
    expect(target.x).toBeCloseTo(bin.center.x);
    expect(target.y).toBeCloseTo(bin.center.y);
    expect(target.z).toBeCloseTo(bin.center.z);
  });

  it('resolves a bay ref, whose id carries the lane id and the bay number', () => {
    const graph = graphOf(raw);
    const target = resolveFocus(graph, { kind: 'bay', id: 'a-1-l:3' })!;
    const bay = graph.bays.find((candidate) => candidate.laneCode === 'A01-L' && candidate.seq === 3)!;
    expect(target.x).toBeCloseTo(bay.center.x);
    expect(target.z).toBeCloseTo(bay.center.z);
  });

  it('lifts the camera for a level ref, so a tall stack is visible', () => {
    const graph = graphOf(raw);
    const ground = resolveFocus(graph, { kind: 'lane', id: 'a-1-l' })!;
    const top = resolveFocus(graph, { kind: 'level', id: 'a-1-l:4' })!;
    expect(top.y).toBeGreaterThan(ground.y);
  });

  it('returns null for an id that is not in the document', () => {
    const graph = graphOf(raw);
    expect(resolveFocus(graph, { kind: 'aisle', id: 'nope' })).toBeNull();
    expect(resolveFocus(graph, { kind: 'bin', id: 'NOPE' })).toBeNull();
  });
});
