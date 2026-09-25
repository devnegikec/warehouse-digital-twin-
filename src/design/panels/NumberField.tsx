/**
 * A numeric field that treats the *committed* value as authoritative.
 *
 * While typing, the field holds a local draft; it commits on blur or Enter and
 * reverts on Escape. That matters for two reasons:
 *
 *  - The inspector must be able to override a drag (P12). Typing always wins.
 *  - Committing per keystroke would push one undo entry per character, so undo
 *    would rewind "1", "12", "121" instead of the edit.
 *
 * The pending draft is held in a ref as well as in state, and that is load bearing. `commit`
 * necessarily runs twice for a single Enter: once from the key handler, and again from the
 * blur that handler triggers. React has not re-rendered in between, so the blur's closure
 * still sees the old draft and `setDraft(null)` has not taken effect — which used to push
 * the same edit onto the undo stack twice, so one undo appeared to do nothing. The same
 * stale closure made Escape *commit* the value it was supposed to discard. The ref is
 * cleared synchronously, so the second call, and every Escape, now returns early.
 */
import { useRef, useState } from 'react';

type Props = {
  label: string;
  value: number;
  onCommit: (value: number) => void;
  step?: number;
  min?: number;
  max?: number;
  unit?: string;
  hint?: string;
  disabled?: boolean;
  /** Shown when the committed value is out of an allowed range. */
  error?: string;
};

export function NumberField({
  label,
  value,
  onCommit,
  step = 0.05,
  min,
  max,
  unit,
  hint,
  disabled,
  error,
}: Props) {
  const [draft, setDraft] = useState<string | null>(null);
  const pending = useRef<string | null>(null);

  const edit = (next: string | null) => {
    pending.current = next;
    setDraft(next);
  };

  const commit = () => {
    const raw = pending.current;
    if (raw === null) return;
    edit(null);
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed === value) return;
    onCommit(parsed);
  };

  return (
    <label className={`field${error ? ' field-error' : ''}${disabled ? ' field-disabled' : ''}`}>
      <span className="field-label">{label}</span>
      <span className="field-input">
        <input
          type="number"
          inputMode="decimal"
          value={draft ?? String(value)}
          step={step}
          min={min}
          max={max}
          disabled={disabled}
          onChange={(event) => edit(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              commit();
              event.currentTarget.blur();
            } else if (event.key === 'Escape') {
              edit(null);
              event.currentTarget.blur();
            }
          }}
        />
        {unit && <span className="field-unit">{unit}</span>}
      </span>
      {error && <span className="field-message">{error}</span>}
      {!error && hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function TextField({
  label,
  value,
  onCommit,
  hint,
}: {
  label: string;
  value: string;
  onCommit: (value: string) => void;
  hint?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const pending = useRef<string | null>(null);
  const edit = (next: string | null) => {
    pending.current = next;
    setDraft(next);
  };

  const commit = () => {
    const raw = pending.current;
    if (raw === null) return;
    edit(null);
    const next = raw.trim();
    if (next.length === 0 || next === value) return;
    onCommit(next);
  };

  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <span className="field-input">
        <input
          type="text"
          value={draft ?? value}
          onChange={(event) => edit(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              commit();
              event.currentTarget.blur();
            } else if (event.key === 'Escape') {
              edit(null);
              event.currentTarget.blur();
            }
          }}
        />
      </span>
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

/**
 * A bare numeric input for table cells, where each field has no visible label.
 *
 * Uncontrolled on purpose. `key` is supplied by the caller as the current value, so
 * the input remounts whenever the document value changes — by an undo, a drag, or an
 * edit somewhere else — and picks up the new `defaultValue`. That is what stops a
 * typed-but-rejected value from lingering on screen after the document refuses it.
 */
export function InlineNumber({
  value,
  onCommit,
  step = 0.05,
  min,
  placeholder,
  label,
}: {
  value: number | null;
  onCommit: (value: number | null) => void;
  step?: number;
  min?: number;
  placeholder?: string;
  /** Accessible name, since a table cell has no label of its own. */
  label?: string;
}) {
  const text = value === null ? '' : String(value);

  return (
    <input
      type="number"
      inputMode="decimal"
      aria-label={label}
      key={text}
      defaultValue={text}
      step={step}
      min={min}
      placeholder={placeholder ?? ''}
      onBlur={(event) => {
        const raw = event.target.value.trim();
        if (raw === '') {
          if (value !== null) onCommit(null);
          return;
        }
        const parsed = Number(raw);
        if (Number.isFinite(parsed) && parsed !== value) onCommit(parsed);
        else event.target.value = text;
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.currentTarget.blur();
        } else if (event.key === 'Escape') {
          event.currentTarget.value = text;
          event.currentTarget.blur();
        }
      }}
    />
  );
}

/** A label/value list for derived, read-only facts. */
export function Readout({ rows }: { rows: Array<[string, string]> }) {
  return (
    <dl className="readout">
      {rows.map(([label, value]) => (
        <div key={label} style={{ display: 'contents' }}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
