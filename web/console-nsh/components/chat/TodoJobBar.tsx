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
import { Text, View } from "nsh";
import type { IconName } from "../icons";
import { BAR_BELOW, BAR_INSET } from "../frame/mobileBar";
import {
  CAPSULE_COMPACT_HEIGHT,
  CAPSULE_COMPACT_INSET,
  CAPSULE_COMPACT_SIZE,
  CAPSULE_DANGER_TINT,
  CAPSULE_FOCUS_RING,
  CAPSULE_NAV_SIZE,
  CapsuleButton,
  type CapsuleButtonLook,
  capsuleButtonLook,
  type CapsuleSize,
  CapsuleToolbar,
  capsuleToolbarSize,
} from "../shared/CapsuleBar";
import { isMobile } from "../../lib/shell";
import { t } from "./i18n";

// The toolbar is the shared capsule toolbar (components/shared/CapsuleBar.tsx); its measures are
// kept here under the names this toolbar's callers and tests know them by.
/** A button's height: the navigation's slot, so the capsule's padding is the same on every side. */
export const TODO_JOB_BUTTON_HEIGHT = CAPSULE_NAV_SIZE.height;
/** A button's width: the navigation's slot where it has room. */
export const TODO_JOB_BUTTON_WIDTH = CAPSULE_NAV_SIZE.width;
/** The room between the two buttons: the capsule's padding, so every gap round them is the same. */
export const TODO_JOB_BUTTON_GAP = BAR_INSET;
/** The glyphs' size: the navigation's. */
export const TODO_JOB_ICON_SIZE = CAPSULE_NAV_SIZE.icon;
/** Stop's fill: the theme's danger at this share over the card, opaque (`bg-danger/12` over `bg-card`). */
export const TODO_JOB_STOP_TINT = CAPSULE_DANGER_TINT;
/** The keyboard focus mark of each button (the console's Button draws none of its own). */
export const TODO_JOB_FOCUS_RING = CAPSULE_FOCUS_RING;

/** `topic`: the job's topic, the mirror of View Job on the job's own page (TodoTaskEditor). */
export type TodoJobButtonKind = "start" | "stop" | "view" | "topic";

/** How one of the toolbar's buttons looks in a state: `look` is `primary` (Start), `stop`, `quiet` (View Job), `busy` or `disabled`. */
export type TodoJobButtonLook = CapsuleButtonLook;

/**
 * The look of `kind` (`start`, `stop`, `view`, `topic`) while `busy` or `disabled`: Start is the
 * primary button (a white Play), Stop the danger one (a red Stop square; it stops that run, not the
 * schedule), View Job and the topic the quiet ones.
 */
export function todoJobButtonLook(kind: TodoJobButtonKind, state: { busy?: boolean; disabled?: boolean } = {}): TodoJobButtonLook {
  const glyph: IconName = kind === "start" ? "PhPlay" : kind === "stop" ? "PhStop" : kind === "topic" ? "PhChat" : "PhListChecks";
  const look = capsuleButtonLook(kind === "start" ? "primary" : kind === "stop" ? "danger" : "quiet", glyph, state);
  return look.look === "danger" ? { ...look, look: "stop" } : look;
}

/** A button's box and glyph, in points. */
export type TodoJobButtonSize = CapsuleSize;
/** The navigation's slot: the capsule on a phone. */
export const TODO_JOB_NAV_SIZE: TodoJobButtonSize = CAPSULE_NAV_SIZE;
// On a desktop the toolbar is as tall as a bar's back button (38pt, its hairline included): the
// same buttons scaled to fit, with the same room all round. The job's own page sets it into its bar.
export const TODO_JOB_COMPACT_HEIGHT = CAPSULE_COMPACT_HEIGHT;
export const TODO_JOB_COMPACT_SIZE: TodoJobButtonSize = CAPSULE_COMPACT_SIZE;
export const TODO_JOB_COMPACT_INSET = CAPSULE_COMPACT_INSET;

type LayoutEvent = { bounds: { origin: { x: number; y: number }; size: { width: number; height: number } } };

/** One of the toolbar's icon buttons (the shared `CapsuleButton`, with this toolbar's looks). */
export function TodoJobButton(props: {
  kind: TodoJobButtonKind;
  label: string;
  busy?: boolean;
  disabled?: boolean;
  onPress?: () => void;
  testID: string;
  /** Its box and glyph; the navigation's slot when not given. */
  size?: TodoJobButtonSize;
  onLayout?: (event: LayoutEvent) => void;
  onIconLayout?: (event: LayoutEvent) => void;
}) {
  return (
    <CapsuleButton
      look={todoJobButtonLook(props.kind, { busy: props.busy, disabled: props.disabled })}
      label={props.label}
      busy={props.busy}
      disabled={props.disabled}
      onPress={props.onPress}
      testID={props.testID}
      size={props.size}
      onLayout={props.onLayout}
      onIconLayout={props.onIconLayout}
    />
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
  // A phone's capsule is the navigation's; a desktop's is the compact one of the job's page.
  const compact = () => !isMobile();
  const size = () => capsuleToolbarSize(compact());
  return (
    // The capsule sits as far above the foot as the navigation's does, and on a phone is as tall.
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
      <CapsuleToolbar floating compact={compact()} label={t("chat_todo_job_toolbar")} testID="chat-todo-job-bar" onLayout={report("capsule")} onRowLayout={report("row")}>
          <TodoJobButton
            kind={props.running ? "stop" : "start"}
            label={props.running ? t("chat_todo_job_stop") : t("chat_todo_job_start")}
            busy={props.busy}
            disabled={!props.toggleEnabled}
            onPress={() => (props.running ? props.onStop?.() : props.onStart?.())}
            size={size()}
            testID="chat-todo-job-toggle"
            onLayout={report("toggle")}
            onIconLayout={report("toggle-icon")}
          />
          <TodoJobButton
            kind="view"
            label={t("chat_todo_job_view")}
            disabled={!props.viewEnabled}
            onPress={() => props.onView?.()}
            size={size()}
            testID="chat-todo-job-view"
            onLayout={report("view")}
            onIconLayout={report("view-icon")}
          />
      </CapsuleToolbar>
    </View>
  );
}
