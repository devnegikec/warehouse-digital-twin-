/**
 * Aisles: corridor slab (the drag handle) plus translucent rack volumes.
 *
 * Drag behaviour, and why it works the way it does:
 *
 *  - The pointer is projected onto the floor plane, so a drag maps to world XZ
 *    regardless of camera angle; `window` listeners keep it tracking once the
 *    pointer leaves the mesh.
 *  - The **resulting** position is snapped, not the delta. Snapping the delta would
 *    let an aisle drift off-grid and stay there.
 *  - The provisional position lives in component state and is committed as a single
 *    `aisle.translate` on pointer-up. Dispatching on every pointermove would push a
 *    history entry per frame, so undo would crawl back one pixel at a time.
 *  - OrbitControls is suspended for the duration, or the camera would orbit while
 *    the aisle moves.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useThree, type ThreeEvent } from '@react-three/fiber';
import { Html, useCursor } from '@react-three/drei';

import { laneStackHeightM, snap, type Aisle, type Centerline, type DerivedBay } from 'layout-core';

import { useDesignStore } from '../store/designStore';
import { COLORS } from '../theme';
import { rackRuns } from './rackRuns';
import { useClickNotDrag } from './useClickNotDrag';
import { useGroundProjector, type GroundPoint } from './useGroundProjector';

/** Axis-aligned footprint of an aisle, in the form a box mesh wants. */
function corridorBox(centerline: Centerline, widthM: number) {
  const spanX = Math.abs(centerline.x2 - centerline.x1);
  const spanZ = Math.abs(centerline.z2 - centerline.z1);
  const alongX = spanX >= spanZ;

  return {
    position: [
      (centerline.x1 + centerline.x2) / 2,
      0.05,
      (centerline.z1 + centerline.z2) / 2,
    ] as [number, number, number],
    size: [
      Math.max(alongX ? spanX : widthM, 0.1),
      0.1,
      Math.max(alongX ? widthM : spanZ, 0.1),
    ] as [number, number, number],
  };
}

type LaneRun = {
  key: string;
  /** The lane these bays belong to; lets a click on the rack select its lane. */
  laneCode: string;
  position: [number, number, number];
  size: [number, number, number];
};

/**
 * A live drag. The window listeners are created in the pointerdown handler and
 * removed by `finish`, rather than being attached by a `useEffect` keyed on a
 * `dragging` flag: that effect can run *after* the pointerup, which strands the
 * drag and leaves stale listeners that then commit phantom moves on every
 * subsequent pointer event.
 */
type ActiveDrag = {
  start: GroundPoint;
  origin: Centerline;
  provisional: Centerline;
  move: (event: PointerEvent) => void;
  up: () => void;
  cancel: () => void;
};

/**
 * Turns the compiler's bays into one box per *contiguous* run of bays, so a GAP
 * segment shows as a real break in the rack rather than being glossed over.
 *
 * Grouping comes from `rackRuns`, which is a single linear pass — this used to re-group
 * the bays once per lane, which is O(bays × lanes) and cannot survive the 100k target.
 * The transforms are derived from the graph rather than re-deriving rack offsets here, so
 * the 2D inspector and the 3D view cannot disagree about where a rack is.
 */
function runsByLane(bays: DerivedBay[], laneCodes: string[]): Map<string, LaneRun[]> {
  const result = new Map<string, LaneRun[]>();

  for (const run of rackRuns(bays, laneCodes)) {
    const alongX = run.rotationDeg === 0;
    const laneRuns = result.get(run.laneCode);
    const entry: LaneRun = {
      key: run.key,
      laneCode: run.laneCode,
      position: [run.center.x, 0, run.center.z],
      size: [alongX ? run.widthM : run.depthM, 0, alongX ? run.depthM : run.widthM],
    };

    if (laneRuns) laneRuns.push(entry);
    else result.set(run.laneCode, [entry]);
  }

  return result;
}

function AisleGizmo({
  aisle,
  isSelected,
  stackHeightM,
  runs,
}: {
  aisle: Aisle;
  isSelected: boolean;
  stackHeightM: number;
  runs: LaneRun[];
}) {
  const dispatch = useDesignStore((state) => state.dispatch);
  const select = useDesignStore((state) => state.select);
  const snapM = useDesignStore((state) => state.snapM);
  const tool = useDesignStore((state) => state.tool);
  const project = useGroundProjector();
  const controls = useThree((state) => state.controls) as { enabled: boolean } | null;

  const dragRef = useRef<ActiveDrag | null>(null);
  const [dragging, setDragging] = useState(false);
  const [provisional, setProvisional] = useState<Centerline | null>(null);
  const [hovered, setHovered] = useState(false);
  const [hoveredRun, setHoveredRun] = useState<string | null>(null);
  /** A click that ends a drag belongs to the drag, not to whatever it landed on. */
  const { onPointerDown: rememberDown, isClick } = useClickNotDrag();
  const selection = useDesignStore((state) => state.selection);

  useCursor(hovered && !dragging, 'grab');
  useCursor(hoveredRun !== null, 'pointer');

  // A drag must never outlive the component.
  useEffect(
    () => () => {
      const drag = dragRef.current;
      if (!drag) return;
      window.removeEventListener('pointermove', drag.move);
      window.removeEventListener('pointerup', drag.up);
      window.removeEventListener('pointercancel', drag.cancel);
    },
    [],
  );

  const beginDrag = (clientX: number, clientY: number) => {
    // Never stack drags: a second pointerdown while one is live is a no-op.
    if (dragRef.current) return;

    const ground = project(clientX, clientY);
    if (!ground) return;

    const origin = aisle.centerline;
    const active: ActiveDrag = {
      start: ground,
      origin,
      provisional: origin,
      move: () => {},
      up: () => {},
      cancel: () => {},
    };

    active.move = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const point = project(event.clientX, event.clientY);
      if (!point) return;

      const deltaX = point.x - drag.start.x;
      const deltaZ = point.z - drag.start.z;
      // Snap the resulting position, not the delta, so the aisle cannot drift
      // off-grid and stay there.
      const next: Centerline = {
        x1: snap(drag.origin.x1 + deltaX, snapM),
        z1: snap(drag.origin.z1 + deltaZ, snapM),
        x2: snap(drag.origin.x2 + deltaX, snapM),
        z2: snap(drag.origin.z2 + deltaZ, snapM),
      };
      drag.provisional = next;
      setProvisional(next);
    };

    const finish = (commit: boolean) => {
      const drag = dragRef.current;
      if (!drag) return;
      dragRef.current = null;

      window.removeEventListener('pointermove', drag.move);
      window.removeEventListener('pointerup', drag.up);
      window.removeEventListener('pointercancel', drag.cancel);
      if (controls) controls.enabled = true;

      setDragging(false);
      setProvisional(null);

      if (!commit) return;
      // One history entry per drag, not one per frame.
      const deltaX = drag.provisional.x1 - drag.origin.x1;
      const deltaZ = drag.provisional.z1 - drag.origin.z1;
      if (Math.abs(deltaX) > 1e-9 || Math.abs(deltaZ) > 1e-9) {
        dispatch({ type: 'aisle.translate', aisleId: aisle.id, deltaX, deltaZ });
      }
    };

    active.up = () => finish(true);
    active.cancel = () => finish(false);

    dragRef.current = active;
    window.addEventListener('pointermove', active.move);
    window.addEventListener('pointerup', active.up);
    window.addEventListener('pointercancel', active.cancel);
    if (controls) controls.enabled = false;

    setProvisional(origin);
    setDragging(true);
  };

  const centerline = provisional ?? aisle.centerline;
  const corridor = corridorBox(centerline, aisle.widthM);
  const highlighted = isSelected || hovered;

  const onGrab = (event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation();
    if (event.button !== 0) return;

    select({ kind: 'aisle', id: aisle.id, label: aisle.code });

    // With a placement tool active a click belongs to the ground handler.
    if (tool !== 'SELECT') return;
    beginDrag(event.clientX, event.clientY);
  };

  const onEnter = (event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation();
    setHovered(true);
  };

  const handleY = stackHeightM + 1.3;

  return (
    <group>
      <mesh position={corridor.position} onPointerDown={onGrab} onPointerOver={onEnter} onPointerOut={() => setHovered(false)}>
        <boxGeometry args={corridor.size} />
        <meshStandardMaterial
          color={isSelected ? COLORS.aisleSelected : COLORS.aisle}
          transparent
          opacity={highlighted ? 0.4 : 0.18}
          emissive={isSelected ? COLORS.aisleSelected : COLORS.aisle}
          emissiveIntensity={highlighted ? 0.35 : 0.05}
          roughness={0.5}
        />
      </mesh>

      {/*
       * Drag handle. The corridor slab is the natural thing to grab, but from an
       * elevated view the racks occlude it almost everywhere, which made moving an
       * aisle effectively impossible with the mouse. This handle floats above the
       * rack stack so it is always reachable, with a pole tying it to the aisle.
       */}
      <mesh position={[corridor.position[0], stackHeightM + 0.6, corridor.position[2]]} raycast={() => null}>
        <cylinderGeometry args={[0.05, 0.05, 1.2, 8]} />
        <meshBasicMaterial color={isSelected ? COLORS.aisleSelected : COLORS.rackFrame} transparent opacity={0.6} />
      </mesh>
      <mesh
        position={[corridor.position[0], handleY, corridor.position[2]]}
        onPointerDown={onGrab}
        onPointerOver={onEnter}
        onPointerOut={() => setHovered(false)}
      >
        <cylinderGeometry args={[0.55, 0.55, 0.22, 24]} />
        <meshStandardMaterial
          color={isSelected ? COLORS.aisleSelected : COLORS.aisle}
          emissive={isSelected ? COLORS.aisleSelected : COLORS.aisle}
          emissiveIntensity={highlighted ? 0.7 : 0.25}
          roughness={0.35}
          metalness={0.2}
        />
      </mesh>

      {runs.map((run) => {
        // The rack *is* the lane, so clicking it selects the lane — the same thing
        // the structure list does. It stays draggable-not: pointerdown here would
        // swallow the corridor drag, which is why the aisle's own handle floats above
        // the racking instead of relying on the slab being reachable.
        const lane = aisle.lanes.find((candidate) => candidate.code === run.laneCode);
        const laneSelected = lane
          ? selection.some((ref) => ref.kind === 'lane' && ref.id === lane.id)
          : false;

        return (
          <mesh
            key={run.key}
            position={[run.position[0], stackHeightM / 2, run.position[2]]}
            onPointerDown={rememberDown}
            onClick={(event) => {
              if (!isClick(event)) return;
              event.stopPropagation();
              if (lane) select({ kind: 'lane', id: lane.id, label: `${aisle.code} / ${lane.code}` });
            }}
            onPointerOver={() => setHoveredRun(run.key)}
            onPointerOut={() => setHoveredRun(null)}
          >
            <boxGeometry args={[run.size[0], stackHeightM, run.size[2]]} />
            <meshStandardMaterial
              color={laneSelected ? COLORS.aisleSelected : COLORS.rackFrame}
              transparent
              opacity={laneSelected ? 0.22 : hoveredRun === run.key || isSelected ? 0.14 : 0.07}
              depthWrite={false}
            />
          </mesh>
        );
      })}

      {highlighted && (
        <Html
          position={[corridor.position[0], handleY + 1.1, corridor.position[2]]}
          center
          distanceFactor={30}
          style={{ pointerEvents: 'none' }}
        >
          <div className="aisle-tag">
            <strong>{aisle.code}</strong>
            <span>
              {dragging && provisional
                ? `moving → ${(provisional.x2 - provisional.x1).toFixed(2)} m at z ${provisional.z1.toFixed(2)}`
                : `${aisle.widthM} m wide · ${aisle.lanes.length} lane${aisle.lanes.length === 1 ? '' : 's'}`}
            </span>
            {dragging ? (
              <span className="aisle-tag-hint">Release to commit</span>
            ) : (
              <span className="aisle-tag-hint">Drag to move</span>
            )}
          </div>
        </Html>
      )}
    </group>
  );
}

export function AisleGizmos() {
  const aisles = useDesignStore((state) => state.history.doc.aisles);
  const bays = useDesignStore((state) => state.graph.bays);
  const selection = useDesignStore((state) => state.selection);

  const selectedAisleIds = useMemo(
    () => new Set(selection.filter((ref) => ref.kind === 'aisle').map((ref) => ref.id)),
    [selection],
  );

  const laneCodes = useMemo(
    () => aisles.flatMap((aisle) => aisle.lanes.map((lane) => lane.code)),
    [aisles],
  );

  const runs = useMemo(() => runsByLane(bays, laneCodes), [bays, laneCodes]);

  return (
    <group>
      {aisles.map((aisle) => (
        <AisleGizmo
          key={aisle.id}
          aisle={aisle}
          isSelected={selectedAisleIds.has(aisle.id)}
          stackHeightM={aisle.lanes.reduce(
            (max, lane) => Math.max(max, laneStackHeightM(lane.levels)),
            0,
          )}
          runs={aisle.lanes.flatMap((lane) => runs.get(lane.code) ?? [])}
        />
      ))}
    </group>
  );
}
