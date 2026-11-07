// The TODO list (the Vue page's todo-index): Heartbeat first, then the scheduled items, disabled
// ones last, each with its run state and schedule. The list is configuration the user writes, a
// handful of items, so it is an Each in a Scroll rather than a virtualized List.
import { Scroll, Text, View } from "nsh";
import { Button as BaseButton } from "nsh/base";
import { translate } from "../../lib/core/context.js";
import { TODO_RUN_RUNNING } from "../../lib/core/todo-runs.js";
import { Button, Icon, Skeleton } from "../ui";
import type { TodoRun, TodoState, TodoTask } from "./todo-state";

const t = translate as (key: string, vars?: Record<string, unknown> | null) => string;

/** The item's marker: running (blue), waiting (orange), else enabled or disabled. */
export function RunMarker(props: { run: TodoRun | null; enabled: boolean }) {
  const cls = () => {
    if (props.run) {
      return props.run.state === TODO_RUN_RUNNING ? "bg-blue border-blue" : "bg-warn border-warn";
    }
    return props.enabled ? "bg-ok border-ok" : "border-status-off";
  };
  return <View class={`size-2 rounded-full border ${cls()}`} accessibilityElementsHidden />;
}

function IndexItem(props: {
  title: string;
  meta: string;
  runLabel: string;
  run: TodoRun | null;
  enabled: boolean;
  active: boolean;
  arrived?: boolean;
  testID?: string;
  onPress: () => void;
}) {
  return (
    <BaseButton
      onPress={() => props.onPress()}
      selected={props.active}
      accessibilityLabel={props.title}
      testID={props.testID}
      class={`flex-row items-center gap-2 rounded-(--radius) px-2.5 py-2 hover:bg-hover active:bg-selection ${
        props.active ? "bg-selection" : props.arrived ? "bg-hover" : ""
      }`}
    >
      <View class="flex-1 gap-0.5">
        <Text class="text-sm font-medium text-foreground line-clamp-1">{props.title}</Text>
        <Text class="text-xs text-muted-foreground line-clamp-1">
          <If when={props.run}>
            <Text class="text-blue-dark">{`${props.runLabel} · `}</Text>
          </If>
          {props.meta}
        </Text>
      </View>
      <RunMarker run={props.run} enabled={props.enabled} />
    </BaseButton>
  );
}

export function TodoIndex(props: { state: TodoState; mobile?: boolean }) {
  const state = props.state;
  const display = (task: TodoTask) => state.taskListDisplayTask(task) as TodoTask;
  return (
    <View class="flex-1" accessibilityLabel={t("todo_nav_title")} testID="todo-index">
      <View class="min-h-12 flex-row items-center gap-1 border-b border-line-faint px-3">
        <Text class="flex-1 text-base font-semibold text-foreground" role="header">
          {t("todo_title")}
        </Text>
        <Button
          variant="plain"
          iconOnly
          icon="PhCalendarBlank"
          title={t("todo_view_calendar")}
          testID="todo-view-toggle"
          onPress={state.toggleTodoView}
        />
        <If when={!props.mobile}>
          <Button
            variant="plain"
            iconOnly
            icon="PhPlus"
            title={t("todo_action_add")}
            testID="todo-add"
            onPress={state.addTask}
          />
        </If>
      </View>

      <Scroll class="flex-1" contentClass={`gap-1 p-2 ${props.mobile ? "pb-24" : ""}`}>
        <If when={state.loading() || state.heartbeatLoading()}>
          <Skeleton rows={3} label={t("todo_heartbeat_loading")} class="p-2" />
        </If>

        <IndexItem
          title={t("todo_heartbeat_title")}
          meta={state.heartbeatIndexMeta()}
          runLabel={state.runStateLabel(state.heartbeatRun())}
          run={state.heartbeatRun()}
          enabled={!state.heartbeatDisabled()}
          active={!props.mobile && state.heartbeatSelected()}
          testID="todo-heartbeat-item"
          onPress={state.selectHeartbeat}
        />

        <If when={state.tasks().length > 0 || !state.loading()}>
          <View class="flex-row items-center gap-2 px-2.5 pb-1 pt-3">
            <Text class="font-mono text-xs uppercase tracking-wide text-muted-foreground">{t("todo_index_scheduled")}</Text>
            <View class="h-px flex-1 bg-line-faint" />
          </View>
        </If>

        <If
          when={state.tasks().length > 0}
          else={
            <If when={!state.loading()}>
              <BaseButton
                onPress={state.addTask}
                accessibilityLabel={t("todo_action_add")}
                testID="todo-empty-add"
                class="flex-row items-center gap-2 rounded-(--radius) px-2.5 py-2 hover:bg-hover active:bg-selection"
              >
                <View class="flex-1 gap-0.5">
                  <Text class="text-sm font-medium text-foreground">{t("todo_empty_list")}</Text>
                  <Text class="text-xs text-muted-foreground">{t("todo_empty_list_hint")}</Text>
                </View>
                <Icon name="PhPlus" size={15} color="subtle" />
              </BaseButton>
            </If>
          }
        >
          <View class="gap-1" role={props.mobile ? undefined : "list"}>
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
                  testID={`todo-item-${task().id}`}
                  onPress={() => state.selectTask(task())}
                />
              )}
            </Each>
          </View>
        </If>
      </Scroll>
    </View>
  );
}
