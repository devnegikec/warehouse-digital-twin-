/**
 * The Operate-mode projection, and the Phase 9 DoD.
 *
 * DoD: *a layout designed in Design mode renders identically in Operate mode.*
 *
 * "Identically" is provable here because both modes feed the same bins to `deriveSlots`:
 * Design mode hands it the compiler's output, Operate mode hands it the published rows —
 * and `server/tests/test_persistence.py` already proves those rows match the compiler 1:1
 * (same codes, same centres, same capacities). So this file closes the chain by checking
 * that the projection is a faithful, lossless view of whatever bins it is given:
 *
 *   one slot per bin, same position, same size, same rotation, same identity.
 *
 * Together: compiled bins → published rows → operate slots. Each link is tested where it
 * happens, rather than by comparing two screenshots.
 */
import { describe, expect, it } from 'vitest';

import { buildLayout, type DerivedBin } from 'layout-core';

import { createInitialDoc } from '../design/initialDoc';
import type { BinPlacementsDto } from '../design/persistence/apiClient';
import { deriveSlots, daysSinceLastMove, statusOf, summarize, type OperateBin } from './slots';

function graphBins(): DerivedBin[] {
  return buildLayout(createInitialDoc()).bins;
}

function asOperateBins(bins: DerivedBin[], withIds = false): OperateBin[] {
  return bins.map((bin, index) =>
    withIds ? { ...bin, id: `bin-${index}` } : (bin as OperateBin),
  );
}

/** A placements index for one bin, as the server would report it. */
function indexFor(
  bin: OperateBin,
  rows: { skuId: string; sku: string; qty: number; volume: number; weight: number; ageDays?: number }[],
): Map<string, BinPlacementsDto> {
  const placements = rows.map((row, index) => ({
    id: `p${index}`,
    binId: bin.id ?? 'bin-0',
    binCode: bin.code,
    skuId: row.skuId,
    sku: row.sku,
    qty: row.qty,
    volumeUsedM3: row.volume,
    weightUsedKg: row.weight,
    updatedAt:
      row.ageDays === undefined
        ? null
        : new Date(Date.now() - row.ageDays * 86_400_000).toISOString(),
  }));

  const usedVolumeM3 = placements.reduce((total, item) => total + item.volumeUsedM3, 0);
  const usedWeightKg = placements.reduce((total, item) => total + item.weightUsedKg, 0);

  return new Map([
    [
      bin.code,
      {
        binId: bin.id ?? 'bin-0',
        binCode: bin.code,
        capacityM3: bin.capacityM3,
        maxWeightKg: bin.maxWeightKg,
        usedVolumeM3,
        usedWeightKg,
        remainingVolumeM3: Math.max(bin.capacityM3 - usedVolumeM3, 0),
        remainingWeightKg:
          bin.maxWeightKg === null ? null : Math.max(bin.maxWeightKg - usedWeightKg, 0),
        utilization: bin.capacityM3 > 0 ? usedVolumeM3 / bin.capacityM3 : 0,
        placements,
      },
    ],
  ]);
}

describe('the operate projection is a faithful view of the bins', () => {
  it('produces exactly one slot per bin', () => {
    const bins = graphBins();
    expect(deriveSlots(asOperateBins(bins), new Map())).toHaveLength(bins.length);
  });

  it('keeps every bin position, size and rotation', () => {
    const bins = graphBins();
    const slots = deriveSlots(asOperateBins(bins), new Map());

    bins.forEach((bin, index) => {
      const slot = slots[index]!;
      expect(slot.position).toEqual([bin.center.x, bin.center.y, bin.center.z]);
      expect(slot.size).toEqual([bin.widthM, bin.heightM, bin.depthM]);
      expect(slot.rotationDeg).toBe(bin.rotationDeg);
    });
  });

  it('keeps the identity a bin is looked up by', () => {
    const slots = deriveSlots(asOperateBins(graphBins()), new Map());
    const byCode = new Set(slots.map((slot) => slot.binCode));
    expect(byCode.size).toBe(slots.length);
    expect(slots[0]!.aisleCode).toMatch(/^A\d+$/);
    expect(slots[0]!.laneCode).toContain(slots[0]!.aisleCode);
  });

  it('carries the capacity the layout was compiled with', () => {
    const bins = graphBins();
    const slots = deriveSlots(asOperateBins(bins), new Map());
    expect(slots[0]!.capacityM3).toBe(bins[0]!.capacityM3);
    expect(slots[0]!.maxWeightKg).toBe(bins[0]!.maxWeightKg);
  });

  it('has an id only when the source supplied one, as published rows do', () => {
    const derived = deriveSlots(asOperateBins(graphBins()), new Map());
    expect(derived[0]!.binId).toBeNull();

    const published = deriveSlots(asOperateBins(graphBins(), true), new Map());
    expect(published[0]!.binId).toBe('bin-0');
  });
});

describe('status is derived, not invented', () => {
  it('calls an unplaced bin empty, with nothing else to say about it', () => {
    const slot = deriveSlots(asOperateBins(graphBins()), new Map())[0]!;
    expect(slot.status).toBe('empty');
    expect(slot.sku).toBeNull();
    expect(slot.qty).toBe(0);
    expect(slot.lastMovedDays).toBeNull();
    expect(slot.utilization).toBe(0);
  });

  it('calls a half-full bin low stock', () => {
    const bins = asOperateBins(graphBins(), true);
    const bin = bins[0]!;
    const index = indexFor(bin, [
      { skuId: 's1', sku: 'PALLET', qty: 4, volume: bin.capacityM3 * 0.3, weight: 100, ageDays: 1 },
    ]);

    const slot = deriveSlots([bin], index)[0]!;
    expect(slot.status).toBe('low_stock');
    expect(slot.sku).toBe('PALLET');
    expect(slot.utilization).toBeCloseTo(0.3, 6);
  });

  it('calls a well-filled bin current stock', () => {
    const bins = asOperateBins(graphBins(), true);
    const bin = bins[0]!;
    const index = indexFor(bin, [
      { skuId: 's1', sku: 'PALLET', qty: 9, volume: bin.capacityM3 * 0.8, weight: 100, ageDays: 2 },
    ]);

    expect(deriveSlots([bin], index)[0]!.status).toBe('current_stock');
  });

  it('calls a full bin nobody has touched slow moving', () => {
    const bins = asOperateBins(graphBins(), true);
    const bin = bins[0]!;
    const index = indexFor(bin, [
      { skuId: 's1', sku: 'PALLET', qty: 9, volume: bin.capacityM3 * 0.9, weight: 100, ageDays: 45 },
    ]);

    const slot = deriveSlots([bin], index)[0]!;
    expect(slot.status).toBe('slow_moving');
    expect(slot.lastMovedDays).toBeGreaterThanOrEqual(44);
  });

  it('describes a shared bin by its main occupant', () => {
    const bins = asOperateBins(graphBins(), true);
    const bin = bins[0]!;
    const index = indexFor(bin, [
      { skuId: 's1', sku: 'SMALL', qty: 1, volume: 0.2, weight: 10, ageDays: 1 },
      { skuId: 's2', sku: 'BULK', qty: 7, volume: 0.6, weight: 50, ageDays: 1 },
    ]);

    const slot = deriveSlots([bin], index)[0]!;
    expect(slot.sku).toBe('BULK');
    expect(slot.qty).toBe(7);
    expect(slot.skuCount).toBe(2);
    expect(slot.usedVolumeM3).toBeCloseTo(0.8, 6);
  });
});

describe('daysSinceLastMove', () => {
  it('is null for a bin with nothing in it', () => {
    expect(daysSinceLastMove(undefined, Date.now())).toBeNull();
  });

  it('is null when the placement carries no timestamp', () => {
    const bins = asOperateBins(graphBins(), true);
    const bin = bins[0]!;
    const index = indexFor(bin, [{ skuId: 's1', sku: 'X', qty: 1, volume: 1, weight: 1 }]);
    expect(daysSinceLastMove(index.get(bin.code), Date.now())).toBeNull();
  });

  it('uses the most recent timestamp when a bin holds several SKUs', () => {
    const bins = asOperateBins(graphBins(), true);
    const bin = bins[0]!;
    const index = indexFor(bin, [
      { skuId: 's1', sku: 'OLD', qty: 1, volume: 0.1, weight: 1, ageDays: 40 },
      { skuId: 's2', sku: 'NEW', qty: 1, volume: 0.1, weight: 1, ageDays: 3 },
    ]);

    const age = daysSinceLastMove(index.get(bin.code), Date.now());
    expect(age).not.toBeNull();
    expect(age!).toBeLessThan(6);
  });
});

describe('statusOf', () => {
  it('is empty whenever nothing is placed, whatever the other numbers say', () => {
    expect(statusOf(0, 0, null)).toBe('empty');
    expect(statusOf(0, 1, 500)).toBe('empty');
  });

  it('prefers slow moving over low stock: a half-empty bin nobody visits is the worse problem', () => {
    expect(statusOf(1, 0.2, 60)).toBe('slow_moving');
  });
});

describe('summarize', () => {
  it('counts the bins and adds up their volume', () => {
    const bins = asOperateBins(graphBins(), true);
    const index = indexFor(bins[0]!, [
      { skuId: 's1', sku: 'X', qty: 2, volume: 1.0, weight: 20, ageDays: 1 },
    ]);

    const summary = summarize(deriveSlots(bins, index));

    expect(summary.bins).toBe(bins.length);
    expect(summary.occupiedBins).toBe(1);
    expect(summary.emptyBins).toBe(bins.length - 1);
    expect(summary.usedVolumeM3).toBeCloseTo(1.0, 6);
    expect(summary.byStatus.low_stock).toBe(1);
    expect(summary.byStatus.empty).toBe(bins.length - 1);
    expect(summary.utilization).toBeGreaterThan(0);
    expect(summary.utilization).toBeLessThan(1);
  });

  it('reports an all-empty layout honestly', () => {
    const summary = summarize(deriveSlots(asOperateBins(graphBins()), new Map()));
    expect(summary.occupiedBins).toBe(0);
    expect(summary.utilization).toBe(0);
    expect(summary.lastMovedDays).toBeNull();
  });
});
