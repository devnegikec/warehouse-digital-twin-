/**
 * Diagnostics list.
 *
 * Clicking a diagnostic selects the entity it refers to *and* flies the camera to it,
 * because validators emit `entityRefs` rather than prose (P6). Following an error to
 * its source should not require reading coordinates or orbiting to find the thing.
 */
import type { Diagnostic, EntityRef } from 'layout-core';

import { useDesignStore } from '../store/designStore';
import { COLORS } from '../theme';
import { mostSpecificRef, requestFocus, resolveFocus } from '../scene/cameraFocus';

const VISIBLE_LIMIT = 60;

function refKey(ref: EntityRef): string {
  return `${ref.kind}:${ref.id}`;
}

export function DiagnosticList() {
  // `graph` and `history.doc` are stable objects — the compiler caches on document
  // identity — so selecting them is safe. Only derived arrays would be unsafe here.
  const graph = useDesignStore((state) => state.graph);
  const select = useDesignStore((state) => state.select);

  const diagnostics = graph.diagnostics;
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
  const warnings = diagnostics.filter((diagnostic) => diagnostic.severity === 'warning');
  const visible = [...errors, ...warnings].slice(0, VISIBLE_LIMIT);

  const focus = (diagnostic: Diagnostic) => {
    const best = mostSpecificRef(diagnostic.entityRefs);
    if (!best) return;
    select(best);
    const target = resolveFocus(graph, best);
    if (target) requestFocus(target);
  };

  return (
    <aside className="side-panel side-panel-right">
      <div className="section">
        <h3 className="section-title">
          Diagnostics
          <span className="section-title-tag">
            {errors.length} error{errors.length === 1 ? '' : 's'} · {warnings.length} warning
            {warnings.length === 1 ? '' : 's'}
          </span>
        </h3>

        {visible.length === 0 && (
          <div className="empty-hint">
            No issues. This layout satisfies every rule.
          </div>
        )}

        {visible.map((diagnostic, index) => (
          <button
            key={`${diagnostic.code}-${index}`}
            className={`diagnostic diagnostic-${diagnostic.severity}`}
            onClick={() => focus(diagnostic)}
            title={
              diagnostic.entityRefs.length > 0
                ? `Go to ${diagnostic.entityRefs.map(refKey).join(', ')}`
                : 'No specific entity'
            }
          >
            <span
              className="status-dot"
              style={{
                marginTop: 5,
                background: diagnostic.severity === 'error' ? COLORS.error : COLORS.warning,
              }}
            />
            <span>
              <span className="diagnostic-code">{diagnostic.code}</span>
              <span className="diagnostic-message">{diagnostic.message}</span>
            </span>
          </button>
        ))}

        {visible.length < errors.length + warnings.length && (
          <div className="diagnostic-more">
            {errors.length + warnings.length - visible.length} more not shown
          </div>
        )}
      </div>
    </aside>
  );
}
