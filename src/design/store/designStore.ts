/**
 * React binding for the editor store.
 *
 * The store itself lives in `layout-core` (on `zustand/vanilla`) so the editor
 * state machine is covered by the package's test suite. This file is the only
 * place that touches React, and it exists so components can subscribe to narrow
 * slices without knowing where the store came from.
 */
import { useStore } from 'zustand';

import { createDesignStore, type DesignStore } from 'layout-core';

import { createInitialDoc } from '../initialDoc';

/** One store for the application. `createDesignStore` normalizes the initial document. */
export const designStore = createDesignStore(createInitialDoc());

/**
 * Subscribe to a slice of editor state.
 *
 * Select a primitive or a stable reference — returning a fresh object on every
 * call will re-render forever, because zustand compares with `Object.is`.
 */
export function useDesignStore<T>(selector: (state: DesignStore) => T): T {
  return useStore(designStore, selector);
}

/** Read state without subscribing — for event handlers and imperative work. */
export function designState(): DesignStore {
  return designStore.getState();
}

// In development the store is reachable from the console (and from automated UI
// checks) as `__designStore`. Guarded so it is tree-shaken out of production.
if (import.meta.env?.DEV) {
  (globalThis as unknown as Record<string, unknown>).__designStore = designStore;
}
