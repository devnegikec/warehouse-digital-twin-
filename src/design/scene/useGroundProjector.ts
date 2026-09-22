/**
 * Converts screen coordinates to a point on the warehouse floor (y = 0).
 *
 * Dragging cannot rely on pointer events from the dragged mesh: once the pointer
 * leaves the mesh, those stop firing. So during a drag we listen on `window` and
 * project through this hook instead.
 */
import { useCallback } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';

export type GroundPoint = { x: number; z: number };

export function useGroundProjector(): (clientX: number, clientY: number) => GroundPoint | null {
  const raycaster = useThree((state) => state.raycaster);
  const camera = useThree((state) => state.camera);
  const gl = useThree((state) => state.gl);

  return useCallback(
    (clientX: number, clientY: number) => {
      const rect = gl.domElement.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;

      const ndc = new THREE.Vector2(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -(((clientY - rect.top) / rect.height) * 2 - 1),
      );

      raycaster.setFromCamera(ndc, camera);
      const hit = new THREE.Vector3();
      const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
      if (!raycaster.ray.intersectPlane(plane, hit)) return null;
      return { x: hit.x, z: hit.z };
    },
    [raycaster, camera, gl],
  );
}
