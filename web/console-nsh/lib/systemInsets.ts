// Where the system's bars leave room for the app on Android. nsh draws the Android app edge to edge:
// the status bar (and a display cutout) lies over the top of the surface, the navigation bar or
// the gesture handle over its bottom (over a side in landscape with button navigation), and
// `safeArea()` reports their sizes. Each inset is taken once, by the outermost view that needs it:
//
// - the app's frame (App.tsx) moves everything below the status bar and inside the side insets, so
//   every page's top bar sits whole under the status bar, at its own height;
// - the bottom: the phone's navigation strip draws its card under the gesture handle (its own
//   padding) while it shows; without the strip the frame keeps the page above the handle;
// - while the software keyboard is up, its height (which covers the navigation bar) replaces the
//   bottom inset, so nothing adds both;
// - dialogs are an Overlay over the whole surface, outside the frame: their layer takes the same
//   insets itself;
// - so are the sheets docked at a side (nsh/base's `Sheet`, the chat's topic and workspace panel on
//   phones): the panel takes the insets of the edges it touches, inside its own paper, and the
//   frame's padding never reaches it, so nothing is taken twice;
// - and the dropdowns that are sheets at the bottom on touch screens (nsh/base's Menu, Select,
//   DatePicker): their panel takes the bottom inset under its own padding (`bottomSheetInsets`,
//   on iOS and the web too, wherever `safeArea()` reports one).
//
// Otherwise iOS, the desktops and the web are unchanged (they pass no insets here). Pure functions, no
// state, so the tests can check the numbers.

export interface Edges {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface FrameInsets {
  /** The app frame's padding. */
  frame: Edges;
  /** The navigation strip's bottom padding, under its icons. */
  bottomNav: number;
}

const size = (value: number | undefined) => (Number.isFinite(value) && (value as number) > 0 ? (value as number) : 0);

/**
 * The frame's and the navigation strip's padding, for the system bars' insets `area`, the software
 * keyboard's height (0 when hidden) and whether the navigation strip shows.
 */
export function frameInsets(area: Partial<Edges>, keyboard: number, bottomNav: boolean): FrameInsets {
  const bottom = size(area.bottom);
  const raised = size(keyboard);
  return {
    frame: {
      top: size(area.top),
      right: size(area.right),
      left: size(area.left),
      bottom: raised > 0 ? Math.max(raised, bottom) : bottomNav ? 0 : bottom,
    },
    bottomNav: raised > 0 || !bottomNav ? 0 : bottom,
  };
}

/**
 * The padding of the dialogs' layer: the system bars' insets plus `gap` on every side, and at the
 * bottom the keyboard's height instead of the bottom inset while the keyboard is up (`keyboard`
 * is 0 for layouts that do not rise with it).
 */
export function dialogLayerInsets(area: Partial<Edges>, keyboard: number, gap: number): Edges {
  const raised = size(keyboard);
  return {
    top: size(area.top) + gap,
    right: size(area.right) + gap,
    left: size(area.left) + gap,
    bottom: (raised > 0 ? Math.max(raised, size(area.bottom)) : size(area.bottom)) + gap,
  };
}

/**
 * The padding of a sheet docked at the right edge, from the top of the surface to its bottom (the
 * chat's topic and workspace panel on phones): the status bar's inset at the top, the right inset
 * (a cutout or the navigation bar in landscape) at its edge, and at the bottom the navigation bar's
 * inset, or the keyboard's height while it is up. Its left edge is in the middle of the surface:
 * nothing there. The sheet is an Overlay, outside the frame: this is all the room it gets.
 */
export function rightSheetInsets(area: Partial<Edges>, keyboard: number): Edges {
  const raised = size(keyboard);
  return {
    top: size(area.top),
    right: size(area.right),
    bottom: raised > 0 ? Math.max(raised, size(area.bottom)) : size(area.bottom),
    left: 0,
  };
}

/** The bottom of a sheet at the bottom of the screen. */
export interface BottomSheetInsets {
  /** The sheet's own padding under its last row, plus the room the system takes there. */
  paddingBottom: number;
  /** The class's height at most, grown by that room, within the screen below the status bar. */
  maxHeight: number;
}

/**
 * The bottom of a sheet at the bottom of the screen: nsh/base's `Menu`, `Select` and `DatePicker`
 * on touch screens (their `placement` is the desktops'). The sheet is an overlay over the whole
 * surface, outside the frame, and nsh pads it with nothing: its last row would sit under the
 * navigation bar or the gesture handle. So it keeps `padding` (its classes' bottom padding, which
 * an inline `paddingBottom` replaces) above the bottom inset `area.bottom`, and grows its
 * `contentMax` (its `max-h-*` class, if any) by that inset, so its rows keep the room they had.
 *
 * `keyboard` is the software keyboard's height for a sheet that rises above it (0 for one that
 * stays down, or while it is hidden): the keyboard covers the navigation bar, so it replaces the
 * inset rather than adding to it. Either way the sheet ends below the status bar (`area.top`).
 * `undefined` when there is nothing to clear: the sheet is as its classes draw it.
 */
export function bottomSheetInsets(
  area: Partial<Edges>,
  keyboard: number,
  windowHeight: number,
  padding: number,
  contentMax?: number,
): BottomSheetInsets | undefined {
  const raised = size(keyboard);
  const clear = raised > 0 ? Math.max(raised, size(area.bottom)) : size(area.bottom);
  if (clear === 0) return undefined;
  const room = Math.max(0, size(windowHeight) - size(area.top) - clear);
  const content = contentMax === undefined ? room : Math.min(size(contentMax), room);
  return { paddingBottom: clear + size(padding), maxHeight: clear + content };
}
