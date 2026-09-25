/**
 * Editable top-down plan of the warehouse.
 *
 * The 3D view is the wrong instrument for laying out a floor: perspective hides
 * whether two racks share a centreline, and it is easy to orbit past an overlap
 * without noticing. This is the same derived geometry drawn orthographically, in
 * metres, where a gap is visible as a gap — and unlike the mini-map it can be edited
 * in place.
 *
 * Everything it draws comes from the compiler's output, and everything it changes goes
 * through a command, so it cannot drift from the 3D view, the inspector or the
 * diagnostics. Dragging is a local preview committed as one command on pointer-up,
 * for the same reason the 3D gizmos work that way: a history entry per frame would
 * make undo crawl back one pixel at a time.
 */
import { useMemo, useRef, useState } from 'react';

import { snap, type Aisle, type Lane } from 'layout-core';

import { makeAisleInput } from '../placement';
import { designState, useDesignStore } from '../store/designStore';
import { COLORS } from '../theme';
import { defaultCrossAisleWidthM, useAddCrossAisle } from '../panels/laneActions';
import { laneStatsOf, useLaneStats } from '../panels/laneStats';
import { rackRuns, type RackRun } from '../scene/rackRuns';
import {
  aisleAt,
  corridorRect,
  ratioAlongAisle,
  type PlanPoint,
} from './planGeometry';

/** Local preview of a drag; committed as one command when the pointer is released. */
type DragState = {
  kind: 'aisle' | 'obstacle';
  id: string;
  start: PlanPoint;
  delta: PlanPoint;
  moved: boolean;
};

/** Convert a pointer event to plan coordinates (metres), using the SVG's own matrix. */
function planPointOf(svg: SVGSVGElement, event: { clientX: number; clientY: number }): PlanPoint {
  const matrix = svg.getScreenCTM();
  if (!matrix) return { x: 0, z: 0 };
  const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
  return { x: point.x, z: point.y };
}

export function PlanEditor() {
  const warehouse = useDesignStore((state) => state.history.doc.warehouse);
  const aisles = useDesignStore((state) => state.history.doc.aisles);
  const obstacles = useDesignStore((state) => state.history.doc.obstacles);
  const rackTypes = useDesignStore((state) => state.history.doc.rackTypes);
  const bays = useDesignStore((state) => state.graph.bays);
  const selection = useDesignStore((state) => state.selection);
  const tool = useDesignStore((state) => state.tool);
  const snapM = useDesignStore((state) => state.snapM);
  const dispatch = useDesignStore((state) => state.dispatch);
  const select = useDesignStore((state) => state.select);
  const setTool = useDesignStore((state) => state.setTool);
  const addCrossAisle = useAddCrossAisle();
  const stats = useLaneStats();

  const svgRef = useRef<SVGSVGElement>(null);
  const [crossAisleArmed, setCrossAisleArmed] = useState(false);
  const [allAisles, setAllAisles] = useState(true);
  const [crossWidthM, setCrossWidthM] = useState(() =>
    aisles[0] ? defaultCrossAisleWidthM(aisles[0], rackTypes) : 2.7,
  );
  const [drag, setDrag] = useState<DragState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  /** Store tool and the plan's own cross-aisle mode are one mode between them. */
  const mode = crossAisleArmed ? 'CROSS_AISLE' : tool === 'ADD_AISLE' ? 'ADD_AISLE' : 'SELECT';

  const laneIndex = useMemo(() => {
    const map = new Map<string, { aisle: Aisle; lane: Lane }>();
    for (const aisle of aisles) {
      for (const lane of aisle.lanes) map.set(lane.code, { aisle, lane });
    }
    return map;
  }, [aisles]);

  /**
   * Racks are one rectangle per *contiguous run*, so a cross-aisle shows as a break
   * rather than being drawn over. Grouped by aisle so dragging an aisle previews its
   * whole racking, not just the corridor slab.
   */
  const runsByAisle = useMemo(() => {
    const map = new Map<string, { run: RackRun; lane: Lane }[]>();
    const visible = bays.filter((bay) => bay.inRackRun && !bay.isSkipped);

    for (const run of rackRuns(visible)) {
      const entry = laneIndex.get(run.laneCode);
      if (!entry) continue;
      const list = map.get(entry.aisle.id);
      if (list) list.push({ run, lane: entry.lane });
      else map.set(entry.aisle.id, [{ run, lane: entry.lane }]);
    }
    return map;
  }, [bays, laneIndex]);

  const selectedAisleIds = useMemo(
    () => new Set(selection.filter((ref) => ref.kind === 'aisle').map((ref) => ref.id)),
    [selection],
  );
  const selectedLaneIds = useMemo(
    () => new Set(selection.filter((ref) => ref.kind === 'lane').map((ref) => ref.id)),
    [selection],
  );
  const selectedObstacleIds = useMemo(
    () => new Set(selection.filter((ref) => ref.kind === 'obstacle').map((ref) => ref.id)),
    [selection],
  );

  const beginDrag = (
    kind: DragState['kind'],
    id: string,
    point: PlanPoint,
    pick: () => void,
    capture: (pointerId: number) => void,
    pointerId: number,
  ) => {
    capture(pointerId);
    pick();
    setDrag({ kind, id, start: point, delta: { x: 0, z: 0 }, moved: false });
    setNotice(null);
  };

  const moveDrag = (point: PlanPoint) => {
    if (!drag) return;
    const delta = { x: snap(point.x - drag.start.x, snapM), z: snap(point.z - drag.start.z, snapM) };
    if (delta.x === drag.delta.x && delta.z === drag.delta.z) return;
    setDrag({ ...drag, delta, moved: true });
  };

  const endDrag = () => {
    if (!drag) return;

    if (drag.moved) {
      if (drag.kind === 'aisle') {
        dispatch({
          type: 'aisle.translate',
          aisleId: drag.id,
          deltaX: drag.delta.x,
          deltaZ: drag.delta.z,
        });
      } else {
        const obstacle = obstacles.find((candidate) => candidate.id === drag.id);
        if (obstacle) {
          dispatch({
            type: 'obstacle.update',
            obstacleId: drag.id,
            patch: { x: obstacle.x + drag.delta.x, z: obstacle.z + drag.delta.z },
          });
        }
      }
    }

    setDrag(null);
  };

  /**
   * Tool clicks are handled on the `<svg>` itself rather than on the floor rectangle.
   * A rectangle only receives the events that land on it, so a click on an aisle would
   * never reach a floor-level handler — which is exactly the click a cross-aisle needs.
   * In SELECT mode the child shapes stop propagation, so this only clears the selection
   * when the click really did miss everything.
   */
  const onSvgPointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg) return;
    const point = planPointOf(svg, event);

    if (mode === 'ADD_AISLE') {
      const rackType = rackTypes[0];
      if (!rackType) {
        setNotice('Add a rack type first — a lane without one is not a lane.');
        return;
      }
      const outcome = dispatch({
        type: 'aisle.add',
        aisle: makeAisleInput(
          { x: snap(point.x, snapM), z: snap(point.z, snapM) },
          warehouse,
          rackType.id,
        ),
      });
      if (!outcome.ok) {
        setNotice(outcome.reason ?? 'Could not place the aisle.');
        return;
      }
      const created = designState().history.doc.aisles.at(-1);
      if (created) select({ kind: 'aisle', id: created.id, label: created.code });
      setTool('SELECT');
      setNotice(null);
      return;
    }

    if (mode === 'CROSS_AISLE') {
      const target = aisleAt(aisles, point);
      if (!target) {
        setNotice('Place an aisle first — a cross-aisle divides racking that exists.');
        return;
      }
      const ok = addCrossAisle(
        allAisles ? aisles.map((aisle) => aisle.id) : [target.id],
        ratioAlongAisle(target, point),
        crossWidthM,
      );
      setNotice(
        ok
          ? null
          : 'That position does not cut a whole bay. Aim at the middle of the racking.',
      );
      return;
    }

    select(null);
  };

  const { origin, lengthM, widthM } = warehouse;
  const pad = 2;
  const viewBox = `${origin.x - pad} ${origin.z - pad} ${lengthM + pad * 2} ${widthM + pad * 2}`;

  const cursorClass =
    mode === 'ADD_AISLE' ? 'plan-cursor-add' : mode === 'CROSS_AISLE' ? 'plan-cursor-cut' : '';

  return (
    <div className={`plan-editor${cursorClass ? ` ${cursorClass}` : ''}`}>
      <div className="plan-toolbar">
        <span className="topbar-group-label">Plan</span>
        <button
          className={`button${mode === 'SELECT' ? ' button-active' : ''}`}
          onClick={() => {
            setCrossAisleArmed(false);
            setTool('SELECT');
          }}
        >
          Select
        </button>
        <button
          className={`button${mode === 'ADD_AISLE' ? ' button-active' : ''}`}
          onClick={() => {
            setCrossAisleArmed(false);
            setTool('ADD_AISLE');
          }}
        >
          + Aisle
        </button>
        <button
          className={`button${crossAisleArmed ? ' button-active' : ''}`}
          title="Click the plan to cut a walking route across the racking"
          onClick={() => {
            setCrossAisleArmed((value) => !value);
            setTool('SELECT');
          }}
        >
          ⤬ Cross-aisle
        </button>

        {crossAisleArmed && (
          <>
            <label className="plan-inline">
              Route
              <input
                type="number"
                className="plan-number"
                min={0.5}
                step={0.1}
                value={crossWidthM}
                onChange={(event) => setCrossWidthM(Number(event.target.value))}
              />
              m
            </label>
            <label className="plan-inline">
              <input
                type="checkbox"
                checked={allAisles}
                onChange={(event) => setAllAisles(event.target.checked)}
              />
              All aisles
            </label>
            <span className="plan-hint">Snaps to whole bays</span>
          </>
        )}

        <span className="topbar-spacer" />
        <span className="plan-hint">
          Drag an aisle or a column to move it · click a rack for its lane
        </span>
      </div>

      {notice && <div className="plan-notice">{notice}</div>}

      <svg
        ref={svgRef}
        className="plan-svg"
        viewBox={viewBox}
        preserveAspectRatio="xMidYMid meet"
        role="application"
        aria-label="Editable plan of the warehouse"
        onPointerDown={onSvgPointerDown}
      >
        <defs>
          <pattern id="plan-grid" width="1" height="1" patternUnits="userSpaceOnUse">
            <path d="M 1 0 L 0 0 0 1" fill="none" stroke="rgba(148,163,184,0.12)" strokeWidth="0.02" />
          </pattern>
          <pattern id="plan-grid-5" width="5" height="5" patternUnits="userSpaceOnUse">
            <path d="M 5 0 L 0 0 0 5" fill="none" stroke="rgba(148,163,184,0.22)" strokeWidth="0.04" />
          </pattern>
        </defs>

        {/* The floor is painted, not listened to: tool clicks belong to the `<svg>`. */}
        <rect
          x={origin.x}
          y={origin.z}
          width={lengthM}
          height={widthM}
          fill="#0b1220"
          stroke="rgba(148,163,184,0.45)"
          strokeWidth="0.08"
          pointerEvents="none"
        />
        <rect x={origin.x} y={origin.z} width={lengthM} height={widthM} fill="url(#plan-grid)" />
        <rect x={origin.x} y={origin.z} width={lengthM} height={widthM} fill="url(#plan-grid-5)" />

        {/* Aisles: racking first, then the corridor slab drawn over it so the walking
            route reads on top. */}
        {aisles.map((aisle) => {
          const aisleDrag = drag?.kind === 'aisle' && drag.id === aisle.id ? drag : null;
          const corridor = corridorRect(aisle);
          const isSelected = selectedAisleIds.has(aisle.id);

          return (
            <g
              key={aisle.id}
              transform={
                aisleDrag
                  ? `translate(${aisleDrag.delta.x} ${aisleDrag.delta.z})`
                  : undefined
              }
            >
              {(runsByAisle.get(aisle.id) ?? []).map(({ run, lane }) => {
                const alongX = run.rotationDeg === 0;
                const runWidth = alongX ? run.widthM : run.depthM;
                const runHeight = alongX ? run.depthM : run.widthM;
                const laneStats = laneStatsOf(stats, lane.code);
                const laneSelected = selectedLaneIds.has(lane.id);

                return (
                  <g key={run.key}>
                    <rect
                      className="plan-pick"
                      x={run.center.x - runWidth / 2}
                      y={run.center.z - runHeight / 2}
                      width={runWidth}
                      height={runHeight}
                      fill={laneSelected ? COLORS.aisleSelected : 'rgba(96,165,250,0.30)'}
                      stroke={laneSelected ? COLORS.aisleSelected : 'rgba(96,165,250,0.55)'}
                      strokeWidth="0.03"
                      onPointerDown={(event) => {
                        if (mode !== 'SELECT' || !svgRef.current) return;
                        // Keep this off the svg's tool handler, which would clear the
                        // selection we are about to make.
                        event.stopPropagation();
                        beginDrag(
                          'aisle',
                          aisle.id,
                          planPointOf(svgRef.current, event),
                          () =>
                            select({
                              kind: 'lane',
                              id: lane.id,
                              label: `${aisle.code} / ${lane.code}`,
                            }),
                          (pointerId) => event.currentTarget.setPointerCapture(pointerId),
                          event.pointerId,
                        );
                      }}
                      onPointerMove={(event) => {
                        if (svgRef.current) moveDrag(planPointOf(svgRef.current, event));
                      }}
                      onPointerUp={endDrag}
                      onPointerCancel={endDrag}
                    >
                      <title>
                        {`${run.laneCode} — this run: ${run.bayCount} bay${run.bayCount === 1 ? '' : 's'} × ${lane.levels.length} level${lane.levels.length === 1 ? '' : 's'} = ${run.bayCount * lane.levels.length} bins; lane total ${laneStats.bins}`}
                      </title>
                    </rect>

                    {runWidth >= 6 && (
                      <text
                        className="plan-label"
                        x={run.center.x}
                        y={run.center.z + 0.35}
                        textAnchor="middle"
                      >
                        {`${lane.code} ×${lane.levels.length}L`}
                      </text>
                    )}
                  </g>
                );
              })}

              <rect
                className="plan-pick"
                x={corridor.x}
                y={corridor.z}
                width={corridor.width}
                height={corridor.height}
                fill={isSelected ? 'rgba(251,191,36,0.20)' : 'rgba(148,163,184,0.10)'}
                stroke={isSelected ? COLORS.aisleSelected : 'rgba(148,163,184,0.40)'}
                strokeWidth="0.06"
                strokeDasharray={aisle.lanes.length === 0 ? '0.5 0.35' : undefined}
                onPointerDown={(event) => {
                  if (mode !== 'SELECT' || !svgRef.current) return;
                  event.stopPropagation();
                  beginDrag(
                    'aisle',
                    aisle.id,
                    planPointOf(svgRef.current, event),
                    () => select({ kind: 'aisle', id: aisle.id, label: aisle.code }),
                    (pointerId) => event.currentTarget.setPointerCapture(pointerId),
                    event.pointerId,
                  );
                }}
                onPointerMove={(event) => {
                  if (svgRef.current) moveDrag(planPointOf(svgRef.current, event));
                }}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
              >
                <title>{`Aisle ${aisle.code} — ${aisle.widthM} m corridor, ${aisle.lanes.length} lane(s)`}</title>
              </rect>

              <text
                className="plan-label plan-label-aisle"
                x={corridor.x + corridor.width / 2}
                y={corridor.z + corridor.height / 2 + 0.3}
                textAnchor="middle"
              >
                {aisle.code}
              </text>
            </g>
          );
        })}

        {/* Obstacles last: they explain why a bay is blocked, so they read on top. */}
        {obstacles.map((obstacle) => {
          const obstacleDrag =
            drag?.kind === 'obstacle' && drag.id === obstacle.id ? drag : null;
          const isSelected = selectedObstacleIds.has(obstacle.id);

          return (
            <rect
              key={obstacle.id}
              className="plan-pick"
              x={obstacle.x + (obstacleDrag?.delta.x ?? 0)}
              y={obstacle.z + (obstacleDrag?.delta.z ?? 0)}
              width={obstacle.widthM}
              height={obstacle.depthM}
              fill={isSelected ? 'rgba(251,191,36,0.5)' : 'rgba(248,113,113,0.45)'}
              stroke={isSelected ? COLORS.aisleSelected : 'rgba(248,113,113,0.85)'}
              strokeWidth="0.05"
              onPointerDown={(event) => {
                if (mode !== 'SELECT' || !svgRef.current) return;
                event.stopPropagation();
                beginDrag(
                  'obstacle',
                  obstacle.id,
                  planPointOf(svgRef.current, event),
                  () => select({ kind: 'obstacle', id: obstacle.id, label: obstacle.kind }),
                  (pointerId) => event.currentTarget.setPointerCapture(pointerId),
                  event.pointerId,
                );
              }}
              onPointerMove={(event) => {
                if (svgRef.current) moveDrag(planPointOf(svgRef.current, event));
              }}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
            >
              <title>{`${obstacle.kind} — ${obstacle.widthM} × ${obstacle.depthM} m`}</title>
            </rect>
          );
        })}

        {/* Scale bar, because the grid is unlabelled. */}
        <g transform={`translate(${origin.x + 0.5}, ${origin.z + widthM + 0.8})`}>
          <line x1="0" y1="0" x2="5" y2="0" stroke="rgba(148,163,184,0.8)" strokeWidth="0.06" />
          <line x1="0" y1="-0.16" x2="0" y2="0.16" stroke="rgba(148,163,184,0.8)" strokeWidth="0.06" />
          <line x1="5" y1="-0.16" x2="5" y2="0.16" stroke="rgba(148,163,184,0.8)" strokeWidth="0.06" />
          <text x="5.3" y="0.25" className="plan-label" fontSize="0.9">
            5 m
          </text>
        </g>
      </svg>
    </div>
  );
}
