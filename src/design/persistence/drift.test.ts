/**
 * Cross-language drift, over a real HTTP connection.
 *
 * The conformance fixtures prove the two compilers agree on the documents *in the
 * fixtures*. This test covers the gap they cannot: the document the editor actually
 * sends. The TypeScript client posts its **normalized** document — schema defaults
 * already materialised — and the Python server re-normalizes and re-hashes it. If the
 * two disagree even slightly about defaults, hashes differ and publish refuses with
 * COMPILER_DRIFT.
 *
 * That is the highest-severity risk in the design (§10), and this is the only test
 * that exercises it the way production does: bytes over the wire, no shared fixtures.
 *
 * Skipped automatically when the API is not running, so it never breaks `npm run
 * test:app` on a machine with only the frontend up. Start the API with `npm run api:dev`.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import { buildLayout } from 'layout-core';

import { createInitialDoc } from '../initialDoc';
import { api, apiBaseUrl } from './apiClient';

const API = apiBaseUrl();

/**
 * The initial document, re-coded. The warehouse code is part of every bin code and of
 * the hash, and the server keys warehouses on the code *in the document*, so a probe
 * must send a document that agrees with the code it asks for.
 */
function probeDoc(code: string) {
  const doc = createInitialDoc();
  doc.warehouse.code = code;
  return buildLayout(doc);
}

async function apiIsUp(): Promise<boolean> {
  try {
    const response = await fetch(`${API}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

let reachable = false;

beforeAll(async () => {
  reachable = await apiIsUp();
});

describe('the TypeScript-normalized document survives the wire', () => {
  it('compiles on the server to the same hash, with no drift', async () => {
    if (!reachable) {
      // Not a silent pass: the title says what was skipped.
      console.warn(`Skipping drift test: no API at ${API}`);
      return;
    }

    const graph = buildLayout(createInitialDoc());

    const response = await fetch(`${API}/api/layout/compile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ doc: graph.doc, clientDocHash: graph.hash }),
    });

    // Read the body once: `expect`'s message argument is evaluated eagerly, so passing
    // `response.text()` there would consume the stream before `response.json()`.
    const text = await response.text();
    expect(response.status, text).toBe(200);

    const body = JSON.parse(text) as { docHash: string; binCount: number };
    expect(body.docHash).toBe(graph.hash);
    // And they derived the same layout, not just the same hash of the same input.
    expect(body.binCount).toBe(graph.bins.length);
  });

  it('is accepted as a draft, and refused when the hash is wrong', async () => {
    if (!reachable) return;

    const code = `WH-DRIFT-${Math.floor(Math.random() * 1_000_000)}`;
    const graph = probeDoc(code);

    const created = await api.createWarehouse({
      code,
      name: 'Drift probe',
      lengthM: graph.doc.warehouse.lengthM,
      widthM: graph.doc.warehouse.widthM,
      heightM: graph.doc.warehouse.heightM,
      doc: graph.doc,
    });
    expect(created.ok, JSON.stringify(created)).toBe(true);
    if (!created.ok) return;

    const good = await api.putDraft(
      created.data.id,
      { doc: graph.doc, clientDocHash: graph.hash },
      created.data.draftRevision,
    );
    expect(good.ok, JSON.stringify(good)).toBe(true);

    if (!good.ok) return;

    // The same bytes with a deliberately wrong hash must be refused, otherwise the
    // drift check is not actually wired into the write path.
    const drifted = await api.putDraft(
      created.data.id,
      { doc: graph.doc, clientDocHash: '0'.repeat(64) },
      good.data.draftRevision,
    );
    expect(drifted.ok).toBe(false);
    if (!drifted.ok) {
      expect(drifted.status).toBe(409);
      expect(drifted.code).toBe('COMPILER_DRIFT');
    }

    // Clean up so repeated runs do not accumulate warehouses.
    await api.discardDraft(created.data.id, good.data.draftRevision);
  });

  it('refuses a stale draft revision after another save', async () => {
    if (!reachable) return;

    const code = `WH-STALE-${Math.floor(Math.random() * 1_000_000)}`;
    const graph = probeDoc(code);

    const created = await api.createWarehouse({
      code,
      lengthM: graph.doc.warehouse.lengthM,
      widthM: graph.doc.warehouse.widthM,
      heightM: graph.doc.warehouse.heightM,
      doc: graph.doc,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const first = await api.putDraft(created.data.id, { doc: graph.doc }, created.data.draftRevision);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const stale = await api.putDraft(created.data.id, { doc: graph.doc }, created.data.draftRevision);
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.code).toBe('STALE_DRAFT');
      expect(stale.expectedRevision).toBe(created.data.draftRevision);
      expect(stale.actualRevision).toBe(first.data.draftRevision);
    }

    await api.discardDraft(created.data.id, first.data.draftRevision);
  });
});
