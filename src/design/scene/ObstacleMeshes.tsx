/**
 * Obstacles: columns, pillars, walls, offices.
 *
 * Rendered as translucent red volumes so they read as "not usable storage space"
 * without hiding the racks behind them.
 */
import { useDesignStore } from '../store/designStore';
import { COLORS } from '../theme';

export function ObstacleMeshes() {
  const obstacles = useDesignStore((state) => state.history.doc.obstacles);
  const selection = useDesignStore((state) => state.selection);
  const select = useDesignStore((state) => state.select);

  const selectedIds = new Set(selection.filter((ref) => ref.kind === 'obstacle').map((ref) => ref.id));

  return (
    <group>
      {obstacles.map((obstacle) => {
        const isSelected = selectedIds.has(obstacle.id);
        return (
          <mesh
            key={obstacle.id}
            position={[
              obstacle.x + obstacle.widthM / 2,
              obstacle.heightM / 2,
              obstacle.z + obstacle.depthM / 2,
            ]}
            onClick={(event) => {
              event.stopPropagation();
              select({ kind: 'obstacle', id: obstacle.id, label: obstacle.kind });
            }}
          >
            <boxGeometry args={[obstacle.widthM, obstacle.heightM, obstacle.depthM]} />
            <meshStandardMaterial
              color={isSelected ? COLORS.binSelected : COLORS.obstacle}
              transparent
              opacity={isSelected ? 0.75 : 0.5}
              roughness={0.6}
            />
          </mesh>
        );
      })}
    </group>
  );
}
