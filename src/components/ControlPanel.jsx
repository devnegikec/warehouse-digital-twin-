// src/components/ControlPanel.jsx
import { COLOR_MAP } from '../mockData';

const STATUS_ICONS = {
  empty: '⬜',
  current_stock: '🟢',
  low_stock: '🟡',
  slow_moving: '🔴',
};

const STATUS_LABELS = {
  empty: 'Empty',
  current_stock: 'Current Stock',
  low_stock: 'Low Stock',
  slow_moving: 'Slow Moving',
};

export default function ControlPanel({ selectedSlot, onDeselect, activeFilter, onFilterChange }) {
  return (
    <div style={{
      width: 360,
      flexShrink: 0,
      background: '#0f172a',
      borderRight: '1px solid #1e293b',
      display: 'flex',
      flexDirection: 'column',
      overflowY: 'auto',
      height: '100vh',
    }}>
      {/* Sticky header */}
      <div style={{
        padding: '20px 24px 16px',
        borderBottom: '1px solid #1e293b',
        position: 'sticky',
        top: 0,
        zIndex: 10,
        background: '#0f172a',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
          <div style={{
            width: 8, height: 8, borderRadius: '50%',
            background: '#10b981', boxShadow: '0 0 6px #10b981',
          }} />
          <span style={{
            fontSize: 11, color: '#10b981', fontWeight: 600,
            letterSpacing: '0.08em', textTransform: 'uppercase',
          }}>
            Live
          </span>
        </div>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: '#f8fafc' }}>
          WMS Control Center
        </h2>
        <p style={{ margin: '4px 0 0', fontSize: 12, color: '#475569' }}>
          Warehouse Management System
        </p>
      </div>

      {/* Body */}
      <div style={{ padding: '20px 24px', flex: 1 }}>

        {/* Inventory filter */}
        <div style={{ marginBottom: 24 }}>
          <SectionLabel>Inventory Filter</SectionLabel>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <FilterButton
              label="🌐 All Bins"
              active={activeFilter === 'all'}
              onClick={() => onFilterChange('all')}
            />
            {Object.keys(COLOR_MAP).map(key => (
              <FilterButton
                key={key}
                label={`${STATUS_ICONS[key]} ${STATUS_LABELS[key]}`}
                active={activeFilter === key}
                color={COLOR_MAP[key]}
                onClick={() => onFilterChange(key)}
              />
            ))}
          </div>
        </div>

        <Divider />

        {/* Bin inspector */}
        <div>
          <SectionLabel>Bin Inspector</SectionLabel>

          {selectedSlot ? (
            <div style={{
              background: '#0a1628',
              borderRadius: 10,
              border: `1px solid ${COLOR_MAP[selectedSlot.status]}55`,
              overflow: 'hidden',
              boxShadow: `0 0 20px ${COLOR_MAP[selectedSlot.status]}22`,
            }}>
              {/* Card header */}
              <div style={{
                background: `${COLOR_MAP[selectedSlot.status]}18`,
                borderBottom: `1px solid ${COLOR_MAP[selectedSlot.status]}33`,
                padding: '12px 16px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}>
                <span style={{ fontSize: 13, fontWeight: 700, color: '#38bdf8' }}>
                  {selectedSlot.id}
                </span>
                <span style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: COLOR_MAP[selectedSlot.status],
                  background: `${COLOR_MAP[selectedSlot.status]}22`,
                  padding: '3px 8px',
                  borderRadius: 4,
                  textTransform: 'capitalize',
                }}>
                  {STATUS_ICONS[selectedSlot.status]} {STATUS_LABELS[selectedSlot.status]}
                </span>
              </div>

              {/* Detail rows */}
              <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
                <InspectorRow label="SKU Code" value={selectedSlot.sku || '—'} />
                <InspectorRow
                  label="Quantity"
                  value={`${selectedSlot.qty} items`}
                  highlight={selectedSlot.qty < 10 && selectedSlot.qty > 0}
                />
                <InspectorRow label="Aisle" value={`Aisle ${selectedSlot.aisle}`} />
                <InspectorRow label="Bay" value={`Bay ${selectedSlot.bay}`} />
                <InspectorRow label="Level" value={`Level ${selectedSlot.level + 1} of 5`} />
                <InspectorRow label="Row" value={selectedSlot.row === 0 ? 'Left Row' : 'Right Row'} />
                {selectedSlot.lastMovedDays > 0 && (
                  <InspectorRow
                    label="Last Moved"
                    value={`${selectedSlot.lastMovedDays} days ago`}
                    highlight={selectedSlot.lastMovedDays > 30}
                  />
                )}
              </div>

              {/* Deselect */}
              <div style={{ padding: '0 16px 14px' }}>
                <button
                  onClick={onDeselect}
                  style={{
                    width: '100%',
                    padding: '8px',
                    background: 'transparent',
                    border: '1px solid #1e293b',
                    borderRadius: 6,
                    color: '#475569',
                    cursor: 'pointer',
                    fontSize: 12,
                  }}
                >
                  ✕ Deselect
                </button>
              </div>
            </div>
          ) : (
            <div style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 10,
              padding: '32px 16px',
              border: '2px dashed #1e293b',
              borderRadius: 10,
              color: '#334155',
              textAlign: 'center',
            }}>
              <span style={{ fontSize: 28 }}>📦</span>
              <span style={{ fontSize: 13 }}>Click any bin to inspect its details</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Small shared primitives ──────────────────────────────────────────────────

function SectionLabel({ children }) {
  return (
    <h4 style={{
      margin: '0 0 12px 0',
      fontSize: 11,
      color: '#475569',
      letterSpacing: '0.08em',
      textTransform: 'uppercase',
      fontWeight: 600,
    }}>
      {children}
    </h4>
  );
}

function Divider() {
  return <div style={{ height: 1, background: '#1e293b', marginBottom: 24 }} />;
}

function FilterButton({ label, active, color, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '9px 12px',
        background: active ? '#1e293b' : 'transparent',
        border: `1px solid ${active ? '#334155' : '#1e293b'}`,
        borderRadius: 7,
        color: active ? '#f8fafc' : '#64748b',
        cursor: 'pointer',
        fontSize: 13,
        textAlign: 'left',
        transition: 'all 0.15s',
      }}
    >
      {color && (
        <div style={{
          width: 10,
          height: 10,
          borderRadius: 2,
          background: color,
          flexShrink: 0,
          boxShadow: active ? `0 0 6px ${color}` : 'none',
        }} />
      )}
      <span>{label}</span>
    </button>
  );
}

function InspectorRow({ label, value, highlight }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <span style={{ fontSize: 12, color: '#475569' }}>{label}</span>
      <span style={{ fontSize: 12, fontWeight: 600, color: highlight ? '#f59e0b' : '#cbd5e1' }}>
        {value}
      </span>
    </div>
  );
}
