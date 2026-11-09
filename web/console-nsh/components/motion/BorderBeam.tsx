// The loading state (design/ui-refresh.html §5–6): a short gradient segment riding a box's own
// 1pt border clockwise, one lap per 2.3s at a constant speed round the corners, with a faint
// blurred copy under it. Put it last inside a `relative` box that has the border: it reaches out
// by the border's width to lie on it (so the box must not clip) and takes no presses. The segment
// is a run of dashes on the rounded-rect path, each a step of the gradient (clear tail → the tone
// at 72% → its light head), their offsets driven by one animated value, so the beam moves natively
// without redrawing. Reduced motion: it rests at the top left, 12% along the border.
import { Canvas, cleanup, createAnimatedValue, Easing, untracked, reduceMotion, token } from "nsh";
import { mix, withAlpha } from "./color";

export type BeamTone = "blue" | "red" | "amber";

const LAP_MS = 2300;
const SLICES = 14;
const REST = 0.12;

/** Each tone's body (at 72%) and head colours, from the theme. */
function toneColors(tone: BeamTone): [string, string] {
  switch (tone) {
    case "red":
      return [String(token("danger")), "#e9b3bf"];
    case "amber":
      return [String(token("warn-dark")), "#efc88c"];
    default:
      return [String(token("blue")), String(token("blue-lighter"))];
  }
}

/** The gradient at `t` (0 tail .. 1 head): transparent → body at 0.72 → head. */
function beamColor(body: string, head: string, t: number) {
  return t <= 0.72 ? withAlpha(body, t / 0.72) : mix(body, head, (t - 0.72) / 0.28);
}

export function BorderBeam(props: {
  /** The segment's length in points: 96 on the composer, 64 on md/sm buttons, 40 on xs/xxs. */
  length: number;
  tone?: BeamTone;
  /** The box's corner radius (default 2, the console's `--radius`). */
  radius?: number;
  /** A hairline drawn round the box under the beam, for a box without a border of its own. */
  track?: string;
  /** The box's border width (default 1): the beam lies on the border's outer edge. */
  border?: number;
  testID?: string;
}) {
  const phase = createAnimatedValue(REST);
  const still = untracked(reduceMotion);
  if (!still) {
    phase.set(0);
    void phase.keyframes([0, 1], { duration: LAP_MS, easing: Easing.linear, iterations: "infinite" });
  }
  cleanup(() => void phase.stop());

  return (
    <Canvas
      accessibilityElementsHidden
      testID={props.testID}
      class="absolute"
      style={{ left: -(props.border ?? 1), top: -(props.border ?? 1), right: -(props.border ?? 1), bottom: -(props.border ?? 1), pointerEvents: "none" }}
      draw={(cx, size) => {
        const [body, head] = toneColors(props.tone ?? "blue");
        const w = size.width - 1;
        const h = size.height - 1;
        if (w <= 2 || h <= 2) return;
        const r = Math.min(props.radius ?? 2, w / 2, h / 2);
        // The rounded rect's length; the dash pattern repeats once per lap.
        const perimeter = 2 * (w + h) - 8 * r + 2 * Math.PI * r;
        const length = Math.min(props.length, perimeter * 0.45);
        const slice = length / SLICES;
        const pass = (lineWidth: number, alpha: number) => {
          cx.lineWidth = lineWidth;
          cx.globalAlpha = alpha;
          cx.lineCap = "butt";
          for (let k = 0; k < SLICES; k++) {
            cx.beginPath();
            cx.roundRect(0.5, 0.5, w, h, r);
            cx.strokeStyle = beamColor(body, head, (k + 0.5) / SLICES);
            // Slightly long slices so neighbours overlap and leave no seams.
            cx.setLineDash([slice + 0.15, perimeter - slice - 0.15]);
            const at = k * slice;
            cx.lineDashOffset = phase.interpolate({ inputRange: [0, 1], outputRange: [-at, -at - perimeter] });
            cx.stroke();
          }
        };
        if (props.track) {
          cx.beginPath();
          cx.roundRect(0.5, 0.5, w, h, r);
          cx.lineWidth = 1;
          cx.strokeStyle = props.track;
          cx.stroke();
        }
        // The glow: a 3pt copy at a quarter strength, softened.
        cx.save();
        cx.shadowColor = body;
        cx.shadowBlur = 3;
        pass(3, 0.25);
        cx.restore();
        pass(1, 1);
      }}
    />
  );
}
