// Where a popup goes on a phone (design/mobile-popups.md): every menu, dialog and popup bubble the
// app draws there is the same floating paper as the bottom navigation's More menu and the agent
// switcher. All four corners are round; it keeps a small gap (POPUP_GAP) from the window's left,
// right and bottom, outside whatever the system takes there (a notch or the navigation bar at a
// side, the gesture handle or the software keyboard at the bottom, or the floating navigation bar
// with More and the agents); it never reaches above the status bar's inset and the same gap; what
// does not fit scrolls inside it. It slides in from above the window's top edge, and back out
// there.
//
// The layer that holds the paper takes each inset once, as its padding (the paper never pads
// itself for the system): the paper's own bottom edge, corners included, stays in view above the
// inset. Pure functions, no state, so the tests can check the numbers (tests/mobile-popup.test.tsx).
import type { Edges } from "./systemInsets";

/** The gap a phone's popup keeps from the window's left, right and bottom (the bottom bar's side margin). */
export const POPUP_GAP = 12;
/** The widest a phone's popup is; a wider layer (a phone in landscape) centres it. */
export const POPUP_MAX_WIDTH = 560;
/** The least height a popup is given, however little room is left (it scrolls inside). */
export const POPUP_MIN_HEIGHT = 120;

export interface MobilePopupFrame {
  /** The layer's padding round the paper: the system's room and the gap, on each side. */
  top: number;
  right: number;
  bottom: number;
  left: number;
  /** The paper's tallest and widest. */
  maxHeight: number;
  maxWidth: number;
}

const size = (value: number | undefined) => (Number.isFinite(value) && (value as number) > 0 ? (value as number) : 0);

/**
 * The paper's place in a layer `width` by `height`:
 *
 * - `area`: the system's insets the layer lies under (leave out the ones an ancestor of the layer
 *   already took: Android's frame, for a layer inside it);
 * - `keyboard`: the software keyboard's height over the layer's foot (0 while hidden, or for a
 *   layer that already stands on it). It covers the bottom inset, so it replaces it;
 * - `below`: the room something floating at the layer's foot takes, its own bottom inset and the
 *   gap above it included (the bottom navigation, under More and the agents): it replaces the
 *   bottom inset and the gap, unless the keyboard reaches higher;
 * - `share`: the most of the layer's height the paper takes (More's and the agents' 62%).
 */
export function mobilePopupFrame(options: {
  width: number;
  height: number;
  area?: Partial<Edges>;
  keyboard?: number;
  below?: number;
  share?: number;
  maxWidth?: number;
}): MobilePopupFrame {
  const area = options.area ?? {};
  const raised = size(options.keyboard);
  const clear = Math.max(raised, size(area.bottom)) + POPUP_GAP;
  const bottom = Math.max(size(options.below), clear);
  const top = size(area.top) + POPUP_GAP;
  const left = size(area.left) + POPUP_GAP;
  const right = size(area.right) + POPUP_GAP;
  const room = size(options.height) - top - bottom;
  const shared = options.share === undefined ? room : Math.min(room, size(options.height) * options.share);
  return {
    top,
    right,
    bottom,
    left,
    maxHeight: Math.max(POPUP_MIN_HEIGHT, Math.floor(shared)),
    maxWidth: Math.max(0, Math.min(options.maxWidth ?? POPUP_MAX_WIDTH, size(options.width) - left - right)),
  };
}

/**
 * How far above its place the paper starts (a negative translation): out of sight above the
 * layer's top edge, for a paper whose top is at `y` in the layer and which is `height` tall. Until
 * it is laid out (`height` 0) it waits a layer's height up.
 */
export function mobilePopupEntrance(y: number, height: number, layerHeight: number): number {
  if (!(height > 0)) return -Math.max(1, size(layerHeight));
  return -(Math.max(0, y) + height + 1);
}
