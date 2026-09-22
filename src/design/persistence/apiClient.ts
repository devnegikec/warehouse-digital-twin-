/**
 * Typed client for the persistence API.
 *
 * Requests return a discriminated result instead of throwing. The editor has to
 * distinguish `STALE_DRAFT` (someone else moved the draft) from `COMPILER_DRIFT` (the
 * two compilers disagree — the alarm that must never be swallowed) from a plain
 * network failure, and it has to *show* the difference. Exceptions would make the
 * three cases look alike at every call site.
 *
 * Types come from `apiTypes.ts`, generated from the FastAPI OpenAPI schema by
 * `npm run gen:api-types`. Nothing about the wire contract is written by hand.
 */
import type { components } from './apiTypes';

type Schemas = components['schemas'];

export type WarehouseDto = Schemas['WarehouseOut'];
export type VersionDto = Schemas['VersionOut'];
export type DraftSavedDto = Schemas['DraftOut'];
export type PublishDto = Schemas['PublishOut'];
export type PublishedLayoutDto = Schemas['PublishedLayoutOut'];
export type SkuDto = Schemas['SkuOut'];
export type PlacementDto = Schemas['PlacementOut'];
export type BinPlacementsDto = Schemas['BinPlacementsOut'];
export type BulkPlacementDto = Schemas['BulkPlacementOut'];
export type UtilizationDto = Schemas['UtilizationOut'];
export type SkuInput = Schemas['SkuIn'];

/** Every refusal the API can return, in the shared envelope. */
export type ApiFailure = {
  ok: false;
  /** HTTP status, or 0 when the request never reached the server. */
  status: number;
  code: string;
  message: string;
  /** Present on validation and publish refusals. */
  diagnostics?: unknown[];
  /** Present on COMPILER_DRIFT. */
  clientDocHash?: string;
  serverDocHash?: string;
  /** Present on STALE_DRAFT. */
  expectedRevision?: number;
  actualRevision?: number;
};

export type ApiResult<T> = { ok: true; data: T } | ApiFailure;

const DEFAULT_BASE_URL = 'http://localhost:8000';

export function apiBaseUrl(): string {
  const configured = import.meta.env?.VITE_API_URL;
  return typeof configured === 'string' && configured.length > 0 ? configured : DEFAULT_BASE_URL;
}

type RequestOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  /** Sent as `If-Match`; required by the draft endpoints. */
  ifMatch?: number;
  signal?: AbortSignal;
};

async function request<T>(path: string, options: RequestOptions = {}): Promise<ApiResult<T>> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.ifMatch !== undefined) headers['If-Match'] = String(options.ifMatch);

  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl()}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });
  } catch (error) {
    // No status at all: the server is not running, or the request was aborted.
    return {
      ok: false,
      status: 0,
      code: 'NETWORK_ERROR',
      message:
        error instanceof Error && error.name === 'AbortError'
          ? 'The request was cancelled'
          : `Could not reach the API at ${apiBaseUrl()}`,
    };
  }

  if (response.status === 204) {
    return { ok: true, data: undefined as T };
  }

  const text = await response.text();
  let parsed: unknown = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }

  if (!response.ok) {
    return failureFrom(response.status, parsed, text);
  }

  return { ok: true, data: parsed as T };
}

/**
 * FastAPI nests the envelope under `detail`. Unwrapping it here means no caller has
 * to know that, and a response that is not an envelope at all still produces
 * something readable rather than `undefined`.
 */
export function failureFrom(status: number, parsed: unknown, rawText = ''): ApiFailure {
  const detail = (parsed as { detail?: unknown } | null)?.detail;

  if (detail && typeof detail === 'object') {
    const envelope = detail as Record<string, unknown>;
    return {
      ok: false,
      status,
      code: typeof envelope.code === 'string' ? envelope.code : `HTTP_${status}`,
      message: typeof envelope.message === 'string' ? envelope.message : `HTTP ${status}`,
      diagnostics: Array.isArray(envelope.diagnostics) ? envelope.diagnostics : undefined,
      clientDocHash:
        typeof envelope.clientDocHash === 'string' ? envelope.clientDocHash : undefined,
      serverDocHash:
        typeof envelope.serverDocHash === 'string' ? envelope.serverDocHash : undefined,
      expectedRevision:
        typeof envelope.expectedRevision === 'number' ? envelope.expectedRevision : undefined,
      actualRevision:
        typeof envelope.actualRevision === 'number' ? envelope.actualRevision : undefined,
    };
  }

  return {
    ok: false,
    status,
    code: `HTTP_${status}`,
    message: rawText.slice(0, 400) || `HTTP ${status}`,
  };
}

export const api = {
  listWarehouses: () => request<WarehouseDto[]>('/api/warehouses'),

  getWarehouse: (warehouseId: string) => request<WarehouseDto>(`/api/warehouses/${warehouseId}`),

  createWarehouse: (payload: {
    code: string;
    name?: string;
    lengthM: number;
    widthM: number;
    heightM: number;
    doc?: unknown;
  }) =>
    request<WarehouseDto>('/api/warehouses', {
      method: 'POST',
      body: { name: '', ...payload },
    }),

  putDraft: (
    warehouseId: string,
    payload: { doc: unknown; clientDocHash?: string },
    ifMatch: number,
  ) =>
    request<DraftSavedDto>(`/api/warehouses/${warehouseId}/draft`, {
      method: 'PUT',
      body: payload,
      ifMatch,
    }),

  discardDraft: (warehouseId: string, ifMatch: number) =>
    request<void>(`/api/warehouses/${warehouseId}/draft`, { method: 'DELETE', ifMatch }),

  publish: (warehouseId: string, payload: { doc: unknown; clientDocHash?: string; createdBy?: string }) =>
    request<PublishDto>(`/api/warehouses/${warehouseId}/publish`, { method: 'POST', body: payload }),

  listVersions: (warehouseId: string) =>
    request<VersionDto[]>(`/api/warehouses/${warehouseId}/versions`),

  getPublishedLayout: (warehouseId: string) =>
    request<PublishedLayoutDto>(`/api/warehouses/${warehouseId}/layout`),

  // --- SKUs and placements (Phase 8) ---

  listSkus: (warehouseId: string) => request<SkuDto[]>(`/api/warehouses/${warehouseId}/skus`),

  createSku: (warehouseId: string, payload: SkuInput) =>
    request<SkuDto>(`/api/warehouses/${warehouseId}/skus`, { method: 'POST', body: payload }),

  updateSku: (skuId: string, payload: SkuInput) =>
    request<SkuDto>(`/api/skus/${skuId}`, { method: 'PUT', body: payload }),

  deleteSku: (skuId: string) => request<void>(`/api/skus/${skuId}`, { method: 'DELETE' }),

  listPlacements: (warehouseId: string) =>
    request<PlacementDto[]>(`/api/warehouses/${warehouseId}/placements`),

  listBinPlacements: (binId: string) =>
    request<BinPlacementsDto>(`/api/bins/${binId}/placements`),

  createPlacement: (binId: string, payload: { skuId: string; qty: number }) =>
    request<PlacementDto>(`/api/bins/${binId}/placements`, { method: 'POST', body: payload }),

  deletePlacement: (placementId: string) =>
    request<void>(`/api/placements/${placementId}`, { method: 'DELETE' }),

  bulkPlace: (warehouseId: string, payload: { skuId: string; qty: number; binIds: string[] }) =>
    request<BulkPlacementDto>(`/api/warehouses/${warehouseId}/placements/bulk`, {
      method: 'POST',
      body: payload,
    }),

  getUtilization: (warehouseId: string) =>
    request<UtilizationDto>(`/api/warehouses/${warehouseId}/utilization`),
};
