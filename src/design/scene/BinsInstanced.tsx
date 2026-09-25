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
import { getInventory, setDropTarget, useInventory } from '../persistence/inventoryStore';
import { useClickNotDrag } from './useClickNotDrag';

/** Reused across the colour pass, so 100k bins cost no allocations. */
const CAPACITY_COLD = new THREE.Color(COLORS.bin);
const CAPACITY_WARM = new THREE.Color('#dbe4ef');

function capacityColor(
  target: THREE.Color,
  bin: DerivedBin,
  minCapacity: number,
  maxCapacity: number,
): THREE.Color {
  const span = maxCapacity - minCapacity;
  const t = span > 1e-9 ? (bin.capacityM3 - minCapacity) / span : 0;
  // 0 -> slate, 1 -> warm. Uses three's own lerp so it stays in the sRGB working space.
  return target.copy(CAPACITY_COLD).lerp(CAPACITY_WARM, t * 0.75 + 0.1);
}

/** How many selected bins get an outline mesh before the rest fall back to the base colour. */
const MAX_SELECTED_OUTLINES = 64;

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

  /**
   * Two separate passes on purpose.
   *
   * Transforms only change when the *geometry* changes; colours change on hover, on
   * selection, and after a placement. Doing both in one effect meant every pointer move
   * rebuilt 100k matrices — the exact cost the instanced mesh exists to avoid. The
   * transforms are now rebuilt on a layout edit, and a hover touches nothing but an
   * overlay mesh.
   */
  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;

    const dummy = new THREE.Object3D();
    bins.forEach((bin, index) => {
      dummy.position.set(bin.center.x, bin.center.y, bin.center.z);
      dummy.rotation.set(0, THREE.MathUtils.degToRad(bin.rotationDeg), 0);
      dummy.scale.set(bin.widthM, bin.heightM, bin.depthM);
      dummy.updateMatrix();
      mesh.setMatrixAt(index, dummy.matrix);
    });

    mesh.instanceMatrix.needsUpdate = true;
    // The bounding sphere has to be recomputed or a large layout gets frustum-culled
    // from the wrong centre.
    mesh.computeBoundingSphere();
  }, [bins]);

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;

    const color = new THREE.Color();
    bins.forEach((bin, index) => {
      if (heatmap) color.set(utilizationColor(utilizationOf(binIndexByCode.get(bin.code))));
      else capacityColor(color, bin, minCapacity, maxCapacity);

      mesh.setColorAt(index, color);
    });

    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    // `binIndexByCode` is in the deps so colours refresh after a placement.
  }, [bins, heatmap, binIndexByCode, minCapacity, maxCapacity]);

  /**
   * Selected bins, as outlines.
   *
   * Kept out of the instance buffer for the same reason as hover: a selection change
   * would otherwise rewrite every colour. Capped, because a bulk selection is aimed at
   * thousands of bins and one mesh each would be worse than the problem it solves.
   */
  const selectedBins = useMemo(() => {
    if (selectedBinCodes.size === 0) return [];
    const found: DerivedBin[] = [];
    for (const bin of bins) {
      if (selectedBinCodes.has(bin.code)) {
        found.push(bin);
        if (found.length >= MAX_SELECTED_OUTLINES) break;
      }
    }
    return found;
  }, [bins, selectedBinCodes]);

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
        {/*
          * No `vertexColors` here. It makes three define `USE_COLOR`, which reads the
          * geometry's `color` attribute — and a boxGeometry has none, so WebGL feeds
          * the shader the default generic attribute (0, 0, 0) and every bin renders
          * black. Per-instance colours only need `USE_INSTANCING_COLOR`, which three
          * enables by itself once `setColorAt` has created the instance colour buffer.
          */}
        <meshStandardMaterial roughness={0.7} metalness={0.15} />
      </instancedMesh>

      {/*
        * Hover and selection are drawn *over* the instances rather than written into
        * their colour buffer. A pointer move therefore costs one mesh instead of
        * rewriting (and re-uploading) every instance colour in the layout.
        */}
      {hoveredBin && (
        <mesh
          position={[hoveredBin.center.x, hoveredBin.center.y, hoveredBin.center.z]}
          rotation={[0, THREE.MathUtils.degToRad(hoveredBin.rotationDeg), 0]}
        >
          <boxGeometry
            args={[hoveredBin.widthM * 1.04, hoveredBin.heightM * 1.04, hoveredBin.depthM * 1.04]}
          />
          <meshStandardMaterial
            color={COLORS.binHover}
            emissive={COLORS.binHover}
            emissiveIntensity={0.35}
            transparent
            opacity={0.55}
            depthWrite={false}
          />
        </mesh>
      )}

      {selectedBins.map((bin) => (
        <mesh
          key={`sel-${bin.code}`}
          position={[bin.center.x, bin.center.y, bin.center.z]}
          rotation={[0, THREE.MathUtils.degToRad(bin.rotationDeg), 0]}
        >
          <boxGeometry args={[bin.widthM * 1.06, bin.heightM * 1.06, bin.depthM * 1.06]} />
          <meshStandardMaterial
            color={COLORS.binSelected}
            emissive={COLORS.binSelected}
            emissiveIntensity={0.4}
            transparent
            opacity={0.7}
            depthWrite={false}
          />
        </mesh>
      ))}

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
