/**
 * Operate mode shell.
 *
 * Reads the layout once on entry (and on every re-entry, so a publish made in Design mode
 * shows up), then renders it. Nothing here can edit the layout: `slots` is a derived
 * value and every control is a filter or a view toggle.
 *
 * The source badge is deliberately prominent. "Published v3" and "unsaved working copy"
 * look identical in 3D, and an operator acting on the wrong one is the failure mode worth
 * designing against.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';

import { useSession } from '../design/persistence/session';
import { ManagePanel } from './ManagePanel';
import { loadLayoutSource, refreshLocalSource, useLayoutSource } from './layoutSource';
import WarehouseCanvas, { type OperateFilter } from './WarehouseCanvas';
import { designStore } from '../design/store/designStore';
import './operate.css';

/**
 * The warehouse footprint, read once per render from the store.
 *
 * `useStore` rather than the design package's hook helper, because this is the vanilla
 * store and Operate mode only ever needs this one value from it.
 */
function useDesignStoreWarehouse() {
  return useSyncExternalStore(
    designStore.subscribe,
    () => designStore.getState().history.doc.warehouse,
  );
}

export function OperateWorkspace({ onSwitchMode }: { onSwitchMode: () => void }) {
  const source = useLayoutSource();
  const session = useSession();

  const [selectedBinCode, setSelectedBinCode] = useState<string | null>(null);
  const [filter, setFilter] = useState<OperateFilter>('all');
  const [showPath, setShowPath] = useState(false);

  const warehouse = useDesignStoreWarehouse();

  // Load on entry. Deliberately keyed on the mode being entered rather than on the
  // session, so returning from Design mode always re-reads what was published.
  useEffect(() => {
    void loadLayoutSource();
  }, []);

  // While nothing is published the viewer follows the editor, so the two modes can be
  // compared without publishing first.
  useEffect(() => {
    if (source.mode !== 'local') return;
    return designStore.subscribe(() => refreshLocalSource());
  }, [source.mode]);

  const selectedSlot =
    selectedBinCode === null
      ? null
      : (source.slots.find((slot) => slot.binCode === selectedBinCode) ?? null);

  const sourceLabel =
    source.mode === 'published'
      ? `Published v${source.version ?? '?'}`
      : session.connected
        ? 'Working copy (not published)'
        : 'Working copy (offline)';

  const footprint = {
    originX: warehouse.origin.x,
    originZ: warehouse.origin.z,
    lengthM: warehouse.lengthM,
    widthM: warehouse.widthM,
  };

  return (
    <div className="operate-root">
      <header className="operate-topbar">
        <div className="operate-brand">
          <strong>Warehouse Operations</strong>
          <span className={`operate-source operate-source-${source.mode}`}>{sourceLabel}</span>
          {source.warehouseCode && <span className="operate-code">{source.warehouseCode}</span>}
        </div>

        <div className="topbar-spacer" />

        {source.docHash && (
          <span className="operate-hash" title={`docHash ${source.docHash}`}>
            {source.docHash.slice(0, 10)}…
          </span>
        )}

        <button
          className={`button${showPath ? ' button-active' : ''}`}
          onClick={() => setShowPath((value) => !value)}
          title="Show a serpentine picking route through the real aisles"
        >
          {showPath ? 'Hide route' : 'Show route'}
        </button>

        <button className="button" disabled={source.loading} onClick={() => void loadLayoutSource()}>
          {source.loading ? 'Reloading…' : 'Reload'}
        </button>

        <button className="button" onClick={onSwitchMode}>
          ← Back to design
        </button>
      </header>

      {source.error && (
        <div className="outcome-notice" role="status">
          <strong>{source.error.code}</strong>
          <span>{source.error.message}</span>
        </div>
      )}

      {source.conflicts.length > 0 && (
        <div className="outcome-notice" role="status">
          <strong>Compiler drift</strong>
          <span>{source.conflicts.join(' ')}</span>
        </div>
      )}

      <div className="operate-body-wrap">
        <ManagePanel
          slots={source.slots}
          summary={source.summary}
          selectedSlot={selectedSlot}
          activeFilter={filter}
          onFilterChange={setFilter}
          onDeselect={() => setSelectedBinCode(null)}
          sourceLabel={sourceLabel}
        />

        <div className="operate-canvas">
          <WarehouseCanvas
            slots={source.slots}
            activeFilter={filter}
            showPath={showPath}
            selectedSlotId={selectedBinCode}
            onSelectSlot={(slot) => setSelectedBinCode(slot?.binCode ?? null)}
            footprint={footprint}
            revision={source.revision}
          />

          <div className="canvas-hint">
            Hover a bin to preview · Click to inspect · Drag to orbit · Scroll to zoom
          </div>
        </div>
      </div>
    </div>
  );
}
