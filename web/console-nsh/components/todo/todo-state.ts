// The TODO page's state and actions, ported from the setup of web/console/src/views/TodoView.js.
// One instance per page (createTodoState runs in the page's body, so its effects and timers go with
// the page). Tasks are replaced, never mutated: an edit copies the task, applies the model's editing
// function to the copy, and stores it as the draft (or in the list).
import { batch, cleanup, computed, effect, signal, untracked } from "nsh";
import {
  endpointState,
  runtimeApiFetch,
  runtimeApiFetchForEndpoint,
  runtimeEndpointByRef,
  translate,
} from "../../lib/core/context.js";
import { endpointRoutePath } from "../../lib/core/endpoint-routes.js";
import { createArrivalTracker, createHighlightWindow } from "../../lib/core/arrivals.js";
import { pushNotice } from "../../lib/core/notices.js";
import { rememberRecentWorkspaceDir } from "../../lib/core/recent-workspace-dirs.js";
import { invalidateConsoleSetupReadiness } from "../../lib/core/setup.js";
import { requestSystemNotificationPermission } from "../../lib/core/system-notifications.js";
import { normalizeTodoRuns, todoRunsSignature, TODO_RUN_RUNNING } from "../../lib/core/todo-runs.js";
import {
  findTodoTopic,
  todoTopicChatPath,
  todoTopicsEndpointRef,
  waitForTodoTopic,
  TODO_TOPIC_CANCELLED,
  TODO_TOPIC_ERROR,
  TODO_TOPIC_READY,
  TODO_TOPIC_UNAVAILABLE,
} from "../../lib/core/todo-topic.js";
import { modelVendorMeta } from "../../lib/core/model-vendor.js";
import { isVisible } from "../../lib/platform";
import { currentRoute, locationOf, navigate } from "../../lib/router";
import { isMobile } from "../../lib/shell";
import * as model from "./todo-model.js";

const t = translate as (key: string, vars?: Record<string, unknown> | null) => string;
const trimText = model.trimText as (value: unknown) => string;

/** A TODO item as the page edits it (normalizeTask's shape). */
export interface TodoTask {
  _key: string;
  id: string;
  title: string;
  enabled: boolean;
  at: string;
  cron: string;
  tz: string;
  content: string;
  chat_id: string;
  llm_profile: string;
  workspace_dir: string;
  bash_env: { name: string; value: string }[];
  last_run_at: string;
  last_run_status: string;
  mode: string;
  repeat_kind: string;
  repeat_time: string;
  repeat_weekdays: number[];
  repeat_month_day: string;
  custom_cron: string;
}

export interface TodoRun {
  state: string;
  manual: boolean;
  startedAt: string;
}

/** A dropdown entry of the timezone, schedule, model and chat pickers. */
export interface TodoMenuItem {
  id: string;
  title: string;
  value: string;
  subtitle?: string;
  image?: string;
  icon?: string;
}

export interface CalendarSelection {
  date: string;
  title: string;
  task_ids: string[];
  activate: boolean;
}

export interface RunDialogState {
  endpointRef: string;
  key: string;
  taskID: string;
  title: string;
  status: string;
  topicID: string;
  error: string;
}

export interface TaskActionItem {
  id: string;
  title?: string;
  disabled?: boolean;
  danger?: boolean;
  divider?: boolean;
  action?: () => void;
}

interface EditResult {
  changed: boolean;
  refresh: boolean;
}

type Editor = (task: TodoTask) => EditResult | void | undefined;

function emptyRunDialog(): RunDialogState {
  return { endpointRef: "", key: "", taskID: "", title: "", status: "", topicID: "", error: "" };
}

function errorMessage(error: unknown) {
  return trimText((error as { message?: string } | null)?.message);
}

const notice = {
  error: (text: string) => pushNotice({ type: "error", text }),
  success: (text: string) => pushNotice({ type: "success", text }),
};


/** One heartbeat workflow as the editor holds it; `_key` stays while `id` is empty for a new one. */
export type HeartbeatWorkflow = { _key: string; id: string; title: string; instructions: string; enabled: boolean };

let heartbeatWorkflowSeq = 0;

function heartbeatWorkflowFrom(item: any): HeartbeatWorkflow {
  const id = typeof item?.id === "string" ? item.id.trim() : "";
  heartbeatWorkflowSeq += 1;
  return {
    _key: id || `new-workflow-${heartbeatWorkflowSeq}`,
    id,
    title: typeof item?.title === "string" ? item.title : "",
    instructions: typeof item?.instructions === "string" ? item.instructions : "",
    enabled: item?.enabled !== false,
  };
}

export function createTodoState() {
  const loading = signal(false);
  const saving = signal(false);
  const tasks = signal<TodoTask[]>([]);
  // A task added to the list flashes where it lands; loads and agent switches do not.
  const taskArrivals = createArrivalTracker({ edge: "any" });
  const arrivedTasks = createHighlightWindow(1800);
  const arrivedTick = signal(0);
  const persistedTaskSignatures = signal<Map<string, string>>(new Map());
  // TODO items the runtime is running or has queued now, by task ID; polled while the page is open.
  const taskRuns = signal<Map<string, TodoRun>>(new Map());
  let taskRunsSignature = "";
  const chatOptions = signal<any[]>([]);
  const llmDefaultRouteModel = signal("");
  const llmProfiles = signal<any[]>([]);
  const selectedTaskKey = signal("");
  const selectedTaskDraft = signal<TodoTask | null>(null);
  const selectedCalendarDate = signal("");
  const selectedCalendarDateTitle = signal("");
  const selectedCalendarTaskIDs = signal<string[]>([]);
  const draftDirty = signal(false);
  const tasksDirty = signal(false);
  const mobileEditorVisible = signal(false);
  const deleteDialogOpen = signal(false);
  const deleteTargetKey = signal("");
  const repeatInputRevision = signal(0);
  const heartbeatLoading = signal(false);
  const heartbeatSaving = signal(false);
  // The heartbeat's workflows (agent.db heartbeat_workflows), edited here and saved as one list.
  const heartbeatWorkflows = signal<HeartbeatWorkflow[]>([]);
  const heartbeatDirty = signal(false);
  const heartbeatTask = signal<TodoTask | null>(null);
  const heartbeatEnabled = signal(true);
  const runningTaskKey = signal("");
  // The selected item's topic, once the endpoint has it: { key, topicID }, key naming the
  // endpoint and item it was looked up for, so an answer about another one is not shown.
  const taskTopic = signal({ key: "", topicID: "" });
  let taskTopicLookupSeq = 0;
  // The dialog after a manual run is accepted. status is checking while it looks for the item's
  // topic, then ready, unavailable (not there in time), error, or none when the endpoint lists no
  // topics. It never requests another run.
  const runDialogOpen = signal(false);
  const runDialog = signal<RunDialogState>(emptyRunDialog());
  let runDialogLookup: AbortController | null = null;
  const workspacePickerOpen = signal(false);
  let disposed = false;

  const calendarView = () => trimText(currentRoute()?.query?.view).toLowerCase() === "calendar";

  effect(() => {
    const list = tasks();
    untracked(() => {
      const arrived = taskArrivals.update(
        list.map((task) => task._key),
        endpointState.selectedRef,
      );
      if (arrived.size > 0) {
        arrivedTasks.add(arrived);
        arrivedTick.update((n) => n + 1);
        // The flash ends with the highlight window.
        setTimeout(() => {
          if (!disposed) arrivedTick.update((n) => n + 1);
        }, 1900);
      }
    });
  });

  const heartbeatSelected = computed(() => selectedTaskKey() === model.HEARTBEAT_ITEM_KEY);
  const heartbeatDisabled = computed(() => heartbeatEnabled() === false);
  const selectedStoredTask = computed(() => tasks().find((task) => task._key === selectedTaskKey()) || null);
  const selectedTask = computed<TodoTask | null>(() =>
    heartbeatSelected()
      ? null
      : selectedTaskDraft()?._key === selectedTaskKey()
        ? selectedTaskDraft()
        : selectedStoredTask(),
  );

  function taskListDisplayTask(task: TodoTask) {
    const draft = selectedTaskDraft();
    if (task?._key === selectedTaskKey() && draft?._key === task._key) {
      return draft;
    }
    return task;
  }

  const orderedTasks = computed(() =>
    [...tasks()].sort((left, right) => {
      const leftDisabled = taskListDisplayTask(left)?.enabled === false;
      const rightDisabled = taskListDisplayTask(right)?.enabled === false;
      return Number(leftDisabled) - Number(rightDisabled);
    }),
  );
  const selectedCalendarTasks = computed(() => {
    const tasksByID = new Map(tasks().map((task) => [trimText(task?.id), task]));
    return selectedCalendarTaskIDs()
      .map((id) => tasksByID.get(id))
      .filter(Boolean) as TodoTask[];
  });
  const deleteTarget = computed(() => tasks().find((task) => task._key === deleteTargetKey()) || null);
  const taskHasLocalChanges = computed(() => tasksDirty() || draftDirty());
  const selectedTaskHasLocalChanges = computed(() => {
    const task = selectedTask();
    const key = task?._key;
    if (!key) {
      return false;
    }
    const persistedSignature = persistedTaskSignatures().get(key);
    if (persistedSignature === undefined) {
      return true;
    }
    return persistedSignature !== JSON.stringify(model.serializeTask(task, t("todo_untitled")));
  });
  const selectedSaveValidationMessage = computed(() => {
    const task = selectedTask();
    return task ? (model.taskValidationMessage(task) as string) : "";
  });
  const selectedTaskError = computed(() => {
    const task = selectedTask();
    return task ? (model.visibleTaskValidationMessage(task) as string) : "";
  });

  let lastValidationToast = "";
  effect(() => {
    const text = trimText(selectedTaskError());
    untracked(() => {
      if (!text) {
        lastValidationToast = "";
        return;
      }
      if (text === lastValidationToast) {
        return;
      }
      lastValidationToast = text;
      notice.error(text);
    });
  });

  const chatMenuItems = computed<TodoMenuItem[]>(() => model.chatMenuItems(chatOptions()));
  const llmProfileMenuItems = computed<TodoMenuItem[]>(() =>
    model.llmProfileMenuItems(llmDefaultRouteModel(), llmProfiles(), modelVendorMeta),
  );
  const heartbeatIndexMeta = computed(() => {
    if (loading() || heartbeatLoading()) {
      return t("todo_heartbeat_loading");
    }
    if (heartbeatDisabled()) {
      return t("todo_heartbeat_disabled");
    }
    const task = heartbeatTask();
    return task ? (model.schedulePreviewText(task) as string) : t("todo_schedule_missing");
  });
  const canSaveTasks = computed(
    () => !loading() && !saving() && taskHasLocalChanges() && !selectedSaveValidationMessage(),
  );
  const canSaveHeartbeat = computed(
    () =>
      heartbeatSelected() &&
      !heartbeatLoading() &&
      !heartbeatSaving() &&
      heartbeatDirty() &&
      heartbeatWorkflows().every((item) => trimText(item.title) !== ""),
  );
  const canSave = computed(() => (heartbeatSelected() ? canSaveHeartbeat() : canSaveTasks()));

  function taskRun(task: TodoTask | null | undefined) {
    const id = trimText(task?.id);
    return id ? taskRuns().get(id) || null : null;
  }

  function heartbeatRun() {
    return taskRuns().get(model.HEARTBEAT_ITEM_KEY) || null;
  }

  const canRunSelectedTask = computed(
    () =>
      Boolean(selectedStoredTask()) &&
      !heartbeatSelected() &&
      !loading() &&
      !saving() &&
      !runningTaskKey() &&
      !runDialogOpen() &&
      trimText(selectedStoredTask()?.id) !== "" &&
      !taskRun(selectedStoredTask()),
  );
  const canDuplicateSelectedTask = computed(
    () => Boolean(selectedTask()) && !heartbeatSelected() && !loading() && !saving(),
  );
  const showIndexPane = computed(() => !isMobile() || !mobileEditorVisible());
  const showEditorPane = computed(() => !isMobile() || mobileEditorVisible());
  const mobileShowBack = computed(() => isMobile() && mobileEditorVisible());
  const mobileBarTitle = computed(() =>
    mobileShowBack()
      ? heartbeatSelected()
        ? t("todo_heartbeat_title")
        : taskTitle(selectedTask()) || t("todo_detail_title")
      : calendarView()
        ? t("todo_view_calendar")
        : t("todo_title"),
  );
  const selectedIndex = computed(() => tasks().findIndex((task) => task._key === selectedTaskKey()));
  const selectedCanMoveUp = computed(() => selectedIndex() > 0);
  const selectedCanMoveDown = computed(() => selectedIndex() >= 0 && selectedIndex() < tasks().length - 1);

  const selectedTaskTopicKey = computed(() => {
    const task = selectedStoredTask();
    const id = trimText(task?.id);
    if (!task || !id || heartbeatSelected() || !persistedTaskSignatures().has(task._key)) {
      return "";
    }
    return model.taskTopicKey(endpointState.selectedRef, id) as string;
  });
  const selectedTaskTopicID = computed(() =>
    selectedTaskTopicKey() && taskTopic().key === selectedTaskTopicKey() ? taskTopic().topicID : "",
  );

  const taskActionMenuItems = computed<TaskActionItem[]>(() => [
    {
      id: "run-manually",
      title: t("todo_action_run_manually"),
      disabled: !canRunSelectedTask(),
      action: () => void runSelectedTaskNow(),
    },
    // There only once the item has a topic: viewing an item never creates one.
    ...(selectedTaskTopicID()
      ? [
          {
            id: "open-topic",
            title: t("todo_action_open_topic"),
            action: () => openTaskTopic(untracked(selectedTaskTopicID)),
          },
        ]
      : []),
    {
      id: "duplicate",
      title: t("todo_action_duplicate"),
      disabled: !canDuplicateSelectedTask(),
      action: duplicateSelectedTask,
    },
    {
      id: "move-up",
      title: t("todo_action_move_up"),
      disabled: saving() || loading() || !selectedCanMoveUp(),
      action: () => moveSelectedTask(-1),
    },
    {
      id: "move-down",
      title: t("todo_action_move_down"),
      disabled: saving() || loading() || !selectedCanMoveDown(),
      action: () => moveSelectedTask(1),
    },
    { id: "delete-divider", divider: true },
    {
      id: "delete",
      title: t("action_delete"),
      danger: true,
      disabled: saving() || loading(),
      action: confirmDeleteSelectedTask,
    },
  ]);

  const deleteDialogText = computed(() =>
    t("todo_delete_confirm", { title: taskTitle(deleteTarget() || selectedTask() || null) }),
  );

  const runDialogText = computed(() => {
    const dialog = runDialog();
    const queued = t("todo_run_dialog_text", { title: dialog.title || t("todo_untitled") });
    const detail = (
      {
        checking: t("todo_run_dialog_topic_checking"),
        [TODO_TOPIC_READY]: t("todo_run_dialog_topic_ready"),
        [TODO_TOPIC_UNAVAILABLE]: t("todo_run_dialog_topic_unavailable"),
        [TODO_TOPIC_ERROR]: t("todo_run_dialog_topic_error", { error: dialog.error || t("msg_load_failed") }),
      } as Record<string, string>
    )[dialog.status];
    return detail ? `${queued} ${detail}` : queued;
  });

  /* ---------- views and selection ---------- */

  effect(() => {
    if (!isMobile()) {
      untracked(() => mobileEditorVisible.set(false));
    }
  });

  function showIndexView() {
    mobileEditorVisible.set(false);
  }

  function setTodoView(view: "list" | "calendar") {
    mobileEditorVisible.set(false);
    const route = untracked(currentRoute);
    const query: Record<string, string> = { ...(route?.query || {}) };
    if (view === "calendar") {
      selectCalendarDate({ date: "", title: "", task_ids: [], activate: true });
      const now = new Date();
      query.view = "calendar";
      if (!/^\d{4}-\d{2}$/.test(trimText(query.month))) {
        query.month = `${now.getFullYear()}-${model.pad2(now.getMonth() + 1)}`;
      }
    } else {
      delete query.view;
      delete query.month;
    }
    void navigate(locationOf(route?.path || "/", query));
  }

  // One toggle switches between the list and the calendar.
  function toggleTodoView() {
    setTodoView(untracked(calendarView) ? "list" : "calendar");
  }

  function taskTitle(task: TodoTask | null | undefined): string {
    return model.taskTitle(task) as string;
  }

  function scheduleLabel(task: TodoTask | null | undefined): string {
    return model.schedulePreviewText(task) as string;
  }

  function isArrived(task: TodoTask) {
    return arrivedTick() >= 0 && arrivedTasks.has(task?._key);
  }

  function applyTaskRuns(raw: unknown) {
    const next = normalizeTodoRuns(raw) as Map<string, TodoRun>;
    const signature = todoRunsSignature(next);
    if (signature !== taskRunsSignature) {
      taskRunsSignature = signature;
      taskRuns.set(next);
    }
  }

  async function refreshTaskRuns() {
    if (!isVisible()) {
      return;
    }
    try {
      const data = await runtimeApiFetch("/todo/runs");
      if (!disposed) applyTaskRuns(data?.runs);
    } catch {
      // An older runtime has no /todo/runs; the list then shows no run state.
    }
  }

  function runStateLabel(run: TodoRun | null) {
    return run?.state === TODO_RUN_RUNNING ? t("todo_run_state_running") : t("todo_run_state_queued");
  }

  function openSelectedTaskDraft() {
    selectedTaskDraft.set(model.cloneTaskForDraft(untracked(selectedStoredTask)) as TodoTask | null);
    draftDirty.set(false);
  }

  function commitSelectedTaskDraft() {
    const draft = untracked(selectedTaskDraft);
    if (!draft || !untracked(draftDirty)) {
      return;
    }
    const list = untracked(tasks);
    const index = list.findIndex((task) => task._key === draft._key);
    batch(() => {
      if (index < 0) {
        selectedTaskDraft.set(null);
        draftDirty.set(false);
        return;
      }
      const nextTasks = [...list];
      nextTasks[index] = model.cloneTaskForDraft(draft) as TodoTask;
      tasks.set(nextTasks);
      selectedTaskDraft.set(model.cloneTaskForDraft(nextTasks[index]) as TodoTask);
      draftDirty.set(false);
      tasksDirty.set(true);
    });
  }

  /** Applies an editing function to a copy of the task and stores the copy. */
  function editTask(task: TodoTask | null | undefined, edit: Editor) {
    if (!task?._key) {
      return;
    }
    const draft = untracked(selectedTaskDraft);
    const isDraft = draft?._key === task._key;
    const current = isDraft ? draft : untracked(tasks).find((item) => item._key === task._key);
    if (!current) {
      return;
    }
    const copy = model.cloneTaskForDraft(current) as TodoTask;
    const result = (edit(copy) || model.EDIT_CHANGED) as EditResult;
    batch(() => {
      if (result.changed) {
        if (isDraft) {
          selectedTaskDraft.set(copy);
          draftDirty.set(true);
        } else {
          tasks.update((list) => list.map((item) => (item._key === copy._key ? copy : item)));
          tasksDirty.set(true);
        }
      }
      if (result.refresh) {
        repeatInputRevision.update((n) => n + 1);
      }
    });
  }

  function selectTask(task: TodoTask | null | undefined) {
    if (!task || !task._key) {
      return;
    }
    batch(() => {
      const changingSelection = task._key !== untracked(selectedTaskKey);
      if (changingSelection) {
        commitSelectedTaskDraft();
        selectedTaskKey.set(task._key);
        openSelectedTaskDraft();
      } else if (!untracked(selectedTaskDraft)) {
        openSelectedTaskDraft();
      }
      if (untracked(isMobile)) {
        mobileEditorVisible.set(true);
      }
    });
  }

  function selectCalendarDate(selection: Partial<CalendarSelection> | null) {
    batch(() => {
      selectedCalendarDate.set(trimText(selection?.date));
      selectedCalendarDateTitle.set(trimText(selection?.title));
      selectedCalendarTaskIDs.set(
        Array.isArray(selection?.task_ids) ? selection!.task_ids.map((id) => trimText(id)).filter(Boolean) : [],
      );
      if (selection?.activate !== true) {
        return;
      }
      commitSelectedTaskDraft();
      selectedTaskKey.set("");
      selectedTaskDraft.set(null);
      draftDirty.set(false);
      mobileEditorVisible.set(false);
    });
  }

  function selectHeartbeat() {
    batch(() => {
      if (untracked(heartbeatSelected)) {
        if (untracked(isMobile)) {
          mobileEditorVisible.set(true);
        }
        return;
      }
      commitSelectedTaskDraft();
      selectedTaskKey.set(model.HEARTBEAT_ITEM_KEY);
      selectedTaskDraft.set(null);
      draftDirty.set(false);
      if (untracked(isMobile)) {
        mobileEditorVisible.set(true);
      }
    });
  }

  function nextID() {
    const list = untracked(tasks);
    const used = new Set(list.map((task) => trimText(task.id)).filter(Boolean));
    let index = list.length + 1;
    let id = `task-${index}`;
    while (used.has(id)) {
      index += 1;
      id = `task-${index}`;
    }
    return id;
  }

  function addTask() {
    const task = model.normalizeTask({
      id: nextID(),
      title: t("todo_untitled"),
      at: model.defaultAtValue(),
      cron: "0 9 * * *",
      tz: model.browserUTCOffsetValue(),
      content: "",
    }) as TodoTask;
    batch(() => {
      tasks.update((list) => [...list, task]);
      tasksDirty.set(true);
      selectTask(task);
    });
  }

  function duplicateSelectedTask() {
    if (!untracked(canDuplicateSelectedTask)) {
      return;
    }
    batch(() => {
      // Retain the source draft locally; both items use the existing Save workflow.
      commitSelectedTaskDraft();
      const task = model.cloneTaskForDraft(untracked(selectedTask)) as TodoTask;
      task.id = nextID();
      task._key = model.nextTaskKey() as string;
      task.title = t("todo_copy_title", { title: taskTitle(task) });
      const nextTasks = [...untracked(tasks)];
      nextTasks.splice(untracked(selectedIndex) + 1, 0, task);
      tasks.set(nextTasks);
      tasksDirty.set(true);
      selectTask(task);
    });
  }

  function confirmDeleteSelectedTask() {
    const key = untracked(selectedTaskKey);
    if (!key) {
      return;
    }
    batch(() => {
      deleteTargetKey.set(key);
      deleteDialogOpen.set(true);
    });
  }

  function closeDeleteDialog() {
    batch(() => {
      deleteDialogOpen.set(false);
      deleteTargetKey.set("");
    });
  }

  function applyOptions(data: any) {
    chatOptions.set(model.normalizeChatOptions(data?.chat_options) as any[]);
    llmDefaultRouteModel.set(trimText(data?.llm_default_route?.model));
    llmProfiles.set(model.normalizeLLMProfiles(data?.llm_profiles) as any[]);
  }

  function signatures(list: TodoTask[]) {
    return new Map(list.map((task) => [task._key, JSON.stringify(model.serializeTask(task, t("todo_untitled")))]));
  }

  async function deleteSelectedTask() {
    if (untracked(saving)) {
      return;
    }
    const key = untracked(deleteTargetKey);
    if (!key) {
      closeDeleteDialog();
      return;
    }
    if (!untracked(tasks).some((task) => task._key === key)) {
      closeDeleteDialog();
      return;
    }
    const nextTasks = untracked(tasks).filter((task) => task._key !== key);
    batch(() => {
      saving.set(true);
      deleteDialogOpen.set(false);
    });
    try {
      const data = await runtimeApiFetch("/todo/tasks", {
        method: "PUT",
        body: { tasks: nextTasks.map((task) => model.serializeTask(task, t("todo_untitled"))) },
      });
      if (disposed) return;
      batch(() => {
        applyOptions(data);
        tasks.set(nextTasks);
        persistedTaskSignatures.set(signatures(nextTasks));
        selectedTaskKey.set("");
        selectedTaskDraft.set(null);
        draftDirty.set(false);
        tasksDirty.set(false);
        mobileEditorVisible.set(false);
      });
      notice.success(t("msg_delete_success"));
    } catch (e) {
      notice.error(errorMessage(e) || t("msg_delete_failed"));
    } finally {
      batch(() => {
        saving.set(false);
        deleteTargetKey.set("");
      });
    }
  }

  function moveSelectedTask(delta: number) {
    batch(() => {
      commitSelectedTaskDraft();
      const index = untracked(selectedIndex);
      const list = untracked(tasks);
      const nextIndex = index + delta;
      if (index < 0 || nextIndex < 0 || nextIndex >= list.length) {
        return;
      }
      const nextTasks = [...list];
      const [task] = nextTasks.splice(index, 1);
      nextTasks.splice(nextIndex, 0, task);
      tasks.set(nextTasks);
      tasksDirty.set(true);
      openSelectedTaskDraft();
    });
  }

  /* ---------- workspace ---------- */

  function openWorkspacePicker() {
    if (!untracked(selectedTask) || untracked(saving) || untracked(loading)) {
      return;
    }
    workspacePickerOpen.set(true);
  }

  function closeWorkspacePicker() {
    workspacePickerOpen.set(false);
  }

  function pickWorkspaceDir(dir: string) {
    const task = untracked(selectedTask);
    workspacePickerOpen.set(false);
    if (!task) {
      return;
    }
    rememberRecentWorkspaceDir(dir);
    editTask(task, (copy) => model.updateTaskField(copy, "workspace_dir", dir));
  }

  /* ---------- field edits ---------- */

  const edits = {
    field: (task: TodoTask, field: keyof TodoTask, value: string) =>
      editTask(task, (copy) => model.updateTaskField(copy, field, value)),
    title: (task: TodoTask, value: string) => editTask(task, (copy) => model.updateTaskField(copy, "title", value)),
    enabled: (task: TodoTask, value: boolean) => editTask(task, (copy) => model.updateTaskEnabled(copy, value)),
    scheduleMode: (task: TodoTask, mode: string) => editTask(task, (copy) => model.updateScheduleMode(copy, mode)),
    at: (task: TodoTask, value: string) => editTask(task, (copy) => model.updateAtInput(copy, value)),
    repeatKind: (task: TodoTask, kind: string) => {
      if (untracked(saving) || untracked(loading)) {
        return;
      }
      editTask(task, (copy) => model.updateRepeatKind(copy, kind));
    },
    repeatTime: (task: TodoTask, value: string) => editTask(task, (copy) => model.updateRepeatTime(copy, value)),
    repeatMinute: (task: TodoTask, value: string) => editTask(task, (copy) => model.updateRepeatMinute(copy, value)),
    repeatMonthDay: (task: TodoTask, value: string) =>
      editTask(task, (copy) => model.updateRepeatMonthDay(copy, value)),
    customCron: (task: TodoTask, value: string) => editTask(task, (copy) => model.updateCustomCron(copy, value)),
    toggleWeekday: (task: TodoTask, weekday: number) =>
      editTask(task, (copy) => model.toggleRepeatWeekday(copy, weekday)),
    timezone: (task: TodoTask, value: string) => editTask(task, (copy) => model.updateTaskField(copy, "tz", value)),
    llmProfile: (task: TodoTask, value: string) =>
      editTask(task, (copy) => model.updateTaskField(copy, "llm_profile", value)),
    workspaceDir: (task: TodoTask, value: string) =>
      editTask(task, (copy) => model.updateTaskField(copy, "workspace_dir", value)),
    clearWorkspaceDir: (task: TodoTask) => editTask(task, (copy) => model.updateTaskField(copy, "workspace_dir", "")),
    addBashEnvRow: (task: TodoTask) => editTask(task, (copy) => model.addBashEnvRow(copy)),
    removeBashEnvRow: (task: TodoTask, index: number) => editTask(task, (copy) => model.removeBashEnvRow(copy, index)),
    bashEnvField: (task: TodoTask, index: number, field: "name" | "value", value: string) =>
      editTask(task, (copy) => model.updateBashEnvField(copy, index, field, value)),
    chat: async (task: TodoTask, chatIDRaw: string) => {
      const chatID = trimText(chatIDRaw);
      if (chatID === model.CONSOLE_NOTIFICATION_CHAT_ID) {
        const permission = await requestSystemNotificationPermission();
        if (permission !== "granted") {
          const key =
            permission === "denied"
              ? "todo_chat_notification_denied"
              : permission === "unsupported"
                ? "todo_chat_notification_unsupported"
                : "todo_chat_notification_required";
          notice.error(t(key));
          return;
        }
      }
      editTask(task, (copy) => model.updateTaskField(copy, "chat_id", chatID));
    },
  };

  /* ---------- heartbeat ---------- */

  async function loadHeartbeat() {
    heartbeatLoading.set(true);
    try {
      const data = await runtimeApiFetch("/heartbeat/workflows");
      if (disposed) return;
      const items = Array.isArray(data?.items) ? data.items : [];
      batch(() => {
        heartbeatWorkflows.set(items.map((item: any) => heartbeatWorkflowFrom(item)));
        heartbeatDirty.set(false);
      });
    } catch (e) {
      notice.error(errorMessage(e) || t("msg_read_failed"));
    } finally {
      heartbeatLoading.set(false);
    }
  }

  function editHeartbeatWorkflows(change: (items: HeartbeatWorkflow[]) => HeartbeatWorkflow[]) {
    batch(() => {
      heartbeatWorkflows.update((items) => change(items));
      heartbeatDirty.set(true);
    });
  }

  function addHeartbeatWorkflow() {
    editHeartbeatWorkflows((items) => [...items, heartbeatWorkflowFrom({ title: "", instructions: "", enabled: true })]);
  }

  function updateHeartbeatWorkflow(key: string, patch: Partial<Omit<HeartbeatWorkflow, "_key" | "id">>) {
    editHeartbeatWorkflows((items) => items.map((item) => (item._key === key ? { ...item, ...patch } : item)));
  }

  function moveHeartbeatWorkflow(key: string, delta: number) {
    editHeartbeatWorkflows((items) => {
      const from = items.findIndex((item) => item._key === key);
      const to = from + delta;
      if (from < 0 || to < 0 || to >= items.length) return items;
      const next = [...items];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  }

  function removeHeartbeatWorkflow(key: string) {
    editHeartbeatWorkflows((items) => items.filter((item) => item._key !== key));
  }

  async function saveHeartbeat() {
    if (!untracked(canSaveHeartbeat)) {
      return;
    }
    heartbeatSaving.set(true);
    try {
      const items = untracked(heartbeatWorkflows).map((item) => ({
        id: item.id,
        title: trimText(item.title),
        instructions: item.instructions,
        enabled: item.enabled,
      }));
      const data = await runtimeApiFetch("/heartbeat/workflows", { method: "PUT", body: { items } });
      const saved = Array.isArray(data?.items) ? data.items : null;
      batch(() => {
        if (saved) heartbeatWorkflows.set(saved.map((item: any) => heartbeatWorkflowFrom(item)));
        heartbeatDirty.set(false);
      });
      invalidateConsoleSetupReadiness();
      notice.success(t("msg_save_success"));
    } catch (e) {
      notice.error(errorMessage(e) || t("msg_save_failed"));
    } finally {
      heartbeatSaving.set(false);
    }
  }

  /* ---------- load and save ---------- */

  async function load() {
    loading.set(true);
    try {
      const data = await runtimeApiFetch("/todo/tasks");
      if (disposed) return;
      const rows = Array.isArray(data?.tasks) ? data.tasks : [];
      const systemRows = Array.isArray(data?.system_tasks) ? data.system_tasks : [];
      const heartbeatRow = systemRows.find((item: any) => trimText(item?.id) === model.HEARTBEAT_ITEM_KEY);
      const loadedTasks = rows.map((item: any) => model.normalizeTask(item, t("todo_untitled"))) as TodoTask[];
      batch(() => {
        applyOptions(data);
        tasks.set(loadedTasks);
        persistedTaskSignatures.set(signatures(loadedTasks));
        heartbeatEnabled.set(data?.heartbeat_enabled !== false);
        applyTaskRuns(data?.runs);
        heartbeatTask.set(heartbeatRow ? (model.normalizeTask(heartbeatRow, t("todo_heartbeat_title")) as TodoTask) : null);
        selectedTaskKey.set("");
        selectedTaskDraft.set(null);
        draftDirty.set(false);
        tasksDirty.set(false);
        mobileEditorVisible.set(false);
      });
    } catch (e) {
      notice.error(errorMessage(e) || t("msg_load_failed"));
    } finally {
      loading.set(false);
    }
  }

  async function saveTasks() {
    if (untracked(loading) || untracked(saving) || !untracked(taskHasLocalChanges)) {
      return false;
    }
    const selectedMessage = untracked(selectedSaveValidationMessage);
    if (selectedMessage) {
      notice.error(selectedMessage);
      return false;
    }
    commitSelectedTaskDraft();
    const validationMessages = untracked(tasks)
      .map((task) => model.taskValidationMessage(task) as string)
      .filter(Boolean);
    if (validationMessages.length > 0) {
      notice.error(validationMessages[0]);
      return false;
    }
    const nextTasks = untracked(tasks).map((task) => model.cloneTaskForDraft(task) as TodoTask);
    nextTasks.forEach((task) => model.normalizeTaskBeforeSave(task));
    batch(() => {
      tasks.set(nextTasks);
      repeatInputRevision.update((n) => n + 1);
      saving.set(true);
    });
    try {
      const data = await runtimeApiFetch("/todo/tasks", {
        method: "PUT",
        body: { tasks: nextTasks.map((task) => model.serializeTask(task, t("todo_untitled"))) },
      });
      if (disposed) return false;
      batch(() => {
        applyOptions(data);
        persistedTaskSignatures.set(signatures(nextTasks));
        tasksDirty.set(false);
        selectedTaskDraft.set(model.cloneTaskForDraft(untracked(selectedStoredTask)) as TodoTask | null);
        draftDirty.set(false);
      });
      notice.success(t("msg_save_success"));
      return true;
    } catch (e) {
      notice.error(errorMessage(e) || t("msg_save_failed"));
      return false;
    } finally {
      saving.set(false);
    }
  }

  async function save() {
    if (untracked(heartbeatSelected)) {
      await saveHeartbeat();
      return;
    }
    await saveTasks();
  }

  /* ---------- run now and the item's topic ---------- */

  async function runSelectedTaskNow() {
    const task = untracked(selectedStoredTask);
    if (!untracked(canRunSelectedTask) || !task) {
      return;
    }
    const id = trimText(task.id);
    const key = task._key;
    const endpointRef = endpointState.selectedRef;
    if (!id) {
      return;
    }
    const validation = untracked(selectedSaveValidationMessage);
    if (validation) {
      notice.error(validation);
      return;
    }
    runningTaskKey.set(key);
    try {
      if (untracked(selectedTaskHasLocalChanges) && !(await saveTasks())) {
        return;
      }
      const stored = untracked(selectedStoredTask);
      if (
        disposed ||
        untracked(loading) ||
        untracked(saving) ||
        endpointState.selectedRef !== endpointRef ||
        stored?._key !== key ||
        trimText(stored?.id) !== id
      ) {
        return;
      }
      await runtimeApiFetch(`/todo/tasks/${encodeURIComponent(id)}/run`, { method: "POST" });
      if (disposed) return;
      openRunDialog({ endpointRef, key, taskID: id, title: taskTitle(untracked(selectedStoredTask)) });
      void refreshTaskRuns();
    } catch (e) {
      notice.error(errorMessage(e) || t("todo_run_failed"));
    } finally {
      runningTaskKey.set("");
    }
  }

  // Looks the selected item's topic up once; viewing an item never creates its topic.
  async function refreshSelectedTaskTopic() {
    const key = untracked(selectedTaskTopicKey);
    const seq = ++taskTopicLookupSeq;
    if (!key) {
      return;
    }
    const endpointRef = endpointState.selectedRef;
    const taskID = trimText(untracked(selectedStoredTask)?.id);
    try {
      const topicID = await findTodoTopic(
        runtimeApiFetchForEndpoint,
        todoTopicsEndpointRef(endpointRef, runtimeEndpointByRef),
        taskID,
      );
      if (!disposed && seq === taskTopicLookupSeq && key === untracked(selectedTaskTopicKey)) {
        taskTopic.set({ key, topicID });
      }
    } catch {
      // The entry shows up at the next lookup; the TODO itself does not depend on it.
    }
  }

  function openTaskTopic(topicID: string) {
    const path = todoTopicChatPath(topicID);
    if (!path) {
      return;
    }
    void navigate(endpointRoutePath(endpointState.selectedRef, path));
  }

  function cancelRunDialogLookup() {
    if (runDialogLookup) {
      runDialogLookup.abort();
      runDialogLookup = null;
    }
  }

  function openRunDialog(next: { endpointRef: string; key: string; taskID: string; title: string }) {
    cancelRunDialogLookup();
    batch(() => {
      runDialog.set({ ...emptyRunDialog(), ...next });
      runDialogOpen.set(true);
    });
    void resolveRunDialogTopic();
  }

  // Closing the dialog only closes it: the accepted run goes on.
  function closeRunDialog() {
    cancelRunDialogLookup();
    runDialogOpen.set(false);
  }

  // Finds the item's topic, which its first run creates when it starts: at once when it is there,
  // else by asking again for a while. Only reads.
  async function resolveRunDialogTopic() {
    cancelRunDialogLookup();
    const dialog = untracked(runDialog);
    if (!untracked(runDialogOpen) || !dialog.taskID) {
      return;
    }
    const topicsEndpointRef = todoTopicsEndpointRef(dialog.endpointRef, runtimeEndpointByRef);
    if (!topicsEndpointRef) {
      runDialog.set({ ...dialog, status: "none", topicID: "", error: "" });
      return;
    }
    const lookup = new AbortController();
    runDialogLookup = lookup;
    runDialog.set({ ...dialog, status: "checking", topicID: "", error: "" });
    const result = await waitForTodoTopic(
      () => findTodoTopic(runtimeApiFetchForEndpoint, topicsEndpointRef, dialog.taskID),
      { signal: lookup.signal } as Parameters<typeof waitForTodoTopic>[1] & object,
    );
    if (disposed || result.status === TODO_TOPIC_CANCELLED || runDialogLookup !== lookup) {
      return;
    }
    runDialogLookup = null;
    runDialog.set({
      ...untracked(runDialog),
      status: result.status,
      topicID: result.topicID,
      error: trimText((result.error as { message?: string } | null)?.message),
    });
    const key = model.taskTopicKey(dialog.endpointRef, dialog.taskID) as string;
    if (result.status === TODO_TOPIC_READY && key === untracked(selectedTaskTopicKey)) {
      taskTopicLookupSeq += 1;
      taskTopic.set({ key, topicID: result.topicID });
    }
  }

  function retryRunDialogTopic() {
    void resolveRunDialogTopic();
  }

  function openRunDialogTopic() {
    const { topicID, endpointRef } = untracked(runDialog);
    closeRunDialog();
    if (topicID && endpointRef === endpointState.selectedRef) {
      openTaskTopic(topicID);
    }
  }

  // A new item or agent is looked up; the same one again when its run state changes, until its
  // topic is there.
  let previousTopicKey: string | null = null;
  effect(() => {
    const key = selectedTaskTopicKey();
    void (taskRun(selectedStoredTask())?.state || "");
    untracked(() => {
      const previous = previousTopicKey;
      previousTopicKey = key;
      if (previous !== null && key === previous && selectedTaskTopicID()) {
        return;
      }
      void refreshSelectedTaskTopic();
    });
  });

  // The dialog is about the item and agent it was opened for, and its lookup stops with it.
  effect(() => {
    if (!runDialogOpen()) {
      untracked(cancelRunDialogLookup);
    }
  });
  effect(() => {
    const ref = endpointState.selectedRef;
    const key = selectedTaskKey();
    untracked(() => {
      const dialog = runDialog();
      if (runDialogOpen() && (dialog.endpointRef !== ref || dialog.key !== key)) {
        closeRunDialog();
      }
    });
  });

  /* ---------- start ---------- */

  function start() {
    void load();
    void loadHeartbeat();
    const timer = setInterval(() => {
      void refreshTaskRuns();
    }, 5000);
    cleanup(() => {
      clearInterval(timer);
      disposed = true;
      taskTopicLookupSeq += 1;
      cancelRunDialogLookup();
    });
  }

  return {
    // state
    loading,
    saving,
    tasks,
    orderedTasks,
    selectedTask,
    selectedTaskKey,
    selectedStoredTask,
    selectedCalendarDate,
    selectedCalendarDateTitle,
    selectedCalendarTasks,
    heartbeatLoading,
    heartbeatSaving,
    heartbeatSelected,
    heartbeatWorkflows,
    heartbeatDisabled,
    heartbeatIndexMeta,
    canSave,
    canRunSelectedTask,
    runningTaskKey,
    calendarView,
    showIndexPane,
    showEditorPane,
    mobileShowBack,
    mobileBarTitle,
    taskActionMenuItems,
    selectedTaskTopicID,
    deleteDialogOpen,
    deleteDialogText,
    runDialogOpen,
    runDialog,
    runDialogText,
    workspacePickerOpen,
    repeatInputRevision,
    chatMenuItems,
    llmProfileMenuItems,
    // reads
    taskTitle,
    scheduleLabel,
    taskListDisplayTask,
    taskRun,
    heartbeatRun,
    runStateLabel,
    isArrived,
    // actions
    start,
    load,
    save,
    addTask,
    selectTask,
    selectHeartbeat,
    selectCalendarDate,
    showIndexView,
    setTodoView,
    toggleTodoView,
    duplicateSelectedTask,
    moveSelectedTask,
    confirmDeleteSelectedTask,
    closeDeleteDialog,
    deleteSelectedTask,
    runSelectedTaskNow,
    openTaskTopic,
    closeRunDialog,
    retryRunDialogTopic,
    openRunDialogTopic,
    openWorkspacePicker,
    closeWorkspacePicker,
    pickWorkspaceDir,
    addHeartbeatWorkflow,
    updateHeartbeatWorkflow,
    moveHeartbeatWorkflow,
    removeHeartbeatWorkflow,
    edits,
  };
}

export type TodoState = ReturnType<typeof createTodoState>;
