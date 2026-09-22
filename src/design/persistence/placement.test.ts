/**
 * The Phase 8 DoD, end to end against the running API.
 *
 * > dropping an oversized SKU is rejected client-side and server-side with the **same
 * > diagnostic code**
 *
 * `inventory.test.ts` proves the client produces the codes the shared fixtures expect,
 * and `server/tests/test_inventory.py` proves the API does too. This test closes the
 * loop: it computes the verdict with the client's own function, sends the drop, and
 * requires the server's refusal to name the same rule. That is the only version of this
 * assertion that would catch the two sides drifting apart in a way the fixtures miss.
 *
 * Skipped automatically when the API is not running. Start it with `npm run api:dev`
 * (on port 8001 if the Docker container is holding 8000).
 */
import { beforeAll, describe, expect, it } from 'vitest';

import { api, apiBaseUrl, type SkuDto } from './apiClient';
import { checkPlacement } from './inventory';

const API = apiBaseUrl();

async function apiIsUp(): Promise<boolean> {
  try {
    return (await fetch(`${API}/health`, { signal: AbortSignal.timeout(1500) })).ok;
  } catch {
    return false;
  }
}

let reachable = false;

beforeAll(async () => {
  reachable = await apiIsUp();
});

/**
 * A layout whose single bin is exactly 2.7 × 1.6 × 1.0 m with a 500 kg beam limit.
 *
 * Built so the derived bin's opening is known: the capacity arithmetic then comes from
 * the compiler, and both sides check the same numbers.
 */
function oneBinDoc(code: string) {
  return {
    schemaVersion: 1,
    warehouse: { code, name: 'DoD', lengthM: 20, widthM: 12, heightM: 8 },
    rackTypes: [{ id: 'rt', code: 'STD', bayWidthM: 2.7, depthM: 1.0 }],
    aisles: [
      {
        id: 'a',
        code: 'A01',
        orientation: 'X',
        centerline: { x1: 1, z1: 6, x2: 19, z2: 6 },
        widthM: 3.0,
        lanes: [
          {
            id: 'l',
            code: 'A01-L',
            side: 'LEFT',
            rackTypeId: 'rt',
            lengthM: 2.7,
            levels: [{ clearHeightM: 1.6, binDepthM: 1.0, beamHeightM: 0.08, maxWeightKg: 500 }],
          },
        ],
      },
    ],
  };
}

type Prepared = { warehouseId: string; bin: Record<string, unknown>; code: string };

async function prepare(suffix: string): Promise<Prepared | null> {
  const code = `WH-DOD-${suffix}`;
  const doc = oneBinDoc(code);

  const created = await api.createWarehouse({
    code,
    name: 'DoD',
    lengthM: 20,
    widthM: 12,
    heightM: 8,
    doc,
  });
  if (!created.ok) {
    console.warn(`could not create ${code}: ${JSON.stringify(created)}`);
    return null;
  }

  const published = await api.publish(created.data.id, { doc });
  if (!published.ok) {
    console.warn(`could not publish ${code}: ${JSON.stringify(published)}`);
    return null;
  }

  const layout = await api.getPublishedLayout(created.data.id);
  if (!layout.ok || layout.data.bins.length !== 1) return null;

  return { warehouseId: created.data.id, bin: layout.data.bins[0] as Record<string, unknown>, code };
}

async function makeSku(warehouseId: string, sku: Partial<SkuDto>): Promise<SkuDto | null> {
  const created = await api.createSku(warehouseId, {
    sku: sku.sku ?? 'SKU',
    name: '',
    widthM: sku.widthM ?? 1,
    heightM: sku.heightM ?? 1,
    depthM: sku.depthM ?? 1,
    weightKg: sku.weightKg ?? 100,
    stackable: true,
    rotatable: sku.rotatable ?? true,
    hazmat: false,
  });
  return created.ok ? created.data : null;
}

describe('the client and the server agree on placement refusals', () => {
  it('refuses an oversized drop with the same code on both sides', async () => {
    if (!reachable) {
      console.warn(`Skipping placement DoD test: no API at ${API}`);
      return;
    }

    const prepared = await prepare('BIG');
    if (!prepared) return;

    // 2.5 m in every direction: it cannot fit a 1.6 m tall opening in any orientation.
    const oversized = await makeSku(prepared.warehouseId, {
      sku: 'OVERSIZED',
      widthM: 2.5,
      heightM: 2.5,
      depthM: 2.5,
      weightKg: 10,
    });
    expect(oversized).not.toBeNull();
    if (!oversized) return;

    // What the drag ghost would show, computed by the client's own function.
    const clientVerdict = checkPlacement(
      {
        widthM: Number(prepared.bin.widthM),
        heightM: Number(prepared.bin.heightM),
        depthM: Number(prepared.bin.depthM),
        capacityM3: Number(prepared.bin.capacityM3),
        maxWeightKg: Number(prepared.bin.maxWeightKg),
      },
      { volumeM3: 0, weightKg: 0 },
      oversized,
      1,
    );
    expect(clientVerdict.fits).toBe(false);

    const response = await api.createPlacement(String(prepared.bin.id), {
      skuId: oversized.id,
      qty: 1,
    });

    expect(response.ok).toBe(false);
    if (!response.ok) {
      // The DoD, in one line.
      expect(response.code).toBe(clientVerdict.code);
      expect(response.code).toBe('ITEM_DOES_NOT_FIT_OPENING');
    }
  });

  it('agrees on the volume rule too, not just the opening rule', async () => {
    if (!reachable) return;

    const prepared = await prepare('VOL');
    if (!prepared) return;

    const small = await makeSku(prepared.warehouseId, {
      sku: 'SMALL',
      widthM: 1.2,
      heightM: 1.1,
      depthM: 0.8,
      weightKg: 10,
    });
    if (!small) return;

    const bin = {
      widthM: Number(prepared.bin.widthM),
      heightM: Number(prepared.bin.heightM),
      depthM: Number(prepared.bin.depthM),
      capacityM3: Number(prepared.bin.capacityM3),
      maxWeightKg: null,
    };

    // Too many for the volume, but each one fits the opening.
    const clientVerdict = checkPlacement(bin, { volumeM3: 0, weightKg: 0 }, small, 9);
    expect(clientVerdict.code).toBe('EXCEEDS_BIN_VOLUME');

    const response = await api.createPlacement(String(prepared.bin.id), {
      skuId: small.id,
      qty: 9,
    });

    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.code).toBe(clientVerdict.code);
  });

  it('replaces rather than stacks a re-drop, and agrees about what no longer fits', async () => {
    if (!reachable) return;

    const prepared = await prepare('OK');
    if (!prepared) return;

    const sku = await makeSku(prepared.warehouseId, {
      sku: 'FITS',
      widthM: 1.2,
      heightM: 1.1,
      depthM: 0.8,
      weightKg: 100,
    });
    if (!sku) return;

    const bin = {
      widthM: Number(prepared.bin.widthM),
      heightM: Number(prepared.bin.heightM),
      depthM: Number(prepared.bin.depthM),
      capacityM3: Number(prepared.bin.capacityM3),
      maxWeightKg: null,
    };

    const first = await api.createPlacement(String(prepared.bin.id), { skuId: sku.id, qty: 2 });
    expect(first.ok, JSON.stringify(first)).toBe(true);

    const after = await api.listBinPlacements(String(prepared.bin.id));
    expect(after.ok).toBe(true);
    if (!after.ok) return;

    const expectedUsed = 1.2 * 1.1 * 0.8 * 2;
    expect(after.data.usedVolumeM3).toBeCloseTo(expectedUsed, 5);
    expect(after.data.usedWeightKg).toBeCloseTo(200, 5);

    // A re-drop *sets* the quantity — `(bin_id, sku_id)` is unique — so the check must
    // exclude this SKU's own row, or it would refuse a drop for space it is about to
    // free. `BinsInstanced` does exactly this; here it is checked explicitly.
    const clientVerdict = checkPlacement(bin, { volumeM3: 0, weightKg: 0 }, sku, 3);
    expect(clientVerdict.fits).toBe(true);

    const replaced = await api.createPlacement(String(prepared.bin.id), { skuId: sku.id, qty: 3 });
    expect(replaced.ok, JSON.stringify(replaced)).toBe(true);

    const afterReplace = await api.listBinPlacements(String(prepared.bin.id));
    expect(afterReplace.ok).toBe(true);
    if (!afterReplace.ok) return;
    // Three, not five: the row was replaced, not added to.
    expect(afterReplace.data.usedVolumeM3).toBeCloseTo(1.2 * 1.1 * 0.8 * 3, 5);

    // Now a quantity that genuinely does not fit, refused by both sides with one code.
    const tooMany = checkPlacement(bin, { volumeM3: 0, weightKg: 0 }, sku, 5);
    expect(tooMany.fits).toBe(false);

    const refused = await api.createPlacement(String(prepared.bin.id), {
      skuId: sku.id,
      qty: 5,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe(tooMany.code);
  });
});
