// The user bubble's tail (the Vue console's core/chat-bubble-tail.js), drawn on the device pixel
// grid the way the bubble's 1px border is, so the two read as one line at any pixel density.
//
// A 1px border is drawn whole device pixels wide (at 1.5x: one device pixel) and on device pixel
// edges. A 1pt stroke on a canvas is not: at 1.5x it is 1.5 device pixels, smoothed across two, so
// the tail would look wider and paler than the border it continues. So the line is the border's
// width in device pixels, and its straight parts sit on the border's own pixels.
//
// The geometry is in points, from the corner where the bubble's top and right borders meet, less
// the line width to the left: the drawing's first column is the right border, its first row the
// top border.

/** How far the tip reaches past the bubble's border, down the right edge to where the slope meets
 * it, the concave fillet there and the rounding of the tip. */
const TAIL_REACH = 8;
const TAIL_RISE = 11.5;
const TAIL_FILLET = 4;
const TAIL_TIP = 1.6;

export type Point = [number, number];

export interface BubbleTail {
  /** The line's width in points: whole device pixels, at least one. */
  line: number;
  /** The drawing's box, in points. */
  width: number;
  height: number;
  /** The outline, from the right edge to the top edge (stroked). */
  outline: { start: Point; corner: Point; filletEnd: Point; tipStart: Point; tip: Point; tipEnd: Point; end: Point };
}

/** The width a 1pt border is drawn at for `dpr`, in points. */
export function borderWidth(dpr: number) {
  const ratio = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  return Math.max(1, Math.floor(ratio + 1e-6)) / ratio;
}

export function bubbleTail(dpr: number): BubbleTail {
  const line = borderWidth(dpr);
  const half = line / 2;
  const edgeX = half;
  const topY = half;
  const corner: Point = [edgeX, topY + TAIL_RISE];
  const tip: Point = [line + TAIL_REACH - half, topY];
  const dx = tip[0] - corner[0];
  const dy = tip[1] - corner[1];
  const length = Math.hypot(dx, dy);
  const ux = dx / length;
  const uy = dy / length;
  const start: Point = [edgeX, corner[1] + TAIL_FILLET];
  const filletEnd: Point = [corner[0] + ux * TAIL_FILLET, corner[1] + uy * TAIL_FILLET];
  const tipStart: Point = [tip[0] - ux * TAIL_TIP, tip[1] - uy * TAIL_TIP];
  const tipEnd: Point = [tip[0] - TAIL_TIP, topY];
  return {
    line,
    width: Math.ceil(tip[0] + line),
    height: Math.ceil(start[1] + line),
    outline: { start, corner, filletEnd, tipStart, tip, tipEnd, end: [0, topY] },
  };
}

interface PathSink {
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void;
  closePath(): void;
}

/** The fill: covers the bubble's own borders under the tail, up to the outline's centre. */
export function traceTailFill(cx: PathSink, tail: BubbleTail) {
  const o = tail.outline;
  cx.beginPath();
  cx.moveTo(0, 0);
  cx.lineTo(...o.tipEnd);
  cx.quadraticCurveTo(...o.tip, ...o.tipStart);
  cx.lineTo(...o.filletEnd);
  cx.quadraticCurveTo(...o.corner, ...o.start);
  cx.lineTo(0, o.start[1]);
  cx.closePath();
}

/** The outline: the right edge flowing through the fillet into the slope, round the tip, along the
 * top edge back to the bubble. */
export function traceTailOutline(cx: PathSink, tail: BubbleTail) {
  const o = tail.outline;
  cx.beginPath();
  cx.moveTo(...o.start);
  cx.quadraticCurveTo(...o.corner, ...o.filletEnd);
  cx.lineTo(...o.tipStart);
  cx.quadraticCurveTo(...o.tip, ...o.tipEnd);
  cx.lineTo(...o.end);
}
