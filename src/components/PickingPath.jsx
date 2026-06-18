// src/components/PickingPath.jsx
import React from 'react';
import { Line } from '@react-three/drei';

export default function PickingPath({ config }) {
  const { aisleSpacing, baySpacing } = config;

  // Mock path array representing a picker moving down Aisle 1, cutting across, and returning up Aisle 2
  const pathWaypoints = [
    [0 * aisleSpacing, 0.1, 0 * baySpacing],   // Start at Aisle 0 Dock Entrance
    [0 * aisleSpacing, 0.1, 12 * baySpacing],  // Pick Item 1 (Bay 12)
    [0 * aisleSpacing, 0.1, 24 * baySpacing],  // Reach the end of Aisle 0
    [2 * aisleSpacing, 0.1, 24 * baySpacing],  // Cross over to Aisle 2 lane
    [2 * aisleSpacing, 0.1, 8 * baySpacing],   // Pick Item 2 (Bay 8)
    [2 * aisleSpacing, 0.1, 0 * baySpacing],   // Return to main dispatch deck
  ];

  return (
    <group>
      {/* 3D Core Path Line Segment */}
      <Line
        points={pathWaypoints}
        color="#38bdf8" // Neon Sky Blue
        lineWidth={4}
        dashed={false}
      />

      {/* Glowing Start/End Waypoint Indicators */}
      <mesh position={pathWaypoints[0]}>
        <cylinderGeometry args={[0.4, 0.4, 0.2]} />
        <meshBasicMaterial color="#34d399" />
      </mesh>
      <mesh position={pathWaypoints[pathWaypoints.length - 1]}>
        <cylinderGeometry args={[0.4, 0.4, 0.2]} />
        <meshBasicMaterial color="#ef4444" />
      </mesh>
    </group>
  );
}
