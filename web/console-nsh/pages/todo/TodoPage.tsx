// The TODO page (web/console/src/views/TodoView.js): scheduled and manual agent tasks. A list (or
// the calendar) at the left, the selected item's editor at the right; on phones one at a time, with
// a back button over the editor and the floating add button over the list.
import { effect, Scroll, Text, untracked, View } from "nsh";
import { translate } from "../../lib/core/context.js";
import { isMobile } from "../../lib/shell";
import { Button, Fab, type MessageAction, MessageDialog, Page } from "../../components/ui";
import { WorkspaceDirPickerDialog } from "../../components/shared/WorkspaceDirPickerDialog";
import { TodoCalendar } from "../../components/todo/TodoCalendar";
import { TodoHeartbeatEditor } from "../../components/todo/TodoHeartbeatEditor";
import { TodoIndex } from "../../components/todo/TodoIndex";
import { TodoTaskEditor } from "../../components/todo/TodoTaskEditor";
import { createTodoState, type TodoState, type TodoTask } from "../../components/todo/todo-state";
import { TODO_TOPIC_ERROR, TODO_TOPIC_READY, TODO_TOPIC_UNAVAILABLE } from "../../lib/core/todo-topic.js";

const t = translate as (key: string, vars?: Record<string, unknown> | null) => string;

function CalendarDayDetail(props: { state: TodoState }) {
  const state = props.state;
  return (
    <View
      class="gap-3 rounded-(--radius) border border-line-faint bg-card p-4"
      accessibilityLabel={t("todo_calendar_agenda")}
      testID="todo-day-detail"
    >
      <View class="gap-0.5">
        <Text class="text-base font-semibold text-foreground">{state.selectedCalendarDateTitle()}</Text>
        <Text class="text-xs text-muted-foreground">
          {t("todo_calendar_item_count", { count: state.selectedCalendarTasks().length })}
        </Text>
      </View>
      <If
        when={state.selectedCalendarTasks().length > 0}
        else={<Text class="text-xs text-muted-foreground">{t("todo_calendar_day_empty")}</Text>}
      >
        <View class="gap-1">
          <Each of={state.selectedCalendarTasks()} key={(task: TodoTask) => task._key}>
            {(task) => (
              <Button
                variant="plain"
                block
                class="justify-start py-1"
                title={state.taskTitle(task())}
                testID={`todo-day-item-${task().id}`}
                onPress={() => state.selectTask(task())}
              >
                <View class="flex-1 flex-row items-center gap-2">
                  <View class={`size-1.5 ${task().enabled === false ? "border border-status-off" : "bg-status-on"}`} />
                  <View class="flex-1 gap-0.5">
                    <Text
                      class={`text-sm line-clamp-1 ${task().enabled === false ? "text-muted-foreground" : "text-foreground"}`}
                    >
                      {state.taskTitle(task())}
                    </Text>
                    <Text class="text-xs text-muted-foreground line-clamp-1">{state.scheduleLabel(task())}</Text>
                  </View>
                </View>
              </Button>
            )}
          </Each>
        </View>
      </If>
    </View>
  );
}

function Placeholder(props: { state: TodoState }) {
  const state = props.state;
  return (
    <View class="items-start gap-3 p-5" testID="todo-placeholder">
      <View class="gap-1">
        <Text class="text-lg font-semibold text-foreground">{t("todo_detail_empty_title")}</Text>
        <Text class="text-sm text-muted-foreground">{t("todo_detail_empty_hint")}</Text>
      </View>
      <Button
        variant="primary"
        icon="PhPlus"
        label={t("todo_action_add")}
        disabled={state.loading() || state.saving()}
        testID="todo-placeholder-add"
        onPress={state.addTask}
      />
    </View>
  );
}

/** What the editor side shows, in the Vue template's order. */
function EditorPane(props: { state: TodoState }) {
  const state = props.state;
  const mode = () => {
    if (!state.showEditorPane()) return "none";
    if (!state.calendarView() && state.heartbeatSelected()) return "heartbeat";
    if (state.selectedTask()) return "task";
    if (state.calendarView() && state.selectedCalendarDate()) return "day";
    return "placeholder";
  };
  return (
    <Scroll class="flex-1" contentClass={`gap-4 ${isMobile() ? "p-4 pb-24" : "p-5"}`}>
      <If when={mode() === "heartbeat"}>
        <TodoHeartbeatEditor state={state} />
      </If>
      <If when={mode() === "task"}>
        <View class="rounded-(--radius) border border-line-faint bg-card p-4">
          <TodoTaskEditor state={state} />
        </View>
      </If>
      <If when={mode() === "day"}>
        <CalendarDayDetail state={state} />
      </If>
      <If when={mode() === "placeholder"}>
        <Placeholder state={state} />
      </If>
    </Scroll>
  );
}

function Calendar(props: { state: TodoState; mobile?: boolean }) {
  const state = props.state;
  return (
    <TodoCalendar
      mobile={props.mobile}
      tasks={state.tasks()}
      tasksLoading={state.loading()}
      taskTitle={state.taskTitle}
      scheduleLabel={state.scheduleLabel}
      onAddTask={state.addTask}
      onSelectDate={state.selectCalendarDate}
      onSelectTask={state.selectTask}
      onShowList={() => state.setTodoView("list")}
    />
  );
}

export function TodoPage() {
  const state = createTodoState();
  effect(() => untracked(() => void state.start()));

  const runDialogActions = (): MessageAction[] => {
    const dialog = state.runDialog();
    const dismiss: MessageAction = { id: "dismiss", label: t("action_close"), variant: "outlined", onPress: state.closeRunDialog };
    if (dialog.status === TODO_TOPIC_READY) {
      return [dismiss, { id: "open", label: t("todo_action_open_topic"), variant: "primary", onPress: state.openRunDialogTopic }];
    }
    if (dialog.status === "checking") {
      return [dismiss, { id: "open", label: t("todo_action_open_topic"), variant: "primary", loading: true }];
    }
    if (dialog.status === TODO_TOPIC_UNAVAILABLE || dialog.status === TODO_TOPIC_ERROR) {
      return [
        dismiss,
        { id: "retry", label: t("todo_run_dialog_check_again"), variant: "primary", onPress: state.retryRunDialogTopic },
      ];
    }
    return [dismiss];
  };

  return (
    <Page
      title={t("todo_title")}
      hideBar={!isMobile() || !state.mobileShowBack()}
      scroll={false}
      testID="todo-page"
      leading={
        <View class="flex-1 flex-row items-center gap-2">
          <Button
            variant="plain"
            size="xs"
            iconOnly
            icon="PhArrowLeft"
            title={t("todo_nav_title")}
            testID="todo-back"
            onPress={state.showIndexView}
          />
          <Text class="flex-1 text-lg font-semibold text-foreground line-clamp-1" role="header">
            {state.mobileBarTitle()}
          </Text>
        </View>
      }
    >
      <If
        when={isMobile()}
        else={
          <View class="flex-1 flex-row">
            <If
              when={state.calendarView()}
              else={
                <View class="w-72 border-r border-line-faint bg-sidebar">
                  <TodoIndex state={state} />
                </View>
              }
            >
              <Scroll class="flex-1" contentClass="min-h-full p-4">
                <Calendar state={state} />
              </Scroll>
            </If>
            <View class={state.calendarView() ? "w-96 border-l border-line-faint" : "flex-1"}>
              <EditorPane state={state} />
            </View>
          </View>
        }
      >
        <View class="flex-1">
          <If when={state.showIndexPane()} else={<EditorPane state={state} />}>
            <If when={state.calendarView()} else={<TodoIndex state={state} mobile />}>
              <Scroll class="flex-1" contentClass="px-4 pb-24">
                <Calendar state={state} mobile />
              </Scroll>
            </If>
          </If>
          <If when={state.showIndexPane()}>
            <Fab
              label={t("todo_action_add")}
              disabled={state.loading() || state.saving()}
              testID="todo-fab"
              onPress={state.addTask}
            />
          </If>
        </View>
      </If>

      <WorkspaceDirPickerDialog
        open={state.workspacePickerOpen()}
        initialDir={state.selectedTask()?.workspace_dir ?? ""}
        title={t("todo_workspace_dir_dialog_title")}
        confirmLabel={t("todo_workspace_dir_choose")}
        onClose={state.closeWorkspacePicker}
        onConfirm={state.pickWorkspaceDir}
      />
      <MessageDialog
        open={state.deleteDialogOpen()}
        onClose={state.closeDeleteDialog}
        icon="PhTrash"
        tone="danger"
        title={t("action_delete")}
        text={state.deleteDialogText()}
        testID="todo-delete-dialog"
        actions={[
          { id: "cancel", label: t("action_cancel"), variant: "outlined", onPress: state.closeDeleteDialog },
          { id: "delete", label: t("action_delete"), variant: "danger", onPress: () => void state.deleteSelectedTask() },
        ]}
      />
      <MessageDialog
        open={state.runDialogOpen()}
        onClose={state.closeRunDialog}
        icon="PhTimer"
        title={t("todo_run_dialog_title")}
        text={state.runDialogText()}
        testID="todo-run-dialog"
        actions={runDialogActions()}
      />
    </Page>
  );
}
