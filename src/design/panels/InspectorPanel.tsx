/**
 * The numeric inspector — authoritative over the 3D view (P12).
 *
 * If the inspector and the canvas ever disagree, the inspector is right: dragging
 * is a coarse gesture, typing is exact. Every field commits a command, so every
 * edit is undoable and nothing bypasses the document.
 *
 * Inline inputs use `key={value}` + `defaultValue` rather than a controlled value.
 * That commits on blur instead of per keystroke (one history entry per edit, not
 * one per character) while still refreshing when an undo or a drag changes the
 * underlying value, because the changing key remounts the input.
 */
import { useMemo } from 'react';

import {
  laneStackHeightM,
  type Aisle,
  type Lane,
  type LayoutDoc,
  type ObstacleKind,
  type RackLevel,
} from 'layout-core';

import { useDesignStore } from '../store/designStore';
import { removePlacement, useInventory } from '../persistence/inventoryStore';
import { laneStatsOf, useLaneStats } from './laneStats';
import { InlineNumber, NumberField, Readout, TextField } from './NumberField';
import { SegmentsEditor } from './SegmentsEditor';
import { SkipBaysEditor } from './SkipBaysEditor';
import { SkuPalette } from './SkuPalette';
import { StructurePanel } from './StructurePanel';

// ── Sections ────────────────────────────────────────────────────────────────

function WarehouseSection() {
  const warehouse = useDesignStore((state) => state.history.doc.warehouse);
  const dispatch = useDesignStore((state) => state.dispatch);

  return (
    <div className="section">
      <h3 className="section-title">
        Warehouse
        <span className="section-title-tag">{warehouse.code}</span>
      </h3>

      <TextField
        label="Name"
        value={warehouse.name}
        onCommit={(name) => dispatch({ type: 'warehouse.update', patch: { name } })}
      />
      <NumberField
        label="Length (X)"
        unit="m"
        step={1}
        min={1}
        value={warehouse.lengthM}
        onCommit={(lengthM) => dispatch({ type: 'warehouse.update', patch: { lengthM } })}
      />
      <NumberField
        label="Width (Z)"
        unit="m"
        step={1}
        min={1}
        value={warehouse.widthM}
        onCommit={(widthM) => dispatch({ type: 'warehouse.update', patch: { widthM } })}
      />
      <NumberField
        label="Clear height"
        unit="m"
        step={0.5}
        min={0.5}
        value={warehouse.heightM}
        onCommit={(heightM) => dispatch({ type: 'warehouse.update', patch: { heightM } })}
        hint="Every rack stack must fit inside this."
      />
      <NumberField
        label="Origin X"
        unit="m"
        step={1}
        value={warehouse.origin.x}
        onCommit={(x) =>
          dispatch({ type: 'warehouse.update', patch: { origin: { ...warehouse.origin, x } } })
        }
        hint="Moves the whole footprint; the layout inside it is unaffected."
      />
      <NumberField
        label="Origin Z"
        unit="m"
        step={1}
        value={warehouse.origin.z}
        onCommit={(z) =>
          dispatch({ type: 'warehouse.update', patch: { origin: { ...warehouse.origin, z } } })
        }
      />
    </div>
  );
}

function AisleSection({ aisle }: { aisle: Aisle }) {
  const dispatch = useDesignStore((state) => state.dispatch);
  const snapM = useDesignStore((state) => state.snapM);

  const alongX = Math.abs(aisle.centerline.x2 - aisle.centerline.x1)
    >= Math.abs(aisle.centerline.z2 - aisle.centerline.z1);

  const patchCenterline = (next: Partial<Aisle['centerline']>) => {
    dispatch({
      type: 'aisle.update',
      aisleId: aisle.id,
      patch: { centerline: { ...aisle.centerline, ...next } },
    });
  };

  return (
    <div className="section">
      <h3 className="section-title">
        Aisle
        <span className="section-title-tag">{alongX ? 'runs along X' : 'runs along Z'}</span>
      </h3>

      <Readout
        rows={[
          ['Orientation', `${alongX ? 'X' : 'Z'} (derived from the centerline)`],
          ['Run length', `${Math.abs(aisle.centerline.x2 - aisle.centerline.x1).toFixed(2)} m`],
          ['Lanes', `${aisle.lanes.length}`],
        ]}
      />

      <div style={{ height: 8 }} />

      <NumberField
        label="Corridor width"
        unit="m"
        min={0.5}
        value={aisle.widthM}
        onCommit={(widthM) =>
          dispatch({ type: 'aisle.update', aisleId: aisle.id, patch: { widthM } })
        }
        hint="Clear width between the two rack faces."
      />

      {alongX ? (
        <>
          <NumberField
            label="Start X"
            unit="m"
            step={snapM}
            value={aisle.centerline.x1}
            onCommit={(x1) => patchCenterline({ x1 })}
          />
          <NumberField
            label="End X"
            unit="m"
            step={snapM}
            value={aisle.centerline.x2}
            onCommit={(x2) => patchCenterline({ x2 })}
          />
          <NumberField
            label="Centre Z"
            unit="m"
            step={snapM}
            value={aisle.centerline.z1}
            onCommit={(z) => patchCenterline({ z1: z, z2: z })}
            hint="Both ends move together, so the aisle stays axis-aligned."
          />
        </>
      ) : (
        <>
          <NumberField
            label="Centre X"
            unit="m"
            step={snapM}
            value={aisle.centerline.x1}
            onCommit={(x) => patchCenterline({ x1: x, x2: x })}
          />
          <NumberField
            label="Start Z"
            unit="m"
            step={snapM}
            value={aisle.centerline.z1}
            onCommit={(z1) => patchCenterline({ z1 })}
          />
          <NumberField
            label="End Z"
            unit="m"
            step={snapM}
            value={aisle.centerline.z2}
            onCommit={(z2) => patchCenterline({ z2 })}
          />
        </>
      )}

      <label className="field">
        <span className="field-label">Travel</span>
        <span className="field-input">
          <select
            className="select"
            style={{ width: '100%' }}
            value={aisle.travelDirection}
            onChange={(event) =>
              dispatch({
                type: 'aisle.update',
                aisleId: aisle.id,
                patch: {
                  travelDirection: event.target.value as Aisle['travelDirection'],
                },
              })
            }
          >
            <option value="BOTH">Both directions</option>
            <option value="FORWARD">One way (forward)</option>
            <option value="REVERSE">One way (reverse)</option>
          </select>
        </span>
      </label>
    </div>
  );
}

function LevelTable({ lane }: { lane: Lane }) {
  const dispatch = useDesignStore((state) => state.dispatch);
  const warehouseHeightM = useDesignStore((state) => state.history.doc.warehouse.heightM);

  const stack = laneStackHeightM(lane.levels);
  const overHeight = stack > warehouseHeightM;

  // Running top of each level, accumulated exactly as the compiler does
  // (beam, then clear) — so this column cannot disagree with the bins it produces.
  const tops: number[] = [];
  let running = 0;
  for (const level of lane.levels) {
    running += level.beamHeightM + level.clearHeightM;
    tops.push(running);
  }

  const setLevel = (levelIndex: number, patch: Partial<RackLevel>) =>
    dispatch({ type: 'lane.setLevel', laneId: lane.id, levelIndex, patch });

  return (
    <>
      <div className="level-head">
        <span>#</span>
        <span>Clear</span>
        <span>Depth</span>
        <span>Beam</span>
        <span>Max kg</span>
        <span>Top</span>
        <span />
      </div>

      {lane.levels.map((level, index) => (
        <div className="level-row" key={index}>
          <span className="level-index">{index + 1}</span>
          <InlineNumber
            label={`Level ${index + 1} clear height`}
            value={level.clearHeightM}
            min={0.05}
            onCommit={(clearHeightM) => clearHeightM && setLevel(index, { clearHeightM })}
          />
          <InlineNumber
            label={`Level ${index + 1} bin depth`}
            value={level.binDepthM}
            min={0.05}
            onCommit={(binDepthM) => binDepthM && setLevel(index, { binDepthM })}
          />
          <InlineNumber
            label={`Level ${index + 1} beam height`}
            value={level.beamHeightM}
            min={0}
            onCommit={(beamHeightM) => beamHeightM !== null && setLevel(index, { beamHeightM })}
          />
          <InlineNumber
            label={`Level ${index + 1} weight limit`}
            value={level.maxWeightKg ?? null}
            step={25}
            min={0}
            placeholder="—"
            onCommit={(maxWeightKg) =>
              setLevel(index, { maxWeightKg: maxWeightKg && maxWeightKg > 0 ? maxWeightKg : undefined })
            }
          />
          <span className={`level-top${tops[index]! > warehouseHeightM ? ' level-top-over' : ''}`}>
            {tops[index]!.toFixed(2)}
          </span>
          <button
            className="icon-button"
            title="Delete level"
            disabled={lane.levels.length <= 1}
            onClick={() => dispatch({ type: 'lane.removeLevel', laneId: lane.id, levelIndex: index })}
          >
            ×
          </button>
        </div>
      ))}

      <button
        className="button"
        style={{ marginTop: 6, width: '100%' }}
        onClick={() => dispatch({ type: 'lane.addLevel', laneId: lane.id })}
      >
        + Add level
      </button>

      <div className={`stack-summary${overHeight ? ' stack-summary-over' : ''}`}>
        <span>Stack height</span>
        <strong>
          {stack.toFixed(2)} m / {warehouseHeightM.toFixed(2)} m
        </strong>
      </div>
      {overHeight && (
        <div className="field-message" style={{ marginTop: 4 }}>
          Exceeds the building by {(stack - warehouseHeightM).toFixed(2)} m. This blocks publishing.
        </div>
      )}
    </>
  );
}

function LaneSection({ aisle, lane }: { aisle: Aisle; lane: Lane }) {
  const dispatch = useDesignStore((state) => state.dispatch);
  const rackTypes = useDesignStore((state) => state.history.doc.rackTypes);
  const stats = useLaneStats();
  const laneStats = laneStatsOf(stats, lane.code);

  const rackType = rackTypes.find((candidate) => candidate.id === lane.rackTypeId);

  return (
    <div className="section">
      <h3 className="section-title">
        Lane
        <span className="section-title-tag">
          {lane.code} · {aisle.code}
        </span>
      </h3>

      <TextField
        label="Code"
        value={lane.code}
        onCommit={(code) => dispatch({ type: 'lane.update', laneId: lane.id, patch: { code } })}
      />

      <label className="field">
        <span className="field-label">Side</span>
        <span className="field-input">
          <select
            className="select"
            style={{ width: '100%' }}
            value={lane.side}
            onChange={(event) =>
              dispatch({
                type: 'lane.update',
                laneId: lane.id,
                patch: { side: event.target.value as Lane['side'] },
              })
            }
          >
            <option value="LEFT">Left of the corridor</option>
            <option value="RIGHT">Right of the corridor</option>
          </select>
        </span>
      </label>

      <label className="field">
        <span className="field-label">Rack type</span>
        <span className="field-input">
          <select
            className="select"
            style={{ width: '100%' }}
            value={lane.rackTypeId}
            onChange={(event) =>
              dispatch({
                type: 'lane.update',
                laneId: lane.id,
                patch: { rackTypeId: event.target.value },
              })
            }
          >
            {rackTypes.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.code} — {candidate.bayWidthM} m bays
              </option>
            ))}
            {!rackType && <option value={lane.rackTypeId}>{lane.rackTypeId} (missing)</option>}
          </select>
        </span>
      </label>

      <NumberField
        label="Run length"
        unit="m"
        step={rackType?.bayWidthM ?? 2.7}
        min={0.1}
        value={lane.lengthM}
        onCommit={(lengthM) => dispatch({ type: 'lane.update', laneId: lane.id, patch: { lengthM } })}
        hint="Shortening a lane clamps its runs; bays are re-derived."
      />
      <NumberField
        label="Start offset"
        unit="m"
        value={lane.startOffsetM}
        min={0}
        onCommit={(startOffsetM) =>
          dispatch({ type: 'lane.update', laneId: lane.id, patch: { startOffsetM } })
        }
        hint="Distance from the aisle's start to the first bay."
      />

      <Readout
        rows={[
          ['Bay width', rackType ? `${rackType.bayWidthM} m` : 'unknown'],
          ['Bays in service', `${laneStats.activeBays} of ${laneStats.bays.length}`],
          ['Bins produced', `${laneStats.bins} (${laneStats.activeBays} bays × ${lane.levels.length} levels)`],
        ]}
      />

      <div style={{ height: 12 }} />
      <h4 className="section-title">Rack runs</h4>
      <SegmentsEditor lane={lane} stats={laneStats} />

      <div style={{ height: 12 }} />
      <h4 className="section-title">
        Reserved bays
        <span className="section-title-tag">{laneStats.skipped}</span>
      </h4>
      <SkipBaysEditor lane={lane} stats={laneStats} />

      <div style={{ height: 12 }} />
      <h4 className="section-title">Levels</h4>
      <LevelTable lane={lane} />

      <button
        className="button"
        style={{ width: '100%', marginTop: 14 }}
        onClick={() => dispatch({ type: 'lane.remove', laneId: lane.id })}
      >
        Delete this lane
      </button>
    </div>
  );
}

function BinSection({ code }: { code: string }) {
  const bin = useDesignStore((state) => state.graph.bins.find((candidate) => candidate.code === code));
  const inventory = useInventory();
  const select = useDesignStore((state) => state.select);

  // Inventory is keyed by bin *id*, but the scene selects bins by code, so the lookup
  // goes through the code map.
  const contents = inventory.warehouseId ? inventory.index.byBinCode.get(code) : undefined;

  if (!bin) {
    return (
      <div className="section">
        <h3 className="section-title">Bin</h3>
        <div className="empty-hint">
          Bin <code>{code}</code> is no longer produced by the current layout.
        </div>
      </div>
    );
  }

  return (
    <div className="section">
      <h3 className="section-title">
        Bin
        <span className="section-title-tag">derived</span>
      </h3>
      <Readout
        rows={[
          ['Code', bin.code],
          ['Aisle / lane', `${bin.aisleCode} / ${bin.laneCode}`],
          ['Side', bin.side === 'LEFT' ? 'Left' : 'Right'],
          ['Bay', `${bin.baySeq} (1-based)`],
          ['Level', `${bin.levelIndex + 1}`],
          ['Centre', `${bin.center.x}, ${bin.center.y}, ${bin.center.z} m`],
          ['Opening', `${bin.widthM} × ${bin.heightM} × ${bin.depthM} m`],
          ['Usable volume', `${bin.capacityM3} m³`],
          ['Weight limit', bin.maxWeightKg === null ? 'none' : `${bin.maxWeightKg} kg`],
        ]}
      />

      {contents && (
        <>
          <div style={{ height: 12 }} />
          <h4 className="section-title">
            Contents
            <span className="section-title-tag">{contents.placements.length}</span>
          </h4>

          <div className="utilisation-bar" title={`${contents.utilization * 100}% of usable volume`}>
            <span style={{ width: `${Math.min(contents.utilization, 1) * 100}%` }} />
          </div>
          <Readout
            rows={[
              [
                'Volume',
                `${contents.usedVolumeM3.toFixed(3)} / ${contents.capacityM3} m³`,
              ],
              [
                'Weight',
                contents.maxWeightKg === null
                  ? `${contents.usedWeightKg.toFixed(0)} kg (no limit)`
                  : `${contents.usedWeightKg.toFixed(0)} / ${contents.maxWeightKg} kg`,
              ],
            ]}
          />

          {contents.placements.length === 0 && (
            <div className="empty-hint">
              Empty. Drag a SKU from the inventory list onto this bin in the 3D view.
            </div>
          )}

          {contents.placements.map((placement) => (
            <div className="placement-row" key={placement.id}>
              <span>
                <strong>{placement.sku}</strong>
                <span className="sku-meta">
                  {placement.qty} × · {placement.volumeUsedM3} m³ · {placement.weightUsedKg} kg
                </span>
              </span>
              <button
                className="icon-button"
                title="Remove this placement"
                onClick={() => void removePlacement(placement.id)}
              >
                ×
              </button>
            </div>
          ))}
        </>
      )}

      {!contents && inventory.warehouseId && (
        <div className="field-hint" style={{ marginTop: 8 }}>
          This bin is not in the published layout, so inventory cannot be placed in it.
          Publish to make it assignable.
        </div>
      )}

      <div className="field-hint" style={{ marginTop: 8 }}>
        Bins are derived from the lane, bay and level — edit those to change them.
      </div>
      {contents && contents.placements.length > 0 && (
        <button
          className="button"
          style={{ width: '100%', marginTop: 8 }}
          onClick={() => select({ kind: 'bin', id: bin.code, label: bin.code })}
        >
          Keep selected
        </button>
      )}
    </div>
  );
}

function ObstacleSection({ obstacleId }: { obstacleId: string }) {
  const obstacle = useDesignStore((state) =>
    state.history.doc.obstacles.find((candidate) => candidate.id === obstacleId),
  );
  const dispatch = useDesignStore((state) => state.dispatch);

  if (!obstacle) return null;

  const patch = (values: Record<string, unknown>) =>
    dispatch({ type: 'obstacle.update', obstacleId: obstacle.id, patch: values });

  return (
    <div className="section">
      <h3 className="section-title">
        Obstacle
        <span className="section-title-tag">{obstacle.kind.toLowerCase()}</span>
      </h3>

      <label className="field">
        <span className="field-label">Kind</span>
        <span className="field-input">
          <select
            className="select"
            style={{ width: '100%' }}
            value={obstacle.kind}
            onChange={(event) => patch({ kind: event.target.value as ObstacleKind })}
          >
            {(['COLUMN', 'PILLAR', 'WALL', 'OFFICE', 'CUSTOM'] as const).map((kind) => (
              <option key={kind} value={kind}>
                {kind.toLowerCase()}
              </option>
            ))}
          </select>
        </span>
      </label>

      <NumberField label="X" unit="m" value={obstacle.x} onCommit={(x) => patch({ x })} />
      <NumberField label="Z" unit="m" value={obstacle.z} onCommit={(z) => patch({ z })} />
      <NumberField
        label="Width"
        unit="m"
        min={0.1}
        value={obstacle.widthM}
        onCommit={(widthM) => patch({ widthM })}
      />
      <NumberField
        label="Depth"
        unit="m"
        min={0.1}
        value={obstacle.depthM}
        onCommit={(depthM) => patch({ depthM })}
      />
      <NumberField
        label="Height"
        unit="m"
        min={0.1}
        value={obstacle.heightM}
        onCommit={(heightM) => patch({ heightM })}
      />
    </div>
  );
}

function RackTypesSection({ doc }: { doc: LayoutDoc }) {
  const dispatch = useDesignStore((state) => state.dispatch);

  return (
    <div className="section">
      <h3 className="section-title">
        Rack types
        <span className="section-title-tag">{doc.rackTypes.length}</span>
      </h3>

      {doc.rackTypes.map((rackType) => (
        <div key={rackType.id} style={{ marginBottom: 10 }}>
          <Readout
            rows={[
              ['Code', rackType.code],
              ['Frame depth', `${rackType.depthM} m`],
            ]}
          />
          <NumberField
            label="Bay width"
            unit="m"
            step={0.1}
            min={0.1}
            value={rackType.bayWidthM}
            onCommit={(bayWidthM) =>
              dispatch({ type: 'rackType.update', rackTypeId: rackType.id, patch: { bayWidthM } })
            }
          />
        </div>
      ))}

      <button
        className="button"
        style={{ width: '100%' }}
        onClick={() => {
          const n = doc.rackTypes.length + 1;
          dispatch({
            type: 'rackType.add',
            rackType: {
              code: `RT${n}`,
              name: `Rack type ${n}`,
              bayWidthM: 2.7,
              depthM: 1.1,
            },
          });
        }}
      >
        + Add rack type
      </button>
    </div>
  );
}

// ── Panel ───────────────────────────────────────────────────────────────────

export function InspectorPanel() {
  const selection = useDesignStore((state) => state.selection);
  const doc = useDesignStore((state) => state.history.doc);

  const ref = selection[0];

  const laneHit = useMemo(() => {
    if (ref?.kind !== 'lane') return undefined;
    for (const aisle of doc.aisles) {
      const lane = aisle.lanes.find((candidate) => candidate.id === ref.id);
      if (lane) return { aisle, lane };
    }
    return undefined;
  }, [doc, ref]);

  const aisle = ref?.kind === 'aisle' ? doc.aisles.find((candidate) => candidate.id === ref.id) : undefined;

  return (
    <div className="side-panel side-panel-left">
      <WarehouseSection />
      <StructurePanel />
      <SkuPalette />

      {selection.length === 0 && (
        <div className="section">
          <h3 className="section-title">Selection</h3>
          <div className="empty-hint">
            Pick an aisle or a lane from the structure list, or click a rack, a bin or a column
            in the 3D view.
            <br />
            Drag a corridor slab to move an aisle.
          </div>
        </div>
      )}

      {selection.length > 1 && (
        <div className="section">
          <h3 className="section-title">Multiple selected</h3>
          <div className="empty-hint">{selection.length} objects selected.</div>
        </div>
      )}

      {aisle && <AisleSection aisle={aisle} />}
      {laneHit && <LaneSection aisle={laneHit.aisle} lane={laneHit.lane} />}
      {ref?.kind === 'bin' && <BinSection code={ref.id} />}
      {ref?.kind === 'obstacle' && <ObstacleSection obstacleId={ref.id} />}

      <RackTypesSection doc={doc} />
    </div>
  );
}
