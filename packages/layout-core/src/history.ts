/**
 * Patch-based undo/redo (P7).
 *
 * Modelled as a value, not a mutable stack: `HistoryState` is plain data and every
 * operation returns a new state. That makes it trivially testable, friendly to
 * Zustand, and impossible to get into a half-updated state.
 *
 * Patches come from immer's `produceWithPatches`, so the forward and inverse
 * patches are derived from the edit itself rather than hand-written. The one rule
 * that keeps them valid: an entry may only be replayed against the exact document
 * it was produced from, which the linear past/future stacks guarantee. Branching
 * (committing after an undo) clears the redo stack.
 */
import { applyPatches, enablePatches, type Patch } from 'immer';

import {
  COMMAND_LABELS,
  applyCommand,
  defaultCommandContext,
  type Command,
  type CommandContext,
  type CommandOutcome,
  type CommandType,
} from './commands.js';
import type { LayoutDoc } from './schema.js';

enablePatches();

/** How many edits can be undone. Oldest entries are dropped beyond this. */
export const HISTORY_LIMIT = 200;

export type HistoryEntry = {
  commandType: CommandType;
  label: string;
  patches: Patch[];
  inversePatches: Patch[];
};

export type HistoryState = {
  doc: LayoutDoc;
  past: HistoryEntry[];
  future: HistoryEntry[];
};

export function createHistory(doc: LayoutDoc): HistoryState {
  return { doc, past: [], future: [] };
}

export type CommitResult = {
  state: HistoryState;
  outcome: CommandOutcome;
};

/**
 * Apply a command and push it onto the undo stack. A rejected command leaves the
 * state untouched and returns the reason.
 */
export function commit(
  state: HistoryState,
  command: Command,
  ctx: CommandContext = defaultCommandContext,
  limit: number = HISTORY_LIMIT,
): CommitResult {
  const outcome = applyCommand(state.doc, command, ctx);
  if (!outcome.ok) return { state, outcome };

  const entry: HistoryEntry = {
    commandType: command.type,
    label: COMMAND_LABELS[command.type],
    patches: outcome.patches,
    inversePatches: outcome.inversePatches,
  };

  const past = [...state.past, entry];
  if (past.length > limit) past.splice(0, past.length - limit);

  // Any commit invalidates the redo stack: those patches no longer apply.
  return { state: { doc: outcome.doc, past, future: [] }, outcome };
}

export function undo(state: HistoryState): HistoryState {
  const entry = state.past.at(-1);
  if (!entry) return state;

  return {
    doc: applyPatches(state.doc, entry.inversePatches),
    past: state.past.slice(0, -1),
    // Prepend: the most recently undone edit must be the next one redone.
    future: [entry, ...state.future],
  };
}

export function redo(state: HistoryState): HistoryState {
  const entry = state.future[0];
  if (!entry) return state;

  return {
    doc: applyPatches(state.doc, entry.patches),
    past: [...state.past, entry],
    future: state.future.slice(1),
  };
}

export function canUndo(state: HistoryState): boolean {
  return state.past.length > 0;
}

export function canRedo(state: HistoryState): boolean {
  return state.future.length > 0;
}

export function undoLabel(state: HistoryState): string | null {
  return state.past.at(-1)?.label ?? null;
}

export function redoLabel(state: HistoryState): string | null {
  return state.future[0]?.label ?? null;
}

export function historyDepth(state: HistoryState): { undo: number; redo: number } {
  return { undo: state.past.length, redo: state.future.length };
}

/** Replace the document and discard history — for loading a different layout. */
export function resetHistory(doc: LayoutDoc): HistoryState {
  return createHistory(doc);
}
