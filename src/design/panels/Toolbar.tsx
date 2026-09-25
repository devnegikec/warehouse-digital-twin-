/**
 * Top bar: history, tools, snap increment, and live layout status.
 *
 * Note the selectors: every one returns a primitive or a stable reference. A
 * selector that builds a new array or object on each call would re-render forever,
 * because zustand compares snapshots with `Object.is`. That is also why status
 * counts come from the precomputed `graph.errorCount` rather than from filtering
 * `graph.diagnostics` inside a selector.
 */
import { useDesignStore } from '../store/designStore';
import { COLORS, SNAP_OPTIONS } from '../theme';
import { SessionBar } from './SessionBar';

type Props = {
  onSwitchMode: () => void;
  onPublish: () => void;
  /** Which view of the document the canvas area is showing. */
  view: '3D' | 'PLAN';
  onViewChange: (view: '3D' | 'PLAN') => void;
};

export function Toolbar({ onSwitchMode, onPublish, view, onViewChange }: Props) {
  const undo = useDesignStore((state) => state.undo);
  const redo = useDesignStore((state) => state.redo);
  const tool = useDesignStore((state) => state.tool);
  const setTool = useDesignStore((state) => state.setTool);
  const snapM = useDesignStore((state) => state.snapM);
  const setSnapM = useDesignStore((state) => state.setSnapM);

  const canUndo = useDesignStore((state) => state.history.past.length > 0);
  const canRedo = useDesignStore((state) => state.history.future.length > 0);
  const undoLabel = useDesignStore((state) => state.history.past.at(-1)?.label ?? null);
  const redoLabel = useDesignStore((state) => state.history.future[0]?.label ?? null);
  const depth = useDesignStore((state) => state.history.past.length);

  const binCount = useDesignStore((state) => state.graph.bins.length);
  const bayCount = useDesignStore((state) => state.graph.bays.length);
  const errorCount = useDesignStore((state) => state.graph.errorCount);
  const warningCount = useDesignStore((state) => state.graph.warningCount);
  const publishable = useDesignStore((state) => state.graph.publishable);
  const hasRackType = useDesignStore((state) => state.history.doc.rackTypes.length > 0);

  const statusClass = !publishable ? 'badge-err' : warningCount > 0 ? 'badge-warn' : 'badge-ok';
  const statusText = !publishable
    ? 'Blocked'
    : warningCount > 0
      ? 'Publishable with warnings'
      : 'Publishable';

  return (
    <header className="topbar">
      <div className="topbar-brand">
        <strong>Warehouse Designer</strong>
        <span>Design mode</span>
      </div>

      <div className="topbar-group">
        <span className="topbar-group-label">History</span>
        <button
          className="button button-icon"
          title={undoLabel ? `Undo ${undoLabel}` : 'Nothing to undo'}
          disabled={!canUndo}
          onClick={undo}
        >
          ↶
        </button>
        <button
          className="button button-icon"
          title={redoLabel ? `Redo ${redoLabel}` : 'Nothing to redo'}
          disabled={!canRedo}
          onClick={redo}
        >
          ↷
        </button>
        <span className="status-item" style={{ fontSize: 11, color: COLORS.textFaint }}>
          {depth} edit{depth === 1 ? '' : 's'}
        </span>
      </div>

      <div className="topbar-group">
        <div className="view-tabs" role="tablist" aria-label="View">
          <button
            role="tab"
            aria-selected={view === '3D'}
            className={`view-tab${view === '3D' ? ' view-tab-active' : ''}`}
            onClick={() => onViewChange('3D')}
          >
            3D
          </button>
          <button
            role="tab"
            aria-selected={view === 'PLAN'}
            className={`view-tab${view === 'PLAN' ? ' view-tab-active' : ''}`}
            onClick={() => onViewChange('PLAN')}
          >
            Plan (2D)
          </button>
        </div>
      </div>

      <div className="topbar-group">
        <span className="topbar-group-label">Tool</span>
        <button
          className={`button${tool === 'SELECT' ? ' button-active' : ''}`}
          onClick={() => setTool('SELECT')}
        >
          Select
        </button>
        <button
          className={`button${tool === 'ADD_AISLE' ? ' button-active' : ''}`}
          disabled={!hasRackType}
          title={hasRackType ? 'Click the floor to place an aisle' : 'Add a rack type first'}
          onClick={() => setTool('ADD_AISLE')}
        >
          + Aisle
        </button>
        <button
          className={`button${tool === 'ADD_OBSTACLE' ? ' button-active' : ''}`}
          title="Click the floor to place a column"
          onClick={() => setTool('ADD_OBSTACLE')}
        >
          + Column
        </button>
      </div>

      <div className="topbar-group">
        <span className="topbar-group-label">Snap</span>
        <select
          className="select"
          value={snapM}
          onChange={(event) => setSnapM(Number(event.target.value))}
        >
          {SNAP_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {option} m
            </option>
          ))}
        </select>
      </div>

      <div className="topbar-spacer" />

      <SessionBar />

      <div className="status">
        <span className="status-item" title="Bays produced by the current layout">
          <span className="status-dot" style={{ background: COLORS.info }} />
          {bayCount} bays
        </span>
        <span className="status-item" title="Bins produced by the current layout">
          <span className="status-dot" style={{ background: COLORS.bin }} />
          {binCount} bins
        </span>
        <span className="status-item" title="Errors block publishing; warnings do not">
          <span className="status-dot" style={{ background: COLORS.error }} />
          {errorCount}
          <span className="status-dot" style={{ background: COLORS.warning, marginLeft: 6 }} />
          {warningCount}
        </span>
        <span className={`badge ${statusClass}`}>{statusText}</span>
      </div>

      <button
        className="button"
        title={
          publishable
            ? 'Review and publish this layout'
            : 'Blocked by errors — open to see which ones'
        }
        onClick={onPublish}
      >
        Publish…
      </button>

      <button className="button" onClick={onSwitchMode}>
        Operate mode →
      </button>
    </header>
  );
}
