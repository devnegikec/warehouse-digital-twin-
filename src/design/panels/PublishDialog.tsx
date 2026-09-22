/**
 * Publish workflow.
 *
 * The gate is the compiler's verdict, not a checklist: `graph.publishable` is false
 * exactly when an error-severity rule fired, so "cannot publish" always has a
 * diagnostic behind it, and every one of them is listed and navigable from here.
 *
 * Warnings do not block. They exist for layouts that are legal but probably not what
 * the designer meant, and refusing to publish them would train people to ignore the
 * badge.
 */
import { useEffect, useState } from 'react';

import type { Diagnostic, EntityRef } from 'layout-core';

import { useDesignStore } from '../store/designStore';
import { COLORS } from '../theme';
import { mostSpecificRef, requestFocus, resolveFocus } from '../scene/cameraFocus';
import { canonicalJson, copyText, downloadJson, readableJson, publishSummary } from '../publish';
import type { ApiFailure } from '../persistence/apiClient';
import { publishLayout, useSession } from '../persistence/session';

function DiagnosticRow({
  diagnostic,
  onGoTo,
}: {
  diagnostic: Diagnostic;
  onGoTo: (refs: EntityRef[]) => void;
}) {
  const actionable = diagnostic.entityRefs.length > 0;

  return (
    <div className={`publish-issue publish-issue-${diagnostic.severity}`}>
      <div className="publish-issue-body">
        <span className="diagnostic-code">{diagnostic.code}</span>
        <span className="diagnostic-message">{diagnostic.message}</span>
      </div>
      {actionable && (
        <button className="button" onClick={() => onGoTo(diagnostic.entityRefs)}>
          Go to
        </button>
      )}
    </div>
  );
}

export function PublishDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const graph = useDesignStore((state) => state.graph);
  const select = useDesignStore((state) => state.select);
  const session = useSession();

  const [published, setPublished] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [result, setResult] = useState<
    { version: number; changed: boolean; binCount: number; orphaned: number } | null
  >(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Re-opening should show the gate, not the previous run's confirmation.
  useEffect(() => {
    if (!open) {
      setPublished(false);
      setNotice(null);
      setResult(null);
      setFailure(null);
    }
  }, [open]);

  if (!open) return null;

  const summary = publishSummary(graph);
  const errors = graph.diagnostics.filter((item) => item.severity === 'error');
  const warnings = graph.diagnostics.filter((item) => item.severity === 'warning');

  const goTo = (refs: EntityRef[]) => {
    const best = mostSpecificRef(refs);
    if (!best) return;
    select(best);
    const target = resolveFocus(graph, best);
    if (target) requestFocus(target);
    onClose();
  };

  const copy = async (label: string, text: string) => {
    const ok = await copyText(text);
    setNotice(ok ? `${label} copied.` : 'The clipboard is unavailable in this context.');
  };

  /** Publishes for real when a warehouse is open; otherwise validates the payload. */
  const runPublish = async () => {
    setNotice(null);
    setFailure(null);

    if (!session.connected) {
      setPublished(true);
      return;
    }

    const outcome = await publishLayout();
    if (outcome.ok) {
      setResult({
        version: outcome.version,
        changed: outcome.changed,
        binCount: outcome.binCount,
        orphaned: outcome.orphaned.length,
      });
      return;
    }
    setFailure(outcome);
  };

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Publish layout"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="modal-head">
          <div>
            <h2>Publish layout</h2>
            <span className="modal-sub">
              {summary.warehouseCode} · revision from {summary.bins} bins
            </span>
          </div>
          <button className="icon-button" title="Close" onClick={onClose}>
            ×
          </button>
        </header>

        <div className="modal-body">
          <div className={`gate gate-${graph.publishable ? (warnings.length ? 'warn' : 'ok') : 'err'}`}>
            <span
              className="status-dot"
              style={{
                background: graph.publishable
                  ? warnings.length
                    ? COLORS.warning
                    : COLORS.ok
                  : COLORS.error,
              }}
            />
            <strong>
              {graph.publishable
                ? warnings.length
                  ? `Ready, with ${warnings.length} warning${warnings.length === 1 ? '' : 's'}`
                  : 'Ready to publish'
                : `Blocked by ${errors.length} error${errors.length === 1 ? '' : 's'}`}
            </strong>
            <span className="gate-note">
              {graph.publishable
                ? 'Warnings do not block publishing.'
                : 'Errors must be fixed; each one links to the entity behind it.'}
            </span>
          </div>

          {errors.length > 0 && (
            <section className="modal-section">
              <h3 className="modal-section-title">
                Errors
                <span className="section-title-tag">{errors.length}</span>
              </h3>
              {errors.map((diagnostic, index) => (
                <DiagnosticRow key={`${diagnostic.code}-${index}`} diagnostic={diagnostic} onGoTo={goTo} />
              ))}
            </section>
          )}

          {warnings.length > 0 && (
            <section className="modal-section">
              <h3 className="modal-section-title">
                Warnings
                <span className="section-title-tag">{warnings.length}</span>
              </h3>
              {warnings.map((diagnostic, index) => (
                <DiagnosticRow key={`${diagnostic.code}-${index}`} diagnostic={diagnostic} onGoTo={goTo} />
              ))}
            </section>
          )}

          <section className="modal-section">
            <h3 className="modal-section-title">What will be stored</h3>
            <dl className="readout">
              <div style={{ display: 'contents' }}>
                <dt>Aisles / lanes</dt>
                <dd>
                  {summary.aisles} / {summary.lanes}
                </dd>
              </div>
              <div style={{ display: 'contents' }}>
                <dt>Levels</dt>
                <dd>{summary.levels}</dd>
              </div>
              <div style={{ display: 'contents' }}>
                <dt>Bays</dt>
                <dd>
                  {summary.activeBays} of {summary.bays} in service
                </dd>
              </div>
              <div style={{ display: 'contents' }}>
                <dt>Bins</dt>
                <dd>{summary.bins}</dd>
              </div>
            </dl>
            <div className="hash-line">
              <span className="field-label">Document hash</span>
              <code title={graph.hash}>{graph.hash}</code>
            </div>
            <p className="modal-note">
              The server recompiles this document and compares its own hash with this
              one. A mismatch is refused as <code>COMPILER_DRIFT</code> rather than
              stored, because two compilers disagreeing is how wrong bins reach the
              database.
            </p>
          </section>

          {session.connected && (
            <p className="modal-note">
              Publishing writes to <strong>{session.warehouseCode}</strong>
              {session.draftVersion === null ? '' : ` (draft revision ${session.draftRevision})`}.
              The server recompiles this document and refuses the write if its hash
              disagrees with the one shown above.
            </p>
          )}

          {result && (
            <section className="modal-section">
              <h3 className="modal-section-title">Published</h3>
              <div className="gate gate-ok">
                <span className="status-dot" style={{ background: COLORS.ok }} />
                <strong>
                  {result.changed ? `Version ${result.version} is live` : `Version ${result.version} was already live`}
                </strong>
                <span className="gate-note">
                  {result.changed
                    ? `${result.binCount} bin rows written. The server's compiler agreed with this one.`
                    : 'The same document was already published, so nothing was written.'}
                </span>
              </div>
              {result.orphaned > 0 && (
                <p className="modal-note">
                  {result.orphaned} placement{result.orphaned === 1 ? '' : 's'} referenced bins
                  that no longer exist. They are reported against this version rather than
                  deleted, so they can be re-mapped.
                </p>
              )}
            </section>
          )}

          {failure && (
            <section className="modal-section">
              <div className="gate gate-err">
                <span className="status-dot" style={{ background: COLORS.error }} />
                <strong>{failure.code}</strong>
                <span className="gate-note">{failure.message}</span>
              </div>
              {failure.code === 'COMPILER_DRIFT' && (
                <p className="modal-note">
                  The TypeScript and Python compilers produced different hashes for this
                  document, so it was not stored. This is the alarm that stops diverging
                  compilers writing wrong bins — the fix is a compiler change plus a new
                  conformance fixture, not a retry.
                  <br />
                  <code>{failure.clientDocHash?.slice(0, 16)}…</code> here vs{' '}
                  <code>{failure.serverDocHash?.slice(0, 16)}…</code> on the server.
                </p>
              )}
              {failure.code === 'STALE_DRAFT' && (
                <p className="modal-note">
                  Another editor saved this draft first (revision {failure.actualRevision}).
                  Your version is still in the editor; saving again would overwrite theirs.
                </p>
              )}
              {failure.code === 'LAYOUT_NOT_PUBLISHABLE' && (
                <p className="modal-note">
                  The server's validators found errors this client did not. That means the
                  compilers disagree about the rules, which is a bug worth reporting rather
                  than working around.
                </p>
              )}
            </section>
          )}

          {published && !session.connected && (
            <section className="modal-section">
              <h3 className="modal-section-title">Payload ready</h3>
              <div className="row-actions">
                <button
                  className="button"
                  onClick={() => copy('Document', readableJson(graph))}
                >
                  Copy document
                </button>
                <button
                  className="button"
                  onClick={() => copy('Canonical form', canonicalJson(graph))}
                >
                  Copy canonical form
                </button>
                <button
                  className="button"
                  onClick={() =>
                    downloadJson(`${summary.warehouseCode}-layout.json`, readableJson(graph))
                  }
                >
                  Download JSON
                </button>
              </div>
              <p className="modal-note">
                Nothing is stored yet: no warehouse is open. Use
                <strong> Save to server</strong> in the toolbar to open one, and this button
                will publish instead of previewing.
              </p>
            </section>
          )}

          {notice && <div className="modal-notice">{notice}</div>}
        </div>

        <footer className="modal-foot">
          <button className="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="button button-primary"
            disabled={!graph.publishable || session.publishing}
            title={
              graph.publishable
                ? session.connected
                  ? `Publish to ${session.warehouseCode}`
                  : 'Validate the payload for publishing'
                : `Fix ${errors.length} error${errors.length === 1 ? '' : 's'} first`
            }
            onClick={() => void runPublish()}
          >
            {!graph.publishable
              ? 'Blocked'
              : session.publishing
                ? 'Publishing…'
                : session.connected
                  ? 'Publish'
                  : 'Review payload'}
          </button>
        </footer>
      </div>
    </div>
  );
}
