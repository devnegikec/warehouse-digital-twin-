/**
 * The publish payload.
 *
 * Publishing is gated on the compiler, not on a form. `graph.publishable` is already
 * false whenever any error-severity rule fires, and the rule registry is the single
 * source of severity (Phase 2) — so the gate here cannot disagree with the diagnostics
 * list, because it is the same computation.
 *
 * Two serialisations are produced on purpose:
 *
 *  - the **canonical** form, which is what `docHash` is computed over and therefore
 *    what the server must hash to detect drift;
 *  - a **readable** form, for a human who wants to see what is about to be sent.
 *
 * The wire request in Phase 7 carries `docHash` as `clientDocHash` so a mismatch
 * between the two compilers is a hard 409 rather than a silent divergence.
 */
import { canonicalize, type LayoutGraph } from 'layout-core';

export type PublishPayload = {
  schemaVersion: number;
  warehouseCode: string;
  /** sha256 of `canonicalJson`; sent as `clientDocHash`. */
  docHash: string;
  doc: unknown;
};

export type PublishSummary = {
  warehouseCode: string;
  aisles: number;
  lanes: number;
  levels: number;
  bays: number;
  activeBays: number;
  bins: number;
};

export function buildPublishPayload(graph: LayoutGraph): PublishPayload {
  return {
    schemaVersion: graph.doc.schemaVersion,
    warehouseCode: graph.doc.warehouse.code,
    docHash: graph.hash,
    doc: graph.doc,
  };
}

export function publishSummary(graph: LayoutGraph): PublishSummary {
  return {
    warehouseCode: graph.doc.warehouse.code,
    aisles: graph.doc.aisles.length,
    lanes: graph.doc.aisles.reduce((total, aisle) => total + aisle.lanes.length, 0),
    levels: graph.doc.aisles.reduce(
      (total, aisle) =>
        total + aisle.lanes.reduce((count, lane) => count + lane.levels.length, 0),
      0,
    ),
    bays: graph.bays.length,
    activeBays: graph.bays.filter((bay) => bay.inRackRun && !bay.isSkipped).length,
    bins: graph.bins.length,
  };
}

/** Exactly what the hash is computed over. */
export function canonicalJson(graph: LayoutGraph): string {
  return canonicalize(graph.doc);
}

/** The same document, formatted for reading. Not hashed. */
export function readableJson(graph: LayoutGraph): string {
  return JSON.stringify(buildPublishPayload(graph), null, 2);
}

/** Copies text, reporting failure rather than pretending it worked. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function downloadJson(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
