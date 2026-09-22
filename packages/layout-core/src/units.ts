/**
 * Units and numeric tolerances.
 *
 * The canonical unit is METRES everywhere: the document, the database, the compiler.
 * 1 three.js scene unit = 1 m. Do not introduce a second unit anywhere.
 */

/** Geometry comparison tolerance: 0.1 mm. All comparisons are inclusive within EPS. */
export const EPS = 1e-4;

/** Decimals retained in canonical output. Must match `canonical.py`. */
export const PRECISION = 6;

/** Share of a bin's raw volume considered usable (honeycombing, handling clearance). */
export const DEFAULT_UTILIZATION = 0.85;

/** Below this clear corridor width we warn — typical counterbalance forklift needs ~2.5 m. */
export const MIN_AISLE_WIDTH_M = 2.5;

/** Cap repeated diagnostics so one bad parameter cannot emit 10k messages. */
export const MAX_DIAGNOSTICS_PER_CODE = 25;

/**
 * Round half away from zero, matching the Python implementation in `canonical.py`
 * (which uses Decimal + ROUND_HALF_UP rather than Python's banker's rounding).
 */
export function round(n: number, decimals: number = PRECISION): number {
  const r = Number(n.toFixed(decimals));
  return Object.is(r, -0) ? 0 : r;
}

export function nearlyEqual(a: number, b: number, eps: number = EPS): boolean {
  return Math.abs(a - b) <= eps;
}

export function nearlyZero(n: number, eps: number = EPS): boolean {
  return Math.abs(n) <= eps;
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}

/** Snap to the editor grid. `step <= 0` disables snapping. */
export function snap(n: number, step: number): number {
  return step > 0 ? round(Math.round(n / step) * step) : n;
}
