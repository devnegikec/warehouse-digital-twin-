/**
 * Navigable outline of the document: warehouse → aisles → lanes, plus obstacles.
 *
 * Why this exists at all: the 3D canvas can only select what has a mesh. Lanes have
 * no mesh of their own — a lane *is* its rack run — so before this panel the lane
 * editor was unreachable, and every lane setting (levels, runs, skips, side, rack
 * type) was authorable in the schema but not in the editor. The tree is the fix, and
 * it doubles as the aisle list.
 *
 * Deleting is deliberately not confirmed. Every mutation goes through the command
 * history, so a misclick is one undo away — a modal would cost more than it saves.
 */
import type { Aisle, Lane, LayoutDoc } from 'layout-core';

import { useDesignStore } from '../store/designStore';
import { defaultCrossAisleWidthM, useAddCrossAisle, useAddLane, useAddObstacle } from './laneActions';
import { laneStatsOf, useLaneStats, type LaneStats } from './laneStats';

function TreeRow({
  depth,
  selected,
  label,
  meta,
  onSelect,
  title,
  children,
}: {
  depth: number;
  selected: boolean;
  label: string;
  meta?: string;
  onSelect: () => void;
  title?: string;
  children?: React.ReactNode;
}) {
  return (
    <div
      className={`tree-row${selected ? ' tree-row-selected' : ''}`}
      style={{ paddingLeft: 8 + depth * 14 }}
    >
      <button className="tree-pick" title={title ?? label} onClick={onSelect}>
        <span className="tree-label">{label}</span>
        {meta && <span className="tree-meta">{meta}</span>}
      </button>
      <span className="tree-actions">{children}</span>
    </div>
  );
}

function LaneRow({ aisle, lane, depth }: { aisle: Aisle; lane: Lane; depth: number }) {
  const selection = useDesignStore((state) => state.selection);
  const dispatch = useDesignStore((state) => state.dispatch);
  const select = useDesignStore((state) => state.select);
  const stats = useLaneStats();
  const laneStats = laneStatsOf(stats, lane.code);

  const selected = selection.some((ref) => ref.kind === 'lane' && ref.id === lane.id);

  return (
    <TreeRow
      depth={depth}
      selected={selected}
      label={lane.code}
      meta={`${lane.side === 'LEFT' ? 'L' : 'R'} · ${laneStats.bins} bins`}
      title={`Lane ${lane.code} — ${lane.levels.length} levels, ${laneStats.activeBays}/${laneStats.bays.length} bays in service`}
      onSelect={() => select({ kind: 'lane', id: lane.id, label: `${aisle.code} / ${lane.code}` })}
    >
      <button
        className="icon-button"
        title="Delete this lane"
        onClick={() => dispatch({ type: 'lane.remove', laneId: lane.id })}
      >
        ×
      </button>
    </TreeRow>
  );
}

function AisleBlock({ aisle }: { aisle: Aisle }) {
  const selection = useDesignStore((state) => state.selection);
  const dispatch = useDesignStore((state) => state.dispatch);
  const select = useDesignStore((state) => state.select);
  const rackTypes = useDesignStore((state) => state.history.doc.rackTypes);
  const addLane = useAddLane();
  const addCrossAisle = useAddCrossAisle();
  const stats = useLaneStats();

  const selected = selection.some((ref) => ref.kind === 'aisle' && ref.id === aisle.id);
  const bins = aisle.lanes.reduce((total, lane) => total + laneStatsOf(stats, lane.code).bins, 0);
  const hasLeft = aisle.lanes.some((lane) => lane.side === 'LEFT');
  const hasRight = aisle.lanes.some((lane) => lane.side === 'RIGHT');

  return (
    <div className="tree-group">
      <TreeRow
        depth={1}
        selected={selected}
        label={aisle.code}
        meta={`${aisle.lanes.length} lane${aisle.lanes.length === 1 ? '' : 's'} · ${bins} bins`}
        title={`Aisle ${aisle.code} — drag its corridor in the 3D view to move it`}
        onSelect={() => select({ kind: 'aisle', id: aisle.id, label: aisle.code })}
      >
        <button
          className="icon-button icon-button-text"
          title={hasLeft ? 'Add another lane on the left face' : 'Add a lane on the left face'}
          onClick={() => addLane(aisle, 'LEFT')}
        >
          +L
        </button>
        <button
          className="icon-button icon-button-text"
          title={hasRight ? 'Add another lane on the right face' : 'Add a lane on the right face'}
          onClick={() => addLane(aisle, 'RIGHT')}
        >
          +R
        </button>
        <button
          className="icon-button icon-button-text"
          title="Cut a cross-aisle through every lane of this aisle, at the middle"
          disabled={aisle.lanes.length === 0}
          onClick={() =>
            addCrossAisle([aisle.id], 0.5, defaultCrossAisleWidthM(aisle, rackTypes))
          }
        >
          ⤬
        </button>
        <button
          className="icon-button"
          title="Delete this aisle and its lanes"
          onClick={() => dispatch({ type: 'aisle.remove', aisleId: aisle.id })}
        >
          ×
        </button>
      </TreeRow>

      {aisle.lanes.length === 0 && (
        <div className="tree-empty" style={{ paddingLeft: 8 + 2 * 14 }}>
          No racks — add a lane on the left or right face.
        </div>
      )}

      {aisle.lanes.map((lane) => (
        <LaneRow key={lane.id} aisle={aisle} lane={lane} depth={2} />
      ))}
    </div>
  );
}

function ObstacleBlock({ doc }: { doc: LayoutDoc }) {
  const selection = useDesignStore((state) => state.selection);
  const dispatch = useDesignStore((state) => state.dispatch);
  const select = useDesignStore((state) => state.select);
  const addObstacle = useAddObstacle();

  return (
    <div className="tree-group">
      <div className="tree-head">
        <span>Obstacles</span>
        <span className="tree-actions">
          <button
            className="icon-button icon-button-text"
            title="Add a column at the centre of the floor, then position it in the inspector"
            onClick={() => addObstacle('COLUMN')}
          >
            + Add
          </button>
        </span>
      </div>

      {doc.obstacles.length === 0 && <div className="tree-empty">Nothing in the way.</div>}

      {doc.obstacles.map((obstacle) => (
        <TreeRow
          key={obstacle.id}
          depth={1}
          selected={selection.some((ref) => ref.kind === 'obstacle' && ref.id === obstacle.id)}
          label={obstacle.kind.toLowerCase()}
          meta={`${obstacle.widthM} × ${obstacle.depthM} m at ${obstacle.x}, ${obstacle.z}`}
          title={`${obstacle.kind} at ${obstacle.x}, ${obstacle.z}`}
          onSelect={() =>
            select({ kind: 'obstacle', id: obstacle.id, label: obstacle.kind })
          }
        >
          <button
            className="icon-button"
            title="Delete this obstacle"
            onClick={() => dispatch({ type: 'obstacle.remove', obstacleId: obstacle.id })}
          >
            ×
          </button>
        </TreeRow>
      ))}
    </div>
  );
}

export function StructurePanel() {
  const doc = useDesignStore((state) => state.history.doc);
  const setTool = useDesignStore((state) => state.setTool);

  const rackTypeCount = doc.rackTypes.length;

  return (
    <div className="section">
      <h3 className="section-title">
        Structure
        <span className="section-title-tag">
          {doc.aisles.length} aisle{doc.aisles.length === 1 ? '' : 's'}
        </span>
      </h3>

      {rackTypeCount === 0 && (
        <div className="field-message">
          A lane needs a rack type. Add one under <strong>Rack types</strong> below.
        </div>
      )}

      <div className="tree-group">
        <div className="tree-head">
          <span>Aisles</span>
          <span className="tree-actions">
            <button
              className="icon-button icon-button-text"
              title="Place an aisle by clicking the floor"
              onClick={() => setTool('ADD_AISLE')}
            >
              + Add
            </button>
          </span>
        </div>

        {doc.aisles.length === 0 && (
          <div className="tree-empty">No aisles yet — add one and click the floor.</div>
        )}

        {doc.aisles.map((aisle) => (
          <AisleBlock key={aisle.id} aisle={aisle} />
        ))}
      </div>

      <ObstacleBlock doc={doc} />
    </div>
  );
}
