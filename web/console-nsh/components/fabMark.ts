// The Fab's registration marks (components/ui.tsx, `Fab`): two open corners just outside the
// button's top-left and bottom-right corners, each drawn as ONE open stroke: a straight arm, a
// continuous corner curve concentric with the button's own, then the other straight arm. A mark
// built from two border sides of a box (FT155) was painted side by side, each side's half of the
// turn rasterised on its own, so the two halves could part at the curve; one stroked path has no
// such join. The path is the approved prototype's (FT157): the button's corner curve (Core
// Animation's, which nsh's web and Apple backends draw for `corner-squircle`) at the button's 8pt
// radius plus the stroke centre's 4.5pt offset, between 22pt arms.

import { RADIUS } from "./corners";

export type Point = readonly [number, number];

/**
 * Core Animation's continuous corner, in units of the radius: three cubic curves from the first
 * edge's tangent point to the second's, each `[start, control 1, control 2, end]`. A point is
 * `[along the first edge from the corner, along the second edge from the corner]`. Between two
 * curves the curve runs straight from one's end to the next one's start (a fraction of a point).
 */
export const CONTINUOUS_CORNER_CURVES: readonly (readonly [Point, Point, Point, Point])[] = [
  [[1.52866483, 0], [1.08849296, 0], [0.86840694, 0], [0.66993427, 0.065496]],
  [[0.63149399, 0.074911], [0.37282392, 0.16905899], [0.16905899, 0.37282392], [0.074911, 0.63149399]],
  [[0.065496, 0.66993427], [0, 0.86840694], [0, 1.08849296], [0, 1.52866483]],
];

/** How far along each edge the continuous curve reaches, in units of the radius. */
export const CONTINUOUS_CORNER_REACH = CONTINUOUS_CORNER_CURVES[0][0][0];

/**
 * The marks' measures, in points: the button's side and corner radius, the marks' outer edge
 * `gap` outside the button, their stroke width, and each arm's length from the mark's corner point.
 */
export const FAB_MARK = { button: 52, radius: RADIUS.control, gap: 5, stroke: 1, arm: 22 } as const;

/** How far outside the button the stroke's centre line runs: 4.5pt. */
export const FAB_MARK_OFFSET = FAB_MARK.gap - FAB_MARK.stroke / 2;
/** The mark's curve radius, concentric with the button's corner: 8 + 4.5 = 12.5pt. */
export const FAB_MARK_RADIUS = FAB_MARK.radius + FAB_MARK_OFFSET;
/** Each arm's length from the mark's corner point: the approved 22pt, never shorter than the curve's reach (19.1pt). */
export const FAB_MARK_ARM = Math.max(FAB_MARK.arm, CONTINUOUS_CORNER_REACH * FAB_MARK_RADIUS);
/**
 * The side of each mark's square canvas: half a stroke round the corner point, the arm, and the
 * other half stroke past its square end (23pt). It lies `FAB_MARK.gap` outside the button's corner.
 */
export const FAB_MARK_SIZE = FAB_MARK.stroke + FAB_MARK_ARM;

export type FabMarkCorner = "start" | "end";

export type MarkSegment = { kind: "line"; to: Point } | { kind: "curve"; c1: Point; c2: Point; to: Point };

/** A mark's one open path, in its canvas's points: `M start`, then line, curve, line, curve, line, curve, line. */
export type MarkPath = { start: Point; segments: MarkSegment[] };

/**
 * The path of the top-left (`start`) or bottom-right (`end`) mark in its own canvas. The start
 * mark's corner point is half a stroke in from the canvas's top left; the end mark is the start
 * mark turned half round the canvas's centre (as the bottom-right corner is the top-left one turned
 * about the button's).
 */
export function fabMarkPath(corner: FabMarkCorner): MarkPath {
  const half = FAB_MARK.stroke / 2;
  const r = FAB_MARK_RADIUS;
  const turn = (p: Point): Point => (corner === "start" ? p : [FAB_MARK_SIZE - p[0], FAB_MARK_SIZE - p[1]]);
  // First edge: the top arm (to the right of the corner point); second edge: the left arm.
  const at = (a: number, b: number): Point => turn([half + a * r, half + b * r]);
  const segments: MarkSegment[] = [];
  for (const [p0, c1, c2, p1] of CONTINUOUS_CORNER_CURVES) {
    segments.push({ kind: "line", to: at(p0[0], p0[1]) });
    segments.push({ kind: "curve", c1: at(c1[0], c1[1]), c2: at(c2[0], c2[1]), to: at(p1[0], p1[1]) });
  }
  segments.push({ kind: "line", to: turn([half, half + FAB_MARK_ARM]) });
  return { start: turn([half + FAB_MARK_ARM, half]), segments };
}

/** The drawing calls a mark makes (`CanvasRenderingContext2D`'s, as a test can record them). */
export type MarkContext = {
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  bezierCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): void;
  stroke(): void;
  lineWidth: unknown;
  lineCap: unknown;
  lineJoin: unknown;
  strokeStyle: unknown;
};

/** Draws one mark as a single stroke of `color`, with nothing filled. */
export function drawFabMark(cx: MarkContext, corner: FabMarkCorner, color: string) {
  const { start, segments } = fabMarkPath(corner);
  cx.beginPath();
  cx.moveTo(start[0], start[1]);
  for (const s of segments) {
    if (s.kind === "line") cx.lineTo(s.to[0], s.to[1]);
    else cx.bezierCurveTo(s.c1[0], s.c1[1], s.c2[0], s.c2[1], s.to[0], s.to[1]);
  }
  cx.lineWidth = FAB_MARK.stroke;
  cx.lineCap = "butt";
  // Rounds the curve's few-degree turns onto its sub-point straight runs, as the prototype's SVG does.
  cx.lineJoin = "round";
  cx.strokeStyle = color;
  cx.stroke();
}
