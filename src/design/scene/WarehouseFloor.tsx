/**
 * Footprint slab and floor grid.
 *
 * The visual grid is 1 m with 5 m sections — deliberately coarser than the snap
 * increment (default 0.05 m), because snapping to a visible 5 cm grid would be
 * unreadable at warehouse scale. The inspector, not the grid, is what tells you
 * an exact dimension.
 */
import { useMemo } from 'react';
import { Grid } from '@react-three/drei';
import * as THREE from 'three';

import { useDesignStore } from '../store/designStore';
import { COLORS } from '../theme';

export function WarehouseFloor() {
  const warehouse = useDesignStore((state) => state.history.doc.warehouse);

  const { origin, lengthM, widthM } = warehouse;
  const centerX = origin.x + lengthM / 2;
  const centerZ = origin.z + widthM / 2;

  return (
    <group>
      {/* Slab: top face sits exactly at y = 0, which is the modelling datum. */}
      <mesh position={[centerX, -0.1, centerZ]} receiveShadow>
        <boxGeometry args={[lengthM, 0.2, widthM]} />
        <meshStandardMaterial color={COLORS.floor} roughness={0.95} metalness={0} />
      </mesh>

      <Grid
        position={[centerX, 0.002, centerZ]}
        args={[lengthM, widthM]}
        cellSize={1}
        cellThickness={0.6}
        cellColor={COLORS.grid}
        sectionSize={5}
        sectionThickness={1.2}
        sectionColor={COLORS.gridSection}
        fadeDistance={180}
        fadeStrength={1}
        infiniteGrid={false}
      />
    </group>
  );
}

/** Footprint outline drawn on the floor plane, so the usable envelope is unmistakable. */
export function FootprintOutline() {
  const warehouse = useDesignStore((state) => state.history.doc.warehouse);
  const { origin, lengthM, widthM } = warehouse;

  const geometry = useMemo(() => {
    const corners = [
      [origin.x, 0.01, origin.z],
      [origin.x + lengthM, 0.01, origin.z],
      [origin.x + lengthM, 0.01, origin.z + widthM],
      [origin.x, 0.01, origin.z + widthM],
    ];
    const result = new THREE.BufferGeometry();
    result.setAttribute('position', new THREE.Float32BufferAttribute(corners.flat(), 3));
    return result;
  }, [origin.x, origin.z, lengthM, widthM]);

  return (
    <lineLoop geometry={geometry}>
      <lineBasicMaterial color={COLORS.floorEdge} />
    </lineLoop>
  );
}
