// src/components/RackSlot.jsx
import React, { useState } from 'react';
import { COLOR_MAP } from '../mockData';

export default function RackSlot({ data, onSelect }) {
  const [hovered, setHovered] = useState(false);

  // Calculate spatial position based on layout coordinates
  // Width = X, Height = Y, Depth = Z
  const position = [data.aisle * 1.5, data.level * 1.2 + 0.6, data.bay * 2];

  return (
    <mesh
      position={position}
      onClick={(e) => {
        e.stopPropagation(); // Prevents clicking multiple intersecting objects
        onSelect(data);
      }}
      onPointerOver={(e) => {
        e.stopPropagation();
        setHovered(true);
      }}
      onPointerOut={(e) => {
        setHovered(false);
      }}
    >
      {/* Box dimensions: width, height, depth */}
      <boxGeometry args={[1.2, 0.9, 1.5]} />

      <meshStandardMaterial
        color={hovered ? "#3b82f6" : COLOR_MAP[data.status]}
        roughness={0.4}
        metalness={0.1}
        wireframe={data.status === "empty"} // Render open spaces cleanly as wireframes
      />
    </mesh>
  );
}
