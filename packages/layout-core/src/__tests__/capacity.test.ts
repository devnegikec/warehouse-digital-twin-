import { describe, expect, it } from 'vitest';

import { itemFits, orientationsOf, usableVolumeM3, utilization, validatePlacement } from '../capacity.js';
import { formatBinCode, isValidCodePattern, tokensInPattern } from '../ids.js';

const BIN = {
  widthM: 2.7,
  heightM: 1.6,
  depthM: 1,
  capacityM3: usableVolumeM3(2.7, 1.6, 1),
  maxWeightKg: 500,
};

const PALLET = { widthM: 1.2, heightM: 1.1, depthM: 0.8, weightKg: 100, rotatable: true };

/**
 * Height-constrained bin whose 1.3 m depth is the only reason the item fits:
 * the pallet has to be laid on its side.
 */
const TALL_BIN = {
  widthM: 2.7,
  heightM: 1.0,
  depthM: 1.3,
  capacityM3: usableVolumeM3(2.7, 1.0, 1.3),
  maxWeightKg: null,
};
const SIDEWAYS_ITEM = { widthM: 1.2, heightM: 1.4, depthM: 0.9, weightKg: 50, rotatable: true };

describe('usableVolumeM3', () => {
  it('applies the utilisation factor', () => {
    expect(usableVolumeM3(2.7, 1.6, 1)).toBe(3.672);
  });

  it('honours a custom utilisation factor', () => {
    expect(usableVolumeM3(2, 2, 2, 1)).toBe(8);
  });
});

describe('orientationsOf', () => {
  it('offers six distinct orientations for a fully rotatable box', () => {
    expect(orientationsOf({ widthM: 1, heightM: 2, depthM: 3 }, true)).toHaveLength(6);
  });

  it('de-duplicates orientations for a cubic item', () => {
    expect(orientationsOf({ widthM: 1, heightM: 1, depthM: 1 }, true)).toHaveLength(1);
  });

  it('pins the authored orientation when not rotatable', () => {
    expect(orientationsOf({ widthM: 1, heightM: 2, depthM: 3 }, false)).toEqual([[1, 2, 3]]);
  });
});

describe('itemFits', () => {
  it('accepts an item that fits the opening, volume and weight', () => {
    const result = itemFits(BIN, PALLET, 1);
    expect(result.fits).toBe(true);
    expect(result.orientation).toBeDefined();
  });

  it('rotates an item to make it fit', () => {
    const result = itemFits(TALL_BIN, SIDEWAYS_ITEM, 1);
    expect(result.fits).toBe(true);
    // Laid on its side: height of the chosen orientation must respect the 1.0 m opening.
    expect(result.orientation?.[1]).toBeLessThanOrEqual(1.0);
  });

  it('refuses an item too large for the opening in every orientation', () => {
    const result = itemFits(BIN, { ...PALLET, widthM: 3.5 }, 1);
    expect(result.fits).toBe(false);
    expect(result.failure?.code).toBe('ITEM_DOES_NOT_FIT_OPENING');
  });

  it('refuses when the pinned orientation does not fit', () => {
    const result = itemFits(TALL_BIN, { ...SIDEWAYS_ITEM, rotatable: false }, 1);
    expect(result.fits).toBe(false);
    expect(result.failure?.code).toBe('ITEM_DOES_NOT_FIT_OPENING');
  });

  it('refuses when the aggregate volume exceeds capacity', () => {
    // 3.672 m3 usable, 1.056 m3 each, 100 kg each -> 3 fit on both counts.
    expect(itemFits(BIN, PALLET, 3).fits).toBe(true);
    const tooMany = itemFits(BIN, PALLET, 5);
    expect(tooMany.fits).toBe(false);
    expect(tooMany.failure?.code).toBe('EXCEEDS_BIN_VOLUME');
  });

  it('refuses when the aggregate weight exceeds the beam limit', () => {
    const result = itemFits(BIN, { ...PALLET, weightKg: 250 }, 3); // 750 kg > 500 kg
    expect(result.fits).toBe(false);
    expect(result.failure?.code).toBe('EXCEEDS_BIN_WEIGHT');
  });

  it('skips the weight check when the level has no limit', () => {
    expect(itemFits({ ...BIN, maxWeightKg: null }, { ...PALLET, weightKg: 9000 }, 1).fits).toBe(true);
  });

  it('rejects a non-positive quantity', () => {
    expect(itemFits(BIN, PALLET, 0).fits).toBe(false);
    expect(itemFits(BIN, PALLET, -1).failure?.code).toBe('QTY_NOT_POSITIVE');
  });
});

describe('validatePlacement', () => {
  const ctx = { binCode: 'WH1/A01/L/B001/L1', sku: 'SKU-1' };

  it('returns no diagnostics when the placement fits', () => {
    expect(validatePlacement(BIN, PALLET, 1, ctx)).toEqual([]);
  });

  it('returns a ref-bearing diagnostic when it does not', () => {
    const diagnostics = validatePlacement(BIN, PALLET, 5, ctx);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe('EXCEEDS_BIN_VOLUME');
    expect(diagnostics[0]?.severity).toBe('error');
    expect(diagnostics[0]?.entityRefs).toEqual([
      { kind: 'bin', id: ctx.binCode, label: ctx.binCode },
      { kind: 'sku', id: ctx.sku, label: ctx.sku },
    ]);
  });
});

describe('utilization', () => {
  it('reports the consumed fraction', () => {
    expect(utilization(BIN, 1.056, 1)).toBe(0.2876);
  });

  it('returns zero for a zero-capacity bin instead of dividing by zero', () => {
    expect(utilization({ ...BIN, capacityM3: 0 }, 1, 1)).toBe(0);
  });
});

describe('bin code formatting', () => {
  const parts = {
    warehouse: 'WH1',
    aisle: 'A03',
    lane: 'A03-L',
    side: 'LEFT' as const,
    baySeq: 12,
    levelIndex: 1,
  };

  it('renders the default pattern with zero padding', () => {
    expect(formatBinCode('{warehouse}/{aisle}/{side}/B{bay:03}/L{level}', parts)).toBe(
      'WH1/A03/L/B012/L2',
    );
  });

  it('renders the 1-based level number', () => {
    expect(formatBinCode('L{level}', { ...parts, levelIndex: 0 })).toBe('L1');
  });

  it('supports the lane token', () => {
    expect(formatBinCode('{lane}-B{bay}', parts)).toBe('A03-L-B12');
  });

  it('validates patterns against the allowed token list', () => {
    expect(isValidCodePattern('{warehouse}/{aisle}/{side}/B{bay:03}/L{level}')).toBe(true);
    expect(isValidCodePattern('{(warehouse}')).toBe(false);
    expect(isValidCodePattern('{nope}/{aisle}')).toBe(false);
    expect(isValidCodePattern('no-placeholders')).toBe(false);
  });

  it('extracts tokens from a pattern', () => {
    expect(tokensInPattern('{warehouse}/{aisle}/{side}/B{bay:03}/L{level}')).toEqual([
      'warehouse',
      'aisle',
      'side',
      'bay',
      'level',
    ]);
  });
});
