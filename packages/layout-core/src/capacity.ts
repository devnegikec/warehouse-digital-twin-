/**
 * Capacity and fit checking.
 *
 * Capacity is deliberately its own module and its own columns (P5): it answers
 * "how much fits", which is a different question from "where is it".
 *
 * Failures are returned as *codes*, not prose, so placement validation can raise
 * them as ordinary diagnostics with no string parsing.
 */
import type { Diagnostic, EntityRef } from './diagnostics.js';
import { ruleSeverity } from './rules.js';
import { DEFAULT_UTILIZATION, EPS, round } from './units.js';

export type Box = { widthM: number; heightM: number; depthM: number };

export type CapacityTarget = Box & {
  /** Usable volume already computed with the utilization factor applied. */
  capacityM3: number;
  maxWeightKg: number | null;
};

export type FitItem = Box & {
  weightKg: number;
  /** When false, only the item's authored orientation is legal. */
  rotatable: boolean;
};

/** These codes live in the rule registry, so layout rules and placement rules share one list. */
export type FitFailureCode =
  | 'QTY_NOT_POSITIVE'
  | 'ITEM_DOES_NOT_FIT_OPENING'
  | 'EXCEEDS_BIN_VOLUME'
  | 'EXCEEDS_BIN_WEIGHT';

export type FitResult = {
  fits: boolean;
  failure?: { code: FitFailureCode; message: string };
  /** The orientation used, in bin-local (width, height, depth) terms. */
  orientation?: [number, number, number];
};

/** Raw bin volume with the utilization factor applied. */
export function usableVolumeM3(w: number, h: number, d: number, utilization = DEFAULT_UTILIZATION): number {
  return round(w * h * d * utilization);
}

/**
 * The distinct axis-aligned orientations to try, in a deterministic order so that
 * TypeScript and Python always select the same one.
 * `rotatable: false` pins the item to its authored orientation.
 */
export function orientationsOf(item: Box, rotatable: boolean): Array<[number, number, number]> {
  const { widthM: w, heightM: h, depthM: d } = item;
  const all: Array<[number, number, number]> = [
    [w, h, d],
    [w, d, h],
    [h, w, d],
    [h, d, w],
    [d, w, h],
    [d, h, w],
  ];
  if (!rotatable) return [[w, h, d]];
  const seen = new Set<string>();
  const unique: Array<[number, number, number]> = [];
  for (const o of all) {
    const key = o.join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(o);
  }
  return unique;
}

/**
 * Full fit check: geometry first (an item must physically fit the opening),
 * then aggregate volume, then weight.
 */
export function itemFits(bin: CapacityTarget, item: FitItem, qty: number): FitResult {
  if (qty <= 0) {
    return {
      fits: false,
      failure: { code: 'QTY_NOT_POSITIVE', message: 'Quantity must be greater than zero' },
    };
  }

  const fitsOpening = (o: [number, number, number]): boolean =>
    o[0] <= bin.widthM + EPS && o[1] <= bin.heightM + EPS && o[2] <= bin.depthM + EPS;

  const candidate = orientationsOf(item, item.rotatable).find(fitsOpening);
  if (!candidate) {
    return {
      fits: false,
      failure: {
        code: 'ITEM_DOES_NOT_FIT_OPENING',
        message:
          `Item ${item.widthM} x ${item.heightM} x ${item.depthM} m does not fit the ` +
          `${bin.widthM} x ${bin.heightM} x ${bin.depthM} m opening in any legal orientation`,
      },
    };
  }

  const totalVolume = round(item.widthM * item.heightM * item.depthM * qty);
  if (totalVolume > bin.capacityM3 + EPS) {
    return {
      fits: false,
      failure: {
        code: 'EXCEEDS_BIN_VOLUME',
        message: `Needs ${totalVolume} m3 but the bin holds ${bin.capacityM3} m3`,
      },
      orientation: candidate,
    };
  }

  if (bin.maxWeightKg !== null) {
    const totalWeight = round(item.weightKg * qty);
    if (totalWeight > bin.maxWeightKg + EPS) {
      return {
        fits: false,
        failure: {
          code: 'EXCEEDS_BIN_WEIGHT',
          message: `Needs ${totalWeight} kg but the level limit is ${bin.maxWeightKg} kg`,
        },
        orientation: candidate,
      };
    }
  }

  return { fits: true, orientation: candidate };
}

/**
 * Placement validation: the fit check expressed as ordinary diagnostics, so a
 * rejected drag-and-drop returns the same shape as a bad layout, and the Python
 * side raises identical codes.
 */
export function validatePlacement(
  bin: CapacityTarget,
  item: FitItem,
  qty: number,
  ctx: { binCode: string; sku: string },
): Diagnostic[] {
  const result = itemFits(bin, item, qty);
  if (result.fits || !result.failure) return [];

  const entityRefs: EntityRef[] = [
    { kind: 'bin', id: ctx.binCode, label: ctx.binCode },
    { kind: 'sku', id: ctx.sku, label: ctx.sku },
  ];

  return [
    {
      severity: ruleSeverity(result.failure.code),
      code: result.failure.code,
      message: result.failure.message,
      entityRefs,
      data: { qty, binCode: ctx.binCode, sku: ctx.sku },
    },
  ];
}

/** Fraction of usable volume consumed — for the utilisation heatmap. */
export function utilization(bin: CapacityTarget, itemVolumeM3: number, qty: number): number {
  if (bin.capacityM3 <= 0) return 0;
  return round((itemVolumeM3 * qty) / bin.capacityM3, 4);
}
