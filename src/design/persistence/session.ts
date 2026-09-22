/**
 * The editor's connection to the API: draft autosave and publish.
 *
 * Deliberately **outside** the design store. The design store is the document and its
 * undo history — it lives in `layout-core`, is framework-free, and is mirrored in
 * Python. Server session state is neither of those things, and mixing the two would
 * mean a failed autosave could ever affect what the user is editing. Here, a failure
 * to save cannot touch the document at all: it only sets a flag the UI reads.
 *
 * State is published through a module singleton because the R3F canvas and the panels
 * live in different React roots, so a context provider could not reach both.
 */
import { useSyncExternalStore } from 'react';
import type { DesignStore } from 'layout-core';
import { designState, designStore } from '../store/designStore';
import { api, type ApiFailure } from './apiClient';
import { loadInventory, resetInventory } from './inventoryStore';

/** Long enough that typing a number does not produce a request per keystroke. */
export const AUTOSAVE_DELAY_MS = 1200;

export type SaveState = 'IDLE' | 'SAVING' | 'SAVED' | 'ERROR' | 'CONFLICT';

export type SessionState = {
  connected: boolean;
  warehouseId: string | null;
  warehouseCode: string | null;
  /** The token to echo as `If-Match`. Null until the server has told us one. */
  draftRevision: number | null;
  draftVersion: number | null;
  publishedVersion: number | null;
  saveState: SaveState;
  lastSavedAt: number | null;
  /** The refusal to show, if the last call failed. */
  failure: ApiFailure | null;
  /** True while a publish request is in flight. */
  publishing: boolean;
};

const INITIAL: SessionState = {
  connected: false,
  warehouseId: null,
  warehouseCode: null,
  draftRevision: null,
  draftVersion: null,
  publishedVersion: null,
  saveState: 'IDLE',
  lastSavedAt: null,
  failure: null,
  publishing: false,
};

let state: SessionState = INITIAL;
const listeners = new Set<() => void>();

function set(patch: Partial<SessionState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

export function getSession(): SessionState {
  return state;
}

export function subscribeSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useSession(): SessionState {
  return useSyncExternalStore(subscribeSession, getSession, getSession);
}

/**
 * Open a warehouse and start saving to it.
 *
 * The local document is pushed as the first draft immediately, so connecting never
 * silently discards what the designer has already built. The server is asked to
 * create the warehouse first; if the code is taken it is opened instead, which makes
 * "connect" idempotent from the user's point of view.
 */
export async function connect(code: string, name = ''): Promise<void> {
  // The *normalized* document: schema defaults materialised, exactly what the hash
  // was computed over. Sending the raw editor document would let the server hash a
  // differently-shaped document and report drift that is not real.
  const doc = designState().graph.doc;

  set({ saveState: 'SAVING', failure: null });

  const created = await api.createWarehouse({
    code,
    name: name || code,
    lengthM: doc.warehouse.lengthM,
    widthM: doc.warehouse.widthM,
    heightM: doc.warehouse.heightM,
    doc,
  });

  if (!created.ok && created.code !== 'WAREHOUSE_CODE_TAKEN') {
    set({ saveState: 'ERROR', failure: created });
    return;
  }

  let warehouse = created.ok ? created.data : null;

  if (warehouse === null) {
    // The code is taken, so open what is already there rather than failing: from the
    // user's point of view "save to WH1" should work whether or not WH1 exists.
    const listed = await api.listWarehouses();
    if (!listed.ok) {
      set({ saveState: 'ERROR', failure: listed });
      return;
    }
    warehouse = listed.data.find((candidate) => candidate.code === code) ?? null;

    if (warehouse === null) {
      set({
        saveState: 'ERROR',
        failure: {
          ok: false,
          status: 0,
          code: 'WAREHOUSE_NOT_FOUND',
          message: `'${code}' already exists but could not be found in the warehouse list`,
        },
      });
      return;
    }
  }

  const revision = warehouse.draftRevision;

  // The server may already hold a draft (reconnecting). Pushing the local document is
  // the safer default: the designer is looking at it, and the previous revision is
  // still in the version history unless it was published.
  const saved = await api.putDraft(
    warehouse.id,
    { doc, clientDocHash: designState().graph.hash },
    revision,
  );
  if (!saved.ok) {
    // 428 means the server wants a token; the revision it reported at creation is
    // the one we just used, so anything else here is a real refusal.
    set({
      connected: true,
      warehouseId: warehouse.id,
      warehouseCode: warehouse.code,
      draftRevision: revision,
      publishedVersion: warehouse.published?.version ?? null,
      saveState: 'ERROR',
      failure: saved,
    });
    return;
  }

  set({
    connected: true,
    warehouseId: warehouse.id,
    warehouseCode: warehouse.code,
    draftRevision: saved.data.draftRevision,
    draftVersion: saved.data.version,
    publishedVersion: warehouse.published?.version ?? null,
    saveState: 'SAVED',
    lastSavedAt: Date.now(),
    failure: null,
  });

  // Inventory hangs off the warehouse, so it is loaded with the connection. Until the
  // layout is published there are no bins and this quietly finds no placements.
  await loadInventory(warehouse.id);
}

export function disconnect(): void {
  resetInventory();
  set({ ...INITIAL });
}

/** Push the current document as the draft, if a warehouse is open. */
export async function saveDraft(): Promise<void> {
  const { connected, warehouseId, draftRevision } = state;
  if (!connected || !warehouseId || draftRevision === null) return;

  const graph = designState().graph;
  set({ saveState: 'SAVING' });

  const result = await api.putDraft(
    warehouseId,
    { doc: graph.doc, clientDocHash: graph.hash },
    draftRevision,
  );

  if (result.ok) {
    set({
      saveState: 'SAVED',
      lastSavedAt: Date.now(),
      draftRevision: result.data.draftRevision,
      draftVersion: result.data.version,
      failure: null,
    });
    return;
  }

  // A stale token is not an error to retry: another editor has moved the draft on, and
  // re-sending would overwrite their work. The user has to decide.
  const conflict = result.code === 'STALE_DRAFT';
  set({
    saveState: conflict ? 'CONFLICT' : 'ERROR',
    failure: result,
    draftRevision: conflict ? (result.actualRevision ?? draftRevision) : draftRevision,
  });
}

export type PublishOutcome =
  | { ok: true; version: number; changed: boolean; binCount: number; orphaned: unknown[] }
  | ApiFailure;

export async function publishLayout(createdBy?: string): Promise<PublishOutcome> {
  const { connected, warehouseId } = state;
  if (!connected || !warehouseId) {
    return {
      ok: false,
      status: 0,
      code: 'NOT_CONNECTED',
      message: 'No warehouse is open, so there is nowhere to publish to',
    };
  }

  const graph = designState().graph;
  set({ publishing: true, failure: null });

  const result = await api.publish(warehouseId, {
    doc: graph.doc,
    clientDocHash: graph.hash,
    createdBy,
  });

  if (!result.ok) {
    set({ publishing: false, failure: result });
    return result;
  }

  set({
    publishing: false,
    publishedVersion: result.data.version,
    // Publishing supersedes the draft, so the old token is dead.
    draftRevision: null,
    draftVersion: null,
    saveState: 'IDLE',
  });

  // The published layout is what placements are checked against, so bins and their
  // capacities have to be re-read after every publish.
  await loadInventory(warehouseId);

  return {
    ok: true,
    version: result.data.version,
    changed: result.data.changed,
    binCount: result.data.binCount,
    orphaned: result.data.orphanedPlacements,
  };
}

/**
 * Watch the document and save it after a pause.
 *
 * Keyed on the document hash, so undo, redo and a drag all save the same way while a
 * no-op re-render does not. Returns a cleanup function; the caller mounts it once.
 */
export function startAutosave(): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastHash = designState().graph.hash;

  const unsubscribe = designStore.subscribe((current: DesignStore) => {
    if (current.graph.hash === lastHash) return;
    lastHash = current.graph.hash;

    if (!getSession().connected) return;
    // A conflict means the server will refuse this again; retrying would just spam it.
    if (getSession().saveState === 'CONFLICT') return;

    clearTimeout(timer);
    timer = setTimeout(() => {
      void saveDraft();
    }, AUTOSAVE_DELAY_MS);
  });

  return () => {
    clearTimeout(timer);
    unsubscribe();
  };
}
