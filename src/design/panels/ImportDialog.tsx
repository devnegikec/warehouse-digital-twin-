/**
 * Import a layout from JSON.
 *
 * The document *is* the input format — a design is fully described by
 * `packages/layout-core/schema/layout-doc.v1.json`, so "authoring in JSON" needs no
 * translation layer, only a way in and a way to be told what is wrong.
 *
 * This is a dialog rather than a file-drop shortcut because the failure case matters:
 * a handout with a stray comma should say which comma and where, and the document that
 * *was* in the editor must survive it. Import goes through `document.replace`, a normal
 * command, so a bad import changes nothing and a good one is a single undo away.
 */
import { useEffect, useRef, useState } from 'react';

import { designState, useDesignStore } from '../store/designStore';
import { readLayoutJson } from '../importLayout';

type Loaded = { aisles: number; lanes: number; bins: number };

export function ImportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dispatch = useDesignStore((state) => state.dispatch);

  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Re-opening should show an empty form, not the previous run's file.
  useEffect(() => {
    if (open) return;
    setText('');
    setError(null);
    setLoaded(null);
    setFileName(null);
  }, [open]);

  if (!open) return null;

  const load = (raw: string) => {
    setLoaded(null);

    const result = readLayoutJson(raw);
    if (!result.ok) {
      setError(result.reason);
      return;
    }

    const outcome = dispatch({ type: 'document.replace', doc: result.doc });
    if (!outcome.ok) {
      setError(outcome.reason ?? 'The document was refused.');
      return;
    }

    // The store recompiles in the same `set()` that replaces the document, so the graph
    // read back here is the imported layout, not the previous one.
    const graph = designState().graph;
    setError(null);
    setLoaded({
      aisles: graph.doc.aisles.length,
      lanes: graph.doc.aisles.reduce((total, aisle) => total + aisle.lanes.length, 0),
      bins: graph.bins.length,
    });
  };

  const pickFile = (file: File) => {
    setFileName(file.name);
    void file.text().then((content) => {
      setText(content);
      load(content);
    });
  };

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Import layout JSON"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="modal-head">
          <div>
            <h2>Import layout JSON</h2>
            <span className="modal-sub">Warehouse, aisles, lanes, levels, runs and obstacles</span>
          </div>
          <button className="icon-button" title="Close" onClick={onClose}>
            ×
          </button>
        </header>

        <div className="modal-body">
          <section className="modal-section">
            <h3 className="modal-section-title">From a file</h3>
            <input
              ref={fileRef}
              type="file"
              accept=".json,application/json"
              className="file-input"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) pickFile(file);
                // Clear the input so choosing the same file twice re-imports it.
                event.target.value = '';
              }}
            />
            <p className="modal-note">
              {fileName ? `Read ${fileName}.` : 'Or paste the document below.'}
            </p>
          </section>

          <section className="modal-section">
            <h3 className="modal-section-title">From text</h3>
            <textarea
              className="json-input"
              aria-label="Layout JSON"
              spellCheck={false}
              placeholder={'{\n  "schemaVersion": 1,\n  "warehouse": { "code": "WH1", … },\n  "aisles": [ … ]\n}'}
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
          </section>

          {error && (
            <section className="modal-section">
              <div className="gate gate-err">
                <span className="status-dot" style={{ background: '#ef4444' }} />
                <strong>Not loaded</strong>
                <span className="gate-note">{error}</span>
              </div>
              <p className="modal-note">
                Nothing changed: a refused import leaves the layout exactly as it was.
              </p>
            </section>
          )}

          {loaded && (
            <section className="modal-section">
              <div className="gate gate-ok">
                <span className="status-dot" style={{ background: '#10b981' }} />
                <strong>Loaded</strong>
                <span className="gate-note">
                  {loaded.aisles} aisle{loaded.aisles === 1 ? '' : 's'} · {loaded.lanes} lane
                  {loaded.lanes === 1 ? '' : 's'} · {loaded.bins} bins
                </span>
              </div>
              <p className="modal-note">
                One undo restores the previous layout. Diagnostics from the imported document
                are in the panel on the right.
              </p>
            </section>
          )}

          <p className="modal-note">
            The full field list is the schema at{' '}
            <code>packages/layout-core/schema/layout-doc.v1.json</code>. Unknown fields are
            ignored; anything the schema requires and the file omits is reported above with the
            path that is missing.
          </p>
        </div>

        <footer className="modal-foot">
          <button className="button" onClick={onClose}>
            Close
          </button>
          <button
            className="button button-primary"
            disabled={text.trim() === ''}
            onClick={() => load(text)}
          >
            Import
          </button>
        </footer>
      </div>
    </div>
  );
}
