/**
 * Operate mode: read-only view of a layout, with its inventory.
 *
 * Replaces the original control panel, which read a hardcoded status vocabulary from
 * `mockData.js` and could only describe one warehouse. The information shown is the same
 * *kind*; it now comes from the layout and the placements.
 */
import {
  STATUS_COLORS,
  STATUS_ICONS,
  STATUS_LABELS,
  type OperateSlot,
  type OperateSummary,
  type SlotStatus,
} from './slots';
import type { OperateFilter } from './WarehouseCanvas';

function FilterButton({
  label,
  active,
  color,
  onClick,
  count,
}: {
  label: string;
  active: boolean;
  color?: string;
  onClick: () => void;
  count?: number;
}) {
  return (
    <button className={`operate-filter${active ? ' operate-filter-active' : ''}`} onClick={onClick}>
      {color && <span className="operate-swatch" style={{ background: color }} />}
      <span className="operate-filter-label">{label}</span>
      {count !== undefined && <span className="operate-count">{count}</span>}
    </button>
  );
}

function Row({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="operate-row">
      <span className="operate-row-label">{label}</span>
      <span className={`operate-row-value${highlight ? ' operate-row-warn' : ''}`}>{value}</span>
    </div>
  );
}

const STATUS_ORDER: SlotStatus[] = ['empty', 'current_stock', 'low_stock', 'slow_moving'];

export function ManagePanel({
  slots,
  summary,
  selectedSlot,
  activeFilter,
  onFilterChange,
  onDeselect,
  sourceLabel,
}: {
  slots: OperateSlot[];
  summary: OperateSummary;
  selectedSlot: OperateSlot | null;
  activeFilter: OperateFilter;
  onFilterChange: (filter: OperateFilter) => void;
  onDeselect: () => void;
  sourceLabel: string;
}) {
  const levelsInColumn = selectedSlot
    ? Math.max(...slots.filter((slot) => slot.laneCode === selectedSlot.laneCode).map((slot) => slot.levelIndex + 1))
    : 0;

  return (
    <aside className="operate-panel">
      <header className="operate-head">
        <span className="operate-live">
          <span className="status-dot" style={{ background: '#10b981' }} />
          {sourceLabel}
        </span>
        <h2>Warehouse Operations</h2>
        <p>
          {summary.bins} bins · {summary.occupiedBins} occupied ·{' '}
          {(summary.utilization * 100).toFixed(1)}% of usable volume in use
        </p>
      </header>

      <div className="operate-body">
        <section>
          <h4 className="operate-section">Inventory filter</h4>
          <div className="operate-filters">
            <FilterButton
              label="All bins"
              active={activeFilter === 'all'}
              count={summary.bins}
              onClick={() => onFilterChange('all')}
            />
            {STATUS_ORDER.map((status) => (
              <FilterButton
                key={status}
                label={`${STATUS_ICONS[status]} ${STATUS_LABELS[status]}`}
                color={STATUS_COLORS[status]}
                active={activeFilter === status}
                count={summary.byStatus[status]}
                onClick={() => onFilterChange(status)}
              />
            ))}
          </div>
        </section>

        <section>
          <h4 className="operate-section">Bin inspector</h4>

          {selectedSlot ? (
            <div
              className="operate-card"
              style={{ borderColor: `${STATUS_COLORS[selectedSlot.status]}55` }}
            >
              <div
                className="operate-card-head"
                style={{
                  background: `${STATUS_COLORS[selectedSlot.status]}18`,
                  borderBottomColor: `${STATUS_COLORS[selectedSlot.status]}33`,
                }}
              >
                <span className="operate-bin-code">{selectedSlot.binCode}</span>
                <span
                  className="operate-badge"
                  style={{
                    color: STATUS_COLORS[selectedSlot.status],
                    background: `${STATUS_COLORS[selectedSlot.status]}22`,
                  }}
                >
                  {STATUS_ICONS[selectedSlot.status]} {STATUS_LABELS[selectedSlot.status]}
                </span>
              </div>

              <div className="operate-card-body">
                <Row label="SKU" value={selectedSlot.sku ?? '—'} />
                <Row
                  label="Quantity"
                  value={`${selectedSlot.qty} items`}
                  highlight={selectedSlot.qty > 0 && selectedSlot.qty < 10}
                />
                {selectedSlot.skuCount > 1 && (
                  <Row label="Other SKUs" value={`${selectedSlot.skuCount - 1} more`} />
                )}
                <Row label="Aisle" value={selectedSlot.aisleCode || '—'} />
                <Row label="Lane" value={`${selectedSlot.laneCode} (${selectedSlot.side.toLowerCase()})`} />
                <Row label="Bay" value={`Bay ${selectedSlot.baySeq}`} />
                <Row
                  label="Level"
                  value={`Level ${selectedSlot.levelIndex + 1}${levelsInColumn ? ` of ${levelsInColumn}` : ''}`}
                />
                <Row
                  label="Fill"
                  value={`${(selectedSlot.utilization * 100).toFixed(0)}% of ${selectedSlot.capacityM3} m³`}
                />
                <Row
                  label="Weight"
                  value={
                    selectedSlot.maxWeightKg === null
                      ? `${selectedSlot.usedWeightKg.toFixed(0)} kg (no limit)`
                      : `${selectedSlot.usedWeightKg.toFixed(0)} / ${selectedSlot.maxWeightKg} kg`
                  }
                  highlight={
                    selectedSlot.maxWeightKg !== null &&
                    selectedSlot.usedWeightKg > selectedSlot.maxWeightKg * 0.9
                  }
                />
                {selectedSlot.lastMovedDays !== null && (
                  <Row
                    label="Last moved"
                    value={`${selectedSlot.lastMovedDays} day${selectedSlot.lastMovedDays === 1 ? '' : 's'} ago`}
                    highlight={selectedSlot.lastMovedDays >= 30}
                  />
                )}
              </div>

              <div className="operate-card-foot">
                <button className="button" onClick={onDeselect}>
                  ✕ Deselect
                </button>
              </div>
            </div>
          ) : (
            <div className="operate-empty">
              <span>📦</span>
              <span>Click any bin to inspect its details</span>
            </div>
          )}
        </section>

        <section>
          <h4 className="operate-section">Layout utilisation</h4>
          <Row label="Usable volume" value={`${summary.totalVolumeM3.toFixed(1)} m³`} />
          <Row label="Volume in use" value={`${summary.usedVolumeM3.toFixed(1)} m³`} />
          <Row label="Empty bins" value={`${summary.emptyBins}`} />
          <Row
            label="Oldest movement"
            value={
              summary.lastMovedDays === null ? 'no stock' : `${summary.lastMovedDays} days ago`
            }
            highlight={summary.lastMovedDays !== null && summary.lastMovedDays >= 30}
          />
        </section>
      </div>
    </aside>
  );
}
