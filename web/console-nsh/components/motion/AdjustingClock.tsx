// The alarm clock icon whose hands are being set: while something runs, its two hands turn as a
// clock's do when someone winds its crown, and the face, the bells and the box stay put.
//
// The icon is Phosphor's alarm (regular weight, assets/icons/alarm.svg) split in two: the face and
// its bells are the handless copy (alarm-face.svg) as an Image tinted like any Icon, and the hands
// are drawn on a Canvas over it at the icon's own geometry (its 256 grid: centre 128,136, hands 56
// long, 16 wide with round caps). At rest they show the icon's three o'clock, so the idle icon is
// the plain alarm icon. Turning, each hand has its own native animated angle: the minute hand
// sweeps a lap per 1.2 s in eased strokes (fast, then slowing to the top, as a crown is turned),
// the hour hand creeps on steadily at a twelfth of its speed (a lap per 14.4 s), so they move
// apart rather than as one turning picture, and both take the blue of a run (180 ms). When the run
// ends they stop where they are and settle back to three o'clock (260 ms): the minute hand on to
// the top, the hour hand the short way round; a new run meanwhile picks them up from there.
//
// Reduced motion: no turning. The hands stand still at ten past ten in blue (an open V where the
// idle icon shows an L), and go back to three o'clock at once when the run ends.
import { Canvas, cleanup, createAnimatedValue, Easing, effect, Image, reduceMotion, signal, token, untracked, View } from "nsh";
import FACE from "../../assets/icons/alarm-face.svg";
import { withAlpha } from "./color";
import { MOTION_EASE, MOTION_NORMAL, MOTION_SLOW } from "./tokens";

type TokenName = Parameters<typeof token>[0];

const TAU = Math.PI * 2;
/** Three o'clock, the icon's own hands: the minute hand at the top, the hour hand at three. */
export const CLOCK_REST = { minute: 0, hour: TAU / 4 };
/** Ten past ten, the reduced-motion pose while running. */
export const CLOCK_STILL = { minute: TAU / 6, hour: (TAU * 10) / 12 + TAU / 144 };
/** One lap of the minute hand while turning (ms); the hour hand takes twelve times as long. */
export const MINUTE_LAP = 1200;
export const HOUR_LAP = MINUTE_LAP * 12;
const STROKE = Easing.bezier(0.45, 0, 0.55, 1);

/** How the hands move now: at rest, turning, settling back to rest, or held still (reduced motion). */
export type ClockPhase = "rest" | "turning" | "settling" | "still";

/** Reads the hands (tests): their angles in radians from the top, clockwise, within one lap. */
export type ClockProbe = () => Promise<{ minute: number; hour: number; phase: ClockPhase }>;

const lap = (angle: number) => ((angle % TAU) + TAU) % TAU;

export function AdjustingClock(props: {
  /** The hands turn (or, with reduced motion, stand at ten past ten). */
  adjusting: boolean;
  /** The icon's side (default 14). */
  size?: number;
  /** The face's colour, and the hands' at rest. */
  color: TokenName;
  testID?: string;
  /** Mounted (an invisible box over the icon) only while adjusting. */
  adjustingTestID?: string;
  /** Hears how to read the hands (tests). */
  probe?: (read: ClockProbe) => void;
}) {
  const size = untracked(() => props.size ?? 14);
  const still = untracked(reduceMotion);
  const start = untracked(() => props.adjusting);
  const pose = start && still ? CLOCK_STILL : CLOCK_REST;
  const minute = createAnimatedValue(pose.minute);
  const hour = createAnimatedValue(pose.hour);
  // 0 the face's colour, 1 a run's blue.
  const tint = createAnimatedValue(start ? 1 : 0);
  const phase = signal<ClockPhase>(start ? (still ? "still" : "turning") : "rest");
  let generation = 0;

  // Each hand loops from where it stands, so a run that starts again mid-settle picks them up there.
  const turn = (fromMinute: number, fromHour: number) => {
    phase.set("turning");
    void minute.keyframes([fromMinute, fromMinute + TAU], { duration: MINUTE_LAP, easing: STROKE, iterations: "infinite" });
    void hour.keyframes([fromHour, fromHour + TAU], { duration: HOUR_LAP, easing: Easing.linear, iterations: "infinite" });
  };

  const settle = async (run: number) => {
    phase.set("settling");
    const [m, h] = await Promise.all([minute.stop(), hour.stop()]);
    if (run !== generation) return;
    const fromMinute = lap(m.value);
    const fromHour = lap(h.value);
    minute.set(fromMinute);
    hour.set(fromHour);
    // The minute hand finishes its stroke to the top; the hour hand takes the short way to three.
    const toMinute = fromMinute === 0 ? 0 : TAU;
    let toHour = CLOCK_REST.hour;
    if (fromHour - toHour > Math.PI) toHour += TAU;
    const timing = { duration: MOTION_SLOW, easing: MOTION_EASE };
    const done = await Promise.all([minute.timing(toMinute, timing), hour.timing(toHour, timing)]);
    if (run !== generation || !done.every((result) => result.finished)) return;
    minute.set(CLOCK_REST.minute);
    hour.set(CLOCK_REST.hour);
    phase.set("rest");
  };

  if (start && !still) turn(pose.minute, pose.hour);
  effect(() => {
    const now = props.adjusting;
    untracked(() => {
      const run = ++generation;
      if (still) {
        const at = now ? CLOCK_STILL : CLOCK_REST;
        minute.set(at.minute);
        hour.set(at.hour);
        tint.set(now ? 1 : 0);
        phase.set(now ? "still" : "rest");
        return;
      }
      void tint.timing(now ? 1 : 0, { duration: MOTION_NORMAL, easing: MOTION_EASE });
      if (now) {
        if (phase() === "turning") return;
        void Promise.all([minute.stop(), hour.stop()]).then(([m, h]) => {
          if (run === generation) turn(lap(m.value), lap(h.value));
        });
      } else if (phase() !== "rest") {
        void settle(run);
      }
    });
  });
  cleanup(() => {
    generation++;
    for (const value of [minute, hour, tint]) void value.stop();
  });

  untracked(() =>
    props.probe?.(async () => {
      const [m, h] = await Promise.all([minute.getValue(), hour.getValue()]);
      return { minute: lap(m), hour: lap(h), phase: untracked(phase) };
    }),
  );

  // The icon's 256 grid in points.
  const unit = size / 256;
  return (
    <View accessibilityElementsHidden testID={props.testID} style={{ width: size, height: size }}>
      <Image
        src={FACE}
        accessibilityElementsHidden
        style={{ width: size, height: size, tintColor: token(props.color) as string }}
      />
      <Canvas
        accessibilityElementsHidden
        class="absolute"
        style={{ left: 0, top: 0, width: size, height: size, pointerEvents: "none" }}
        draw={(cx) => {
          const face = withAlpha(String(token(props.color)));
          const blue = withAlpha(String(token("blue")));
          cx.save();
          cx.translate(128 * unit, 136 * unit);
          cx.lineWidth = 16 * unit;
          cx.lineCap = "round";
          cx.strokeStyle = tint.interpolate({ inputRange: [0, 1], outputRange: [face, blue] });
          for (const angle of [hour, minute]) {
            cx.save();
            cx.rotate(angle);
            cx.beginPath();
            cx.moveTo(0, 0);
            cx.lineTo(0, -56 * unit);
            cx.stroke();
            cx.restore();
          }
          cx.restore();
        }}
      />
      <If when={props.adjusting && props.adjustingTestID}>
        <View
          accessibilityElementsHidden
          testID={props.adjustingTestID}
          class="absolute inset-0"
          style={{ pointerEvents: "none" }}
        />
      </If>
    </View>
  );
}
