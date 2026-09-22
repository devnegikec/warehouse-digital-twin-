/**
 * Inventory state: the SKU list, what is in every bin, and the drag in flight.
 *
 * Outside the design store for the same reason the session is: inventory is server
 * state about *stuff*, not the document's geometry. A failed placement must not touch
 * the layout, and undoing a placement is not an undo of a layout edit.
 *
 * A module singleton with `useSyncExternalStore`, because the palette is in the panel
 * tree and the drop target is resolved inside the R3F canvas — a different React root.
 */
import { useSyncExternalStore } from 'react';

import type { BinPlacementsDto, SkuDto, SkuInput } from './apiClient';
import { api } from './apiClient';
import {
  EMPTY_INVENTORY,
  checkPlacement,
  type InventoryIndex,
  type PlacementCheck,
} from './inventory';

export type DropTarget = {
  binId: string;
  binCode: string;
  verdict: PlacementCheck;
};

export type InventoryState = {
  warehouseId: string | null;
  index: InventoryIndex;
  loading: boolean;
  /** True once a load has been attempted, so an empty list is not mistaken for "no server". */
  loaded: boolean;
  error: string | null;
  /** The SKU being dragged from the palette, with the quantity to place. */
  drag: { skuId: string; qty: number } | null;
  drop: DropTarget | null;
  /** Colour bins by utilisation instead of by capacity. */
  heatmap: boolean;
  busy: boolean;
  notice: string | null;
};

const INITIAL: InventoryState = {
  warehouseId: null,
  index: EMPTY_INVENTORY,
  loading: false,
  loaded: false,
  error: null,
  drag: null,
  drop: null,
  heatmap: true,
  busy: false,
  notice: null,
};

let state: InventoryState = INITIAL;
const listeners = new Set<() => void>();

function set(patch: Partial<InventoryState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

export function getInventory(): InventoryState {
  return state;
}

export function subscribeInventory(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useInventory(): InventoryState {
  return useSyncExternalStore(subscribeInventory, getInventory, getInventory);
}

/** Forget everything — called when the session disconnects. */
export function resetInventory(): void {
  set({ ...INITIAL });
}

/** Rebuild the by-bin index from a flat placement list plus the bins' capacities. */
function indexInventory(
  skus: SkuDto[],
  placements: { id: string; binId: string; binCode: string; skuId: string; sku: string; qty: number; volumeUsedM3: number; weightUsedKg: number }[],
  bins: { id: string; code: string; capacityM3: number; maxWeightKg: number | null; widthM: number; heightM: number; depthM: number }[],
): InventoryIndex {
  const byBinId = new Map<string, BinPlacementsDto>();
  const byBinCode = new Map<string, BinPlacementsDto>();

  for (const bin of bins) {
    const inBin = placements.filter((placement) => placement.binId === bin.id);
    const usedVolume = inBin.reduce((total, placement) => total + placement.volumeUsedM3, 0);
    const usedWeight = inBin.reduce((total, placement) => total + placement.weightUsedKg, 0);

    const entry = {
      binId: bin.id,
      binCode: bin.code,
      capacityM3: bin.capacityM3,
      maxWeightKg: bin.maxWeightKg,
      usedVolumeM3: usedVolume,
      usedWeightKg: usedWeight,
      remainingVolumeM3: Math.max(bin.capacityM3 - usedVolume, 0),
      remainingWeightKg:
        bin.maxWeightKg === null ? null : Math.max(bin.maxWeightKg - usedWeight, 0),
      utilization: bin.capacityM3 <= 0 ? 0 : Math.min(usedVolume / bin.capacityM3, 1),
      placements: inBin as BinPlacementsDto['placements'],
    } satisfies BinPlacementsDto;

    byBinId.set(bin.id, entry);
    byBinCode.set(bin.code, entry);
  }

  return {
    skus,
    byBinId,
    byBinCode,
    placements: placements as InventoryIndex['placements'],
    emptyBinCount: [...byBinId.values()].filter((entry) => entry.placements.length === 0).length,
  };
}

/**
 * Load SKUs, placements and the published bins, then index them.
 *
 * Bins come from the published layout because a placement only exists against a
 * published bin — the same rows the server validates against.
 */
export async function loadInventory(warehouseId: string): Promise<void> {
  set({ warehouseId, loading: true, error: null });

  const [skus, placements, layout] = await Promise.all([
    api.listSkus(warehouseId),
    api.listPlacements(warehouseId),
    api.getPublishedLayout(warehouseId),
  ]);

  if (!skus.ok) {
    set({ loading: false, loaded: true, error: `${skus.code}: ${skus.message}` });
    return;
  }
  if (!placements.ok) {
    set({ loading: false, loaded: true, error: `${placements.code}: ${placements.message}` });
    return;
  }
  if (!layout.ok) {
    // Not published yet: there are no bins, so there is nothing to place into.
    set({
      loading: false,
      loaded: true,
      index: { ...EMPTY_INVENTORY, skus: skus.data },
      notice: null,
    });
    return;
  }

  set({
    loading: false,
    loaded: true,
    error: null,
    index: indexInventory(
      skus.data,
      placements.data,
      // `bins` is a free-form dict on the wire (`list[dict[str, Any]]` on the Python
      // side), so the fields are converted explicitly rather than asserted into place.
      layout.data.bins.map((bin) => ({
        id: String(bin.id),
        code: String(bin.code),
        capacityM3: Number(bin.capacityM3),
        maxWeightKg: bin.maxWeightKg === null ? null : Number(bin.maxWeightKg),
        widthM: Number(bin.widthM),
        heightM: Number(bin.heightM),
        depthM: Number(bin.depthM),
      })),
    ),
  });
}

// --- SKU CRUD ----------------------------------------------------------------

export async function createSku(payload: SkuInput): Promise<boolean> {
  const warehouseId = state.warehouseId;
  if (!warehouseId) return false;

  set({ busy: true, notice: null });
  const result = await api.createSku(warehouseId, payload);
  if (!result.ok) {
    set({ busy: false, notice: `${result.code}: ${result.message}` });
    return false;
  }

  set({ busy: false, notice: null });
  await loadInventory(warehouseId);
  return true;
}

export async function updateSku(skuId: string, payload: SkuInput): Promise<boolean> {
  const warehouseId = state.warehouseId;
  set({ busy: true, notice: null });

  const result = await api.updateSku(skuId, payload);
  if (!result.ok) {
    set({ busy: false, notice: `${result.code}: ${result.message}` });
    return false;
  }

  set({ busy: false, notice: null });
  if (warehouseId) await loadInventory(warehouseId);
  return true;
}

export async function deleteSku(skuId: string): Promise<boolean> {
  const warehouseId = state.warehouseId;
  set({ busy: true, notice: null });

  const result = await api.deleteSku(skuId);
  if (!result.ok) {
    set({ busy: false, notice: `${result.code}: ${result.message}` });
    return false;
  }

  set({ busy: false, notice: null });
  if (warehouseId) await loadInventory(warehouseId);
  return true;
}

// --- Dragging ----------------------------------------------------------------

export function startDrag(skuId: string, qty = 1): void {
  set({ drag: { skuId, qty }, drop: null, notice: null });
}

export function setDragQuantity(qty: number): void {
  const drag = state.drag;
  if (!drag) return;
  set({ drag: { ...drag, qty }, drop: null });
}

/** Called by the canvas each frame while a drag is in flight. */
export function setDropTarget(drop: DropTarget | null): void {
  const current = state.drop;
  // Avoid a state write per frame when nothing changed; this runs inside useFrame.
  if (
    (current === null && drop === null) ||
    (current !== null &&
      drop !== null &&
      current.binId === drop.binId &&
      current.verdict.fits === drop.verdict.fits &&
      current.verdict.code === drop.verdict.code)
  ) {
    return;
  }
  set({ drop });
}

export function cancelDrag(): void {
  set({ drag: null, drop: null });
}

/**
 * Commit the placement under the cursor.
 *
 * The client's verdict only decides whether to *ask*; the server revalidates and its
 * answer is the one that counts. A refusal replaces the notice with the server's code,
 * which should be the same one the user just saw.
 */
export async function commitDrop(): Promise<void> {
  const { drag, drop, warehouseId } = state;
  if (!drag || !warehouseId) {
    set({ drag: null, drop: null });
    return;
  }

  if (!drop) {
    set({ drag: null, drop: null, notice: 'Nothing to drop onto.' });
    return;
  }

  if (!drop.verdict.fits) {
    set({
      drag: null,
      drop: null,
      notice: drop.verdict.code
        ? `${drop.verdict.code}: ${drop.verdict.message}`
        : drop.verdict.message,
    });
    return;
  }

  set({ busy: true, notice: null });
  const result = await api.createPlacement(drop.binId, { skuId: drag.skuId, qty: drag.qty });

  if (!result.ok) {
    set({
      busy: false,
      drag: null,
      drop: null,
      notice: `${result.code}: ${result.message}`,
    });
    await loadInventory(warehouseId);
    return;
  }

  set({ busy: false, drag: null, drop: null, notice: null });
  await loadInventory(warehouseId);
}

// --- Unassigning and bulk ----------------------------------------------------

export async function removePlacement(placementId: string): Promise<void> {
  const warehouseId = state.warehouseId;
  set({ busy: true, notice: null });

  const result = await api.deletePlacement(placementId);
  set({ busy: false, notice: result.ok ? null : `${result.code}: ${result.message}` });
  if (warehouseId) await loadInventory(warehouseId);
}

export type BulkOutcome = { placed: number; rejected: number; summary: string };

/**
 * Fill a set of bins with one SKU.
 *
 * Per-bin by design: a selection is expected to contain bins that are too short or
 * already full, so the outcome reports how many took it and why the rest did not.
 */
export async function bulkFill(
  skuId: string,
  qty: number,
  binIds: string[],
): Promise<BulkOutcome | null> {
  const warehouseId = state.warehouseId;
  if (!warehouseId || binIds.length === 0) return null;

  set({ busy: true, notice: null });
  const result = await api.bulkPlace(warehouseId, { skuId, qty, binIds });

  if (!result.ok) {
    set({ busy: false, notice: `${result.code}: ${result.message}` });
    return null;
  }

  const codes = new Map<string, number>();
  for (const item of result.data.results) {
    if (item.ok || !item.code) continue;
    codes.set(item.code, (codes.get(item.code) ?? 0) + 1);
  }
  const reasons = [...codes.entries()]
    .map(([code, count]) => `${count} × ${code}`)
    .join(', ');

  set({ busy: false, notice: null });
  await loadInventory(warehouseId);

  return {
    placed: result.data.placed,
    rejected: result.data.rejected,
    summary:
      result.data.rejected === 0
        ? `${result.data.placed} bins filled.`
        : `${result.data.placed} filled, ${result.data.rejected} refused (${reasons}).`,
  };
}

export function setHeatmap(on: boolean): void {
  set({ heatmap: on });
}

export function clearNotice(): void {
  set({ notice: null });
}
