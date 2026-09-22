/**
 * The persistence client's contract with the API.
 *
 * `failureFrom` is the piece worth testing: FastAPI nests the envelope under `detail`,
 * and if that unwrapping is wrong every call site sees `undefined` instead of the code
 * it branches on — which would turn a deliberate refusal (COMPILER_DRIFT, STALE_DRAFT)
 * into a mystery. The `If-Match` header is tested for the same reason: it is the whole
 * optimistic-locking mechanism, and it is easy to drop silently in a refactor.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { api, apiBaseUrl, failureFrom } from './apiClient';

describe('failureFrom', () => {
  it('unwraps the envelope FastAPI nests under detail', () => {
    const failure = failureFrom(409, {
      detail: {
        code: 'STALE_DRAFT',
        message: 'Draft revision 1 is stale; the server is at 2',
        expectedRevision: 1,
        actualRevision: 2,
      },
    });

    expect(failure.ok).toBe(false);
    expect(failure.status).toBe(409);
    expect(failure.code).toBe('STALE_DRAFT');
    expect(failure.expectedRevision).toBe(1);
    expect(failure.actualRevision).toBe(2);
  });

  it('carries both hashes for a drift refusal', () => {
    const failure = failureFrom(409, {
      detail: {
        code: 'COMPILER_DRIFT',
        message: 'The TypeScript and Python compilers disagree',
        clientDocHash: 'a'.repeat(64),
        serverDocHash: 'b'.repeat(64),
      },
    });

    expect(failure.code).toBe('COMPILER_DRIFT');
    expect(failure.clientDocHash).toBe('a'.repeat(64));
    expect(failure.serverDocHash).toBe('b'.repeat(64));
  });

  it('keeps the diagnostics a publish refusal came with', () => {
    const failure = failureFrom(422, {
      detail: {
        code: 'LAYOUT_NOT_PUBLISHABLE',
        message: 'The layout has errors',
        diagnostics: [{ code: 'BIN_OUT_OF_FOOTPRINT', severity: 'error' }],
      },
    });

    expect(failure.code).toBe('LAYOUT_NOT_PUBLISHABLE');
    expect(failure.diagnostics).toHaveLength(1);
  });

  it('still produces a readable code when the body is not an envelope', () => {
    const failure = failureFrom(502, null, '<html>bad gateway</html>');

    expect(failure.code).toBe('HTTP_502');
    expect(failure.message).toContain('bad gateway');
  });

  it('survives an empty error body', () => {
    const failure = failureFrom(500, null, '');

    expect(failure.code).toBe('HTTP_500');
    expect(failure.message).toBe('HTTP 500');
  });
});

describe('the If-Match header', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is sent as a bare integer revision on a draft write', async () => {
    const fetchMock = vi.fn(async () => new Response('{"draftRevision":8}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await api.putDraft('wh-1', { doc: { schemaVersion: 1 }, clientDocHash: 'abc' }, 7);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toContain('/api/warehouses/wh-1/draft');
    expect(init.method).toBe('PUT');
    expect((init.headers as Record<string, string>)['If-Match']).toBe('7');
  });

  it('is not sent when no revision is supplied', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await api.publish('wh-1', { doc: {} });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)['If-Match']).toBeUndefined();
  });
});

describe('a request that never reaches the server', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports a network error with status 0 rather than throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );

    const result = await api.listWarehouses();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(0);
      expect(result.code).toBe('NETWORK_ERROR');
      expect(result.message).toContain(apiBaseUrl());
    }
  });
});
