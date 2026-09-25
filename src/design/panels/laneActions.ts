/**
 * Authoring actions that *construct* an entity, as opposed to editing one that
 * already exists.
 *
 * These live here rather than inside a panel because the structure tree and the
 * inspector both offer them, and a designer should not get a different default lane
 * depending on which button they happened to press.
 *
 * Both actions select what they created. Creating something the user then has to go
 * and find is the most common way an editor feels broken.
 */
import { useCallback } from 'react';

import {
  MIN_AISLE_WIDTH_M,
  round,
  type Aisle,
  type LaneSide,
  type ObstacleKind,
  type RackType,
} from 'layout-core';

import { useDesignStore } from '../store/designStore';

/** Length of the run a lane may occupy: the distance between the aisle's two ends. */
export function aisleRunLengthM(aisle: Aisle): number {
  return Math.hypot(
    aisle.centerline.x2 - aisle.centerline.x1,
    aisle.centerline.z2 - aisle.centerline.z1,
  );
}

export function useAddLane(): (aisle: Aisle, side: LaneSide) => void {
  const dispatch = useDesignStore((state) => state.dispatch);
  const select = useDesignStore((state) => state.select);
  const rackTypes = useDesignStore((state) => state.history.doc.rackTypes);

  return useCallback(
    (aisle: Aisle, side: LaneSide) => {
      const sibling = aisle.lanes.find((lane) => lane.side === side) ?? aisle.lanes[0];
      const rackTypeId = sibling?.rackTypeId ?? rackTypes[0]?.id;
      // A lane without a rack type is not a lane. The document reports that as
      // LANE_UNKNOWN_RACK_TYPE, but there is no reason to author one deliberately.
      if (!rackTypeId) return;

      const existingIds = new Set(aisle.lanes.map((lane) => lane.id));

      // `code` and `id` are deliberately omitted: `makeLane` derives the code from
      // the aisle and the new id from the command context, so the numbering rule
      // lives in one place.
      const outcome = dispatch({
        type: 'lane.add',
        aisleId: aisle.id,
        lane: {
          side,
          rackTypeId,
          lengthM: aisleRunLengthM(aisle),
          // Clone a sibling's levels so a new lane starts with the same stack as the
          // rest of the aisle. `makeLane` falls back to one default level.
          levels: sibling?.levels.map((level) => ({ ...level })),
        },
      });

      if (!outcome.ok) return;

      const added = outcome.doc.aisles
        .find((candidate) => candidate.id === aisle.id)
        ?.lanes.find((lane) => !existingIds.has(lane.id));

      if (added) select({ kind: 'lane', id: added.id, label: added.code });
    },
    [dispatch, rackTypes, select],
  );
}

/**
 * Width a cross-aisle should be by default: at least one bay, so it removes whole
 * bays, and never narrower than a forklift needs.
 */
export function defaultCrossAisleWidthM(aisle: Aisle, rackTypes: readonly RackType[]): number {
  const byId = new Map(rackTypes.map((rackType) => [rackType.id, rackType]));
  const bayWidthM = aisle.lanes
    .map((lane) => byId.get(lane.rackTypeId)?.bayWidthM)
    .find((width): width is number => typeof width === 'number');

  return Math.max(bayWidthM ?? MIN_AISLE_WIDTH_M, MIN_AISLE_WIDTH_M);
}

/**
 * Cut a cross-aisle through every lane of `aisleIds`, at `positionRatio` along each
 * aisle (0.5 is the middle).
 *
 * One command for the whole route, so the racks on both sides, the diagnostics and the
 * undo stack all move together.
 */
export function useAddCrossAisle(): (
  aisleIds: string[],
  positionRatio: number,
  widthM: number,
) => boolean {
  const dispatch = useDesignStore((state) => state.dispatch);

  return useCallback(
    (aisleIds, positionRatio, widthM) => {
      if (aisleIds.length === 0) return false;
      return dispatch({
        type: 'crossAisle.add',
        aisleIds,
        positionRatio: round(positionRatio, 4),
        widthM: round(widthM, 3),
      }).ok;
    },
    [dispatch],
  );
}

export function useAddObstacle(): (kind: ObstacleKind) => void {  const dispatch = useDesignStore((state) => state.dispatch);
  const select = useDesignStore((state) => state.select);
  const warehouse = useDesignStore((state) => state.history.doc.warehouse);
  const obstacles = useDesignStore((state) => state.history.doc.obstacles);

  return useCallback(
    (kind: ObstacleKind) => {
      const size = kind === 'WALL' ? { widthM: 4, depthM: 0.3 } : { widthM: 1, depthM: 1 };
      const existingIds = new Set(obstacles.map((obstacle) => obstacle.id));

      const outcome = dispatch({
        type: 'obstacle.add',
        obstacle: {
          kind,
          // Centred on the footprint. Placing it in genuinely free space would mean
          // re-deriving collisions here, and the inspector is where it gets
          // positioned precisely anyway.
          x: round(warehouse.origin.x + warehouse.lengthM / 2 - size.widthM / 2, 3),
          z: round(warehouse.origin.z + warehouse.widthM / 2 - size.depthM / 2, 3),
          ...size,
          heightM: Math.min(6, warehouse.heightM),
        },
      });

      if (!outcome.ok) return;

      const added = outcome.doc.obstacles.find((obstacle) => !existingIds.has(obstacle.id));
      if (added) select({ kind: 'obstacle', id: added.id, label: added.kind });
    },
    [dispatch, obstacles, select, warehouse],
  );
}
