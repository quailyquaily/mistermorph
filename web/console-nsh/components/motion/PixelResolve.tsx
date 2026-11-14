// Something coming into focus as the brand's "pixel becomes smooth" (design/DESIGN.md §2): its
// content drawn in coarse square pixels that grow finer, 12pt, 8, 6, 4, 3, 2, then smooth, in steps
// rather than a blur, as a dot matrix resolving. The Contacts panel's avatar resolves so each time a
// contact opens in it.
//
//   <PixelResolve watch={contactID()} size={88}><KindAvatar … /></PixelResolve>
//
// It plays when it is made and each time `watch` changes. A GPU shader (`ShaderEffect`) samples the
// content once per cell; where the platform draws no shaders (`shadersAvailable()`: no GPU, a
// terminal, headless tests) the content fades in instead. Only `nsh.progress` moves, natively.
// Reduced motion: the content is in focus at once.
import type { JSX } from "nsh";
import { createAnimatedValue, effect, ShaderEffect, shadersAvailable, untracked, View } from "nsh";
import { MOTION_EASE, motionMs } from "./tokens";

/** How long the content takes to come into focus. */
export const PIXEL_RESOLVE_MS = 320;

// The cell size steps by progress (seven equal shares of it); at 1 the content draws as it is. The
// cells are whole points of the box, centred samples of the content.
const PIXELATE = `
fn shade(uv: vec2f) -> vec4f {
  var steps = array<f32, 7>(12.0, 8.0, 6.0, 4.0, 3.0, 2.0, 1.0);
  let i = min(u32(clamp(nsh.progress, 0.0, 1.0) * 7.0), 6u);
  let cell = steps[i];
  if (cell <= 1.0) {
    return sample_content(uv);
  }
  let cells = max(floor(nsh.size / cell), vec2f(1.0));
  return sample_content((floor(uv * cells) + 0.5) / cells);
}
`;

export function PixelResolve(props: { watch: unknown; size: number; class?: string; testID?: string; children?: JSX.Element }) {
  // 1 is in focus: what a reduced-motion run and the end of each resolve leave.
  const progress = createAnimatedValue(1);
  const fade = createAnimatedValue(1);
  effect(() => {
    void props.watch;
    untracked(() => {
      const duration = motionMs(PIXEL_RESOLVE_MS);
      if (duration <= 0) return;
      if (shadersAvailable()) {
        progress.set(0);
        // Linear in time: the steps are equal shares of it.
        void progress.timing(1, { duration, easing: [0, 0, 1, 1] });
      } else {
        fade.set(0);
        void fade.timing(1, { duration: Math.round(duration * 0.7), easing: MOTION_EASE });
      }
    });
  });
  return (
    <If
      when={shadersAvailable()}
      else={
        <View class={props.class} testID={props.testID} style={{ width: props.size, height: props.size, opacity: fade }}>
          {props.children}
        </View>
      }
    >
      <ShaderEffect source={PIXELATE} progress={progress} class={props.class} testID={props.testID} style={{ width: props.size, height: props.size }}>
        {props.children}
      </ShaderEffect>
    </If>
  );
}
