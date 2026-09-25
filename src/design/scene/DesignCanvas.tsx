/**
 * The design canvas.
 *
 * Reads everything from the store and writes nothing but commands, so the scene is
 * a pure projection of the document (P1). Clicking bare floor either clears the
 * selection or places a new object, depending on the active tool.
 */
import { Canvas, type ThreeEvent } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';

import { snap } from 'layout-core';

import { makeAisleInput } from '../placement';
import { designState, useDesignStore } from '../store/designStore';
import { COLORS } from '../theme';
import { AisleGizmos } from './AisleGizmos';
import { BinsInstanced } from './BinsInstanced';
import { CameraRig } from './CameraRig';
import { ObstacleMeshes } from './ObstacleMeshes';
import { FootprintOutline, WarehouseFloor } from './WarehouseFloor';
import { useClickNotDrag } from './useClickNotDrag';

/** Invisible floor plane that captures clicks which miss every object. */
function GroundInteraction() {
  const warehouse = useDesignStore((state) => state.history.doc.warehouse);
  const rackTypes = useDesignStore((state) => state.history.doc.rackTypes);
  const tool = useDesignStore((state) => state.tool);
  const snapM = useDesignStore((state) => state.snapM);
  const dispatch = useDesignStore((state) => state.dispatch);
  const select = useDesignStore((state) => state.select);
  const setTool = useDesignStore((state) => state.setTool);

  const { origin, lengthM, widthM } = warehouse;
  /** A drag that ends over the floor must not be treated as a click on it. */
  const { onPointerDown: rememberDown, isClick } = useClickNotDrag();

  const placeAisle = (point: { x: number; z: number }) => {
    const rackType = rackTypes[0];
    if (!rackType) return;

    const outcome = dispatch({
      type: 'aisle.add',
      aisle: makeAisleInput(point, warehouse, rackType.id),
    });

    if (!outcome.ok) return;

    // Commands generate ids, so the created aisle is read back rather than guessed.
    const created = designState().history.doc.aisles.at(-1);
    if (created) select({ kind: 'aisle', id: created.id, label: created.code });
    setTool('SELECT');
  };

  return (
    <mesh
      rotation={[-Math.PI / 2, 0, 0]}
      position={[origin.x + lengthM / 2, 0.004, origin.z + widthM / 2]}
      onPointerDown={rememberDown}
      onClick={(event: ThreeEvent<MouseEvent>) => {
        if (!isClick(event)) {
          event.stopPropagation();
          return;
        }
        event.stopPropagation();
        const point = { x: snap(event.point.x, snapM), z: snap(event.point.z, snapM) };

        if (tool === 'ADD_AISLE') {
          placeAisle(point);
          return;
        }

        if (tool === 'ADD_OBSTACLE') {
          dispatch({
            type: 'obstacle.add',
            obstacle: {
              kind: 'COLUMN',
              x: point.x - 0.4,
              z: point.z - 0.4,
              widthM: 0.8,
              depthM: 0.8,
              heightM: 4,
            },
          });
          setTool('SELECT');
          return;
        }

        select(null);
      }}
    >
      <planeGeometry args={[lengthM, widthM]} />
      <meshBasicMaterial transparent opacity={0} depthWrite={false} />
    </mesh>
  );
}

export function DesignCanvas() {
  const warehouse = useDesignStore((state) => state.history.doc.warehouse);
  const tool = useDesignStore((state) => state.tool);

  const target: [number, number, number] = [
    warehouse.origin.x + warehouse.lengthM / 2,
    0,
    warehouse.origin.z + warehouse.widthM / 2,
  ];

  return (
    <Canvas
      shadows
      dpr={[1, 2]}
      camera={{ position: [52, 40, 50], fov: 42, near: 0.5, far: 600 }}
      style={{ cursor: tool === 'SELECT' ? 'default' : 'crosshair' }}
    >
      <color attach="background" args={[COLORS.background]} />
      <fog attach="fog" args={[COLORS.background, 120, 320]} />

      <ambientLight intensity={0.5} />
      <hemisphereLight args={['#dbeafe', '#0b1220', 0.8]} />
      <directionalLight
        position={[warehouse.lengthM * 0.7, 55, warehouse.widthM * 0.9]}
        intensity={1.1}
        castShadow
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-left={-60}
        shadow-camera-right={60}
        shadow-camera-top={60}
        shadow-camera-bottom={-60}
        shadow-camera-near={1}
        shadow-camera-far={200}
      />

      <OrbitControls
        makeDefault
        target={target}
        maxPolarAngle={Math.PI / 2.05}
        minDistance={6}
        maxDistance={260}
      />

      <CameraRig />

      <WarehouseFloor />
      <FootprintOutline />
      <GroundInteraction />
      <ObstacleMeshes />
      <AisleGizmos />
      <BinsInstanced />
    </Canvas>
  );
}
