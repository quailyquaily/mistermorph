// Whether the phone's bottom navigation (components/frame/MobileBottomNav.tsx) shows its labels or
// only its icons, from the way the page's content scrolls (docs/console/mobile-bottom-nav.md).
// The capsule starts expanded (icons and labels); reading down into the content makes it the
// smaller icon-only capsule, going back up expands it again, and at the top it is always expanded.
// It never hides.
//
// The pages' scrollers tell it where they are: every navigation page's main list goes through
// `useScrollMemory` (lib/scrollMemory.ts), which passes each report on with the scroller's area
// key as its source (`noteNavScroll`). Only the source that last moved under the reader counts;
// another one taking over starts afresh, expanded. The navigation resets it when the page changes
// (`resetNavScroll`).
//
// The direction is a net movement, not one report's: expanded, the capsule compacts once the
// content went NAV_COMPACT_AFTER points further down than the highest it was since it expanded;
// compact, it expands once it came NAV_EXPAND_AFTER points back up from the lowest. A small
// reversal in between moves inside that band and changes nothing, so a finger's jitter never
// flips it. Offsets are clamped to what the content reaches, so a rubber band past either end
// (iOS, a pull at the top) counts as resting at that end.
import { signal } from "nsh";

/** Points the content must go down, net, before the expanded capsule compacts. */
export const NAV_COMPACT_AFTER = 32;
/** Points the content must come back up, net, before the compact capsule expands. */
export const NAV_EXPAND_AFTER = 24;
/** An offset this close to the content's top is the top (sub-point rounding, a browser's 0.5). */
export const NAV_TOP_SLOP = 1;

/** Where the direction stands: the source it follows, and the turning point it measures from. */
export interface NavScrollState {
  compact: boolean;
  /** The scroller followed ("" none: the next one the reader moves is taken). */
  source: string;
  /** Expanded: the highest the content was (smallest offset) since; compact: the lowest. */
  anchor: number;
}

/** A scroller's report: its offset and how far its content lets it go. */
export interface NavScrollSample {
  source: string;
  y: number;
  /** The scroller's own height and its content's (the content reaches `content - viewport`). */
  viewport: number;
  content: number;
  /**
   * Not the reader's movement: the app putting a place back (lib/scrollMemory.ts restoring it), or
   * a scroller pulled back because its content got shorter. It moves the turning point along and
   * is never a direction; it is heard only from the source already followed.
   */
  programmatic?: boolean;
}

export const NAV_SCROLL_START: NavScrollState = { compact: false, source: "", anchor: 0 };

/** The offset inside what the content reaches (rubber bands past either end are at that end). */
export function clampNavOffset(y: number, viewport: number, content: number) {
  const end = Math.max(0, content - viewport);
  if (!Number.isFinite(y)) return 0;
  return Math.min(Math.max(y, 0), end);
}

/** The next state after `sample` (pure: the tests' and the signal's). */
export function stepNavScroll(state: NavScrollState, sample: NavScrollSample): NavScrollState {
  const y = clampNavOffset(sample.y, sample.viewport, sample.content);
  if (sample.source !== state.source) {
    // Another scroller (or the first after a reset): its own start, expanded, nothing carried
    // over. The app moving one the reader is not on does not take the capsule from theirs.
    if (sample.programmatic) return state;
    return { compact: false, source: sample.source, anchor: y };
  }
  // At the top, or content too short to scroll: always expanded.
  if (y <= NAV_TOP_SLOP) return { compact: false, source: state.source, anchor: y };
  if (sample.programmatic) return { ...state, anchor: y };
  if (!state.compact) {
    if (y - state.anchor >= NAV_COMPACT_AFTER) return { compact: true, source: state.source, anchor: y };
    return y < state.anchor ? { ...state, anchor: y } : state;
  }
  if (state.anchor - y >= NAV_EXPAND_AFTER) return { compact: false, source: state.source, anchor: y };
  return y > state.anchor ? { ...state, anchor: y } : state;
}

const state = signal<NavScrollState>(NAV_SCROLL_START);
const compact = signal(false);

/** Whether the bottom navigation is its compact, icon-only capsule now. */
export const navCompact = () => compact();

/** For tests: the whole state. */
export const navScrollState = () => state();

/** A scroller's report (lib/scrollMemory.ts passes each on). */
export function noteNavScroll(sample: NavScrollSample) {
  const next = stepNavScroll(state(), sample);
  if (next === state()) return;
  state.set(next);
  if (compact() !== next.compact) compact.set(next.compact);
}

/** Back to the start, expanded, following no scroller (another page, the navigation shown again). */
export function resetNavScroll() {
  state.set(NAV_SCROLL_START);
  if (compact()) compact.set(false);
}
