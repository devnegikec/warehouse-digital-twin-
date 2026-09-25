/**
 * The Operate-mode canvas.
 *
 * Every dimension here comes from the layout, not from a configuration object: the floor
 * is the warehouse's own footprint, the racking is derived from the bins, and the camera
 * fits itself to what is actually being shown. That is the whole of Phase 9 — the viewer
 * stopped describing one hardcoded warehouse and started describing the document.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { Grid, Html, OrbitControls } from '@react-three/drei';
import * as THREE from 'three';

import { PickingRoute } from './PickingRoute';
import { RackStructure } from './RackStructure';
import { STATUS_COLORS, type OperateSlot, type SlotStatus } from './slots';

export type OperateFilter = 'all' | SlotStatus;

const EMPTY_COLOR = '#1e293b';

function SlotTooltip({ slot }: { slot: OperateSlot }) {
  const color = STATUS_COLORS[slot.status];

  return (
    <Html center distanceFactor={18} style={{ pointerEvents: 'none' }} zIndexRange={[100, 0]}>
      <div
        style={{
          background: 'rgba(15, 23, 42, 0.95)',
          border: `1px solid ${color}`,
          borderRadius: 6,
          padding: '8px 12px',
          minWidth: 190,
          boxShadow: `0 0 12px ${color}55`,
          color: '#f8fafc',
          fontSize: 12,
          lineHeight: 1.6,
          whiteSpace: 'nowrap',
        }}
      >
        <div style={{ fontWeight: 700, color: '#38bdf8', marginBottom: 4 }}>{slot.binCode}</div>
        <div>
          <span style={{ color: '#94a3b8' }}>Status: </span>
          <span style={{ color, fontWeight: 600, textTransform: 'capitalize' }}>
            {slot.status.replace('_', ' ')}
          </span>
        </div>
        {slot.sku && (
          <div>
            <span style={{ color: '#94a3b8' }}>SKU: </span>
            {slot.sku}
            {slot.skuCount > 1 ? ` (+${slot.skuCount - 1} more)` : ''}
          </div>
        )}
        <div>
          <span style={{ color: '#94a3b8' }}>Qty: </span>
          {slot.qty}
        </div>
        <div>
          <span style={{ color: '#94a3b8' }}>Fill: </span>
          {(slot.utilization * 100).toFixed(0)}% of {slot.capacityM3} m³
        </div>
        <div>
          <span style={{ color: '#94a3b8' }}>Aisle / lane: </span>
          {slot.aisleCode} / {slot.laneCode}
        </div>
        <div>
          <span style={{ color: '#94a3b8' }}>Bay / level: </span>
          {slot.baySeq} / {slot.levelIndex + 1}
        </div>
        {slot.lastMovedDays !== null && (
          <div>
            <span style={{ color: '#94a3b8' }}>Last moved: </span>
            {slot.lastMovedDays} day{slot.lastMovedDays === 1 ? '' : 's'} ago
          </div>
        )}
        <div style={{ marginTop: 4, fontSize: 10, color: '#64748b' }}>Click to inspect</div>
      </div>
    </Html>
  );
}

function binsFor(slots: readonly OperateSlot[], filter: OperateFilter): OperateSlot[] {
  return filter === 'all' ? [...slots] : slots.filter((slot) => slot.status === filter);
}

/**
 * The instanced bins, plus the hover and selection highlights drawn on top.
 *
 * Rebuilt only when the slot list or the colours change — the same discipline the
 * designer's canvas uses, because this is the path that has to survive 100k bins.
 */
function SlotInstances({
  slots,
  activeFilter,
  selectedId,
  onSelectSlot,
  onHover,
  hoveredId,
}: {
  slots: OperateSlot[];
  activeFilter: OperateFilter;
  selectedId: string | null;
  onSelectSlot: (slot: OperateSlot) => void;
  onHover: (id: string | null) => void;
  hoveredId: string | null;
}) {
  const meshRef = useRef<THREE.InstancedMesh>(null);

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;

    const dummy = new THREE.Object3D();
    const color = new THREE.Color();

    slots.forEach((slot, index) => {
      dummy.position.set(slot.position[0], slot.position[1], slot.position[2]);
      dummy.rotation.set(0, THREE.MathUtils.degToRad(slot.rotationDeg), 0);
      dummy.scale.set(slot.size[0], slot.size[1], slot.size[2]);
      dummy.updateMatrix();
      mesh.setMatrixAt(index, dummy.matrix);

      // A filtered-out bin keeps its geometry but loses its colour, so the rack stays
      // readable instead of the layout appearing to change shape.
      const dimmed = activeFilter !== 'all' && slot.status !== activeFilter;
      color.set(dimmed ? EMPTY_COLOR : STATUS_COLORS[slot.status]);
      mesh.setColorAt(index, color);
    });

    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [slots, activeFilter]);

  const hovered = hoveredId === null ? null : (slots.find((slot) => slot.binCode === hoveredId) ?? null);
  const selected = selectedId === null ? null : (slots.find((slot) => slot.binCode === selectedId) ?? null);

  return (
    <group>
      <instancedMesh
        key={slots.length}
        ref={meshRef}
        args={[undefined, undefined, slots.length]}
        onPointerMove={(event) => {
          event.stopPropagation();
          if (event.instanceId !== undefined) onHover(slots[event.instanceId]?.binCode ?? null);
        }}
        onPointerOut={() => onHover(null)}
        onClick={(event) => {
          event.stopPropagation();
          if (event.instanceId === undefined) return;
          const slot = slots[event.instanceId];
          if (slot) onSelectSlot(slot);
        }}
      >
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial roughness={0.45} metalness={0.15} />
      </instancedMesh>

      {hovered && hovered.binCode !== selectedId && (
        <>
          <mesh position={hovered.position} rotation={[0, THREE.MathUtils.degToRad(hovered.rotationDeg), 0]}>
            <boxGeometry args={[hovered.size[0] * 1.03, hovered.size[1] * 1.03, hovered.size[2] * 1.03]} />
            <meshStandardMaterial color="#3b82f6" transparent opacity={0.5} depthWrite={false} />
          </mesh>
          <group position={[hovered.position[0], hovered.position[1] + hovered.size[1] * 0.7, hovered.position[2]]}>
            <SlotTooltip slot={hovered} />
          </group>
        </>
      )}

      {selected && (
        <mesh position={selected.position} rotation={[0, THREE.MathUtils.degToRad(selected.rotationDeg), 0]}>
          <boxGeometry args={[selected.size[0] * 1.05, selected.size[1] * 1.05, selected.size[2] * 1.05]} />
          <meshStandardMaterial
            color="#f59e0b"
            emissive="#f59e0b"
            emissiveIntensity={0.5}
            transparent
            opacity={0.85}
          />
        </mesh>
      )}
    </group>
  );
}

export default function WarehouseCanvas({
  slots,
  activeFilter,
  showPath,
  selectedSlotId,
  onSelectSlot,
  footprint,
  revision,
}: {
  slots: OperateSlot[];
  activeFilter: OperateFilter;
  showPath: boolean;
  selectedSlotId: string | null;
  onSelectSlot: (slot: OperateSlot | null) => void;
  footprint: { originX: number; originZ: number; lengthM: number; widthM: number };
  revision: number;
}) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const visible = useMemo(() => binsFor(slots, activeFilter), [slots, activeFilter]);
  const centre = useMemo(
    () =>
      [
        footprint.originX + footprint.lengthM / 2,
        0,
        footprint.originZ + footprint.widthM / 2,
      ] as [number, number, number],
    [footprint],
  );

  const handleSelect = useCallback(
    (slot: OperateSlot) => {
      onSelectSlot(slot);
    },
    [onSelectSlot],
  );

  // Scene extent: the building plus a margin, so the floor never floats.
  const span = Math.max(footprint.lengthM, footprint.widthM) + 4;
  const cameraDistance = Math.max(span * 0.9, 18);

  return (
    <div style={{ width: '100%', height: '100vh', backgroundColor: '#0f172a' }}>
      <Canvas
        key={`operate-${revision}`}
        camera={{ position: [centre[0] + cameraDistance * 0.6, cameraDistance * 0.7, centre[2] + cameraDistance], fov: 45 }}
        shadows
      >
        <ambientLight intensity={0.5} />
        <directionalLight position={[30, 50, 30]} intensity={1.4} castShadow shadow-mapSize={[2048, 2048]} />
        <directionalLight position={[-20, 30, -20]} intensity={0.4} color="#bfdbfe" />

        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[centre[0], -0.02, centre[2]]} receiveShadow>
          <planeGeometry args={[footprint.lengthM, footprint.widthM]} />
          <meshStandardMaterial color="#0f172a" roughness={0.8} />
        </mesh>

        <Grid
          position={[centre[0], 0, centre[2]]}
          args={[footprint.lengthM, footprint.widthM]}
          cellSize={1}
          cellThickness={0.4}
          cellColor="#1e3a5f"
          sectionSize={5}
          sectionThickness={0.8}
          sectionColor="#1e40af"
          fadeDistance={span * 2}
          fadeStrength={1}
          infiniteGrid={false}
        />

        <RackStructure slots={slots} />

        <SlotInstances
          slots={visible}
          activeFilter={activeFilter}
          selectedId={selectedSlotId}
          onSelectSlot={handleSelect}
          onHover={setHoveredId}
          hoveredId={hoveredId}
        />

        {showPath && <PickingRoute slots={slots} />}

        <OrbitControls
          makeDefault
          target={centre}
          minDistance={5}
          maxDistance={span * 3}
          maxPolarAngle={Math.PI / 2.1}
        />
      </Canvas>
    </div>
  );
}
