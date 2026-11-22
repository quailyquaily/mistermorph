// The spine at the left of a list of runs (the list's Today, a job's Runs, the calendar's day): a
// hairline through every row with each run's mark on it. A run that another run started is set in
// under it, and the spine swings out to it in one soft curve and back for the next run, so a chain
// reads as a branch of the day rather than as rows that happen to follow each other.
//
// Each row draws its own part on a canvas as tall as the row (nsh has no SVG): the way in, from
// where the row above left the spine (its depth) to this row's mark, straight when they are on the
// same line and an S curve otherwise; then straight down from the mark to the row's foot. The parts
// meet at the rows' edges, so the line is one line however the rows wrap.
//
// Craft: straight runs lie on whole points plus a half, the pixels a 1pt border is drawn on, so
// they are as crisp as the hairlines around them; the curve's ends are vertical, so it joins them
// without a corner.
import { Canvas, token, View } from "nsh";
import { StatusMark, type StatusState } from "../ui";

/** How far a run is set in under the run that started it. */
export const RUN_INSET = 18;
/** The spine's own column, as wide as the mark's slot. */
export const RUN_SPINE_WIDTH = 9;
/** A mark's side, and where its middle lies down a row (under the 12pt of line above it). */
const MARK = 7;
const MARK_Y = 12 + MARK / 2;

/** The room a row's content leaves for the spine at `depth`. */
export const runSpineRoom = (depth: number) => RUN_SPINE_WIDTH + Math.max(0, depth) * RUN_INSET;

/**
 * A row's part of the spine. Put it first in the row, which must be `relative`: it lies over the
 * row's left edge (`left` points in, the row's own padding) and takes no room; the row's content
 * starts `runSpineRoom(depth)` further in.
 */
export function RunSpine(props: {
  /** 0 on the day's line, one more under each run that started this one. */
  depth: number;
  /** The depth of the row above (this row's own for the first row). */
  from: number;
  tone: StatusState;
  /** The row's padding at the left, in points. */
  left?: number;
}) {
  const x = (depth: number) => Math.round(Math.max(0, depth) * RUN_INSET) + RUN_SPINE_WIDTH / 2;
  const width = () => runSpineRoom(Math.max(props.depth, props.from));
  return (
    <View
      accessibilityElementsHidden
      class="absolute bottom-0 top-0"
      style={{ left: props.left ?? 0, width: width(), pointerEvents: "none" }}
    >
      <Canvas
        class="absolute inset-0"
        style={{ pointerEvents: "none" }}
        draw={(cx, size) => {
          const at = x(props.depth);
          const from = x(props.from);
          cx.lineWidth = 1;
          cx.lineCap = "butt";
          cx.strokeStyle = String(token("line"));
          cx.beginPath();
          cx.moveTo(from, 0);
          if (from === at) {
            cx.lineTo(at, MARK_Y);
          } else {
            // Leaves and arrives vertically: the control points sit on the two lines.
            cx.bezierCurveTo(from, MARK_Y * 0.7, at, MARK_Y * 0.3, at, MARK_Y);
          }
          cx.lineTo(at, size.height);
          cx.stroke();
        }}
      />
      <View class="absolute" style={{ left: x(props.depth) - MARK / 2, top: MARK_Y - MARK / 2 }}>
        <StatusMark state={props.tone} size={MARK} corner={2} />
      </View>
    </View>
  );
}
