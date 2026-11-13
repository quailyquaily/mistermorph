// The TODO list (the Vue page's todo-index, views/TodoView.css + views/common.css's
// workspace-sidebar-*): Heartbeat first, then the scheduled items, disabled ones last, each with its
// run state and schedule. The list is configuration the user writes, a handful of items, so it is
// an Each in a Scroll rather than a virtualized List.
//
// Craft carried over from the Vue list:
// - one selection highlight per group that glides between items (createSlidingSelection, a FLIP on
//   its transform); the items keep only their hover fill, which comes in after 60ms and goes at once
//   so sweeping the pointer down the list does not flash every row;
// - an item that just arrived or changed holds a blue tint, then fades back (createArrivalTint);
// - a running item's marker turns into the running ring (StatusMark);
// - the head sits flush with the list at rest and draws its hairline only once something has
//   scrolled under it; the list's hidden end fades (createScrollEdges);
// - the items' markers are centred under the head's last button's icon (TODO_MARKER_SLOT below).
import { createAnimatedValue, effect, reduceMotion, Scroll, Text, untracked, View } from "nsh";
import { Button as BaseButton } from "nsh/base";
import { translate } from "../../lib/core/context.js";
import { TODO_RUN_RUNNING } from "../../lib/core/todo-runs.js";
import { gutterX, gutterY, listTitleSize } from "../frame/metrics";
import { createArrivalTint, createScrollEdges, createSlidingSelection, SCROLLBAR } from "../motion";
import { BAR_ICON_SIZE, CircleButton, Icon, StatusMark } from "../ui";
import { createPartProbe, type PartLayoutListener } from "../shared/partProbe";
import type { TodoRun, TodoState, TodoTask } from "./todo-state";

const t = translate as (key: string, vars?: Record<string, unknown> | null) => string;

/** The Vue page's index width (`--todo-sidebar-width`). */
export const TODO_INDEX_WIDTH = 310;
/** `--workspace-head-height`: the index head, as tall as the page bar. */
export const TODO_HEAD_HEIGHT = 57;

// The head's last button (Add on a desktop, the calendar toggle on a phone, where Add floats over
// the list) is a 38pt square with its icon in the middle, and each item's marker (a 7pt mark in the
// middle of a 16pt slot at the row's end) is centred under that icon: the axis lies the same
// distance in from the index's right edge. On a phone the head keeps the pages' phone gutter and
// the rows, edge to edge, take their right padding from the axis (gutter and half a button, less
// half the slot and the 1pt border). On a desktop the rows keep the list's 16pt gutter (as wide as
// the topic and contact rows) and 10pt padding (the marks' axis 35pt in, their right edge 15.5pt
// inside the row's, as a topic's), and the head's right padding puts the icon there (16pt): Add
// ends where the rows do.
// Centres, not edges: the mark is 7pt, the button 38.
/** The head's buttons: the standard round icon button (CircleButton, 38pt) with a regular icon button's 16pt icon (BAR_ICON_SIZE). */
export const TODO_HEAD_BUTTON = 38;
/** The marker's slot at an item's end (RunMarker), the mark in its middle. */
export const TODO_MARKER_SLOT = 16;
const ROW_BORDER = 1;
const DESKTOP_LIST_GUTTER_RIGHT = 16;
const DESKTOP_ROW_PADDING_RIGHT = 10;

/** How far the axis the head's last icon and the items' markers are centred on lies in from the index's right edge. */
export function todoMarkerAxisInset(mobile: boolean): number {
  return mobile
    ? gutterX() + TODO_HEAD_BUTTON / 2
    : DESKTOP_LIST_GUTTER_RIGHT + ROW_BORDER + DESKTOP_ROW_PADDING_RIGHT + TODO_MARKER_SLOT / 2;
}

/** The head's right padding, so its last button's icon is centred on the axis. */
export function todoHeadPaddingRight(mobile: boolean): number {
  return mobile ? gutterX() : todoMarkerAxisInset(false) - TODO_HEAD_BUTTON / 2;
}

/** An item's right padding, so its marker is centred on the axis. */
export function todoRowPaddingRight(mobile: boolean): number {
  return mobile ? todoMarkerAxisInset(true) - TODO_MARKER_SLOT / 2 - ROW_BORDER : DESKTOP_ROW_PADDING_RIGHT;
}

// Hover: the row's soft fill (accent 6 %) fades in after a short pause and out at once.
export const ROW_HOVER = { transitionDelay: 60 };
export const ROW_TRANSITION = { transitionProperty: "colors", transitionDuration: 180, transitionTimingFunction: "ease" } as const;

/**
 * The item's marker, a 7pt status square: waiting (orange), else blue when enabled and hollow when
 * not (the Vue console's badge dot overrides in styles/base.css); the turning ring while it runs.
 */
export function RunMarker(props: { run: TodoRun | null; enabled: boolean; probe?: Probe }) {
  const state = () =>
    props.run ? (props.run.state === TODO_RUN_RUNNING ? "running" : "pending") : props.enabled ? "on" : "off";
  return (
    <View class="items-center justify-center" style={{ width: TODO_MARKER_SLOT }} accessibilityElementsHidden {...props.probe}>
      <StatusMark state={state()} size={7} corner={2} />
    </View>
  );
}

/** A part's layout probe (createPartProbe's `probe`), spread on the view. */
type Probe = ReturnType<ReturnType<typeof createPartProbe>["probe"]>;

function IndexItem(props: {
  title: string;
  meta: string;
  runLabel: string;
  run: TodoRun | null;
  enabled: boolean;
  active: boolean;
  arrived?: boolean;
  mobile?: boolean;
  testID?: string;
  onLayout?: (event: { bounds: { origin: { x: number; y: number }; size: { width: number; height: number } } }) => void;
  onPress: () => void;
  /** Probes for the title column and the marker slot (TodoIndex's `onPartLayout`). */
  titleProbe?: Probe;
  markerProbe?: Probe;
}) {
  const tint = createArrivalTint();
  let wasArrived = false;
  effect(() => {
    const arrived = !!props.arrived;
    untracked(() => {
      if (arrived && !wasArrived) tint.play();
      wasArrived = arrived;
    });
  });
  return (
    <BaseButton
      onPress={() => props.onPress()}
      selected={props.active}
      accessibilityLabel={props.title}
      testID={props.testID}
      onLayout={props.onLayout}
      // The selected row's fill is the gliding highlight behind it; hovering it deepens that a
      // shade (accent 10 % -> ~13 %), as the Vue list does.
      class={`relative flex-row items-center gap-2.5 rounded-(--radius) border border-transparent ${
        props.mobile ? "pb-[10.3px] pl-3 pt-[11px]" : "pb-[10.3px] pl-3.5 pt-3"
      } ${props.active ? "hover:bg-hover-faint" : "hover:bg-hover-soft"}`}
      style={{ ...ROW_TRANSITION, paddingRight: todoRowPaddingRight(!!props.mobile) }}
      hoverStyle={ROW_HOVER}
    >
      <View class="absolute inset-0 rounded-(--radius)" style={{ backgroundColor: tint.color, pointerEvents: "none" }} />
      {/* nsh draws a line no shorter than its font (17.3pt here, where the Vue title's line is
          16.1): 3pt between the lines and 10.3 below keep the row at the Vue row's 61.3pt. On mobile
          the title is 15pt on a 17.3pt line. */}
      <View class="flex-1 gap-[3px]" {...props.titleProbe}>
        <Text
          class={`${listTitleSize(!!props.mobile)} font-normal ${props.mobile ? "leading-[17.3px]" : "leading-[16.1px]"} tracking-[-0.35px] text-foreground line-clamp-2`}
        >
          {props.title}
        </Text>
        <Text
          class={`font-mono text-xs leading-[16.2px] line-clamp-2 ${props.active ? "text-subtle" : "text-muted-foreground"}`}
        >
          <If when={props.run}>
            <Text class="text-subtle">{`${props.runLabel} · `}</Text>
          </If>
          {props.meta}
        </Text>
      </View>
      <RunMarker run={props.run} enabled={props.enabled} probe={props.markerProbe} />
    </BaseButton>
  );
}

/** A group heading (workspace-sidebar-divider): a small mono label, then a rule that fades out. */
function Divider(props: { label: string; mobile?: boolean }) {
  return (
    <View class={`flex-row items-center gap-2.5 pb-1 pt-2.5 ${props.mobile ? "px-3.5" : "mx-4 px-3.5"}`} role="header">
      <Text class="font-mono text-[11px] font-medium uppercase leading-[15.4px] tracking-[1.32px] text-muted-foreground line-clamp-1">
        {props.label}
      </Text>
      <View class="h-px flex-1 bg-linear-to-r from-line-soft to-transparent" />
    </View>
  );
}

export function TodoIndex(props: {
  state: TodoState;
  mobile?: boolean;
  /** Hears where parts lie on the page (tests): `index`, `head-action` (the head's last button),
   * `marker-<item>` and `title-<item>` (`heartbeat`, else the task's id), `empty-marker` (the
   * empty list's add icon slot). */
  onPartLayout?: PartLayoutListener;
}) {
  const state = props.state;
  const parts = createPartProbe(() => props.onPartLayout);
  const display = (task: TodoTask) => state.taskListDisplayTask(task) as TodoTask;
  const heartbeatSelection = createSlidingSelection(() => (!props.mobile && state.heartbeatSelected() ? "heartbeat" : null));
  const taskSelection = createSlidingSelection(() => (props.mobile ? null : state.selectedTaskKey() || null));
  const edges = createScrollEdges({ start: false });
  return (
    <View class="flex-1" accessibilityLabel={t("todo_nav_title")} testID="todo-index" {...parts.probe(() => "index")}>
      <View
        class={`flex-row items-center border-b ${edges.scrolled() ? "border-line-soft/50" : "border-transparent"}`}
        style={{
          height: TODO_HEAD_HEIGHT,
          paddingLeft: gutterX(),
          paddingRight: todoHeadPaddingRight(!!props.mobile),
          transitionProperty: "colors",
          transitionDuration: 180,
        }}
      >
        <Text
          class="flex-1 text-xl font-normal leading-[24px] tracking-[-0.6px] text-foreground line-clamp-1"
          role="header"
        >
          {t("todo_title")}
        </Text>
        {/* Buttons sit at the top of their box (self-start); a wrapper centres them in the head. The
            last one's icon is centred over the items' markers (above). */}
        <View {...parts.probe(() => (props.mobile ? "head-action" : null))}>
          <CircleButton
            icon="PhCalendarBlank"
            iconSize={BAR_ICON_SIZE}
            title={t("todo_view_calendar")}
            testID="todo-view-toggle"
            onPress={state.toggleTodoView}
          />
        </View>
        <If when={!props.mobile}>
          <View {...parts.probe(() => "head-action")}>
            <CircleButton icon="PhPlus" iconSize={BAR_ICON_SIZE} title={t("todo_action_add")} testID="todo-add" onPress={state.addTask} />
          </View>
        </If>
      </View>

      <Scroll class="flex-1" scrollbar={SCROLLBAR} {...edges.handlers} style={edges.style()}>
        <View
          onLayout={edges.onContentLayout}
          class="gap-3.5"
          // On phones the rows run edge to edge (Vue: list padding 16 0, their own 12 inside) and
          // the list clears the floating add button.
          style={{ paddingBottom: props.mobile ? 84 : gutterY() }}
        >
          <If when={state.loading() || state.heartbeatLoading()}>
            <View class={`gap-2 ${props.mobile ? "pt-4" : "px-4 pt-4"}`} accessibilityLabel={t("todo_heartbeat_loading")}>
              <Each of={[0, 1, 2]}>{() => <View class="h-15 animate-pulse rounded-(--radius) bg-muted" />}</Each>
            </View>
          </If>

          <View class={`relative ${props.mobile ? "pt-4" : "px-4 pt-4"}`}>
            <heartbeatSelection.Highlight class="rounded-(--radius) bg-selection" />
            <IndexItem
              title={t("todo_heartbeat_title")}
              meta={state.heartbeatIndexMeta()}
              runLabel={state.runStateLabel(state.heartbeatRun())}
              run={state.heartbeatRun()}
              enabled={!state.heartbeatDisabled()}
              active={!props.mobile && state.heartbeatSelected()}
              mobile={props.mobile}
              testID="todo-heartbeat-item"
              onLayout={heartbeatSelection.track("heartbeat")}
              onPress={state.selectHeartbeat}
              titleProbe={parts.probe(() => "title-heartbeat")}
              markerProbe={parts.probe(() => "marker-heartbeat")}
            />
          </View>

          <View>
            <If when={state.tasks().length > 0 || !state.loading()}>
              <Divider label={t("todo_index_scheduled")} mobile={props.mobile} />
            </If>

            <If
              when={state.tasks().length > 0}
              else={
                <If when={!state.loading()}>
                  <View class={props.mobile ? "" : "px-4"}>
                    <BaseButton
                      onPress={state.addTask}
                      accessibilityLabel={t("todo_action_add")}
                      testID="todo-empty-add"
                      class={`flex-row items-center gap-2.5 rounded-(--radius) border border-dashed border-line-soft hover:bg-hover-soft ${
                        props.mobile ? "pl-3 py-[11px]" : "pb-[11px] pl-3.5 pt-3"
                      }`}
                      style={{ ...ROW_TRANSITION, paddingRight: todoRowPaddingRight(!!props.mobile) }}
                      hoverStyle={ROW_HOVER}
                    >
                      <View class="flex-1 gap-1">
                        <Text class="text-sm leading-[15.1px] tracking-[-0.35px] text-subtle">{t("todo_empty_list")}</Text>
                        <Text class="text-xs leading-[16.8px] text-muted-foreground">{t("todo_empty_list_hint")}</Text>
                      </View>
                      <View class="items-center" style={{ width: TODO_MARKER_SLOT }} {...parts.probe(() => "empty-marker")}>
                        <Icon name="PhPlus" size={14} color="muted-foreground" />
                      </View>
                    </BaseButton>
                  </View>
                </If>
              }
            >
              <View class={`relative gap-0.5 ${props.mobile ? "" : "px-4"}`} role={props.mobile ? undefined : "list"}>
                <taskSelection.Highlight class="rounded-(--radius) bg-selection" />
                <Each of={state.orderedTasks()} key={(task) => task._key}>
                  {(task) => (
                    <IndexItem
                      title={state.taskTitle(display(task()))}
                      meta={state.scheduleLabel(display(task()))}
                      runLabel={state.runStateLabel(state.taskRun(task()))}
                      run={state.taskRun(task())}
                      enabled={display(task()).enabled !== false}
                      active={!props.mobile && task()._key === state.selectedTaskKey()}
                      arrived={state.isArrived(task())}
                      mobile={props.mobile}
                      testID={`todo-item-${task().id}`}
                      onLayout={taskSelection.track(task()._key)}
                      onPress={() => state.selectTask(task())}
                      titleProbe={parts.probe(() => `title-${task().id}`)}
                      markerProbe={parts.probe(() => `marker-${task().id}`)}
                    />
                  )}
                </Each>
              </View>
            </If>
          </View>
        </View>
      </Scroll>
    </View>
  );
}
