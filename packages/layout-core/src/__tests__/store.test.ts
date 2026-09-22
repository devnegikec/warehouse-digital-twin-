/**
 * Editor store (Phase 3).
 *
 * The store is built on `zustand/vanilla`, so it can be driven directly here with
 * no React renderer. The invariant under test throughout: `graph` is always a
 * faithful projection of `history.doc`.
 */
import { describe, expect, it } from 'vitest';

import { command, createSequentialIdFactory } from '../commands.js';
import { buildLayout } from '../compile.js';
import {
  DEFAULT_SNAP_M,
  compileCached,
  createDesignStore,
  selectBins,
  selectCanRedo,
  selectCanUndo,
  selectErrors,
  selectHistoryDepth,
  selectPublishable,
  selectRedoLabel,
  selectSelectedBinCodes,
  selectUndoLabel,
  selectWarnings,
} from '../store.js';
import { aisleInput, emptyDoc, laneInput, largeDoc, obstacleInput, richDoc } from './helpers.js';

function store(initial = emptyDoc()) {
  return createDesignStore(initial, { idFactory: createSequentialIdFactory('s') });
}

describe('createDesignStore', () => {
  it('derives the graph from the initial document', () => {
    const api = store(richDoc());
    const state = api.getState();

    expect(state.graph.bins).toHaveLength(20);
    expect(state.graph.doc).toEqual(state.history.doc);
    expect(state.graph.hash).toBe(buildLayout(richDoc()).hash);
  });

  it('starts with sensible editor defaults', () => {
    const state = store().getState();

    expect(state.tool).toBe('SELECT');
    expect(state.snapM).toBe(DEFAULT_SNAP_M);
    expect(state.selection).toEqual([]);
    expect(state.hoveredBinCode).toBeNull();
    expect(state.lastOutcome).toBeNull();
  });

  it('recomputes the graph when a command changes the document', () => {
    const api = store();

    const outcome = api.getState().dispatch(command({ type: 'aisle.add', aisle: aisleInput() }));
    expect(outcome.ok).toBe(true);

    expect(api.getState().graph.bins).toHaveLength(10);
    expect(api.getState().history.doc.aisles).toHaveLength(1);
    expect(api.getState().lastOutcome?.ok).toBe(true);
  });

  it('keeps doc and graph in step across many commands', () => {
    const api = store(richDoc());
    // richDoc: 10 bays x 2 levels = 20 bins.
    expect(api.getState().graph.bins).toHaveLength(20);

    // A new lane takes the default single level: +10 bays x 1 level.
    api.getState().dispatch(command({ type: 'lane.add', aisleId: 'a1', lane: laneInput({ side: 'RIGHT' }) }));
    expect(api.getState().graph.bins).toHaveLength(30);

    // Skipping bay 1 removes that bay's two levels.
    api.getState().dispatch(command({ type: 'lane.toggleSkipBay', laneId: 'l1', baySeq: 1 }));
    expect(api.getState().graph.bins).toHaveLength(28);

    // A third level on l1 adds 9 bays x 1 level.
    api.getState().dispatch(command({ type: 'lane.addLevel', laneId: 'l1' }));
    expect(api.getState().graph.bins).toHaveLength(37);

    // `graph.doc` is the normalized copy produced by the compiler, so it is deeply
    // equal to the history document rather than the same object.
    expect(api.getState().graph.doc).toEqual(api.getState().history.doc);
  });

  it('records a rejected command without touching the document', () => {
    const api = store(richDoc());
    const before = api.getState().history.doc;

    const outcome = api.getState().dispatch(
      command({ type: 'aisle.remove', aisleId: 'does-not-exist' }),
    );

    expect(outcome.ok).toBe(false);
    expect(api.getState().history.doc).toBe(before);
    expect(api.getState().graph.doc).toEqual(before);
    expect(api.getState().lastOutcome?.reason).toMatch(/No aisle with id/);
    expect(selectCanUndo(api.getState())).toBe(false);
  });

  it('undoes and redoes, moving the graph with the document', () => {
    const api = store();
    api.getState().dispatch(command({ type: 'aisle.add', aisle: aisleInput() }));
    const afterAdd = api.getState();

    api.getState().undo();
    expect(api.getState().graph.bins).toHaveLength(0);
    expect(selectCanRedo(api.getState())).toBe(true);
    expect(selectUndoLabel(api.getState())).toBeNull();

    api.getState().redo();
    expect(api.getState().graph.bins).toHaveLength(10);
    expect(api.getState().graph.hash).toBe(afterAdd.graph.hash);
    expect(api.getState().graph.doc).toEqual(afterAdd.history.doc);
  });

  it('ignores undo and redo when the stacks are empty', () => {
    const api = store();
    const before = api.getState().history;

    api.getState().undo();
    api.getState().redo();

    expect(api.getState().history).toBe(before);
  });

  it('loads a document and discards history', () => {
    const api = store();
    api.getState().dispatch(command({ type: 'aisle.add', aisle: aisleInput() }));
    api.getState().dispatch(command({ type: 'obstacle.add', obstacle: obstacleInput() }));
    expect(selectHistoryDepth(api.getState())).toEqual({ undo: 2, redo: 0 });

    api.getState().loadDocument(richDoc());

    expect(selectHistoryDepth(api.getState())).toEqual({ undo: 0, redo: 0 });
    expect(selectCanUndo(api.getState())).toBe(false);
    expect(api.getState().graph.bins).toHaveLength(20);
    expect(api.getState().selection).toEqual([]);
  });

  it('rejects a document that violates the contract', () => {
    const api = store();
    expect(() => api.getState().loadDocument({ schemaVersion: 1 })).toThrow();
  });

  it('selects, toggles and clears selection', () => {
    const api = store();
    const bin = { kind: 'bin' as const, id: 'WH1/A01/L/B001/L1' };

    api.getState().select(bin);
    expect(selectSelectedBinCodes(api.getState())).toEqual([bin.id]);

    api.getState().select([bin, { kind: 'aisle', id: 'a1' }]);
    expect(api.getState().selection).toHaveLength(2);

    api.getState().toggleSelection(bin);
    expect(selectSelectedBinCodes(api.getState())).toEqual([]);

    api.getState().toggleSelection(bin);
    expect(selectSelectedBinCodes(api.getState())).toEqual([bin.id]);

    api.getState().select(null);
    expect(api.getState().selection).toEqual([]);
  });

  it('sets the active tool, the snap increment and the hovered bin', () => {
    const api = store();

    api.getState().setTool('ADD_AISLE');
    api.getState().setSnapM(0.25);
    api.getState().setHoveredBin('WH1/A01/L/B001/L1');

    expect(api.getState().tool).toBe('ADD_AISLE');
    expect(api.getState().snapM).toBe(0.25);
    expect(api.getState().hoveredBinCode).toBe('WH1/A01/L/B001/L1');
  });

  it('is isolated per store instance', () => {
    const first = store();
    const second = store();

    first.getState().dispatch(command({ type: 'aisle.add', aisle: aisleInput() }));

    expect(first.getState().graph.bins).toHaveLength(10);
    expect(second.getState().graph.bins).toHaveLength(0);
  });
});

describe('selectors', () => {
  it('splits diagnostics by severity and reports publishability', () => {
    const api = store(richDoc());
    api.getState().dispatch(command({ type: 'aisle.update', aisleId: 'a1', patch: { widthM: 2 } }));

    const state = api.getState();
    expect(selectWarnings(state).map((d) => d.code)).toEqual(['AISLE_TOO_NARROW']);
    expect(selectErrors(state)).toEqual([]);
    expect(selectPublishable(state)).toBe(true);
  });

  it('reports publishability false once a hard error exists', () => {
    const api = store(richDoc());
    api.getState().dispatch(command({ type: 'obstacle.update', obstacleId: 'ob1', patch: { z: 8 } }));

    expect(selectErrors(api.getState()).length).toBeGreaterThan(0);
    expect(selectPublishable(api.getState())).toBe(false);
  });

  it('exposes history depth and labels', () => {
    const api = store();
    api.getState().dispatch(command({ type: 'aisle.add', aisle: aisleInput() }));
    api.getState().dispatch(command({ type: 'obstacle.add', obstacle: obstacleInput() }));

    expect(selectHistoryDepth(api.getState())).toEqual({ undo: 2, redo: 0 });
    expect(selectUndoLabel(api.getState())).toBe('Add obstacle');

    api.getState().undo();
    expect(selectRedoLabel(api.getState())).toBe('Add obstacle');
  });

  it('lists every derived bin', () => {
    expect(selectBins(store(richDoc()).getState())).toHaveLength(20);
  });
});

describe('compile cache', () => {
  it('returns the identical graph for the same document object', () => {
    const doc = richDoc();
    expect(compileCached(doc)).toBe(compileCached(doc));
  });

  it('distinguishes different documents', () => {
    expect(compileCached(richDoc())).not.toBe(compileCached(richDoc()));
  });

  it('is reused by the store rather than recomputed', () => {
    const api = store(richDoc());
    expect(api.getState().graph).toBe(compileCached(api.getState().history.doc));
  });
});

describe('compile performance', () => {
  it('compiles a 1,500-bin layout well inside an interactive budget', () => {
    const doc = largeDoc();

    const started = performance.now();
    const graph = buildLayout(doc);
    const elapsed = performance.now() - started;

    expect(graph.bins).toHaveLength(1_500);
    // Generous bound: this is a guard against accidental O(n^2) behaviour, not a
    // benchmark. A quadratic regression would blow past this by orders of magnitude.
    expect(elapsed).toBeLessThan(500);
  });

  it('serves a cached compile without recompiling', () => {
    const api = store(largeDoc());
    const first = api.getState().graph;

    const started = performance.now();
    for (let i = 0; i < 1_000; i += 1) compileCached(api.getState().history.doc);
    const elapsed = performance.now() - started;

    expect(api.getState().graph).toBe(first);
    expect(elapsed).toBeLessThan(50);
  });
});
