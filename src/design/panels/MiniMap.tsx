/**
 * Top-down plan view, rendered as SVG rather than a second WebGL canvas.
 *
 * The 3D camera is a poor instrument for checking an alignment: perspective hides
 * whether two racks share a centreline, and it is easy to orbit past an overlap
 * without noticing. This draws the same derived geometry orthographically, in metres,
 * where a gap is visible as a gap.
 *
 * SVG also keeps the cost honest — no second WebGL context, no extra render loop, and
 * text stays crisp at any zoom.
 *
 * Everything drawn here comes from the compiler's output, so the plan cannot drift
 * from the 3D view or from the diagnostics.
 */
import { useMemo, useState } from 'react';

import type { Aisle } from 'layout-core';

import { useDesignStore } from '../store/designStore';
import { COLORS } from '../theme';

type Rect = { x: number; z: number; width: number; height: number };

/** Corridor footprint of an aisle, in plan coordinates. */
function corridorRect(aisle: Aisle): Rect {
  const { x1, z1, x2, z2 } = aisle.centerline;
  const half = aisle.widthM / 2;
  const alongX = Math.abs(x2 - x1) >= Math.abs(z2 - z1);

  if (alongX) {
    return { x: Math.min(x1, x2), z: z1 - half, width: Math.abs(x2 - x1), height: aisle.widthM };
  }
  return { x: x1 - half, z: Math.min(z1, z2), width: aisle.widthM, height: Math.abs(z2 - z1) };
}

export function MiniMap() {
  const warehouse = useDesignStore((state) => state.history.doc.warehouse);
  const aisles = useDesignStore((state) => state.history.doc.aisles);
  const obstacles = useDesignStore((state) => state.history.doc.obstacles);
  const bays = useDesignStore((state) => state.graph.bays);
  const selection = useDesignStore((state) => state.selection);
  const select = useDesignStore((state) => state.select);

  const [open, setOpen] = useState(true);

  // A lane code is unique across the document because it embeds the aisle code, so
  // this maps plan rectangles back to the entity a click should select.
  const laneIdByCode = useMemo(() => {
    const map = new Map<string, { aisleId: string; laneId: string; label: string }>();
    for (const aisle of aisles) {
      for (const lane of aisle.lanes) {
        map.set(lane.code, { aisleId: aisle.id, laneId: lane.id, label: `${aisle.code} / ${lane.code}` });
      }
    }
    return map;
  }, [aisles]);

  // Only bays that actually produce bins are drawn as racks. Gap and skipped bays are
  // omitted on purpose: this is a picture of the racking, not of the bay numbering.
  const racks = useMemo(
    () => bays.filter((bay) => bay.inRackRun && !bay.isSkipped),
    [bays],
  );

  const selectedAisleIds = useMemo(
    () => new Set(selection.filter((ref) => ref.kind === 'aisle').map((ref) => ref.id)),
    [selection],
  );
  const selectedLaneIds = useMemo(
    () => new Set(selection.filter((ref) => ref.kind === 'lane').map((ref) => ref.id)),
    [selection],
  );

  const { origin, lengthM, widthM } = warehouse;
  const pad = 1;
  const viewBox = `${origin.x - pad} ${origin.z - pad} ${lengthM + pad * 2} ${widthM + pad * 2}`;

  return (
    <div className="minimap">
      <button className="minimap-head" onClick={() => setOpen((value) => !value)}>
        <span>Plan view</span>
        <span>{open ? '–' : '+'}</span>
      </button>

      {open && (
        <>
          <svg
            className="minimap-svg"
            viewBox={viewBox}
            preserveAspectRatio="xMidYMid meet"
            role="img"
            aria-label="Top-down plan of the warehouse"
          >
            <defs>
              <pattern id="minimap-grid" width="5" height="5" patternUnits="userSpaceOnUse">
                <path d="M 5 0 L 0 0 0 5" fill="none" stroke="rgba(148,163,184,0.16)" strokeWidth="0.06" />
              </pattern>
            </defs>

            {/* Floor and grid. */}
            <rect
              x={origin.x}
              y={origin.z}
              width={lengthM}
              height={widthM}
              fill="#0b1220"
              stroke="rgba(148,163,184,0.45)"
              strokeWidth="0.12"
            />
            <rect x={origin.x} y={origin.z} width={lengthM} height={widthM} fill="url(#minimap-grid)" />

            {/* Racks, from the derived bays. */}
            {racks.map((bay) => {
              const alongX = bay.rotationDeg === 0;
              const width = alongX ? bay.widthM : bay.depthM;
              const height = alongX ? bay.depthM : bay.widthM;
              const lane = laneIdByCode.get(bay.laneCode);
              const isSelected = lane ? selectedLaneIds.has(lane.laneId) : false;

              return (
                <rect
                  key={`${bay.laneCode}:${bay.seq}`}
                  x={bay.center.x - width / 2}
                  y={bay.center.z - height / 2}
                  width={width}
                  height={height}
                  fill={isSelected ? COLORS.aisleSelected : 'rgba(96,165,250,0.30)'}
                  stroke={isSelected ? COLORS.aisleSelected : 'rgba(96,165,250,0.55)'}
                  strokeWidth="0.04"
                  className={lane ? 'minimap-clickable' : undefined}
                  onClick={() => lane && select({ kind: 'lane', id: lane.laneId, label: lane.label })}
                >
                  <title>{`${bay.laneCode} bay ${bay.seq}`}</title>
                </rect>
              );
            })}

            {/* Corridors, drawn over the racks so they read as the walking route. */}
            {aisles.map((aisle) => {
              const rect = corridorRect(aisle);
              const isSelected = selectedAisleIds.has(aisle.id);
              return (
                <rect
                  key={aisle.id}
                  x={rect.x}
                  y={rect.z}
                  width={rect.width}
                  height={rect.height}
                  fill={isSelected ? 'rgba(251,191,36,0.22)' : 'rgba(148,163,184,0.10)'}
                  stroke={isSelected ? COLORS.aisleSelected : 'rgba(148,163,184,0.40)'}
                  strokeWidth="0.08"
                  className="minimap-clickable"
                  onClick={() => select({ kind: 'aisle', id: aisle.id, label: aisle.code })}
                >
                  <title>{`Aisle ${aisle.code} — ${aisle.widthM} m corridor`}</title>
                </rect>
              );
            })}

            {/* Obstacles last: they explain why a bay is blocked, so they read on top. */}
            {obstacles.map((obstacle) => (
              <rect
                key={obstacle.id}
                x={obstacle.x}
                y={obstacle.z}
                width={obstacle.widthM}
                height={obstacle.depthM}
                fill="rgba(248,113,113,0.45)"
                stroke="rgba(248,113,113,0.85)"
                strokeWidth="0.06"
                className="minimap-clickable"
                onClick={() =>
                  select({ kind: 'obstacle', id: obstacle.id, label: obstacle.kind })
                }
              >
                <title>{`${obstacle.kind} ${obstacle.widthM} × ${obstacle.depthM} m`}</title>
              </rect>
            ))}

            {/* A scale bar, because the grid is unlabelled. */}
            <g transform={`translate(${origin.x + 0.5}, ${origin.z + widthM + 0.55})`}>
              <line x1="0" y1="0" x2="5" y2="0" stroke="rgba(148,163,184,0.8)" strokeWidth="0.08" />
              <line x1="0" y1="-0.14" x2="0" y2="0.14" stroke="rgba(148,163,184,0.8)" strokeWidth="0.08" />
              <line x1="5" y1="-0.14" x2="5" y2="0.14" stroke="rgba(148,163,184,0.8)" strokeWidth="0.08" />
              <text x="5.3" y="0.18" fill="rgba(148,163,184,0.9)" fontSize="0.85">
                5 m
              </text>
            </g>
          </svg>

          <div className="minimap-foot">
            {aisles.length} aisle{aisles.length === 1 ? '' : 's'} · {racks.length} rack bays ·{' '}
            {obstacles.length} obstacle{obstacles.length === 1 ? '' : 's'}
          </div>
        </>
      )}
    </div>
  );
}
