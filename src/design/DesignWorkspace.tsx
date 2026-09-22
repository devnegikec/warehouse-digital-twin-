/**
 * Design mode shell: inspector on the left, canvas in the middle, diagnostics on
 * the right.
 */
import { useEffect, useState } from 'react';

import { DesignCanvas } from './scene/DesignCanvas';
import { DiagnosticList } from './panels/DiagnosticList';
import { InspectorPanel } from './panels/InspectorPanel';
import { MiniMap } from './panels/MiniMap';
import { OutcomeNotice } from './panels/OutcomeNotice';
import { PublishDialog } from './panels/PublishDialog';
import { Toolbar } from './panels/Toolbar';
import { startAutosave } from './persistence/session';
import { useDesignStore } from './store/designStore';
import './design.css';

function ToolBanner() {
  const tool = useDesignStore((state) => state.tool);

  if (tool === 'SELECT') return null;

  const message =
    tool === 'ADD_AISLE'
      ? 'Click the floor to place an aisle · Esc to cancel'
      : 'Click the floor to place a column · Esc to cancel';

  return <div className="tool-banner">{message}</div>;
}

export function DesignWorkspace({ onSwitchMode }: { onSwitchMode: () => void }) {
  const [publishing, setPublishing] = useState(false);

  // One subscription for the whole workspace, so the debounce timer is not restarted
  // every time a panel re-renders.
  useEffect(() => startAutosave(), []);

  return (
    <div className="design-root">
      <Toolbar onSwitchMode={onSwitchMode} onPublish={() => setPublishing(true)} />
      <OutcomeNotice />
      <div className="workspace-body">
        <InspectorPanel />
        <div className="canvas-area">
          <DesignCanvas />
          <MiniMap />
          <ToolBanner />
          <div className="canvas-hint">
            Click a corridor to select an aisle · Click a rack for its lane · Click a bin to inspect it · Drag a handle to move
          </div>
        </div>
        <DiagnosticList />
      </div>
      <PublishDialog open={publishing} onClose={() => setPublishing(false)} />
    </div>
  );
}
