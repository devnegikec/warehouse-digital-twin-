/**
 * Editor palette. Kept in one place so the 3D scene and the 2D panels agree —
 * a colour that means "selected" in the canvas must mean the same in a list.
 */
export const COLORS = {
  background: '#0b1220',
  panel: '#0f172a',
  panelBorder: '#1e293b',
  floor: '#132033',
  floorEdge: '#334155',
  grid: '#1b2942',
  gridSection: '#2a3d5c',

  aisle: '#3b82f6',
  aisleSelected: '#22d3ee',
  rackFrame: '#64748b',
  bin: '#7c8ba1',
  binHover: '#f59e0b',
  binSelected: '#22d3ee',
  obstacle: '#ef4444',

  ok: '#10b981',
  error: '#ef4444',
  warning: '#f59e0b',
  info: '#38bdf8',

  text: '#e2e8f0',
  textDim: '#94a3b8',
  textFaint: '#64748b',
} as const;

/** Snap increments offered in the toolbar, in metres. */
export const SNAP_OPTIONS = [0.05, 0.1, 0.25, 0.5, 1] as const;
