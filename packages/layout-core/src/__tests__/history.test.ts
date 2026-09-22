/**
 * Phase 3 definition of done: add aisle → undo → redo leaves the document hash
 * identical to the original.
 *
 * The hash assertions catch value drift; the `toEqual` assertions catch anything a
 * hash could mask (key order, extra keys, a lost `id`).
 */
import { describe, expect, it } from 'vitest';

import { commit, createHistory, historyDepth, redo, redoLabel, undo, undoLabel } from '../history.js';
import { canRedo, canUndo, resetHistory } from '../history.js';
import { command, createSequentialIdFactory } from '../commands.js';
import { buildLayout } from '../compile.js';
import { aisleInput, emptyDoc, laneInput, obstacleInput, richDoc, testContext } from './helpers.js';

const hashOf = (doc: Parameters<typeof buildLayout>[0]) => buildLayout(doc).hash;

describe('undo/redo round trip (definition of done)', () => {
  it('add aisle → undo → redo leaves the doc hash identical', () => {
    const original = emptyDoc();
    const originalHash = hashOf(original);

    const first = commit(
      createHistory(original),
      command({ type: 'aisle.add', aisle: aisleInput() }),
      testContext,
    );
    expect(first.outcome.ok).toBe(true);

    const addedDoc = first.state.doc;
    const addedHash = hashOf(addedDoc);
    expect(addedHash).not.toBe(originalHash);

    const undone = undo(first.state);
    expect(hashOf(undone.doc)).toBe(originalHash);
    expect(undone.doc).toEqual(original);

    const redone = redo(undone);
    expect(hashOf(redone.doc)).toBe(addedHash);
    expect(redone.doc).toEqual(addedDoc);
  });

  it('survives a long sequence of varied edits, in both directions', () => {
    const original = richDoc();
    let state = createHistory(original);

    const commands = [
      command({ type: 'aisle.add', aisle: aisleInput({ centerline: { x1: 2, z1: 16, x2: 38, z2: 16 } }) }),
      command({ type: 'lane.add', laneId: 'l1', aisleId: 'a1', lane: laneInput({ side: 'RIGHT' }) }),
      command({ type: 'lane.setLevel', laneId: 'l1', levelIndex: 0, patch: { clearHeightM: 1.95 } }),
      command({ type: 'lane.addLevel', laneId: 'l1', level: { clearHeightM: 1.2, binDepthM: 0.9 } }),
      command({ type: 'lane.toggleSkipBay', laneId: 'l1', baySeq: 4 }),
      command({ type: 'lane.setSegments', laneId: 'l1', segments: [{ kind: 'GAP', startM: 0, endM: 27 }] }),
      command({ type: 'obstacle.add', obstacle: obstacleInput({ id: 'ob2', x: 20 }) }),
      command({ type: 'aisle.translate', aisleId: 'a1', deltaX: -1, deltaZ: 2 }),
      command({ type: 'warehouse.update', patch: { heightM: 9 } }),
      command({ type: 'rackType.update', rackTypeId: 'rt1', patch: { bayWidthM: 2.5 } }),
    ];

    for (const cmd of commands) {
      const result = commit(state, cmd, testContext);
      expect(result.outcome.ok, `${cmd.type} failed: ${result.outcome.reason ?? ''}`).toBe(true);
      state = result.state;
    }

    const finalDoc = state.doc;
    const finalHash = hashOf(finalDoc);
    expect(historyDepth(state).undo).toBe(commands.length);

    // Rewind all the way to the beginning and compare against the original.
    let rewind = state;
    for (let i = 0; i < commands.length; i += 1) rewind = undo(rewind);

    expect(rewind.doc).toEqual(original);
    expect(hashOf(rewind.doc)).toBe(hashOf(original));
    expect(canRedo(rewind)).toBe(true);

    let forward = rewind;
    for (let i = 0; i < commands.length; i += 1) forward = redo(forward);

    expect(forward.doc).toEqual(finalDoc);
    expect(hashOf(forward.doc)).toBe(finalHash);
  });

  it('restores the same generated id on redo', () => {
    const ctx = { idFactory: createSequentialIdFactory('gen') };
    const first = commit(
      createHistory(emptyDoc()),
      command({ type: 'aisle.add', aisle: aisleInput() }),
      ctx,
    );

    const idAfterUndoRedo = redo(undo(first.state)).doc.aisles[0]?.id;
    expect(idAfterUndoRedo).toBe(first.state.doc.aisles[0]?.id);
    expect(idAfterUndoRedo).toBe('gen-1');
  });
});

describe('history semantics', () => {
  it('starts empty', () => {
    const state = createHistory(emptyDoc());
    expect(canUndo(state)).toBe(false);
    expect(canRedo(state)).toBe(false);
    expect(undoLabel(state)).toBeNull();
    expect(redoLabel(state)).toBeNull();
  });

  it('exposes labels for undo and redo affordances', () => {
    const { state } = commit(
      createHistory(emptyDoc()),
      command({ type: 'aisle.add', aisle: aisleInput() }),
      testContext,
    );

    expect(undoLabel(state)).toBe('Add aisle');

    const rewound = undo(state);
    expect(redoLabel(rewound)).toBe('Add aisle');
  });

  it('keeps undo and redo symmetric across several steps', () => {
    let state = createHistory(emptyDoc());
    state = commit(state, command({ type: 'aisle.add', aisle: aisleInput() }), testContext).state;
    state = commit(
      state,
      command({ type: 'aisle.add', aisle: aisleInput({ centerline: { x1: 2, z1: 16, x2: 38, z2: 16 } }) }),
      testContext,
    ).state;
    state = commit(
      state,
      command({ type: 'obstacle.add', obstacle: obstacleInput({ id: 'ob1' }) }),
      testContext,
    ).state;

    expect(historyDepth(state)).toEqual({ undo: 3, redo: 0 });
    expect(state.doc.aisles).toHaveLength(2);

    state = undo(state);
    expect(historyDepth(state)).toEqual({ undo: 2, redo: 1 });
    expect(state.doc.aisles).toHaveLength(2);
    expect(state.doc.obstacles).toHaveLength(0);

    state = undo(state);
    expect(historyDepth(state)).toEqual({ undo: 1, redo: 2 });
    expect(state.doc.aisles).toHaveLength(1);

    // Redo must replay in the original order, not reverse.
    const afterFirstRedo = redo(state).doc;
    expect(afterFirstRedo.aisles).toHaveLength(2);
    expect(afterFirstRedo.obstacles).toHaveLength(0);

    const afterSecondRedo = redo(redo(state)).doc;
    expect(afterSecondRedo.obstacles).toHaveLength(1);
  });

  it('clears the redo stack when a new command is committed', () => {
    let state = createHistory(emptyDoc());
    state = commit(state, command({ type: 'aisle.add', aisle: aisleInput() }), testContext).state;
    state = undo(state);
    expect(canRedo(state)).toBe(true);

    state = commit(
      state,
      command({ type: 'aisle.add', aisle: aisleInput({ centerline: { x1: 2, z1: 16, x2: 38, z2: 16 } }) }),
      testContext,
    ).state;

    expect(canRedo(state)).toBe(false);
  });

  it('leaves the state untouched when a command is rejected', () => {
    const state = createHistory(richDoc());
    const result = commit(
      state,
      command({ type: 'aisle.remove', aisleId: 'missing' }),
      testContext,
    );

    expect(result.outcome.ok).toBe(false);
    expect(result.state).toBe(state);
    expect(canUndo(result.state)).toBe(false);
  });

  it('is a no-op when there is nothing to undo or redo', () => {
    const state = createHistory(emptyDoc());
    expect(undo(state)).toBe(state);
    expect(redo(state)).toBe(state);
  });

  it('drops the oldest entries beyond the limit', () => {
    let state = createHistory(emptyDoc());

    for (let i = 0; i < 5; i += 1) {
      state = commit(
        state,
        command({ type: 'obstacle.add', obstacle: obstacleInput({ id: `ob${i}` }) }),
        testContext,
        3,
      ).state;
    }

    expect(historyDepth(state).undo).toBe(3);
    // The two dropped edits are unreachable, but the remaining three still undo cleanly.
    while (canUndo(state)) state = undo(state);
    expect(state.doc.obstacles).toHaveLength(2);
  });

  it('resets history when a document is loaded', () => {
    const state = resetHistory(richDoc());
    expect(canUndo(state)).toBe(false);
    expect(canRedo(state)).toBe(false);
  });
});
