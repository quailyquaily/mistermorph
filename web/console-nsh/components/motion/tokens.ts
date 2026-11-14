// The console's motion tokens (the Vue console's --motion-* in styles/base.css): short and eased
// out, like an instrument settling. Reduced motion zeroes them, so code that reads `motionMs`
// lands at once instead of moving.
import { reduceMotion } from "nsh";

/** Hover fills, menus, a highlight showing. */
export const MOTION_FAST = 120;
/** Dialogs, tabs' indicator, tooltips rising. */
export const MOTION_NORMAL = 180;
/** A selection gliding between items. */
export const MOTION_SLOW = 260;
/** A page settling in. */
export const MOTION_PAGE = 220;
/** A row that just arrived holds its tint this long. */
export const MOTION_HIGHLIGHT = 1600;
/** cubic-bezier(0.2, 0, 0, 1): quick start, long settle. */
export const MOTION_EASE: [number, number, number, number] = [0.2, 0, 0, 1];
/** The same curve as a CSS timing function, for `transitionTimingFunction`. */
export const MOTION_EASE_CSS = "cubic-bezier(0.2, 0, 0, 1)" as const;
/** cubic-bezier(0.4, 0, 1, 1): slow start, leaving fast, for something going away (a dialog
 *  closing, a sheet sliding out): it gets out of the way instead of lingering at the end. */
export const MOTION_EXIT_EASE: [number, number, number, number] = [0.4, 0, 1, 1];
/** A dialog going out: quicker than its MOTION_NORMAL settle in. */
export const MOTION_EXIT = 140;
/** A sheet sliding up from the screen's bottom edge (the Vue console's 280ms): the phone's More
 *  and agent sheets, and dialogs on phones. */
export const MOTION_SHEET_IN = 280;
/** The same sheet sliding back down, on MOTION_EXIT_EASE (the Vue console's 200ms). */
export const MOTION_SHEET_OUT = 200;

/** `ms`, or 0 when the user asks for less motion. */
export function motionMs(ms: number) {
  return reduceMotion() ? 0 : ms;
}

// A cubic Bézier from (0,0) to (1,1), evaluated at time `t` (0..1): the progress there. Used to
// know where a glide is between frames (the animation itself runs natively).
function bezier(x1: number, y1: number, x2: number, y2: number) {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (s: number) => ((ax * s + bx) * s + cx) * s;
  const sampleY = (s: number) => ((ay * s + by) * s + cy) * s;
  const slopeX = (s: number) => (3 * ax * s + 2 * bx) * s + cx;
  return (t: number) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    let s = t;
    for (let i = 0; i < 8; i += 1) {
      const dx = sampleX(s) - t;
      if (Math.abs(dx) < 1e-5) break;
      const d = slopeX(s);
      if (Math.abs(d) < 1e-6) break;
      s -= dx / d;
    }
    // Bisection when Newton strayed.
    if (s < 0 || s > 1 || Math.abs(sampleX(s) - t) > 1e-3) {
      let lo = 0;
      let hi = 1;
      s = t;
      for (let i = 0; i < 24; i += 1) {
        const x = sampleX(s);
        if (Math.abs(x - t) < 1e-5) break;
        if (x < t) lo = s;
        else hi = s;
        s = (lo + hi) / 2;
      }
    }
    return sampleY(s);
  };
}

/** Progress along MOTION_EASE at time fraction `t`. */
export const easeProgress = bezier(...MOTION_EASE);
