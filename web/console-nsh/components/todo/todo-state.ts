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
import { peekResource, readResource, resourceKey, writeResource } from "../../lib/core/resources.js";
import { rememberRecentWorkspaceDir } from "../../lib/core/recent-workspace-dirs.js";
import { invalidateConsoleSetupReadiness } from "../../lib/core/setup.js";
import { requestSystemNotificationPermission } from "../../lib/core/system-notifications.js";
import {
  normalizeFinishedTodoRuns,
  normalizeTodoRuns,
  todoRunsSignature,
  TODO_RUN_CANCELED,
  TODO_RUN_DONE,
  TODO_RUN_FAILED,
  TODO_RUN_RUNNING,
} from "../../lib/core/todo-runs.js";
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
import { newJobID } from "../../lib/core/job-id.js";
import { modelVendorMeta } from "../../lib/core/model-vendor.js";
import { isDesktop, isVisible } from "../../lib/platform";
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
  /** What starts it, as the runtime lists it; undefined for a runtime that knows only the one schedule. */
  triggers?: TodoTrigger[];
  /** The jobs whose results it takes in, and how. */
  uses?: TodoUse[];
  /** With several inputs that start it: when all have a new result, or any one. */
  join?: "all" | "any";
  /** What the runtime says is wrong with the job as set up. */
  warnings?: string[];
}

export interface TodoTrigger {
  id: string;
  kind: string;
  at: string;
  cron: string;
  tz: string;
  channel: string;
  chat_id: string;
}

export type TodoUseMode = "latest" | "each" | "fresh";
export interface TodoUse {
  job_id: string;
  mode: TodoUseMode;
  max_age?: string;
}

export interface TodoRun {
  state: string;
  manual: boolean;
  startedAt: string;
  /** Names this one execution; a later run of the same item gets another. */
  runID: string;
  /** A stop was asked for (from here or elsewhere) and the run is winding down. */
  stopping: boolean;
}

/**
 * A stop asked for one execution, keyed by its run ID: `requesting` while the request is out,
 * `stopping` once the runtime took it, until the run's end shows in /todo/runs.
 */
export interface TodoStop {
  endpointRef: string;
  taskID: string;
  runID: string;
  title: string;
  startedAt: string;
  phase: "requesting" | "stopping";
}

/** The selected item's running execution, with whether a stop is on its way. */
export interface SelectedRunStop {
  run: TodoRun;
  pending: boolean;
}

const FINISHED_STATUSES = [TODO_RUN_DONE, TODO_RUN_FAILED, TODO_RUN_CANCELED];
/** How often /todo/runs is asked while a stop waits for the run's end. */
const STOP_POLL_MS = 1000;

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

const tasksKey = (endpointRef: string) => resourceKey("todo", "tasks", String(endpointRef || "").trim());
const heartbeatKey = (endpointRef: string) => resourceKey("todo", "heartbeat", String(endpointRef || "").trim());

export function createTodoState() {
  // True from the start: the page loads at once, so its first frame shows the placeholder rows,
  // not the empty list.
  const loading = signal(true);
  // The list (or the heartbeat's workflows) on screen is last visit's, and the runtime has not
  // answered yet: it shows in place of the placeholder rows, and nothing is edited until then.
  const tasksFromLastTime = signal(false);
  const heartbeatFromLastTime = signal(false);
  const placeholderRows = computed(() => (loading() && !tasksFromLastTime()) || (heartbeatLoading() && !heartbeatFromLastTime()));
  const tasksPending = computed(() => loading() && !tasksFromLastTime());
  // How the list's first load went: "" until it answered, then ok or failed.
  const loaded = signal<"" | "ok" | "failed">("");
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
  let taskRunsSeq = 0;
  // The stops asked from this page that have not seen their run's end, by run ID.
  const stops = signal<Map<string, TodoStop>>(new Map());
  let stopPollTimer: ReturnType<typeof setTimeout> | null = null;
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
  // Only a running execution of a saved item offers Stop; idle, waiting and unsaved ones do not.
  const selectedRunStop = computed<SelectedRunStop | null>(() => {
    const task = selectedStoredTask();
    if (!task || heartbeatSelected() || !persistedTaskSignatures().has(task._key)) {
      return null;
    }
    const run = taskRun(task);
    if (!run || run.state !== TODO_RUN_RUNNING || !run.runID) {
      return null;
    }
    return { run, pending: run.stopping || stops().has(run.runID) };
  });
  const canDuplicateSelectedTask = computed(
    () => Boolean(selectedTask()) && !heartbeatSelected() && !loading() && !saving(),
  );
  // The list and an open item take turns: on a phone, and on a desktop too, where the list is a
  // page of its own. Only the desktop calendar keeps the open item beside it.
  const paged = () => isMobile() || !calendarView();
  const showIndexPane = computed(() => !paged() || !mobileEditorVisible());
  const showEditorPane = computed(() => !paged() || mobileEditorVisible());
  const mobileShowBack = computed(() => paged() && mobileEditorVisible());
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
    if (!paged()) {
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

  // finishedRaw is /todo/runs "finished" (how recent runs ended); /todo/tasks has none.
  function applyTaskRuns(raw: unknown, finishedRaw?: unknown) {
    const next = normalizeTodoRuns(raw) as Map<string, TodoRun>;
    const signature = todoRunsSignature(next);
    if (signature !== taskRunsSignature) {
      taskRunsSignature = signature;
      taskRuns.set(next);
    }
    settleStops(next, finishedRaw);
  }

  async function refreshTaskRuns() {
    if (!isVisible()) {
      return;
    }
    const seq = ++taskRunsSeq;
    try {
      const data = await runtimeApiFetch("/todo/runs");
      // An older answer never overwrites a newer one.
      if (!disposed && seq === taskRunsSeq) applyTaskRuns(data?.runs, data?.finished);
    } catch {
      // An older runtime has no /todo/runs; the list then shows no run state.
    }
  }

  /* ---------- stopping a run ---------- */

  function putStop(stop: TodoStop) {
    const next = new Map(untracked(stops));
    next.set(stop.runID, stop);
    stops.set(next);
  }

  function dropStop(runID: string) {
    const current = untracked(stops);
    if (!current.has(runID)) return;
    const next = new Map(current);
    next.delete(runID);
    stops.set(next);
  }

  // A stop the runtime took ends when its run's end shows: how it ended is in "finished". A run
  // that is gone without a record (an older runtime, a long-forgotten run) just ended.
  function settleStops(runs: Map<string, TodoRun>, finishedRaw: unknown) {
    const pending = [...untracked(stops).values()].filter((stop) => stop.phase === "stopping");
    if (pending.length === 0 || !Array.isArray(finishedRaw)) {
      return;
    }
    const finished = normalizeFinishedTodoRuns(finishedRaw) as Map<string, { status: string }>;
    for (const stop of pending) {
      const ended = finished.get(stop.runID);
      if (ended) {
        settleStop(stop, ended.status);
      } else if (runs.get(stop.taskID)?.runID !== stop.runID) {
        settleStop(stop, "");
      }
    }
  }

  // Says how the stopped run ended and shows it as the item's last run.
  function settleStop(stop: TodoStop, status: string) {
    dropStop(stop.runID);
    if (stop.endpointRef !== endpointState.selectedRef) {
      return;
    }
    const title = stop.title || t("todo_untitled");
    if (status === TODO_RUN_CANCELED) {
      notice.success(t("todo_stop_stopped", { title }));
    } else if (status === TODO_RUN_DONE) {
      pushNotice({ type: "info", text: t("todo_stop_completed", { title }) });
    } else if (status === TODO_RUN_FAILED) {
      pushNotice({ type: "warning", text: t("todo_stop_failed_before", { title }) });
    } else {
      pushNotice({ type: "info", text: t("todo_stop_ended", { title }) });
    }
    if (FINISHED_STATUSES.includes(status)) {
      showLastRun(stop.taskID, status, stop.startedAt);
    }
  }

  // The item's last-run line without reloading the list (which would drop edits): the stored item
  // and an open draft of it are replaced with copies that have the run's end.
  function showLastRun(taskID: string, status: string, startedAt: string) {
    const withRun = (task: TodoTask): TodoTask => ({
      ...task,
      last_run_status: status,
      last_run_at: startedAt || task.last_run_at,
    });
    batch(() => {
      const list = untracked(tasks);
      if (list.some((task) => trimText(task.id) === taskID)) {
        tasks.set(list.map((task) => (trimText(task.id) === taskID ? withRun(task) : task)));
      }
      const draft = untracked(selectedTaskDraft);
      if (draft && trimText(draft.id) === taskID) {
        selectedTaskDraft.set(withRun(draft));
      }
    });
  }

  function scheduleStopPoll() {
    if (stopPollTimer || disposed) return;
    stopPollTimer = setTimeout(() => {
      stopPollTimer = null;
      if (disposed || ![...untracked(stops).values()].some((stop) => stop.phase === "stopping")) {
        return;
      }
      void refreshTaskRuns().finally(scheduleStopPoll);
    }, STOP_POLL_MS);
  }

  // Stops the selected item's running execution, the one shown now: the request names its run ID,
  // so it can never stop a later run. One request at a time; the item stays as it is.
  async function stopSelectedRun() {
    const task = untracked(selectedStoredTask);
    const target = untracked(selectedRunStop);
    if (!task || !target || target.pending) {
      return;
    }
    const taskID = trimText(task.id);
    const stop: TodoStop = {
      endpointRef: endpointState.selectedRef,
      taskID,
      runID: target.run.runID,
      title: taskTitle(task),
      startedAt: target.run.startedAt,
      phase: "requesting",
    };
    putStop(stop);
    try {
      const data = await runtimeApiFetch(`/todo/tasks/${encodeURIComponent(taskID)}/stop`, {
        method: "POST",
        body: { run_id: stop.runID },
      });
      if (disposed || !untracked(stops).has(stop.runID)) return;
      const status = trimText(data?.status);
      if (status === "stopping") {
        // Taken, not yet stopped: the run's end says how it went.
        putStop({ ...stop, phase: "stopping" });
        scheduleStopPoll();
        return;
      }
      settleStop(stop, FINISHED_STATUSES.includes(status) ? status : "");
      void refreshTaskRuns();
    } catch (e) {
      if (disposed) return;
      dropStop(stop.runID);
      if ((e as { status?: number } | null)?.status === 404) {
        // The runtime no longer holds that run: it ended (or the runtime restarted).
        settleStop(stop, "");
      } else if (stop.endpointRef === endpointState.selectedRef) {
        // Still running, as far as the page knows: Stop can be pressed again.
        notice.error(t("todo_stop_failed", { error: errorMessage(e) || t("msg_load_failed") }));
      }
      void refreshTaskRuns();
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
      if (untracked(paged)) {
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
        if (untracked(paged)) {
          mobileEditorVisible.set(true);
        }
        return;
      }
      commitSelectedTaskDraft();
      selectedTaskKey.set(model.HEARTBEAT_ITEM_KEY);
      selectedTaskDraft.set(null);
      draftDirty.set(false);
      if (untracked(paged)) {
        mobileEditorVisible.set(true);
      }
    });
  }

  // A new item's ID: job-<uuid v4>, as the runtime makes them. It never reuses a deleted item's
  // ID, so an item's topic and runs stay its own.
  function nextID() {
    const used = new Set(untracked(tasks).map((task) => trimText(task.id)));
    let id = newJobID() as string;
    while (used.has(id)) {
      id = newJobID() as string;
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

  // The list's revision as the agent last reported it (GET and PUT /todo/tasks), sent with each save
  // so a save of a list that changed meanwhile (a job the agent added, another window's save) is
  // refused rather than overwriting it. null when the agent reports none (an earlier version).
  let listRevision: number | null = null;

  function applyRevision(data: any) {
    listRevision = typeof data?.revision === "number" ? data.revision : null;
  }

  function saveBody(list: TodoTask[]) {
    const body: Record<string, unknown> = { tasks: list.map((task) => model.serializeTask(task, t("todo_untitled"))) };
    if (listRevision !== null) {
      body.revision = listRevision;
    }
    return body;
  }

  // saveErrorMessage is what a failed save says: a list that changed since it was loaded is told
  // apart from other failures.
  function saveErrorMessage(e: unknown, fallback: string) {
    const status = (e as { status?: number } | null)?.status;
    const message = errorMessage(e);
    if (status === 409 && message.includes("changed since it was read")) {
      return t("todo_save_conflict");
    }
    return message || fallback;
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
        body: saveBody(nextTasks),
      });
      void keepSavedTasks();
      if (disposed) return;
      applyRevision(data);
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
      notice.error(saveErrorMessage(e, t("msg_delete_failed")));
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

  /* ---------- triggers and the jobs a job uses ---------- */

  /** A chat's channel as a message trigger names it (the chat's platform; "agentlink" for a peer agent). */
  function channelOf(option: { platform?: string }) {
    return trimText(option?.platform).toLowerCase().replace(/[\s_-]+/g, "");
  }

  // The chats a message can start a job from: every chat the agent knows, but not the Console's own
  // notifications (nobody writes there). The value is "channel chat_id".
  const messageSourceItems = computed<TodoMenuItem[]>(() =>
    (chatOptions() as { chat_id: string; platform: string }[])
      .filter((option) => option.chat_id !== model.CONSOLE_NOTIFICATION_CHAT_ID && channelOf(option) !== "console" && channelOf(option) !== "")
      .map((option) => {
        const item = (model.chatMenuItems([option]) as TodoMenuItem[])[1];
        return { ...item, id: `source-${option.chat_id}`, value: `${channelOf(option)} ${option.chat_id}` };
      }),
  );

  function chatTitle(chatID: string): string {
    const id = trimText(chatID);
    const item = chatMenuItems().find((entry) => entry.value === id);
    return item ? item.title : id;
  }

  /** A trigger besides the form's schedule, in words. */
  function triggerPhrase(trigger: TodoTrigger): string {
    if (trigger.kind === "message") return t("todo_trigger_message", { chat: chatTitle(trigger.chat_id) });
    if (trigger.kind === "schedule") {
      const text = model.schedulePreviewText(model.normalizeTask({ at: trigger.at, cron: trigger.cron, tz: trigger.tz })) as string;
      return t("todo_trigger_schedule", { schedule: text });
    }
    return t("todo_trigger_poke");
  }

  function jobByID(jobID: string): TodoTask | undefined {
    const id = trimText(jobID);
    return tasks().find((task) => trimText(task.id) === id);
  }

  function jobTitle(jobID: string): string {
    const job = jobByID(jobID);
    return job ? taskTitle(taskListDisplayTask(job) as TodoTask) : trimText(jobID);
  }

  /** Opens another job's page (a job named in this one's links). */
  function openJob(jobID: string) {
    const job = jobByID(jobID);
    if (job) selectTask(job);
  }

  /** The jobs `task` depends on, directly or through others, by id. */
  function upstreamOf(task: TodoTask): Set<string> {
    const seen = new Set<string>();
    const walk = (job: TodoTask | undefined) => {
      for (const use of job?.uses ?? []) {
        if (seen.has(use.job_id)) continue;
        seen.add(use.job_id);
        walk(jobByID(use.job_id));
      }
    };
    walk(task);
    return seen;
  }

  // The jobs `task` may start using: saved ones, not itself, not ones it uses already, and not ones
  // that depend on it (that would be a loop, which the runtime refuses).
  function usableJobItems(task: TodoTask): TodoMenuItem[] {
    const own = trimText(task?.id);
    const used = new Set((task?.uses ?? []).map((use) => use.job_id));
    return tasks()
      .filter((job) => {
        const id = trimText(job.id);
        return id !== "" && id !== own && !used.has(id) && persistedTaskSignatures().has(job._key) && !upstreamOf(job).has(own);
      })
      .map((job) => ({ id: `job-${job.id}`, title: taskTitle(job), value: job.id }));
  }

  /** The jobs that take in `task`'s result, each with how. */
  function usedBy(task: TodoTask): { id: string; title: string; mode: TodoUseMode }[] {
    const own = trimText(task?.id);
    if (!own) return [];
    const out: { id: string; title: string; mode: TodoUseMode }[] = [];
    for (const job of tasks()) {
      const use = (job.uses ?? []).find((entry) => entry.job_id === own);
      if (use) out.push({ id: job.id, title: taskTitle(job), mode: use.mode });
    }
    return out;
  }

  const joinItems = computed<TodoMenuItem[]>(() => [
    { id: "join-all", title: t("todo_join_all"), value: "all" },
    { id: "join-any", title: t("todo_join_any"), value: "any" },
  ]);

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
    poke: (task: TodoTask, on: boolean) => editTask(task, (copy) => model.setPokeTrigger(copy, on)),
    removeExtraTrigger: (task: TodoTask, index: number) => editTask(task, (copy) => model.removeExtraTrigger(copy, index)),
    /** `source`: a message source's value from messageSourceItems, "channel chat_id". */
    addMessageSource: (task: TodoTask, source: string) => {
      const at = source.indexOf(" ");
      if (at <= 0) return;
      editTask(task, (copy) => model.addMessageTrigger(copy, source.slice(0, at), source.slice(at + 1)));
    },
    addUse: (task: TodoTask, jobID: string) => editTask(task, (copy) => model.addUse(copy, jobID)),
    useMode: (task: TodoTask, jobID: string, mode: string) => editTask(task, (copy) => model.setUseMode(copy, jobID, mode)),
    removeUse: (task: TodoTask, jobID: string) => editTask(task, (copy) => model.removeUse(copy, jobID)),
    join: (task: TodoTask, join: string) => editTask(task, (copy) => model.setJoin(copy, join)),
    chat: async (task: TodoTask, chatIDRaw: string) => {
      const chatID = trimText(chatIDRaw);
      if (chatID === model.CONSOLE_NOTIFICATION_CHAT_ID) {
        const permission = await requestSystemNotificationPermission();
        if (permission !== "granted") {
          const key =
            permission === "denied"
              ? "todo_chat_notification_denied"
              : permission === "unsupported"
                ? isDesktop()
                  ? "todo_chat_notification_unsupported_desktop"
                  : "todo_chat_notification_unsupported"
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
    const key = heartbeatKey(endpointState.selectedRef);
    const apply = (data: any) => {
      const items = Array.isArray(data?.items) ? data.items : [];
      batch(() => {
        heartbeatWorkflows.set(items.map((item: any) => heartbeatWorkflowFrom(item)));
        heartbeatDirty.set(false);
      });
    };
    try {
      if (untracked(heartbeatWorkflows).length === 0 && !untracked(heartbeatDirty)) {
        const cached = peekResource(key) ?? (await readResource(key));
        if (disposed) return;
        if (cached !== undefined && untracked(heartbeatWorkflows).length === 0 && !untracked(heartbeatDirty)) {
          apply(cached);
          heartbeatFromLastTime.set(true);
        }
      }
      const data = await runtimeApiFetch("/heartbeat/workflows");
      writeResource(key, { items: Array.isArray(data?.items) ? data.items : [] }, { eager: true });
      if (disposed) return;
      apply(data);
    } catch (e) {
      notice.error(errorMessage(e) || t("msg_read_failed"));
    } finally {
      batch(() => {
        heartbeatLoading.set(false);
        heartbeatFromLastTime.set(false);
      });
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
      writeResource(heartbeatKey(endpointState.selectedRef), { items: saved ?? items }, { eager: true });
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

  // An address that names an item (`/todo?task=<id>`, the chat's View Job) opens it once the list
  // has loaded; the address then drops the name, so the item stays where the person leaves it. An
  // item that is not there (deleted, or a one-time item that ran) leaves the list as it is, and says so.
  effect(() => {
    const id = trimText(currentRoute()?.query?.task);
    if (!id || !loaded() || loading()) return;
    const list = tasks();
    untracked(() => {
      const task = list.find((item) => trimText(item.id) === id);
      if (task) {
        selectTask(task);
      } else if (untracked(loaded) === "ok") {
        // A failed load has said so already.
        pushNotice({ type: "info", text: t("todo_item_missing") });
      }
      const route = currentRoute();
      const query: Record<string, string> = { ...(route?.query || {}) };
      delete query.task;
      void navigate(locationOf(route?.path || "/", query), { replace: true });
    });
  });

  // The list as /todo/tasks gave it. `over` is true for the runtime's answer coming over last
  // visit's list: the items keep their keys (so none flashes as new) and the selection stays.
  function applyTasksAnswer(data: any, over: boolean) {
    const rows = Array.isArray(data?.tasks) ? data.tasks : [];
    const systemRows = Array.isArray(data?.system_tasks) ? data.system_tasks : [];
    const heartbeatRow = systemRows.find((item: any) => trimText(item?.id) === model.HEARTBEAT_ITEM_KEY);
    let loadedTasks = rows.map((item: any) => model.normalizeTask(item, t("todo_untitled"))) as TodoTask[];
    let nextHeartbeat = heartbeatRow ? (model.normalizeTask(heartbeatRow, t("todo_heartbeat_title")) as TodoTask) : null;
    let keepSelection = false;
    if (over) {
      const keys = new Map<string, string>();
      for (const task of untracked(tasks)) if (trimText(task.id)) keys.set(trimText(task.id), task._key);
      loadedTasks = loadedTasks.map((task) => (keys.has(trimText(task.id)) ? { ...task, _key: keys.get(trimText(task.id)) as string } : task));
      const shownHeartbeat = untracked(heartbeatTask);
      if (nextHeartbeat && shownHeartbeat) nextHeartbeat = { ...nextHeartbeat, _key: shownHeartbeat._key };
      const selected = untracked(selectedTaskKey);
      keepSelection = Boolean(selected) && (selected === model.HEARTBEAT_ITEM_KEY || loadedTasks.some((task) => task._key === selected));
    }
    applyRevision(data);
    batch(() => {
      applyOptions(data);
      tasks.set(loadedTasks);
      persistedTaskSignatures.set(signatures(loadedTasks));
      heartbeatEnabled.set(data?.heartbeat_enabled !== false);
      applyTaskRuns(data?.runs);
      heartbeatTask.set(nextHeartbeat);
      if (keepSelection) {
        // Nothing was edited meanwhile (the list takes no edits while it loads): the editor shows
        // the item as the runtime has it.
        if (untracked(selectedTaskDraft)) openSelectedTaskDraft();
      } else {
        selectedTaskKey.set("");
        selectedTaskDraft.set(null);
        mobileEditorVisible.set(false);
      }
      draftDirty.set(false);
      tasksDirty.set(false);
    });
  }

  // Keeps /todo/tasks' answer for the next visit, without its runs: what ran then is not running now.
  function keepTasksAnswer(endpointRef: string, data: any) {
    if (!data || typeof data !== "object") return;
    const { runs: _runs, ...rest } = data;
    writeResource(tasksKey(endpointRef), rest, { eager: true });
  }

  // After a save the list the runtime has is asked for again, only to keep it for the next visit.
  async function keepSavedTasks() {
    const endpointRef = endpointState.selectedRef;
    try {
      keepTasksAnswer(endpointRef, await runtimeApiFetchForEndpoint(endpointRef, "/todo/tasks"));
    } catch (e) {
      console.warn("todo: the saved list was not kept for the next visit:", errorMessage(e));
    }
  }

  async function load() {
    loading.set(true);
    let failed = false;
    const endpointRef = endpointState.selectedRef;
    try {
      if (!untracked(loaded)) {
        // The first load of this visit: last visit's list shows while the runtime answers.
        const cached = peekResource(tasksKey(endpointRef)) ?? (await readResource(tasksKey(endpointRef)));
        if (disposed) return;
        if (cached !== undefined && !untracked(loaded)) {
          applyTasksAnswer(cached, false);
          tasksFromLastTime.set(true);
        }
      }
      const data = await runtimeApiFetch("/todo/tasks");
      if (endpointRef === endpointState.selectedRef) keepTasksAnswer(endpointRef, data);
      if (disposed) return;
      applyTasksAnswer(data, untracked(tasksFromLastTime));
    } catch (e) {
      failed = true;
      notice.error(errorMessage(e) || t("msg_load_failed"));
    } finally {
      batch(() => {
        loading.set(false);
        tasksFromLastTime.set(false);
        if (!untracked(loaded)) loaded.set(failed ? "failed" : "ok");
      });
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
        body: saveBody(nextTasks),
      });
      void keepSavedTasks();
      if (disposed) return false;
      applyRevision(data);
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
      notice.error(saveErrorMessage(e, t("msg_save_failed")));
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
      if (stopPollTimer) clearTimeout(stopPollTimer);
      stopPollTimer = null;
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
    placeholderRows,
    tasksPending,
    heartbeatSaving,
    heartbeatSelected,
    heartbeatWorkflows,
    heartbeatDisabled,
    heartbeatIndexMeta,
    canSave,
    canRunSelectedTask,
    selectedRunStop,
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
    triggerPhrase,
    messageSourceItems,
    jobTitle,
    openJob,
    usableJobItems,
    usedBy,
    joinItems,
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
    stopSelectedRun,
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
