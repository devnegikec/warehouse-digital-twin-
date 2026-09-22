/**
 * Animates the camera to a focused entity.
 *
 * The viewing *angle* is preserved and only the distance and target change. A fixed
 * angle would be less code, but it throws away the orientation the designer chose,
 * and re-orienting after every fly-to is worse than not flying at all.
 *
 * Lives inside the `<Canvas>` because it needs the render loop and the camera, and
 * subscribes to the focus bus because the diagnostics panel is in a different React
 * root.
 */
import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';

import { subscribeFocus, type FocusTarget } from './cameraFocus';

const DURATION_MS = 520;
/** Never look up at the racks from floor level; keep at least this much elevation. */
const MIN_ELEVATION_RATIO = 0.45;

type Flight = {
  fromPosition: THREE.Vector3;
  toPosition: THREE.Vector3;
  fromTarget: THREE.Vector3;
  toTarget: THREE.Vector3;
  startedAt: number;
};

type OrbitLike = { target: THREE.Vector3; update: () => void };

export function CameraRig() {
  const camera = useThree((state) => state.camera);
  const controls = useThree((state) => state.controls) as unknown as OrbitLike | null;

  const flight = useRef<Flight | null>(null);

  useEffect(() => {
    const plan = (focus: FocusTarget) => {
      const toTarget = new THREE.Vector3(focus.x, focus.y, focus.z);

      // Keep the current direction, but from the *target* the camera is already
      // orbiting, so the flight does not swing through the middle of the layout.
      const currentTarget = controls?.target ?? toTarget;
      const offset = new THREE.Vector3().subVectors(camera.position, currentTarget);
      if (offset.lengthSq() < 1e-6) offset.set(1, 1, 1).normalize();
      offset.normalize();
      offset.y = Math.max(offset.y, MIN_ELEVATION_RATIO);
      offset.normalize();

      const distance = Math.max(focus.radius * 2.6, 9);
      const toPosition = toTarget.clone().addScaledVector(offset, distance);

      flight.current = {
        fromPosition: camera.position.clone(),
        toPosition,
        fromTarget: currentTarget.clone(),
        toTarget,
        startedAt: performance.now(),
      };
    };

    return subscribeFocus(plan);
  }, [camera, controls]);

  useFrame(() => {
    const active = flight.current;
    if (!active) return;

    const elapsed = performance.now() - active.startedAt;
    const linear = Math.min(elapsed / DURATION_MS, 1);
    // Ease out cubic: quick to leave, settles gently.
    const eased = 1 - (1 - linear) ** 3;

    camera.position.lerpVectors(active.fromPosition, active.toPosition, eased);
    const target = new THREE.Vector3().lerpVectors(active.fromTarget, active.toTarget, eased);
    if (controls) controls.target.copy(target);

    camera.lookAt(target);
    controls?.update();

    if (linear >= 1) flight.current = null;
  });

  return null;
}
