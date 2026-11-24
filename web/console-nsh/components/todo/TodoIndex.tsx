// The TODO list, written as a notebook page: Heartbeat first, then the items in their order, then
// the ones that are switched off under their own heading. Each is a line on a hairline: its marker
// in the left margin, its name, and when it runs. An item opens in the list's place (TodoPage), so
// the list has no selection. It is configuration the user writes, a handful of items, so it is an
// Each in a Scroll rather than a virtualized List.
//
// Craft:
// - an item's hover fill comes in after 60ms and goes at once, so sweeping the pointer down the
//   list does not flash every row;
// - an item that just arrived or changed holds a blue tint, then fades back (createArrivalTint);
// - a running item's marker turns into the running ring (StatusMark), and no word repeats it;
// - the head sits flush with the list at rest and draws its hairline only once something has
//   scrolled under it; the list's hidden end fades (createScrollEdges);
// - every marker lies on one edge of the margin and every name starts on one line (TODO_MARGIN).
import { effect, Scroll, signal, Text, untracked, View } from "nsh";
import { Button as BaseButton } from "nsh/base";
import { translate } from "../../lib/core/context.js";
import { useScrollMemory } from "../../lib/scrollMemory";
import { TODO_RUN_RUNNING } from "../../lib/core/todo-runs.js";
import { BarRoom, glassBarClass, glassBarStyle, underBar } from "../frame/glassBar";
import { gutterX, gutterY } from "../frame/metrics";
import { createArrivalTint, createScrollEdges, SCROLLBAR } from "../motion";
import { BAR_ICON_SIZE, CircleButton, Icon, StatusMark } from "../ui";
import { createPartProbe, type PartLayoutListener } from "../shared/partProbe";
import type { TodoRun, TodoState, TodoTask } from "./todo-state";
import { ChatComposer } from "../chat/ChatComposer";
import { TodoViewRule, todoViewRuleColor, todoViewSagCenter, TodoViewTabs } from "./TodoViewTabs";
import { CARD_CORNERS } from "../corners";

const t = translate as (key: string, vars?: Record<string, unknown> | null) => string;

/** The Vue page's index width (`--todo-sidebar-width`). */
export const TODO_INDEX_WIDTH = 310;
/** `--workspace-head-height`: the index head, as tall as the page bar. */
export const TODO_HEAD_HEIGHT = 57;

// The calendar's head (TodoCalendar) still lays its buttons out over the old 310pt index column,
// from these: the 38pt round buttons, and the inset that put the last one's icon over the old
// list's markers. They go when the calendar's head is rebuilt over the page's column.
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
    <View class="items-start justify-center" style={{ width: TODO_MARKER_SLOT }} accessibilityElementsHidden {...props.probe}>
      <StatusMark state={state()} size={7} corner={2} />
    </View>
  );
}

/** A part's layout probe (createPartProbe's `probe`), spread on the view. */
type Probe = ReturnType<ReturnType<typeof createPartProbe>["probe"]>;

/** The list's column on a desktop: a page of text, centred. */
export const TODO_LIST_MAX_WIDTH = 760;
/** The margin at each row's left, where its marker sits (a bullet in a notebook's margin). */
export const TODO_MARGIN = 28;

/**
 * One job, as a line of a notebook page: its marker in the left margin, its name, and under it when
 * it runs. The row says nothing its marker already shows (a running item has the turning ring and
 * no "Running"): the state is in the row's accessibility label.
 */
function IndexItem(props: {
  title: string;
  meta: string;
  runLabel: string;
  run: TodoRun | null;
  enabled: boolean;
  arrived?: boolean;
  mobile?: boolean;
  testID?: string;
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
      accessibilityLabel={props.run ? `${props.title}, ${props.runLabel}` : props.title}
      testID={props.testID}
      class="relative flex-row rounded-(--radius) hover:bg-hover-soft"
      style={ROW_TRANSITION}
      hoverStyle={ROW_HOVER}
    >
      <View class="absolute inset-0 rounded-(--radius)" style={{ backgroundColor: tint.color, pointerEvents: "none" }} />
      {/* The marker, centred on the name's first line (24pt, 10pt down). */}
      <View class="mt-2.5 h-6 justify-center" style={{ width: TODO_MARGIN }}>
        <RunMarker run={props.run} enabled={props.enabled} probe={props.markerProbe} />
      </View>
      <View class="flex-1 gap-px border-b border-line-soft/60 pb-[11px] pt-2.5" {...props.titleProbe}>
        <Text
          class={`text-base font-normal leading-[24px] tracking-[-0.2px] line-clamp-2 ${props.enabled ? "text-foreground" : "text-muted-foreground"}`}
        >
          {props.title}
        </Text>
        <Text class="text-[13px] leading-[20px] text-muted-foreground line-clamp-2">
          {/* A waiting item says so (its orange mark alone is not a known sign); a running one has the ring. */}
          <If when={props.run && props.run.state !== TODO_RUN_RUNNING}>
            <Text class="text-subtle">{`${props.runLabel} · `}</Text>
          </If>
          {props.meta}
        </Text>
      </View>
    </BaseButton>
  );
}

/** A group heading in the page's margin style: a small mono label over the rows it names. */
function Divider(props: { label: string }) {
  return (
    <View class="pb-1.5 pt-6" style={{ paddingLeft: TODO_MARGIN }} role="header">
      <Text class="font-mono text-[11px] font-medium uppercase leading-[15.4px] tracking-[1.32px] text-muted-foreground line-clamp-1">
        {props.label}
      </Text>
    </View>
  );
}

export function TodoIndex(props: {
  state: TodoState;
  mobile?: boolean;
  /** Hears where parts lie on the page (tests): `index`, `head-title`, `head-action` (the head's last button),
   * `marker-<item>` and `title-<item>` (`heartbeat`, else the task's id), `empty-add`,
   * `empty-text` and `empty-marker` (the empty list's add row, its text column and its icon
   * slot), `view-toggle` and `view-toggle-icon` (the calendar toggle and its
   * icon). */
  onPartLayout?: PartLayoutListener;
}) {
  const state = props.state;
  const parts = createPartProbe(() => props.onPartLayout);
  const display = (task: TodoTask) => state.taskListDisplayTask(task) as TodoTask;
  const on = (task: TodoTask) => display(task).enabled !== false;
  // The list as written, then the items that are switched off, under their own heading.
  const onTasks = () => state.orderedTasks().filter(on);
  const offTasks = () => state.orderedTasks().filter((task) => !on(task));
  const edges = createScrollEdges({ start: false });
  const headWidth = signal(0);
  // The flow has something to draw: the runtime knows which job uses which.
  const flow = () => state.tasks().some((task) => Array.isArray(task.triggers));
  const memory = useScrollMemory({ column: 2, area: "index", ready: () => !props.state.tasksPending() });
  // The page's column: the pages' gutter at each side, and on a desktop no wider than a page of text.
  const column = () => ({ width: "100%" as const, maxWidth: props.mobile ? undefined : TODO_LIST_MAX_WIDTH, alignSelf: "center" as const });
  const row = (task: () => TodoTask) => (
    <IndexItem
      title={state.taskTitle(display(task()))}
      meta={state.whenLabel(display(task()))}
      runLabel={state.runStateLabel(state.taskRun(task()))}
      run={state.taskRun(task())}
      enabled={on(task())}
      arrived={state.isArrived(task())}
      mobile={props.mobile}
      testID={`todo-item-${task().id}`}
      onPress={() => state.selectTask(task())}
      titleProbe={parts.probe(() => `title-${task().id}`)}
      markerProbe={parts.probe(() => `marker-${task().id}`)}
    />
  );
  return (
    <View class="flex-1" accessibilityLabel={t("todo_nav_title")} testID="todo-index" {...parts.probe(() => "index")}>
      <View
        // Its bottom hairline is drawn (TodoViewRule): shown once rows have gone under the head,
        // and dipping under the current view's tab. The head draws over the list for the dip.
        class={`relative z-10 border-b border-transparent ${glassBarClass()}`}
        style={{ ...glassBarStyle(), height: TODO_HEAD_HEIGHT, paddingHorizontal: gutterX() }}
        onLayout={(event) => headWidth.set(event.bounds.size.width)}
      >
        {/* The head spans the pane, as the calendar's and the flow's do: the title at the pane's
            left gutter, the views' tabs at its right one (beside the Today column where there is
            one), so both keep their place whichever view shows. */}
        <View class="flex-1 flex-row items-center">
          <Text
            class="flex-1 text-xl font-normal leading-[24px] tracking-[-0.6px] text-foreground line-clamp-1"
            role="header"
            {...parts.probe(() => "head-title")}
          >
            {t("todo_title")}
          </Text>
          {/* The page's views, as tabs (the flow only where the runtime knows which job uses
              which). Add is in the composer on a desktop, a floating button on a phone. */}
          <TodoViewTabs
            value="list"
            flow={flow()}
            mobile={props.mobile}
            onChange={(view) => state.setTodoView(view)}
            onPartLayout={props.onPartLayout}
          />
        </View>
        <TodoViewRule
          center={() => todoViewSagCenter("list", flow(), !!props.mobile, headWidth(), gutterX())}
          color={edges.scrolled() ? todoViewRuleColor("line-faint") : undefined}
        />
      </View>

      <Scroll
        class="flex-1"
        scrollbar={SCROLLBAR}
        {...edges.handlers}
        ref={memory.ref}
        onScroll={(event) => {
          edges.handlers.onScroll(event);
          memory.onScroll(event);
        }}
        style={{ ...edges.style(), ...underBar(TODO_HEAD_HEIGHT) }}
      >
        <BarRoom height={TODO_HEAD_HEIGHT} />
        <View
          onLayout={edges.onContentLayout}
          style={{ paddingHorizontal: gutterX(), paddingTop: 8, paddingBottom: props.mobile ? 84 : gutterY() * 2 }}
        >
          <View style={column()}>
            {/* A job written in words: the chat's composer, as in a conversation. The agent writes the
                job from the sentence; a note under it leads to the topic where it does. */}
            {/* It spans the column, from the markers' edge: it is not one of the list's rows. */}
            <View class="gap-2 pb-3 pt-1" testID="todo-compose">
              <ChatComposer
                landing
                value={state.composeText()}
                onChange={(value) => state.composeText.set(value)}
                placeholder={t("todo_compose_placeholder")}
                sendLabel={t("todo_compose_send")}
                sending={state.composeSending()}
                sendDisabled={state.composeSending() || state.composeText().trim() === ""}
                // A job is written in words alone: no workspace or file to add, so no add button.
                attachDisabled
                attachHidden
                onSubmit={() => void state.composeJob()}
                // A desktop: the other way to make a job, an empty form, is the toolbar's last
                // button, a primary circle the size of Send (a phone has the floating Add).
                actionsEnd={
                  <If when={!props.mobile}>
                    <CircleButton variant="primary" icon="PhPlus" iconSize={BAR_ICON_SIZE} title={t("todo_action_add")} disabled={state.loading()} testID="todo-add" onPress={state.addTask} />
                  </If>
                }
              />
              <If when={state.composeTopicID()}>
                <View class="flex-row flex-wrap items-baseline gap-x-2 px-3" testID="todo-compose-note">
                  <Text class="text-xs leading-[17.4px] text-muted-foreground">{t("todo_compose_sent")}</Text>
                  <BaseButton onPress={state.openComposeTopic} accessibilityLabel={t("todo_action_open_topic")} testID="todo-compose-topic">
                    <Text class="text-xs leading-[17.4px] text-blue">{t("todo_action_open_topic")}</Text>
                  </BaseButton>
                </View>
              </If>
            </View>

            <If when={state.placeholderRows()}>
              <View class="gap-2 pt-2" accessibilityLabel={t("todo_heartbeat_loading")} style={{ paddingLeft: TODO_MARGIN }}>
                <Each of={[0, 1, 2]}>{() => <View class="h-13 animate-pulse rounded-(--radius) bg-muted" />}</Each>
              </View>
            </If>

            <IndexItem
              title={t("todo_heartbeat_title")}
              meta={state.heartbeatIndexMeta()}
              runLabel={state.runStateLabel(state.heartbeatRun())}
              run={state.heartbeatRun()}
              enabled={!state.heartbeatDisabled()}
              mobile={props.mobile}
              testID="todo-heartbeat-item"
              onPress={state.selectHeartbeat}
              titleProbe={parts.probe(() => "title-heartbeat")}
              markerProbe={parts.probe(() => "marker-heartbeat")}
            />

            <If
              when={state.tasks().length > 0}
              else={
                <If when={!state.loading()}>
                  {/* The button takes no ref: this view, exactly as large, reports its frame. */}
                  <View class="pt-3" style={{ paddingLeft: TODO_MARGIN }}>
                    <View {...parts.probe(() => "empty-add")}>
                      <BaseButton
                        onPress={state.addTask}
                        accessibilityLabel={t("todo_action_add")}
                        testID="todo-empty-add"
                        class={`flex-row items-center gap-2.5 ${CARD_CORNERS} border border-dashed border-line-soft px-3.5 pb-[11px] pt-3 hover:bg-hover-soft`}
                        style={ROW_TRANSITION}
                        hoverStyle={ROW_HOVER}
                      >
                        <View class="flex-1 gap-1" {...parts.probe(() => "empty-text")}>
                          <Text class="text-sm leading-[15.1px] tracking-[-0.35px] text-subtle">{t("todo_empty_list")}</Text>
                          <Text class="text-xs leading-[16.8px] text-muted-foreground">{t("todo_empty_list_hint")}</Text>
                        </View>
                        <View class="items-center" style={{ width: TODO_MARKER_SLOT }} {...parts.probe(() => "empty-marker")}>
                          <Icon name="PhPlus" size={14} color="muted-foreground" />
                        </View>
                      </BaseButton>
                    </View>
                  </View>
                </If>
              }
            >
              <View role="list">
                <Each of={onTasks()} key={(task) => task._key}>
                  {(task) => row(task)}
                </Each>
              </View>
              <If when={offTasks().length > 0}>
                <Divider label={t("todo_index_off")} />
                <View role="list" testID="todo-index-off">
                  <Each of={offTasks()} key={(task) => task._key}>
                    {(task) => row(task)}
                  </Each>
                </View>
              </If>
            </If>
          </View>
        </View>
      </Scroll>
    </View>
  );
}
