// The TODO page (web/console/src/views/TodoView.js): scheduled and manual agent tasks. A list (or
// the calendar) at the left, the selected item's editor at the right; on phones one at a time, with
// a back button over the editor and the floating add button over the list.
import { effect, Scroll, Text, untracked, View, windowSize } from "nsh";
import { Button as BaseButton } from "nsh/base";
import { translate } from "../../lib/core/context.js";
import { isMobile } from "../../lib/shell";
import { Button, Fab, type MessageAction, MessageDialog, Page, PageTitle } from "../../components/ui";
import { WorkspaceDirPickerDialog } from "../../components/shared/WorkspaceDirPickerDialog";
import { TodoCalendar } from "../../components/todo/TodoCalendar";
import { TodoHeartbeatEditor } from "../../components/todo/TodoHeartbeatEditor";
import { ROW_TRANSITION, TODO_INDEX_WIDTH, TodoIndex } from "../../components/todo/TodoIndex";
import { TodoCard } from "../../components/todo/TodoCard";
import { gutterX, gutterY } from "../../components/frame/metrics";
import { Entrance, FadeText, SCROLLBAR } from "../../components/motion";
import { TodoTaskEditor } from "../../components/todo/TodoTaskEditor";
import { createTodoState, type TodoState, type TodoTask } from "../../components/todo/todo-state";
import { TODO_TOPIC_ERROR, TODO_TOPIC_READY, TODO_TOPIC_UNAVAILABLE } from "../../lib/core/todo-topic.js";

const t = translate as (key: string, vars?: Record<string, unknown> | null) => string;

/** The selected day's TODOs in the calendar's side column (the Vue page's day detail card). */
function CalendarDayDetail(props: { state: TodoState; panel?: boolean }) {
  const state = props.state;
  return (
    <TodoCard
      panel={props.panel}
      list
      title={state.selectedCalendarDateTitle()}
      meta={t("todo_calendar_item_count", { count: state.selectedCalendarTasks().length })}
      accessibilityLabel={t("todo_calendar_agenda")}
      testID="todo-day-detail"
    >
      <If
        when={state.selectedCalendarTasks().length > 0}
        else={<Text class="px-1 py-[18px] text-xs text-muted-foreground">{t("todo_calendar_day_empty")}</Text>}
      >
        <View>
          <Each of={state.selectedCalendarTasks()} key={(task: TodoTask) => task._key}>
            {(task, index) => (
              <BaseButton
                onPress={() => state.selectTask(task())}
                accessibilityLabel={state.taskTitle(task())}
                testID={`todo-day-item-${task().id}`}
                // Rows on hairlines (`.todo-calendar-day-detail-item`): a 7pt status square, the
                // name in 14pt semibold, the schedule in mono; the last row drops its rule.
                class={`flex-row items-center gap-2.5 px-1 py-[13px] hover:bg-blue/5 ${
                  index() < state.selectedCalendarTasks().length - 1 ? "border-b border-line-soft" : ""
                }`}
                style={ROW_TRANSITION}
              >
                <View class={`size-[7px] ${task().enabled === false ? "bg-muted-foreground" : "bg-blue"}`} />
                <View class="flex-1 gap-[3px]">
                  <FadeText
                    text={state.taskTitle(task())}
                    class={`text-sm font-semibold ${task().enabled === false ? "text-muted-foreground" : "text-foreground"}`}
                  />
                  <Text class="font-mono text-xs leading-[16.8px] text-muted-foreground">{state.scheduleLabel(task())}</Text>
                </View>
              </BaseButton>
            )}
          </Each>
        </View>
      </If>
    </TodoCard>
  );
}

/** Nothing selected (`.todo-placeholder`): centred in the pane, the title, a note and Add TODO. */
function Placeholder(props: { state: TodoState; mobile?: boolean }) {
  const state = props.state;
  const height = () => windowSize().height;
  const width = () => windowSize().width;
  return (
    <View
      class="flex-1 items-center justify-center"
      testID="todo-placeholder"
      style={{
        marginTop: props.mobile ? 0 : gutterY(),
        marginRight: gutterX(),
        marginBottom: gutterY(),
        marginLeft: props.mobile ? gutterX() : 0,
        // clamp(28px, 8vh, 88px) clamp(18px, 4vw, 64px)
        paddingVertical: Math.min(88, Math.max(28, height() * 0.08)),
        paddingHorizontal: Math.min(64, Math.max(18, width() * 0.04)),
      }}
    >
      <View class="w-full max-w-xl items-center gap-2">
        <Text class="max-w-55 text-center text-xl font-normal leading-[24px] tracking-[-0.6px] text-foreground" role="header">
          {t("todo_detail_empty_title")}
        </Text>
        <Text class="max-w-[34rem] text-center text-base leading-[25.9px] text-subtle">{t("todo_detail_empty_hint")}</Text>
      </View>
      <View class="mt-4 flex-row items-center justify-center gap-2">
        <Button
          variant="primary"
          size="md"
          icon="PhPlus"
          label={t("todo_action_add")}
          disabled={state.loading() || state.saving()}
          testID="todo-placeholder-add"
          onPress={state.addTask}
        />
      </View>
    </View>
  );
}

/** What the editor side shows, in the Vue template's order. */
function EditorPane(props: { state: TodoState; mobile?: boolean }) {
  const state = props.state;
  const mode = () => {
    if (!state.showEditorPane()) return "none";
    if (!state.calendarView() && state.heartbeatSelected()) return "heartbeat";
    if (state.selectedTask()) return "task";
    if (state.calendarView() && state.selectedCalendarDate()) return "day";
    return "placeholder";
  };
  // In the calendar's side column the card is a panel inset 8 all round and scrolls within the
  // column; beside the list it is a framed box (margin 8 8 8 16), on phones 16 all round.
  const panel = () => !props.mobile && state.calendarView();
  const margin = () =>
    props.mobile ? { margin: 16, marginBottom: 96 } : panel() ? { margin: 8 } : { marginTop: 8, marginRight: 8, marginBottom: 8, marginLeft: 16 };
  return (
    <If when={mode() !== "placeholder"} else={<Placeholder state={state} mobile={props.mobile} />}>
      <Scroll class="flex-1" scrollbar={SCROLLBAR} contentClass="min-h-full">
        <Entrance watch={`${mode()}:${state.selectedTaskKey() ?? ""}:${state.selectedCalendarDate() ?? ""}`} class="flex-1" rise={4}>
          <View class="flex-1" style={margin()}>
            <If when={mode() === "heartbeat"}>
              <TodoHeartbeatEditor state={state} />
            </If>
            <If when={mode() === "task"}>
              <TodoTaskEditor state={state} panel={panel()} />
            </If>
            <If when={mode() === "day"}>
              <CalendarDayDetail state={state} panel={panel()} />
            </If>
          </View>
        </Entrance>
      </Scroll>
    </If>
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
          <PageTitle text={state.mobileBarTitle()} />
        </View>
      }
    >
      <If
        when={isMobile()}
        else={
          <If
            when={state.calendarView()}
            else={
              // The list's column (310) and the editor beside it, 4 apart (the workbench's gap).
              <View class="flex-1 flex-row gap-1">
                <View style={{ width: TODO_INDEX_WIDTH }}>
                  <TodoIndex state={state} />
                </View>
                <View class="flex-1">
                  <EditorPane state={state} />
                </View>
              </View>
            }
          >
            {/* The calendar and its side column share the page's height, 1.45 : 0.55 (360 at least). */}
            <View class="flex-1 flex-row gap-1">
              <Scroll class="flex-[1.45]" scrollbar={SCROLLBAR} contentClass="min-h-full">
                <Calendar state={state} />
              </Scroll>
              <View class="min-w-90 flex-[0.55]">
                <EditorPane state={state} />
              </View>
            </View>
          </If>
        }
      >
        <View class="flex-1">
          <If when={state.showIndexPane()} else={<EditorPane state={state} mobile />}>
            <If when={state.calendarView()} else={<TodoIndex state={state} mobile />}>
              <Scroll class="flex-1" scrollbar={SCROLLBAR} contentClass="pb-24">
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
