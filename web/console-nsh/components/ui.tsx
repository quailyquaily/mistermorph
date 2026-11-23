// The console's design system: its controls, drawn from nsh/base with the morph theme's tokens
// (theme.json). Pages build from these; a missing variant is added here, not restyled per page.
//
// The look follows the Vue console's ui-kit: hairlines, a dark blue primary, quiet plain buttons,
// mono caps for labels, and red only for what is destructive. Corners are the continuous scale of
// ./corners.ts (controls 8, cards and popovers 12, dialogs 18, switch tracks 6); circles stay round.
import type { Bounds, InputRef, JSX, KeyBindingOptions, Motion, MouseEvent, ScrollRef, ViewRef } from "nsh";
import type { ButtonProps as BaseButtonProps, TextViewClasses, TextViewStyles } from "nsh/base";
import { Canvas, cleanup, computed, context, createAnimatedValue, createMotion, Easing, effect, Image, keyboardFrame, keymap, platform, reduceMotion, safeArea, Scroll, signal, Text, token, untracked, View, windowSize } from "nsh";
import {
  Button as BaseButton,
  Checkbox as BaseCheckbox,
  Dialog,
  Input,
  Menu,
  MenuItem,
  MenuSeparator,
  Progress,
  Select,
  Sheet,
  Switch,
  TextView,
  Tooltip,
} from "nsh/base";
import { dismissNotice, noticeState, pushNotice } from "../lib/core/notices.js";
import { CARD_CORNERS, CONTINUOUS, CONTROL_CORNERS, cornersClass, fittingRadius, nestedRadius, POPOVER_CORNERS, RADIUS, TRACK_CORNERS } from "./corners";
import { drawFabMark, FAB_MARK, FAB_MARK_SIZE, type FabMarkCorner } from "./fabMark";
import { FILLED_ICONS, ICONS, type IconName } from "./icons";
import { PickerList, type PickerItem, type PickerProbe } from "./shared/PickerList";
import { withAlpha } from "./motion/color";
import { solidBox, SOLID_SHADOWS, solidStateStyles, type SolidTone } from "./solidLook";
import { BorderBeam, type BeamTone } from "./motion/BorderBeam";
import { RunningMark } from "./motion/RunningMark";
import { sagHalf, SagRule } from "./motion/Sag";
import { recentPress } from "./motion/pressOrigin";
import { createScrollEdges, EdgeScroll, SCROLLBAR } from "./motion/ScrollEdges";
import { equalTabWidths, TAB_OVERFLOW_SLACK, tabRevealOffset, type TabBox } from "./shared/tabStrip";
import { FadeText } from "./motion/FadeText";
import { BarRoom, glassBarClass, glassBarStyle, underBar } from "./frame/glassBar";
import { CHROME_BAR_HEIGHT, gutterX, gutterY, pageGap, pageTop } from "./frame/metrics";
import { dialogLayerInsets } from "../lib/systemInsets";
import { mobilePopupEntrance, mobilePopupFrame } from "../lib/mobilePopup";
import {
  MOTION_EASE,
  MOTION_EASE_CSS,
  MOTION_EXIT,
  MOTION_EXIT_EASE,
  MOTION_NORMAL,
  MOTION_SHEET_IN,
  MOTION_SHEET_OUT,
  MOTION_SLOW,
  motionMs,
} from "./motion/tokens";
import { MobileBarSpacer, mobileBarRoom } from "./frame/mobileBar";
import { boundsFrame, createPartProbe, type PartFrame, type PartLayoutListener } from "./shared/partProbe";
import type { ScrollMemory } from "../lib/scrollMemory";
import { isMobile, MOBILE_BREAKPOINT, rightSheetPopupStyle } from "../lib/shell";
import { shortcutsEligible } from "../lib/shortcutPolicy";

export type { IconName };

type Tone = "neutral" | "info" | "ok" | "warn" | "danger";
type TokenName = Parameters<typeof token>[0];

/* ---------- icons and marks ---------- */

/** A Phosphor icon (regular weight, or its fill weight with `filled` where there is one), tinted with a theme token. */
export function Icon(props: {
  name: IconName;
  size?: number;
  color?: TokenName;
  class?: string;
  filled?: boolean;
  testID?: string;
  /** Its frame in its parent as it lays out (layout probes in tests). */
  onLayout?: (event: { bounds: { origin: { x: number; y: number }; size: { width: number; height: number } } }) => void;
}) {
  return (
    <Image
      src={(props.filled && FILLED_ICONS[props.name]) || ICONS[props.name]}
      class={props.class}
      testID={props.testID}
      onLayout={props.onLayout}
      accessibilityElementsHidden
      style={{
        width: props.size ?? 16,
        height: props.size ?? 16,
        tintColor: token(props.color ?? "foreground") as string,
      }}
    />
  );
}

export type StatusState = "on" | "off" | "pending" | "error" | "unread" | "running" | "done";

/**
 * The console's square status mark: filled when on, hollow when off, orange when waiting. Running,
 * it morphs into a turning ring and back when it ends (design/ui-refresh.html §7, RunningMark), so
 * any mark that can show a run gets the animation by passing `running`.
 */
export function StatusMark(props: {
  state: StatusState;
  /** The square's side (default 8). */
  size?: number;
  /** The square's corner radius (default square). */
  corner?: number;
  /** The settled square's colour in place of the state's own (a mark on a dark panel). */
  color?: string;
  /** The ring's colour (default the theme's status-on blue). */
  ringColor?: string;
  class?: string;
  testID?: string;
}) {
  const stateColor = (): TokenName => {
    switch (props.state) {
      case "pending":
        return "status-pending";
      case "done":
        // Something that ended well: the success colour, where "on" only says it is switched on.
        return "ok";
      case "error":
        return "status-error";
      case "off":
        return "status-off";
      default:
        return "status-on";
    }
  };
  return (
    <RunningMark
      running={props.state === "running"}
      color={props.color ?? String(token(stateColor()))}
      hollow={props.state === "off" && !props.color}
      ringColor={props.ringColor}
      size={props.size ?? 8}
      corner={props.corner}
      class={props.class}
      testID={props.testID}
    />
  );
}

/**
 * The one spinner: a short 2pt hairline whose blue segment sweeps across it. nsh's indeterminate
 * Progress leaves the indicator's width and motion to the app, so the segment is moved here (left to
 * itself it fills the track and stands still, which reads as a dash). Reduced motion: it stays put.
 */
export function Spinner(props: { size?: number; class?: string }) {
  const width = () => props.size ?? 24;
  const segment = () => Math.max(4, Math.round(width() * 0.4));
  const sweep = createAnimatedValue(0);
  const still = untracked(reduceMotion);
  if (!still) {
    void sweep.keyframes([0, 1], { duration: 900, easing: Easing.bezier(0.45, 0, 0.55, 1), iterations: "infinite" });
  }
  cleanup(() => void sweep.stop());
  return (
    <View class={props.class}>
      <View role="progressbar" class="h-0.5 overflow-hidden bg-line-faint" style={{ width: width() }}>
        <View
          class="h-full bg-blue"
          style={{
            width: still ? width() : segment(),
            opacity: still ? 0.5 : 1,
            transform: [{ translateX: still ? 0 : sweep.interpolate({ inputRange: [0, 1], outputRange: [-segment(), width()] }) }],
          }}
        />
      </View>
    </View>
  );
}

/* ---------- text ---------- */

/** Mono caps label above a field or a group, as the Vue console's `.ui-kicker`: 12pt mono 500, 0.16em apart. */
export function Kicker(props: { children?: JSX.Element; right?: JSX.Element; class?: string }) {
  return (
    <View class={`flex-row items-center justify-between gap-2 ${props.class ?? ""}`}>
      <Text class="font-mono text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">{props.children}</Text>
      {props.right}
    </View>
  );
}

/** A page's or a section's heading. */
export function Heading(props: { children?: JSX.Element; level?: 1 | 2 | 3; class?: string }) {
  const size = () => (props.level === 1 ? "text-xl" : props.level === 3 ? "text-base" : "text-lg");
  return <Text class={`${size()} font-semibold text-foreground ${props.class ?? ""}`}>{props.children}</Text>;
}

/** Secondary text: meta, hints, timestamps. */
export function Muted(props: { children?: JSX.Element; class?: string; numberOfLines?: number }) {
  return (
    <Text class={`text-xs text-muted-foreground ${props.class ?? ""}`} style={{ numberOfLines: props.numberOfLines ?? 0 }}>
      {props.children}
    </Text>
  );
}

/** Rendered Markdown (replies, documents), with the console's prose styles. */
export function Markdown(props: {
  source: string;
  class?: string;
  selectable?: boolean;
  onLinkPress?: (url: string) => void;
  streaming?: boolean;
  /** Tailwind classes by part (TextView's `classes`: `{ heading1: "text-xl", code: "font-mono" }`). */
  classes?: TextViewClasses;
  /** Inline styles by part (TextView's `styles`), over `classes`. */
  styles?: TextViewStyles;
}) {
  return (
    <TextView
      markdown={props.source}
      classes={props.classes}
      styles={props.styles}
      selectable={props.selectable ?? true}
      class={`text-sm text-foreground ${props.class ?? ""}`}
      onLinkPress={props.onLinkPress ? (event) => props.onLinkPress?.(event.url) : undefined}
      codeBlockScrollbar
      tableScrollbar
    />
  );
}

/* ---------- tooltips ---------- */

// The console's tooltip (the Vue console's .app-tooltip, core/tooltips.js): a small paper card
// with a hairline, rising 3pt into place after a short pause, in place of a grey box.
const TIP_SHADOW = "0 4px 14px rgba(24, 24, 50, 0.1)";

/** A tooltip: `tooltip={<Tip text="…" />}` on any view. */
/** A tooltip; `shortcut` is the keyboard shortcut of what it names, shown after it (`⇧⌘O`). */
export function Tip(props: { text: string; shortcut?: string; placement?: "top" | "bottom" | "left" | "right" }) {
  return (
    <Tooltip
      delay={420}
      placement={props.placement ?? "top"}
      class="max-w-75 rounded-(--radius) border border-line-soft bg-card px-2 pb-1.25 pt-1 transition duration-180"
      startingClass="opacity-0 translate-y-0.75"
      endingClass="opacity-0"
      style={{ boxShadow: TIP_SHADOW, transitionTimingFunction: MOTION_EASE_CSS }}
    >
      <If when={props.shortcut} else={<Text class="text-xs leading-[17.4px] text-foreground">{props.text}</Text>}>
        <View class="flex-row items-center gap-2">
          <Text class="shrink text-xs leading-[17.4px] text-foreground">{props.text}</Text>
          <Text class="shrink-0 text-xs leading-[17.4px] text-muted-foreground" testID="tip-shortcut">
            {props.shortcut}
          </Text>
        </View>
      </If>
    </Tooltip>
  );
}

/* ---------- buttons ---------- */

// nsh 0.4.0's base Button drops the `tooltip` every element takes (a hint on it, or anything inside
// it, never shows), so a button's tooltip goes on a view around it. The view takes the classes that
// place the button in its parent (flex, self, margins, widths, position) and the button the rest,
// stretched across the view when the view is sized, so the layout is the button's own.
const OUTER_CLASS =
  /^(?:-?m[trblxyse]?-|flex-(?:1|auto|none|initial)$|grow|shrink|basis-|self-|w-|min-w-|max-w-|absolute$|fixed$|sticky$|inset|top-|left-|right-|bottom-|start-|end-|z-|order-|col-|row-span|row-start|row-end)/;
const SIZED_CLASS = /^(?:self-stretch|w-|flex-1|flex-auto|grow|basis-|min-w-)/;

function splitButtonClass(cls: string | undefined): [string, string] {
  const outer: string[] = [];
  const inner: string[] = [];
  for (const c of (cls ?? "").split(/\s+/).filter(Boolean)) (!c.includes(":") && OUTER_CLASS.test(c) ? outer : inner).push(c);
  if (outer.some((c) => SIZED_CLASS.test(c))) inner.push("self-stretch");
  // A wrapper stretched by its parent (a dialog's close button, `items-stretch` in the title bar)
  // is taller than the button: the button fills it. Growing from its own size, it stays as it was
  // wherever the wrapper is not stretched.
  inner.push("grow");
  return [outer.join(" "), inner.join(" ")];
}

/** nsh/base's Button with a `tooltip` that shows (see above). Same props. */
export function TipButton(props: BaseButtonProps) {
  const split = () => splitButtonClass(props.class ?? undefined);
  return (
    // The wrapper is what sits in the parent, so it reports the layout (a sliding selection places
    // its highlight from these frames, which are relative to the parent).
    <View class={split()[0]} tooltip={props.tooltip} onLayout={props.onLayout}>
      <BaseButton {...props} tooltip={undefined} onLayout={undefined} class={split()[1]} />
    </View>
  );
}

export type ButtonVariant = "primary" | "outlined" | "plain" | "danger" | "highlight" | "ghost-danger";
export type ButtonSize = "md" | "sm" | "xs" | "xxs";

// The ui-kit's .touchable variants (styles/ui-kit.css, the morph theme): primary, danger and
// highlight are the solid ones, one finish in three colours (components/solidLook.ts: a crisp
// hairline, a lit top edge and a soft shadow that deepens on hover, a fill a step deeper on hover
// and pressed, the shadow gone while pressed, an inset focus ring); outlined is translucent white
// on a hairline that darkens on hover; plain is bare text that takes a soft blue fill on hover.
// Disabled looks are the morph theme's (`body[data-theme=morph] .touchable.*[disabled]`): never a
// plain opacity, each variant fades to its own paler colours.
const BUTTON_VARIANTS: Record<
  ButtonVariant,
  {
    box: string;
    text: TokenName;
    textClass: string;
    disabledText: TokenName;
    press: string;
    /** A solid variant's tone (solidLook.ts): its shadows by state. Its `box` holds the tone's fills. */
    solid?: SolidTone;
    /** A non-solid variant's shadow at rest and on hover. */
    shadow?: [string, string];
    /** The border beam's colour while loading. */
    beam: BeamTone;
    /** The box while loading, in place of `box` and its disabled look: filled variants turn soft (a
     * tint of their colour, a hairline and text in it); plain ones gain a faint hairline for the
     * beam to ride. Without it the variant's disabled look stays (outlined). */
    loadingBox?: string;
    /** The text and icon colour on `loadingBox`. */
    loadingText?: TokenName;
    /** A box without a border: the faint hairline drawn for the beam to ride while loading, not
     * laid out, so the button keeps its size. */
    loadingTrack?: TokenName;
  }
> = {
  primary: {
    box: `${solidBox("primary")} disabled:bg-primary-disabled disabled:border-primary-disabled-line`,
    text: "primary-foreground",
    textClass: "text-primary-foreground group-disabled:text-on-disabled",
    disabledText: "on-disabled",
    // Pressed, the fill itself deepens (the box's `active:`): no layer over it.
    press: "",
    solid: "primary",
    beam: "blue",
    loadingBox: "bg-blue/10 border-[0.5px] border-blue/35",
    loadingText: "ink",
  },
  outlined: {
    box: "bg-outline-bg border border-outline-line hover:bg-outline-bg-hover hover:border-outline-line-hover disabled:bg-outline-disabled-bg disabled:border-outline-disabled-line",
    text: "foreground",
    textClass: "text-foreground group-disabled:text-outline-disabled-text",
    disabledText: "outline-disabled-text",
    press: "group-active:bg-press",
    beam: "blue",
    shadow: [
      "inset 0 1px 0 rgba(255, 255, 255, 0.2), 0 0 4px rgba(24, 46, 72, 0.05)",
      "inset 0 1px 0 rgba(255, 255, 255, 0.2), 0 1px 3px rgba(24, 46, 72, 0.1)",
    ],
  },
  plain: {
    box: "hover:bg-hover disabled:bg-transparent",
    text: "subtle",
    textClass: "text-subtle group-hover:text-foreground group-disabled:text-plain-disabled-text",
    disabledText: "plain-disabled-text",
    press: "group-active:bg-press",
    beam: "blue",
    loadingBox: "bg-transparent",
    loadingTrack: "line-faint",
  },
  danger: {
    box: `${solidBox("danger")} disabled:bg-outline-disabled-bg disabled:border-danger-disabled-line`,
    text: "destructive-foreground",
    textClass: "text-destructive-foreground group-disabled:text-danger-disabled-text",
    disabledText: "danger-disabled-text",
    press: "",
    solid: "danger",
    beam: "red",
    loadingBox: "bg-danger/10 border-[0.5px] border-danger/35",
    loadingText: "danger",
  },
  highlight: {
    box: `${solidBox("warn")} disabled:bg-warn-disabled disabled:border-warn-disabled-line`,
    text: "warn-foreground",
    textClass: "text-warn-foreground group-disabled:text-on-disabled",
    disabledText: "on-disabled",
    press: "",
    solid: "warn",
    beam: "amber",
    loadingBox: "bg-warn/12 border-[0.5px] border-warn/40",
    loadingText: "warn-dark",
  },
  "ghost-danger": {
    box: "hover:bg-close disabled:bg-transparent",
    text: "danger",
    textClass: "text-danger group-disabled:text-plain-disabled-text",
    disabledText: "plain-disabled-text",
    press: "group-active:bg-press",
    beam: "red",
    loadingBox: "bg-transparent",
    loadingTrack: "danger-disabled-line",
  },
};

// The ui-kit's .q-button sizes: md 44, sm 38, xs 32, xxs 24 points tall; 0.8rem side padding
// (1rem at md); text 14, 14, 12 and 11.2; a 16pt icon 8pt before the label. Corners: the
// controls' continuous 8pt; the 24pt xxs takes the largest radius whose curve fits it (7pt).
const XXS_RADIUS = fittingRadius(RADIUS.control, 24);
const BUTTON_SIZES: Record<ButtonSize, { box: string; text: string; icon: number; square: string; radius: number; corners: string }> = {
  md: { box: "h-11 px-4 gap-2", text: "text-sm", icon: 16, square: "size-11", radius: RADIUS.control, corners: CONTROL_CORNERS },
  sm: { box: "h-9.5 px-[12.8px] gap-2", text: "text-sm", icon: 16, square: "size-9.5", radius: RADIUS.control, corners: CONTROL_CORNERS },
  xs: { box: "h-8 px-[12.8px] gap-2", text: "text-xs", icon: 16, square: "size-8", radius: RADIUS.control, corners: CONTROL_CORNERS },
  xxs: { box: "h-6 px-[12.8px] gap-1.5", text: "text-[11.2px]", icon: 14, square: "size-6", radius: XXS_RADIUS, corners: cornersClass(XXS_RADIUS) },
};

/** A Button variant's finish (for tests): its solid tone if it is a solid one, its box classes and its press layer's. */
export function buttonVariantFinish(variant: ButtonVariant): { solid?: SolidTone; box: string; press: string } {
  const v = BUTTON_VARIANTS[variant];
  return { solid: v.solid, box: v.box, press: v.press };
}

/** A button size's corners: its radius in points and its classes (continuous). */
export function buttonCorners(size: ButtonSize = "sm"): { radius: number; corners: string } {
  const { radius, corners } = BUTTON_SIZES[size];
  return { radius, corners };
}

export interface ButtonProps {
  /** primary (the default commit), outlined, plain (quiet), danger, highlight, ghost-danger. */
  variant?: ButtonVariant;
  /** md 44, sm 38 (default), xs 32, xxs 24 points tall, as the Vue console's AppButton sizes. */
  size?: ButtonSize;
  /** The button's text; with an `icon`, its name instead (see `icon`). */
  label?: string;
  /**
   * The button's face. A button shows text or a glyph, never both: with an icon it is a square icon
   * button, and its `label` is not drawn but names it, as its accessible name and its tooltip
   * (a `title` is the tooltip only of a button without a label). The busy beam of `loading` is a state, not a
   * glyph: a text button keeps its label while it runs.
   */
  icon?: IconName;
  /** A square icon button whose glyph is its `children`; give `title` (or `label`) for its tooltip and accessible name. */
  iconOnly?: boolean;
  /** The tooltip, and the accessible name when there is no label. */
  title?: string;
  /** The accessible name, when the label alone would not say enough ("Change" in a list of rows). */
  accessibilityLabel?: string;
  disabled?: boolean;
  /** Busy: disabled (presses blocked), keeping its size and content, with the border beam running round it (design/ui-refresh.html §6). */
  loading?: boolean;
  /** Full width (an icon button then keeps its height and centres its glyph). */
  block?: boolean;
  /** A long label wraps onto more lines, centred, and the button grows taller (at least its size's height) instead of cutting the label off. */
  wrap?: boolean;
  /** On (a toggled tool, the open panel's button): ink on a soft blue fill, as the ui-kit's `toggle-on`. */
  selected?: boolean;
  /** How it sits across its parent's axis (default `start`; `block` stretches). `center` centres it in a column without a wrapper. */
  align?: "start" | "center" | "end" | "stretch" | "auto";
  class?: string;
  testID?: string;
  onPress?: () => void;
  /** Room around the button that takes its presses too (a compact button keeps a 44pt target). */
  hitSlop?: BaseButtonProps["hitSlop"];
  /** The button's frame in its parent. */
  onLayout?: BaseButtonProps["onLayout"];
  /** Its icon's frame in it (layout probes in tests). */
  onIconLayout?: (event: { bounds: { origin: { x: number; y: number }; size: { width: number; height: number } } }) => void;
  /** Anything after the label (a count), or an `iconOnly` button's own glyph. Not a glyph beside a label. */
  children?: JSX.Element;
}

/** A size's box for a wrapping label: its height as a minimum, with room above and below the lines. */
const wrapBox = (box: string) => `${box.replace(/(^|\s)h-/, "$1min-h-")} py-2`;

const ALIGN_SELF = { start: "self-start", center: "self-center", end: "self-end", stretch: "self-stretch", auto: "self-auto" } as const;

const LOADING_TEXT_CLASS: Partial<Record<TokenName, string>> = { ink: "text-ink", danger: "text-danger", "warn-dark": "text-warn-dark" };

/**
 * The busy state's beam (design/ui-refresh.html §6) for any control drawn as a button `variant`:
 * mount it last inside the control's `relative` box. It rides the box's own border (the soft
 * hairline of `busyLook`), or, for the bare variants, draws a faint hairline of its own to ride.
 * `short` is the 40pt beam of xs/xxs and icon-sized controls (else 64).
 */
export function BusyBeam(props: {
  busy: boolean;
  variant?: ButtonVariant;
  short?: boolean;
  border?: number;
  /** The box's corner radius (default the controls' 8pt; a circle button's: half its side). */
  radius?: number;
  testID?: string;
}) {
  const variant = () => BUTTON_VARIANTS[props.variant ?? "primary"];
  return (
    <If when={props.busy}>
      <BorderBeam
        length={props.short ? 40 : 64}
        tone={variant().beam}
        track={variant().loadingTrack ? String(token(variant().loadingTrack!)) : undefined}
        border={props.border ?? (variant().loadingTrack ? 0 : variant().loadingText ? 0.5 : 1)}
        radius={props.radius ?? RADIUS.control}
        testID={props.testID}
      />
    </If>
  );
}

/* ---------- circle buttons ---------- */

/** A circle button's side: `md` 38pt (the composer's controls), `sm` 32pt. */
export const CIRCLE_BUTTON_SIZES = { md: 38, sm: 32 } as const;
export type CircleButtonSize = keyof typeof CIRCLE_BUTTON_SIZES;
/** `plain`: bare, the plain button's fill on hover and press; `outlined`: a hairline ring; `primary`:
 * filled ink, and `danger`: filled red, the solid buttons' finish (solidLook.ts) and their pale
 * disabled looks; `close`: a dialog's close button, the soft red tint of the close strip it
 * replaced, deeper on hover. */
export type CircleButtonVariant = "plain" | "outlined" | "primary" | "danger" | "close";

/** The fill of a head's round button while it is on (the Topics head's view toggles, the Contacts head's tabs): a blue tint under a blue icon. */
export const CIRCLE_BUTTON_ON_FILL = "bg-blue/12";

/**
 * A circle button's look, for a control that draws its own box (a menu's trigger): round, the
 * glyph in the middle, the variant's fill and ring.
 */
export function circleButtonClass(options: { size?: CircleButtonSize; variant?: CircleButtonVariant } = {}): string {
  const side = options.size === "sm" ? "size-8" : "size-[38px]";
  const look =
    options.variant === "primary"
      ? `${solidBox("primary")} disabled:bg-primary-disabled disabled:border-primary-disabled-line`
      : options.variant === "danger"
        ? `${solidBox("danger")} disabled:bg-outline-disabled-bg disabled:border-danger-disabled-line`
        : options.variant === "close"
          ? "bg-close hover:bg-close-hover focus:bg-close-hover active:bg-close-hover"
        : options.variant === "outlined"
          ? "border border-line-soft bg-transparent hover:bg-hover active:bg-press"
          : // The plain button's look (BUTTON_VARIANTS.plain): a fill on hover, a deeper one pressed.
            "hover:bg-hover active:bg-press";
  return `relative ${side} items-center justify-center rounded-full transition-colors duration-[180ms] ${look}`;
}

/** The glyph's colour on a round button's fill: what is written on that fill (its disabled text's while disabled), else the plain glyphs'. */
export function circleIconColor(variant?: CircleButtonVariant, disabled?: boolean): TokenName {
  if (variant === "primary") return disabled ? "on-disabled" : "primary-foreground";
  if (variant === "danger") return disabled ? "danger-disabled-text" : "destructive-foreground";
  return "subtle";
}

/** A round button's solid tone, if its variant is a filled one. */
export function circleSolidTone(variant?: CircleButtonVariant): SolidTone | undefined {
  return variant === "primary" ? "primary" : variant === "danger" ? "danger" : undefined;
}

/**
 * The standard round icon button: `icon` in the middle (14pt, `iconColor`; `iconSize` for another,
 * as a column head's BAR_ICON_SIZE), or a glyph of its own as `children`; `title` is its tooltip
 * and its accessible name. `class` adds to the look (a selected fill, a busy box).
 */
export function CircleButton(props: {
  title: string;
  icon?: IconName;
  iconColor?: TokenName;
  iconSize?: number;
  size?: CircleButtonSize;
  variant?: CircleButtonVariant;
  selected?: boolean;
  disabled?: boolean;
  hitSlop?: number | { top?: number; bottom?: number; left?: number; right?: number };
  onPress?: () => void;
  class?: string;
  testID?: string;
  children?: JSX.Element;
}) {
  return (
    <TipButton
      onPress={() => props.onPress?.()}
      disabled={props.disabled}
      selected={props.selected}
      accessibilityLabel={props.title}
      tooltip={<Tip text={props.title} />}
      hitSlop={props.hitSlop as any}
      testID={props.testID}
      class={`${circleButtonClass({ size: props.size, variant: props.variant })} ${props.class ?? ""}`}
      // A filled one's finish (solidLook.ts): its shadows by state; the fills are in its classes.
      style={solidStateStyles(circleSolidTone(props.variant)).style}
      hoverStyle={solidStateStyles(circleSolidTone(props.variant)).hoverStyle}
      focusVisibleStyle={solidStateStyles(circleSolidTone(props.variant)).focusVisibleStyle}
      activeStyle={solidStateStyles(circleSolidTone(props.variant)).activeStyle}
      disabledStyle={solidStateStyles(circleSolidTone(props.variant)).disabledStyle}
    >
      <If when={props.children} else={<Icon name={props.icon ?? "PhPlus"} size={props.iconSize ?? 14} color={props.iconColor ?? circleIconColor(props.variant, props.disabled)} />}>
        {props.children}
      </If>
    </TipButton>
  );
}

/**
 * How a control drawn as a button `variant` looks while busy: `box`, the classes for its fill and
 * hairline (filled variants turn soft), and `text`, its text and icon colour. Use with BusyBeam.
 */
export function busyLook(variant: ButtonVariant = "primary"): { box: string; text: TokenName } {
  const v = BUTTON_VARIANTS[variant];
  return { box: v.loadingBox ?? "", text: v.loadingText ?? v.disabledText };
}

/** The console's button: one command, any input. */
// nsh 0.4.0 on Android: a box that clips (`overflow-hidden`, which rounds the press layer) and casts
// an outer shadow moves its children into an inner box that takes the presses, and the button
// never gets them. Android buttons go without the shadow (SOLID_SHADOWS, for the solid ones too).
const BUTTON_SHADOWS = SOLID_SHADOWS;

/** A selected solid button: the toggles' soft blue under ink (`bg-selection`), with none of the solid fills. */
const SELECTED_SOLID_BOX = "border-[0.5px] border-transparent";

export function Button(props: ButtonProps) {
  // In a dialog's actions row it counts itself, and shares the row's width when it is one of two
  // on a sheet (DialogActions).
  const actions = DialogActionsRow();
  if (actions) cleanup(actions.add());
  const variant = () => BUTTON_VARIANTS[props.variant ?? "primary"];
  // A selected solid button is a soft toggle, not a raised fill: no solid finish then.
  const solid = () => (props.selected ? undefined : variant().solid);
  const shadow = () => (BUTTON_SHADOWS && !variant().solid ? variant().shadow : undefined);
  const states = () => solidStateStyles(solid());
  const size = () => BUTTON_SIZES[props.size ?? "sm"];
  const enabled = () => !props.disabled && !props.loading;
  // Loading is disabled: presses are blocked. Filled variants turn soft (their own tint, hairline
  // and text) so the beam reads on them; outlined keeps its disabled look; plain ones keep their
  // disabled text with a faint hairline drawn for the beam. The button's size never changes.
  const loadingFill = () => (props.loading ? variant().loadingBox : undefined);
  const loadingText = () => (props.loading ? variant().loadingText : undefined);
  const iconColor = (): TokenName =>
    loadingText() ?? (props.disabled || props.loading ? variant().disabledText : props.selected ? "ink" : variant().text);
  const textClass = () =>
    loadingText() ? LOADING_TEXT_CLASS[loadingText()!] : props.selected && enabled() ? "text-ink" : variant().textClass;
  // A glyph is the whole face: the label is then the button's name, not drawn (ButtonProps.icon).
  const glyphFace = () => !!props.iconOnly || !!props.icon;
  const square = () => !!props.iconOnly || (!!props.icon && !!props.label);
  // The tooltip: a glyph's label (what it would have read), else the title.
  const tip = () => (glyphFace() && props.label ? props.label : props.title);
  return (
    <TipButton
      disabled={!enabled()}
      selected={props.selected}
      onPress={() => enabled() && props.onPress?.()}
      accessibilityLabel={props.accessibilityLabel || props.label || props.title || props.icon || undefined}
      testID={props.testID}
      hitSlop={props.hitSlop}
      tooltip={tip() ? <Tip text={tip()!} /> : undefined}
      class={`group relative flex-row items-center justify-center ${props.loading ? "" : "overflow-hidden"} ${size().corners} border-transparent ${loadingFill() ?? (variant().solid && props.selected ? SELECTED_SOLID_BOX : variant().box)} ${
        square() && !props.block ? `${size().square} px-0` : props.wrap && !glyphFace() ? wrapBox(size().box) : size().box
      } ${props.block ? "self-stretch" : ALIGN_SELF[props.align ?? "start"]} ${props.selected ? "bg-selection" : ""} ${actions?.equal() ? "flex-1 min-w-0" : ""} ${props.class ?? ""}`}
      onLayout={props.onLayout}
      // Only the colours ease: a shadow changes at once (solidLook.ts), and nsh zeroes the easing
      // under reduced motion.
      style={{
        boxShadow: states().style?.boxShadow ?? shadow()?.[0],
        transitionProperty: "colors",
        transitionDuration: 180,
        transitionTimingFunction: "ease-out",
      }}
      hoverStyle={states().hoverStyle ?? (shadow() && enabled() ? { boxShadow: shadow()![1] } : undefined)}
      focusVisibleStyle={states().focusVisibleStyle}
      activeStyle={states().activeStyle}
      disabledStyle={states().disabledStyle ?? (shadow() ? { boxShadow: "none" } : undefined)}
    >
      <View
        accessibilityElementsHidden
        class={`absolute inset-0 ${size().corners} transition-colors duration-100 ease-out ${variant().press}`}
        style={{ pointerEvents: "none" }}
      />
      <BusyBeam
        busy={!!props.loading}
        variant={props.variant}
        short={props.size === "xs" || props.size === "xxs"}
        radius={size().radius}
        testID={props.testID ? `${props.testID}-loading` : undefined}
      />
      <If when={props.icon}>
        <Icon name={props.icon!} size={size().icon} color={iconColor()} onLayout={props.onIconLayout} />
      </If>
      <If when={props.label && !glyphFace()}>
        <Text
          class={`${size().text} font-medium tracking-[0.01em] transition-colors duration-180 ${textClass()} ${props.wrap ? "min-w-0 shrink text-center" : ""}`}
          style={props.wrap ? undefined : { numberOfLines: 1 }}
        >
          {props.label}
        </Text>
      </If>
      {props.children}
    </TipButton>
  );
}

/* ---------- fields ---------- */

export interface TextFieldProps {
  value: string;
  onChange?: (value: string) => void;
  onSubmit?: (text: string) => void;
  /** What Enter does in a one-line field: `blurAndSubmit` (the default: submits and lets go of the focus) or `submit` (keeps the focus, for a form that stays open when its submit fails). */
  submitBehavior?: "submit" | "blurAndSubmit";
  onKeyPress?: (key: string) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  placeholder?: string;
  /** A label above the field. */
  label?: string;
  /** A hint below it. */
  hint?: string;
  /** An error below it, in place of the hint. */
  error?: string;
  masked?: boolean;
  multiline?: boolean;
  /** Visible lines of a multiline field. */
  rows?: number;
  disabled?: boolean;
  readonly?: boolean;
  /** Mono text: paths, keys, ids, code. */
  mono?: boolean;
  autoFocus?: boolean;
  maxLength?: number;
  keyboardType?: "default" | "email-address" | "numeric" | "url" | "number-pad" | "decimal-pad" | "phone-pad";
  /** md 44 (default), sm 38, xs 32 points tall, as the Vue console's AppInput sizes. */
  size?: "md" | "sm" | "xs";
  /** An icon inside the field, before the text. */
  leadingIcon?: IconName;
  /** Something inside the field, after the text (a reveal button, a unit). */
  trailing?: JSX.Element;
  /** Vue's clear button inside the field's end (AppInput's `clear-btn`): empties it (`onChange("")`); shown while the field holds text, as Vue's. */
  clearable?: boolean;
  /** Called after the clear button emptied the field. */
  onClear?: () => void;
  /** The clear button's accessible name (default "Clear"). */
  clearLabel?: string;
  class?: string;
  inputClass?: string;
  testID?: string;
  accessibilityLabel?: string;
  inputRef?: (ref: InputRef) => void;
  /** The field's box (the bordered row the text and its buttons are in), in the field (layout probes in tests). */
  onBoxLayout?: (event: { bounds: { origin: { x: number; y: number }; size: { width: number; height: number } } }) => void;
}

// The ui-kit's field (.q-input, the morph theme): white at 92 %, a hairline that turns blue with a
// faint halo while focused, the controls' continuous corners (the halo follows them); 44pt tall
// with 12pt padding, a textarea 12pt all round.
const FIELD_SIZES = {
  md: { box: "min-h-11", text: "text-sm", height: 44 },
  sm: { box: "min-h-9.5", text: "text-sm", height: 38 },
  xs: { box: "min-h-8", text: "text-xs", height: 32 },
} as const;
const CLEAR_SIZES = { md: 32, sm: 28, xs: 24 } as const;
/** The clear button's corners, nested in the field's: the field's radius less the gap round it. */
const clearRadius = (size: keyof typeof CLEAR_SIZES) => nestedRadius(RADIUS.control, (FIELD_SIZES[size].height - CLEAR_SIZES[size]) / 2);
/** A regular (md) field's height, for boxes that stand in for one (a stored secret, a locked field). */
export const FIELD_HEIGHT = FIELD_SIZES.md.box;
const FIELD_FOCUS = {
  // Read when a field takes the focus, so it follows the theme shown then.
  get borderColor() {
    return String(token("ring"));
  },
  get boxShadow() {
    return `0 0 0 1px ${withAlpha(String(token("blue")), 0.16)}`;
  },
};

/** A text field with its label, hint and error, as the Vue console's AppInput and AppTextarea. */
export function TextField(props: TextFieldProps) {
  const lines = () => Math.max(1, props.rows ?? (props.multiline ? 3 : 1));
  const size = () => FIELD_SIZES[props.size ?? "md"];
  return (
    <View class={`gap-1 ${props.class ?? ""}`}>
      <If when={props.label}>
        <Text class="text-xs font-medium text-subtle">{props.label}</Text>
      </If>
      <View
        class={`flex-row gap-2 ${CONTROL_CORNERS} border bg-field ${props.multiline ? "items-start" : `items-center ${size().box}`} ${
          props.leadingIcon ? "pl-2.5" : ""
        } ${props.error ? "border-danger" : "border-input"} ${props.disabled ? "bg-transparent opacity-50" : ""}`}
        focusWithinStyle={props.error ? undefined : FIELD_FOCUS}
        style={{ transitionProperty: "colors, box-shadow", transitionDuration: 200, transitionTimingFunction: "ease-in-out" }}
        onLayout={props.onBoxLayout}
      >
        <If when={props.leadingIcon}>
          <Icon name={props.leadingIcon!} size={15} color="muted-foreground" />
        </If>
        <Input
          ref={(node: InputRef) => props.inputRef?.(node)}
          value={props.value}
          onChange={({ value }) => props.onChange?.(value)}
          onSubmit={({ text }) => props.onSubmit?.(text)}
          submitBehavior={props.multiline ? undefined : props.submitBehavior}
          onKeyPress={props.onKeyPress ? ({ key }) => props.onKeyPress?.(key) : undefined}
          onFocus={props.onFocus}
          onBlur={props.onBlur}
          placeholder={props.placeholder}
          masked={props.masked}
          multiline={props.multiline}
          readonly={props.readonly || props.disabled}
          autoFocus={props.autoFocus}
          maxLength={props.maxLength}
          keyboardType={props.keyboardType}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel={props.accessibilityLabel || props.label || props.placeholder}
          testID={props.testID}
          class={`min-w-0 flex-1 self-stretch ${props.multiline ? "p-3 leading-[18.2px]" : `${props.leadingIcon ? "pl-0.5" : "pl-3"} pr-3 py-1.5`} ${
            size().text
          } text-foreground placeholder:text-placeholder caret-blue selection:bg-blue/22 ${props.mono ? "font-mono" : ""} ${
            props.inputClass ?? ""
          }`}
          style={props.multiline ? { minHeight: lines() * 18.2 + 24 } : undefined}
        />
        <If when={props.clearable && props.value !== "" && !props.disabled && !props.readonly && !props.multiline}>
          <BaseButton
            onPress={() => {
              props.onChange?.("");
              props.onClear?.();
            }}
            accessibilityLabel={props.clearLabel || "Clear"}
            testID={props.testID ? `${props.testID}-clear` : undefined}
            class={`group mr-[5px] items-center justify-center ${CONTINUOUS} transition-colors duration-180 hover:bg-hover active:bg-press`}
            style={{ width: CLEAR_SIZES[props.size ?? "md"], height: CLEAR_SIZES[props.size ?? "md"], borderRadius: clearRadius(props.size ?? "md") }}
          >
            <Icon name="AppIconEditorDelete" size={16} color="subtle" />
          </BaseButton>
        </If>
        {props.trailing}
      </View>
      <If when={props.error || props.hint}>
        <Text class={`text-xs ${props.error ? "text-danger" : "text-muted-foreground"}`}>{props.error || props.hint}</Text>
      </If>
    </View>
  );
}

/** A switch's track: 34 by 20pt, the tracks' continuous 6pt corners. */
export const SWITCH_TRACK_CORNERS = TRACK_CORNERS;
/** A switch's thumb (14pt, inset 3pt by the track's hairline and padding): the track's corners nested. */
export const SWITCH_THUMB_CORNERS = cornersClass(nestedRadius(RADIUS.track, 3));

/** A switch with its label (the Vue console's AppSwitch). */
export function Toggle(props: {
  checked: boolean;
  onChange?: (checked: boolean) => void;
  label?: string;
  hint?: string;
  /** The track alone: `label` is only its accessible name. */
  hideLabel?: boolean;
  disabled?: boolean;
  class?: string;
  testID?: string;
}) {
  return (
    <Switch
      checked={props.checked}
      disabled={props.disabled}
      onChange={({ checked }) => props.onChange?.(checked)}
      accessibilityLabel={props.label}
      testID={props.testID}
      class={`group flex-row items-center gap-2.5 disabled:opacity-50 ${props.class ?? ""}`}
      trackClass={`h-5 w-[34px] ${SWITCH_TRACK_CORNERS} border border-line p-[2px] transition duration-180 group-hover:border-muted-foreground checked:border-ink checked:bg-ink`}
      thumbClass={`size-3.5 ${SWITCH_THUMB_CORNERS} bg-card checked:translate-x-3.5`}
      thumbStyle={{
        boxShadow: "0 0 0 1px rgba(24, 24, 50, 0.22), 0 1px 1px rgba(24, 24, 50, 0.1)",
        transitionProperty: "transform",
        transitionDuration: 260,
        transitionTimingFunction: "cubic-bezier(0.3, 1.35, 0.5, 1)",
      }}
    >
      <If when={!props.hideLabel && (props.label || props.hint)}>
        <View class="flex-1 gap-0.5">
          <If when={props.label}>
            <Text class="text-sm text-foreground">{props.label}</Text>
          </If>
          <If when={props.hint}>
            <Text class="text-xs text-muted-foreground">{props.hint}</Text>
          </If>
        </View>
      </If>
    </Switch>
  );
}

/** A checkbox with its label. */
export function CheckboxField(props: {
  checked: boolean;
  onChange?: (checked: boolean) => void;
  label?: string;
  disabled?: boolean;
  indeterminate?: boolean;
  class?: string;
}) {
  return (
    <BaseCheckbox
      checked={props.checked}
      indeterminate={props.indeterminate}
      disabled={props.disabled}
      onChange={({ checked }) => props.onChange?.(checked)}
      accessibilityLabel={props.label}
      class={`flex-row items-center gap-2 disabled:opacity-45 ${props.class ?? ""}`}
      indicatorClass="size-4 items-center justify-center rounded-(--radius) border border-input bg-field checked:bg-blue checked:border-blue"
      indicator={<Icon name="PhCheck" size={12} color="on-accent" />}
    >
      <If when={props.label}>
        <Text class="text-sm text-foreground">{props.label}</Text>
      </If>
    </BaseCheckbox>
  );
}

export interface Choice {
  value: string;
  label: string;
  /** A second line or a note beside the label. */
  description?: string;
  disabled?: boolean;
}

/* ---------- popups over the page ---------- */

// The popups open over a page: dialogs, menus, selects and the composer's suggestions. Escape is the
// topmost one's, but a keymap binding that fires takes the key from them all (and the newest
// binding fires first, whichever popup opened last), so a page's own Escape (a panel beside the
// content) holds back while any of them is open.
const openPopups = signal(0);

/** Whether a popup (`trackPopup`) is open over the page. */
export const popupOpen = () => openPopups() > 0;

/** Counts a popup as open while `open()` says so, until the component that tracks it goes. */
export function trackPopup(open: () => boolean) {
  effect(() => {
    if (!open()) return;
    untracked(() => openPopups.set(untracked(openPopups) + 1));
    cleanup(() => openPopups.set(untracked(openPopups) - 1));
  });
}

/**
 * Escape closes a panel beside the content (a `SidePane` column, a settings or store pane at the
 * right) while `active()` holds, but never while a popup is open over the page: the binding is
 * dropped meanwhile, so the dialog opened from the panel (Rename, Delete, a picker) gets Escape
 * and the panel stays open under it as it was. Call it in the panel's component body.
 *
 * A page's own key, so an application shortcut: not bound where those are off
 * (lib/shortcutPolicy.ts); the panel's close or back button is there as ever.
 */
export function bindPaneEscape(close: () => void, active: () => boolean = () => true, options?: KeyBindingOptions) {
  effect(() => {
    if (!shortcutsEligible() || !active() || popupOpen()) return;
    cleanup(keymap.bind("escape", () => close(), options));
  });
}

/** A dropdown of choices (the Vue console's AppSelect / AppDropdownMenu in select mode). */
export function SelectField(props: {
  items: Choice[];
  value: string | null;
  onChange?: (value: string) => void;
  label?: string;
  hint?: string;
  placeholder?: string;
  disabled?: boolean;
  searchable?: boolean;
  /** md 44 (default), sm 38, xs 32 points tall, as the ui-kit's dropdown sizes (`.q-dropdown-menu.sm`). */
  size?: "md" | "sm" | "xs";
  class?: string;
  testID?: string;
}) {
  const current = () => props.items.find((item) => item.value === props.value);
  const height = () => ({ md: "h-11", sm: "h-9.5", xs: "h-8" })[props.size ?? "md"];
  const triggerClass = () =>
    `${height()} flex-row items-center justify-between gap-2 ${CONTROL_CORNERS} border bg-field ${
      props.size === "xs" ? "pl-[9.6px]" : "pl-[12.8px]"
    } pr-2 transition-colors duration-180`;
  const valueText = () => (
    <Text class={`flex-1 ${props.size === "xs" ? "text-xs" : "text-sm"} ${current() ? "text-foreground" : "text-placeholder"} line-clamp-1`}>
      {current()?.label ?? props.placeholder ?? ""}
    </Text>
  );
  // nsh's Select lays its list over the trigger on the web, the chosen row on the field (as a
  // macOS pop-up button); the ui-kit's dropdown (.q-menu) drops below it, 8pt down, at least as wide
  // as the field, with the chevron turned while open; the chosen row is not marked (the field says it). A Menu places as asked, so the plain select
  // is a menu of checkable rows; only the searchable one keeps Select (it filters as one types).
  const open = signal(false);
  // Disabled, the list goes without saying it closed.
  trackPopup(() => open() && !props.disabled);
  const triggerWidth = signal(0);
  // Phones and touch screens: the list is the shared floating paper (`PopupList`); the base
  // dropdown stays shut there (`open` held false) and only says when its trigger asks to open.
  const sheetOpen = signal(false);
  const openChange = (next: boolean) => {
    if (untracked(popupSheets)) {
      if (next) sheetOpen.set(true);
      return;
    }
    open.set(next);
  };
  const sheet = () => (
    <PopupList
      open={sheetOpen() && !props.disabled}
      onClose={() => sheetOpen.set(false)}
      label={props.label || props.placeholder}
      items={props.items.map((item) => ({ value: item.value, title: item.label, note: item.description, disabled: item.disabled }))}
      value={props.value ?? ""}
      onChoose={(value) => props.onChange?.(value)}
      filterPlaceholder={props.searchable ? props.placeholder || props.label || "Filter" : undefined}
      partID={props.testID ? `${props.testID}-popup` : undefined}
    />
  );
  const plain = () => (
    <Menu
      open={popupSheets() ? false : undefined}
      placement="bottom"
      // .q-menu is the field's width and at least 220pt, overflowing to the left: its right
      // edge is the field's.
      align="end"
      offset={8}
      onOpenChange={({ open: next }) => openChange(next)}
      popupClass={`${MENU_POPUP} max-h-80`}
      popupStyle={{ ...MENU_POPUP_STYLE, minWidth: Math.max(220, triggerWidth()) }}
      popupStartingClass={MENU_STARTING}
      popupEndingClass="opacity-0"
      trigger={
        <View
          testID={props.testID}
          accessibilityLabel={props.label || props.placeholder}
          accessibilityValue={{ text: current()?.label ?? "" }}
          onLayout={(event) => triggerWidth.set(event.bounds.size.width)}
          class={`${triggerClass()} group ${open() ? "border-ring" : "border-input"}`}
        >
          {valueText()}
          <Icon
            name="PhCaretDown"
            size={14}
            color="muted-foreground"
            class={`opacity-50 transition duration-180 group-hover:opacity-100 ${open() ? "rotate-180" : ""}`}
          />
        </View>
      }
    >
      {/* nsh's Menu does not scroll: its rows past max-h-80 would run off the popup. */}
      <Scroll class="shrink">
      <Each of={props.items} key={(item) => item.value}>
        {(item) => (
          <MenuItem
            disabled={item().disabled}
            checked={item().value === props.value}
            indicator={<View />}
            indicatorClass="hidden"
            onSelect={() => props.onChange?.(item().value)}
            class={`${MENU_ITEM_BOX} py-2.5 hover:bg-hover focus:bg-hover disabled:opacity-50`}
          >
            <Text class="text-sm leading-5 text-foreground">{item().label}</Text>
            <If when={item().description}>
              <Text class="text-xs text-muted-foreground">{item().description}</Text>
            </If>
          </MenuItem>
        )}
      </Each>
      </Scroll>
    </Menu>
  );
  return (
    <View class={`gap-1 ${props.class ?? ""}`}>
      <If when={props.label}>
        <Text class="text-xs font-medium text-subtle">{props.label}</Text>
      </If>
      <If when={props.searchable && !props.disabled} else={
        <If when={!props.disabled} else={<View class={`${triggerClass()} border-input opacity-50`}>{valueText()}<Icon name="PhCaretDown" size={14} color="muted-foreground" class="opacity-50" /></View>}>
          {plain()}
        </If>
      }>
      <Select
        items={props.items.map((item) => ({ value: item.value, title: item.label, disabled: item.disabled }))}
        value={props.value}
        open={popupSheets() ? false : undefined}
        disabled={props.disabled}
        searchable={props.searchable}
        accessibilityLabel={props.label || props.placeholder}
        onChange={({ value }) => value !== null && props.onChange?.(value)}
        onOpenChange={({ open: next }) => openChange(next)}
        testID={props.testID}
        class={`${height()} flex-row items-center justify-between gap-2 ${CONTROL_CORNERS} border border-input bg-field ${
          props.size === "xs" ? "pl-[9.6px]" : "pl-[12.8px]"
        } pr-2 transition-colors duration-180 aria-expanded:border-ring disabled:opacity-50`}
        placement="bottom"
        align="start"
        offset={4}
        popupClass={MENU_POPUP}
        popupStyle={MENU_POPUP_STYLE}
        itemClass={`${MENU_ITEM_BOX} py-2 text-sm text-foreground hover:bg-hover focus:bg-hover selected:bg-selection`}
        searchClass={`mx-2 mb-1 ${MENU_ITEM_CORNERS} border border-input px-2 py-1 text-sm`}
        trigger={
          <View class="flex-1 flex-row items-center justify-between gap-2">
            <Text class={`flex-1 ${props.size === "xs" ? "text-xs" : "text-sm"} ${current() ? "text-foreground" : "text-placeholder"} line-clamp-1`}>
              {current()?.label ?? props.placeholder ?? ""}
            </Text>
            <Icon name="PhCaretDown" size={14} color="muted-foreground" class={`opacity-50 transition duration-180 ${open() || sheetOpen() ? "rotate-180" : ""}`} />
          </View>
        }
      />
      </If>
      <If when={props.hint}>
        <Text class="text-xs text-muted-foreground">{props.hint}</Text>
      </If>
      {sheet()}
    </View>
  );
}

/* ---------- menus ---------- */

export interface MenuEntry {
  id: string;
  label?: string;
  icon?: IconName;
  /** Red: deletes or cannot be undone. */
  danger?: boolean;
  disabled?: boolean;
  /** A check mark beside it (a current choice). */
  checked?: boolean;
  separator?: boolean;
  /** A second line under the label. */
  description?: string;
  onSelect?: () => void;
}

// The ui-kit's menu (.q-menu, the morph theme): white on a faint hairline with a soft drop
// shadow, 8pt above and below the items, items 8pt by 16pt; it drops in 4pt from its trigger.
// The popovers' continuous 12pt corners; each item's highlight is inset 8pt from the sides as
// from the top and bottom, its corners nested in the menu's (12 less the hairline and the 8pt:
// 3pt), and its text 8pt further in, at 16pt as before.
export const MENU_POPUP = `min-w-55 ${POPOVER_CORNERS} border border-line-faint bg-dialog py-2 transition duration-120`;
/** A menu item's corners: the menu's, nested by its hairline and the 8pt inset. */
export const MENU_ITEM_RADIUS = nestedRadius(RADIUS.popover, 1 + 8);
export const MENU_ITEM_CORNERS = cornersClass(MENU_ITEM_RADIUS);
/** A menu item's box in a `MENU_POPUP`: inset 8pt from the sides, its text 16pt in, its corners nested. */
export const MENU_ITEM_BOX = `mx-2 px-2 ${MENU_ITEM_CORNERS}`;
export const MENU_POPUP_STYLE = {
  // The lit top edge is the theme's (`sheen`): bright on a light popup, faint on a dark one.
  get boxShadow() {
    return `inset 0 1px 0 ${token("sheen")}, 0 10px 24px rgba(24, 46, 72, 0.12)`;
  },
  transitionTimingFunction: MOTION_EASE_CSS,
};
export const MENU_STARTING = "opacity-0 -translate-y-1";
/**
 * The large corners of the console's floating paper: the dialogs, and every popup on phones (More
 * and the agents in MobileBottomNav, `DialogLayer`'s floating paper, `PopupSheet`): the dialogs'
 * continuous 18pt (with `CONTINUOUS` beside the inline `borderRadius`), all four corners, always.
 * Popover bubbles on desktops have the popovers' 12pt (`POPOVER_CORNERS`).
 */
export const POPUP_RADIUS = RADIUS.dialog;
/** The rows on the phone's floating paper (`PopupList`): its corners nested by its hairline and 8pt padding. */
export const POPUP_ROW_RADIUS = nestedRadius(POPUP_RADIUS, 1 + 8);

/**
 * A menu of commands opened from a trigger (the Vue console's AppMenu and dropdown menus).
 *
 * nsh's Menu opens on a press of the trigger's own outer view, so the trigger must not hold a
 * pressable of its own: a `Button` (a `TipButton`: a tooltip view around nsh/base's Button) takes
 * every press and the menu never opens. Give it a plain view (`MenuIconTrigger`, `role="button"`)
 * and pass `disabled` here, not to the trigger.
 */
export function DropdownMenu(props: {
  trigger: JSX.Element;
  items: MenuEntry[];
  placement?: "bottom" | "top" | "left" | "right";
  align?: "start" | "center" | "end";
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** The trigger does not open the menu (while its page saves or loads). */
  disabled?: boolean;
  /** What the menu is of, over its rows on phones (the paper's title, as More's) and for screen readers there. */
  label?: string;
  class?: string;
  /** On phones, what the paper's test ids start with (`<testID>-popup`, then `-list`,
   *  `-option-<id>`, `-highlighted-<id>` round the highlighted row). */
  testID?: string;
}) {
  const shown = signal(false);
  const isOpen = () => (props.open ?? shown()) && !props.disabled;
  trackPopup(isOpen);
  const setOpen = (open: boolean) => {
    shown.set(open);
    props.onOpenChange?.(open);
  };
  // Phones and touch screens: the commands are rows of the shared floating paper (`PopupList`);
  // the base menu stays shut there (`open` held false) and only says when its trigger asks to open.
  const rows = (): PickerItem[] =>
    props.items.flatMap((item, index, all) =>
      item.separator
        ? []
        : [
            {
              value: item.id,
              title: item.label ?? "",
              note: item.description,
              danger: item.danger,
              disabled: item.disabled,
              separated: index > 0 && !!all[index - 1].separator,
              icon: item.icon ? <Icon name={item.icon} size={16} color={item.danger ? "danger" : "subtle"} /> : undefined,
              trailing: item.checked ? <Icon name="PhCheck" size={14} color="blue" /> : undefined,
            },
          ],
    );
  return (
    <If when={!props.disabled} else={<View class="opacity-45">{props.trigger}</View>}>
    <PopupList
      open={popupSheets() && isOpen()}
      onClose={() => setOpen(false)}
      label={props.label}
      role="menu"
      items={rows()}
      partID={props.testID ? `${props.testID}-popup` : undefined}
      onChoose={(id) => props.items.find((item) => item.id === id)?.onSelect?.()}
    />
    <Menu
      trigger={props.trigger}
      placement={props.placement ?? "bottom"}
      align={props.align ?? "end"}
      open={popupSheets() ? false : props.open}
      onOpenChange={({ open }) => {
        // Shut as it is on phones, it has nothing to close: the paper closes itself.
        if (untracked(popupSheets) && !open) return;
        setOpen(open);
      }}
      popupClass={`${MENU_POPUP} ${props.class ?? ""}`}
      popupStyle={MENU_POPUP_STYLE}
      popupStartingClass={MENU_STARTING}
      popupEndingClass="opacity-0"
    >
      <Each of={props.items} key={(item) => item.id}>
        {(item) => (
          <If
            when={!item().separator}
            else={<MenuSeparator class="mx-4 my-2 h-px bg-line-faint" />}
          >
            <MenuItem
              disabled={item().disabled}
              checked={item().checked ?? null}
              onSelect={() => item().onSelect?.()}
              class={`flex-row items-center gap-2.5 ${MENU_ITEM_BOX} py-2 hover:bg-hover focus:bg-hover disabled:opacity-50`}
            >
              <If when={item().icon}>
                <Icon name={item().icon!} size={15} color={item().danger ? "danger" : "subtle"} />
              </If>
              <View class="flex-1">
                <Text class={`text-sm ${item().danger ? "text-danger" : "text-foreground"}`}>{item().label}</Text>
                <If when={item().description}>
                  <Text class="text-xs text-muted-foreground">{item().description}</Text>
                </If>
              </View>
              <If when={item().checked}>
                <Icon name="PhCheck" size={14} color="blue" />
              </If>
            </MenuItem>
          </If>
        )}
      </Each>
    </Menu>
    </If>
  );
}

/**
 * A `DropdownMenu`'s icon trigger that looks like a plain xs icon-only `Button` (32pt square, the
 * subtle icon, a soft fill on hover, a tooltip naming it), but is a plain view: the menu takes its
 * presses, taps and Enter/Space (see `DropdownMenu`). Disabled is the menu's `disabled`.
 */
export function MenuIconTrigger(props: { icon?: IconName; label: string; testID?: string }) {
  return (
    <View
      role="button"
      accessibilityLabel={props.label}
      testID={props.testID}
      tooltip={<Tip text={props.label} />}
      class={`size-8 items-center justify-center ${CONTROL_CORNERS} hover:bg-hover active:bg-press aria-expanded:bg-hover`}
      style={{ transitionProperty: "colors", transitionDuration: 180, transitionTimingFunction: "ease-out" }}
    >
      <Icon name={props.icon ?? "PhDotsThree"} size={16} color="subtle" />
    </View>
  );
}

/* ---------- popups on phones ---------- */

/** The title row of a phone's popup (More's and the agents'): min-h-9.5 and its hairline. */
export const POPUP_TITLE_HEIGHT = 39;

/** A phone popup's title row: a square mark and the name in spaced mono capitals, over a hairline. */
export function PopupTitle(props: { label: string }) {
  return (
    <View class="min-h-9.5 flex-row items-center gap-2 border-b border-line-soft px-4">
      <View class="size-1.5 bg-muted-foreground" accessibilityElementsHidden />
      <Text class="shrink font-mono text-xs uppercase tracking-widest text-muted-foreground" style={{ numberOfLines: 1 }}>
        {props.label}
      </Text>
    </View>
  );
}

/**
 * A popup on a phone (design/mobile-popups.md): what is a dropdown or a bubble at its trigger on
 * the desktops (a menu, a select, a date picker, a picker) is here the floating paper of More and
 * the agent switcher, over their scrim: all four corners round, a small gap from the window's left,
 * right and bottom outside the system's insets and the keyboard, never wider than POPUP_MAX_WIDTH,
 * sliding up from below the window's bottom edge. It is `DialogLayer`'s paper, so it is modal as a
 * dialog is: the focus stays inside it and goes back to what had it, and Escape, Android's Back
 * and a press on the scrim close it (`onClose`). `children` gets the tallest its content may be
 * (a getter: it follows the keyboard and the window), and scrolls what is taller itself.
 */
export function PopupSheet(props: {
  open: boolean;
  onClose: () => void;
  /** The paper's title row, and its name for screen readers. */
  label?: string;
  testID?: string;
  children: (contentMax: () => number) => JSX.Element;
  /** For tests: the paper's frame and motion. */
  probe?: DialogProbe;
}) {
  // The paper's hairlines (2) and its title row.
  const contentMax = () => popupFrame().maxHeight - 2 - (props.label ? POPUP_TITLE_HEIGHT : 0);
  return (
    // Out of the flow: the layer is the window's, and where it is declared (a field's column, a
    // row of controls) it must take no room and no gap, open or shut.
    <View class="absolute left-0 top-0 size-0" style={{ pointerEvents: "box-none" }}>
      <DialogLayer
        open={props.open}
        onClose={props.onClose}
        testID={props.testID}
        label={props.label}
        sheet
        panelClass="w-full max-w-[560px]"
        probe={props.probe}
      >
        <If when={props.label}>
          <PopupTitle label={props.label ?? ""} />
        </If>
        {untracked(() => props.children(contentMax))}
      </DialogLayer>
    </View>
  );
}

/**
 * Choices on a phone's popup: the rows of the agent switcher (`PickerList`: an icon, a title, a
 * second line, a mark; 44pt for a finger), an optional filter over them, in a `PopupSheet`. A row
 * pressed is `onChoose`, and the paper closes. The filter takes the focus (and raises the
 * keyboard) only once it is pressed.
 */
export function PopupList(props: {
  open: boolean;
  onClose: () => void;
  label?: string;
  items: PickerItem[];
  /** The chosen item's value, marked in the list; none for a menu of commands. */
  value?: string;
  onChoose: (value: string) => void;
  filterPlaceholder?: string;
  emptyText?: string;
  /** Rows under the list, after a hairline: never filtered out. */
  footer?: PickerItem[];
  /** What the rows are for screen readers: a `listbox` of `option`s (default), or a `menu` of `menuitem`s. */
  role?: "listbox" | "menu";
  /** What the parts' test ids start with (`-list`, `-filter`, `-option-<value>`). */
  partID?: string;
  /** The layer's test id (default `partID`). */
  layerID?: string;
  probe?: DialogProbe;
  /** For tests: the list's scroll view and what it reports. */
  listProbe?: PickerProbe;
}) {
  return (
    <PopupSheet open={props.open} onClose={props.onClose} label={props.label} testID={props.layerID ?? props.partID} probe={props.probe}>
      {(contentMax) => (
        <View class="shrink p-2">
          <PickerList
            items={props.items}
            value={props.value}
            onChoose={(value) => {
              props.onChoose(value);
              props.onClose();
            }}
            open={props.open}
            accessibilityLabel={props.label ?? ""}
            role={props.role}
            filterPlaceholder={props.filterPlaceholder}
            filterAutoFocus={false}
            emptyText={props.emptyText}
            footer={props.footer}
            rowClass="min-h-11 justify-center"
            rowRadius={POPUP_ROW_RADIUS}
            // The paper's padding (p-2) round it.
            maxHeight={contentMax() - 16}
            probe={props.listProbe}
            class="gap-1"
            testID={props.partID ? `${props.partID}-list` : undefined}
            part={(name) => (props.partID ? `${props.partID}-${name}` : undefined)}
          />
        </View>
      )}
    </PopupSheet>
  );
}

/* ---------- surfaces ---------- */

/** A tag: neutral metadata, or a scarce semantic tone. */
export function Badge(props: { tone?: Tone; label?: string; children?: JSX.Element; class?: string }) {
  const cls = () => {
    switch (props.tone) {
      case "info":
        return { box: "border-blue-lighter bg-selection", text: "text-blue-dark" };
      case "ok":
        return { box: "border-ok bg-card", text: "text-ok" };
      case "warn":
        return { box: "border-warn bg-card", text: "text-warn-dark" };
      case "danger":
        return { box: "border-danger bg-card", text: "text-danger" };
      default:
        return { box: "border-line bg-card", text: "text-subtle" };
    }
  };
  return (
    <View class={`flex-row items-center gap-1 self-start rounded-(--radius) border px-1.5 py-px ${cls().box} ${props.class ?? ""}`}>
      <If when={props.label}>
        <Text class={`font-mono text-xs ${cls().text}`}>{props.label}</Text>
      </If>
      {props.children}
    </View>
  );
}

export function Divider(props: { vertical?: boolean; class?: string }) {
  return <View class={`${props.vertical ? "w-px self-stretch" : "h-px self-stretch"} bg-line-faint ${props.class ?? ""}`} />;
}

/** A bordered panel. */
export function Card(props: { children?: JSX.Element; class?: string; onPress?: () => void; testID?: string }) {
  return (
    <View
      testID={props.testID}
      onPress={props.onPress}
      class={`${CARD_CORNERS} border border-line-faint bg-card ${props.onPress ? "active:bg-hover" : ""} ${props.class ?? ""}`}
    >
      {props.children}
    </View>
  );
}

/**
 * A titled group of a page (the Vue console's AppSection).
 *
 * - `plain` (default) and `card`: this console's earlier looks (a 16pt heading; `card` on a panel).
 * - `head`: Vue's plain AppSection: a 44pt head on a line-soft hairline, then the body 16pt below.
 * - `boxed`: Vue's `variant="boxed"`: a hairline frame on the paper; its head is a 48pt strip with
 *   the hairline under it, its body padded 16pt (12pt on phones).
 * - `pane`: Vue's `variant="pane"`: beside a list, a left hairline, head and body as `boxed`.
 *
 * In `head`, `boxed` and `pane` the head is one row: an optional `lead` (a back button) on its left
 * edge, the title as an 11pt mono caps label (its own case with `literal`), the meta on one line
 * taking the rest (cut with a fade), and `actions` at the far end, one 32pt control high. `list`:
 * the body is rows, padded only 4pt above and below.
 */
export function Section(props: {
  title?: string;
  /** One line after the title: text (cut with a fade), or a node of your own. */
  meta?: string | JSX.Element;
  /** boxed, pane: the body has no padding of its own (a table, a chart edge to edge). */
  flush?: boolean;
  /** boxed, pane: the head's and body's padding (default 16, 12 on phones). */
  padding?: number;
  /** The body takes the rest of the section's height. */
  fill?: boolean;
  style?: Record<string, unknown>;
  accessibilityLabel?: string;
  actions?: JSX.Element;
  /** Before the label (head, boxed, pane): a back button. */
  lead?: JSX.Element;
  children?: JSX.Element;
  variant?: "plain" | "card" | "head" | "boxed" | "pane";
  /** The title is a name the user gave: keep its case. */
  literal?: boolean;
  /** The body is a list of rows (boxed, pane): 4pt above and below instead of 16pt all round. */
  list?: boolean;
  class?: string;
  bodyClass?: string;
  testID?: string;
}) {
  const vueLike = () => props.variant === "head" || props.variant === "boxed" || props.variant === "pane";
  return (
    <If when={vueLike()} else={<LegacySection {...props} />}>
      <SectionVue {...props} />
    </If>
  );
}

function LegacySection(props: { title?: string; meta?: string | JSX.Element; actions?: JSX.Element; children?: JSX.Element; variant?: string; class?: string; testID?: string }) {
  return (
    <View
      testID={props.testID}
      class={`gap-3 ${props.variant === "card" ? `${CARD_CORNERS} border border-line-faint bg-card p-4` : ""} ${
        props.class ?? ""
      }`}
    >
      <If when={props.title || props.actions}>
        <View class="flex-row items-center justify-between gap-3">
          <View class="flex-1 gap-0.5">
            <If when={props.title}>
              <Text class="text-base font-semibold text-foreground">{props.title}</Text>
            </If>
            <If when={props.meta}>
              <If when={typeof props.meta === "string"} else={props.meta as JSX.Element}>
                <Text class="text-xs text-muted-foreground">{props.meta as string}</Text>
              </If>
            </If>
          </View>
          {props.actions}
        </View>
      </If>
      {props.children}
    </View>
  );
}

function SectionVue(props: {
  title?: string;
  /** One line after the title: text (cut with a fade), or a node of your own. */
  meta?: string | JSX.Element;
  /** boxed, pane: the body has no padding of its own (a table, a chart edge to edge). */
  flush?: boolean;
  /** boxed, pane: the head's and body's padding (default 16, 12 on phones). */
  padding?: number;
  /** The body takes the rest of the section's height. */
  fill?: boolean;
  style?: Record<string, unknown>;
  accessibilityLabel?: string;
  actions?: JSX.Element;
  lead?: JSX.Element;
  children?: JSX.Element;
  variant?: string;
  literal?: boolean;
  list?: boolean;
  class?: string;
  bodyClass?: string;
  testID?: string;
}) {
  const framed = () => props.variant === "boxed" || props.variant === "pane";
  const pad = () => props.padding ?? (windowSize().width <= 720 ? 12 : 16);
  const hasHead = () => !!(props.title || props.meta || props.actions || props.lead);
  return (
    <View
      testID={props.testID}
      accessibilityLabel={props.accessibilityLabel}
      style={props.style}
      class={`min-w-0 ${props.fill ? "flex-1" : ""} ${
        props.variant === "boxed"
          ? `${CARD_CORNERS} border border-line-soft bg-paper-soft`
          : props.variant === "pane"
            ? `${windowSize().width <= 720 ? "" : "border-l border-line-soft"}`
            : "gap-4"
      } ${props.class ?? ""}`}
    >
      <If when={hasHead()}>
        <View
          class={`flex-row items-center gap-2.5 ${props.children ? "border-b border-line-soft" : ""} ${
            props.variant === "pane" ? "bg-paper" : ""
          }`}
          style={{ height: framed() ? 48 : 44, paddingHorizontal: framed() ? pad() : 0 }}
        >
          <If when={props.lead}>
            <View class="-ml-2 -mr-1 h-8 flex-row items-center">{props.lead}</View>
          </If>
          <If when={props.title}>
            <View class="shrink flex-row items-center" style={{ maxWidth: "100%" }}>
              <FadeText
                text={props.title ?? ""}
                role="header"
                class={`font-mono text-[11px] font-semibold leading-[15.4px] text-subtle ${
                  props.literal ? "tracking-[0.22px]" : "uppercase tracking-[1.1px]"
                }`}
              />
            </View>
          </If>
          <View class="min-w-0 flex-1">
            <If when={props.meta}>
              <If when={typeof props.meta === "string"} else={props.meta as JSX.Element}>
                <FadeText text={String(props.meta ?? "")} class="text-xs leading-[17.4px] text-muted-foreground" />
              </If>
            </If>
          </View>
          <If when={props.actions}>
            <View class="-mr-1.5 h-8 flex-row items-center justify-end gap-1">{props.actions}</View>
          </If>
        </View>
      </If>
      <If when={props.children}>
        <View
          class={`min-w-0 gap-4 ${props.fill ? "flex-1" : ""} ${props.bodyClass ?? ""}`}
          style={
            framed() && !props.flush
              ? props.list
                ? { paddingVertical: 4 }
                : { padding: pad() }
              : undefined
          }
        >
          {props.children}
        </View>
      </If>
    </View>
  );
}

/** Placeholder rows while something loads. */
export function Skeleton(props: { rows?: number; label?: string; class?: string }) {
  const widths = [92, 76, 84, 64, 88, 70];
  const rows = () => Array.from({ length: Math.max(1, props.rows ?? 6) }, (_, i) => widths[i % widths.length]);
  return (
    <View class={`gap-3 ${props.class ?? ""}`} accessibilityLabel={props.label || "Loading"}>
      <Each of={rows()}>{(width) => <View class="h-3 rounded-(--radius) bg-muted" style={{ width: `${width()}%` }} />}</Each>
    </View>
  );
}

/** What a list says when it has nothing. */
export function EmptyState(props: { title: string; text?: string; icon?: IconName; action?: JSX.Element; class?: string }) {
  return (
    <View class={`items-center gap-2 px-6 py-10 ${props.class ?? ""}`}>
      <If when={props.icon}>
        <Icon name={props.icon!} size={28} color="muted-foreground" />
      </If>
      <Text class="text-sm font-medium text-foreground">{props.title}</Text>
      <If when={props.text}>
        <Text class="text-center text-xs text-muted-foreground">{props.text}</Text>
      </If>
      {props.action}
    </View>
  );
}

/** A progress bar, 0..1. */
/**
 * Indeterminate loading (AppProgress `infinite`, base.css): a 2pt line-soft hairline with a short
 * blue segment (28% of the track, fading at both ends) sweeping across every 1.2s, in place of the
 * ui-kit's bar. Reduced motion: the segment fills the track at half strength and stays.
 */
export function LoadingLine(props: { label?: string; class?: string; testID?: string }) {
  const width = signal(0);
  const sweep = createAnimatedValue(0);
  const still = untracked(reduceMotion);
  if (!still) {
    void sweep.keyframes([0, 1], { duration: 1200, easing: Easing.bezier(0.45, 0, 0.55, 1), iterations: "infinite" });
  }
  cleanup(() => void sweep.stop());
  const segment = () => (still ? width() : width() * 0.28);
  return (
    <View
      role="progressbar"
      accessibilityLabel={props.label}
      testID={props.testID}
      class={`h-0.5 overflow-hidden bg-line-soft ${props.class ?? ""}`}
      onLayout={(event) => width.set(event.bounds.size.width)}
    >
      <View
        class="h-full"
        style={{
          width: segment(),
          opacity: still ? 0.5 : 1,
          backgroundImage: `linear-gradient(90deg, transparent, ${token("blue")} 45%, ${token("blue")} 55%, transparent)`,
          // translateX(-100%) to translateX(357%) of the segment: fully across the track.
          transform: [{ translateX: still ? 0 : sweep.interpolate({ inputRange: [0, 1], outputRange: [-segment(), segment() * 3.57] }) }],
        }}
      />
    </View>
  );
}

/** A bar of progress; `indeterminate` is Vue's scanning hairline (LoadingLine). */
export function ProgressBar(props: { value?: number; indeterminate?: boolean; tone?: Tone; class?: string; label?: string }) {
  if (untracked(() => props.indeterminate)) return <LoadingLine label={props.label} class={props.class} />;
  const bar = () => (props.tone === "danger" ? "bg-danger" : props.tone === "warn" ? "bg-warn" : props.tone === "ok" ? "bg-ok" : "bg-blue");
  return (
    <Progress
      value={props.value}
      indeterminate={props.indeterminate}
      accessibilityLabel={props.label}
      class={props.class}
      trackClass="h-1 overflow-hidden rounded-full bg-muted"
      indicatorClass={`h-1 rounded-full ${bar()}`}
    />
  );
}

/** One option of `Tabs`. */
export interface TabItem {
  id: string;
  label: string;
  count?: number;
  disabled?: boolean;
  icon?: IconName;
  /** The option's test id (its press target). */
  testID?: string;
}

/** Where a tab strip stands, as test fixtures hear it (`probeTabStrips`). */
export interface TabStripFrame {
  /** One per strip, for as long as it is mounted. */
  strip: number;
  testID: string;
  value: string;
  /** The strip's own width: the room it shows. */
  viewport: number;
  /** The options' row, at least as wide as the viewport. */
  content: number;
  /** How far it is scrolled sideways. */
  offset: number;
  /** Whether the options are wider than the room (it scrolls). */
  scrolls: boolean;
  /** Each option's place along the content. */
  boxes: Record<string, TabBox>;
  /** The width each option's own content (icon, label, count, padding) takes. */
  natural: Record<string, number>;
  /** A mouse is dragging the strip (moved past the slop). */
  dragging: boolean;
  /** How many times the strip scrolled by itself to show an option. */
  reveals: number;
  /** Whether the last of those glided (false: it jumped), null before the first. */
  glided: boolean | null;
  /** The option with the keyboard's focus, if any. */
  focused: string | null;
}

let tabStripProbe: ((frame: TabStripFrame) => void) | null = null;
let tabStrips = 0;

/** Test fixtures hear every tab strip's widths, offset and options here (null to stop). */
export function probeTabStrips(listener: ((frame: TabStripFrame) => void) | null) {
  tabStripProbe = listener;
}

/** A mouse drag that goes this far sideways scrolls the strip. */
const TAB_DRAG_SLOP = 6;
/** A press this soon after a mouse drag ended is the drag's release, not a choice. */
const TAB_DRAG_RELEASE_MS = 250;

/**
 * Tabs (design/ui-refresh.html §1): the options in quiet text on a hairline, the current one in ink
 * with the hairline dipping softly under it; the dip glides to the next option when it changes.
 * `equal` gives every option the same share of the row; an item's `icon` shows before its label
 * (`iconOnly` hides labels, keeping them as tooltips).
 *
 * Options never get narrower than their labels: options wider than the room together scroll
 * sideways in a strip as wide as the room (never wider than its parent), their hidden edges fading.
 * A finger swipes it natively (a swipe cancels the press it began on; an up or down swipe is left to
 * the page); a mouse pressed on an option drags it once it moves a few points sideways, and the
 * release selects nothing; a wheel or touchpad scrolls it as any scroller. The current option is
 * brought into view, moving the strip as little as it must (shared/tabStrip.ts): when it changes
 * (gliding, unless the system reduces motion), on the first layout, and whenever the strip or its
 * options change size. An option already in view is never moved to, so a strip the user scrolled
 * stays put until the selection or the layout changes. `equal` options share a row they fit
 * equally; one whose label needs more keeps its width and the others share the rest
 * (`equalTabWidths`). Each option is a Tab stop, brought into view as the keyboard's focus reaches
 * it; Enter or Space selects it, and the keyboard's focus shows as a soft fill. The options are
 * pressable views (role `tab`, with its selected and disabled states), not nsh/base Buttons, which
 * report no focus.
 */
export function Tabs(props: {
  items: TabItem[];
  value: string;
  onChange?: (id: string) => void;
  equal?: boolean;
  iconOnly?: boolean;
  /** Tight options and 12pt labels (AppTabs under 380pt); on by itself in windows narrower than 380pt. */
  narrow?: boolean;
  accessibilityLabel?: string;
  class?: string;
  /** The strip's test id; its scroller is `<testID>-scroll`. */
  testID?: string;
  /** Each option's frame in the control, as `onLayout` reports it (to measure the options): along
   * the options' row, which starts at the control's start (scrolled or not), and down from the
   * control's top. */
  onItemLayout?: (id: string, event: { bounds: Bounds }) => void;
}) {
  const strip = ++tabStrips;
  const narrow = () => props.narrow ?? windowSize().width < 380;
  // Each option's place along the content (for the dip under the current one and for bringing it
  // into view), and the width its own content takes (for the equal shares).
  const boxes = signal<Record<string, TabBox>>({});
  const natural = signal<Record<string, number>>({});
  const viewport = signal(0);
  const content = signal(0);
  // Where the strip is scrolled: as it last reported, or as last asked (a report may lag). The
  // scroller is there only while the options overflow; `scrollerReady` counts the scrollers laid out.
  let offset = 0;
  let scroller: ScrollRef | undefined;
  let laidOut = false;
  const scrollerReady = signal(0);
  let reveals = 0;
  let glided: boolean | null = null;
  let focused: string | null = null;
  // A mouse drag: pressed on an option (`armed`), then where the first held move was and the offset
  // then; `moved` once past the slop. `released`: when the last drag that moved ended.
  let armed = false;
  let drag: { x: number; from: number; moved: boolean } | null = null;
  let released = 0;
  const edges = createScrollEdges({ horizontal: true, fade: 16 });
  const scrolls = computed(() => viewport() > 0 && content() > viewport() + TAB_OVERFLOW_SLACK);

  const setBox = (id: string, event: { bounds: Bounds }) => {
    const box = { x: event.bounds.origin.x, w: event.bounds.size.width };
    const old = untracked(boxes)[id];
    if (!old || old.x !== box.x || old.w !== box.w) boxes.set({ ...untracked(boxes), [id]: box });
  };
  const setNatural = (id: string, width: number) => {
    if (untracked(natural)[id] !== width) natural.set({ ...untracked(natural), [id]: width });
  };
  // `equal`: the width each option takes, once every option and the room are measured.
  const shares = computed<Record<string, number> | null>(() => {
    if (!props.equal) return null;
    const items = props.items;
    const room = viewport();
    const measured = natural();
    if (room <= 0 || items.some((item) => !(measured[item.id] > 0))) return null;
    const widths = equalTabWidths(
      items.map((item) => measured[item.id]),
      room,
    );
    return Object.fromEntries(items.map((item, index) => [item.id, widths[index]]));
  });
  // Equal options are laid out at their own widths first: the row shows once they are shared out.
  const settling = () => Boolean(props.equal) && props.items.length > 0 && shares() === null;

  const report = () =>
    tabStripProbe?.({
      strip,
      testID: untracked(() => props.testID) ?? "",
      value: untracked(() => props.value),
      viewport: untracked(viewport),
      content: untracked(content),
      offset,
      scrolls: untracked(scrolls),
      boxes: untracked(boxes),
      natural: untracked(natural),
      dragging: Boolean(drag?.moved),
      reveals,
      glided,
      focused,
    });
  const maxOffset = () => Math.max(0, untracked(content) - untracked(viewport));
  const scrollTo = (x: number, animated: boolean) => {
    if (!scroller) return;
    scroller.scrollTo({ x, animated: animated && !untracked(reduceMotion) });
    offset = x;
  };
  /** Brings option `id` into view, moving the strip as little as it must. */
  const reveal = (id: string, animated: boolean) => {
    const box = untracked(boxes)[id];
    if (!box || !scroller || !untracked(scrolls)) return;
    const next = tabRevealOffset(box, untracked(viewport), untracked(content), Math.min(offset, maxOffset()));
    if (Math.abs(next - offset) <= TAB_OVERFLOW_SLACK) return;
    reveals += 1;
    glided = animated && !untracked(reduceMotion);
    scrollTo(next, animated);
    report();
  };
  // The current option, whenever it, its place or the room change. A new value glides there; the
  // first layout and a change of sizes jump (nothing to follow).
  let shown: string | null = null;
  effect(() => {
    const value = props.value;
    const box = boxes()[value];
    const room = viewport();
    content();
    scrolls();
    scrollerReady();
    if (!box || room <= 0) return;
    const moved = shown !== null && shown !== value;
    shown = value;
    untracked(() => reveal(value, moved));
  });
  effect(() => {
    boxes();
    natural();
    viewport();
    content();
    props.value;
    untracked(report);
  });

  // A mouse drags the strip (a finger's swipe is the scroll view's own, and a mouse never drags a
  // scroll view): moves with the button held after a press on an option. The press does not fire
  // once the pointer moved off (the web drops it past 10pt); a release that still reaches an
  // option right after a drag is ignored (`choose`).
  const endDrag = () => {
    armed = false;
    if (!drag) return;
    if (drag.moved) released = Date.now();
    drag = null;
    report();
  };
  const mouseMove = (event: MouseEvent) => {
    if (event.pressedButton !== "left" || !armed || !untracked(scrolls)) {
      if (event.pressedButton !== "left") endDrag();
      return;
    }
    const x = event.pagePosition.x;
    if (!drag) {
      drag = { x, from: Math.min(offset, maxOffset()), moved: false };
      return;
    }
    const dx = x - drag.x;
    if (!drag.moved && Math.abs(dx) < TAB_DRAG_SLOP) return;
    drag.moved = true;
    scrollTo(Math.min(maxOffset(), Math.max(0, drag.from - dx)), false);
    report();
  };
  const choose = (id: string) => {
    if (drag?.moved || Date.now() - released < TAB_DRAG_RELEASE_MS) return;
    props.onChange?.(id);
  };

  const current = () => boxes()[props.value] ?? null;
  // The options' frames for `onItemLayout`, moved down by where their row sits in the control
  // (centred in a control taller than the options); told again when that moves.
  const itemFrames: Record<string, Bounds> = {};
  let rowTop = 0;
  const tellItem = (id: string) => {
    const frame = itemFrames[id];
    if (frame) props.onItemLayout?.(id, { bounds: { origin: { x: frame.origin.x, y: frame.origin.y + rowTop }, size: frame.size } });
  };
  const setViewport = (event: { bounds: Bounds }) => {
    const width = event.bounds.size.width;
    if (width !== untracked(viewport)) viewport.set(width);
    if (event.bounds.origin.y !== rowTop) {
      rowTop = event.bounds.origin.y;
      for (const id of Object.keys(itemFrames)) tellItem(id);
    }
  };
  // The options' row, with room under it for the dip, which hangs 6pt below the options; the
  // negative margin of the view around it keeps the strip as tall as its options. Drawn by the plain
  // row and by the scroller alike (each its own copy: only one is there at a time).
  const Options = () => (
    <View
      class="relative grow shrink-0 flex-row items-center pb-[6px]"
      style={{ opacity: settling() ? 0 : 1 }}
      onLayout={(event) => {
        edges.onContentLayout(event);
        const width = event.bounds.size.width;
        if (width !== untracked(content)) content.set(width);
      }}
    >
      <Each of={props.items} key={(item) => item.id}>
        {(item) => (
          <View
            role="tab"
            accessibilityLabel={item().label}
            accessibilityState={{ selected: props.value === item().id, disabled: Boolean(item().disabled) }}
            disabled={item().disabled}
            testID={item().testID}
            tooltip={props.iconOnly && item().icon ? <Tip text={item().label} /> : undefined}
            onPress={() => choose(item().id)}
            onPressDown={() => {
              armed = true;
            }}
            onFocus={() => {
              focused = item().id;
              reveal(item().id, true);
              report();
            }}
            onBlur={() => {
              if (focused === item().id) focused = null;
              report();
            }}
            onLayout={(event: { bounds: Bounds }) => {
              setBox(item().id, event);
              itemFrames[item().id] = event.bounds;
              tellItem(item().id);
            }}
            class={`group h-9 shrink-0 flex-row items-center justify-center ${CONTROL_CORNERS} focus-visible:bg-hover disabled:opacity-50`}
            style={{ minWidth: shares()?.[item().id] ?? 0 }}
          >
            {/* The option's own content, at its own width whatever share it is given. */}
            <View
              class={`h-9 flex-row items-center justify-center gap-1.5 ${
                props.iconOnly && item().icon ? "w-9" : narrow() ? "px-2" : "px-3"
              }`}
              onLayout={(event) => setNatural(item().id, event.bounds.size.width)}
            >
              <If when={item().icon}>
                <Icon name={item().icon!} size={16} color={props.value === item().id ? "ink" : "muted-foreground"} />
              </If>
              <If when={!(props.iconOnly && item().icon)}>
                <Text
                  class={`${narrow() ? "text-xs leading-[16.8px]" : "text-sm leading-[19.6px]"} font-medium transition-colors duration-120 ${
                    props.value === item().id ? "text-ink" : "text-muted-foreground group-hover:text-foreground"
                  }`}
                  style={{ numberOfLines: 1 }}
                >
                  {item().label}
                </Text>
              </If>
              <If when={item().count !== undefined}>
                <Text class="font-mono text-xs text-muted-foreground">{String(item().count)}</Text>
              </If>
            </View>
          </View>
        )}
      </Each>
      <SagRule
        center={() => (current() ? current()!.x + current()!.w / 2 : null)}
        half={sagHalf(Math.min(current()?.w ?? 38, 64))}
        color={String(token("line-soft"))}
        class="absolute bottom-0 left-0 right-0 h-[7px]"
      />
    </View>
  );
  // The strip is a plain row while its options fit and a scroller only while they do not: on the web
  // every scroller, even one that cannot scroll, keeps a vertical swipe that starts on it from
  // scrolling the page (PORTING.md), so only a strip that overflows pays for that. The options are
  // measured at their own widths either way, so the choice cannot feed back on itself.
  return (
    <View
      class={`relative flex-row items-center self-start max-w-full ${props.equal ? "self-stretch" : ""} ${props.class ?? ""}`}
      role="tablist"
      accessibilityLabel={props.accessibilityLabel}
      testID={props.testID}
      onMouseMove={mouseMove}
      onMouseUp={endDrag}
      onMouseLeave={endDrag}
    >
      <If
        when={scrolls()}
        else={
          <View
            class="-mb-[6px] min-w-0 shrink grow flex-row overflow-hidden"
            ref={() => {
              scroller = undefined;
              offset = 0;
            }}
            onLayout={setViewport}
          >
            <Options />
          </View>
        }
      >
        <Scroll
          horizontal
          ref={(node: ScrollRef) => {
            scroller = node;
            offset = 0;
            laidOut = false;
          }}
          scrollbar={SCROLLBAR}
          keyboardShouldPersistTaps="handled"
          testID={props.testID ? `${props.testID}-scroll` : undefined}
          class="-mb-[6px] min-w-0 shrink grow"
          contentClass="grow"
          style={edges.style()}
          scrollEventThrottle={16}
          onLayout={(event) => {
            edges.handlers.onLayout(event);
            setViewport(event);
            // A scroller made as the options stopped fitting starts at its start: show the current
            // option once it is laid out.
            if (!laidOut) {
              laidOut = true;
              scrollerReady.update((n) => n + 1);
            }
          }}
          onScroll={(event) => {
            edges.handlers.onScroll(event);
            offset = event.offset.x;
            report();
          }}
        >
          <Options />
        </Scroll>
      </If>
    </View>
  );
}

/* ---------- dialogs ---------- */

// The ui-kit's dialog (AppDialog / AppDialogShell, the morph theme): white on a hairline over a
// light scrim, with the dialogs' continuous corners (POPUP_RADIUS); a 44pt header with the title
// and a square red-tinted close button.
// On phones (< 720pt) it is a sheet: full width at the bottom.
//
// Motion (styles/base.css, core/dialog-origin.js): it settles in from 98 % as it fades, and when a
// press opened it (within 900 ms) it grows out of that point from 90 % instead, and goes back into
// it on close. On phones (`mobilePopups`) it is the shared floating paper instead
// (design/mobile-popups.md, lib/mobilePopup.ts): a small gap from the window's left, right and
// bottom, outside the system's insets and the keyboard, sliding up from below the window's bottom
// edge and back down out there. The panel has the popups' large corners (POPUP_RADIUS), all four of them,
// on phones too; it clips what it holds to them (a title bar, a painted footer). The
// backdrop
// and the panel are drawn here (the base Dialog is only the layer), so both can move, natively, on
// opacity and transform alone; the panel stays drawn until it is out.
const DIALOG_SHADOW = "0 12px 24px rgba(20, 24, 32, 0.14)";

/** Below this window width every popup takes the phone's presentation, whatever points at it. */
export const DIALOG_SHEET_WIDTH = 720;

/**
 * Whether popups take the phone's presentation (design/mobile-popups.md): the floating paper of
 * More and the agent switcher, for every dialog, menu, select, date picker and picker bubble. A
 * window narrower than DIALOG_SHEET_WIDTH (a phone upright, a narrow browser window), or a touch
 * screen within the phone layout's width (a phone on its side: lib/shell.ts MOBILE_BREAKPOINT).
 * Wider windows keep the desktops' dialogs and dropdowns. Reactive.
 */
export function mobilePopups() {
  const width = windowSize().width;
  return width < DIALOG_SHEET_WIDTH || (!platform.desktop && width <= MOBILE_BREAKPOINT);
}

/**
 * Whether a dropdown (a menu, a select, a date picker) is a `PopupSheet`: on phones, and on every
 * other touch screen, where nsh/base cannot anchor it to its trigger and would draw a sheet flush
 * with the screen's bottom edge, sliding up. Reactive.
 */
export function popupSheets() {
  return !platform.desktop || mobilePopups();
}

/** Whether dialogs are the phone's floating paper (`mobilePopups`). Reactive. */
export function dialogIsSheet() {
  return mobilePopups();
}

// Headless tests draw no software keyboard: a fixture stands one in (its height over the foot of
// the window), and every phone paper then stands on it as on a real one.
const keyboardStandIn = signal<number | null>(null);

/** For tests: a software keyboard `height` tall over the foot of the window (null: the real one). */
export function standInKeyboard(height: number | null) {
  keyboardStandIn.set(height);
}

/**
 * The phone paper's place in its dialog layer: the layer's padding round it, and its tallest.
 * Reactive. On Android the layer is an nsh Dialog's window, which nsh lays out above the software
 * keyboard (ModalHost): the paper keeps only its gap from the keyboard's top. A stand-in keyboard
 * (headless tests) shrinks no window, and is counted as before.
 */
export function popupFrame() {
  const { width, height } = windowSize();
  const standIn = keyboardStandIn();
  return mobilePopupFrame({
    width,
    height,
    area: safeArea(),
    keyboard: standIn ?? keyboardFrame().height,
    layerAboveKeyboard: platform.os === "android" && standIn === null,
  });
}

/** What a test reads of a dialog's panel: its frame in the layer, and its motion. */
export interface DialogProbe {
  layout?: (bounds: Bounds) => void;
  motion?: (motion: Motion) => void;
  /** The panel starts going out. */
  leave?: () => void;
}

let dialogWatcher: ((name: string) => DialogProbe | undefined) | null = null;

/**
 * For tests: a probe for every dialog layer made from now on that has none of its own, by its
 * test id or else its label (the papers under `DropdownMenu`, `SelectField` and the pickers take
 * no `probe` prop). null stops it.
 */
export function watchDialogs(watcher: ((name: string) => DialogProbe | undefined) | null) {
  dialogWatcher = watcher;
}

// Every dialog is one layer of nsh's, a `Dialog` (a modal root), on every platform: the newest
// modal is above all the others and the app's own root, so a dialog opened from a sheet (the
// chat's WorkspaceSheet, a SidePane, the skill store's panel: nsh 0.6's `Sheet` is a modal root
// too) is above it, scrim and paper, and takes the presses, Escape and Android's Back until it is
// gone. Never an `Overlay`: an overlay is drawn in the root around its node (the app's, for a
// dialog declared on a page), which is under every open sheet. On Android the layer reaches
// under the status bar (`statusBarTranslucent`), as the sheets do, and keeps its panel inside the
// system's insets itself (layerStyle).
const ANDROID_LAYER = platform.os === "android";

/** The dialog layer under `Modal` and `MessageDialog` (scrim, panel, the motion from the pressing control): for a dialog with a panel of its own. */
export function DialogLayer(props: {
  open: boolean;
  onClose: () => void;
  testID?: string;
  /** The panel's classes (width, padding, gap). */
  panelClass: string;
  panelStyle?: { maxWidth?: number };
  /** The phone's floating paper whatever the window's width (`PopupSheet`: a dropdown on a wide touch screen). */
  sheet?: boolean;
  label?: string;
  /** For tests: the panel's frame and motion. */
  probe?: DialogProbe;
  children?: JSX.Element;
}) {
  const shown = signal(untracked(() => props.open));
  trackPopup(() => props.open);
  const panel = createMotion({ initial: { opacity: 0 } });
  const probe = untracked(() => props.probe ?? dialogWatcher?.(props.testID ?? props.label ?? ""));
  probe?.motion?.(panel);
  const scrim = createAnimatedValue(0);
  const origin = signal<[number, number] | null>(null);
  let press: { x: number; y: number } | null = null;
  let pendingEnter = false;
  let closing = false;
  // Whether the paper comes in from out of sight (a first opening, or after it went out): it slides
  // up from below the window's bottom edge; reopened while going out, from where it is.
  let fromBelow = true;
  const narrow = () => !!props.sheet || dialogIsSheet();
  /** How far down the paper is out of sight: its top at the layer's bottom edge (positive). */
  const away = (bounds?: Bounds | null) =>
    mobilePopupEntrance(bounds?.origin.y ?? 0, bounds?.size.height ?? 0, untracked(() => windowSize().height));
  // The paper slides the whole way in and out, as the phone's other popups do (MobileBottomNav): a
  // little longer than a dialog's settle. Going out is quicker than coming in, on an easing that
  // starts slow and leaves fast (MOTION_EXIT_EASE), so it gets out of the way.
  const duration = (sheet: boolean) => motionMs(sheet ? MOTION_SHEET_IN : MOTION_NORMAL);
  const exitDuration = (sheet: boolean) => motionMs(sheet ? MOTION_SHEET_OUT : MOTION_EXIT);

  const enter = (bounds?: { origin: { x: number; y: number }; size: { width: number; height: number } }) => {
    if (!pendingEnter) return;
    pendingEnter = false;
    const sheet = untracked(narrow);
    const ms = duration(sheet);
    void scrim.timing(1, { duration: ms, easing: MOTION_EASE });
    if (sheet) {
      origin.set(null);
      panel.opacity.set(1);
      panel.scale.set(1);
      if (ms <= 0) {
        panel.translateY.set(0);
        return;
      }
      if (fromBelow) panel.translateY.set(away(bounds ?? panelBox));
      void panel.translateY.timing(0, { duration: ms, easing: MOTION_EASE });
      return;
    }
    panel.translateY.set(0);
    const fromPress = !!press && !!bounds;
    if (fromPress && bounds) origin.set([press!.x - bounds.origin.x, press!.y - bounds.origin.y]);
    else origin.set(null);
    if (ms <= 0) {
      panel.scale.set(1);
      panel.opacity.set(1);
      return;
    }
    const from = fromPress ? 0.9 : 0.98;
    void panel.play({ duration: ms, keyframes: { opacity: [{ value: 0, easing: MOTION_EASE }, 1], scale: [{ value: from, easing: MOTION_EASE }, 1] } });
  };

  effect(() => {
    const open = props.open;
    untracked(() => {
      if (open) {
        fromBelow = !closing;
        closing = false;
        press = recentPress();
        pendingEnter = true;
        if (narrow()) {
          // Out of sight below the bottom edge until its first layout says where it is and how
          // tall; reopened while going out, it turns back from where it is.
          if (fromBelow) {
            panel.opacity.set(1);
            panel.translateY.set(away());
          }
        } else panel.opacity.set(0);
        if (!shown()) shown.set(true);
        // The panel's first layout starts the entrance; when its frame did not change (reopened in
        // place), start it on the next frame.
        requestAnimationFrame(() => requestAnimationFrame(() => enter()));
      } else if (shown() && !closing) {
        closing = true;
        pendingEnter = false;
        const sheet = narrow();
        const ms = exitDuration(sheet);
        if (ms <= 0) {
          shown.set(false);
          return;
        }
        void scrim.timing(0, { duration: ms, easing: MOTION_EXIT_EASE });
        probe?.leave?.();
        // The panel stays drawn (and its contents mounted) while it goes out.
        const out = sheet
          ? panel.translateY.timing(away(panelBox), { duration: ms, easing: MOTION_EXIT_EASE })
          : panel.play({
              duration: ms,
              keyframes: {
                opacity: [{ value: 1, easing: MOTION_EXIT_EASE }, 0],
                scale: [{ value: 1, easing: MOTION_EXIT_EASE }, origin() ? 0.9 : 0.98],
              },
            });
        void out.then(() => {
          if (closing) shown.set(false);
        });
      }
    });
  });

  // The panel's frame in the layer, which the scrim covers from its origin.
  let panelBox: Bounds | null = null;
  // The scrim and the panel, in whichever layer holds them.
  const layer = () => [
    <View
      accessibilityElementsHidden
      // Found in tests as `<testID>-scrim`.
      testID={props.testID ? `${props.testID}-scrim` : undefined}
      // On phones the backdrop of More and the agent switcher.
      class={`absolute inset-0 ${narrow() ? "bg-scrim" : "bg-dialog-scrim"}`}
      style={{ opacity: scrim }}
      // Android hands a touch that nothing in the panel takes (its padding, a label) to the views
      // behind it, so the scrim hears presses on the panel too: only those outside it close.
      onPress={(event) => {
        const box = panelBox;
        const { x, y } = event.position;
        if (box && x >= box.origin.x && x <= box.origin.x + box.size.width && y >= box.origin.y && y <= box.origin.y + box.size.height) return;
        props.onClose();
      }}
      focusable={false}
    />,
    <View
      accessibilityLabel={props.label}
      onLayout={(event) => {
        panelBox = event.bounds;
        probe?.layout?.(event.bounds);
        enter(event.bounds);
      }}
      // On phones the paper of More and the agent switcher: their hairline and shadow, as tall as
      // the window leaves it (lib/mobilePopup.ts); what does not fit scrolls inside it.
      class={`overflow-hidden ${CONTINUOUS} border bg-dialog ${narrow() ? "w-full border-line-faint" : "max-h-[90%] border-dialog-line"} ${props.panelClass}`}
      style={{
        ...(props.panelStyle ?? {}),
        ...(narrow() ? { maxHeight: popupFrame().maxHeight } : {}),
        borderRadius: POPUP_RADIUS,
        // Not on Android, as the bottom bar: a shadow there would not follow the corners, and
        // a view that clips and casts one moves its children into a box of their own (PORTING.md).
        boxShadow: platform.os === "android" ? undefined : narrow() ? MENU_POPUP_STYLE.boxShadow : DIALOG_SHADOW,
        transformOrigin: origin() ?? "center",
        ...panel.style,
      }}
    >
      {props.children}
    </View>,
  ];
  const layerClass = () =>
    `absolute inset-0 items-center ${narrow() ? "justify-end" : `justify-center ${ANDROID_LAYER ? "" : "p-4"}`}`;
  // On phones the panel floats at the foot of the layer, which keeps it a small gap in from the
  // left, the right and the bottom, outside the room the system takes there (a notch, the
  // navigation bar or gesture handle, or the software keyboard, which the layer does not shrink
  // for, except on Android: nsh lays its dialog windows out above it, see popupFrame) and below
  // the status bar (lib/mobilePopup.ts): the layer's padding, on every platform, so
  // the paper's own bottom edge and corners show above the inset. Numbers, not
  // `env(keyboard-inset-height)`: the env value moves a view natively but not in nsh's layout,
  // where presses are matched. Wide windows: Android's layer covers the whole surface, status
  // and navigation bars included, so there the layer keeps the panel inside every inset
  // (lib/systemInsets.ts), with a 16pt margin.
  const layerStyle = () => {
    if (narrow()) {
      const frame = popupFrame();
      return { paddingTop: frame.top, paddingRight: frame.right, paddingBottom: frame.bottom, paddingLeft: frame.left };
    }
    if (!ANDROID_LAYER) return undefined;
    const insets = dialogLayerInsets(safeArea(), 0, 16);
    return { paddingTop: insets.top, paddingRight: insets.right, paddingBottom: insets.bottom, paddingLeft: insets.left };
  };

  return (
    <Dialog
      open={shown()}
      // Escape and Back would close the layer at once, under the closing motion: they only ask
      // (onCancel), and the panel goes out as a press on the scrim or the close button makes it.
      closeOnEscape={false}
      closeOnSwipe={false}
      onCancel={() => props.onClose()}
      onOpenChange={({ open }) => {
        if (!open) props.onClose();
      }}
      testID={props.testID}
      animation="none"
      // Over the whole screen as the sheets' layers are (nsh 0.4.0's Dialog started below the status
      // bar and took presses one status bar higher than it drew them; the Console used an Overlay).
      android={{ statusBarTranslucent: true }}
      class={layerClass()}
      style={layerStyle()}
    >
      {layer()}
    </Dialog>
  );
}

// A dialog's actions row. Each `Button` rendered in it counts itself while it is mounted (one an
// `If` hides does not count), and while the dialog is a sheet (phones) and exactly two show, they
// share the row's width equally. One, three or more keep their own widths, and so does every row on
// wider windows. The buttons must sit in the row itself (or in a row inside it): a button in a
// column of its own would grow down, not across.
interface DialogActionsCount {
  /** Counts a button in; the returned function counts it out. */
  add(): () => void;
  /** Whether the row's buttons share its width. */
  equal(): boolean;
}
const DialogActionsRow = context<DialogActionsCount | null>(null);

/**
 * Its children, with the functions among them (expression children, `If`) run here, under the
 * context values provided around it, each in a memo of its own. nsh web's `Provider` hands its
 * children on as they are, so such a function would run later, outside the value (the native
 * runtimes, and so headless tests, run them under it).
 */
function UnderContext(props: { children?: JSX.Element }) {
  const memoize = (value: JSX.Element): JSX.Element =>
    typeof value === "function" ? computed(() => memoize((value as () => JSX.Element)())) : Array.isArray(value) ? value.map(memoize) : value;
  return untracked(() => memoize(props.children));
}

/** A dialog's row of actions: two on a sheet are equally wide (see above). Takes a View's classes. */
export function DialogActions(props: { class?: string; style?: { paddingBottom?: number }; testID?: string; children?: JSX.Element }) {
  const count = signal(0);
  const row: DialogActionsCount = {
    add() {
      count.update((n) => n + 1);
      let counted = true;
      return () => {
        if (!counted) return;
        counted = false;
        count.update((n) => n - 1);
      };
    },
    equal: () => count() === 2 && dialogIsSheet(),
  };
  return (
    <View class={props.class} style={props.style} testID={props.testID}>
      <DialogActionsRow.Provider value={row}>
        <UnderContext>{props.children}</UnderContext>
      </DialogActionsRow.Provider>
    </View>
  );
}

export type ModalSize = "sm" | "md" | "lg" | "xl" | "full";
const MODAL_WIDTHS: Record<ModalSize, string> = {
  sm: "w-full max-w-sm",
  md: "w-full max-w-[560px]",
  lg: "w-full max-w-2xl",
  xl: "w-full max-w-4xl",
  full: "w-full h-full",
};

/** A dialog over the window (the Vue console's AppDialogShell): title, body, footer of actions. */
export function Modal(props: {
  open: boolean;
  onClose: () => void;
  title?: string;
  description?: string;
  size?: ModalSize;
  /** A width of its own in points (Vue's picker dialogs are 720), over `size`. */
  width?: number;
  /** Actions at the bottom, the default commit last. */
  footer?: JSX.Element;
  /** Something at the right of the title bar. */
  headerActions?: JSX.Element;
  /** Whether the body scrolls (default true). */
  scroll?: boolean;
  /**
   * A body without its own padding: the children reach the panel's sides and bottom edge, right
   * under the title bar (a full-screen preview). Their own spacing is theirs.
   */
  flush?: boolean;
  children?: JSX.Element;
  testID?: string;
  closeLabel?: string;
  /** For tests: the panel's frame and motion. */
  probe?: DialogProbe;
}) {
  return (
    <DialogLayer
      open={props.open}
      onClose={props.onClose}
      testID={props.testID}
      label={props.title}
      panelClass={props.width ? "w-full" : MODAL_WIDTHS[props.size ?? "md"]}
      panelStyle={props.width ? { maxWidth: props.width } : undefined}
      probe={props.probe}
    >
      <View class="min-h-11 flex-row items-stretch border-b border-dialog-line">
        <View class="flex-1 justify-center gap-0.5 py-2 pl-3 pr-2">
          <If when={props.title}>
            <Text class="text-base font-semibold leading-[19.2px] tracking-[-0.32px] text-foreground" role="header" style={{ numberOfLines: 1 }}>
              {props.title}
            </Text>
          </If>
          <If when={props.description}>
            <Text class="text-xs text-muted-foreground">{props.description}</Text>
          </If>
        </View>
        {/* The close button: a round one, 6pt in from the top and the side, so it sits in the
            panel's round corner as the corner's own curve does (it was a red strip flush in the
            corner, which the corner would clip). */}
        <View class="flex-row items-center gap-1 pr-1.5">
          {props.headerActions}
          <CircleButton
            title={props.closeLabel ?? "Close"}
            icon="PhX"
            iconColor="danger"
            size="sm"
            variant="close"
            onPress={props.onClose}
            testID={props.testID ? `${props.testID}-close` : undefined}
          />
        </View>
      </View>
      <If when={props.scroll !== false} else={<View class={props.flush ? "flex-1" : "flex-1 p-4"}>{props.children}</View>}>
        <EdgeScroll class="shrink" contentClass={props.flush ? "gap-3" : "p-4 gap-3"}>
          {props.children}
        </EdgeScroll>
      </If>
      <If when={props.footer}>
        <DialogActions
          class="flex-row flex-wrap items-center justify-end gap-2 border-t border-line-faint px-4 py-3"
          testID={props.testID ? `${props.testID}-footer` : undefined}
        >
          {props.footer}
        </DialogActions>
      </If>
    </DialogLayer>
  );
}

export interface MessageAction {
  id: string;
  label: string;
  variant?: ButtonVariant;
  disabled?: boolean;
  loading?: boolean;
  onPress?: () => void;
}

/** A short message with its choices (the Vue console's AppMessageDialog): a centred icon, title and text, then the choices side by side. */
export function MessageDialog(props: {
  open: boolean;
  onClose: () => void;
  title: string;
  text?: string;
  icon?: IconName;
  tone?: Tone;
  actions: MessageAction[];
  children?: JSX.Element;
  testID?: string;
  /** For tests: the panel's frame and motion. */
  probe?: DialogProbe;
}) {
  return (
    <DialogLayer
      open={props.open}
      onClose={props.onClose}
      testID={props.testID}
      label={props.title}
      panelClass="w-full max-w-[500px] items-stretch px-4 pb-4 pt-6"
      probe={props.probe}
    >
      <If when={props.icon}>
        <View class="mb-4 items-center">
          <Icon name={props.icon!} size={32} color={props.tone === "danger" ? "danger" : "blue"} />
        </View>
      </If>
      <Text class="mb-2 text-center text-base font-semibold text-foreground" role="header">
        {props.title}
      </Text>
      <If when={props.text}>
        <Text class="mb-6 text-center text-sm text-subtle">{props.text}</Text>
      </If>
      {props.children}
      <View class="flex-row gap-4">
        <Each of={props.actions} key={(action) => action.id}>
          {(action) => (
            <Button
              variant={action().variant ?? "outlined"}
              size="md"
              block
              class="flex-1"
              label={action().label}
              disabled={action().disabled}
              loading={action().loading}
              onPress={() => action().onPress?.()}
              testID={`dialog-action-${action().id}`}
            />
          )}
        </Each>
      </View>
    </DialogLayer>
  );
}

/* ---------- confirm, as a promise ---------- */

interface ConfirmRequest {
  title: string;
  text?: string;
  confirmLabel: string;
  cancelLabel: string;
  danger?: boolean;
  resolve: (ok: boolean) => void;
}
const confirmRequest = signal<ConfirmRequest | null>(null);

/** Asks a yes or no question; resolves true on confirm. Rendered by `ConfirmHost` in the shell. */
export function confirm(options: Omit<ConfirmRequest, "resolve">): Promise<boolean> {
  return new Promise((resolve) => {
    untracked(() => confirmRequest())?.resolve(false);
    confirmRequest.set({ ...options, resolve });
  });
}

export function ConfirmHost() {
  const answer = (ok: boolean) => {
    const request = untracked(() => confirmRequest());
    confirmRequest.set(null);
    request?.resolve(ok);
  };
  return (
    <MessageDialog
      open={confirmRequest() !== null}
      onClose={() => answer(false)}
      title={confirmRequest()?.title ?? ""}
      text={confirmRequest()?.text}
      icon={confirmRequest()?.danger ? "PhWarning" : "PhQuestion"}
      tone={confirmRequest()?.danger ? "danger" : "info"}
      actions={[
        { id: "cancel", label: confirmRequest()?.cancelLabel ?? "", variant: "outlined", onPress: () => answer(false) },
        {
          id: "confirm",
          label: confirmRequest()?.confirmLabel ?? "",
          variant: confirmRequest()?.danger ? "danger" : "primary",
          onPress: () => answer(true),
        },
      ]}
    />
  );
}

/* ---------- notices ---------- */

/**
 * The floating notice stack (the Vue console's AppNoticeHost), fed by lib/core/notices.js: at the
 * bottom right on wide windows; on phones under the top bar, the screen's width less the gutter,
 * where it covers neither the bar's buttons (Back) nor the bottom navigation and the composer (a
 * notice saying to tap the mic again sat on the mic).
 */
export function NoticeHost(props: { class?: string }) {
  const tone = (type: string) =>
    type === "error" ? "border-danger" : type === "warning" ? "border-warn" : type === "success" ? "border-ok" : "border-blue";
  const icon = (type: string): IconName =>
    type === "error" ? "PhWarningCircle" : type === "warning" ? "PhWarning" : type === "success" ? "PhCheckCircle" : "PhInfo";
  const color = (type: string): TokenName =>
    type === "error" ? "danger" : type === "warning" ? "warn-dark" : type === "success" ? "ok" : "blue";
  return (
    <View
      class={`absolute gap-2 ${isMobile() ? "left-3 right-3" : "bottom-4 right-4 w-80 max-w-[90%]"} ${props.class ?? ""}`}
      style={{ pointerEvents: "box-none", top: isMobile() ? CHROME_BAR_HEIGHT + 8 : undefined }}
      testID="notice-host"
    >
      <Each of={noticeState.items as { id: string; type: string; text: string; label: string }[]} key={(item) => item.id}>
        {(item) => (
          <View
            role="alert"
            class={`flex-row items-start gap-2 rounded-(--radius) border-l-2 bg-popover px-3 py-2 shadow-md ${tone(item().type)}`}
          >
            <Icon name={icon(item().type)} size={16} color={color(item().type)} />
            <View class="flex-1 gap-0.5">
              <If when={item().label}>
                <Text class="font-mono text-xs uppercase text-muted-foreground">{item().label}</Text>
              </If>
              <View selectable>
                <Text class="text-sm text-foreground">{item().text}</Text>
              </View>
            </View>
            <Button variant="plain" size="xxs" iconOnly icon="PhX" title="Dismiss" onPress={() => dismissNotice(item().id)} />
          </View>
        )}
      </Each>
    </View>
  );
}

/** Shows `error` in the notice stack while it is set, as the Vue console's AppPage did. */
export function usePageError(error: () => string, id = `page-error-${Math.random().toString(36).slice(2)}`) {
  effect(() => {
    const text = String(error() || "").trim();
    untracked(() => {
      if (text) pushNotice({ id, type: "error", text, timeout: 0 });
      else dismissNotice(id);
    });
  });
  cleanup(() => dismissNotice(id));
}

/* ---------- the page frame ---------- */

/**
 * A workspace page: its bar (title, actions) and its body (the Vue console's AppPage). The bar is
 * as tall as the sidebar's switcher (57pt with its hairline) with the content's side gutter; the
 * title is the 20pt regular of `.workspace-section-title`. The body's padding and gap follow the
 * window's width as AppPage.css's clamps do.
 */
export function Page(props: {
  title?: string;
  /** Replaces the title in the bar (a picker, a breadcrumb). */
  leading?: JSX.Element;
  actions?: JSX.Element;
  /** A page-level error: shown in the notice stack while set. */
  error?: string;
  /** Whether the body scrolls as one (default true); false for pages that own their scrolling. */
  scroll?: boolean;
  hideBar?: boolean;
  /** With `scroll` false: the body's own scroller runs on under the bar (it takes `underBar()` and
   * starts with the bar's room itself), so the bar is glass. */
  glassBar?: boolean;
  children?: JSX.Element;
  bodyClass?: string;
  testID?: string;
  /** Remembers where the body is scrolled across visits of the page (lib/scrollMemory.ts). */
  memory?: ScrollMemory;
}) {
  usePageError(() => props.error ?? "");
  return (
    <View class="flex-1" testID={props.testID}>
      <If when={!props.hideBar}>
        {/* Over a body that scrolls as one, the bar is glass: the body runs on under it. */}
        <PageBar title={props.title} leading={props.leading} actions={props.actions} glass={props.scroll !== false || props.glassBar} />
      </If>
      <If when={props.scroll !== false} else={<View class={`flex-1 ${props.bodyClass ?? ""}`}>{props.children}</View>}>
        <EdgeScroll
          class="flex-1"
          start={false}
          style={props.hideBar ? undefined : underBar()}
          ref={(node) => props.memory?.ref(node)}
          onScroll={(event) => props.memory?.onScroll(event)}
        >
          <If when={!props.hideBar}>
            <BarRoom />
          </If>
          <View
            class={props.bodyClass ?? ""}
            style={{ gap: pageGap(), paddingTop: pageTop(), paddingHorizontal: gutterX(), paddingBottom: gutterY() }}
          >
            {props.children}
          </View>
          <MobileBarSpacer />
        </EdgeScroll>
      </If>
    </View>
  );
}

/**
 * A page's bar alone (AppPage.css `.page-bar`), for pages that lay out their own body. `glass`: the
 * scroller under it runs on behind it (components/frame/glassBar.tsx: give that scroller
 * `underBar()` and start its content with `BarRoom`).
 */
export function PageBar(props: { title?: string; leading?: JSX.Element; actions?: JSX.Element; class?: string; glass?: boolean }) {
  return (
    <View
      class={`flex-row items-center gap-2 border-b border-line-soft py-2 ${props.glass ? glassBarClass() : ""} ${props.class ?? ""}`}
      style={{ height: CHROME_BAR_HEIGHT, paddingHorizontal: gutterX(), ...(props.glass ? glassBarStyle() : {}) }}
    >
      <View class="flex-1 flex-row items-center gap-2">
        <If when={props.leading} else={<PageTitle text={props.title ?? ""} />}>
          {props.leading}
        </If>
      </View>
      <If when={props.actions}>
        <View class="flex-row items-center gap-2">{props.actions}</View>
      </If>
    </View>
  );
}

/** A page's title as the Vue console's `.page-title.workspace-section-title`: 20pt regular, tight. */
export function PageTitle(props: { text: string; class?: string }) {
  return (
    <FadeText
      text={props.text}
      role="header"
      class={`flex-1 pb-[2.4px] pt-[0.4px] text-xl font-normal leading-[22.8px] tracking-[-0.6px] text-foreground ${props.class ?? ""}`}
    />
  );
}

/**
 * The size of a phone bar's icon buttons: every back arrow. The Button's default, a 38pt side with
 * a 16pt icon.
 */
export const BAR_BUTTON_SIZE = "sm" satisfies ButtonSize;

/**
 * The icon of a BAR_BUTTON_SIZE button (16pt), for bar buttons drawn without Button (the index
 * column heads' round buttons: Topics, TODO, Skills) so their icons match the regular icon buttons'.
 */
export const BAR_ICON_SIZE = BUTTON_SIZES[BAR_BUTTON_SIZE].icon;

/**
 * A back arrow's sizes, named as the Button's (`sm` 38pt, `xs` 32pt), and the circle button of
 * that side each one is drawn as.
 */
const BACK_BUTTON_CIRCLES = { sm: "md", xs: "sm" } as const satisfies Partial<Record<ButtonSize, CircleButtonSize>>;
export type BackButtonSize = keyof typeof BACK_BUTTON_CIRCLES;

/** The circle button a back arrow is: BAR_BUTTON_SIZE on a phone, else its `desktopSize` (if any). */
export function backButtonCircle(mobile: boolean, desktopSize?: BackButtonSize): CircleButtonSize {
  return BACK_BUTTON_CIRCLES[mobile ? BAR_BUTTON_SIZE : (desktopSize ?? BAR_BUTTON_SIZE)];
}

/**
 * A page bar's back arrow: the standard round icon button (CircleButton, plain) with a regular icon
 * button's 16pt arrow (BAR_ICON_SIZE), as the index heads' buttons are. On a phone it is as big as
 * the bar's other icon buttons (BAR_BUTTON_SIZE, 38pt, as Todo's calendar toggle); a bar that also
 * shows on wide windows keeps its `desktopSize` there (Context's 32pt). Like the calendar toggle it
 * sits in a wrapper that the bar's row centres. `title` is its tooltip and accessible name.
 */
export function BackButton(props: {
  title: string;
  onPress: () => void;
  testID?: string;
  desktopSize?: BackButtonSize;
  /** Hears its frame on the page as `back`, and its arrow's as `back-icon` (tests). */
  onPartLayout?: PartLayoutListener;
}) {
  const parts = createPartProbe(() => props.onPartLayout);
  let box: ViewRef | undefined;
  let arrow: PartFrame | undefined;
  // The arrow lies in the button, which fills the wrapper from its corner: its frame there is its
  // frame in the wrapper.
  const report = () => {
    parts.report("back", box);
    parts.report("back-icon", box, () => arrow);
  };
  return (
    <View
      ref={(node: ViewRef) => {
        box = node;
      }}
      onLayout={report}
    >
      <CircleButton
        size={backButtonCircle(isMobile(), props.desktopSize)}
        variant="plain"
        title={props.title}
        testID={props.testID}
        onPress={() => props.onPress()}
      >
        <Icon
          name="PhArrowLeft"
          size={BAR_ICON_SIZE}
          color="subtle"
          onLayout={(event) => {
            arrow = boundsFrame(event);
            report();
          }}
        />
      </CircleButton>
    </View>
  );
}

/* ---------- side pane and floating action ---------- */

/**
 * The panel at the right of a list that edits or inspects one of its items (the Vue console's
 * AppSidePane). On wide windows it is a column beside the list: put it last in a `flex-row`.
 * With `sheet` (phones) it is a drawer from the right over a scrim. Escape closes it.
 * The drawer is a layer over the whole surface, outside the app's frame: its paper runs to the top,
 * right and bottom edges and its padding takes the system bars' and cutouts' insets, once
 * (lib/shell.ts `rightSheetPopupStyle`), so what is put in it needs none. The column is inside
 * the frame, which has taken them already.
 */
export function SidePane(props: {
  open: boolean;
  onClose: () => void;
  sheet?: boolean;
  label?: string;
  class?: string;
  children?: JSX.Element;
}) {
  return (
    <If
      when={props.sheet}
      else={
        <If when={props.open}>
          <SidePaneColumn onClose={props.onClose} label={props.label} class={props.class}>
            {props.children}
          </SidePaneColumn>
        </If>
      }
    >
      <Sheet
        open={props.open}
        side="right"
        onOpenChange={({ open }) => {
          if (!open) props.onClose();
        }}
        backdropClass="bg-scrim"
        popupClass={`h-full w-[88%] max-w-md border-l border-line bg-card ${props.class ?? ""}`}
        popupStyle={rightSheetPopupStyle()}
      >
        {props.children}
      </Sheet>
    </If>
  );
}

function SidePaneColumn(props: { onClose: () => void; label?: string; class?: string; children?: JSX.Element }) {
  bindPaneEscape(() => props.onClose());
  return (
    <View accessibilityLabel={props.label} class={`w-96 border-l border-line-faint bg-card ${props.class ?? ""}`}>
      {props.children}
    </View>
  );
}

/** One of the Fab's registration marks (fabMark.ts): a single muted hairline stroke on a canvas
 * just outside one corner, drawn behind the button, taking no presses and hidden from assistive tech. */
function FabMark(props: { corner: FabMarkCorner; probe: { ref?: (node: ViewRef) => void; onLayout?: () => void } }) {
  const outside = -FAB_MARK.gap;
  const place = props.corner === "start" ? { left: outside, top: outside } : { right: outside, bottom: outside };
  return (
    <Canvas
      accessibilityElementsHidden
      class="absolute"
      style={{ ...place, width: FAB_MARK_SIZE, height: FAB_MARK_SIZE, pointerEvents: "none" }}
      draw={(cx) => drawFabMark(cx, props.corner, String(token("muted-foreground")))}
      {...props.probe}
    />
  );
}

/**
 * The floating add button of a page (the Vue console's AppFab): a 52pt ink square at the bottom
 * right, with registration marks just outside two opposite corners (the console's drawing-sheet
 * frames; components/fabMark.ts). It rises 12pt into place as it fades in, and sinks 1pt while pressed.
 */
export function Fab(props: {
  label: string;
  icon?: IconName;
  disabled?: boolean;
  onPress?: () => void;
  testID?: string;
  /** Hears its frame on the page as `fab`, and its marks' as `fab-mark-start` and `fab-mark-end` (tests). */
  onPartLayout?: PartLayoutListener;
}) {
  const parts = createPartProbe(() => props.onPartLayout);
  const enter = createMotion({
    enter: {
      duration: MOTION_SLOW,
      keyframes: { opacity: [{ value: 0, easing: MOTION_EASE }, 1], translateY: [{ value: 12, easing: MOTION_EASE }, 0] },
    },
  });
  return (
    // Above the phone's floating bottom bar when it shows (its room less the gap under a list).
    <View class="absolute right-4" style={{ ...enter.style, bottom: mobileBarRoom() > 0 ? mobileBarRoom() - 4 : 16, pointerEvents: "box-none" }} {...parts.probe(() => "fab")}>
      <FabMark corner="start" probe={parts.probe(() => "fab-mark-start")} />
      <FabMark corner="end" probe={parts.probe(() => "fab-mark-end")} />
      <TipButton
        onPress={() => props.onPress?.()}
        disabled={props.disabled}
        accessibilityLabel={props.label}
        testID={props.testID}
        tooltip={<Tip text={props.label} placement="left" />}
        class={`size-13 items-center justify-center ${CONTROL_CORNERS} border border-primary-line bg-primary transition duration-120 active:translate-y-px disabled:opacity-55`}
        style={{ boxShadow: "0 6px 16px rgba(20, 29, 48, 0.2), 0 1px 3px rgba(20, 29, 48, 0.12)", transitionTimingFunction: MOTION_EASE_CSS }}
        activeStyle={{ boxShadow: "0 2px 6px rgba(20, 29, 48, 0.18)" }}
      >
        <Icon name={props.icon ?? "PhPlus"} size={22} color="primary-foreground" />
      </TipButton>
    </View>
  );
}
