// Dialog origin (the Vue console's core/dialog-origin.js): the shell notes where the last press
// went down; a dialog that opens within a moment of it grows out of that point (and shrinks back
// into it), instead of popping up from nowhere in the middle. `Modal` and `MessageDialog` read it;
// the shell feeds it from its root view's touch capture, which sees every press first.

const RECENT_MS = 900;
let last: { x: number; y: number; at: number } | null = null;

/** A press went down at (`x`, `y`) in the window. */
export function notePress(x: number, y: number) {
  if (Number.isFinite(x) && Number.isFinite(y)) last = { x, y, at: performance.now() };
}

/** Where the press that is opening something now went down, or null when none was recent. */
export function recentPress(): { x: number; y: number } | null {
  if (!last || performance.now() - last.at > RECENT_MS) return null;
  return { x: last.x, y: last.y };
}
