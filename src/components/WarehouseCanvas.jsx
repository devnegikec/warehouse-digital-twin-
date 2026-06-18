// src/components/WarehouseCanvas.jsx
import { useRef, useEffect, useMemo, useState, useCallback } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { OrbitControls, Html, Grid } from '@react-three/drei';
import * as THREE from 'three';
import { generateWarehouseLayout, COLOR_MAP } from '../mockData';
import PickingPath from './PickingPath';

// Layout Configuration Metrics
const CONFIG = {
  totalAisles: 6,
  baysPerAisle: 25,
  levelsPerRack: 5,
  aisleSpacing: 6.5,
  baySpacing: 1.8,
  levelHeight: 1.4,
};

// Upright post dimensions
const UPRIGHT_W = 0.12;
const UPRIGHT_D = 0.12;
const BEAM_H = 0.08;
const BEAM_D = 0.12;

// Build rack frame geometry for one aisle column (both rows)
function RackFrame({ aisleIndex, config }) {
  const { baysPerAisle, levelsPerRack, aisleSpacing, baySpacing, levelHeight } = config;
  const totalHeight = levelsPerRack * levelHeight;
  const totalDepth = (baysPerAisle - 1) * baySpacing;

  const uprights = [];
  const beams = [];

  for (let row = 0; row < 2; row++) {
    const xBase = aisleIndex * aisleSpacing + (row === 0 ? -0.8 : 0.8);
    const xFront = xBase + (row === 0 ? -0.7 : 0.7);
    const xBack = xBase + (row === 0 ? 0.7 : -0.7);

    // Vertical uprights at each bay boundary
    for (let b = 0; b <= baysPerAisle; b++) {
      const zPos = b * baySpacing - baySpacing / 2;
      const key = `upright-${aisleIndex}-${row}-${b}`;

      uprights.push(
        <mesh key={`${key}-front`} position={[xFront, totalHeight / 2, zPos]}>
          <boxGeometry args={[UPRIGHT_W, totalHeight, UPRIGHT_D]} />
          <meshStandardMaterial color="#94a3b8" roughness={0.7} metalness={0.4} />
        </mesh>,
        <mesh key={`${key}-back`} position={[xBack, totalHeight / 2, zPos]}>
          <boxGeometry args={[UPRIGHT_W, totalHeight, UPRIGHT_D]} />
          <meshStandardMaterial color="#94a3b8" roughness={0.7} metalness={0.4} />
        </mesh>
      );

      // Horizontal cross-beams at each level
      for (let l = 0; l < levelsPerRack; l++) {
        const yBeam = l * levelHeight;
        beams.push(
          <mesh key={`beam-${aisleIndex}-${row}-${b}-${l}`} position={[xBase, yBeam, zPos]}>
            <boxGeometry args={[Math.abs(xFront - xBack) + UPRIGHT_W, BEAM_H, BEAM_D]} />
            <meshStandardMaterial color="#64748b" roughness={0.8} metalness={0.5} />
          </mesh>
        );
      }
    }

    // Longitudinal beams running along the depth at each level
    for (let l = 0; l < levelsPerRack; l++) {
      const yBeam = l * levelHeight;
      beams.push(
        <mesh key={`longbeam-${aisleIndex}-${row}-${l}-front`} position={[xFront, yBeam, totalDepth / 2]}>
          <boxGeometry args={[UPRIGHT_W, BEAM_H, totalDepth]} />
          <meshStandardMaterial color="#64748b" roughness={0.8} metalness={0.5} />
        </mesh>,
        <mesh key={`longbeam-${aisleIndex}-${row}-${l}-back`} position={[xBack, yBeam, totalDepth / 2]}>
          <boxGeometry args={[UPRIGHT_W, BEAM_H, totalDepth]} />
          <meshStandardMaterial color="#64748b" roughness={0.8} metalness={0.5} />
        </mesh>
      );
    }
  }

  return <group>{uprights}{beams}</group>;
}

// Tooltip shown on hover
function BinTooltip({ slot }) {
  const statusColors = {
    empty: '#94a3b8',
    current_stock: '#10b981',
    low_stock: '#f59e0b',
    slow_moving: '#ef4444',
  };

  return (
    <Html
      center
      distanceFactor={18}
      style={{ pointerEvents: 'none' }}
      zIndexRange={[100, 0]}
    >
      <div style={{
        background: 'rgba(15, 23, 42, 0.95)',
        border: `1px solid ${statusColors[slot.status]}`,
        borderRadius: 6,
        padding: '8px 12px',
        minWidth: 160,
        boxShadow: `0 0 12px ${statusColors[slot.status]}55`,
        color: '#f8fafc',
        fontSize: 12,
        lineHeight: 1.6,
        whiteSpace: 'nowrap',
      }}>
        <div style={{ fontWeight: 700, color: '#38bdf8', marginBottom: 4 }}>{slot.id}</div>
        <div>
          <span style={{ color: '#94a3b8' }}>Status: </span>
          <span style={{ color: statusColors[slot.status], fontWeight: 600, textTransform: 'capitalize' }}>
            {slot.status.replace('_', ' ')}
          </span>
        </div>
        {slot.sku && (
          <div><span style={{ color: '#94a3b8' }}>SKU: </span>{slot.sku}</div>
        )}
        <div><span style={{ color: '#94a3b8' }}>Qty: </span>{slot.qty} items</div>
        <div><span style={{ color: '#94a3b8' }}>Level: </span>{slot.level + 1}</div>
        <div style={{ marginTop: 4, fontSize: 10, color: '#64748b' }}>Click to inspect</div>
      </div>
    </Html>
  );
}

// Single bin mesh (used for hovered/selected highlight — rendered on top of instanced mesh)
function HighlightBin({ slot, color, pulse }) {
  const meshRef = useRef();

  useEffect(() => {
    if (!meshRef.current || !pulse) return;
    let frame;
    let t = 0;
    const animate = () => {
      t += 0.05;
      if (meshRef.current) {
        meshRef.current.material.emissiveIntensity = 0.4 + Math.sin(t) * 0.3;
      }
      frame = requestAnimationFrame(animate);
    };
    frame = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frame);
  }, [pulse]);

  return (
    <mesh ref={meshRef} position={slot.position}>
      <boxGeometry args={[1.25, 1.05, 1.65]} />
      <meshStandardMaterial
        color={color}
        emissive={color}
        emissiveIntensity={0.5}
        roughness={0.3}
        metalness={0.2}
        transparent
        opacity={0.92}
      />
    </mesh>
  );
}

function InstancedBins({ onSelectSlot, activeFilter, hoveredId, selectedId, onHover }) {
  const meshRef = useRef();
  const rawSlotsData = useMemo(() => generateWarehouseLayout(CONFIG), []);

  const tempObject = useMemo(() => new THREE.Object3D(), []);
  const tempColor = useMemo(() => new THREE.Color(), []);

  useEffect(() => {
    if (!meshRef.current) return;

    rawSlotsData.forEach((slot, index) => {
      tempObject.position.set(slot.position[0], slot.position[1], slot.position[2]);
      tempObject.updateMatrix();
      meshRef.current.setMatrixAt(index, tempObject.matrix);

      if (activeFilter !== 'all' && slot.status !== activeFilter) {
        tempColor.set('#1e293b');
      } else {
        tempColor.set(COLOR_MAP[slot.status]);
      }
      meshRef.current.setColorAt(index, tempColor);
    });

    meshRef.current.instanceMatrix.needsUpdate = true;
    if (meshRef.current.instanceColor) {
      meshRef.current.instanceColor.needsUpdate = true;
    }
  }, [rawSlotsData, activeFilter, tempObject, tempColor]);

  const hoveredSlot = hoveredId !== null ? rawSlotsData[hoveredId] : null;
  const selectedSlot = selectedId !== null ? rawSlotsData.find(s => s.id === selectedId) : null;

  return (
    <>
      <instancedMesh
        ref={meshRef}
        args={[null, null, rawSlotsData.length]}
        onClick={(e) => {
          e.stopPropagation();
          if (e.instanceId !== undefined) onSelectSlot(rawSlotsData[e.instanceId]);
        }}
        onPointerMove={(e) => {
          e.stopPropagation();
          if (e.instanceId !== undefined) onHover(e.instanceId);
        }}
        onPointerLeave={() => onHover(null)}
      >
        <boxGeometry args={[1.2, 1.0, 1.6]} />
        <meshStandardMaterial roughness={0.45} metalness={0.15} />
      </instancedMesh>

      {/* Hover highlight + tooltip */}
      {hoveredSlot && hoveredId !== (selectedSlot ? rawSlotsData.indexOf(selectedSlot) : -1) && (
        <>
          <HighlightBin slot={hoveredSlot} color="#3b82f6" pulse={false} />
          <group position={[hoveredSlot.position[0], hoveredSlot.position[1] + 0.9, hoveredSlot.position[2]]}>
            <BinTooltip slot={hoveredSlot} />
          </group>
        </>
      )}

      {/* Selected highlight */}
      {selectedSlot && (
        <HighlightBin slot={selectedSlot} color="#f59e0b" pulse={true} />
      )}
    </>
  );
}

export default function WarehouseCanvas({ onSelectSlot, activeFilter, showPath, selectedSlotId }) {
  const [hoveredInstanceId, setHoveredInstanceId] = useState(null);

  const floorWidth = CONFIG.totalAisles * CONFIG.aisleSpacing + 4;
  const floorLength = CONFIG.baysPerAisle * CONFIG.baySpacing + 4;
  const centerPosition = [
    floorWidth / 2 - CONFIG.aisleSpacing / 2,
    0,
    floorLength / 2 - CONFIG.baySpacing,
  ];

  const handleSelect = useCallback((slot) => {
    onSelectSlot(slot);
  }, [onSelectSlot]);

  return (
    <div style={{ width: '100%', height: '100vh', backgroundColor: '#0f172a' }}>
      <Canvas camera={{ position: [25, 22, 45], fov: 50 }} shadows>
        {/* Lighting */}
        <ambientLight intensity={0.5} />
        <directionalLight
          position={[30, 50, 30]}
          intensity={1.4}
          castShadow
          shadow-mapSize={[2048, 2048]}
        />
        <directionalLight position={[-20, 30, -20]} intensity={0.4} color="#bfdbfe" />
        <pointLight position={[centerPosition[0], 8, centerPosition[2]]} intensity={0.3} color="#e0f2fe" />

        {/* Floor */}
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[centerPosition[0], -0.02, centerPosition[2]]} receiveShadow>
          <planeGeometry args={[floorWidth, floorLength]} />
          <meshStandardMaterial color="#0f172a" roughness={0.8} />
        </mesh>

        {/* Floor grid */}
        <Grid
          position={[centerPosition[0], 0, centerPosition[2]]}
          args={[floorWidth, floorLength]}
          cellSize={CONFIG.baySpacing}
          cellThickness={0.4}
          cellColor="#1e3a5f"
          sectionSize={CONFIG.aisleSpacing}
          sectionThickness={0.8}
          sectionColor="#1e40af"
          fadeDistance={80}
          fadeStrength={1}
          infiniteGrid={false}
        />

        {/* Rack structural frames */}
        {Array.from({ length: CONFIG.totalAisles }, (_, i) => (
          <RackFrame key={`frame-${i}`} aisleIndex={i} config={CONFIG} />
        ))}

        {/* Bin instances */}
        <InstancedBins
          onSelectSlot={handleSelect}
          activeFilter={activeFilter}
          hoveredId={hoveredInstanceId}
          selectedId={selectedSlotId}
          onHover={setHoveredInstanceId}
        />

        {/* Picking path overlay */}
        {showPath && <PickingPath config={CONFIG} />}

        <OrbitControls
          makeDefault
          target={centerPosition}
          minDistance={5}
          maxDistance={70}
          maxPolarAngle={Math.PI / 2.1}
        />
      </Canvas>
    </div>
  );
}
