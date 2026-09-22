/**
 * Inventory: SKUs, placements and the fit verdict the drag ghost shows.
 *
 * The important function here is `checkPlacement`. It is the *client* half of Phase 8's
 * DoD: the server revalidates every drop with the same shared capacity module, so the
 * code shown to the user while dragging must be the code the server would return. Two
 * things make that true rather than hopeful:
 *
 *  - both sides call `itemFits`/`item_fits`, which is pinned by
 *    `fixtures/placement-conformance/cases.json` and run by both test suites;
 *  - the remaining capacity is computed here the same way the server computes it —
 *    a target with the bin's real opening but the *leftover* volume and weight.
 *
 * If this ever disagrees with the server, the server wins and the drop is refused; the
 * user sees the server's code. That is the correct failure direction.
 */
import type { CapacityTarget, FitFailureCode, FitItem, FitResult } from 'layout-core';
import { itemFits } from 'layout-core';

import type { BinPlacementsDto, PlacementDto, SkuDto } from './apiClient';

/** Placement state for one warehouse, indexed for the render loop. */
export type InventoryIndex = {
  skus: SkuDto[];
  byBinId: Map<string, BinPlacementsDto>;
  byBinCode: Map<string, BinPlacementsDto>;
  placements: PlacementDto[];
  /** Bins holding nothing, per the server's report. */
  emptyBinCount: number;
};

export const EMPTY_INVENTORY: InventoryIndex = {
  skus: [],
  byBinId: new Map(),
  byBinCode: new Map(),
  placements: [],
  emptyBinCount: 0,
};

export function skuById(inventory: InventoryIndex, skuId: string | null): SkuDto | null {
  if (skuId === null) return null;
  return inventory.skus.find((sku) => sku.id === skuId) ?? null;
}

/** The capacity a drop would actually have: the bin's opening, minus what is already in it. */
export function remainingTarget(bin: {
  widthM: number;
  heightM: number;
  depthM: number;
  capacityM3: number;
  maxWeightKg: number | null;
}): CapacityTarget {
  return {
    widthM: bin.widthM,
    heightM: bin.heightM,
    depthM: bin.depthM,
    capacityM3: bin.capacityM3,
    maxWeightKg: bin.maxWeightKg,
  };
}

export type PlacementCheck = {
  fits: boolean;
  code: FitFailureCode | null;
  message: string;
  orientation?: [number, number, number];
};

export function skuToItem(sku: SkuDto): FitItem {
  return {
    widthM: sku.widthM,
    heightM: sku.heightM,
    depthM: sku.depthM,
    weightKg: sku.weightKg,
    rotatable: sku.rotatable,
  };
}

/**
 * Would this quantity of this SKU fit in this bin, given what is already there?
 *
 * `already` must exclude the SKU being placed: a drop replaces that SKU's existing row
 * rather than adding to it, so counting it would refuse a placement that frees its own
 * space.
 */
export function checkPlacement(
  bin: {
    widthM: number;
    heightM: number;
    depthM: number;
    capacityM3: number;
    maxWeightKg: number | null;
  },
  used: { volumeM3: number; weightKg: number },
  sku: SkuDto,
  qty: number,
): PlacementCheck {
  const target: CapacityTarget = {
    ...remainingTarget(bin),
    capacityM3: Math.max(bin.capacityM3 - used.volumeM3, 0),
    maxWeightKg:
      bin.maxWeightKg === null ? null : Math.max(bin.maxWeightKg - used.weightKg, 0),
  };

  const result: FitResult = itemFits(target, skuToItem(sku), qty);
  if (result.fits) {
    return { fits: true, code: null, message: '', orientation: result.orientation };
  }

  return {
    fits: false,
    code: result.failure?.code ?? null,
    message: result.failure?.message ?? 'Does not fit',
    orientation: result.orientation,
  };
}

/**
 * Usage already in a bin, optionally ignoring one SKU.
 *
 * Takes the server's report for the bin rather than an id lookup, because a *derived*
 * bin has no id at all — `DerivedBin` deliberately omits it (the database assigns a
 * surrogate and keys everything on `code`). The code is the only handle the client has
 * on both sides, so it is the join key throughout the editor.
 */
export function usedInBin(
  entry: BinPlacementsDto | undefined,
  options: { excludeSkuId?: string | null } = {},
): { volumeM3: number; weightKg: number } {
  if (!entry) return { volumeM3: 0, weightKg: 0 };

  let volumeM3 = 0;
  let weightKg = 0;
  for (const placement of entry.placements) {
    if (options.excludeSkuId && placement.skuId === options.excludeSkuId) continue;
    volumeM3 += placement.volumeUsedM3;
    weightKg += placement.weightUsedKg;
  }
  return { volumeM3, weightKg };
}

/** Utilisation of a bin, 0–1, for the heatmap. */
export function utilizationOf(entry: BinPlacementsDto | undefined): number {
  return entry?.utilization ?? 0;
}

/** A verdict for a bin that exists in the layout but not in the published structure. */
export const NOT_PUBLISHED: PlacementCheck = {
  fits: false,
  code: null,
  message: 'This bin is not in the published layout yet, so nothing can be placed in it',
};

/** Colour ramp for the heatmap: empty is neutral, full is hot. */
export function utilizationColor(utilization: number): string {
  if (utilization <= 0) return '#3f4c60';
  if (utilization < 0.25) return '#1d4ed8';
  if (utilization < 0.5) return '#0891b2';
  if (utilization < 0.75) return '#22c55e';
  if (utilization < 0.95) return '#eab308';
  return '#ef4444';
}
