/**
 * Where Operate mode gets its layout.
 *
 * Two sources, one shape:
 *
 *  - **published** — `GET /api/warehouses/{id}/layout` plus the placements, when a
 *    warehouse is open. This is what an operator sees: frozen rows, not the designer's
 *    working copy.
 *  - **local** — the compiler's output for whatever is currently being edited, so the
 *    viewer stays usable with no server. That is also what makes the two modes
 *    comparable side by side.
 *
 * Both hand the same `OperateBin` shape to `deriveSlots`, so the projection — and
 * therefore the rendering — cannot differ between them. The one difference is
 * inventory, which local mode has none of by definition: a placement only exists
 * against a published bin.
 *
 * A module singleton read with `useSyncExternalStore`, because the R3F canvas is a
 * separate React root from the panels.
 */
import { useSyncExternalStore } from 'react';

import type { BinPlacementsDto } from '../design/persistence/apiClient';
import { api, type ApiFailure } from '../design/persistence/apiClient';
import { getSession } from '../design/persistence/session';
import { designStore } from '../design/store/designStore';
import {
  deriveSlots,
  summarize,
  type OperateBin,
  type OperateSlot,
  type OperateSummary,
} from './slots';

export type LayoutSourceMode = 'local' | 'published';

export type LayoutSourceState = {
  mode: LayoutSourceMode;
  loading: boolean;
  warehouseCode: string;
  version: number | null;
  docHash: string | null;
  publishedAt: string | null;
  slots: OperateSlot[];
  summary: OperateSummary;
  /** Reasons the served snapshot and today's compiler disagree. */
  conflicts: string[];
  error: ApiFailure | null;
  /** Bumped on every reload, so the 3D scene can refit the camera deliberately. */
  revision: number;
};

type BaseState = Omit<LayoutSourceState, 'loading' | 'error' | 'revision'>;

/**
 * The layout as the editor currently has it.
 *
 * No inventory: a placement is only meaningful against published rows, and pretending
 * otherwise would show stock that exists nowhere.
 */
function fromLocal(): BaseState {
  const { doc, bins, hash } = designStore.getState().graph;
  const slots = deriveSlots(bins as OperateBin[], new Map());

  return {
    mode: 'local',
    warehouseCode: doc.warehouse.code,
    version: null,
    docHash: hash,
    publishedAt: null,
    slots,
    summary: summarize(slots),
    conflicts: [],
  };
}

let state: LayoutSourceState = {
  ...fromLocal(),
  loading: false,
  error: null,
  revision: 0,
};

const listeners = new Set<() => void>();

function set(patch: Partial<LayoutSourceState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

export function getLayoutSource(): LayoutSourceState {
  return state;
}

export function subscribeLayoutSource(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useLayoutSource(): LayoutSourceState {
  return useSyncExternalStore(subscribeLayoutSource, getLayoutSource, getLayoutSource);
}

/** Load the layout Operate mode should show, from the best source available. */
export async function loadLayoutSource(): Promise<void> {
  const session = getSession();

  if (!session.connected || !session.warehouseId) {
    set({ ...fromLocal(), loading: false, error: null, revision: state.revision + 1 });
    return;
  }

  set({ loading: true, error: null });

  const [layout, placements] = await Promise.all([
    api.getPublishedLayout(session.warehouseId),
    api.listPlacements(session.warehouseId),
  ]);

  if (!layout.ok) {
    if (layout.code === 'NO_PUBLISHED_LAYOUT') {
      // Nothing published yet. Showing the working copy beats showing an empty
      // warehouse, and the source label says which one is on screen.
      set({ ...fromLocal(), loading: false, error: null, revision: state.revision + 1 });
      return;
    }
    set({ loading: false, error: layout, revision: state.revision + 1 });
    return;
  }

  const placementsByBinId = new Map<string, BinPlacementsDto['placements']>();
  if (placements.ok) {
    for (const placement of placements.data) {
      const list = placementsByBinId.get(placement.binId);
      if (list) list.push(placement);
      else placementsByBinId.set(placement.binId, [placement]);
    }
  }

  // `bins` is a free-form dict on the wire (`list[dict[str, Any]]` on the Python side),
  // so every field is converted rather than asserted into place.
  const bins: OperateBin[] = layout.data.bins.map((bin) => {
    const center = (bin.center ?? {}) as { x?: unknown; y?: unknown; z?: unknown };
    return {
      id: String(bin.id),
      code: String(bin.code),
      // Aisle and lane identity comes from the server's join, never parsed out of the
      // bin code: the code pattern is per-lane and configurable.
      aisleCode: String(bin.aisleCode ?? ''),
      laneCode: String(bin.laneCode ?? ''),
      side: String(bin.side ?? ''),
      baySeq: Number(bin.baySeq ?? 0),
      levelIndex: Number(bin.levelIndex ?? 0),
      center: { x: Number(center.x ?? 0), y: Number(center.y ?? 0), z: Number(center.z ?? 0) },
      widthM: Number(bin.widthM),
      heightM: Number(bin.heightM),
      depthM: Number(bin.depthM),
      rotationDeg: Number(bin.rotationDeg),
      capacityM3: Number(bin.capacityM3),
      maxWeightKg: bin.maxWeightKg === null ? null : Number(bin.maxWeightKg),
    };
  });

  const byBinCode = new Map<string, BinPlacementsDto>(
    bins.map((bin) => {
      const rows = placementsByBinId.get(String(bin.id)) ?? [];
      const usedVolumeM3 = rows.reduce((total, row) => total + row.volumeUsedM3, 0);
      const usedWeightKg = rows.reduce((total, row) => total + row.weightUsedKg, 0);

      return [
        bin.code,
        {
          binId: String(bin.id),
          binCode: bin.code,
          capacityM3: bin.capacityM3,
          maxWeightKg: bin.maxWeightKg,
          usedVolumeM3,
          usedWeightKg,
          remainingVolumeM3: Math.max(bin.capacityM3 - usedVolumeM3, 0),
          remainingWeightKg:
            bin.maxWeightKg === null ? null : Math.max(bin.maxWeightKg - usedWeightKg, 0),
          utilization: bin.capacityM3 > 0 ? Math.min(usedVolumeM3 / bin.capacityM3, 1) : 0,
          placements: rows,
        },
      ];
    }),
  );

  const slots = deriveSlots(bins, byBinCode);

  set({
    mode: 'published',
    loading: false,
    warehouseCode: layout.data.code,
    version: layout.data.version,
    docHash: layout.data.docHash,
    publishedAt: layout.data.publishedAt ?? null,
    slots,
    summary: summarize(slots),
    conflicts: layout.data.conflicts ?? [],
    error: null,
    revision: state.revision + 1,
  });
}

/** Follow the editor while nothing is published, so the viewer is never stale. */
export function refreshLocalSource(): void {
  if (state.mode !== 'local') return;
  set({ ...fromLocal(), revision: state.revision + 1 });
}
