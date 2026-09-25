/**
 * The picking route, derived from real aisles.
 *
 * The DoD includes "the picking route still works", and the old version could not have
 * been wrong in an interesting way: it walked a fixed set of bay indices against a
 * hardcoded aisle spacing. These tests pin the behaviour that matters now — the route
 * runs down the corridor of an aisle that exists, in the order an operator would walk it.
 */
import { describe, expect, it } from 'vitest';

import { buildLayout } from 'layout-core';

import { createInitialDoc } from '../design/initialDoc';
import { aisleCentrelines } from './PickingRoute';
import { deriveSlots, type OperateBin } from './slots';

function slotsFor() {
  return deriveSlots(buildLayout(createInitialDoc()).bins as OperateBin[], new Map());
}

describe('aisleCentrelines', () => {
  it('finds one centreline per aisle in the layout', () => {
    const slots = slotsFor();
    const aisles = new Set(slots.map((slot) => slot.aisleCode));
    expect(aisleCentrelines(slots)).toHaveLength(aisles.size);
    expect(aisleCentrelines(slots).length).toBe(3);
  });

  it('walks the corridor, not a rack face', () => {
    // The initial layout has a left and a right lane per aisle, 3.4 m apart, so the
    // centreline must sit between them rather than on either one.
    const slots = slotsFor();
    const aisle = 'A02';
    const inAisle = slots.filter((slot) => slot.aisleCode === aisle);
    // The aisles run along X, so the two faces differ in z — which is position index 2.
    const faces = [...new Set(inAisle.map((slot) => slot.position[2]))].sort((a, b) => a - b);
    expect(faces).toHaveLength(2);

    const centreline = aisleCentrelines(slots).find((line) => line.code === aisle);
    expect(centreline).toBeDefined();
    if (!centreline) return;

    const corridor = centreline.from[1];
    expect(corridor).toBeGreaterThan(faces[0]!);
    expect(corridor).toBeLessThan(faces[1]!);
    expect(corridor).toBeCloseTo((faces[0]! + faces[1]!) / 2, 6);
  });

  it('runs along the aisle, spanning its bays', () => {
    const slots = slotsFor();
    const line = aisleCentrelines(slots).find((entry) => entry.code === 'A01');
    expect(line).toBeDefined();
    if (!line) return;

    // The initial layout runs along X from 3 m to 37 m.
    expect(line.from[0]).toBeLessThan(line.to[0]);
    expect(line.from[0]).toBeGreaterThan(2);
    expect(line.to[0]).toBeLessThan(38);
  });

  it('orders the aisles so a serpentine route is walkable', () => {
    const codes = aisleCentrelines(slotsFor()).map((line) => line.code);
    expect(codes).toEqual([...codes].sort());
  });

  it('returns nothing for a layout with no bins', () => {
    expect(aisleCentrelines([])).toEqual([]);
  });
});
