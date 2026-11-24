// The finish of the console's solid controls: the filled Button variants (primary, danger,
// highlight), the filled CircleButtons (primary, danger: the composer's ready Send and its mic) and
// the capsule toolbar's primary button. One language in three colours, each detail small:
//
// - a hairline a shade deeper than the fill (`<tone>-line`), so the edge stays crisp on any ground;
// - a faint lit top edge inside it (`solid-sheen`) and a soft shadow under it (`solid-shadow`):
//   the control is raised. On hover the shadow deepens (`solid-shadow-hover`) and the fill takes a
//   step (`<tone>-hover`: deeper on the light palette, a touch lighter on the dark one, where a
//   raised surface is a lighter one);
// - pressed, it settles: the shadow and the lit edge go and the fill deepens a step past hover
//   (`<tone>-press`), in both palettes;
// - the keyboard's focus is a ring inside the edge in the colour written on the fill (so it reads
//   as well as the label does), drawn as an inset shadow: it follows the corners, continuous or
//   round, and no parent can clip it.
//
// Light and dark have their own values (theme.json): the light palette's navy shadow at a low
// alpha, the dark one's black at a higher one (a light shadow would not show on near-black). The
// text on every enabled fill (rest, hover, pressed) keeps 4.5:1 (tests/solid-buttons.test.tsx).
//
// Motion: the fills ease as colours always have (`transitionProperty: "colors"`); the shadows are
// not in it and change at once, so nothing but colours, opacity and transforms animate, and nsh
// zeroes those under reduced motion. Disabled and loading controls keep their own pale or soft
// looks and lose the shadows (`disabledStyle` wins over every state).
//
// Android: nsh's Android runtime moves the children of a box that clips and casts an outer shadow
// into an inner box that takes the presses, and the button never gets them; Android solid controls
// go without the shadows (fill, hairline and press only).
import { platform, token } from "nsh";

type TokenName = Parameters<typeof token>[0];

/** A solid control's colour: the primary blue, the danger red, the highlight amber. */
export type SolidTone = "primary" | "danger" | "warn";
/** The states a solid control draws a shadow for. */
export type SolidState = "rest" | "hover" | "pressed" | "focus";

/** Each tone's tokens: its fill at rest, on hover and pressed, its hairline and what is written on it. */
export const SOLID_TONES: Record<SolidTone, { fill: TokenName; hover: TokenName; press: TokenName; line: TokenName; text: TokenName }> = {
  primary: { fill: "primary", hover: "primary-hover", press: "primary-press", line: "primary-line", text: "primary-foreground" },
  danger: { fill: "danger", hover: "danger-hover", press: "danger-press", line: "danger-line", text: "on-accent" },
  warn: { fill: "warn", hover: "warn-hover", press: "warn-press", line: "warn-line", text: "on-accent" },
};

// The classes, spelled out (one string per tone) so each reads as the tokens above.
const SOLID_BOX: Record<SolidTone, string> = {
  primary: "bg-primary border-[0.5px] border-primary-line hover:bg-primary-hover active:bg-primary-press disabled:bg-primary",
  danger: "bg-danger border-[0.5px] border-danger-line hover:bg-danger-hover active:bg-danger-press disabled:bg-danger",
  warn: "bg-warn border-[0.5px] border-warn-line hover:bg-warn-hover active:bg-warn-press disabled:bg-warn",
};

/** A solid control's fill and hairline, with its hover and pressed fills; disabled, the fill at rest
 * (nsh's `hover:` reaches a disabled control: `disabled:` wins over it), which the control fades. */
export function solidBox(tone: SolidTone): string {
  return SOLID_BOX[tone];
}

// Inset shadows are drawn from the box's outer edge, under its border (nsh web draws the border
// as a child over the box, 1 CSS pixel wide for the 0.5pt hairline at every scale: Chrome snaps
// it to whole device pixels; Android paints inset shadows before borders too). So the lit edge and
// the focus ring start under the hairline and reach past it by whole points, which land on device
// pixels at 1x, 1.5x and 2x.
/** The width the hairline covers of an inset shadow, in points (as drawn on the web). */
export const SOLID_HAIRLINE_COVER = 1;
/** The lit top edge's height inside the hairline, in points. */
export const SOLID_SHEEN = 1;
/** The keyboard focus ring's width inside the hairline, in points. */
export const SOLID_FOCUS_RING = 2;

/**
 * The box shadow of a solid control of `tone` in `state`, from the tokens of the appearance shown
 * (`read`: a stand-in for `token` in tests). Pressed has none: it settles.
 */
export function solidShadow(tone: SolidTone, state: SolidState, read: (name: TokenName) => unknown = token): string {
  const sheen = String(read("solid-sheen"));
  const shadow = String(read("solid-shadow"));
  switch (state) {
    case "rest":
      return `inset 0 ${SOLID_HAIRLINE_COVER + SOLID_SHEEN}px 0 ${sheen}, 0 1px 2px ${shadow}`;
    case "hover":
      return `inset 0 ${SOLID_HAIRLINE_COVER + SOLID_SHEEN}px 0 ${sheen}, 0 1px 2px ${shadow}, 0 3px 6px -2px ${String(read("solid-shadow-hover"))}`;
    case "pressed":
      return "none";
    case "focus":
      return `inset 0 0 0 ${SOLID_HAIRLINE_COVER + SOLID_FOCUS_RING}px ${String(read(SOLID_TONES[tone].text))}, 0 1px 2px ${shadow}`;
  }
}

/** False on Android (see above): its solid controls draw no shadows. */
export const SOLID_SHADOWS = platform.os !== "android";

/** The state styles a solid control of `tone` passes to its pressable (none for no tone, or on Android). */
export function solidStateStyles(tone: SolidTone | undefined): {
  style?: { boxShadow: string };
  hoverStyle?: { boxShadow: string };
  focusVisibleStyle?: { boxShadow: string };
  activeStyle?: { boxShadow: string };
  disabledStyle?: { boxShadow: string };
} {
  if (!tone || !SOLID_SHADOWS) return {};
  return {
    style: { boxShadow: solidShadow(tone, "rest") },
    hoverStyle: { boxShadow: solidShadow(tone, "hover") },
    focusVisibleStyle: { boxShadow: solidShadow(tone, "focus") },
    activeStyle: { boxShadow: solidShadow(tone, "pressed") },
    disabledStyle: { boxShadow: "none" },
  };
}
