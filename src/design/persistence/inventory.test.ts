/**
 * The client half of the Phase 8 DoD.
 *
 * DoD: *dropping an oversized SKU is rejected client-side and server-side with the same
 * diagnostic code.* The server half is `server/tests/test_inventory.py`. This file
 * covers the client half, in two ways:
 *
 *  1. by running the shared placement fixtures through `checkPlacement`, which is what
 *     the drag ghost uses — so the code the user sees while dragging is pinned by the
 *     same vectors both compilers run;
 *  2. the local arithmetic around it: remaining capacity, excluding the SKU being
 *     replaced, and the heatmap ramp.
 */
import { describe, expect, it } from 'vitest';

import placementCases from '../../../fixtures/placement-conformance/cases.json';
import type { SkuDto } from './apiClient';
import { checkPlacement, usedInBin, utilizationColor } from './inventory';

function sku(overrides: Partial<SkuDto> = {}): SkuDto {
  return {
    id: 'sku-1',
    sku: 'SKU-1',
    name: 'Test',
    widthM: 1.2,
    heightM: 1.1,
    depthM: 0.8,
    weightKg: 100,
    stackable: true,
    rotatable: true,
    hazmat: false,
    placedQty: 0,
    ...overrides,
  } as SkuDto;
}

describe('the shared placement fixtures, through the drag ghost', () => {
  it.each(placementCases.cases.map((entry) => [entry.name, entry] as const))(
    '%s',
    (_name, entry) => {
      const bin = {
        widthM: entry.bin.widthM,
        heightM: entry.bin.heightM,
        depthM: entry.bin.depthM,
        capacityM3: entry.bin.capacityM3,
        maxWeightKg: entry.bin.maxWeightKg,
      };

      const verdict = checkPlacement(
        bin,
        { volumeM3: 0, weightKg: 0 },
        sku({
          widthM: entry.item.widthM,
          heightM: entry.item.heightM,
          depthM: entry.item.depthM,
          weightKg: entry.item.weightKg,
          rotatable: entry.item.rotatable ?? true,
        }),
        entry.qty,
      );

      expect(verdict.fits).toBe(entry.expected.fits);
      expect(verdict.code).toBe(entry.expected.code);
    },
  );
});

describe('checkPlacement', () => {
  const bin = {
    widthM: 2.7,
    heightM: 1.4,
    depthM: 1.0,
    capacityM3: 3.213,
    maxWeightKg: 800,
  };

  it('accepts a quantity that fits', () => {
    expect(checkPlacement(bin, { volumeM3: 0, weightKg: 0 }, sku(), 1).fits).toBe(true);
  });

  it('refuses an item taller than the opening, naming the opening rule', () => {
    const verdict = checkPlacement(bin, { volumeM3: 0, weightKg: 0 }, sku({ heightM: 3 }), 1);
    expect(verdict.fits).toBe(false);
    expect(verdict.code).toBe('ITEM_DOES_NOT_FIT_OPENING');
  });

  it('refuses a quantity that overruns the volume, naming the volume rule', () => {
    const verdict = checkPlacement(bin, { volumeM3: 0, weightKg: 0 }, sku(), 5);
    expect(verdict.code).toBe('EXCEEDS_BIN_VOLUME');
  });

  it('refuses a weight that breaks the beam limit, naming the weight rule', () => {
    const verdict = checkPlacement(
      bin,
      { volumeM3: 0, weightKg: 0 },
      sku({ widthM: 0.5, heightM: 0.5, depthM: 0.5, weightKg: 900 }),
      1,
    );
    expect(verdict.code).toBe('EXCEEDS_BIN_WEIGHT');
  });

  it('counts what is already in the bin against the drop', () => {
    // One fits with room to spare; the same drop onto an occupied bin does not.
    expect(checkPlacement(bin, { volumeM3: 0, weightKg: 0 }, sku(), 2).fits).toBe(true);

    const verdict = checkPlacement(bin, { volumeM3: 2.0, weightKg: 0 }, sku(), 2);
    expect(verdict.fits).toBe(false);
    expect(verdict.code).toBe('EXCEEDS_BIN_VOLUME');
  });

  it('skips the weight check when the level has no limit', () => {
    const unlimited = { ...bin, maxWeightKg: null };
    const heavy = sku({ widthM: 0.5, heightM: 0.5, depthM: 0.5, weightKg: 5000 });

    expect(checkPlacement(unlimited, { volumeM3: 0, weightKg: 0 }, heavy, 1).fits).toBe(true);
  });
});

describe('usedInBin', () => {
  const entry = {
    binId: 'bin-1',
    binCode: 'WH1/A01/L/B001/L1',
    capacityM3: 3.2,
    maxWeightKg: 800,
    usedVolumeM3: 1.5,
    usedWeightKg: 300,
    remainingVolumeM3: 1.7,
    remainingWeightKg: 500,
    utilization: 0.47,
    placements: [
      {
        id: 'p1',
        binId: 'bin-1',
        binCode: 'WH1/A01/L/B001/L1',
        skuId: 'sku-1',
        sku: 'SKU-1',
        qty: 1,
        volumeUsedM3: 1.0,
        weightUsedKg: 200,
      },
      {
        id: 'p2',
        binId: 'bin-1',
        binCode: 'WH1/A01/L/B001/L1',
        skuId: 'sku-2',
        sku: 'SKU-2',
        qty: 1,
        volumeUsedM3: 0.5,
        weightUsedKg: 100,
      },
    ],
  };

  it('sums everything in the bin', () => {
    expect(usedInBin(entry)).toEqual({ volumeM3: 1.5, weightKg: 300 });
  });

  it('can exclude one SKU, because a re-drop replaces its row rather than adding to it', () => {
    // Without this, re-dropping a SKU already in a full bin would be refused for space
    // it is about to free.
    expect(usedInBin(entry, { excludeSkuId: 'sku-1' })).toEqual({
      volumeM3: 0.5,
      weightKg: 100,
    });
  });

  it('reports nothing for a bin that has never been loaded', () => {
    expect(usedInBin(undefined)).toEqual({ volumeM3: 0, weightKg: 0 });
  });
});

describe('the heatmap ramp', () => {
  it('gives an empty bin its own neutral colour rather than the lowest step', () => {
    expect(utilizationColor(0)).not.toBe(utilizationColor(0.01));
  });

  it('moves through distinct colours as a bin fills', () => {
    const swatches = [0, 0.2, 0.4, 0.6, 0.8, 1].map(utilizationColor);
    expect(new Set(swatches).size).toBe(swatches.length);
  });
});
