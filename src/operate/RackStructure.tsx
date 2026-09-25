/**
 * Rack structure: uprights and beams, derived from the slots.
 *
 * The previous viewer built this from a hardcoded `CONFIG`, which meant the steel only
 * existed for one particular warehouse. Here it is derived from the bins themselves: a
 * bay's footprint gives the upright positions and the level heights give the beam
 * positions, so a layout with ten bays or ten levels draws correctly with no config.
 *
 * Two `InstancedMesh`es, not one mesh per member. A realistic layout has thousands of
 * uprights; the Phase 10 target is 100k bins, so per-member meshes are not an option
 * even in the viewer.
 */
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';

import type { OperateSlot } from './slots';

const UPRIGHT_W = 0.12;
const BEAM_H = 0.08;
const BEAM_D = 0.12;
/** Beams sit just under each level, so they read as the shelf a bin rests on. */
const CONCRETE = '#94a3b8';
const STEEL = '#64748b';

type Member = {
  position: [number, number, number];
  rotationY: number;
  scale: [number, number, number];
};

type Frame = {
  uprights: Member[];
  beams: Member[];
};

/**
 * Group slots into bays and emit one set of members per bay.
 *
 * Uprights go at the two *ends* of each bay column (shared between neighbours visually,
 * which is what real racking looks like), on both faces. Beams span the bay width at the
 * bottom of every level, again on both faces.
 */
function buildFrame(slots: readonly OperateSlot[]): Frame {
  const bays = new Map<string, OperateSlot[]>();
  for (const slot of slots) {
    const key = `${slot.aisleCode}/${slot.laneCode}/${slot.baySeq}`;
    const list = bays.get(key);
    if (list) list.push(slot);
    else bays.set(key, [slot]);
  }

  const uprights: Member[] = [];
  const beams: Member[] = [];

  for (const levelsInBay of bays.values()) {
    const sample = levelsInBay[0];
    if (!sample) continue;

    const rotationY = THREE.MathUtils.degToRad(sample.rotationDeg);
    const alongX = sample.rotationDeg === 0;

    const top = levelsInBay.reduce(
      (highest, level) => Math.max(highest, level.position[1] + level.size[1] / 2),
      0,
    );
    const [width, , depth] = sample.size;

    // Local axes of the bay, so the same arithmetic works for an aisle running either
    // way: `across` is the bay width direction, `into` is the rack depth direction.
    const across: [number, number] = alongX ? [width, 0] : [0, width];
    const into: [number, number] = alongX ? [0, depth] : [depth, 0];

    for (const endSign of [-1, 1]) {
      for (const faceSign of [-1, 1]) {
        uprights.push({
          position: [
            sample.position[0] + (across[0] * endSign) / 2 + (into[0] * faceSign) / 2,
            top / 2,
            sample.position[2] + (across[1] * endSign) / 2 + (into[1] * faceSign) / 2,
          ],
          rotationY,
          scale: [UPRIGHT_W, top, UPRIGHT_W],
        });
      }
    }

    for (const level of levelsInBay) {
      const bottom = level.position[1] - level.size[1] / 2;
      for (const faceSign of [-1, 1]) {
        beams.push({
          position: [
            sample.position[0] + (into[0] * faceSign) / 2,
            bottom,
            sample.position[2] + (into[1] * faceSign) / 2,
          ],
          rotationY,
          scale: alongX ? [width, BEAM_H, BEAM_D] : [BEAM_D, BEAM_H, width],
        });
      }
    }
  }

  return { uprights, beams };
}

function Instances({
  members,
  color,
}: {
  members: Member[];
  color: string;
}) {
  const meshRef = useRef<THREE.InstancedMesh>(null);

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;

    const dummy = new THREE.Object3D();
    members.forEach((member, index) => {
      dummy.position.set(...member.position);
      dummy.rotation.set(0, member.rotationY, 0);
      dummy.scale.set(...member.scale);
      dummy.updateMatrix();
      mesh.setMatrixAt(index, dummy.matrix);
    });

    mesh.instanceMatrix.needsUpdate = true;
  }, [members]);

  if (members.length === 0) return null;

  return (
    <instancedMesh key={members.length} ref={meshRef} args={[undefined, undefined, members.length]}>
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial color={color} roughness={0.75} metalness={0.4} />
    </instancedMesh>
  );
}

export function RackStructure({ slots }: { slots: readonly OperateSlot[] }) {
  const frame = useMemo(() => buildFrame(slots), [slots]);

  return (
    <group>
      <Instances members={frame.uprights} color={CONCRETE} />
      <Instances members={frame.beams} color={STEEL} />
    </group>
  );
}
