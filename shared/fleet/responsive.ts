/** Logical points of the panel itself, which may be narrower than the window. */
export type Breakpoint = "phone" | "tablet" | "desktop";
export const PANEL_MAX_WIDTH = 1440;
export const GRID_GAP = 16;

export function breakpointForWidth(width: number): Breakpoint {
  if (!Number.isFinite(width) || width < 600) return "phone";
  return width < 1200 ? "tablet" : "desktop";
}

export function columnsForWidth(width: number): 1 | 2 | 3 {
  const breakpoint = breakpointForWidth(width);
  return breakpoint === "phone" ? 1 : breakpoint === "tablet" ? 2 : 3;
}

/** Also keep nested cards readable: their own measured width can reduce the column count. */
export function gridColumns(width: number, maxColumns: number, minCellWidth = 260): number {
  const fit = Math.max(1, Math.floor((width + GRID_GAP) / (minCellWidth + GRID_GAP)));
  return Math.min(Math.max(1, maxColumns), fit);
}

export function gridCellWidth(width: number, columns: number): number {
  return Math.max(0, (width - GRID_GAP * (columns - 1)) / columns);
}

/** Minimal scroll needed to reveal a selected phone tab, including a restored tab. */
export function tabScrollOffset(x: number, width: number, viewport: number, current: number): number {
  if (x < current) return Math.max(0, x);
  if (x + width > current + viewport) return Math.max(0, x + width - viewport);
  return current;
}
