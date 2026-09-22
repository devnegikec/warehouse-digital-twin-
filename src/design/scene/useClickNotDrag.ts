/**
 * Distinguishes a click from the end of a drag.
 *
 * R3F dispatches `click` after `pointerup`, and it raycasts independently of the
 * drag: after dragging an aisle, the click lands on whatever is under the cursor
 * — usually a bin, or the bare floor — and would overwrite the selection the drag
 * just made, or clear it entirely.
 *
 * Drags start on objects that do not all handle `click`, so the state has to be
 * shared by whoever does. This hook records where the pointer went down and
 * reports whether a subsequent click moved meaningfully.
 */
import { useCallback, useRef } from 'react';

/** Movement below this many pixels is a click that wobbled, not a drag. */
export const DRAG_TOLERANCE_PX = 4;

type PointerPosition = { clientX: number; clientY: number };

export function useClickNotDrag(): {
  onPointerDown: (event: PointerPosition) => void;
  /**
   * True only when this object saw the pointerdown *and* the pointer barely moved.
   * Any other case means the gesture belongs to something else.
   */
  isClick: (event: PointerPosition) => boolean;
} {
  const downAt = useRef<PointerPosition | null>(null);

  const onPointerDown = useCallback((event: PointerPosition) => {
    downAt.current = { clientX: event.clientX, clientY: event.clientY };
  }, []);

  const isClick = useCallback((event: PointerPosition) => {
    const start = downAt.current;
    downAt.current = null;
    // No recorded pointerdown means this object was not under the pointer when the
    // gesture began — usually because a drag on something else consumed it. Such a
    // click is not ours to act on.
    if (!start) return false;
    return (
      Math.hypot(event.clientX - start.clientX, event.clientY - start.clientY) <=
      DRAG_TOLERANCE_PX
    );
  }, []);

  return { onPointerDown, isClick };
}
