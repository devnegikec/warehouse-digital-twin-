/**
 * The document the designer opens with.
 *
 * Deliberately a clean layout: zero diagnostics, so the "publishable" state is
 * visible immediately and any error the user sees was caused by their own edit.
 *
 *   3 aisles x 2 lanes x 12 bays x 5 levels = 360 bins
 */
import type { LayoutDocInput } from 'layout-core';

const BAY_WIDTH_M = 2.7;
const LANE_LENGTH_M = 32.4; // 12 bays
const AISLE_WIDTH_M = 3.4;
const LEVELS = 5;

function levels() {
  return Array.from({ length: LEVELS }, () => ({
    clearHeightM: 1.4,
    binDepthM: 1.0,
    beamHeightM: 0.08,
    maxWeightKg: 800,
  }));
}

/** Shared geometry for both rack faces; id and code are filled in per aisle. */
function laneGeometry() {
  return {
    rackTypeId: 'rt-std',
    startOffsetM: 0,
    lengthM: LANE_LENGTH_M,
    levels: levels(),
  };
}

export function createInitialDoc(): LayoutDocInput {
  return {
    schemaVersion: 1,
    warehouse: {
      code: 'WH1',
      name: 'Distribution Centre',
      lengthM: 40,
      widthM: 20,
      heightM: 8,
    },
    rackTypes: [
      {
        id: 'rt-std',
        code: 'STD',
        name: 'Standard pallet rack',
        bayWidthM: BAY_WIDTH_M,
        depthM: 1.1,
      },
    ],
    obstacles: [
      // A structural column near the front wall, clear of every rack face.
      { id: 'ob-1', kind: 'COLUMN', x: 18, z: 0.6, widthM: 1, depthM: 1, heightM: 6 },
    ],
    aisles: [5, 11, 17].map((z, index) => {
      const aisleNumber = index + 1;
      const code = `A${String(aisleNumber).padStart(2, '0')}`;
      return {
        id: `a-${aisleNumber}`,
        code,
        orientation: 'X' as const,
        centerline: { x1: 3, z1: z, x2: 37, z2: z },
        widthM: AISLE_WIDTH_M,
        travelDirection: 'BOTH' as const,
        lanes: (['LEFT', 'RIGHT'] as const).map((side) => ({
          ...laneGeometry(),
          id: `a-${aisleNumber}-${side === 'LEFT' ? 'l' : 'r'}`,
          code: `${code}-${side === 'LEFT' ? 'L' : 'R'}`,
          side,
        })),
      };
    }),
  };
}
