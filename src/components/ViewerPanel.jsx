// src/components/ViewerPanel.jsx
import { useState } from 'react';
import WarehouseCanvas from './WarehouseCanvas';

export default function ViewerPanel({ onSelectSlot, activeFilter, selectedSlotId }) {
  const [showPath, setShowPath] = useState(false);

  return (
    <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
      <WarehouseCanvas
        onSelectSlot={onSelectSlot}
        activeFilter={activeFilter}
        showPath={showPath}
        selectedSlotId={selectedSlotId}
      />

      {/* Route controls overlay */}
      <div style={{
        position: 'absolute',
        top: 20,
        left: 20,
        background: 'rgba(15, 23, 42, 0.88)',
        backdropFilter: 'blur(10px)',
        padding: '14px 16px',
        borderRadius: 10,
        border: '1px solid #1e40af',
        boxShadow: '0 4px 24px rgba(0,0,0,0.4)',
        minWidth: 200,
      }}>
        <h4 style={{
          margin: '0 0 10px 0',
          fontSize: 13,
          color: '#94a3b8',
          letterSpacing: '0.05em',
          textTransform: 'uppercase',
        }}>
          Route Controls
        </h4>
        <button
          onClick={() => setShowPath(prev => !prev)}
          style={{
            padding: '9px 14px',
            background: showPath ? '#1d4ed8' : '#1e293b',
            color: showPath ? '#fff' : '#94a3b8',
            border: `1px solid ${showPath ? '#3b82f6' : '#334155'}`,
            borderRadius: 6,
            cursor: 'pointer',
            fontWeight: 600,
            fontSize: 13,
            width: '100%',
            transition: 'all 0.2s',
          }}
        >
          {showPath ? '🔵 Hide Picking Route' : '📍 Show Picking Route'}
        </button>
      </div>

      {/* Bottom hint bar */}
      <div style={{
        position: 'absolute',
        bottom: 20,
        left: '50%',
        transform: 'translateX(-50%)',
        background: 'rgba(15, 23, 42, 0.75)',
        backdropFilter: 'blur(6px)',
        padding: '8px 18px',
        borderRadius: 20,
        border: '1px solid #334155',
        fontSize: 12,
        color: '#64748b',
        pointerEvents: 'none',
        whiteSpace: 'nowrap',
      }}>
        Hover over a bin to preview · Click to inspect · Drag to orbit · Scroll to zoom
      </div>
    </div>
  );
}
