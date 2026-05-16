// src/App.jsx
import React, { useState } from 'react';
import WarehouseCanvas from './components/WarehouseCanvas';
import { COLOR_MAP } from './mockData';

export default function App() {
  const [selectedSlot, setSelectedSlot] = useState(null);

  return (
    <div style={{ display: 'flex', width: '100vw', height: '100vh', overflow: 'hidden', fontFamily: 'sans-serif' }}>

      {/* Left Side: Interactive 3D Digital Twin Viewer */}
      <div style={{ flex: 1, position: 'relative' }}>
        <WarehouseCanvas onSelectSlot={setSelectedSlot} />

        {/* Simple Floating Legend Overlay */}
        <div style={{ position: 'absolute', bottom: 20, left: 20, background: 'rgba(255,255,255,0.9)', padding: 15, borderRadius: 8, boxShadow: '0 4px 6px rgba(0,0,0,0.1)' }}>
          <h4 style={{ margin: '0 0 10px 0' }}>Status Legend</h4>
          {Object.keys(COLOR_MAP).map(key => (
            <div key={key} style={{ display: 'flex', alignItems: 'center', marginBottom: 5 }}>
              <div style={{ width: 16, height: 16, backgroundColor: COLOR_MAP[key], marginRight: 8, borderRadius: 3 }} />
              <span style={{ textTransform: 'capitalize', fontSize: 13 }}>{key.replace('_', ' ')}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Right Side: Operational Data Context Panel */}
      <div style={{ width: '350px', background: '#f8fafc', padding: '24px', borderLeft: '1px solid #e2e8f0', display: 'flex', flexDirection: 'column' }}>
        <h2 style={{ marginTop: 0, color: '#1e293b' }}>Warehouse Logistics</h2>
        <p style={{ color: '#64748b', fontSize: '14px' }}>Click any rack mesh inside the 3D viewport canvas window to review shelf occupancy metrics.</p>

        <hr style={{ border: 'none', borderTop: '1px solid #e2e8f0', margin: '20px 0' }} />

        {selectedSlot ? (
          <div>
            <h3 style={{ color: '#0f172a', marginBottom: '16px' }}>Slot: {selectedSlot.id}</h3>

            <div style={{ background: '#fff', padding: '16px', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
              <p><strong>Status:</strong> <span style={{ color: COLOR_MAP[selectedSlot.status], fontWeight: 'bold' }}>{selectedSlot.status.toUpperCase()}</span></p>
              <p><strong>SKU Assigned:</strong> {selectedSlot.sku || 'None'}</p>
              <p><strong>Quantity Count:</strong> {selectedSlot.qty} units</p>
              <p><strong>Days Inactive:</strong> {selectedSlot.lastMovedDays} days</p>
            </div>
          </div>
        ) : (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#94a3b8', border: '2px dashed #e2e8f0', borderRadius: '8px' }}>
            No Rack Selected
          </div>
        )}
      </div>

    </div>
  );
}
