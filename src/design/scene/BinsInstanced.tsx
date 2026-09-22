/**
 * Bins, rendered as a single InstancedMesh.
 *
 * A realistic layout is 100k+ bins, so this must never be one component per bin
 * (P11). Instance transforms are rebuilt only when the bin list or the highlight
 * state changes.
 *
 * Colours encode usable capacity — which varies per level because clear heights
 * differ — so the rack faces are readable at a glance rather than uniform. When
 * inventory is loaded the ramp switches to utilisation, which is the question that
 * matters once things are being stored.
 *
 * While a SKU is being dragged from the palette this component also resolves the drop
 * target: it raycasts its own instances from R3F's pointer and publishes the verdict,
 * so the palette never has to duplicate the bin transforms to work out what is under
 * the cursor.
 */
import { useEffect, useMemo, useRef } from 'react';
import { Html } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';

import type { DerivedBin } from 'layout-core';

import { useDesignStore } from '../store/designStore';
import { COLORS } from '../theme';
import {
  NOT_PUBLISHED,
  checkPlacement,
  skuById,
  usedInBin,
  utilizationColor,
  utilizationOf,
} from '../persistence/inventory';
import { getInventory, setDropTarget, useInventory } from '../persistence/inventoryStore';import { useClickNotDrag } from './useClickNotDrag';

function capacityColor(bin: DerivedBin, minCapacity: number, maxCapacity: number): THREE.Color {
  const span = maxCapacity - minCapacity;
  const t = span > 1e-9 ? (bin.capacityM3 - minCapacity) / span : 0;
  // 0 -> slate, 1 -> warm. Uses three's own lerp so it stays in the sRGB working space.
  return new THREE.Color(COLORS.bin).lerp(new THREE.Color('#dbe4ef'), t * 0.75 + 0.1);
}

export function BinsInstanced() {
  const bins = useDesignStore((state) => state.graph.bins);
  const hoveredBinCode = useDesignStore((state) => state.hoveredBinCode);
  const selection = useDesignStore((state) => state.selection);
  const setHoveredBin = useDesignStore((state) => state.setHoveredBin);
  const select = useDesignStore((state) => state.select);

  const inventory = useInventory();
  const { camera, raycaster, pointer } = useThree();

  const meshRef = useRef<THREE.InstancedMesh>(null);
  const heatmap = inventory.heatmap;
  const binIndexByCode = inventory.index.byBinCode;
  /** A drag must not end as a bin selection — see `useClickNotDrag`. */
  const { onPointerDown: rememberDown, isClick } = useClickNotDrag();

  // Derived with useMemo rather than a selector: a selector returning a new array
  // every call would re-render forever under zustand's Object.is comparison.
  const selectedBinCodes = useMemo(
    () => new Set(selection.filter((ref) => ref.kind === 'bin').map((ref) => ref.id)),
    [selection],
  );

  const { minCapacity, maxCapacity } = useMemo(() => {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const bin of bins) {
      if (bin.capacityM3 < min) min = bin.capacityM3;
      if (bin.capacityM3 > max) max = bin.capacityM3;
    }
    return { minCapacity: min, maxCapacity: max };
  }, [bins]);

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;

    const dummy = new THREE.Object3D();
    const color = new THREE.Color();

    bins.forEach((bin, index) => {
      dummy.position.set(bin.center.x, bin.center.y, bin.center.z);
      dummy.rotation.set(0, THREE.MathUtils.degToRad(bin.rotationDeg), 0);
      dummy.scale.set(bin.widthM, bin.heightM, bin.depthM);
      dummy.updateMatrix();
      mesh.setMatrixAt(index, dummy.matrix);

      if (selectedBinCodes.has(bin.code)) color.set(COLORS.binSelected);
      else if (hoveredBinCode === bin.code) color.set(COLORS.binHover);
      else if (heatmap) color.set(utilizationColor(utilizationOf(binIndexByCode.get(bin.code))));
      else color.copy(capacityColor(bin, minCapacity, maxCapacity));

      mesh.setColorAt(index, color);
    });

    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    // `binIndexByCode` is in the deps so colours refresh after a placement, while the
    // transforms are only rebuilt when the geometry itself changes.
  }, [bins, hoveredBinCode, selectedBinCodes, minCapacity, maxCapacity, heatmap, binIndexByCode]);

  /**
   * Resolve the bin under the pointer while a drag is in flight.
   *
   * Runs in `useFrame` because the palette's drag is not a React event the canvas
   * receives: only R3F's own pointer tracking knows where the cursor is, and it is
   * updated by pointermove events that the palette's drag does not consume.
   */
  useFrame(() => {
    const drag = getInventory().drag;
    if (!drag) {
      if (getInventory().drop) setDropTarget(null);
      return;
    }

    const mesh = meshRef.current;
    if (!mesh) return;

    raycaster.setFromCamera(new THREE.Vector2(pointer.x, pointer.y), camera);
    const hit = raycaster.intersectObject(mesh, false)[0];
    const index = hit?.instanceId;
    const bin = index === undefined ? undefined : bins[index];

    if (!bin) {
      setDropTarget(null);
      return;
    }

    const state = getInventory();
    const sku = skuById(state.index, drag.skuId);
    if (!sku) {
      setDropTarget(null);
      return;
    }

    // A derived bin has no id, so the published row — and with it the id the placement
    // endpoint needs — is found by code. No published row means there is nowhere to
    // place anything yet.
    const entry = state.index.byBinCode.get(bin.code);
    if (!entry) {
      setDropTarget({ binId: '', binCode: bin.code, verdict: NOT_PUBLISHED });
      return;
    }

    // The same arithmetic the server performs, including excluding this SKU's own
    // existing row: a drop replaces that row rather than adding to it.
    const used = usedInBin(entry, { excludeSkuId: sku.id });
    const verdict = checkPlacement(bin, used, sku, drag.qty);

    setDropTarget({ binId: entry.binId, binCode: bin.code, verdict });
  });

  const dropBin = useMemo(
    () => (inventory.drop ? bins.find((bin) => bin.code === inventory.drop?.binCode) : undefined),
    [bins, inventory.drop],
  );

  const hoveredBin = useMemo(
    () => (hoveredBinCode ? bins.find((bin) => bin.code === hoveredBinCode) : undefined),
    [bins, hoveredBinCode],
  );

  if (bins.length === 0) return null;

  const handleMove = (event: { instanceId?: number; stopPropagation: () => void }) => {
    event.stopPropagation();
    if (event.instanceId === undefined) return;
    const bin = bins[event.instanceId];
    if (bin && bin.code !== hoveredBinCode) setHoveredBin(bin.code);
  };

  return (
    <group>
      <instancedMesh
        // The instance count is fixed at construction, so a changed count needs a new mesh.
        key={bins.length}
        ref={meshRef}
        args={[undefined, undefined, bins.length]}
        castShadow
        onPointerDown={rememberDown}
        onPointerMove={handleMove}
        onPointerOut={() => setHoveredBin(null)}
        onClick={(event) => {
          if (!isClick(event)) return;
          event.stopPropagation();
          if (event.instanceId === undefined) return;
          const bin = bins[event.instanceId];
          if (bin) select({ kind: 'bin', id: bin.code, label: bin.code });
        }}
      >
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial vertexColors roughness={0.7} metalness={0.15} />
      </instancedMesh>

      {hoveredBin && (
        <Html
          position={[hoveredBin.center.x, hoveredBin.center.y + hoveredBin.heightM, hoveredBin.center.z]}
          center
          distanceFactor={22}
          style={{ pointerEvents: 'none' }}
        >
          <div className="bin-tooltip">
            <strong>{hoveredBin.code}</strong>
            <span>
              {hoveredBin.widthM} × {hoveredBin.heightM} × {hoveredBin.depthM} m
            </span>
            <span>{hoveredBin.capacityM3} m³ usable</span>
            {hoveredBin.maxWeightKg !== null && <span>≤ {hoveredBin.maxWeightKg} kg</span>}
          </div>
        </Html>
      )}

      {/*
        * The drop ghost. Its colour is the verdict, and a refusal shows the rule code
        * rather than a generic "cannot place" — the same code the server would return,
        * because both sides run the same fit check.
        */}
      {dropBin && inventory.drop && (
        <group
          position={[dropBin.center.x, dropBin.center.y, dropBin.center.z]}
          rotation={[0, THREE.MathUtils.degToRad(dropBin.rotationDeg), 0]}
        >
          <mesh>
            <boxGeometry
              args={[dropBin.widthM * 1.02, dropBin.heightM * 1.02, dropBin.depthM * 1.02]}
            />
            <meshStandardMaterial
              color={inventory.drop.verdict.fits ? '#22c55e' : '#ef4444'}
              transparent
              opacity={0.34}
              depthWrite={false}
            />
          </mesh>
          <Html
            position={[0, dropBin.heightM * 0.75, 0]}
            center
            distanceFactor={20}
            style={{ pointerEvents: 'none' }}
          >
            <div className={`drop-tag${inventory.drop.verdict.fits ? ' drop-tag-ok' : ' drop-tag-no'}`}>
              <strong>{inventory.drop.verdict.fits ? 'Fits' : (inventory.drop.verdict.code ?? 'No')}</strong>
              <span>{dropBin.code}</span>
            </div>
          </Html>
        </group>
      )}
    </group>
  );
}
