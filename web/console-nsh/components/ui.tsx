// The console's design system: its controls, drawn from nsh/base with the morph theme's tokens
// (theme.json). Pages build from these; a missing variant is added here, not restyled per page.
//
// The look follows the Vue console's ui-kit: square-ish corners (2px), hairlines, a dark blue
// primary, quiet plain buttons, mono caps for labels, and red only for what is destructive.
import type { Bounds, InputRef, JSX, Motion } from "nsh";
import type { ButtonProps as BaseButtonProps, TextViewClasses, TextViewStyles } from "nsh/base";
import { cleanup, computed, context, createAnimatedValue, createMotion, Easing, effect, Image, keyboardFrame, keymap, Overlay, platform, reduceMotion, safeArea, Scroll, signal, Text, token, untracked, View, windowSize } from "nsh";
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
import { FILLED_ICONS, ICONS, type IconName } from "./icons";
import { BorderBeam, type BeamTone } from "./motion/BorderBeam";
import { RunningMark } from "./motion/RunningMark";
import { sagHalf, SagRule } from "./motion/Sag";
import { recentPress } from "./motion/pressOrigin";
import { EdgeScroll } from "./motion/ScrollEdges";
import { FadeText } from "./motion/FadeText";
import { CHROME_BAR_HEIGHT, gutterX, gutterY, pageGap, pageTop } from "./frame/metrics";
import { bottomSheetInsets, dialogLayerInsets, dialogSheetInsets } from "../lib/systemInsets";
import { MOTION_EASE, MOTION_EASE_CSS, MOTION_NORMAL, MOTION_SLOW, motionMs } from "./motion/tokens";
import { MobileBarSpacer, mobileBarRoom } from "./frame/mobileBar";
import { createPartProbe, type PartLayoutListener } from "./shared/partProbe";
import { isMobile } from "../lib/shell";

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

export type StatusState = "on" | "off" | "pending" | "error" | "unread" | "running";

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

// The ui-kit's .touchable variants (styles/ui-kit.css, the morph theme): primary is ink blue with a
// faint inner highlight and a shadow that deepens on hover; outlined is translucent white on a
// hairline that darkens on hover; plain is bare text that takes a soft blue fill on hover.
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
    box: "bg-primary border-[0.5px] border-primary-line disabled:bg-primary-disabled disabled:border-primary-disabled-line",
    text: "primary-foreground",
    textClass: "text-primary-foreground group-disabled:text-on-disabled",
    disabledText: "on-disabled",
    press: "group-active:bg-press-light",
    beam: "blue",
    loadingBox: "bg-blue/10 border-[0.5px] border-blue/35",
    loadingText: "ink",
    shadow: [
      "inset 0 1px 0 rgba(255, 255, 255, 0.2), 0 0 4px rgba(24, 46, 72, 0.05)",
      "inset 0 1px 0 rgba(255, 255, 255, 0.2), 0 1px 3px rgba(24, 46, 72, 0.1)",
    ],
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
    box: "bg-destructive border-[0.5px] border-destructive hover:bg-danger-light hover:border-danger-light disabled:bg-outline-disabled-bg disabled:border-danger-disabled-line",
    text: "destructive-foreground",
    textClass: "text-destructive-foreground group-disabled:text-danger-disabled-text",
    disabledText: "danger-disabled-text",
    press: "group-active:bg-press-light",
    beam: "red",
    loadingBox: "bg-danger/10 border-[0.5px] border-danger/35",
    loadingText: "danger",
  },
  highlight: {
    box: "bg-warn border-[0.5px] border-warn-dark hover:bg-warn-light hover:border-warn-light disabled:bg-warn-disabled disabled:border-warn-disabled-line",
    text: "primary-foreground",
    textClass: "text-primary-foreground group-disabled:text-on-disabled",
    disabledText: "on-disabled",
    press: "group-active:bg-press-light",
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
// (1rem at md); text 14, 14, 12 and 11.2; a 16pt icon 8pt before the label.
const BUTTON_SIZES: Record<ButtonSize, { box: string; text: string; icon: number; square: string }> = {
  md: { box: "h-11 px-4 gap-2", text: "text-sm", icon: 16, square: "size-11" },
  sm: { box: "h-9.5 px-[12.8px] gap-2", text: "text-sm", icon: 16, square: "size-9.5" },
  xs: { box: "h-8 px-[12.8px] gap-2", text: "text-xs", icon: 16, square: "size-8" },
  xxs: { box: "h-6 px-[12.8px] gap-1.5", text: "text-[11.2px]", icon: 14, square: "size-6" },
};

export interface ButtonProps {
  /** primary (the default commit), outlined, plain (quiet), danger, highlight, ghost-danger. */
  variant?: ButtonVariant;
  /** md 44, sm 38 (default), xs 32, xxs 24 points tall, as the Vue console's AppButton sizes. */
  size?: ButtonSize;
  /** The button's text. */
  label?: string;
  /** An icon before the text, or the whole button with `iconOnly`. */
  icon?: IconName;
  /** A square icon button; give `title` for its tooltip and accessible name. */
  iconOnly?: boolean;
  /** The tooltip, and the accessible name when there is no label. */
  title?: string;
  /** The accessible name, when the label alone would not say enough ("Change" in a list of rows). */
  accessibilityLabel?: string;
  disabled?: boolean;
  /** Busy: disabled (presses blocked), keeping its size and content, with the border beam running round it (design/ui-refresh.html §6). */
  loading?: boolean;
  /** Full width. */
  block?: boolean;
  /** On (a toggled tool, the open panel's button): ink on a soft blue fill, as the ui-kit's `toggle-on`. */
  selected?: boolean;
  /** How it sits across its parent's axis (default `start`; `block` stretches). `center` centres it in a column without a wrapper. */
  align?: "start" | "center" | "end" | "stretch" | "auto";
  class?: string;
  testID?: string;
  onPress?: () => void;
  /** The button's frame in its parent. */
  onLayout?: BaseButtonProps["onLayout"];
  /** Anything after the label (a count, a caret). */
  children?: JSX.Element;
}

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
  /** The box's corner radius (a circle button's: half its side). */
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
        radius={props.radius}
        testID={props.testID}
      />
    </If>
  );
}

/* ---------- circle buttons ---------- */

/** A circle button's side: `md` 38pt (the composer's controls), `sm` 32pt. */
export const CIRCLE_BUTTON_SIZES = { md: 38, sm: 32 } as const;
export type CircleButtonSize = keyof typeof CIRCLE_BUTTON_SIZES;
/** `plain`: bare, the plain button's fill on hover and press; `outlined`: a hairline ring; `primary`: filled ink. */
export type CircleButtonVariant = "plain" | "outlined" | "primary";

/**
 * A circle button's look, for a control that draws its own box (a menu's trigger): round, the
 * glyph in the middle, the variant's fill and ring.
 */
export function circleButtonClass(options: { size?: CircleButtonSize; variant?: CircleButtonVariant } = {}): string {
  const side = options.size === "sm" ? "size-8" : "size-[38px]";
  const look =
    options.variant === "primary"
      ? "border border-primary bg-primary hover:bg-ink"
      : options.variant === "outlined"
        ? "border border-line-soft bg-transparent hover:bg-hover active:bg-press"
        : // The plain button's look (BUTTON_VARIANTS.plain): a fill on hover, a deeper one pressed.
          "hover:bg-hover active:bg-press";
  return `relative ${side} items-center justify-center rounded-full transition-colors duration-[180ms] ${look}`;
}

/**
 * The standard round icon button: `icon` in the middle (14pt, `iconColor`), or a glyph of its own
 * as `children`; `title` is its tooltip and its accessible name. `class` adds to the look (a
 * selected fill, a busy box).
 */
export function CircleButton(props: {
  title: string;
  icon?: IconName;
  iconColor?: TokenName;
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
    >
      <If when={props.children} else={<Icon name={props.icon ?? "PhPlus"} size={14} color={props.iconColor ?? "subtle"} />}>
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
// never gets them. Android buttons go without the shadow.
const BUTTON_SHADOWS = platform.os !== "android";

export function Button(props: ButtonProps) {
  // In a dialog's actions row it counts itself, and shares the row's width when it is one of two
  // on a sheet (DialogActions).
  const actions = DialogActionsRow();
  if (actions) cleanup(actions.add());
  const variant = () => BUTTON_VARIANTS[props.variant ?? "primary"];
  const shadow = () => (BUTTON_SHADOWS ? variant().shadow : undefined);
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
  return (
    <TipButton
      disabled={!enabled()}
      selected={props.selected}
      onPress={() => enabled() && props.onPress?.()}
      accessibilityLabel={props.accessibilityLabel || props.label || props.title || props.icon || undefined}
      testID={props.testID}
      tooltip={props.title ? <Tip text={props.title} /> : undefined}
      class={`group relative flex-row items-center justify-center ${props.loading ? "" : "overflow-hidden"} rounded-(--radius) border-transparent ${loadingFill() ?? variant().box} ${
        props.iconOnly ? `${size().square} px-0` : size().box
      } ${props.block ? "self-stretch" : ALIGN_SELF[props.align ?? "start"]} ${props.selected ? "bg-selection" : ""} ${actions?.equal() ? "flex-1 min-w-0" : ""} ${props.class ?? ""}`}
      onLayout={props.onLayout}
      style={{
        boxShadow: shadow()?.[0],
        transitionProperty: "colors, box-shadow",
        transitionDuration: 180,
        transitionTimingFunction: "ease-out",
      }}
      hoverStyle={shadow() && enabled() ? { boxShadow: shadow()![1] } : undefined}
      disabledStyle={shadow() ? { boxShadow: "none" } : undefined}
    >
      <View
        accessibilityElementsHidden
        class={`absolute inset-0 transition-colors duration-100 ease-out ${variant().press}`}
        style={{ pointerEvents: "none" }}
      />
      <BusyBeam
        busy={!!props.loading}
        variant={props.variant}
        short={props.size === "xs" || props.size === "xxs"}
        testID={props.testID ? `${props.testID}-loading` : undefined}
      />
      <If when={props.icon}>
        <Icon name={props.icon!} size={size().icon} color={iconColor()} />
      </If>
      <If when={props.label && !props.iconOnly}>
        <Text
          class={`${size().text} font-medium tracking-[0.01em] transition-colors duration-180 ${textClass()}`}
          style={{ numberOfLines: 1 }}
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
  class?: string;
  inputClass?: string;
  testID?: string;
  accessibilityLabel?: string;
  inputRef?: (ref: InputRef) => void;
}

// The ui-kit's field (.q-input, the morph theme): white at 92 %, a hairline that turns blue with a
// faint halo while focused, 2pt corners; 44pt tall with 12pt padding, a textarea 12pt all round.
const FIELD_SIZES = {
  md: { box: "min-h-11", text: "text-sm" },
  sm: { box: "min-h-9.5", text: "text-sm" },
  xs: { box: "min-h-8", text: "text-xs" },
} as const;
const CLEAR_SIZES = { md: 32, sm: 28, xs: 24 } as const;
/** A regular (md) field's height, for boxes that stand in for one (a stored secret, a locked field). */
export const FIELD_HEIGHT = FIELD_SIZES.md.box;
const FIELD_FOCUS = { borderColor: "#426f9e9e", boxShadow: "0 0 0 1px rgba(66, 111, 158, 0.16)" };

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
        class={`flex-row gap-2 rounded-(--radius) border bg-field ${props.multiline ? "items-start" : `items-center ${size().box}`} ${
          props.leadingIcon ? "pl-2.5" : ""
        } ${props.error ? "border-danger" : "border-input"} ${props.disabled ? "bg-transparent opacity-50" : ""}`}
        focusWithinStyle={props.error ? undefined : FIELD_FOCUS}
        style={{ transitionProperty: "colors, box-shadow", transitionDuration: 200, transitionTimingFunction: "ease-in-out" }}
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
          } text-foreground placeholder:text-placeholder caret-blue selection:bg-[#426f9e38] ${props.mono ? "font-mono" : ""} ${
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
            accessibilityLabel="Clear"
            testID={props.testID ? `${props.testID}-clear` : undefined}
            class="group mr-[5px] items-center justify-center rounded-(--radius) transition-colors duration-180 hover:bg-hover active:bg-press"
            style={{ width: CLEAR_SIZES[props.size ?? "md"], height: CLEAR_SIZES[props.size ?? "md"] }}
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
      trackClass="h-5 w-[34px] rounded-(--radius) border border-line p-[2px] transition duration-180 group-hover:border-muted-foreground checked:border-ink checked:bg-ink"
      thumbClass="size-3.5 rounded-[1px] bg-card checked:translate-x-3.5"
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
      indicator={<Icon name="PhCheck" size={12} color="primary-foreground" />}
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
    `${height()} flex-row items-center justify-between gap-2 rounded-(--radius) border bg-field ${
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
  const plain = () => (
    <Menu
      placement="bottom"
      // .q-menu is the field's width and at least 220pt, overflowing to the left: its right
      // edge is the field's.
      align="end"
      offset={8}
      onOpenChange={({ open: next }) => open.set(next)}
      popupClass={`${MENU_POPUP} max-h-80`}
      popupStyle={bottomSheetStyle(8, { style: { ...MENU_POPUP_STYLE, minWidth: Math.max(220, triggerWidth()) }, contentMax: 320 })}
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
      {/* nsh's Menu does not scroll: its rows past max-h-80 would run off the popup, and off the
          sheet into the bottom inset on touch screens. */}
      <Scroll class="shrink">
      <Each of={props.items} key={(item) => item.value}>
        {(item) => (
          <MenuItem
            disabled={item().disabled}
            checked={item().value === props.value}
            indicator={<View />}
            indicatorClass="hidden"
            onSelect={() => props.onChange?.(item().value)}
            class="px-4 py-2.5 hover:bg-hover focus:bg-hover disabled:opacity-50"
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
        disabled={props.disabled}
        searchable={props.searchable}
        accessibilityLabel={props.label || props.placeholder}
        onChange={({ value }) => value !== null && props.onChange?.(value)}
        onOpenChange={({ open: next }) => open.set(next)}
        testID={props.testID}
        class={`${height()} flex-row items-center justify-between gap-2 rounded-(--radius) border border-input bg-field ${
          props.size === "xs" ? "pl-[9.6px]" : "pl-[12.8px]"
        } pr-2 transition-colors duration-180 aria-expanded:border-ring disabled:opacity-50`}
        placement="bottom"
        align="start"
        offset={4}
        popupClass={MENU_POPUP}
        popupStyle={bottomSheetStyle(8, { style: MENU_POPUP_STYLE })}
        itemClass="px-4 py-2 text-sm text-foreground hover:bg-hover focus:bg-hover selected:bg-selection"
        searchClass="mx-2 mb-1 rounded-(--radius) border border-input px-2 py-1 text-sm"
        trigger={
          <View class="flex-1 flex-row items-center justify-between gap-2">
            <Text class={`flex-1 ${props.size === "xs" ? "text-xs" : "text-sm"} ${current() ? "text-foreground" : "text-placeholder"} line-clamp-1`}>
              {current()?.label ?? props.placeholder ?? ""}
            </Text>
            <Icon name="PhCaretDown" size={14} color="muted-foreground" class="opacity-50" />
          </View>
        }
      />
      </If>
      <If when={props.hint}>
        <Text class="text-xs text-muted-foreground">{props.hint}</Text>
      </If>
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
export const MENU_POPUP =
  "min-w-55 rounded-(--radius) border border-line-faint bg-dialog py-2 transition duration-120";
export const MENU_POPUP_STYLE = {
  boxShadow: "inset 0 1px 0 rgba(255, 255, 255, 0.85), 0 10px 24px rgba(24, 46, 72, 0.12)",
  transitionTimingFunction: MOTION_EASE_CSS,
} as const;
export const MENU_STARTING = "opacity-0 -translate-y-1";

/**
 * A dropdown's `popupStyle` on touch screens, where nsh/base's `Menu`, `Select` and `DatePicker`
 * are sheets at the bottom of the screen: `style` with the room for the navigation bar or gesture
 * handle under its last row (`bottomSheetInsets`, lib/systemInsets.ts). `padding` is the bottom
 * padding its `popupClass` gives (`py-2`: 8), `contentMax` its `max-h-*` in points, if any;
 * `keyboard` the keyboard's height for a sheet that rises above it. The desktops' popups, and
 * sheets with no inset to clear, keep `style` as it is. Read it in a binding: it follows the insets.
 */
export function bottomSheetStyle<S extends object>(
  padding: number,
  options: { style?: S; contentMax?: number; keyboard?: number } = {},
): (S & Partial<{ paddingBottom: number; maxHeight: number }>) | S | undefined {
  if (platform.desktop) return options.style;
  const insets = bottomSheetInsets(safeArea(), options.keyboard ?? 0, windowSize().height, padding, options.contentMax);
  return insets ? { ...(options.style ?? ({} as S)), ...insets } : options.style;
}

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
  class?: string;
}) {
  const shown = signal(false);
  trackPopup(() => (props.open ?? shown()) && !props.disabled);
  return (
    <If when={!props.disabled} else={<View class="opacity-45">{props.trigger}</View>}>
    <Menu
      trigger={props.trigger}
      placement={props.placement ?? "bottom"}
      align={props.align ?? "end"}
      open={props.open}
      onOpenChange={({ open }) => {
        shown.set(open);
        props.onOpenChange?.(open);
      }}
      popupClass={`${MENU_POPUP} ${props.class ?? ""}`}
      popupStyle={bottomSheetStyle(8, { style: MENU_POPUP_STYLE })}
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
              class="flex-row items-center gap-2.5 px-4 py-2 hover:bg-hover focus:bg-hover disabled:opacity-50"
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
      class="size-8 items-center justify-center rounded-(--radius) hover:bg-hover active:bg-press aria-expanded:bg-hover"
      style={{ transitionProperty: "colors", transitionDuration: 180, transitionTimingFunction: "ease-out" }}
    >
      <Icon name={props.icon ?? "PhDotsThree"} size={16} color="subtle" />
    </View>
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
      class={`rounded-(--radius) border border-line-faint bg-card ${props.onPress ? "active:bg-hover" : ""} ${props.class ?? ""}`}
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
      class={`gap-3 ${props.variant === "card" ? "rounded-(--radius) border border-line-faint bg-card p-4" : ""} ${
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
          ? "rounded-(--radius) border border-line-soft bg-paper-soft"
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
          backgroundImage: "linear-gradient(90deg, transparent, #426f9e 45%, #426f9e 55%, transparent)",
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

/**
 * Tabs (design/ui-refresh.html §1): the options in quiet text on a hairline, the current one in ink
 * with the hairline dipping softly under it; the dip glides to the next option when it changes.
 * `equal` gives every option the same share of the row; an item's `icon` shows before its label
 * (`iconOnly` hides labels, keeping them as tooltips).
 */
export function Tabs(props: {
  items: { id: string; label: string; count?: number; disabled?: boolean; icon?: IconName }[];
  value: string;
  onChange?: (id: string) => void;
  equal?: boolean;
  iconOnly?: boolean;
  /** Tight options and 12pt labels (AppTabs under 380pt); on by itself in windows narrower than 380pt. */
  narrow?: boolean;
  accessibilityLabel?: string;
  class?: string;
  /** Each option's frame in the control, as `onLayout` reports it (to measure the options). */
  onItemLayout?: (id: string, event: { bounds: Bounds }) => void;
}) {
  const narrow = () => props.narrow ?? windowSize().width < 380;
  // Each option's place along the row, for the dip under the current one.
  const boxes = signal<Record<string, { x: number; w: number }>>({});
  const track = (id: string) => (event: { bounds: { origin: { x: number }; size: { width: number } } }) => {
    const box = { x: event.bounds.origin.x, w: event.bounds.size.width };
    const old = boxes()[id];
    if (!old || old.x !== box.x || old.w !== box.w) boxes.set({ ...boxes(), [id]: box });
  };
  const current = () => boxes()[props.value] ?? null;
  return (
    <View
      class={`relative flex-row items-center self-start ${props.equal ? "self-stretch" : ""} ${props.class ?? ""}`}
      role="tablist"
      accessibilityLabel={props.accessibilityLabel}
    >
      <Each of={props.items} key={(item) => item.id}>
        {(item) => (
          <TipButton
            role="tab"
            selected={props.value === item().id}
            disabled={item().disabled}
            onPress={() => props.onChange?.(item().id)}
            onLayout={(event: { bounds: Bounds }) => {
              track(item().id)(event);
              props.onItemLayout?.(item().id, event);
            }}
            accessibilityLabel={item().label}
            tooltip={props.iconOnly && item().icon ? <Tip text={item().label} /> : undefined}
            class={`group h-9 flex-row items-center justify-center gap-1.5 ${
              props.iconOnly && item().icon ? "w-9" : narrow() ? "px-2" : "px-3"
            } ${props.equal ? "flex-1" : ""} disabled:opacity-50`}
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
          </TipButton>
        )}
      </Each>
      <SagRule
        center={() => (current() ? current()!.x + current()!.w / 2 : null)}
        half={sagHalf(Math.min(current()?.w ?? 38, 64))}
        color={String(token("line-soft"))}
        class="absolute -bottom-[6px] left-0 right-0 h-[7px]"
      />
    </View>
  );
}

/* ---------- dialogs ---------- */

// The ui-kit's dialog (AppDialog / AppDialogShell, the morph theme): white on a hairline with 2pt
// corners over a light scrim; a 44pt header with the title and a square red-tinted close button.
// On phones (< 720pt) it is a sheet: full width at the bottom.
//
// Motion (styles/base.css, core/dialog-origin.js): it settles in from 98 % as it fades, and when a
// press opened it (within 900 ms) it grows out of that point from 90 % instead, and goes back into
// it on close. A sheet slides up from the bottom edge instead, and back down on close. The backdrop
// and the panel are drawn here (the base Dialog is only the layer), so both can move, natively, on
// opacity and transform alone; the panel stays drawn until it is out.
const DIALOG_SHADOW = "0 12px 24px rgba(20, 24, 32, 0.14)";

/** Below this window width a dialog is a sheet at the bottom of the screen. */
export const DIALOG_SHEET_WIDTH = 720;

/** Whether dialogs are sheets at the bottom of the screen (phones, narrow windows). Reactive. */
export function dialogIsSheet() {
  return windowSize().width < DIALOG_SHEET_WIDTH;
}

/**
 * The room a sheet keeps under its last row (the navigation bar's or gesture handle's inset, or
 * the keyboard's height while it is up; lib/systemInsets.ts `dialogSheetInsets`), 0 for a dialog
 * that is not a sheet. A dialog whose last strip is painted a colour of its own (SettingDialog's
 * footer) takes it there, with `DialogLayer`'s `bottomInset="content"`. Reactive.
 */
export function dialogSheetClearance() {
  return dialogIsSheet() ? (dialogSheetInsets(safeArea(), keyboardFrame().height, windowSize().height)?.clear ?? 0) : 0;
}

/** What a test reads of a dialog's panel: its frame in the layer, and its motion. */
export interface DialogProbe {
  layout?: (bounds: Bounds) => void;
  motion?: (motion: Motion) => void;
}

/** The dialog layer under `Modal` and `MessageDialog` (scrim, panel, the motion from the pressing control): for a dialog with a panel of its own. */
/** Android draws dialogs in an Overlay, not nsh's Dialog window (see DialogLayer). */
const OVERLAY_DIALOGS = platform.os === "android";

export function DialogLayer(props: {
  open: boolean;
  onClose: () => void;
  testID?: string;
  /** The panel's classes (width, padding, gap). */
  panelClass: string;
  panelStyle?: { maxWidth?: number };
  /** The panel classes' own bottom padding in points (MessageDialog's pb-4: 16): a sheet keeps it above the room it takes under its last row. */
  panelPaddingBottom?: number;
  /** On a sheet, who fills the room under the last row: the panel (default), or its last strip, painted a colour of its own, which pads itself by `dialogSheetClearance()`. */
  bottomInset?: "panel" | "content";
  label?: string;
  /** For tests: the panel's frame and motion. */
  probe?: DialogProbe;
  children?: JSX.Element;
}) {
  const shown = signal(untracked(() => props.open));
  trackPopup(() => props.open);
  const panel = createMotion({ initial: { opacity: 0 } });
  props.probe?.motion?.(panel);
  const scrim = createAnimatedValue(0);
  const origin = signal<[number, number] | null>(null);
  let press: { x: number; y: number } | null = null;
  let pendingEnter = false;
  let closing = false;
  // Whether the sheet came in from out of sight (a first opening, or after it went out): it slides
  // in from its own height below the bottom edge; reopened while going out, from where it is.
  let fromBelow = true;
  const narrow = dialogIsSheet;
  // A sheet slides the whole way in and out: a little longer than a dialog's settle.
  const duration = (sheet: boolean) => motionMs(sheet ? MOTION_SLOW : MOTION_NORMAL);

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
      const height = bounds?.size.height ?? panelBox?.size.height ?? untracked(() => windowSize().height);
      if (ms <= 0) {
        panel.translateY.set(0);
        return;
      }
      if (fromBelow) panel.translateY.set(height);
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
          // Out of sight below the bottom edge until its first layout says how tall it is; reopened
          // while going out, it turns back from where it is.
          if (fromBelow) {
            panel.opacity.set(1);
            panel.translateY.set(windowSize().height);
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
        const ms = duration(sheet);
        if (ms <= 0) {
          shown.set(false);
          return;
        }
        void scrim.timing(0, { duration: ms, easing: MOTION_EASE });
        // The panel stays drawn (and its contents mounted) while it goes out.
        const out = sheet
          ? panel.translateY.timing(panelBox?.size.height ?? windowSize().height, { duration: ms, easing: MOTION_EASE })
          : panel.play({
              duration: ms,
              keyframes: { opacity: [{ value: 1, easing: MOTION_EASE }, 0], scale: [{ value: 1, easing: MOTION_EASE }, origin() ? 0.9 : 0.98] },
            });
        void out.then(() => {
          if (closing) shown.set(false);
        });
      }
    });
  });

  // A sheet's bottom: the room under its last row, inside its paper (lib/systemInsets.ts).
  const sheetInsets = () =>
    narrow() ? dialogSheetInsets(safeArea(), keyboardFrame().height, windowSize().height) : undefined;
  const panelInsetStyle = () => {
    const insets = sheetInsets();
    if (!insets) return {};
    const own = props.bottomInset === "content" ? {} : { paddingBottom: (props.panelPaddingBottom ?? 0) + insets.clear };
    return { ...own, maxHeight: insets.maxHeight };
  };

  // The panel's frame in the layer, which the scrim covers from its origin.
  let panelBox: { origin: { x: number; y: number }; size: { width: number; height: number } } | null = null;
  // The scrim and the panel, in whichever layer holds them.
  const layer = () => [
    <View
      accessibilityElementsHidden
      class="absolute inset-0 bg-dialog-scrim"
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
        props.probe?.layout?.(event.bounds);
        enter(event.bounds);
      }}
      class={`max-h-[90%] border border-dialog-line bg-dialog ${narrow() ? "w-full" : "rounded-(--radius)"} ${props.panelClass}`}
      style={{ ...(props.panelStyle ?? {}), ...panelInsetStyle(), boxShadow: DIALOG_SHADOW, transformOrigin: origin() ?? "center", ...panel.style }}
    >
      {props.children}
    </View>,
  ];
  const layerClass = () =>
    `absolute inset-0 items-center ${narrow() ? "justify-end" : `justify-center ${OVERLAY_DIALOGS ? "" : "p-4"}`}`;
  // On phones the panel is a sheet at the bottom, and it takes the room under its last row itself
  // (the navigation bar or gesture handle, or the software keyboard, which the layer does not
  // shrink for): its paper reaches the bottom edge and fills that room. A number, not
  // `env(keyboard-inset-height)`: the env value moves the sheet natively but not in nsh's layout,
  // where presses are matched. Android's Overlay covers the whole surface, status and navigation
  // bars included, so there the layer keeps the panel out from under the status bar and the side
  // insets (lib/systemInsets.ts), and wide windows keep it inside every inset, with a 16pt margin.
  const layerStyle = () => {
    if (!OVERLAY_DIALOGS) return undefined;
    const insets = dialogLayerInsets(safeArea(), 0, narrow() ? 0 : 16);
    return { paddingTop: insets.top, paddingRight: insets.right, paddingBottom: narrow() ? 0 : insets.bottom, paddingLeft: insets.left };
  };

  return (
    // Android: nsh 0.4.0's Dialog is a window of its own below the status bar, and presses in it
    // land one status bar higher than what is drawn (a press on a footer button hits the row above
    // it), so the layer is an Overlay over the app's own view there; Back still asks (onCancel).
    <If
      when={OVERLAY_DIALOGS}
      else={
        <Dialog
          open={shown()}
          // Escape and back would close the layer at once, under the closing motion: they only ask
          // (onCancel), and the panel goes out as a press on the scrim or the close button makes it.
          closeOnEscape={false}
          closeOnSwipe={false}
          onCancel={() => props.onClose()}
          onOpenChange={({ open }) => {
            if (!open) props.onClose();
          }}
          testID={props.testID}
          animation="none"
          class={layerClass()}
          style={layerStyle()}
        >
          {layer()}
        </Dialog>
      }
    >
      <If when={shown()}>
        <Overlay onCancel={() => props.onClose()} testID={props.testID} class={layerClass()} style={layerStyle()}>
          {layer()}
        </Overlay>
      </If>
    </If>
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
        <If when={props.headerActions}>
          <View class="flex-row items-center gap-1 pr-1">{props.headerActions}</View>
        </If>
        <TipButton
          onPress={props.onClose}
          accessibilityLabel={props.closeLabel ?? "Close"}
          tooltip={<Tip text={props.closeLabel ?? "Close"} />}
          testID={props.testID ? `${props.testID}-close` : undefined}
          class="w-11 items-center justify-center bg-close transition-colors duration-180 hover:bg-close-hover focus:bg-close-hover"
        >
          <Icon name="PhX" size={14} color="danger" />
        </TipButton>
      </View>
      <If when={props.scroll !== false} else={<View class="flex-1 p-4">{props.children}</View>}>
        <EdgeScroll class="shrink" contentClass="p-4 gap-3">
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
      panelPaddingBottom={16}
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
  children?: JSX.Element;
  bodyClass?: string;
  testID?: string;
}) {
  usePageError(() => props.error ?? "");
  return (
    <View class="flex-1" testID={props.testID}>
      <If when={!props.hideBar}>
        <PageBar title={props.title} leading={props.leading} actions={props.actions} />
      </If>
      <If when={props.scroll !== false} else={<View class={`flex-1 ${props.bodyClass ?? ""}`}>{props.children}</View>}>
        <EdgeScroll class="flex-1" start={false}>
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

/** A page's bar alone (AppPage.css `.page-bar`), for pages that lay out their own body. */
export function PageBar(props: { title?: string; leading?: JSX.Element; actions?: JSX.Element; class?: string }) {
  return (
    <View
      class={`flex-row items-center gap-2 border-b border-line-soft py-2 ${props.class ?? ""}`}
      style={{ height: CHROME_BAR_HEIGHT, paddingHorizontal: gutterX() }}
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
 * The size of a phone bar's icon buttons: Todo's calendar toggle and every back arrow. The
 * Button's default, a 38pt square with a 16pt icon.
 */
export const BAR_BUTTON_SIZE: ButtonSize = "sm";

/**
 * A page bar's back arrow: a plain icon-only Button. On a phone it is the size of the bar's other
 * icon buttons (BAR_BUTTON_SIZE, as Todo's calendar toggle); a bar that also shows on wide windows
 * keeps its `desktopSize` there. Like the calendar toggle it sits in a wrapper that the bar's row
 * centres. `title` is its tooltip and accessible name.
 */
export function BackButton(props: {
  title: string;
  onPress: () => void;
  testID?: string;
  desktopSize?: ButtonSize;
  /** Hears its frame on the page as `back` (tests). */
  onPartLayout?: PartLayoutListener;
}) {
  const parts = createPartProbe(() => props.onPartLayout);
  return (
    <View {...parts.probe(() => "back")}>
      <Button
        variant="plain"
        size={isMobile() ? BAR_BUTTON_SIZE : (props.desktopSize ?? BAR_BUTTON_SIZE)}
        iconOnly
        icon="PhArrowLeft"
        title={props.title}
        testID={props.testID}
        onPress={() => props.onPress()}
      />
    </View>
  );
}

/* ---------- side pane and floating action ---------- */

/**
 * The panel at the right of a list that edits or inspects one of its items (the Vue console's
 * AppSidePane). On wide windows it is a column beside the list: put it last in a `flex-row`.
 * With `sheet` (phones) it is a drawer from the right over a scrim. Escape closes it.
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
      >
        {props.children}
      </Sheet>
    </If>
  );
}

function SidePaneColumn(props: { onClose: () => void; label?: string; class?: string; children?: JSX.Element }) {
  keymap.bind("escape", () => props.onClose());
  return (
    <View accessibilityLabel={props.label} class={`w-96 border-l border-line-faint bg-card ${props.class ?? ""}`}>
      {props.children}
    </View>
  );
}

/**
 * The floating add button of a page (the Vue console's AppFab): a 52pt ink square at the bottom
 * right, with registration marks just outside two opposite corners (the console's drawing-sheet
 * frames). It rises 12pt into place as it fades in, and sinks 1pt while pressed.
 */
export function Fab(props: { label: string; icon?: IconName; disabled?: boolean; onPress?: () => void; testID?: string }) {
  const enter = createMotion({
    enter: {
      duration: MOTION_SLOW,
      keyframes: { opacity: [{ value: 0, easing: MOTION_EASE }, 1], translateY: [{ value: 12, easing: MOTION_EASE }, 0] },
    },
  });
  return (
    // Above the phone's floating bottom bar when it shows (its room less the gap under a list).
    <View class="absolute right-4" style={{ ...enter.style, bottom: mobileBarRoom() > 0 ? mobileBarRoom() - 4 : 16, pointerEvents: "box-none" }}>
      <View class="absolute -left-1.25 -top-1.25 size-2 border-l border-t border-muted-foreground" style={{ pointerEvents: "none" }} />
      <View class="absolute -bottom-1.25 -right-1.25 size-2 border-b border-r border-muted-foreground" style={{ pointerEvents: "none" }} />
      <TipButton
        onPress={() => props.onPress?.()}
        disabled={props.disabled}
        accessibilityLabel={props.label}
        testID={props.testID}
        tooltip={<Tip text={props.label} placement="left" />}
        class="size-13 items-center justify-center rounded-(--radius) border border-primary-line bg-primary transition duration-120 active:translate-y-px disabled:opacity-55"
        style={{ boxShadow: "0 6px 16px rgba(20, 29, 48, 0.2), 0 1px 3px rgba(20, 29, 48, 0.12)", transitionTimingFunction: MOTION_EASE_CSS }}
        activeStyle={{ boxShadow: "0 2px 6px rgba(20, 29, 48, 0.18)" }}
      >
        <Icon name={props.icon ?? "PhPlus"} size={22} color="primary-foreground" />
      </TipButton>
    </View>
  );
}
