// src/App.jsx
//
// Two modes share one document: Design authors it, Operate reads it.
//
// Operate mode derives everything from a layout — the published version when a warehouse
// is open, the working copy otherwise — so it no longer ships a hardcoded warehouse of
// its own. What the viewer shows and what the designer built cannot drift, because they
// are the same data.
import { useState } from 'react';
import { DesignWorkspace } from './design/DesignWorkspace';
import { OperateWorkspace } from './operate/OperateWorkspace';

export default function App() {
  const [mode, setMode] = useState('design');

  return mode === 'design' ? (
    <DesignWorkspace onSwitchMode={() => setMode('operate')} />
  ) : (
    <OperateWorkspace onSwitchMode={() => setMode('design')} />
  );
}
