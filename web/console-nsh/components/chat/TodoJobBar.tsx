// A TODO topic's toolbar, at the foot of the conversation where a person's topic has its composer:
// the bottom navigation's glass capsule (GlassCapsule), centred, with two icon buttons in the
// navigation's slots (as tall, as wide, its 24pt glyphs). The first is the primary control: it
// starts one run of the item now (a white Play on the primary fill), and is Stop while the runtime
// runs it (a red Stop square on a solid pale-red fill; it stops that run, not the schedule). View
// Job, a quiet glyph as the navigation's, opens the item on the TODO page. Each button's name is its
// accessible name and its tooltip; neither draws text. A failure and a gone item are said above the
// capsule, never inside it, and the capsule always holds the same two buttons (disabled while they
// cannot act). The state is the chat's (components/chat/todoJob.ts); the props here are plain values
// so the gallery can show each state.
import { Text, type token, View } from "nsh";
import { BusyBeam, busyLook, type ButtonVariant, Icon, Tip, TipButton } from "../ui";
import type { IconName } from "../icons";
import { BAR_BELOW, BAR_INSET, GlassCapsule, MOBILE_NAV_HEIGHT, NAV_SLOT_MAX } from "../frame/mobileBar";
import { t } from "./i18n";

/** A button's height: the navigation's slot, so the capsule's padding is the same on every side. */
export const TODO_JOB_BUTTON_HEIGHT = MOBILE_NAV_HEIGHT - BAR_INSET * 2;
/** A button's width: the navigation's slot where it has room. */
export const TODO_JOB_BUTTON_WIDTH = NAV_SLOT_MAX;
/** The room between the two buttons: the capsule's padding, so every gap round them is the same. */
export const TODO_JOB_BUTTON_GAP = BAR_INSET;
/** The glyphs' size: the navigation's. */
export const TODO_JOB_ICON_SIZE = 24;
/** Stop's fill: the theme's danger at this share over the card, opaque (`bg-danger/12` over `bg-card`). */
export const TODO_JOB_STOP_TINT = 0.12;

type TokenName = Parameters<typeof token>[0];

/** The keyboard focus mark of each button (the console's Button draws none of its own). */
export const TODO_JOB_FOCUS_RING = "group-focus-visible:border-blue-lighter";

/** `topic`: the job's topic, the mirror of View Job on the job's own page (TodoTaskEditor). */
export type TodoJobButtonKind = "start" | "stop" | "view" | "topic";

/** How one of the toolbar's buttons looks in a state (also read by tests and the gallery). */
export interface TodoJobButtonLook {
  /** Which look, for test ids: `primary` (Start), `stop`, `quiet` (View Job), `busy`, `disabled`. */
  look: "primary" | "stop" | "quiet" | "busy" | "disabled";
  glyph: IconName;
  filled: boolean;
  /** The button's own fill, hairline and hover/focus classes. */
  box: string;
  /** A layer over the fill, under the glyph (Stop's red tint over its opaque card), or none. */
  tint?: string;
  /** The press layer's class. */
  press: string;
  /** The glyph's colour. */
  icon: TokenName;
  /** The busy beam's variant while busy. */
  beam: ButtonVariant;
}

/**
 * The look of `kind` (`start`, `stop`, `view`) while `busy` (its action is under way: the beam runs
 * and it takes no press) or `disabled`. Start is the primary button: white Play on the primary
 * fill. Stop is as solid but red: a red Stop square on an opaque pale-red fill with a red hairline
 * (red on the primary blue would be illegible). View Job is the navigation's idle slot: a muted
 * glyph on no fill, the hover fill under the pointer and the keyboard's focus.
 */
export function todoJobButtonLook(kind: TodoJobButtonKind, state: { busy?: boolean; disabled?: boolean } = {}): TodoJobButtonLook {
  if (kind === "view" || kind === "topic") {
    return {
      look: state.disabled ? "disabled" : "quiet",
      glyph: kind === "topic" ? "PhChat" : "PhListChecks",
      filled: false,
      box: "hover:bg-hover focus:bg-hover disabled:bg-transparent",
      press: "group-active:bg-press",
      icon: state.disabled ? "plain-disabled-text" : "muted-foreground",
      beam: "plain",
    };
  }
  if (kind === "stop") {
    return {
      look: state.busy ? "busy" : state.disabled ? "disabled" : "stop",
      glyph: "PhStop",
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
    return { look: "busy", glyph: "PhPlay", filled: true, box: busy.box, press: "", icon: busy.text, beam: "primary" };
  }
  return {
    look: state.disabled ? "disabled" : "primary",
    glyph: "PhPlay",
    filled: true,
    box: state.disabled
      ? "bg-primary-disabled border-[0.5px] border-primary-disabled-line"
      : "bg-primary border-[0.5px] border-primary-line hover:bg-primary-hover focus:bg-primary-hover",
    press: "group-active:bg-press-light",
    icon: state.disabled ? "on-disabled" : "primary-foreground",
    beam: "primary",
  };
}

type LayoutEvent = { bounds: { origin: { x: number; y: number }; size: { width: number; height: number } } };

/** One of the toolbar's icon buttons: a navigation slot, its name read out and shown as its tooltip. */
export function TodoJobButton(props: {
  kind: TodoJobButtonKind;
  label: string;
  busy?: boolean;
  disabled?: boolean;
  onPress?: () => void;
  testID: string;
  onLayout?: (event: LayoutEvent) => void;
  onIconLayout?: (event: LayoutEvent) => void;
}) {
  const look = () => todoJobButtonLook(props.kind, { busy: props.busy, disabled: props.disabled });
  const enabled = () => !props.disabled && !props.busy;
  return (
    <TipButton
      disabled={!enabled()}
      onPress={() => enabled() && props.onPress?.()}
      accessibilityLabel={props.label}
      tooltip={<Tip text={props.label} />}
      testID={props.testID}
      onLayout={props.onLayout}
      class={`group relative items-center justify-center overflow-hidden rounded-full border-transparent transition-colors duration-160 ${look().box}`}
      style={{ width: TODO_JOB_BUTTON_WIDTH, height: TODO_JOB_BUTTON_HEIGHT }}
    >
      <If when={look().tint}>
        <View accessibilityElementsHidden class={`absolute inset-0 transition-colors duration-160 ${look().tint}`} style={{ pointerEvents: "none" }} />
      </If>
      <View
        accessibilityElementsHidden
        class={`absolute inset-0 transition-colors duration-100 ease-out ${look().press}`}
        style={{ pointerEvents: "none" }}
      />
      {/* The keyboard's focus: a ring inside the pill, plain on the primary fill as on the others. */}
      <View
        accessibilityElementsHidden
        class={`absolute inset-0 rounded-full border-2 border-transparent ${TODO_JOB_FOCUS_RING}`}
        style={{ pointerEvents: "none" }}
        testID={`${props.testID}-focus-ring`}
      />
      {/* The glyph's test id names what it draws (headless tests have no image or style query). */}
      <Icon
        name={look().glyph}
        filled={look().filled}
        size={TODO_JOB_ICON_SIZE}
        color={look().icon}
        testID={`${props.testID}-icon.${look().glyph}.${look().look}.${look().icon}`}
        onLayout={props.onIconLayout}
      />
      <BusyBeam busy={!!props.busy} variant={look().beam} radius={TODO_JOB_BUTTON_HEIGHT / 2} testID={`${props.testID}-loading`} />
    </TipButton>
  );
}

export interface TodoJobBarProps {
  /** The runtime runs the item now: the first button is Stop. */
  running: boolean;
  /** Start or Stop is on its way (or the run is winding down): the first button is busy. */
  busy?: boolean;
  /** The first button can act now (Start on an idle item, Stop on a running one). */
  toggleEnabled: boolean;
  /** View Job can open the item. */
  viewEnabled: boolean;
  /** A quiet line above the capsule (the item is gone). */
  note?: string;
  /** What failed, above the capsule, read out as it appears. */
  error?: string;
  onStart?: () => void;
  onStop?: () => void;
  onView?: () => void;
  /** Hears the frames of the capsule (`capsule`, in its parent), its row (`row`, in the capsule), the
   * buttons (`toggle`, `view`, in the row) and their glyphs (`toggle-icon`, `view-icon`, in the
   * button), as they lay out (layout checks in tests). */
  onPartLayout?: (name: string, frame: { x: number; y: number; w: number; h: number }) => void;
}

export function TodoJobBar(props: TodoJobBarProps) {
  const report = (name: string) =>
    props.onPartLayout
      ? ({ bounds }: LayoutEvent) =>
          props.onPartLayout?.(name, { x: bounds.origin.x, y: bounds.origin.y, w: bounds.size.width, h: bounds.size.height })
      : undefined;
  return (
    // The capsule sits as far above the foot as the navigation's does, and is as tall.
    <View class="w-full items-center gap-2 pt-2" style={{ pointerEvents: "box-none", paddingBottom: BAR_BELOW }} testID="chat-todo-job">
      <If when={props.error}>
        <Text role="alert" class="max-w-full px-2 text-center text-sm text-danger" testID="chat-todo-job-error">
          {props.error}
        </Text>
      </If>
      <If when={props.note}>
        <Text class="max-w-full px-2 text-center text-sm text-muted-foreground" testID="chat-todo-job-note">
          {props.note}
        </Text>
      </If>
      <GlassCapsule testID="chat-todo-job-bar" role="toolbar" accessibilityLabel={t("chat_todo_job_toolbar")} onLayout={report("capsule")}>
        {/* The navigation's slots, the capsule's padding between them as round them. */}
        <View class="flex-row items-center" style={{ gap: TODO_JOB_BUTTON_GAP, height: TODO_JOB_BUTTON_HEIGHT }} onLayout={report("row")}>
          <TodoJobButton
            kind={props.running ? "stop" : "start"}
            label={props.running ? t("chat_todo_job_stop") : t("chat_todo_job_start")}
            busy={props.busy}
            disabled={!props.toggleEnabled}
            onPress={() => (props.running ? props.onStop?.() : props.onStart?.())}
            testID="chat-todo-job-toggle"
            onLayout={report("toggle")}
            onIconLayout={report("toggle-icon")}
          />
          <TodoJobButton
            kind="view"
            label={t("chat_todo_job_view")}
            disabled={!props.viewEnabled}
            onPress={() => props.onView?.()}
            testID="chat-todo-job-view"
            onLayout={report("view")}
            onIconLayout={report("view-icon")}
          />
        </View>
      </GlassCapsule>
    </View>
  );
}
