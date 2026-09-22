/**
 * Surfaces a refused command.
 *
 * Not every command can succeed. `lane.setSegments` refuses runs that overlap or
 * overrun the lane, `lane.removeLevel` refuses to empty a lane, and so on. The store
 * keeps the previous document when a command is refused and records the reason on
 * `lastOutcome`; without somewhere to show it the editor would just appear to ignore
 * the user.
 *
 * It clears itself: every dispatch replaces `lastOutcome`, so the next successful
 * edit removes the notice without any dismissal bookkeeping.
 */
import { useDesignStore } from '../store/designStore';

export function OutcomeNotice() {
  const outcome = useDesignStore((state) => state.lastOutcome);

  if (!outcome || outcome.ok || !outcome.reason) return null;

  return (
    <div className="outcome-notice" role="status">
      <strong>Not applied</strong>
      <span>{outcome.reason}</span>
    </div>
  );
}
