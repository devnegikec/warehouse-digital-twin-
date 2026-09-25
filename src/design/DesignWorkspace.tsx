/**
 * Design mode shell: inspector on the left, canvas in the middle, diagnostics on
 * the right.
 */
import { useEffect, useState } from 'react';

import { DesignCanvas } from './scene/DesignCanvas';
import { DiagnosticList } from './panels/DiagnosticList';
import { ImportDialog } from './panels/ImportDialog';
import { InspectorPanel } from './panels/InspectorPanel';
import { MiniMap } from './panels/MiniMap';
import { OutcomeNotice } from './panels/OutcomeNotice';
import { PlanEditor } from './plan/PlanEditor';
import { PublishDialog } from './panels/PublishDialog';
import { Toolbar } from './panels/Toolbar';
import { startAutosave } from './persistence/session';
import { useDesignStore } from './store/designStore';
import './design.css';

/** The two ways of looking at the same document. */
type ViewMode = '3D' | 'PLAN';

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
  const [importing, setImporting] = useState(false);
  const [view, setView] = useState<ViewMode>('3D');

  // One subscription for the whole workspace, so the debounce timer is not restarted
  // every time a panel re-renders.
  useEffect(() => startAutosave(), []);

  return (
    <div className="design-root">
      <Toolbar
        onSwitchMode={onSwitchMode}
        onPublish={() => setPublishing(true)}
        onImport={() => setImporting(true)}
        view={view}
        onViewChange={setView}
      />
      <OutcomeNotice />
      <div className="workspace-body">
        <InspectorPanel />
        <div className="canvas-area">
          {/*
            * Two views, one document. The 3D canvas is the working view; the plan is
            * where alignment and cross-aisles are editable. Both write through the same
            * commands, so which one is open cannot change the layout.
            */}
          {view === '3D' ? (
            <>
              <DesignCanvas />
              <MiniMap />
              <ToolBanner />
            </>
          ) : (
            <PlanEditor />
          )}

          <div className="canvas-hint">
            {view === '3D'
              ? 'Click a corridor to select an aisle · Click a rack for its lane · Click a bin to inspect it · Drag a handle to move'
              : 'Click an aisle to select it · Drag to move it · Cut a cross-aisle through the racking'}
          </div>
        </div>
        <DiagnosticList />
      </div>
      <PublishDialog open={publishing} onClose={() => setPublishing(false)} />
      <ImportDialog open={importing} onClose={() => setImporting(false)} />
    </div>
  );
}
