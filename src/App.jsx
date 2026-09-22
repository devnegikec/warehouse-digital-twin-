// src/App.jsx
//
// Two modes share one document: Design authors it, Operate reads it.
//
// Operate mode still runs on the original mock data (Phase 9 replaces that with the
// published layout). Keeping both reachable now means the design tool can be
// compared against the viewer it will eventually drive.
import { useState } from 'react';
import ControlPanel from './components/ControlPanel';
import ViewerPanel from './components/ViewerPanel';
import { DesignWorkspace } from './design/DesignWorkspace';

export default function App() {
  const [mode, setMode] = useState('design');
  const [selectedSlot, setSelectedSlot] = useState(null);
  const [activeFilter, setActiveFilter] = useState('all');

  if (mode === 'design') {
    return <DesignWorkspace onSwitchMode={() => setMode('operate')} />;
  }

  return (
    <div style={{
      display: 'flex',
      width: '100vw',
      height: '100vh',
      overflow: 'hidden',
      backgroundColor: '#0f172a',
      color: '#f8fafc',
      fontFamily: "'Inter', 'Segoe UI', sans-serif",
      position: 'relative',
    }}>
      {/* Left — WMS Control Center */}
      <ControlPanel
        selectedSlot={selectedSlot}
        onDeselect={() => setSelectedSlot(null)}
        activeFilter={activeFilter}
        onFilterChange={setActiveFilter}
      />

      {/* Right — 3D Warehouse Canvas */}
      <ViewerPanel
        onSelectSlot={setSelectedSlot}
        activeFilter={activeFilter}
        selectedSlotId={selectedSlot?.id ?? null}
      />

      <button
        onClick={() => setMode('design')}
        style={{
          position: 'absolute',
          top: 20,
          right: 20,
          zIndex: 20,
          padding: '9px 16px',
          background: 'rgba(14, 51, 80, 0.9)',
          border: '1px solid #1d6fa5',
          borderRadius: 8,
          color: '#e0f2fe',
          font: 'inherit',
          fontSize: 13,
          fontWeight: 600,
          cursor: 'pointer',
          backdropFilter: 'blur(6px)',
        }}
      >
        ← Back to design
      </button>
    </div>
  );
}
