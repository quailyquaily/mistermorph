// A TODO topic's toolbar (components/chat/TodoJobBar.tsx on components/chat/todoJob.ts): Start and
// View Job in the bottom navigation's glass capsule where a topic has its composer, Start reading Stop
// while the runtime runs the item. The item is the one the topic's ID names; what the toolbar shows
// is what the runtime answered (runs started elsewhere too), never what a request alone suggests.
// Requests still on their way are tested on the module with a fake runtime, since a held answer
// stops the headless app; the real page is tested through the console's API.
import type { App } from "nsh/test";
import { expect, test } from "nsh/test";
import { effect, signal, untracked } from "nsh";
import { createTodoJobControl, type TodoJobControl } from "../components/chat/todoJob";
import { openConsole, type ApiRequest } from "./harness";

const settle = async () => {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function failure(status: number, message: string) {
  return Object.assign(new Error(message), { status });
}

type Call = { endpointRef: string; path: string; method: string; body: unknown; answer: ReturnType<typeof deferred<any>> };

/** A runtime the test answers by hand: each request waits in `calls` until the test resolves it. */
function setup(initial = { endpointRef: "ep", taskID: "job1" }) {
  const calls: Call[] = [];
  const endpointRef = signal(initial.endpointRef);
  const taskID = signal(initial.taskID);
  const activity = signal("");
  let job!: TodoJobControl;
  effect(() => {
    untracked(() => {
      job = createTodoJobControl({
        endpointRef: () => endpointRef(),
        taskID: () => taskID(),
        activity: () => activity(),
        fetch: (ref, path, options) => {
          const answer = deferred<any>();
          calls.push({ endpointRef: ref, path, method: options?.method || "GET", body: options?.body, answer });
          return answer.promise;
        },
        // Only the test's own steps ask; no timers of their own get in the way.
        pollMs: 3_600_000,
        settleMs: 5,
        settleTimeoutMs: 200,
      });
    });
  });
  /** The oldest request not answered yet for `path` (and `method`). */
  const open = (path: string, method = "GET") => {
    const call = calls.find((item) => item.path === path && item.method === method && !(item as any).done);
    if (!call) throw new Error(`no open ${method} ${path}; asked: ${calls.map((c) => `${c.method} ${c.path}`).join(", ")}`);
    (call as any).done = true;
    return call;
  };
  const answer = async (path: string, body: unknown, method = "GET") => {
    open(path, method).answer.resolve(body);
    await settle();
  };
  const fail = async (path: string, error: unknown, method = "GET") => {
    open(path, method).answer.reject(error);
    await settle();
  };
  const asked = (path: string, method = "GET") => calls.filter((call) => call.path === path && call.method === method);
  const view = () => ({
    status: job.status(),
    running: job.running(),
    pending: job.pending(),
    canStart: job.canStart(),
    canStop: job.canStop(),
    canView: job.canView(),
  });
  return { job: () => job, calls, endpointRef, taskID, activity, open, answer, fail, asked, view };
}

const TASKS = (runs: unknown[] = [], ids = ["job1", "job2"]) => ({ tasks: ids.map((id) => ({ id, title: id })), runs });
const RUNNING = { id: "job1", run_id: "run_a", state: "running", started_at: "2030-01-01T09:00:00Z" };

/* ---------- the module ---------- */

test("the item is the one the topic names: idle offers Start, a running run Stop, a queued one neither", async () => {
  const t = setup();
  expect(t.view()).toMatchObject({ status: "loading", running: false, canStart: false, canStop: false });
  // Its ID is known from the topic: its page can open while it loads.
  expect(t.view().canView).toBe(true);
  expect(t.calls.map((call) => `${call.endpointRef} ${call.path}`)).toEqual(["ep /todo/tasks"]);
  await t.answer("/todo/tasks", TASKS([{ id: "job2", run_id: "run_x", state: "running" }]));
  // Another item's run is not this one's.
  expect(t.view()).toMatchObject({ status: "ready", running: false, canStart: true, canStop: false, canView: true });

  const running = setup();
  await running.answer("/todo/tasks", TASKS([RUNNING]));
  expect(running.view()).toMatchObject({ status: "ready", running: true, canStart: false, canStop: true });

  const queued = setup();
  await queued.answer("/todo/tasks", TASKS([{ id: "job1", run_id: "run_q", state: "queued" }]));
  expect(queued.view()).toMatchObject({ running: false, canStart: false, canStop: false });
});

test("Start asks for one run, stays busy until the runtime lists it, and only then reads Stop", async () => {
  const t = setup();
  await t.answer("/todo/tasks", TASKS());
  void t.job().start();
  expect(t.view()).toMatchObject({ pending: "start", canStart: false, running: false });
  // A second press while the first is out asks nothing.
  void t.job().start();
  expect(t.asked("/todo/tasks/job1/run", "POST").length).toBe(1);
  await t.answer("/todo/tasks/job1/run", { ok: true }, "POST");
  // Accepted, but not listed yet (it may wait for a slot): still Start, still busy.
  await t.answer("/todo/tasks", TASKS());
  expect(t.view()).toMatchObject({ pending: "start", running: false, canStart: false });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await t.answer("/todo/runs", { runs: [RUNNING] });
  expect(t.view()).toMatchObject({ pending: "", running: true, canStop: true });
  void t.job().start();
  expect(t.asked("/todo/tasks/job1/run", "POST").length).toBe(1);
  // Start only ever asked for a run: the item itself was not written.
  expect(t.calls.filter((call) => call.method !== "GET").map((call) => `${call.method} ${call.path}`)).toEqual(["POST /todo/tasks/job1/run"]);
});

test("a run that never shows ends Start's wait; a failed Start says why and claims no run", async () => {
  const t = setup();
  await t.answer("/todo/tasks", TASKS());
  void t.job().start();
  await t.answer("/todo/tasks/job1/run", { ok: true }, "POST");
  await t.answer("/todo/tasks", TASKS());
  // Nothing listed until the wait runs out (a run that ended at once): Start can be pressed again.
  for (let i = 0; i < 80 && t.job().pending(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    const call = t.calls.find((item) => item.path === "/todo/runs" && !(item as any).done);
    if (call) {
      (call as any).done = true;
      call.answer.resolve({ runs: [] });
    }
  }
  expect(t.view()).toMatchObject({ pending: "", running: false, canStart: true });

  void t.job().start();
  await t.fail("/todo/tasks/job1/run", failure(503, "runtime unavailable"), "POST");
  expect(t.job().error()).toEqual({ kind: "start", message: "runtime unavailable" });
  expect(t.view()).toMatchObject({ pending: "", running: false });
  // The runtime is asked what is true now.
  await t.answer("/todo/tasks", TASKS());
  expect(t.view()).toMatchObject({ canStart: true, running: false });
  // The error stays until the next action.
  expect(t.job().error()?.kind).toBe("start");

  // 404: the item is gone.
  void t.job().start();
  expect(t.job().error()).toBe(null);
  await t.fail("/todo/tasks/job1/run", failure(404, "cron task not found"), "POST");
  expect(t.view()).toMatchObject({ status: "missing", running: false, canStart: false, canView: false });
});

test("Stop names the running execution, once, and the run is shown until the runtime drops it", async () => {
  const t = setup();
  await t.answer("/todo/tasks", TASKS([RUNNING]));
  void t.job().stop();
  expect(t.view()).toMatchObject({ pending: "stop", canStop: false, running: true });
  expect(t.job().stopping()).toBe(true);
  void t.job().stop();
  void t.job().start();
  const stops = t.asked("/todo/tasks/job1/stop", "POST");
  expect(stops.length).toBe(1);
  expect(stops[0].body).toEqual({ run_id: "run_a" });
  expect(t.asked("/todo/tasks/job1/run", "POST").length).toBe(0);
  await t.answer("/todo/tasks/job1/stop", { status: "stopping", id: "job1", run_id: "run_a" }, "POST");
  // Taken, winding down: still running, Stop busy and not pressable.
  expect(t.view()).toMatchObject({ pending: "", running: true, canStop: false });
  expect(t.job().stopping()).toBe(true);
  await t.answer("/todo/runs", { runs: [{ ...RUNNING, stopping: true }] });
  expect(t.job().stopping()).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await t.answer("/todo/runs", { runs: [] });
  expect(t.view()).toMatchObject({ running: false, canStart: true });
  expect(t.job().stopping()).toBe(false);
  // The stop is all that was sent: the item and its schedule were not written.
  expect(t.calls.filter((call) => call.method !== "GET").map((call) => `${call.method} ${call.path}`)).toEqual(["POST /todo/tasks/job1/stop"]);
});

test("a failed Stop says why and can be pressed again; a run already gone is no error", async () => {
  const t = setup();
  await t.answer("/todo/tasks", TASKS([RUNNING]));
  void t.job().stop();
  await t.fail("/todo/tasks/job1/stop", failure(503, "runtime busy"), "POST");
  expect(t.job().error()).toEqual({ kind: "stop", message: "runtime busy" });
  await t.answer("/todo/tasks", TASKS([RUNNING]));
  expect(t.view()).toMatchObject({ pending: "", running: true, canStop: true });

  void t.job().stop();
  expect(t.job().error()).toBe(null);
  await t.fail("/todo/tasks/job1/stop", failure(404, "this run is not running"), "POST");
  expect(t.job().error()).toBe(null);
  await t.answer("/todo/tasks", TASKS());
  expect(t.view()).toMatchObject({ running: false, canStart: true });
});

test("a failed load or a gone item never shows a run, and offers nothing that could act on one", async () => {
  const t = setup();
  await t.fail("/todo/tasks", failure(500, "store unreadable"));
  expect(t.view()).toMatchObject({ status: "error", running: false, canStart: false, canStop: false, canView: true });
  expect(t.job().error()).toEqual({ kind: "load", message: "store unreadable" });
  // The next look asks for the item again, and a good answer clears the error.
  void t.job().refresh();
  await t.answer("/todo/tasks", TASKS([RUNNING]));
  expect(t.job().error()).toBe(null);
  expect(t.view()).toMatchObject({ status: "ready", running: true });

  const gone = setup();
  await gone.answer("/todo/tasks", TASKS([RUNNING], ["job2"]));
  // A run listed for an item that is not there is not shown either.
  expect(gone.view()).toMatchObject({ status: "missing", running: false, canStart: false, canStop: false, canView: false });
});

test("answers about an earlier topic are dropped; a new topic starts from nothing", async () => {
  const t = setup();
  t.taskID.set("job2");
  expect(t.view()).toMatchObject({ status: "loading", running: false });
  // The first topic's answer comes late, saying it runs: not shown for the second.
  t.open("/todo/tasks").answer.resolve(TASKS([RUNNING]));
  await settle();
  expect(t.view()).toMatchObject({ status: "loading", running: false });
  await t.answer("/todo/tasks", TASKS([{ id: "job2", run_id: "run_b", state: "running" }]));
  expect(t.view()).toMatchObject({ status: "ready", running: true });

  // A Start under way when the topic changes: its answer touches nothing.
  t.taskID.set("job1");
  await t.answer("/todo/tasks", TASKS());
  void t.job().start();
  t.endpointRef.set("ep2");
  expect(t.view()).toMatchObject({ status: "loading", pending: "" });
  await t.fail("/todo/tasks/job1/run", failure(503, "late"), "POST");
  expect(t.job().error()).toBe(null);
  expect(t.calls.at(-1)).toMatchObject({ endpointRef: "ep2", path: "/todo/tasks" });

  // No TODO topic: nothing to ask, nothing to offer.
  t.taskID.set("");
  expect(t.view()).toMatchObject({ status: "none", running: false, canStart: false, canView: false });
});

test("the topic's activity changing (a run from the schedule or another window) asks again at once", async () => {
  const t = setup();
  await t.answer("/todo/tasks", TASKS());
  expect(t.view().running).toBe(false);
  t.activity.set("running:1:1");
  expect(t.asked("/todo/tasks").length).toBe(2);
  await t.answer("/todo/tasks", TASKS([RUNNING]));
  expect(t.view()).toMatchObject({ running: true, canStop: true });
  // The same activity again asks nothing more.
  t.activity.set("running:1:1");
  expect(t.asked("/todo/tasks").length).toBe(2);
  t.activity.set("");
  await t.answer("/todo/tasks", TASKS());
  expect(t.view()).toMatchObject({ running: false, canStart: true });
});

/* ---------- the page ---------- */

const NOW = new Date().toISOString();
const TOPIC = "_cron_job1";

function runtime() {
  const state = {
    tasks: [{ id: "job1", title: "Daily digest", cron: "0 9 * * *", content: "Summarize the news." }] as any[],
    runs: [] as any[],
    activity: [] as any[],
    tasksStatus: 200,
  };
  const api = {
    "GET /proxy:/topics": { body: { items: [{ id: TOPIC, title: "Daily digest", created_at: NOW, updated_at: NOW }] } },
    "GET /proxy:/tasks": { body: { items: [] } },
    "GET /proxy:/topics/activity": () => ({ body: { topics: state.activity } }),
    "GET /proxy:/todo/tasks": () =>
      state.tasksStatus === 200
        ? { body: { tasks: state.tasks, system_tasks: [], chat_options: [], llm_profiles: [], heartbeat_enabled: true, runs: state.runs } }
        : { status: state.tasksStatus, body: { error: "store unreadable" } },
    "GET /proxy:/todo/runs": () => ({ body: { runs: state.runs, finished: [] } }),
    "GET /proxy:/heartbeat/workflows": { body: { items: [] } },
  } as Record<string, any>;
  return { state, api };
}

function proxied(calls: ApiRequest[], method: string, uri: string) {
  return calls.filter((call) => call.method === method && (call.uri || "").split("?")[0] === uri);
}

function lastLocation(app: App) {
  const history = app.host.calls().filter((call) => call.name === "morph.history");
  return String((history.at(-1)?.data as { url?: string })?.url || "");
}

test("the topic's foot is the item's toolbar: Start and View Job, centred, in place of the old note", async () => {
  const live = runtime();
  const { app } = await openConsole({ location: `/e/default/chat/${TOPIC}`, api: live.api });
  await app.waitFor("id:chat-todo-job-bar");
  expect(app.shows("id:chat-readonly-topic")).toBe(false);
  expect(app.shows("text:/The runs of the TODO item/")).toBe(false);
  // Exactly two buttons, named for what they do; no composer.
  expect(app.count("id:chat-todo-job-bar >> role:button")).toBe(2);
  await app.waitFor("label:Start");
  expect(app.count("label:View Job")).toBe(1);
  expect(app.count("label:Stop")).toBe(0);
  expect(app.shows("id:chat-composer-input")).toBe(false);
  expect(app.count("role:toolbar")).toBe(1);
  await app.waitUntil(() => app.enabled("id:chat-todo-job-toggle"));
  expect(app.enabled("id:chat-todo-job-view")).toBe(true);
});

test("Start runs the item now; once the runtime lists the run the button reads Stop, and Stop stops that run", async () => {
  const live = runtime();
  const { app, calls } = await openConsole({
    location: `/e/default/chat/${TOPIC}`,
    api: {
      ...live.api,
      "POST /proxy:/todo/tasks/job1/run": () => {
        live.state.runs = [RUNNING];
        return { status: 202, body: { ok: true, id: "job1" } };
      },
      "POST /proxy:/todo/tasks/job1/stop": (request: ApiRequest) => {
        live.state.runs = [];
        return { body: { status: "canceled", id: "job1", run_id: request.json?.run_id } };
      },
    },
  });
  await app.waitUntil(() => app.enabled("id:chat-todo-job-toggle"));
  await app.press("id:chat-todo-job-toggle");
  await app.waitFor("label:Stop");
  expect(app.count("label:Start")).toBe(0);
  expect(proxied(calls, "POST", "/todo/tasks/job1/run").length).toBe(1);
  await app.waitUntil(() => app.enabled("id:chat-todo-job-toggle"));
  await app.press("id:chat-todo-job-toggle");
  await app.waitFor("label:Start", { timeout: 4000 });
  const stops = proxied(calls, "POST", "/todo/tasks/job1/stop");
  expect(stops.length).toBe(1);
  expect(stops[0].json).toEqual({ run_id: "run_a" });
  // Neither touched the item or its schedule.
  expect(calls.filter((call) => call.uri !== undefined && call.method !== "GET").map((call) => `${call.method} ${call.uri}`)).toEqual([
    "POST /todo/tasks/job1/run",
    "POST /todo/tasks/job1/stop",
  ]);
});

test("a run started elsewhere turns Start into Stop as the topic's activity shows it, and back when it ends", async () => {
  const live = runtime();
  const { app } = await openConsole({ location: `/e/default/chat/${TOPIC}`, api: live.api, clock: true });
  await app.waitFor("label:Start");
  // The schedule starts a run: the chat's activity poll sees it, and the toolbar asks at once.
  live.state.runs = [RUNNING];
  live.state.activity = [{ id: TOPIC, status: "running", running: 1, cron_running: 1 }];
  await app.clock!.runFor(5000);
  await app.waitFor("label:Stop");
  live.state.runs = [];
  live.state.activity = [];
  await app.clock!.runFor(5000);
  await app.waitFor("label:Start");
});

test("a failed Start says why above the toolbar and leaves Start; a failed load claims no run", async () => {
  const live = runtime();
  const { app } = await openConsole({
    location: `/e/default/chat/${TOPIC}`,
    api: { ...live.api, "POST /proxy:/todo/tasks/job1/run": { status: 503, body: { error: "runtime unavailable" } } },
  });
  await app.waitUntil(() => app.enabled("id:chat-todo-job-toggle"));
  const alerts = app.count("role:alert");
  await app.press("id:chat-todo-job-toggle");
  await app.waitFor("Could not start the run: runtime unavailable");
  // Read out as it appears (role alert), on its own line.
  expect(app.count("id:chat-todo-job-error")).toBe(1);
  expect(app.count("role:alert")).toBe(alerts + 1);
  // Outside the capsule, which keeps its two buttons.
  expect(app.count("id:chat-todo-job-bar >> text:/Could not start/")).toBe(0);
  await app.waitUntil(() => app.enabled("id:chat-todo-job-toggle"));
  expect(app.count("label:Start")).toBe(1);

  const failing = runtime();
  failing.state.tasksStatus = 500;
  failing.state.runs = [RUNNING];
  const second = await openConsole({ location: `/e/default/chat/${TOPIC}`, api: failing.api });
  await second.app.waitFor("text:/^Could not load the TODO item/");
  expect(second.app.count("label:Stop")).toBe(0);
  expect(second.app.count("label:Start")).toBe(1);
  expect(second.app.enabled("id:chat-todo-job-toggle")).toBe(false);
  // The item's ID comes from the topic: its page can still be opened.
  expect(second.app.enabled("id:chat-todo-job-view")).toBe(true);
});

test("an item that is gone says so; both buttons stay, disabled", async () => {
  const live = runtime();
  live.state.tasks = [];
  live.state.runs = [RUNNING];
  const { app } = await openConsole({ location: `/e/default/chat/${TOPIC}`, api: live.api });
  await app.waitFor("The TODO item “Daily digest” no longer exists.");
  expect(app.count("label:Start")).toBe(1);
  expect(app.count("label:Stop")).toBe(0);
  expect(app.enabled("id:chat-todo-job-toggle")).toBe(false);
  expect(app.enabled("id:chat-todo-job-view")).toBe(false);
});

test("View Job opens the item on the TODO page by its ID, and the address then drops it", async () => {
  const live = runtime();
  live.state.tasks = [
    { id: "job0", title: "Other", cron: "0 8 * * *", content: "Other." },
    ...live.state.tasks,
  ];
  // A run of the item: the page goes by the item's ID, never the run's.
  live.state.runs = [RUNNING];
  const { app } = await openConsole({ location: `/e/default/chat/${TOPIC}`, api: live.api });
  await app.waitFor("label:Stop");
  await app.press("id:chat-todo-job-view");
  await app.waitUntil(() => app.host.calls().some((call) => call.name === "morph.history" && String((call.data as any)?.url).endsWith("/e/default/todo?task=job1")));
  await app.waitFor("id:todo-page");
  // The item's editor is open.
  await app.waitFor("id:todo-stop");
  await app.waitUntil(() => lastLocation(app).endsWith("/e/default/todo"));
});

test("an address naming an item that is gone opens the list and says so", async () => {
  const live = runtime();
  const { app } = await openConsole({ location: "/e/default/todo?task=job9", api: live.api });
  await app.waitFor("That TODO item no longer exists.");
  await app.waitUntil(() => lastLocation(app).endsWith("/e/default/todo"));
  expect(app.shows("id:todo-item-job1")).toBe(true);
});

test("on a phone the same toolbar floats at the conversation's foot, glass where the window draws it", async () => {
  const live = runtime();
  const phone = { width: 390, height: 844, platform: "android" as const };
  const { app } = await openConsole({ ...phone, glass: true, location: `/e/default/chat/${TOPIC}`, api: live.api });
  await app.waitFor("id:chat-todo-job-bar.glass");
  expect(app.shows("id:chat-composer-float.glass")).toBe(true);
  await app.waitFor("label:Start");
  expect(app.count("label:View Job")).toBe(1);
  // An open topic hides the bottom navigation: the toolbar is the only capsule.
  expect(app.shows("id:mobile-nav-capsule.glass")).toBe(false);

  const opaque = await openConsole({ ...phone, location: `/e/default/chat/${TOPIC}`, api: runtime().api });
  await opaque.app.waitFor("id:chat-todo-job-bar");
  expect(opaque.app.shows("id:chat-todo-job-bar.glass")).toBe(false);
  expect(opaque.app.count("label:Start")).toBe(1);
});

test("on a phone, back at the topic list the toolbar stops asking about the item", async () => {
  const live = runtime();
  const { app, calls } = await openConsole({ width: 390, height: 844, platform: "android", clock: true, location: `/e/default/chat/${TOPIC}`, api: live.api });
  await app.waitFor("label:Start");
  await app.clock!.runFor(5000);
  // Only the toolbar asks for the runs (the list's TODO view reads /todo/tasks for its model rows).
  const asked = () => proxied(calls, "GET", "/todo/runs").length;
  expect(asked()).toBeGreaterThan(0);
  await app.press("id:chat-back");
  await app.waitFor("id:chat-todo-job", { state: "gone" });
  const before = asked();
  await app.clock!.runFor(20000);
  expect(asked()).toBe(before);
});
