// The phone's page slides, shared by the page host (components/frame/PageStack.tsx) and by pages
// that switch between a list and one of its items (PaneStack.tsx). Only `translateX` moves,
// natively: the incoming page is mounted at its start, both pages move in the same timing, and
// the outgoing one is dropped once the motion ends.
//
// - push: the new page comes in from the right over the old one, which drifts a third to the left;
// - pop: the reverse, the leaving page slides out to the right over the one it reveals;
// - tab-forward / tab-back: two tiles of a strip, side by side, moving a whole width together
//   (left to a later page of the navigation, right to an earlier one).
import type { Motion } from "nsh";
import { MOTION_EASE, motionMs } from "./tokens";

export type SlideKind = "push" | "pop" | "tab-forward" | "tab-back";

/** A page slide's length: brief, a little longer than a dialog's, as a whole screen moves. */
export const MOTION_PAGE_SLIDE = 280;
/** How far the page underneath drifts (of the width) while another slides over it. */
export const PAGE_PARALLAX = 0.3;

export function isSlide(kind: string): kind is SlideKind {
  return kind === "push" || kind === "pop" || kind === "tab-forward" || kind === "tab-back";
}

export interface SlideFrames {
  /** translateX from → to, in points. */
  incoming: [number, number];
  outgoing: [number, number];
  /** Which page draws on top while they overlap ("none": side by side). */
  top: "incoming" | "outgoing" | "none";
}

/** Where the two pages start and end for `kind` across `width` points. */
export function slideFrames(kind: SlideKind, width: number): SlideFrames {
  const w = Math.max(0, Math.round(width));
  const drift = Math.round(w * PAGE_PARALLAX);
  switch (kind) {
    case "push":
      return { incoming: [w, 0], outgoing: [0, -drift], top: "incoming" };
    case "pop":
      return { incoming: [-drift, 0], outgoing: [0, w], top: "outgoing" };
    case "tab-forward":
      return { incoming: [w, 0], outgoing: [0, -w], top: "none" };
    case "tab-back":
      return { incoming: [-w, 0], outgoing: [0, w], top: "none" };
  }
}

/**
 * Plays one page's part of a slide. The default plays it natively; tests pass their own to hold
 * a slide part-way (`tests/fixtures/page-stack-app.tsx`).
 */
export interface SlideDriver {
  play(motion: Motion, from: number, to: number, duration: number): Promise<unknown>;
}

export const nativeSlide: SlideDriver = {
  play(motion, from, to, duration) {
    motion.translateX.set(from);
    return motion.play({
      duration,
      keyframes: { translateX: [{ value: from, easing: MOTION_EASE }, to] },
    });
  },
};

/** Stops `motion`'s slide where it is and gives its translateX there (a slide turned round). */
export async function currentX(motion: Motion): Promise<number> {
  const { value } = await motion.translateX.stop();
  return Number.isFinite(value) ? value : 0;
}

/** The slide's duration now: 0 when the user asks for less motion. */
export function pageSlideMs() {
  return motionMs(MOTION_PAGE_SLIDE);
}

/** Whether the slide's two pages are on screen together: the one underneath is hidden from assistive tech. */
export const OUTGOING_A11Y = {
  accessibilityElementsHidden: true,
  importantForAccessibility: "no-hide-descendants",
} as const;

/** A view laid over its parent's whole box (an outgoing page, out of the flow). */
export const FILL = { position: "absolute", top: 0, right: 0, bottom: 0, left: 0 } as const;
