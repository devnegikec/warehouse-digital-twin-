/**
 * A configurable large layout, shared by the performance guards.
 *
 * Built by repeating the designer's starting aisle rather than by inventing a shape, so
 * the measurements are of a layout someone would actually design: real bay widths, real
 * level heights, two lanes per aisle.
 */
import type { LayoutDocInput } from 'layout-core';

import { createInitialDoc } from './initialDoc';

const BINS_PER_AISLE = 2 * 12 * 5; // two lanes × 12 bays × 5 levels

export function largeDoc(targetBins: number): LayoutDocInput {
  const base = createInitialDoc();
  const aisleCount = Math.max(1, Math.round(targetBins / BINS_PER_AISLE));

  return {
    ...base,
    warehouse: { ...base.warehouse, lengthM: 40, widthM: Math.max(20, aisleCount * 6 + 4) },
    aisles: Array.from({ length: aisleCount }, (_, index) => {
      const aisleNumber = index + 1;
      const code = `A${String(aisleNumber).padStart(2, '0')}`;
      const z = 5 + index * 6;
      return {
        id: `a-${aisleNumber}`,
        code,
        orientation: 'X' as const,
        centerline: { x1: 3, z1: z, x2: 37, z2: z },
        widthM: 3.4,
        travelDirection: 'BOTH' as const,
        lanes: (['LEFT', 'RIGHT'] as const).map((side) => ({
          id: `a-${aisleNumber}-${side === 'LEFT' ? 'l' : 'r'}`,
          code: `${code}-${side === 'LEFT' ? 'L' : 'R'}`,
          side,
          rackTypeId: 'rt-std',
          startOffsetM: 0,
          lengthM: 32.4,
          levels: Array.from({ length: 5 }, () => ({
            clearHeightM: 1.4,
            binDepthM: 1.0,
            beamHeightM: 0.08,
            maxWeightKg: 800,
          })),
        })),
      };
    }),
  };
}
