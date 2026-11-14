// Where the system's bars leave room for the app on Android. nsh draws the Android app edge to edge:
// the status bar (and a display cutout) lies over the top of the surface, the navigation bar or
// the gesture handle over its bottom (over a side in landscape with button navigation), and
// `safeArea()` reports their sizes. Each inset is taken once, by the outermost view that needs it:
//
// - the app's frame (App.tsx) moves everything below the status bar and inside the side insets, so
//   every page's top bar sits whole under the status bar, at its own height;
// - the bottom: the phone's navigation strip draws its card under the gesture handle (its own
//   padding) while it shows; on wide windows, without the strip, the frame keeps the page above
//   the handle; on phones the foot of the page's column does (components/Shell.tsx), so the room
//   under the pages stays the same whoever takes the inset;
// - the phone's workbench (components/frame/Workbench.tsx), a sheet docked at the foot of that
//   column, runs to the bottom edge while it is open: the column's foot and the strip leave the
//   inset to it, and it takes it inside its own paper, so its background fills the room under its
//   last line (`workbenchInsets`, on iOS and the web too, with their side insets);
// - while the software keyboard is up, its height (which covers the navigation bar) replaces the
//   bottom inset, so nothing adds both;
// - dialogs are an Overlay over the whole surface, outside the frame: their layer takes the same
//   insets itself, except on phones, where the dialog is a sheet at the bottom: the layer takes
//   the top and side insets, and the sheet the bottom one (or the keyboard's height) inside its
//   own paper, so its background fills the room under its last row (`dialogSheetInsets`, on iOS
//   and the web too);
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
  /** On phones, the foot of the page's column: the bottom inset nothing else takes (0 elsewhere). */
  foot: number;
}

const size = (value: number | undefined) => (Number.isFinite(value) && (value as number) > 0 ? (value as number) : 0);

/**
 * The frame's, the navigation strip's and the page column's foot padding, for the system bars'
 * insets `area`, the software keyboard's height (0 when hidden) and whether the navigation strip
 * shows. `phone` is given on phones (no sidebar: the page's column is as wide as the frame), with
 * whether the workbench is open there: the column then takes the bottom inset in place of the
 * frame (its foot, or the workbench's sheet while it is open), so opening the workbench changes no
 * height above it. While the keyboard is up the frame takes its height, and nothing else takes any.
 */
export function frameInsets(area: Partial<Edges>, keyboard: number, bottomNav: boolean, phone?: { workbench: boolean }): FrameInsets {
  const bottom = size(area.bottom);
  const raised = size(keyboard);
  // Who takes the bottom inset while the keyboard is down: the workbench, the strip, the foot, the frame.
  const workbench = Boolean(phone?.workbench);
  return {
    frame: {
      top: size(area.top),
      right: size(area.right),
      left: size(area.left),
      bottom: raised > 0 ? Math.max(raised, bottom) : bottomNav || phone ? 0 : bottom,
    },
    bottomNav: raised > 0 || !bottomNav || workbench ? 0 : bottom,
    foot: raised > 0 || !phone || bottomNav || workbench ? 0 : bottom,
  };
}

/** The padding inside the workbench's sheet on a phone. */
export interface WorkbenchInsets {
  bottom: number;
  left: number;
  right: number;
}

/**
 * The padding inside the phone's workbench sheet (components/frame/Workbench.tsx), `margin` in from
 * the window's sides and running to its bottom edge, for the system bars' insets `area` and the
 * software keyboard's height. Its paper takes the bottom inset, so its background fills the room
 * under its last line; while the keyboard is up the frame stands on it (its height replaces the
 * inset) and the sheet takes none. The side insets (a cutout, the navigation bar in landscape) only
 * where the frame does not take them (`frameSides`: Android's frame does), less the sheet's own
 * margin there. Its top is never at the top of the screen: no top inset.
 */
export function workbenchInsets(area: Partial<Edges>, keyboard: number, frameSides: boolean, margin = 0): WorkbenchInsets {
  const side = (value: number | undefined) => (frameSides ? 0 : Math.max(0, size(value) - size(margin)));
  return { bottom: size(keyboard) > 0 ? 0 : size(area.bottom), left: side(area.left), right: side(area.right) };
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

/** The room a dialog that is a sheet at the bottom of the screen keeps under its last row. */
export interface DialogSheetInsets {
  /** The bottom inset or the keyboard's height (never both), taken inside the painted sheet. */
  clear: number;
  /** The sheet's height at most (its share of the screen below the status bar, plus `clear`). */
  maxHeight: number;
}

/**
 * The bottom of a dialog that is a sheet at the bottom of the screen (phones: components/ui.tsx
 * `DialogLayer`). The sheet runs to the bottom edge of the surface, so its own background fills
 * the room under its last row: the navigation bar's or gesture handle's inset `area.bottom`, or,
 * while the software keyboard is up, the keyboard's height instead (it covers that bar). The
 * layer under it takes no bottom inset, so the room is taken once. `share` of the height below
 * the status bar (`area.top`) and above that room is the sheet's content at most (its
 * `max-h-[90%]`). `undefined` when there is nothing to clear: the sheet is as its classes draw it.
 */
export function dialogSheetInsets(area: Partial<Edges>, keyboard: number, windowHeight: number, share = 0.9): DialogSheetInsets | undefined {
  const raised = size(keyboard);
  const clear = raised > 0 ? Math.max(raised, size(area.bottom)) : size(area.bottom);
  if (clear === 0) return undefined;
  const room = Math.max(0, size(windowHeight) - size(area.top) - clear);
  return { clear, maxHeight: clear + Math.round(room * share * 100) / 100 };
}
