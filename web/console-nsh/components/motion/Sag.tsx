// The soft sag (design/ui-refresh.html §1–2): a hairline that dips beside what is selected, as
// `offset = d · (1 − u²)²` with `u` the distance from the dip's centre over its half-span `h`, so
// it leaves and rejoins the straight line with no kink. The dip is sized to what it marks: 3pt
// deep, its half-span 0.7 of the item's length, so it stays close to that item.
//
// The dip is drawn around 0 with the straight line running far past both ends and moved along the
// line by a translation; its place, its span and its depth are animated values, so a change of
// selection runs natively, without redrawing: the dip glides to the next item (320 ms, a long
// settle), taking that item's span on the way, and eases a little shallower while it travels,
// sinking back in as it lands. It sinks in and flattens out the same way when something is
// selected after nothing, or nothing after something. Over the straight line the dip's own stroke
// fades from the line's colour to blue at its deepest point and back. The sidebar's highlight
// (BandEdge) glides the same way, on a straight edge.
import { Canvas, cleanup, createAnimatedValue, effect, Easing, token, untracked } from "nsh";
import type { CanvasRenderingContext2D } from "nsh";
import { withAlpha } from "./color";
import { motionMs } from "./tokens";

const GLIDE_MS = 320;
const GLIDE_EASE = Easing.bezier(0.3, 0.7, 0.2, 1);
/** How shallow the dip gets mid-glide, as a share of its depth. */
const TRAVEL_DEPTH = 0.55;
/** The dip's depth, and its half-span over the selected item's size (a 38pt toggle: 27pt). */
const DEPTH = 3;
const SPAN = 0.7;
const STEPS = 48;

/** The half-span of a dip beside an item `size` points long (never under 16). */
export function sagHalf(size: number) {
  return Math.max(16, size * SPAN);
}

/** The dip's place along the line, its half-span and its depth (0 when nothing is selected), animated. */
function createSag(center: () => number | null, half: () => number, depth: number) {
  const at = createAnimatedValue(0);
  const span = createAnimatedValue(untracked(half));
  const deep = createAnimatedValue(0);
  // 1 while something is selected: what marks the selection besides the dip shows with it.
  const on = createAnimatedValue(0);
  let shown = false;
  effect(() => {
    const c = center();
    const h = half();
    untracked(() => {
      const duration = motionMs(GLIDE_MS);
      if (c === null) {
        if (shown) {
          void deep.timing(0, { duration, easing: GLIDE_EASE });
          void on.timing(0, { duration, easing: GLIDE_EASE });
        }
        shown = false;
        return;
      }
      if (!shown) {
        // A selection after none: the dip sinks in where the item is.
        at.set(c);
        span.set(h);
        void deep.timing(depth, { duration, easing: GLIDE_EASE });
        void on.timing(1, { duration, easing: GLIDE_EASE });
        shown = true;
        return;
      }
      void at.timing(c, { duration, easing: GLIDE_EASE });
      void span.timing(h, { duration, easing: GLIDE_EASE });
      if (duration > 0) {
        void deep.keyframes(
          [
            { offset: 0, value: depth },
            { offset: 0.4, value: depth * TRAVEL_DEPTH, easing: "easeOut" },
            { offset: 1, value: depth, easing: "easeInOut" },
          ],
          { duration },
        );
      }
    });
  });
  cleanup(() => {
    for (const value of [at, span, deep, on]) void value.stop();
  });
  return { at, span, deep, on };
}

/** The sag's profile over `u` from -1 to 1, as (u, across) pairs: `across` is the dip's depth there over `depth`. */
const PROFILE: [number, number][] = Array.from({ length: STEPS + 1 }, (_, k) => {
  const u = -1 + (2 * k) / STEPS;
  return [u, (1 - u * u) ** 2];
});

/** A blue that fades out at both ends of the dip, laid along the axis from -half to half. */
function dipGradient(cx: CanvasRenderingContext2D, half: number) {
  const blue = String(token("blue"));
  const gradient = cx.createLinearGradient(-half, 0, half, 0);
  gradient.addColorStop(0, withAlpha(blue, 0));
  gradient.addColorStop(0.5, withAlpha(blue));
  gradient.addColorStop(1, withAlpha(blue, 0));
  return gradient;
}

/**
 * A horizontal hairline along the bottom of a head that sags under the selected control.
 * `center` is the x of that control's centre in the canvas (null: none, a straight line);
 * `color` is the straight line's colour (it may be transparent). Place it absolutely, its top on
 * the line: it draws the line 0.7pt down and the dip below it.
 */
export function SagRule(props: { center: () => number | null; half: number; color: string; depth?: number; class?: string }) {
  const depth = untracked(() => props.depth ?? DEPTH);
  const sag = createSag(props.center, () => props.half, depth);
  return (
    <Canvas
      accessibilityElementsHidden
      class={props.class}
      style={{ pointerEvents: "none" }}
      draw={(cx, size) => {
        const y = 0.7;
        const far = size.width + 64;
        const point = (u: number, across: number) => [sag.span.mul(u), sag.deep.mul(across).add(y)] as const;
        cx.beginPath();
        cx.rect(0, 0, size.width, size.height);
        cx.clip();
        cx.translate(sag.at, 0);
        cx.lineCap = "round";
        cx.lineJoin = "round";
        cx.lineWidth = 1;
        cx.strokeStyle = props.color;
        cx.beginPath();
        cx.moveTo(-far, y);
        for (const [u, across] of PROFILE) cx.lineTo(...point(u, across));
        cx.lineTo(far * 2, y);
        cx.stroke();
        cx.lineWidth = 1.4;
        cx.globalAlpha = sag.deep.div(depth);
        cx.strokeStyle = dipGradient(cx, props.half);
        cx.beginPath();
        PROFILE.forEach(([u, across], index) => {
          if (index === 0) cx.moveTo(...point(u, across));
          else cx.lineTo(...point(u, across));
        });
        cx.stroke();
      }}
    />
  );
}

/**
 * A column's fill, its straight right edge, and the selected item's highlight: a band `size` tall
 * across the column, its right side on the edge, its top and bottom flaring into the edge in an
 * arc of `radius` each, so the band and the edge read as one line. `center` is that item's centre
 * (y) in the canvas, or null. Put it first in the column, absolutely over the whole of it, in place
 * of the column's own background, border and row highlight. The band glides to the next item as a
 * tab rule's dip does; a nav is not a set of tabs, so the edge itself stays straight.
 */
export function BandEdge(props: {
  center: () => number | null;
  fill: string;
  line: string;
  band: { size: number; color: string; radius?: number };
  class?: string;
}) {
  const sag = createSag(props.center, () => props.band.size, 0);
  return (
    <Canvas
      accessibilityElementsHidden
      class={props.class}
      style={{ pointerEvents: "none" }}
      draw={(cx, size) => {
        const x = size.width - 0.5;
        cx.fillStyle = props.fill;
        cx.fillRect(0, 0, x, size.height);
        cx.save();
        cx.beginPath();
        cx.rect(0, 0, size.width, size.height);
        cx.clip();
        cx.translate(0, sag.at);
        const top = -props.band.size / 2;
        const bottom = props.band.size / 2;
        const r = Math.min(props.band.radius ?? 6, props.band.size / 2);
        cx.globalAlpha = sag.on;
        cx.fillStyle = props.band.color;
        cx.beginPath();
        cx.moveTo(0, top);
        cx.lineTo(x - r, top);
        cx.quadraticCurveTo(x, top, x, top - r);
        cx.lineTo(x, bottom + r);
        cx.quadraticCurveTo(x, bottom, x - r, bottom);
        cx.lineTo(0, bottom);
        cx.closePath();
        cx.fill();
        cx.restore();
        cx.lineWidth = 1;
        cx.strokeStyle = props.line;
        cx.beginPath();
        cx.moveTo(x, 0);
        cx.lineTo(x, size.height);
        cx.stroke();
      }}
    />
  );
}
