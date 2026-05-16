// src/components/WarehouseCanvas.jsx
import React, { useRef, useEffect, useMemo } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, Grid } from '@react-three/drei';
import * as THREE from 'three';
import { generateWarehouseLayout, COLOR_MAP } from '../mockData';

// Layout Configuration Metrics
const CONFIG = {
  totalAisles: 6,
  baysPerAisle: 25,
  levelsPerRack: 5,
  aisleSpacing: 4.5, // Space between forklift pathways
  baySpacing: 1.8,   // Shelf length down the row
  levelHeight: 1.4,  // Shelf tier heights
};

function InstancedRacks({ onSelectSlot }) {
  const meshRef = useRef();

  // 1. Programmatically assemble our mock inventory dataset
  const rawSlotsData = useMemo(() => generateWarehouseLayout(CONFIG), []);

  // Dummy objects used to calculate vector transformations per instance
  const tempObject = new THREE.Object3D();
  const tempColor = new THREE.Color();

  useEffect(() => {
    if (!meshRef.current) return;

    rawSlotsData.forEach((slot, index) => {
      // Set Position
      tempObject.position.set(slot.position[0], slot.position[1], slot.position[2]);
      tempObject.updateMatrix();
      meshRef.current.setMatrixAt(index, tempObject.matrix);

      // Set Color based on status
      tempColor.set(COLOR_MAP[slot.status]);
      meshRef.current.setColorAt(index, tempColor);
    });

    // Notify Three.js that the properties have updated
    meshRef.current.instanceMatrix.needsUpdate = true;
    if (meshRef.current.instanceColor) {
      meshRef.current.instanceColor.needsUpdate = true;
    }
  }, [rawSlotsData]);

  // Handle clicking an instanced object via Raycasting
  const handleMeshClick = (event) => {
    event.stopPropagation();
    const instanceId = event.instanceId; // Returns the index array item clicked
    if (instanceId !== undefined) {
      onSelectSlot(rawSlotsData[instanceId]);
    }
  };

  return (
    <instancedMesh
      ref={meshRef}
      args={[null, null, rawSlotsData.length]}
      onClick={handleMeshClick}
    >
      {/* Structural Box Dimensions for a single bin slot */}
      <boxGeometry args={[1.2, 1.0, 1.6]} />
      <meshStandardMaterial roughness={0.3} metalness={0.1} />
    </instancedMesh>
  );
}

export default function WarehouseCanvas({ onSelectSlot }) {
  return (
    <div style={{ width: '100%', height: '100vh', backgroundColor: '#0f172a' }}>
      <Canvas camera={{ position: [20, 20, 30], fov: 60 }}>
        <ambientLight intensity={0.7} />
        <directionalLight position={[30, 40, 20]} intensity={1.0} castShadow />

        <InstancedRacks onSelectSlot={onSelectSlot} />

        {/* Center the grid view to cover the layout footprint */}
        <Grid
          position={[12, 0, 20]}
          args={[80, 80]}
          cellSize={2}
          cellThickness={1}
          sectionSize={10}
          sectionColor="#334155"
          fadeDistance={60}
          infiniteGrid
        />

        <OrbitControls makeDefault target={[12, 2, 20]} maxPolarAngle={Math.PI / 2.05} />
      </Canvas>
    </div>
  );
}
