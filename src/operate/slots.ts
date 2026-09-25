/**
 * The Operate-mode projection: derived bins plus inventory, expressed as slots.
 *
 * This is the single place geometry and stock are joined, and it is deliberately pure so
 * the "design and operate render identically" claim can be *tested* rather than eyeballed:
 * feeding it the compiler's bins and feeding it the published rows produces the same
 * slots, because both sides hand it the same shape.
 *
 * Status is derived, never fabricated. The original viewer picked a status at random,
 * which meant the legend described nothing. Here:
 *
 *   empty          nothing is placed in the bin
 *   low_stock      something is, but less than half the usable volume
 *   slow_moving    it has not been touched in SLOW_MOVING_DAYS
 *   current_stock  everything else
 *
 * `slow_moving` wins over `low_stock` because a half-empty bin nobody has touched for a
 * month is a slotting problem, which is the more useful thing to see.
 */
import type { BinPlacementsDto } from '../design/persistence/apiClient';

/** Matching the previous viewer's vocabulary so the existing panels keep working. */
export type SlotStatus = 'empty' | 'current_stock' | 'low_stock' | 'slow_moving';

export const STATUS_COLORS: Record<SlotStatus, string> = {
  empty: '#475569',
  current_stock: '#10b981',
  low_stock: '#f59e0b',
  slow_moving: '#ef4444',
};

export const STATUS_ICONS: Record<SlotStatus, string> = {
  empty: '⬜',
  current_stock: '🟢',
  low_stock: '🟡',
  slow_moving: '🔴',
};

export const STATUS_LABELS: Record<SlotStatus, string> = {
  empty: 'Empty',
  current_stock: 'Current Stock',
  low_stock: 'Low Stock',
  slow_moving: 'Slow Moving',
};

export const SLOW_MOVING_DAYS = 30;

/**
 * The subset of a bin this projection needs.
 *
 * `DerivedBin` satisfies it as-is, and so do the published rows read from
 * `GET /layout` — which is what makes the two sources interchangeable.
 */
export type OperateBin = {
  /** Absent for a derived bin: the database assigns the id, and `code` is the key. */
  id?: string;
  code: string;
  aisleCode: string;
  laneCode: string;
  side: string;
  baySeq: number;
  levelIndex: number;
  center: { x: number; y: number; z: number };
  widthM: number;
  heightM: number;
  depthM: number;
  rotationDeg: number;
  capacityM3: number;
  maxWeightKg: number | null;
};

export type OperateSlot = {
  id: string;
  binId: string | null;
  binCode: string;
  aisleCode: string;
  laneCode: string;
  side: string;
  baySeq: number;
  levelIndex: number;
  position: [number, number, number];
  size: [number, number, number];
  rotationDeg: number;
  status: SlotStatus;
  sku: string | null;
  qty: number;
  capacityM3: number;
  usedVolumeM3: number;
  utilization: number;
  maxWeightKg: number | null;
  usedWeightKg: number;
  /** Days since the most recent placement change, or null when the bin is empty. */
  lastMovedDays: number | null;
  /** How many distinct SKUs are in the bin. */
  skuCount: number;
};

const DAY_MS = 86_400_000;

export function statusOf(
  placementCount: number,
  utilization: number,
  lastMovedDays: number | null,
): SlotStatus {
  if (placementCount === 0) return 'empty';
  if (lastMovedDays !== null && lastMovedDays >= SLOW_MOVING_DAYS) return 'slow_moving';
  return utilization < 0.5 ? 'low_stock' : 'current_stock';
}

/**
 * Days since the most recent change to anything in this bin.
 *
 * Taken from the placements' own `updatedAt`, so it is a real signal rather than a
 * random number. A missing timestamp yields null, which simply means "unknown" and is
 * treated as recently touched.
 */
export function daysSinceLastMove(entry: BinPlacementsDto | undefined, now: number): number | null {
  if (!entry || entry.placements.length === 0) return null;

  let newest = Number.NEGATIVE_INFINITY;
  for (const placement of entry.placements) {
    const raw = (placement as { updatedAt?: string | null }).updatedAt;
    if (!raw) continue;
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed) && parsed > newest) newest = parsed;
  }

  if (newest === Number.NEGATIVE_INFINITY) return null;
  return Math.max(0, Math.floor((now - newest) / DAY_MS));
}

export function deriveSlots(
  bins: readonly OperateBin[],
  byBinCode: Map<string, BinPlacementsDto>,
  now: number = Date.now(),
): OperateSlot[] {
  return bins.map((bin) => {
    const entry = byBinCode.get(bin.code);
    const placements = entry?.placements ?? [];
    const usedVolumeM3 = placements.reduce((total, item) => total + item.volumeUsedM3, 0);
    const usedWeightKg = placements.reduce((total, item) => total + item.weightUsedKg, 0);
    const utilization =
      bin.capacityM3 > 0 ? Math.min(usedVolumeM3 / bin.capacityM3, 1) : 0;
    const lastMovedDays = daysSinceLastMove(entry, now);

    // The largest placement is the one worth naming: a bin holding several SKUs is
    // described by its main occupant rather than by an arbitrary first row.
    const main = placements.reduce<(typeof placements)[number] | null>(
      (best, item) => (best === null || item.qty > best.qty ? item : best),
      null,
    );

    return {
      id: bin.code,
      binId: bin.id ?? null,
      binCode: bin.code,
      aisleCode: bin.aisleCode,
      laneCode: bin.laneCode,
      side: bin.side,
      baySeq: bin.baySeq,
      levelIndex: bin.levelIndex,
      position: [bin.center.x, bin.center.y, bin.center.z],
      size: [bin.widthM, bin.heightM, bin.depthM],
      rotationDeg: bin.rotationDeg,
      status: statusOf(placements.length, utilization, lastMovedDays),
      sku: main?.sku ?? null,
      qty: main?.qty ?? 0,
      capacityM3: bin.capacityM3,
      usedVolumeM3,
      utilization,
      maxWeightKg: bin.maxWeightKg,
      usedWeightKg,
      lastMovedDays,
      skuCount: placements.length,
    };
  });
}

export type OperateSummary = {
  bins: number;
  occupiedBins: number;
  emptyBins: number;
  utilization: number;
  usedVolumeM3: number;
  totalVolumeM3: number;
  lastMovedDays: number | null;
  byStatus: Record<SlotStatus, number>;
};

/** Warehouse-wide figures for the control panel, from the same slots the 3D view uses. */
export function summarize(slots: readonly OperateSlot[]): OperateSummary {
  const byStatus: Record<SlotStatus, number> = {
    empty: 0,
    current_stock: 0,
    low_stock: 0,
    slow_moving: 0,
  };

  let usedVolumeM3 = 0;
  let totalVolumeM3 = 0;
  let oldest: number | null = null;

  for (const slot of slots) {
    byStatus[slot.status] += 1;
    usedVolumeM3 += slot.usedVolumeM3;
    totalVolumeM3 += slot.capacityM3;
    if (slot.lastMovedDays !== null && (oldest === null || slot.lastMovedDays > oldest)) {
      oldest = slot.lastMovedDays;
    }
  }

  const occupiedBins = slots.length - byStatus.empty;

  return {
    bins: slots.length,
    occupiedBins,
    emptyBins: byStatus.empty,
    utilization: totalVolumeM3 > 0 ? usedVolumeM3 / totalVolumeM3 : 0,
    usedVolumeM3,
    totalVolumeM3,
    lastMovedDays: oldest,
    byStatus,
  };
}
