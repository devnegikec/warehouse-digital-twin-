/**
 * Bay grid: reserve individual bays without changing the rack runs.
 *
 * Runs and skipped bays answer different questions. A GAP is a physical hole in the
 * racking — there is no steel there. A skipped bay is a bay that exists but is out of
 * service: damaged, reserved, or blocked by something temporary. They are kept apart
 * for that reason, and this grid is the only place skips are edited.
 *
 * A bay inside a GAP run already produces nothing, so skipping it would be
 * meaningless; those chips are shown but disabled, so the grid still reads as a
 * continuous plan view of the lane.
 */
import type { Lane } from 'layout-core';

import { useDesignStore } from '../store/designStore';
import type { LaneStats } from './laneStats';

export function SkipBaysEditor({ lane, stats }: { lane: Lane; stats: LaneStats }) {
  const dispatch = useDesignStore((state) => state.dispatch);

  if (stats.bays.length === 0) {
    return (
      <div className="empty-hint">
        This lane is shorter than one bay, so it has no bays to reserve.
      </div>
    );
  }

  return (
    <>
      <div className="bay-grid">
        {stats.bays.map((bay) => {
          const inGap = !bay.inRackRun;
          const state = inGap ? 'gap' : bay.isSkipped ? 'skipped' : 'rack';
          const title = inGap
            ? `Bay ${bay.seq} sits in a gap run, so it produces nothing already`
            : bay.isSkipped
              ? `Bay ${bay.seq} is reserved — click to put it back in service`
              : `Bay ${bay.seq} is in service — click to reserve it`;

          return (
            <button
              key={bay.seq}
              className={`bay-chip bay-chip-${state}`}
              title={title}
              aria-pressed={bay.isSkipped}
              disabled={inGap}
              onClick={() =>
                dispatch({ type: 'lane.toggleSkipBay', laneId: lane.id, baySeq: bay.seq })
              }
            >
              {bay.seq}
            </button>
          );
        })}
      </div>

      <div className="bay-legend">
        <span className="bay-legend-item">
          <i className="bay-chip bay-chip-rack" /> in service
        </span>
        <span className="bay-legend-item">
          <i className="bay-chip bay-chip-skipped" /> reserved
        </span>
        <span className="bay-legend-item">
          <i className="bay-chip bay-chip-gap" /> gap
        </span>
      </div>

      {stats.skipped > 0 && (
        <button
          className="button"
          style={{ width: '100%', marginTop: 6 }}
          onClick={() =>
            dispatch({ type: 'lane.update', laneId: lane.id, patch: { skipBays: [] } })
          }
        >
          Return all {stats.skipped} reserved bay{stats.skipped === 1 ? '' : 's'} to service
        </button>
      )}
    </>
  );
}
