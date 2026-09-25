/**
 * Where a newly placed aisle goes.
 *
 * Both the 3D canvas and the 2D plan place aisles with the same rule — one gutter,
 * one run length, one clamp to the footprint. Keeping it here means clicking the
 * floor in either view cannot produce a different aisle.
 */
import { clamp, type AisleInput, type LayoutDoc } from 'layout-core';

/** Clear corridor width of a new aisle, in metres. */
export const NEW_AISLE_WIDTH_M = 3.4;
/** Bay pitch assumed when working out how many bays fit. */
export const NEW_AISLE_BAY_WIDTH_M = 2.7;
/** Clear height of a new aisle's first level. */
export const NEW_AISLE_LEVEL = { clearHeightM: 1.4, binDepthM: 1.0, beamHeightM: 0.08 };

/** Reserve at each end of the warehouse so a new aisle never touches a wall. */
const END_MARGIN_M = 1;
const SIDE_MARGIN_M = 2;

/**
 * An aisle centred on `point`, clamped inside the footprint.
 *
 * `levels` is a fresh object per call: the payload goes straight into a command, and
 * handing the same array to two aisles would make one level edit look like two.
 */
export function makeAisleInput(
  point: { x: number; z: number },
  warehouse: LayoutDoc['warehouse'],
  rackTypeId: string,
): AisleInput {
  const { origin, lengthM, widthM } = warehouse;

  const bays = Math.max(1, Math.floor((lengthM - END_MARGIN_M * 4) / NEW_AISLE_BAY_WIDTH_M));
  const runLength = bays * NEW_AISLE_BAY_WIDTH_M;

  const minX = origin.x + END_MARGIN_M;
  const maxX = Math.max(minX, origin.x + lengthM - runLength - END_MARGIN_M);
  const x1 = clamp(point.x - runLength / 2, minX, maxX);

  const minZ = origin.z + SIDE_MARGIN_M;
  const maxZ = Math.max(minZ, origin.z + widthM - SIDE_MARGIN_M);
  const z = clamp(point.z, minZ, maxZ);

  return {
    orientation: 'X',
    centerline: { x1, z1: z, x2: x1 + runLength, z2: z },
    widthM: NEW_AISLE_WIDTH_M,
    lanes: [{ side: 'LEFT', rackTypeId, lengthM: runLength, levels: [{ ...NEW_AISLE_LEVEL }] }],
  };
}
