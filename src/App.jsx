// src/App.jsx
import { useState } from 'react';
import ControlPanel from './components/ControlPanel';
import ViewerPanel from './components/ViewerPanel';

export default function App() {
  const [selectedSlot, setSelectedSlot] = useState(null);
  const [activeFilter, setActiveFilter] = useState('all');

  return (
    <div style={{
      display: 'flex',
      width: '100vw',
      height: '100vh',
      overflow: 'hidden',
      backgroundColor: '#0f172a',
      color: '#f8fafc',
      fontFamily: "'Inter', 'Segoe UI', sans-serif",
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
    </div>
  );
}
