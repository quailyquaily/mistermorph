// The TODO page: scheduled and manual agent tasks. The list is a page of its own and an item opens
// in its place, behind a back button, on a desktop as on a phone (where the list also has the
// floating add button). Only the desktop calendar keeps the selected item beside it.
import { effect, keyboardFrame, Scroll, signal, Text, untracked, View, windowSize } from "nsh";
import { translate } from "../../lib/core/context.js";
import { useScrollMemory } from "../../lib/scrollMemory";
import { isMobile, markMobileDetail } from "../../lib/shell";
import { onSystemBack } from "../../lib/systemBack";
import { BackButton, Button, Fab, type MessageAction, MessageDialog, Page, PageBar, PageTitle } from "../../components/ui";
import { createPaneStack } from "../../components/motion/PaneStack";
import { WorkspaceDirPickerDialog } from "../../components/shared/WorkspaceDirPickerDialog";
import { TodoCalendar } from "../../components/todo/TodoCalendar";
import { calendarDay, TodoDayList } from "../../components/todo/TodoDayList";
import { TodoHeartbeatEditor } from "../../components/todo/TodoHeartbeatEditor";
import { TodoRuns } from "../../components/todo/TodoRuns";
import { TodoFlow } from "../../components/todo/TodoFlow";
import { TodoIndex, TODO_HEAD_HEIGHT } from "../../components/todo/TodoIndex";
import { TodoViewRule, todoViewRuleColor, todoViewSagCenter, TodoViewTabs } from "../../components/todo/TodoViewTabs";
import { gutterX, gutterY } from "../../components/frame/metrics";
import { Entrance, SCROLLBAR } from "../../components/motion";
import { TodoEnabledSwitch, todoRunsBeside, TodoJobToolbar, TodoTaskEditor, todoToolbarAtFoot } from "../../components/todo/TodoTaskEditor";
import { createTodoState, type TodoState, type TodoTask } from "../../components/todo/todo-state";
import { TODO_TOPIC_ERROR, TODO_TOPIC_READY, TODO_TOPIC_UNAVAILABLE } from "../../lib/core/todo-topic.js";
import { BarRoom, underBar } from "../../components/frame/glassBar";
import { BAR_BELOW, MobileBarSpacer } from "../../components/frame/mobileBar";

const t = translate as (key: string, vars?: Record<string, unknown> | null) => string;

/**
 * The calendar's chosen day in its side column: every run of the day, in full (the grid's cells
 * fold the repeating ones). The calendar works the day out and leaves it in `calendarDay(state)`;
 * a run opens its job here, in the day's place.
 */
function CalendarDayDetail(props: { state: TodoState; panel?: boolean }) {
  const state = props.state;
  const openJob = (jobId: string) => {
    const task = state.tasks().find((item: TodoTask) => item.id === jobId);
    if (task) state.selectTask(task);
  };
  return (
    // Beside the grid it is the list's Today column: as wide, under the same head room, with the
    // same gutters (the column's own 8pt margin taken off).
    <View style={{ paddingTop: props.panel ? TODAY_TOP - 8 : 0, paddingHorizontal: props.panel ? 8 : 0 }}>
      <TodoDayList day={calendarDay(state)() ?? null} mobile={!props.panel} onOpen={openJob} />
    </View>
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

/** Where Today starts beside the list: under the list's head, level with its composer. */
const TODAY_TOP = 76;
/** The column of runs beside the list and the calendar. */
const TODAY_WIDTH = 330;

/** The open item's column on a desktop page: wide enough for the form, no wider than a page of text. */
export const DETAIL_MAX_WIDTH = 1180;

/** What the editor side shows, in the Vue template's order. */
/** `page`: on a desktop, the open item as a page of its own (the list is behind its back arrow). */
function EditorPane(props: { state: TodoState; mobile?: boolean; page?: boolean }) {
  const state = props.state;
  const mode = () => {
    if (!state.showEditorPane()) return "none";
    if (!state.calendarView() && state.heartbeatSelected()) return "heartbeat";
    if (state.selectedTask()) return "task";
    if (state.calendarView() && state.selectedCalendarDate()) return "day";
    return "placeholder";
  };
  // In the calendar's side column the card is a panel inset 8 all round and scrolls within the
  // column; beside the list it is a framed box inset 8 at the top, right and bottom and none at the
  // left, so its frame meets the list's column as the sidebar's frame does on the other side, and
  // the rows sit the list's 16pt gutter from each (Contacts likewise); on phones 16 all round.
  const panel = () => !props.mobile && state.calendarView();
  const margin = () =>
    props.mobile
      ? { margin: 16, marginBottom: 96 }
      : props.page
        ? // The column is centred within the page's gutters (padding, so a full-width column keeps them).
          { paddingVertical: gutterY(), paddingHorizontal: gutterX(), alignItems: "center" as const }
        : panel()
          ? { margin: 8 }
          : { marginTop: 8, marginRight: 8, marginBottom: 8 };
  // Under a bar of its own: on a phone, and as a page on a desktop.
  const barred = () => !!props.mobile || !!props.page;
  // What it shows: an item of the list or a day of the calendar (the entrance plays for a new one).
  const shown = () => `${mode()}:${state.selectedTaskKey() ?? ""}:${state.selectedCalendarDate() ?? ""}`;
  // Where it is scrolled, across visits of the page, for as long as it shows the same item.
  const memory = useScrollMemory({
    column: 3,
    area: "editor",
    selection: () => (mode() === "none" || mode() === "placeholder" ? "" : shown()),
  });
  return (
    <If when={mode() !== "placeholder"} else={<Placeholder state={state} mobile={props.mobile} />}>
      {/* On a phone the editor runs on under its bar where the bar is glass. */}
      <Scroll
        class="flex-1"
        scrollbar={SCROLLBAR}
        contentClass="min-h-full"
        style={barred() ? underBar() : undefined}
        ref={memory.ref}
        onScroll={memory.onScroll}
      >
        <If when={barred()}>
          <BarRoom />
        </If>
        <Entrance watch={shown()} class="flex-1" rise={4}>
          <View class="flex-1" style={margin()}>
            <View class="w-full flex-1" style={{ maxWidth: props.page ? DETAIL_MAX_WIDTH : undefined }}>
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
          </View>
        </Entrance>
        <MobileBarSpacer />
      </Scroll>
    </If>
  );
}

/** `split`: the day's runs or an open job stand in a column beside it. */
function Calendar(props: { state: TodoState; mobile?: boolean; split?: boolean }) {
  const state = props.state;
  // The page's live runs (/todo/runs, which the state polls) as one value: when a run starts,
  // moves on or ends, the calendar reads the run history again.
  const liveKey = () =>
    state
      .tasks()
      .map((task: TodoTask) => {
        const run = state.taskRun(task);
        return run ? `${task.id}:${run.state}:${run.runID}` : "";
      })
      .filter(Boolean)
      .join("|");
  return (
    <TodoCalendar
      mobile={props.mobile}
      tasks={state.tasks()}
      tasksLoading={state.tasksPending()}
      taskTitle={state.taskTitle}
      liveKey={liveKey()}
      // The hairline toward the day's list; an open job there is a framed card of its own.
      divider={Boolean(props.split) && !state.selectedTask()}
      onAddTask={state.addTask}
      onSelectDate={state.selectCalendarDate}
      onSelectTask={state.selectTask}
      onView={state.setTodoView}
      flow={state.flowAvailable()}
      onDay={(day) => calendarDay(state).set(day)}
    />
  );
}

export function TodoPage() {
  const state = createTodoState();
  // Android's Back from an open task goes to the list, as the bar's back arrow does.
  onSystemBack(
    () => state.mobileShowBack(),
    () => state.showIndexView(),
  );
  // An open task is not the navigation's page: the bottom navigation steps aside.
  markMobileDetail(() => state.mobileShowBack());
  effect(() => untracked(() => void state.start()));
  // The list (0) and a task (1) are levels of the page. On phones they slide (PaneStack) and the
  // task keeps its bar while it goes out; on a desktop they swap at once.
  const panes = createPaneStack(() => (isMobile() ? (state.showIndexPane() ? 0 : 1) : null));
  const barTitle = panes.held(1, () => state.mobileBarTitle());

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

  // The flow's head ends its row where the list's does; measured for its hairline's dip.
  const flowHeadWidth = signal(0);
  const flowSide = () => (state.sideRoom() ? TODAY_WIDTH : 0);
  // Where the calendar is scrolled, across visits of the page (the list keeps its own, TodoIndex).
  const calendarMemory = useScrollMemory({ column: 2, area: "calendar" });
  return (
    // The phone's bar belongs to the task (it slides with it), below.
    <Page title={t("todo_title")} hideBar scroll={false} testID="todo-page">
      {/* Where the list's changes stand (todo-state's saveState), drawn as nothing: tests wait on it. */}
      <View class="absolute size-px" style={{ pointerEvents: "none" }} testID={`todo-save-${state.saveState()}`} />
      {/* The list and an open item take turns (a phone slides between them; a desktop swaps them).
          Only the desktop calendar keeps the open item beside it. */}
      <If
        when={!state.flowView()}
        else={
          // The flow of jobs into each other: one of the page's views, under the same head as the
          // list's and the calendar's (the title, then the views' tabs).
          <View class="flex-1" testID="todo-flow-page">
            <View
              // Its hairline is drawn (TodoViewRule), dipping under the flow's tab; it draws over the graph for the dip.
              class="relative z-10 flex-row items-center gap-2 border-b border-transparent"
              onLayout={(event) => flowHeadWidth.set(event.bounds.size.width)}
              // The row ends where the list's head ends (before the room of its Today column):
              // the views' tabs keep their place.
              style={{ height: TODO_HEAD_HEIGHT, paddingLeft: gutterX(), paddingRight: gutterX() + flowSide() }}
            >
              <Text class="min-w-0 flex-1 text-xl font-normal leading-[24px] tracking-[-0.6px] text-foreground" role="header" style={{ numberOfLines: 1 }}>
                {t("todo_title")}
              </Text>
              <TodoViewTabs value="flow" flow mobile={isMobile()} onChange={state.setTodoView} />
              <TodoViewRule
                center={() => todoViewSagCenter("flow", true, isMobile(), flowHeadWidth(), gutterX() + flowSide())}
                color={todoViewRuleColor("line-soft")}
              />
            </View>
            <View class="flex-1">
              <TodoFlow
                jobs={state.flow.jobs()}
                mobile={isMobile()}
                busy={state.saving() || state.loading()}
                onOpenJob={state.flow.openJob}
                onAddUse={state.flow.addUse}
                onRemoveUse={state.flow.removeUse}
                onSetJoin={state.flow.setJoin}
              />
            </View>
          </View>
        }
      >
      <If
        when={state.calendarSplit()}
        else={
          <View class="flex-1">
            <If when={panes.shown(0, state.showIndexPane())}>
              <View
                class="flex-1"
                style={panes.style(0)}
                accessibilityElementsHidden={panes.hidden(0) || undefined}
                importantForAccessibility={panes.hidden(0) ? "no-hide-descendants" : undefined}
              >
                <If
                  when={state.calendarView()}
                  else={
                    <View class="flex-1 flex-row">
                      <View class="min-w-0 flex-1">
                        <TodoIndex state={state} mobile={isMobile()} />
                      </View>
                      {/* What ran today and why, beside the list where there is room. */}
                      <If when={state.sideRoom()}>
                        <Scroll class="w-[330px] border-l border-line-soft" scrollbar={SCROLLBAR} contentClass="px-4 pb-10" style={{ paddingTop: TODAY_TOP }}>
                          <TodoRuns title={t("todo_runs_today")} jobTitle={state.jobTitle} watch={state.liveRuns} onOpenJob={state.openJob} testID="todo-today" />
                        </Scroll>
                      </If>
                    </View>
                  }
                >
                  {/* A phone's calendar, or a desktop's without room for the runs beside it: the grid alone. */}
                  <Scroll class="flex-1" scrollbar={SCROLLBAR} contentClass={isMobile() ? "pb-24" : "min-h-full"} ref={calendarMemory.ref} onScroll={calendarMemory.onScroll}>
                    <Calendar state={state} mobile={isMobile()} />
                    <MobileBarSpacer />
                  </Scroll>
                </If>
              </View>
            </If>
            <If when={panes.shown(1, !state.showIndexPane())}>
              <View
                class="flex-1 flex-row"
                style={panes.style(1)}
                accessibilityElementsHidden={panes.hidden(1) || undefined}
                importantForAccessibility={panes.hidden(1) ? "no-hide-descendants" : undefined}
              >
                <View class="min-w-0 flex-1">
                <PageBar
                  glass
                  leading={
                    // The bar is the page's column (the title field's width): back and the open
                    // job's switch at its left, the toolbar at its right (on a phone the toolbar
                    // floats at the page's foot). A job is named by its title field, below, not
                    // here; Heartbeat, which has none, is.
                    <View class="flex-1 flex-row justify-center">
                      <View class="w-full flex-row items-center gap-3" style={{ maxWidth: isMobile() ? undefined : DETAIL_MAX_WIDTH }} testID="todo-bar-row">
                        <BackButton title={t("todo_nav_title")} testID="todo-back" onPress={state.showIndexView} />
                        <If when={state.selectedTask()} else={<PageTitle text={barTitle()} />}>
                          <TodoEnabledSwitch state={state} />
                          <View class="flex-1" />
                          <If when={!todoToolbarAtFoot()}>
                            <TodoJobToolbar state={state} compact />
                          </If>
                        </If>
                      </View>
                    </View>
                  }
                />
                <EditorPane state={state} mobile={isMobile()} page={!isMobile()} />
                {/* A phone: the open job's toolbar floats at the page's foot, where the bottom
                    navigation does on the list (it steps aside for an open job). Not over the keyboard. */}
                <If when={todoToolbarAtFoot() && state.selectedTask() && keyboardFrame().height <= 0}>
                  <View class="absolute left-0 right-0 items-center" style={{ bottom: BAR_BELOW, pointerEvents: "box-none" }} testID="todo-foot-bar">
                    <TodoJobToolbar state={state} />
                  </View>
                </If>
                </View>
                {/* The job's runs, where the list has what ran today: the same column (as wide,
                    behind the same hairline, under the same head room). */}
                <If when={todoRunsBeside(state)}>
                  <Scroll class="w-[330px] border-l border-line-soft" scrollbar={SCROLLBAR} contentClass="px-4 pb-10" style={{ paddingTop: TODAY_TOP }}>
                    <TodoRuns
                      jobID={state.selectedTask()?.id}
                      title={t("todo_runs_title")}
                      jobTitle={state.jobTitle}
                      watch={state.liveRuns}
                      onAvailable={(available) => state.jobRunsAvailable.set(available)}
                    />
                  </Scroll>
                </If>
              </View>
            </If>
            <If when={isMobile() && state.showIndexPane()}>
              <Fab
                label={t("todo_action_add")}
                disabled={state.loading() || state.saving()}
                testID="todo-fab"
                onPress={state.addTask}
              />
            </If>
          </View>
        }
      >
        {/* The calendar and its side column share the page's height, 1.45 : 0.55 (360 at least). */}
        {/* No gap between them: the calendar's pane is as wide as the list's beside its Today column. */}
        <View class="flex-1 flex-row">
          <Scroll class="flex-1" scrollbar={SCROLLBAR} contentClass="min-h-full" ref={calendarMemory.ref} onScroll={calendarMemory.onScroll}>
            <Calendar state={state} />
            <MobileBarSpacer />
          </Scroll>
          {/* The day's runs are the list's Today column (as wide, behind the same hairline); an
              open job's card takes the room its form needs. */}
          {/* As wide with a job's card in it, so the calendar and its head keep their place. */}
          <View class={`w-[330px] ${state.selectedTask() ? "" : "border-l border-line-soft"}`}>
            <EditorPane state={state} />
          </View>
        </View>
      </If>
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
