// The Running status mark (design/ui-refresh.html §7): the console's square status mark becomes a
// turning arc while something runs, one shape, not a swap. Its corners round and it grows into a
// 12pt ring while the fill empties (180 ms), the ring opens a quarter and turns, one lap per 1.2 s;
// when the run ends the arc closes (120 ms) and the ring shrinks back into the square (180 ms).
// It is drawn on a 14pt canvas centred on the square's own box, so the layout never moves.
// Reduced motion: a still open ring, no morph. Every other state keeps its square.
import { Canvas, cleanup, createAnimatedValue, Easing, effect, reduceMotion, token, untracked, View } from "nsh";
import { withAlpha } from "./color";

const MARK_EASE = Easing.bezier(0.2, 0.7, 0.2, 1);
const BOX = 14;
const RING = 5.2;

export function RunningMark(props: {
  running: boolean;
  /** The square's colour when not running (its border, and its fill unless `hollow`). */
  color: string;
  /** A square with no fill (an "off" mark). */
  hollow?: boolean;
  /** The ring's colour (default the theme's status-on blue). */
  ringColor?: string;
  /** The square's side: 7 (default) or 8. */
  size?: number;
  /** The square's corner radius (default 0.5, a square). */
  corner?: number;
  class?: string;
  style?: Record<string, unknown>;
  testID?: string;
}) {
  const size = untracked(() => props.size ?? 7);
  const startRunning = untracked(() => props.running);
  const still = untracked(reduceMotion);
  // 0 the square, 1 the ring; 0 closed, 1 open a quarter; the turn in radians.
  const ring = createAnimatedValue(startRunning ? 1 : 0);
  const open = createAnimatedValue(startRunning ? 1 : 0);
  const turn = createAnimatedValue(0);
  let generation = 0;
  const spin = () => {
    if (!still) void turn.keyframes([0, Math.PI * 2], { duration: 1200, easing: Easing.linear, iterations: "infinite" });
  };
  if (startRunning) spin();
  effect(() => {
    const now = props.running;
    untracked(() => {
      const run = ++generation;
      if (still) {
        ring.set(now ? 1 : 0);
        open.set(now ? 1 : 0);
        return;
      }
      if (now) {
        void ring.timing(1, { duration: 180, easing: MARK_EASE }).then(({ finished }) => {
          if (!finished || run !== generation) return;
          spin();
          void open.timing(1, { duration: 140, easing: MARK_EASE });
        });
      } else {
        void open.timing(0, { duration: 120, easing: MARK_EASE }).then(({ finished }) => {
          if (!finished || run !== generation) return;
          void turn.stop();
          void ring.timing(0, { duration: 180, easing: MARK_EASE });
        });
      }
    });
  });
  cleanup(() => {
    for (const value of [ring, open, turn]) void value.stop();
  });

  const inset = (BOX - size) / 2;
  return (
    <View accessibilityElementsHidden class={props.class} style={{ width: size, height: size, ...props.style }} testID={props.testID}>
      <Canvas
        accessibilityElementsHidden
        class="absolute"
        style={{ left: -inset, top: -inset, width: BOX, height: BOX, pointerEvents: "none" }}
        draw={(cx) => {
          const blue = withAlpha(props.ringColor ?? String(token("status-on")));
          const settled = withAlpha(props.color);
          const fill = props.hollow ? withAlpha(settled, 0) : settled;
          const center = BOX / 2;
          // The square growing into the ring: its path from the square's (inside its 1pt border)
          // to the ring's, its corners from square to round, its fill emptying.
          const side = ring.interpolate({ inputRange: [0, 1], outputRange: [size - 1, RING * 2] });
          const corner = ring.interpolate({ inputRange: [0, 1], outputRange: [props.corner ?? 0.5, RING] });
          const at = ring.interpolate({ inputRange: [0, 1], outputRange: [inset + 0.5, center - RING] });
          cx.save();
          cx.globalAlpha = ring.interpolate({ inputRange: [0, 0.999, 1], outputRange: [1, 1, 0] });
          cx.beginPath();
          cx.roundRect(at, at, side, side, corner);
          cx.fillStyle = ring.interpolate({ inputRange: [0, 1], outputRange: [fill, withAlpha(blue, 0)] });
          cx.fill();
          cx.lineWidth = ring.interpolate({ inputRange: [0, 1], outputRange: [1, 1.6] });
          cx.strokeStyle = ring.interpolate({ inputRange: [0, 1], outputRange: [settled, blue] });
          cx.stroke();
          cx.restore();
          // The ring itself, once the square has become it: an arc opening a quarter as it turns.
          cx.save();
          cx.globalAlpha = ring.interpolate({ inputRange: [0, 0.999, 1], outputRange: [0, 0, 1] });
          cx.translate(center, center);
          cx.rotate(turn);
          cx.beginPath();
          cx.arc(0, 0, RING, 0, open.interpolate({ inputRange: [0, 1], outputRange: [Math.PI * 2, Math.PI * 1.5] }));
          cx.lineWidth = 1.6;
          cx.lineCap = "round";
          cx.strokeStyle = blue;
          cx.stroke();
          cx.restore();
        }}
      />
    </View>
  );
}
