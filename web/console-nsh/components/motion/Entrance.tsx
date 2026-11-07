// Entrances: a view that settles in when what it shows changes (the Vue console's
// core/page-transitions.js: a new page fades in with a 6px rise), and a row that just arrived
// (styles/base.css `.is-arrived`: a selection-blue tint that holds, then fades back).
//
//   <Entrance watch={pageKey()} class="flex-1">…</Entrance>     // replays on each new key
//   const tint = createArrivalTint();  <View style={{ backgroundColor: tint.color }} />  tint.play();
//
// Only opacity and transform move, natively, after the new content is mounted: nothing waits for
// the motion, and the old content is replaced, not faded out. Reduced motion: no motion.
import type { JSX } from "nsh";
import { createAnimatedValue, createMotion, effect, untracked, View } from "nsh";
import { MOTION_EASE, MOTION_HIGHLIGHT, MOTION_PAGE, motionMs } from "./tokens";

/** Plays the page entrance (opacity 0 → 1, `rise` points → 0) on `motion`. */
export function playRise(motion: ReturnType<typeof createMotion>, options: { rise?: number; duration?: number } = {}) {
  const duration = motionMs(options.duration ?? MOTION_PAGE);
  if (duration <= 0) return;
  void motion.play({
    duration,
    keyframes: {
      opacity: [{ value: 0, easing: MOTION_EASE }, 1],
      translateY: [{ value: options.rise ?? 6, easing: MOTION_EASE }, 0],
    },
  });
}

/** A view whose content rises into place each time `watch` changes (not on its first value). */
export function Entrance(props: {
  watch: unknown;
  rise?: number;
  duration?: number;
  class?: string;
  testID?: string;
  children?: JSX.Element;
}) {
  const motion = createMotion();
  let first = true;
  let previous: unknown;
  effect(() => {
    const key = props.watch;
    untracked(() => {
      if (first) {
        first = false;
        previous = key;
        return;
      }
      if (key === previous) return;
      previous = key;
      playRise(motion, { rise: props.rise, duration: props.duration });
    });
  });
  return (
    <View class={props.class} testID={props.testID} style={motion.style}>
      {props.children}
    </View>
  );
}

/** A row's arrival tint: `color` for its `backgroundColor`, `play()` when it arrives or changes. */
export function createArrivalTint() {
  const level = createAnimatedValue(0);
  return {
    color: level.interpolate({ inputRange: [0, 1], outputRange: ["rgba(66,111,158,0)", "rgba(66,111,158,0.14)"] }),
    play() {
      const duration = motionMs(MOTION_HIGHLIGHT);
      if (duration <= 0) return;
      level.set(1);
      void level.keyframes([1, { offset: 0.3, value: 1, easing: "easeIn" }, 0], { duration });
    },
  };
}
