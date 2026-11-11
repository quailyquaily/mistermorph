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
//   scrolled under it; the list's hidden end fades (createScrollEdges).
import { createAnimatedValue, effect, reduceMotion, Scroll, Text, untracked, View } from "nsh";
import { Button as BaseButton } from "nsh/base";
import { translate } from "../../lib/core/context.js";
import { TODO_RUN_RUNNING } from "../../lib/core/todo-runs.js";
import { gutterX, gutterY, listTitleSize } from "../frame/metrics";
import { createArrivalTint, createScrollEdges, createSlidingSelection, SCROLLBAR } from "../motion";
import { Button, Icon, StatusMark } from "../ui";
import type { TodoRun, TodoState, TodoTask } from "./todo-state";

const t = translate as (key: string, vars?: Record<string, unknown> | null) => string;

/** The Vue page's index width (`--todo-sidebar-width`). */
export const TODO_INDEX_WIDTH = 310;
/** `--workspace-head-height`: the index head, as tall as the page bar. */
export const TODO_HEAD_HEIGHT = 57;

// Hover: the row's soft fill (accent 6 %) fades in after a short pause and out at once.
export const ROW_HOVER = { transitionDelay: 60 };
export const ROW_TRANSITION = { transitionProperty: "colors", transitionDuration: 180, transitionTimingFunction: "ease" } as const;

/**
 * The item's marker, a 7pt status square: waiting (orange), else blue when enabled and hollow when
 * not (the Vue console's badge dot overrides in styles/base.css); the turning ring while it runs.
 */
export function RunMarker(props: { run: TodoRun | null; enabled: boolean }) {
  const state = () =>
    props.run ? (props.run.state === TODO_RUN_RUNNING ? "running" : "pending") : props.enabled ? "on" : "off";
  return (
    <View class="w-4 items-center justify-center" accessibilityElementsHidden>
      <StatusMark state={state()} size={7} corner={2} />
    </View>
  );
}

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
        props.mobile ? "px-3 pb-[10.3px] pt-[11px]" : "pb-[10.3px] pl-3.5 pr-[13px] pt-3"
      } ${props.active ? "hover:bg-hover-faint" : "hover:bg-hover-soft"}`}
      style={ROW_TRANSITION}
      hoverStyle={ROW_HOVER}
    >
      <View class="absolute inset-0 rounded-(--radius)" style={{ backgroundColor: tint.color, pointerEvents: "none" }} />
      {/* nsh draws a line no shorter than its font (17.3pt here, where the Vue title's line is
          16.1): 3pt between the lines and 10.3 below keep the row at the Vue row's 61.3pt. On mobile
          the title is 15pt on a 17.3pt line. */}
      <View class="flex-1 gap-[3px]">
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
      <RunMarker run={props.run} enabled={props.enabled} />
    </BaseButton>
  );
}

/** A group heading (workspace-sidebar-divider): a small mono label, then a rule that fades out. */
function Divider(props: { label: string; mobile?: boolean }) {
  return (
    <View class={`flex-row items-center gap-2.5 pb-1 pt-2.5 ${props.mobile ? "px-3.5" : "ml-4 mr-[26px] px-3.5"}`} role="header">
      <Text class="font-mono text-[11px] font-medium uppercase leading-[15.4px] tracking-[1.32px] text-muted-foreground line-clamp-1">
        {props.label}
      </Text>
      <View class="h-px flex-1 bg-linear-to-r from-line-soft to-transparent" />
    </View>
  );
}

export function TodoIndex(props: { state: TodoState; mobile?: boolean }) {
  const state = props.state;
  const display = (task: TodoTask) => state.taskListDisplayTask(task) as TodoTask;
  const heartbeatSelection = createSlidingSelection(() => (!props.mobile && state.heartbeatSelected() ? "heartbeat" : null));
  const taskSelection = createSlidingSelection(() => (props.mobile ? null : state.selectedTaskKey() || null));
  const edges = createScrollEdges({ start: false });
  return (
    <View class="flex-1" accessibilityLabel={t("todo_nav_title")} testID="todo-index">
      <View
        class={`flex-row items-center border-b ${edges.scrolled() ? "border-line-soft/50" : "border-transparent"}`}
        style={{
          height: TODO_HEAD_HEIGHT,
          paddingLeft: gutterX(),
          paddingRight: props.mobile ? gutterX() : 0,
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
        {/* Buttons sit at the top of their box (self-start); a wrapper centres them in the head. */}
        <View>
          <Button
            variant="plain"
            iconOnly
            icon="PhCalendarBlank"
            title={t("todo_view_calendar")}
            testID="todo-view-toggle"
            onPress={state.toggleTodoView}
          />
        </View>
        <If when={!props.mobile}>
          <View>
            <Button
              variant="plain"
              iconOnly
              icon="PhPlus"
              title={t("todo_action_add")}
              testID="todo-add"
              onPress={state.addTask}
            />
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
            <View class={`gap-2 ${props.mobile ? "pt-4" : "pl-4 pr-[26px] pt-4"}`} accessibilityLabel={t("todo_heartbeat_loading")}>
              <Each of={[0, 1, 2]}>{() => <View class="h-15 animate-pulse rounded-(--radius) bg-muted" />}</Each>
            </View>
          </If>

          <View class={`relative ${props.mobile ? "pt-4" : "pl-4 pr-[26px] pt-4"}`}>
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
                  <View class={props.mobile ? "" : "pl-4 pr-[26px]"}>
                    <BaseButton
                      onPress={state.addTask}
                      accessibilityLabel={t("todo_action_add")}
                      testID="todo-empty-add"
                      class={`flex-row items-center gap-2.5 rounded-(--radius) border border-dashed border-line-soft hover:bg-hover-soft ${
                        props.mobile ? "px-3 py-[11px]" : "pb-[11px] pl-3.5 pr-[13px] pt-3"
                      }`}
                      style={ROW_TRANSITION}
                      hoverStyle={ROW_HOVER}
                    >
                      <View class="flex-1 gap-1">
                        <Text class="text-sm leading-[15.1px] tracking-[-0.35px] text-subtle">{t("todo_empty_list")}</Text>
                        <Text class="text-xs leading-[16.8px] text-muted-foreground">{t("todo_empty_list_hint")}</Text>
                      </View>
                      <View class="w-4 items-center">
                        <Icon name="PhPlus" size={14} color="muted-foreground" />
                      </View>
                    </BaseButton>
                  </View>
                </If>
              }
            >
              <View class={`relative gap-0.5 ${props.mobile ? "" : "pl-4 pr-[26px]"}`} role={props.mobile ? undefined : "list"}>
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
