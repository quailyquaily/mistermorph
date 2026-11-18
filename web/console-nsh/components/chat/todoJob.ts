// The TODO item behind a TODO topic, as the conversation's toolbar (TodoJobBar) controls it. A TODO
// topic is "_cron_<task id>" (lib/core/todo-topic.js), so the item is found by that stable ID, never
// by the topic's title or by a run. Everything shown comes from the runtime's own answers (GET
// /todo/tasks, GET /todo/runs): nothing is assumed from a request alone, so a load that failed or
// an item that is gone never shows a run, and Start reads Stop only once the runtime lists the run.
//
//   - Start: POST /todo/tasks/<id>/run, one run now; the item's schedule is untouched.
//   - Stop: POST /todo/tasks/<id>/stop with the running execution's run ID, so it stops that run
//     only (never a later one, never the schedule).
//
// Runs started elsewhere (the schedule, the TODO page, another window) show as the runtime lists
// them: the topic's activity (the chat's /topics/activity poll) changing asks again at once, and
// GET /todo/runs is asked every few seconds while the topic is open and the page is visible. A
// switch to another topic or agent, or the toolbar going away, drops every answer still on its way.
import { batch, cleanup, computed, effect, signal, untracked } from "nsh";
import { normalizeTodoRuns, TODO_RUN_RUNNING } from "../../lib/core/todo-runs.js";

/** none: no TODO topic; loading: the first answer is out; ready: the item is there; missing: it is not (deleted, or a one-time item that ran); error: it could not be loaded. */
export type TodoJobStatus = "none" | "loading" | "ready" | "missing" | "error";
/** The request on its way, if any. */
export type TodoJobAction = "" | "start" | "stop";

/** The item's execution the runtime is running or has queued now (lib/core/todo-runs.js). */
export interface TodoJobRun {
  state: string;
  manual: boolean;
  startedAt: string;
  runID: string;
  stopping: boolean;
}

export interface TodoJobError {
  /** What failed: loading the item, Start, or Stop. */
  kind: "load" | "start" | "stop";
  message: string;
}

type Fetch = (endpointRef: string, path: string, options?: { method?: string; body?: unknown }) => Promise<any>;

export interface TodoJobOptions {
  /** The agent the topic belongs to (the chat's submit endpoint). */
  endpointRef: () => string;
  /** The item's ID ("" while no TODO topic is open). */
  taskID: () => string;
  /** Changes whenever the runtime's activity in the topic does: the item is asked again at once. */
  activity?: () => string;
  /** `runtimeApiFetchForEndpoint` (tests pass their own). */
  fetch: Fetch;
  /** The page is shown: the periodic look happens only then. */
  visible?: () => boolean;
  /** How often GET /todo/runs is asked while the topic is open (5 s). */
  pollMs?: number;
  /** Every how many of those looks the item itself is asked again, to notice it was deleted (6). */
  fullEvery?: number;
  /** After Start or Stop, how often the runs are asked until the change shows (1 s), and for how long at most (10 s). */
  settleMs?: number;
  settleTimeoutMs?: number;
}

function text(value: unknown) {
  return String(value ?? "").trim();
}

function messageOf(error: unknown) {
  return text((error as { message?: string } | null)?.message);
}

function statusOf(error: unknown) {
  return Number((error as { status?: number } | null)?.status) || 0;
}

function sameRun(a: TodoJobRun | null, b: TodoJobRun | null) {
  if (!a || !b) return a === b;
  return a.state === b.state && a.runID === b.runID && a.stopping === b.stopping && a.startedAt === b.startedAt && a.manual === b.manual;
}

export function createTodoJobControl(options: TodoJobOptions) {
  const pollMs = options.pollMs ?? 5000;
  const fullEvery = Math.max(1, options.fullEvery ?? 6);
  const settleMs = options.settleMs ?? 1000;
  const settleTimeoutMs = options.settleTimeoutMs ?? 10000;

  const endpointRef = computed(() => text(options.endpointRef()));
  const jobID = computed(() => text(options.taskID()));
  const key = computed(() => (endpointRef() && jobID() ? `${endpointRef()}\n${jobID()}` : ""));

  const status = signal<TodoJobStatus>("none");
  const run = signal<TodoJobRun | null>(null);
  const pending = signal<TodoJobAction>("");
  const error = signal<TodoJobError | null>(null);

  // The item the answers are about. `generation` moves on with each new one (and when the control
  // goes), so whatever comes back for an earlier one is dropped; `readSeq` keeps only the newest read.
  let scope = { endpointRef: "", taskID: "" };
  let generation = 0;
  let readSeq = 0;
  let settleTimer: ReturnType<typeof setTimeout> | null = null;

  const current = (gen: number) => gen === generation;

  function setRuns(raw: unknown) {
    const next = ((normalizeTodoRuns(raw) as Map<string, TodoJobRun>).get(scope.taskID) || null) as TodoJobRun | null;
    if (!sameRun(untracked(run), next)) run.set(next);
  }

  /** Asks the runtime: the item and its runs (`full`, or while the item is not known yet), else its runs alone. */
  async function read(full: boolean) {
    const { endpointRef: ref, taskID } = scope;
    if (!ref || !taskID) return;
    const gen = generation;
    const seq = ++readSeq;
    const whole = full || untracked(status) !== "ready";
    try {
      const data = await options.fetch(ref, whole ? "/todo/tasks" : "/todo/runs");
      if (!current(gen) || seq !== readSeq) return;
      if (!whole) {
        setRuns(data?.runs);
        return;
      }
      const tasks: unknown[] = Array.isArray(data?.tasks) ? data.tasks : [];
      const found = tasks.some((task) => text((task as { id?: unknown })?.id) === taskID);
      batch(() => {
        if (untracked(error)?.kind === "load") error.set(null);
        if (found) {
          status.set("ready");
          setRuns(data?.runs);
        } else {
          status.set("missing");
          run.set(null);
        }
      });
    } catch (e) {
      if (!current(gen) || seq !== readSeq) return;
      if (!whole) {
        // A failed look at the runs leaves what the last answer said; the next look asks again.
        console.warn("chat: TODO runs", messageOf(e));
        return;
      }
      if (statusOf(e) === 404 && untracked(status) === "ready") {
        // An older runtime without the route, or the item went away: nothing runs that we know of.
        batch(() => {
          status.set("missing");
          run.set(null);
        });
        return;
      }
      batch(() => {
        status.set("error");
        run.set(null);
        error.set({ kind: "load", message: messageOf(e) });
      });
    }
  }

  function clearSettle() {
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = null;
  }

  // After an action: the runs are asked every settleMs until `done` holds, or for settleTimeoutMs at
  // most; `end` runs once either way (for the same item only).
  function settle(done: () => boolean, end: () => void) {
    clearSettle();
    const gen = generation;
    const until = Date.now() + settleTimeoutMs;
    const step = () => {
      if (!current(gen)) return;
      if (done() || Date.now() >= until) {
        end();
        return;
      }
      settleTimer = setTimeout(() => {
        settleTimer = null;
        if (!current(gen)) return;
        void read(false).then(step);
      }, settleMs);
    };
    step();
  }

  const running = computed(() => {
    const value = run();
    return status() === "ready" && !!value && value.state === TODO_RUN_RUNNING;
  });
  /** A stop is on its way: asked from here, or the runtime says the run is winding down. */
  const stopping = computed(() => pending() === "stop" || (running() && run()!.stopping));
  const canStart = computed(() => status() === "ready" && pending() === "" && !run());
  const canStop = computed(() => running() && pending() === "" && !run()!.stopping && run()!.runID !== "");
  /** The item's ID is known from the topic itself, so its page opens while it loads, and after a failed load. */
  const canView = computed(() => jobID() !== "" && endpointRef() !== "" && status() !== "missing" && status() !== "none");

  async function start() {
    if (!untracked(canStart)) return;
    const { endpointRef: ref, taskID } = scope;
    const gen = generation;
    batch(() => {
      pending.set("start");
      error.set(null);
    });
    try {
      await options.fetch(ref, `/todo/tasks/${encodeURIComponent(taskID)}/run`, { method: "POST" });
    } catch (e) {
      if (!current(gen)) return;
      batch(() => {
        pending.set("");
        if (statusOf(e) === 404) {
          status.set("missing");
          run.set(null);
        } else {
          error.set({ kind: "start", message: messageOf(e) });
        }
      });
      // Whatever the failure, the runtime says what is true now (a 409 means a run is already under way).
      if (statusOf(e) !== 404) void read(true);
      return;
    }
    if (!current(gen)) return;
    // Accepted: Start stays busy until the runtime lists the run (it may wait for a free slot first),
    // so a second press cannot ask for a second run.
    await read(true);
    if (!current(gen)) return;
    settle(
      () => untracked(run) !== null || untracked(status) !== "ready",
      () => pending.set(""),
    );
  }

  async function stop() {
    const target = untracked(run);
    if (!untracked(canStop) || !target) return;
    const { endpointRef: ref, taskID } = scope;
    const gen = generation;
    batch(() => {
      pending.set("stop");
      error.set(null);
    });
    try {
      const data = await options.fetch(ref, `/todo/tasks/${encodeURIComponent(taskID)}/stop`, {
        method: "POST",
        body: { run_id: target.runID },
      });
      if (!current(gen)) return;
      if (text(data?.status) === "stopping") {
        // Taken, still winding down: Stop stays busy until the run is gone.
        const now = untracked(run);
        if (now && now.runID === target.runID && !now.stopping) run.set({ ...now, stopping: true });
      }
    } catch (e) {
      if (!current(gen)) return;
      // 404: the runtime no longer holds that run, it ended. Anything else: still running as far as
      // we know, and Stop can be pressed again.
      batch(() => {
        pending.set("");
        if (statusOf(e) !== 404) error.set({ kind: "stop", message: messageOf(e) });
      });
      void read(true);
      return;
    }
    pending.set("");
    await read(false);
    if (!current(gen)) return;
    settle(
      () => untracked(run)?.runID !== target.runID,
      () => {},
    );
  }

  // A new item (another topic or agent): forget the last one's state and answers, and look.
  effect(() => {
    const next = key();
    untracked(() => {
      generation += 1;
      clearSettle();
      scope = { endpointRef: untracked(endpointRef), taskID: untracked(jobID) };
      batch(() => {
        run.set(null);
        pending.set("");
        error.set(null);
        status.set(next ? "loading" : "none");
      });
      if (next) void read(true);
    });
    if (!next) return;
    let polls = 0;
    const timer = setInterval(() => {
      if (options.visible && !options.visible()) return;
      polls += 1;
      void read(polls % fullEvery === 0);
    }, pollMs);
    cleanup(() => {
      clearInterval(timer);
      generation += 1;
      clearSettle();
    });
  });

  // The topic's activity changed (a run started or ended, from anywhere): ask at once.
  if (options.activity) {
    let last: string | null = null;
    effect(() => {
      const signature = `${key()}\u0000${options.activity!()}`;
      untracked(() => {
        const previous = last;
        last = signature;
        if (previous === null || !key() || previous.split("\u0000")[0] !== key() || previous === signature) return;
        void read(true);
      });
    });
  }

  return {
    status,
    run,
    pending,
    error,
    running,
    stopping,
    canStart,
    canStop,
    canView,
    jobID,
    endpointRef,
    start,
    stop,
    refresh: () => read(true),
  };
}

export type TodoJobControl = ReturnType<typeof createTodoJobControl>;
