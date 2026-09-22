/**
 * Editor state (P7, §7.2).
 *
 * Built on `zustand/vanilla`, which has no React dependency, so the whole editor
 * state machine is exercised by the same test suite as the compiler. The React
 * binding is a one-line hook in the app (`src/design/store/useDesignStore.ts`).
 *
 * Two invariants this module owns:
 *
 * 1. **`doc` is the only source of truth.** `graph` (bins, bays, diagnostics, hash)
 *    is derived and recomputed in the same `set()` call that changes the document,
 *    so the two can never disagree.
 * 2. **Nothing mutates `doc` except `dispatch`.** Undo/redo move it backwards and
 *    forwards along the same patch chain.
 */
import { createStore, type StoreApi } from 'zustand/vanilla';

import { defaultCommandContext, type Command, type CommandOutcome } from './commands.js';
import { buildLayout, normalizeDoc, type DerivedBin, type LayoutGraph } from './compile.js';
import type { EntityRef } from './diagnostics.js';
import {
  canRedo,
  canUndo,
  commit,
  createHistory,
  historyDepth,
  redo,
  redoLabel,
  undo,
  undoLabel,
  type HistoryState,
} from './history.js';
import type { LayoutDoc } from './schema.js';

/**
 * `buildLayout` re-parses the document, so caching by object identity avoids
 * repeated work when several selectors read the same state in one render.
 * Immer gives structural sharing, so identity only changes when the document
 * actually changes — which is exactly when a recompile is required.
 */
const graphCache = new WeakMap<LayoutDoc, LayoutGraph>();

export function compileCached(doc: LayoutDoc): LayoutGraph {
  const cached = graphCache.get(doc);
  if (cached) return cached;
  const graph = buildLayout(doc);
  graphCache.set(doc, graph);
  return graph;
}

export type ToolMode = 'SELECT' | 'ADD_AISLE' | 'ADD_OBSTACLE' | 'PLACE_SKU';

export type DesignState = {
  /** The edit history, including the current document. */
  history: HistoryState;
  /** Derived from `history.doc`; never edited directly. */
  graph: LayoutGraph;
  selection: EntityRef[];
  tool: ToolMode;
  /** Editor grid increment, in metres. */
  snapM: number;
  hoveredBinCode: string | null;
  /** Result of the most recent dispatch, for surfacing a rejected command. */
  lastOutcome: CommandOutcome | null;
};

export type DesignActions = {
  dispatch: (command: Command) => CommandOutcome;
  undo: () => void;
  redo: () => void;
  /** Load a different document and discard history. */
  loadDocument: (doc: unknown) => void;
  setTool: (tool: ToolMode) => void;
  setSnapM: (snapM: number) => void;
  select: (refs: EntityRef | EntityRef[] | null) => void;
  toggleSelection: (ref: EntityRef) => void;
  clearSelection: () => void;
  setHoveredBin: (binCode: string | null) => void;
};

export type DesignStore = DesignState & DesignActions;
export type DesignStoreApi = StoreApi<DesignStore>;

export type DesignStoreOptions = {
  idFactory?: () => string;
  historyLimit?: number;
  snapM?: number;
};

export const DEFAULT_SNAP_M = 0.05;

export function createDesignStore(
  initialDoc: unknown,
  options: DesignStoreOptions = {},
): DesignStoreApi {
  const ctx = options.idFactory
    ? { idFactory: options.idFactory }
    : defaultCommandContext;
  const historyLimit = options.historyLimit ?? 200;

  const start = normalizeDoc(initialDoc);

  return createStore<DesignStore>()((set, get) => {
    /** Keep `graph` and `history` in lockstep — they are always set together. */
    const applyHistory = (history: HistoryState, lastOutcome: CommandOutcome | null = null) => {
      set({ history, graph: compileCached(history.doc), lastOutcome });
    };

    return {
      history: createHistory(start),
      graph: compileCached(start),
      selection: [],
      tool: 'SELECT',
      snapM: options.snapM ?? DEFAULT_SNAP_M,
      hoveredBinCode: null,
      lastOutcome: null,

      dispatch: (command) => {
        const result = commit(get().history, command, ctx, historyLimit);
        if (result.outcome.ok) {
          applyHistory(result.state, result.outcome);
        } else {
          set({ lastOutcome: result.outcome });
        }
        return result.outcome;
      },

      undo: () => {
        const history = get().history;
        if (!canUndo(history)) return;
        applyHistory(undo(history));
      },

      redo: () => {
        const history = get().history;
        if (!canRedo(history)) return;
        applyHistory(redo(history));
      },

      loadDocument: (doc) => {
        const normalized = normalizeDoc(doc);
        set({
          history: createHistory(normalized),
          graph: compileCached(normalized),
          selection: [],
          hoveredBinCode: null,
          lastOutcome: null,
        });
      },

      setTool: (tool) => set({ tool }),
      setSnapM: (snapM) => set({ snapM }),
      select: (refs) =>
        set({ selection: refs === null ? [] : Array.isArray(refs) ? refs : [refs] }),
      toggleSelection: (ref) => {
        const { selection } = get();
        const exists = selection.some((item) => item.kind === ref.kind && item.id === ref.id);
        set({
          selection: exists
            ? selection.filter((item) => !(item.kind === ref.kind && item.id === ref.id))
            : [...selection, ref],
        });
      },
      clearSelection: () => set({ selection: [] }),
      setHoveredBin: (binCode) => set({ hoveredBinCode: binCode }),
    };
  });
}

// --- Selectors ---------------------------------------------------------------
// Pure functions over the store shape, so components stay declarative (P14).

export function selectDoc(state: DesignState): LayoutDoc {
  return state.history.doc;
}

export function selectBins(state: DesignState): DerivedBin[] {
  return state.graph.bins;
}

export function selectBinByCode(state: DesignState, code: string): DerivedBin | undefined {
  return state.graph.bins.find((bin) => bin.code === code);
}

export function selectDiagnostics(state: DesignState) {
  return state.graph.diagnostics;
}

export function selectErrors(state: DesignState) {
  return state.graph.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
}

export function selectWarnings(state: DesignState) {
  return state.graph.diagnostics.filter((diagnostic) => diagnostic.severity === 'warning');
}

export function selectPublishable(state: DesignState): boolean {
  return state.graph.publishable;
}

export function selectCanUndo(state: DesignState): boolean {
  return canUndo(state.history);
}

export function selectCanRedo(state: DesignState): boolean {
  return canRedo(state.history);
}

export function selectUndoLabel(state: DesignState): string | null {
  return undoLabel(state.history);
}

export function selectRedoLabel(state: DesignState): string | null {
  return redoLabel(state.history);
}

export function selectHistoryDepth(state: DesignState): { undo: number; redo: number } {
  return historyDepth(state.history);
}

/** Bin codes currently selected, for highlighting in the 3D scene. */
export function selectSelectedBinCodes(state: DesignState): string[] {
  return state.selection.filter((ref) => ref.kind === 'bin').map((ref) => ref.id);
}
