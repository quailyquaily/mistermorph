// The console's corners: one scale of radii, all of them continuous (nsh's
// `borderCurve: "continuous"`, the `corner-squircle` utility), whose curvature eases into the
// edges instead of meeting them at a quarter circle. The scale is defined twice, kept equal by
// tests/corners.test.tsx: as theme tokens (theme.json, `cssVars.theme.radius-*`), which the classes
// below name, and as `RADIUS` here, for what is computed from a radius (a nested corner, a loading
// beam's path, a popover tail's room) when modules load, before the theme can be read (`token()`
// reads nothing then).
//
// - control 8: buttons, text fields and textareas, select triggers, icon squares.
// - card 12: cards and boxed sections.
// - popover 12: menus, select lists and popover bubbles.
// - dialog 18: dialog panels and the phone's floating paper (popups on phones).
// - track 6: switch tracks.
//
// Circles stay circles (`rounded-full`): a continuous corner with no room for its curve is drawn
// circular by every nsh backend, so a pill stays a pill. Panels docked to a window edge (side
// sheets, columns) keep square corners. The generic `--radius` (2pt) is left to the small marks
// and tags that were never part of this scale.
//
// Renderers (nsh 0.6): the web draws continuous corners as CSS `corner-shape` (Chromium; other
// browsers draw circular corners of the same radius), shaping the border, shadow, clip and fills
// together; GPUI (the desktop app) draws circular corners. See docs/console/corners.md.

/** The continuous corner curve, for a class list that sets its own radius. */
export const CONTINUOUS = "corner-squircle";

/** The radii, in points: the theme's `radius-control`, `radius-card`, `radius-popover`, `radius-dialog` and `radius-track`. */
export const RADIUS = {
  control: 8,
  card: 12,
  popover: 12,
  dialog: 18,
  track: 6,
} as const;

/** Buttons, fields, textareas, select triggers: 8pt, continuous. */
export const CONTROL_CORNERS = "rounded-(--radius-control) corner-squircle";
/** Cards and boxed sections: 12pt, continuous. */
export const CARD_CORNERS = "rounded-(--radius-card) corner-squircle";
/** Menus, select lists, popover bubbles: 12pt, continuous. */
export const POPOVER_CORNERS = "rounded-(--radius-popover) corner-squircle";
/** Dialog panels and the phone's floating paper: 18pt, continuous. */
export const DIALOG_CORNERS = "rounded-(--radius-dialog) corner-squircle";
/** Switch tracks: 6pt, continuous. */
export const TRACK_CORNERS = "rounded-(--radius-track) corner-squircle";

/**
 * The radius of a box nested `inset` points inside a box with corners of `outer` (the inset counts
 * the outer box's border and padding), so both corners share a centre and the gap between them
 * stays even round the turn. Never below 0.
 */
export function nestedRadius(outer: number, inset: number): number {
  return Math.max(0, outer - inset);
}

/** A class list's radius of `radius` points, continuous (a nested corner: `nestedRadius`). */
export function cornersClass(radius: number): string {
  return `rounded-[${radius}px] corner-squircle`;
}

/**
 * How far along each edge a continuous corner of `radius` reaches before the edge runs straight:
 * about 1.53 times the radius (nsh's web and Apple backends both draw Core Animation's curve). What
 * must keep off a corner (a popover's tail) keeps this far from it. A box shorter or narrower than
 * twice this has no room for the curve and is drawn with circular corners of the radius.
 */
export function cornerReach(radius: number): number {
  return Math.ceil(radius * 1.528);
}

/**
 * The largest radius whose continuous curve fits a box whose shorter side is `side` points: a
 * small control (a 24pt button) takes this in place of the scale's radius, which would otherwise
 * fall back to circular corners on the web.
 */
export function fittingRadius(radius: number, side: number): number {
  return Math.min(radius, Math.floor(side / 2 / 1.528));
}
