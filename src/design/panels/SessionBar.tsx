/**
 * Connection status and the connect/disconnect control.
 *
 * The editor is local-first: you can design a whole warehouse without a server, and
 * this is the only place that changes that. It is deliberately a separate control from
 * Publish, because "am I saving anywhere" and "is this live" are different questions
 * and a designer should be able to tell them apart at a glance.
 */
import { useEffect, useState } from 'react';

import { connect, disconnect, saveDraft, useSession } from '../persistence/session';
import { apiBaseUrl } from '../persistence/apiClient';

/** "3s ago" is more useful than a timestamp nobody reads. */
function describeAge(savedAt: number | null, now: number): string {
  if (savedAt === null) return '';
  const seconds = Math.max(0, Math.round((now - savedAt) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes}m ago` : `${Math.round(minutes / 60)}h ago`;
}

export function SessionBar() {
  const session = useSession();
  const [code, setCode] = useState('WH1');
  const [now, setNow] = useState(() => Date.now());

  // Only tick while there is an age to display.
  useEffect(() => {
    if (!session.connected || session.lastSavedAt === null) return;
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, [session.connected, session.lastSavedAt]);

  if (!session.connected) {
    return (
      <div className="topbar-group">
        <span className="topbar-group-label">Server</span>
        <input
          className="session-code"
          value={code}
          aria-label="Warehouse code"
          title={`Connect to ${apiBaseUrl()} and autosave this layout there`}
          onChange={(event) => setCode(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && code.trim()) void connect(code.trim());
          }}
        />
        <button
          className="button"
          disabled={session.saveState === 'SAVING' || code.trim().length === 0}
          title="Create the warehouse if needed, then autosave this layout to it"
          onClick={() => void connect(code.trim())}
        >
          {session.saveState === 'SAVING' ? 'Connecting…' : 'Save to server'}
        </button>
      </div>
    );
  }

  const label =
    session.saveState === 'SAVING'
      ? 'Saving…'
      : session.saveState === 'CONFLICT'
        ? 'Draft changed elsewhere'
        : session.saveState === 'ERROR'
          ? 'Save failed'
          : `Saved ${describeAge(session.lastSavedAt, now)}`;

  const tone =
    session.saveState === 'CONFLICT' || session.saveState === 'ERROR'
      ? 'session-bad'
      : session.saveState === 'SAVED'
        ? 'session-ok'
        : '';

  return (
    <div className="topbar-group">
      <span className="topbar-group-label">Server</span>
      <span className={`session-status ${tone}`} title={`Connected to ${apiBaseUrl()}`}>
        <span className="status-dot" />
        <strong>{session.warehouseCode}</strong>
        <span className="session-note">{label}</span>
      </span>
      <button
        className="button button-icon"
        title="Save now"
        disabled={session.saveState === 'SAVING'}
        onClick={() => void saveDraft()}
      >
        ⟳
      </button>
      <button className="button" title="Work locally again" onClick={disconnect}>
        Stop
      </button>
    </div>
  );
}
