// The console's capsules of icon controls: a pill of round slots that floats over a page (glass
// where the window draws it) or is set into a bar.
//
// - `CapsuleNav`: the phone's bottom navigation. Slots side by side, one of them current: a lighter
//   pill behind it slides to the next one, and its glyph fills and takes the primary colour. A slot
//   shows an icon, or a glyph of its own (a portrait).
// - `CapsuleToolbar` and `CapsuleButton`: a job's toolbar (its topic's foot, its page's bar or
//   foot). Buttons, not places: the first is the primary action (a white glyph on the primary
//   fill), a stop is as solid but red, the others quiet glyphs; a busy one runs the busy beam and
//   takes no press. Two sizes: the navigation's own (`nav`, 58pt capsule, 24pt glyphs) so a toolbar
//   and the navigation look alike at a page's foot, and `compact` (38pt, 16pt glyphs) for a bar.
//
// Every control's name is its accessible name and its tooltip; none draws text.
import type { JSX, token } from "nsh";
import { effect, untracked, View } from "nsh";
import { BAR_INSET, GlassCapsule, MOBILE_NAV_HEIGHT, mobileNavSlots, NAV_SLOT_MAX } from "../frame/mobileBar";
import { motionMs } from "../motion/tokens";
import type { IconName } from "../icons";
import { BusyBeam, busyLook, type ButtonVariant, Icon, Tip, TipButton } from "../ui";

type TokenName = Parameters<typeof token>[0];
type LayoutEvent = { bounds: { origin: { x: number; y: number }; size: { width: number; height: number } } };
export type CapsuleFrame = { x: number; y: number; w: number; h: number };

/* ---------- sizes ---------- */

/** A control's box and glyph, in points. */
export interface CapsuleSize {
  width: number;
  height: number;
  icon: number;
}
/** The navigation's slot: as tall as the capsule less its padding, as wide as a slot where there is room. */
export const CAPSULE_NAV_SIZE: CapsuleSize = { width: NAV_SLOT_MAX, height: MOBILE_NAV_HEIGHT - BAR_INSET * 2, icon: 24 };
/** A bar's: the capsule as tall as a bar's back button (38pt, its hairline included). */
export const CAPSULE_COMPACT_HEIGHT = 38;
export const CAPSULE_COMPACT_SIZE: CapsuleSize = { width: 38, height: 30, icon: 16 };
export const CAPSULE_COMPACT_INSET = (CAPSULE_COMPACT_HEIGHT - CAPSULE_COMPACT_SIZE.height) / 2 - 0.5;

/* ---------- the navigation ---------- */

export interface CapsuleNavSlot {
  id: string;
  /** Its accessible name and tooltip. */
  label: string;
  /** Its glyph, filled and in the primary colour while it is the current slot. */
  icon?: IconName;
  /** A glyph of its own in place of an icon (a portrait): nothing is added to it, pressed or current. */
  glyph?: () => JSX.Element;
  /** Its test id; its icon's is `<testID>-icon.<tint>`. */
  testID: string;
}

/**
 * The capsule of the phone's navigation: `slots` side by side, none reaching under its neighbour,
 * each NAV_SLOT_MAX wide where a strip `width` wide has room and narrower on a narrow phone; the
 * pill behind the `active` one (an id; null for none) slides to the next. `onSlotLayout` hears
 * each slot's frame in the row (by its test id) and the pill's (`highlight`, where its slide puts
 * it). It only draws and reports presses: what a slot opens is the caller's.
 */
export function CapsuleNav(props: {
  slots: CapsuleNavSlot[];
  active: string | null;
  onPress: (id: string) => void;
  /** The strip the capsule floats in, in points. */
  width: number;
  testID: string;
  style?: Record<string, unknown>;
  onSlotLayout?: (name: string, frame: CapsuleFrame) => void;
}) {
  const geometry = () => mobileNavSlots(props.width, props.slots.length);
  const activeIndex = () => props.slots.findIndex((slot) => slot.id === props.active);
  const height = MOBILE_NAV_HEIGHT - BAR_INSET * 2;
  // A selected slot's glyph is the primary buttons' colour, the others quiet.
  const tint = (selected: boolean): "primary" | "muted-foreground" => (selected ? "primary" : "muted-foreground");
  const report = (name: string) =>
    props.onSlotLayout
      ? ({ bounds }: LayoutEvent) => props.onSlotLayout?.(name, { x: bounds.origin.x, y: bounds.origin.y, w: bounds.size.width, h: bounds.size.height })
      : undefined;
  // Where the pill's slide puts it.
  effect(() => {
    const at = activeIndex();
    const { slot, left } = geometry();
    if (props.onSlotLayout && at >= 0) untracked(() => props.onSlotLayout?.("highlight", { x: left(at), y: 0, w: slot, h: height }));
  });
  return (
    // Glass where the window draws it (lib/glass.ts): the page shows through, blurred; else the
    // card's own fill, opaque (a tint alone left the page's text under the icons).
    <GlassCapsule testID={props.testID} style={props.style}>
      <View class="relative flex-row" style={{ width: geometry().rowWidth, height }}>
        <If when={activeIndex() >= 0}>
          <View
            accessibilityElementsHidden
            class="absolute bottom-0 left-0 top-0 rounded-full bg-blue/10"
            style={{
              width: geometry().slot,
              transform: [{ translateX: geometry().left(activeIndex()) }],
              transitionProperty: "transform",
              transitionDuration: motionMs(240),
              transitionTimingFunction: "cubic-bezier(0.2, 0.7, 0.2, 1)",
            }}
          />
        </If>
        <Each of={props.slots} key={(slot) => slot.id}>
          {(slot) => {
            const selected = () => props.active === slot().id;
            return (
              <TipButton
                selected={selected()}
                onPress={() => props.onPress(slot().id)}
                accessibilityLabel={slot().label}
                testID={slot().testID}
                tooltip={<Tip text={slot().label} />}
                class={`items-center justify-center rounded-full ${slot().glyph ? "" : "active:bg-hover-soft transition-colors duration-160"}`}
                style={{ width: geometry().slot }}
                onLayout={report(slot().testID)}
              >
                <If when={slot().glyph} else={<Icon name={slot().icon as IconName} size={24} filled={selected()} color={tint(selected())} testID={`${slot().testID}-icon.${tint(selected())}`} />}>
                  {slot().glyph!()}
                </If>
              </TipButton>
            );
          }}
        </Each>
      </View>
    </GlassCapsule>
  );
}

/* ---------- the toolbar ---------- */

/** How one of a toolbar's buttons looks in a state (also read by tests and the gallery). */
export interface CapsuleButtonLook {
  /** Which look, for test ids: `primary`, `danger`, `quiet`, `busy`, `disabled` (a caller may name its own). */
  look: string;
  glyph: IconName;
  filled: boolean;
  /** The button's own fill, hairline and hover/focus classes. */
  box: string;
  /** A layer over the fill, under the glyph (a danger button's red tint over its opaque card), or none. */
  tint?: string;
  /** The press layer's class. */
  press: string;
  /** The glyph's colour. */
  icon: TokenName;
  /** The busy beam's variant while busy. */
  beam: ButtonVariant;
}

/** A danger button's fill: the theme's danger at this share over the card, opaque (`bg-danger/12` over `bg-card`). */
export const CAPSULE_DANGER_TINT = 0.12;
/** The keyboard focus mark of each button (the console's Button draws none of its own). */
export const CAPSULE_FOCUS_RING = "group-focus-visible:border-blue-lighter";

/**
 * The look of a toolbar button of `variant` with `glyph`, while `busy` (its action is under way:
 * the beam runs and it takes no press) or `disabled`. `primary` is the primary button: a white
 * glyph on the primary fill. `danger` is as solid but red: a red glyph on an opaque pale-red fill
 * with a red hairline (red on the primary blue would be illegible). `quiet` is the navigation's
 * idle slot: a muted glyph on no fill, the hover fill under the pointer and the keyboard's focus.
 */
export function capsuleButtonLook(variant: "primary" | "danger" | "quiet", glyph: IconName, state: { busy?: boolean; disabled?: boolean } = {}): CapsuleButtonLook {
  if (variant === "quiet") {
    return {
      look: state.disabled ? "disabled" : "quiet",
      glyph,
      filled: false,
      box: "hover:bg-hover focus:bg-hover disabled:bg-transparent",
      press: "group-active:bg-press",
      icon: state.disabled ? "plain-disabled-text" : "muted-foreground",
      beam: "plain",
    };
  }
  if (variant === "danger") {
    return {
      look: state.busy ? "busy" : state.disabled ? "disabled" : "danger",
      glyph,
      filled: true,
      // While busy or disabled the fill stays (the beam rides the hairline); the glyph pales when it cannot act.
      box: `bg-card border-[0.5px] ${state.disabled && !state.busy ? "border-danger-disabled-line" : "border-danger/35"}`,
      tint: `bg-danger/12 ${state.disabled || state.busy ? "" : "group-hover:bg-danger/18 group-focus:bg-danger/18"}`,
      press: "group-active:bg-press",
      icon: state.disabled && !state.busy ? "danger-disabled-text" : "danger",
      beam: "danger",
    };
  }
  if (state.busy) {
    // As the console's primary Button while loading: its soft blue tint, ink glyph and blue beam.
    const busy = busyLook("primary");
    return { look: "busy", glyph, filled: true, box: busy.box, press: "", icon: busy.text, beam: "primary" };
  }
  return {
    look: state.disabled ? "disabled" : "primary",
    glyph,
    filled: true,
    box: state.disabled
      ? "bg-primary-disabled border-[0.5px] border-primary-disabled-line"
      : "bg-primary border-[0.5px] border-primary-line hover:bg-primary-hover focus:bg-primary-hover",
    press: "group-active:bg-press-light",
    icon: state.disabled ? "on-disabled" : "primary-foreground",
    beam: "primary",
  };
}

/** One of a toolbar's icon buttons, its name read out and shown as its tooltip. */
export function CapsuleButton(props: {
  look: CapsuleButtonLook;
  label: string;
  busy?: boolean;
  disabled?: boolean;
  onPress?: () => void;
  testID: string;
  /** Its box and glyph; the navigation's slot when not given. */
  size?: CapsuleSize;
  onLayout?: (event: LayoutEvent) => void;
  onIconLayout?: (event: LayoutEvent) => void;
}) {
  const size = () => props.size ?? CAPSULE_NAV_SIZE;
  const enabled = () => !props.disabled && !props.busy;
  return (
    <TipButton
      disabled={!enabled()}
      onPress={() => enabled() && props.onPress?.()}
      accessibilityLabel={props.label}
      tooltip={<Tip text={props.label} />}
      testID={props.testID}
      onLayout={props.onLayout}
      class={`group relative items-center justify-center overflow-hidden rounded-full border-transparent transition-colors duration-160 ${props.look.box}`}
      style={{ width: size().width, height: size().height }}
    >
      <If when={props.look.tint}>
        <View accessibilityElementsHidden class={`absolute inset-0 transition-colors duration-160 ${props.look.tint}`} style={{ pointerEvents: "none" }} />
      </If>
      <View accessibilityElementsHidden class={`absolute inset-0 transition-colors duration-100 ease-out ${props.look.press}`} style={{ pointerEvents: "none" }} />
      {/* The keyboard's focus: a ring inside the pill, plain on the primary fill as on the others. */}
      <View
        accessibilityElementsHidden
        class={`absolute inset-0 rounded-full border-2 border-transparent ${CAPSULE_FOCUS_RING}`}
        style={{ pointerEvents: "none" }}
        testID={`${props.testID}-focus-ring`}
      />
      {/* The glyph's test id names what it draws (headless tests have no image or style query). */}
      <Icon
        name={props.look.glyph}
        filled={props.look.filled}
        size={size().icon}
        color={props.look.icon}
        testID={`${props.testID}-icon.${props.look.glyph}.${props.look.look}.${props.look.icon}`}
        onLayout={props.onIconLayout}
      />
      <BusyBeam busy={!!props.busy} variant={props.look.beam} radius={size().height / 2} testID={`${props.testID}-loading`} />
    </TipButton>
  );
}

/** The size of a toolbar's controls: the navigation's, or the compact one. */
export const capsuleToolbarSize = (compact: boolean): CapsuleSize => (compact ? CAPSULE_COMPACT_SIZE : CAPSULE_NAV_SIZE);
/** A toolbar's padding, and the room between its buttons. */
export const capsuleToolbarInset = (compact: boolean) => (compact ? CAPSULE_COMPACT_INSET : BAR_INSET);

/**
 * A toolbar's capsule round its buttons, the capsule's padding between them as round them.
 * `floating`: over a page (its foot, a conversation's foot), the navigation's capsule: glass, with
 * its shadow. Else it is set into a bar or a page, with no shadow (a shadow says "floats").
 * `compact`: 38pt tall, for a bar or a desktop; else the navigation's own height. Give its
 * buttons `capsuleToolbarSize(compact)`.
 */
export function CapsuleToolbar(props: {
  label: string;
  floating?: boolean;
  compact?: boolean;
  testID: string;
  onLayout?: (event: LayoutEvent) => void;
  onRowLayout?: (event: LayoutEvent) => void;
  children?: JSX.Element;
}) {
  const inset = () => capsuleToolbarInset(!!props.compact);
  return (
    <If
      when={props.floating}
      else={
        <View
          role="toolbar"
          accessibilityLabel={props.label}
          class="flex-row items-center rounded-full border-[0.5px] border-line bg-card"
          style={{ padding: inset(), gap: inset() }}
          testID={props.testID}
          onLayout={props.onLayout}
        >
          {props.children}
        </View>
      }
    >
      <GlassCapsule testID={props.testID} role="toolbar" accessibilityLabel={props.label} style={{ padding: inset() }} onLayout={props.onLayout}>
        <View class="flex-row items-center" style={{ gap: inset(), height: capsuleToolbarSize(!!props.compact).height }} onLayout={props.onRowLayout}>
          {props.children}
        </View>
      </GlassCapsule>
    </If>
  );
}
