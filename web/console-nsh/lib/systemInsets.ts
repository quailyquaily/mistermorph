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
// - dialogs are a layer over the whole surface (an nsh Dialog that reaches under the status bar),
//   outside the frame: their layer takes the same insets itself. On phones every popup (a dialog,
//   a menu, a select, a date picker, a picker) is a paper floating at the foot of that layer: the
//   layer takes every inset, and the keyboard's height in place of the bottom one, plus a small
//   gap, as its padding, so the paper's own bottom edge shows above the inset (lib/mobilePopup.ts,
//   on iOS and the web too);
// - so are the sheets docked at a side (nsh/base's `Sheet`: the chat's topic and workspace panel, a
//   `SidePane` and the skill store's panel on phones): the panel takes the insets of the edges it
//   touches, inside its own paper, and the frame's padding never reaches it, so nothing is taken
//   twice (`rightSheetInsets`, on iOS too, where the sheet covers the whole screen as well);
// - the dropdowns (nsh/base's Menu, Select, DatePicker) are that paper too on touch screens, where
//   nsh would draw them as sheets flush with the bottom edge, padded with nothing.
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
 * chat's topic and workspace panel, a `SidePane`, the skill store's panel on phones): the status
 * bar's inset (and a cutout's) at the top, the right inset (a cutout or the navigation bar in
 * landscape) at its edge, and the navigation bar's inset at the bottom. Its left edge is in the
 * middle of the surface: nothing there. The sheet is a layer of its own, outside the frame: this is
 * all the room it gets, and its paper runs to the edges behind it.
 *
 * `keyboard` is the software keyboard's height where the platform already lays the sheet's layer
 * out above the keyboard (Android: nsh draws a `Sheet` in a window of its own, the surface's height
 * less the keyboard's), 0 elsewhere. The layer's foot is then the keyboard's top, which covers the
 * navigation bar: no bottom inset, and never the keyboard's height again (that stood the content a
 * keyboard's height too high, as it did the dialogs: lib/mobilePopup.ts `layerAboveKeyboard`). On
 * iOS nsh ends the panel above the keyboard less the bottom inset, so the inset stays (pass 0).
 */
export function rightSheetInsets(area: Partial<Edges>, keyboard = 0): Edges {
  return {
    top: size(area.top),
    right: size(area.right),
    bottom: size(keyboard) > 0 ? 0 : size(area.bottom),
    left: 0,
  };
}

/**
 * A right sheet's padding as a style: its insets (`rightSheetInsets`, null where the platform gives
 * none) added to the padding the sheet has of its own (`own`, the skill store's gaps around its
 * card). undefined when there is nothing to pad, so a sheet without insets keeps its classes.
 */
export function rightSheetPadding(insets: Edges | null, own?: { top?: number; right?: number; bottom?: number }) {
  if (!insets && !own) return undefined;
  return {
    paddingTop: size(insets?.top) + size(own?.top),
    paddingRight: size(insets?.right) + size(own?.right),
    paddingBottom: size(insets?.bottom) + size(own?.bottom),
  };
}
