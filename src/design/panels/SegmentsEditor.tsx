/**
 * Lane run editor: the RACK / GAP segments that make a lane produce racks, holes,
 * or a mix of the two.
 *
 * Runs are stored as offsets in metres along the lane. A bay belongs to the lane as
 * soon as the lane is long enough for it; whether it actually produces bins depends
 * on whether a RACK run covers the bay's *centre*. So a GAP that does not span a
 * whole bay's centre may only remove one bay — the live bay count below is the
 * honest answer, and it comes from the compiler rather than being recomputed here.
 */
import { useState } from 'react';

import { EPS, round, type Lane, type LaneSegment, type SegmentKind } from 'layout-core';

import { useDesignStore } from '../store/designStore';
import type { LaneStats } from './laneStats';
import { InlineNumber } from './NumberField';

const KINDS: SegmentKind[] = ['RACK', 'GAP'];

/**
 * Pre-flight check for the invariants `lane.setSegments` enforces.
 *
 * The command remains the authority and re-validates everything — but it refuses by
 * leaving the document untouched, and an input that was not dispatched keeps showing
 * what the user typed. Checking here first keeps the editor and the document in step.
 */
function describeProblem(segments: LaneSegment[], lengthM: number): string | null {
  for (const segment of segments) {
    if (!(segment.endM > segment.startM)) {
      return `A ${segment.kind.toLowerCase()} run must end after it starts.`;
    }
    if (segment.endM > lengthM + EPS) {
      return `A run ends at ${round(segment.endM, 2)} m, past the lane's ${round(lengthM, 2)} m.`;
    }
  }
  for (let index = 1; index < segments.length; index += 1) {
    const previous = segments[index - 1]!;
    const current = segments[index]!;
    if (current.startM < previous.endM - EPS) {
      return `Runs overlap at ${round(current.startM, 2)} m.`;
    }
  }
  return null;
}

function InlineText({
  value,
  onCommit,
  placeholder,
  label,
}: {
  value: string;
  onCommit: (value: string) => void;
  placeholder?: string;
  label: string;
}) {
  return (
    <input
      type="text"
      aria-label={label}
      key={value}
      defaultValue={value}
      placeholder={placeholder ?? ''}
      onBlur={(event) => {
        const next = event.target.value.trim();
        if (next !== value) onCommit(next);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
        else if (event.key === 'Escape') {
          event.currentTarget.value = value;
          event.currentTarget.blur();
        }
      }}
    />
  );
}

export function SegmentsEditor({ lane, stats }: { lane: Lane; stats: LaneStats }) {
  const dispatch = useDesignStore((state) => state.dispatch);
  const rackTypes = useDesignStore((state) => state.history.doc.rackTypes);

  const [problem, setProblem] = useState<string | null>(null);
  /** Bumped on a rejected edit, to remount rows and restore the document's values. */
  const [revision, setRevision] = useState(0);

  const segments = lane.segments ?? [];
  const bayWidthM = rackTypes.find((rackType) => rackType.id === lane.rackTypeId)?.bayWidthM ?? 2.7;
  const hasRackRun = segments.some((segment) => segment.kind === 'RACK');

  const tryCommit = (next: LaneSegment[]) => {
    const sorted = [...next].sort((a, b) => a.startM - b.startM);
    const reason = describeProblem(sorted, lane.lengthM);
    setProblem(reason);
    if (reason) {
      setRevision((value) => value + 1);
      return;
    }
    dispatch({ type: 'lane.setSegments', laneId: lane.id, segments: sorted });
  };

  const patchRow = (index: number, patch: Partial<LaneSegment>) => {
    tryCommit(segments.map((segment, at) => (at === index ? { ...segment, ...patch } : segment)));
  };

  /**
   * Split the longest RACK run and drop one bay-wide gap in the middle of it. Doing
   * the arithmetic for the user is the whole point: a hand-typed gap either lands off
   * a bay centre (and removes nothing) or overlaps its neighbour (and is refused).
   */
  const insertCentreGap = () => {
    const candidates = segments
      .map((segment, index) => ({ segment, index }))
      .filter(({ segment }) => segment.kind === 'RACK' && segment.endM - segment.startM >= bayWidthM * 3)
      .sort((a, b) => b.segment.endM - b.segment.startM - (a.segment.endM - a.segment.startM));

    const target = candidates[0];
    if (!target) {
      setProblem(`No rack run is long enough to hold a ${round(bayWidthM, 2)} m gap.`);
      setRevision((value) => value + 1);
      return;
    }

    const { segment } = target;
    const centre = round((segment.startM + segment.endM) / 2, 3);
    const half = round(bayWidthM / 2, 3);
    const gap: LaneSegment = { kind: 'GAP', startM: round(centre - half, 3), endM: round(centre + half, 3) };

    const next = segments.filter((_, index) => index !== target.index);
    next.push({ ...segment, endM: gap.startM });
    next.push(gap);
    next.push({ ...segment, startM: gap.endM });
    tryCommit(next);
  };

  const resetToOneRun = () =>
    tryCommit([{ kind: 'RACK', startM: 0, endM: lane.lengthM }]);

  return (
    <>
      <div className="seg-head">
        <span>Run</span>
        <span>From</span>
        <span>To</span>
        <span>Label</span>
        <span />
      </div>

      {segments.map((segment, index) => (
        <div className="seg-row" key={`${index}:${revision}`}>
          <select
            className="select"
            aria-label={`Run ${index + 1} kind`}
            value={segment.kind}
            onChange={(event) => patchRow(index, { kind: event.target.value as SegmentKind })}
          >
            {KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {kind === 'RACK' ? 'Rack' : 'Gap'}
              </option>
            ))}
          </select>
          <InlineNumber
            label={`Run ${index + 1} start`}
            min={0}
            value={segment.startM}
            onCommit={(startM) => startM !== null && patchRow(index, { startM })}
          />
          <InlineNumber
            label={`Run ${index + 1} end`}
            min={0}
            value={segment.endM}
            onCommit={(endM) => endM !== null && patchRow(index, { endM })}
          />
          <InlineText
            label={`Run ${index + 1} label`}
            placeholder="—"
            value={segment.label ?? ''}
            onCommit={(label) => patchRow(index, { label: label === '' ? undefined : label })}
          />
          <button
            className="icon-button"
            title={
              segments.length <= 1
                ? 'A lane needs at least one run'
                : 'Delete this run, leaving no racks in its place'
            }
            disabled={segments.length <= 1}
            onClick={() => tryCommit(segments.filter((_, at) => at !== index))}
          >
            ×
          </button>
        </div>
      ))}

      <div className="seg-actions">
        <button className="button" onClick={insertCentreGap}>
          + Gap in the middle
        </button>
        <button
          className="button"
          disabled={segments.length === 1 && segments[0]?.kind === 'RACK' && segments[0].startM === 0 && segments[0].endM === lane.lengthM}
          onClick={resetToOneRun}
        >
          One continuous run
        </button>
      </div>

      {problem && <div className="field-message">{problem}</div>}

      {!hasRackRun && (
        <div className="field-message">
          Every run is a gap, so this lane produces no bins.
        </div>
      )}

      <div className="seg-summary">
        <span>Bays producing bins</span>
        <strong>
          {stats.activeBays} / {stats.bays.length}
        </strong>
      </div>
      {stats.skipped > 0 && (
        <div className="field-hint" style={{ marginTop: 4 }}>
          {stats.skipped} bay{stats.skipped === 1 ? '' : 's'} skipped below.
        </div>
      )}
    </>
  );
}
