// The check a message's copy button shows once copied, drawn as a pen draws it: the short stroke
// down to the corner, then the long one up to the right. The shape is Phosphor's `check` (the
// icon the button showed before, assets/icons/check.svg: a polyline on a 256 grid, 16 wide), so
// the drawn check has the size and weight of the icon. The canvas reveals it with one dash as long
// as the path, its offset bound to an animated value (0: nothing, 1: the whole check), so the
// stroke moves natively, without JS per frame.

/** The check's box, in points: the size the copy icon has. */
export const CHECK_SIZE = 14;

/** How long drawing the check takes, in milliseconds. */
export const CHECK_DRAW_MS = 320;

/** Phosphor's check on its 256 grid: start, the corner, the end. */
const GRID = 256;
const GRID_POINTS: [number, number][] = [
  [40, 144],
  [96, 200],
  [224, 72],
];
const GRID_WIDTH = 16;

export type Point = [number, number];

export interface CheckStroke {
  /** Start, corner, end, in points within a `size` box. */
  points: [Point, Point, Point];
  /** The pen's width. */
  width: number;
  /** The short stroke's length (down to the corner) and the long one's (up to the end). */
  down: number;
  up: number;
  length: number;
  /** How far along the path the corner is (0..1). */
  corner: number;
}

/** The check in a `size` point box. */
export function checkStroke(size: number = CHECK_SIZE): CheckStroke {
  const k = size / GRID;
  const [a, b, c] = GRID_POINTS.map(([x, y]) => [x * k, y * k] as Point);
  const down = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const up = Math.hypot(c[0] - b[0], c[1] - b[1]);
  return { points: [a, b, c], width: GRID_WIDTH * k, down, up, length: down + up, corner: down / (down + up) };
}

/** The part of the check drawn at `progress` (0..1): the polyline from the start to the pen. */
export function checkStrokeAt(stroke: CheckStroke, progress: number): Point[] {
  const p = Math.min(1, Math.max(0, progress));
  const [a, b, c] = stroke.points;
  const lerp = (from: Point, to: Point, t: number): Point => [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t];
  if (p <= 0) return [a];
  if (p <= stroke.corner) return [a, lerp(a, b, p / stroke.corner)];
  return [a, b, lerp(b, c, (p - stroke.corner) / (1 - stroke.corner))];
}

/**
 * The dash that reveals the check at `progress`: one dash as long as the path and a gap a little
 * longer, offset so the dash ends where the pen is. At 0 the start sits inside the gap, so not even
 * the round cap shows. The canvas binds the offset to an animated value with the same mapping
 * (`interpolate` over [0, 1] to [hidden, 0]).
 */
export function checkDash(stroke: CheckStroke) {
  return { segments: [stroke.length, stroke.length + 2], hidden: stroke.length + 1 };
}
export function checkDashOffset(stroke: CheckStroke, progress: number) {
  const p = Math.min(1, Math.max(0, progress));
  return checkDash(stroke).hidden * (1 - p);
}

/**
 * When the pen reaches the corner, as a share of CHECK_DRAW_MS. The short stroke takes a little
 * more than its share of the path (a hand turns at the corner) and eases into the corner; the long
 * one leaves it quickly and settles at the end (the keyframes in ChatHistoryItem's CopyButton).
 */
export const CHECK_CORNER_AT = 0.4;

/**
 * What the check does when the button's state changes (`seen` is the last copy the button knew
 * of, `seq` the latest, `copied` whether this message's copy is the one that holds):
 * - `draw`: a new successful copy of this message; draws the check from nothing, also when a copy
 *   is repeated while the check still shows.
 * - `show`: copied, but not by a new copy (the row was bound again while the check holds), or the
 *   user asks for less motion: the whole check at once.
 * - `none`: not copied (idle, another message copied, the check expired): the copy icon shows.
 * A copy that failed or had nothing to copy changes neither `seq` nor `copied`.
 */
export type CheckAction = "none" | "draw" | "show";
export function checkAction(seen: number, seq: number, copied: boolean, reducedMotion: boolean): CheckAction {
  if (!copied) return "none";
  if (seq === seen || reducedMotion) return "show";
  return "draw";
}
