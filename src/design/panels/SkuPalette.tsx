/**
 * SKU palette and placement tools.
 *
 * The palette is the drag source. Rather than HTML5 drag-and-drop — which R3F cannot
 * raycast against — a pointer drag is used: the palette records which SKU is in flight,
 * the canvas resolves the bin under the cursor from R3F's own pointer, and the drop is
 * committed from here. That keeps hit-testing in the renderer that already has the
 * instanced bins and their transforms.
 *
 * Bulk fill lives here too, because the plan's position is that dragging thousands of
 * items in 3D is not viable: past a threshold you select bins and fill them.
 */
import { useEffect, useState } from 'react';

import type { SkuDto, SkuInput } from '../persistence/apiClient';
import {
  bulkFill,
  cancelDrag,
  commitDrop,
  createSku,
  deleteSku,
  setHeatmap,
  setDragQuantity,
  startDrag,
  updateSku,
  useInventory,
} from '../persistence/inventoryStore';
import { useDesignStore } from '../store/designStore';

const BLANK: SkuInput = {
  sku: '',
  name: '',
  widthM: 1.2,
  heightM: 1.0,
  depthM: 0.8,
  weightKg: 250,
  stackable: true,
  rotatable: true,
  hazmat: false,
};

function SkuForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: SkuInput;
  submitLabel: string;
  onSubmit: (payload: SkuInput) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<SkuInput>(initial);

  const number = (field: keyof SkuInput, value: string) =>
    setDraft((current) => ({ ...current, [field]: Number(value) }));

  return (
    <div className="sku-form">
      <label className="field">
        <span className="field-label">Code</span>
        <span className="field-input">
          <input
            value={draft.sku}
            aria-label="SKU code"
            onChange={(event) => setDraft({ ...draft, sku: event.target.value })}
          />
        </span>
      </label>
      <label className="field">
        <span className="field-label">Name</span>
        <span className="field-input">
          <input
            value={draft.name}
            aria-label="SKU name"
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          />
        </span>
      </label>

      <div className="sku-dimensions">
        {(['widthM', 'heightM', 'depthM', 'weightKg'] as const).map((field) => (
          <label className="field" key={field}>
            <span className="field-label">
              {field === 'weightKg' ? 'kg' : field.replace('M', '')}
            </span>
            <span className="field-input">
              <input
                type="number"
                step={field === 'weightKg' ? 10 : 0.05}
                min={0}
                value={draft[field]}
                aria-label={field}
                onChange={(event) => number(field, event.target.value)}
              />
            </span>
          </label>
        ))}
      </div>

      <label className="sku-check">
        <input
          type="checkbox"
          checked={draft.rotatable}
          onChange={(event) => setDraft({ ...draft, rotatable: event.target.checked })}
        />
        May be rotated to fit
      </label>

      <div className="row-actions">
        <button
          className="button button-primary"
          disabled={draft.sku.trim().length === 0}
          onClick={() => onSubmit({ ...draft, sku: draft.sku.trim() })}
        >
          {submitLabel}
        </button>
        <button className="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function SkuRow({
  sku,
  onEdit,
  onDelete,
  selected,
  onSelect,
}: {
  sku: SkuDto;
  onEdit: () => void;
  onDelete: () => void;
  selected: boolean;
  onSelect: () => void;
}) {
  const inventory = useInventory();
  const dragging = inventory.drag?.skuId === sku.id;

  return (
    <div className={`sku-row${selected ? ' sku-row-selected' : ''}`}>
      <button
        className="sku-grip"
        title={
          inventory.warehouseId
            ? 'Drag onto a bin to place, or click to select for a bulk fill'
            : 'Connect to a server to place inventory'
        }
        disabled={!inventory.warehouseId}
        onPointerDown={() => {
          onSelect();
          if (inventory.warehouseId) startDrag(sku.id, 1);
        }}
      >
        <span className="sku-swatch" />
        <span className="sku-body">
          <strong>{sku.sku}</strong>
          <span className="sku-meta">
            {sku.widthM} × {sku.heightM} × {sku.depthM} m · {sku.weightKg} kg
            {sku.placedQty > 0 ? ` · ${sku.placedQty} placed` : ''}
            {sku.rotatable ? '' : ' · fixed'}
          </span>
        </span>
      </button>

      <span className="tree-actions">
        <button className="icon-button icon-button-text" title="Edit" onClick={onEdit}>
          ✎
        </button>
        <button className="icon-button" title="Delete" onClick={onDelete}>
          ×
        </button>
      </span>

      {dragging && (
        <span className="sku-dragging">
          Dragging {sku.sku} — release over a bin
          <button className="icon-button" title="Cancel" onClick={cancelDrag}>
            ×
          </button>
        </span>
      )}
    </div>
  );
}

export function SkuPalette() {
  const inventory = useInventory();
  const selection = useDesignStore((state) => state.selection);
  const select = useDesignStore((state) => state.select);

  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [qty, setQty] = useState(1);
  const [bulkQty, setBulkQty] = useState(1);
  const [focusSkuId, setFocusSkuId] = useState<string | null>(null);
  const [bulkResult, setBulkResult] = useState<string | null>(null);

  // The drag is driven by window events, because the pointer leaves the palette.
  useEffect(() => {
    if (!inventory.drag) return;

    const onUp = () => void commitDrop();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') cancelDrag();
    };

    window.addEventListener('pointerup', onUp);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('keydown', onKey);
    };
  }, [inventory.drag]);

  const selectedBins = selection.filter((ref) => ref.kind === 'bin').map((ref) => ref.id);

  if (!inventory.warehouseId) {
    return (
      <div className="section">
        <h3 className="section-title">
          Inventory
          <span className="section-title-tag">local</span>
        </h3>
        <div className="empty-hint">
          Inventory lives with the published layout, so connect to a server first. Use
          <strong> Save to server</strong> in the toolbar, then publish.
        </div>
      </div>
    );
  }

  const busy = inventory.busy || inventory.loading;

  return (
    <div className="section">
      <h3 className="section-title">
        Inventory
        <span className="section-title-tag">
          {inventory.index.skus.length} SKU{inventory.index.skus.length === 1 ? '' : 's'}
        </span>
      </h3>

      {inventory.error && <div className="field-message">{inventory.error}</div>}
      {inventory.notice && <div className="field-message">{inventory.notice}</div>}
      {bulkResult && <div className="field-hint">{bulkResult}</div>}

      {inventory.index.skus.length === 0 && !adding && !inventory.loading && (
        <div className="empty-hint">
          No SKUs yet. A SKU is the item you place into bins; its dimensions decide what
          fits where.
        </div>
      )}

      {inventory.index.skus.map((sku) =>
        editing === sku.id ? (
          <SkuForm
            key={sku.id}
            initial={{
              sku: sku.sku,
              name: sku.name,
              widthM: sku.widthM,
              heightM: sku.heightM,
              depthM: sku.depthM,
              weightKg: sku.weightKg,
              stackable: sku.stackable,
              rotatable: sku.rotatable,
              hazmat: sku.hazmat,
            }}
            submitLabel="Save"
            onCancel={() => setEditing(null)}
            onSubmit={(payload) => {
              void updateSku(sku.id, payload).then(() => setEditing(null));
            }}
          />
        ) : (
          <SkuRow
            key={sku.id}
            sku={sku}
            selected={focusSkuId === sku.id}
            onSelect={() => setFocusSkuId(sku.id)}
            onEdit={() => setEditing(sku.id)}
            onDelete={() => void deleteSku(sku.id)}
          />
        ),
      )}

      {adding ? (
        <SkuForm
          initial={BLANK}
          submitLabel="Add"
          onCancel={() => setAdding(false)}
          onSubmit={(payload) => {
            void createSku(payload).then((ok) => ok && setAdding(false));
          }}
        />
      ) : (
        <button className="button" style={{ width: '100%' }} onClick={() => setAdding(true)}>
          + Add SKU
        </button>
      )}

      <div className="sku-tools">
        <div className="sku-tool-row">
          <span className="field-label">Quantity per drop</span>
          <input
            className="sku-qty"
            type="number"
            min={1}
            value={qty}
            aria-label="Quantity per drop"
            onChange={(event) => {
              const next = Math.max(1, Number(event.target.value));
              setQty(next);
              setDragQuantity(next);
            }}
          />
        </div>
        <p className="field-hint">
          Drag a SKU onto a bin in the 3D view. Green means it fits; the code on a red
          ghost is the one the server would return.
        </p>

        <div className="sku-tool-row">
          <span className="field-label">
            Bulk fill {selectedBins.length > 0 ? `(${selectedBins.length} selected)` : ''}
          </span>
          <input
            className="sku-qty"
            type="number"
            min={1}
            value={bulkQty}
            aria-label="Bulk quantity"
            onChange={(event) => setBulkQty(Math.max(1, Number(event.target.value)))}
          />
        </div>
        <button
          className="button"
          style={{ width: '100%' }}
          disabled={!focusSkuId || selectedBins.length === 0 || busy}
          title={
            focusSkuId === null
              ? 'Pick a SKU first'
              : selectedBins.length === 0
                ? 'Select bins in the 3D view first'
                : `Fill ${selectedBins.length} bins with ${bulkQty}`
          }
          onClick={() => {
            if (!focusSkuId) return;
            void bulkFill(focusSkuId, bulkQty, selectedBins).then((outcome) => {
              setBulkResult(outcome?.summary ?? null);
            });
          }}
        >
          Fill selected bins
        </button>

        <div className="sku-tool-row">
          <label className="sku-check">
            <input
              type="checkbox"
              checked={inventory.heatmap}
              onChange={(event) => setHeatmap(event.target.checked)}
            />
            Colour bins by utilisation
          </label>
          <button
            className="button"
            disabled={selection.length === 0}
            onClick={() => select(null)}
            title="Clear the bin selection"
          >
            Clear
          </button>
        </div>

        <div className="field-hint">
          {inventory.index.emptyBinCount} of {inventory.index.byBinId.size} bins are empty.
        </div>
      </div>
    </div>
  );
}
