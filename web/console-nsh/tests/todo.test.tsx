// The TODO page: the list, the editor, save, duplicate, delete, run now and its dialog, the topic
// entry, schedules, the calendar, the workspace picker, Heartbeat and the phone layout.
import { expect, test } from "nsh/test";
import { type ApiRequest, openConsole } from "./harness";

const LOCATION = "/e/default/todo";

function tasksBody(extra: Record<string, unknown> = {}) {
  return {
    tasks: [
      { id: "task-1", title: "Review", content: "Original content", cron: "15 9 * * 1,3", tz: "UTC+9" },
      { id: "task-2", title: "Report", content: "Write it", at: "2030-01-02 12:30", tz: "UTC" },
    ],
    system_tasks: [{ id: "__heartbeat__", cron: "*/30 * * * *" }],
    chat_options: [],
    llm_profiles: [],
    heartbeat_enabled: true,
    runs: [],
    ...extra,
  };
}

function api(overrides: Record<string, unknown> = {}) {
  return {
    "GET /proxy:/todo/tasks": { body: tasksBody() },
    "GET /proxy:/todo/runs": { body: { runs: [] } },
    "GET /proxy:/heartbeat/workflows": {
      body: { items: [{ id: "hb-1", title: "Inbox", instructions: "Check the inbox.", enabled: true }] },
    },
    "PUT /proxy:/todo/tasks": (request: ApiRequest) => ({ body: { ...tasksBody(), tasks: request.json?.tasks } }),
    ...overrides,
  } as Record<string, any>;
}


function proxied(calls: ApiRequest[], method: string, uri: string) {
  return calls.filter((call) => call.method === method && (call.uri || "").split("?")[0] === uri);
}

/** What the page asked the agent to change (not reads, not the console's own routes). */
function agentWrites(calls: ApiRequest[]) {
  return calls.filter((call) => call.uri !== undefined && call.method !== "GET");
}

async function openTodo(overrides: Record<string, unknown> = {}, options: Record<string, unknown> = {}) {
  const opened = await openConsole({ location: LOCATION, api: api(overrides), ...options });
  return opened;
}

test("the list shows Heartbeat and the items with their schedules; nothing is selected", async () => {
  const { app } = await openTodo();
  await app.waitFor("id:todo-item-task-1");
  expect(app.texts()).toContain("Heartbeat");
  expect(app.texts()).toContain("Every 30 minutes");
  expect(app.texts()).toContain("Every Monday and Wednesday at 9:15 AM");
  expect(app.texts()).toContain("On Jan 2 at 12:30 PM");
  expect(app.texts()).toContain("No TODO selected");
});

test("editing an item enables Save, and Save sends every item with the edit", async () => {
  const { app, calls } = await openTodo();
  await app.press("id:todo-item-task-1");
  await app.waitFor("id:todo-task-editor");
  expect(app.enabled("id:todo-save")).toBe(false);
  await app.clear("id:todo-title");
  await app.type("id:todo-title", "Weekly review");
  expect(app.enabled("id:todo-save")).toBe(true);
  // The list shows the draft's title at once.
  await app.waitFor("id:todo-item-task-1 >> text:Weekly review");
  await app.press("id:todo-save");
  await app.waitFor("Saved");
  const puts = proxied(calls, "PUT", "/todo/tasks");
  expect(puts.length).toBe(1);
  expect(puts[0].json.tasks).toEqual([
    { id: "task-1", title: "Weekly review", content: "Original content", cron: "15 9 * * 1,3", tz: "UTC+9" },
    { id: "task-2", title: "Report", content: "Write it", at: "2030-01-02 12:30", tz: "UTC" },
  ]);
  expect(app.enabled("id:todo-save")).toBe(false);
});

test("the editor shows when the item last ran and how it ended; saves never send it back", async () => {
  const { app, calls } = await openTodo({
    "GET /proxy:/todo/tasks": {
      body: tasksBody({
        tasks: [
          { id: "task-1", title: "Review", content: "Original content", cron: "15 9 * * 1,3", tz: "UTC+9", last_run_at: "2030-01-01T09:15:00Z", last_run_status: "failed" },
          { id: "task-2", title: "Report", content: "Write it", at: "2030-01-02 12:30", tz: "UTC" },
          { id: "task-3", title: "Digest", content: "Sum it up", cron: "0 8 * * *", tz: "UTC", last_run_at: "2030-01-01T08:00:00Z", last_run_status: "done" },
        ],
      }),
    },
  });
  await app.press("id:todo-item-task-1");
  await app.waitFor("id:todo-last-run");
  await app.waitFor("text:/^Last run .+ · Failed$/");
  await app.press("id:todo-item-task-3");
  await app.waitFor("text:/^Last run .+ · Done$/");
  await app.press("id:todo-item-task-2");
  await app.waitFor("text:Not run yet");
  expect(app.shows("text:/· Failed$/")).toBe(false);

  await app.clear("id:todo-title");
  await app.type("id:todo-title", "Report v2");
  await app.press("id:todo-save");
  await app.waitFor("Saved");
  const sent = proxied(calls, "PUT", "/todo/tasks")[0].json.tasks;
  expect(sent.some((task: any) => "last_run_at" in task || "last_run_status" in task)).toBe(false);
});

test("a failed save shows the error and keeps the edit to save again", async () => {
  let fail = true;
  const { app, calls } = await openTodo({
    "PUT /proxy:/todo/tasks": (request: ApiRequest) =>
      fail ? { status: 500, body: { error: "disk full" } } : { body: { ...tasksBody(), tasks: request.json?.tasks } },
  });
  await app.press("id:todo-item-task-2");
  await app.type("id:todo-title", " now");
  await app.press("id:todo-save");
  await app.waitFor("disk full");
  expect(app.enabled("id:todo-save")).toBe(true);
  fail = false;
  await app.press("id:todo-save");
  await app.waitFor("Saved");
  expect(proxied(calls, "PUT", "/todo/tasks").length).toBe(2);
  expect(proxied(calls, "PUT", "/todo/tasks")[1].json.tasks[1].title).toBe("Report now");
});

test("a failed load says so and the list offers to add the first item", async () => {
  const { app } = await openTodo({ "GET /proxy:/todo/tasks": { status: 500, body: { error: "agent offline" } } });
  await app.waitFor("agent offline");
  await app.waitFor("No scheduled TODOs");
});

test("an empty list adds a new item that needs content before it can be saved", async () => {
  const { app, calls } = await openTodo({ "GET /proxy:/todo/tasks": { body: tasksBody({ tasks: [] }) } });
  await app.waitFor("No scheduled TODOs");
  await app.press("id:todo-empty-add");
  await app.waitFor("id:todo-task-editor");
  expect(app.value("id:todo-title")).toBe("Unititled TODO");
  // Content is required, but its absence is not shouted at.
  expect(app.enabled("id:todo-save")).toBe(false);
  expect(app.texts()).not.toContain("TODO content is required.");
  await app.type("id:todo-content-source", "Water the plants");
  expect(app.enabled("id:todo-save")).toBe(true);
  await app.press("id:todo-save");
  await app.waitFor("Saved");
  const body = proxied(calls, "PUT", "/todo/tasks")[0].json;
  expect(body.tasks.length).toBe(1);
  expect(body.tasks[0]).toMatchObject({ id: "task-1", title: "Unititled TODO", content: "Water the plants" });
  expect(body.tasks[0].at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  // A new item runs in the browser's UTC offset.
  expect(body.tasks[0].tz).toMatch(/^UTC([+-]\d{1,2})?$/);
});

test("Duplicate copies the item below it under a new id, unsaved", async () => {
  const { app, calls } = await openTodo();
  await app.press("id:todo-item-task-1");
  await app.press("id:todo-task-actions");
  await app.press("text:Duplicate");
  await app.waitFor("id:todo-item-task-3");
  expect(app.value("id:todo-title")).toBe("Review (copy)");
  expect(proxied(calls, "PUT", "/todo/tasks").length).toBe(0);
  await app.press("id:todo-save");
  await app.waitFor("Saved");
  const tasks = proxied(calls, "PUT", "/todo/tasks")[0].json.tasks;
  expect(tasks.map((task: { id: string }) => task.id)).toEqual(["task-1", "task-3", "task-2"]);
  expect(tasks[1]).toMatchObject({ title: "Review (copy)", content: "Original content", cron: "15 9 * * 1,3" });
});

test("Delete asks first, then saves the list without the item", async () => {
  const { app, calls } = await openTodo();
  await app.press("id:todo-item-task-2");
  await app.press("id:todo-task-actions");
  await app.press("text:Delete");
  await app.waitFor('Delete TODO "Report"? This takes effect immediately.');
  await app.press("id:dialog-action-cancel");
  await app.waitFor("id:todo-delete-dialog", { state: "gone" });
  expect(proxied(calls, "PUT", "/todo/tasks").length).toBe(0);
  await app.press("id:todo-task-actions");
  await app.press("text:Delete");
  await app.press("id:dialog-action-delete");
  await app.waitFor("Deleted");
  await app.waitFor("id:todo-item-task-2", { state: "gone" });
  expect(proxied(calls, "PUT", "/todo/tasks")[0].json.tasks.map((task: { id: string }) => task.id)).toEqual(["task-1"]);
  expect(app.texts()).toContain("No TODO selected");
});

test("a failed delete keeps the item", async () => {
  const { app } = await openTodo({ "PUT /proxy:/todo/tasks": { status: 500, body: { error: "locked" } } });
  await app.press("id:todo-item-task-2");
  await app.press("id:todo-task-actions");
  await app.press("text:Delete");
  await app.press("id:dialog-action-delete");
  await app.waitFor("locked");
  expect(app.shows("id:todo-item-task-2")).toBe(true);
});

function lastLocation(app: { host: { calls(): { name: string; data: unknown }[] } }) {
  const history = app.host.calls().filter((call) => call.name === "morph.history");
  return String((history.at(-1)?.data as { url?: string })?.url || "");
}

test("Run manually runs a saved item once and confirms it; the topic opens once it is there", async () => {
  let created = false;
  const { app, calls } = await openTodo({
    "POST /proxy:/todo/tasks/task-1/run": { body: { ok: true } },
    "GET /proxy:/topics/_cron_task-1": () =>
      created ? { body: { id: "_cron_task-1", title: "Review" } } : { status: 404, body: { error: "not found" } },
  });
  await app.press("id:todo-item-task-1");
  await app.press("id:todo-task-actions");
  // No topic yet: no entry to it.
  expect(app.shows("text:Open topic")).toBe(false);
  await app.press("text:Run manually");
  await app.waitFor("id:todo-run-dialog");
  await app.waitFor('"Review" will start soon; it may wait for a free slot first. Preparing its topic…');
  // While it looks, Open topic waits.
  await expect(app.press("id:dialog-action-open")).rejects.toMatchObject({ code: "ERR_NSH_TEST_DISABLED" });
  expect(proxied(calls, "POST", "/todo/tasks/task-1/run").length).toBe(1);
  created = true;
  await app.waitFor('"Review" will start soon; it may wait for a free slot first. Its topic shows the run.', { timeout: 4000 });
  await app.press("id:dialog-action-open");
  await app.waitFor("id:todo-run-dialog", { state: "gone" });
  await app.waitUntil(() => lastLocation(app).endsWith("/chat/_cron_task-1"));
  expect(proxied(calls, "POST", "/todo/tasks/task-1/run").length).toBe(1);
  // Looking the topic up only ever reads.
  expect(calls.filter((call) => (call.uri || "").startsWith("/topics/")).every((call) => call.method === "GET")).toBe(true);
});

test("an unsaved edit is saved before the run, and a failed run says so with no dialog", async () => {
  const { app, calls } = await openTodo({
    "POST /proxy:/todo/tasks/task-1/run": { status: 500, body: { error: "queue is full" } },
  });
  await app.press("id:todo-item-task-1");
  await app.type("id:todo-title", "!");
  await app.press("id:todo-task-actions");
  await app.press("text:Run manually");
  await app.waitFor("queue is full");
  expect(app.shows("id:todo-run-dialog")).toBe(false);
  const order = agentWrites(calls)
    .map((call) => `${call.method} ${(call.uri || "").split("?")[0]}`);
  expect(order).toEqual(["PUT /todo/tasks", "POST /todo/tasks/task-1/run"]);
  expect(proxied(calls, "PUT", "/todo/tasks")[0].json.tasks[0].title).toBe("Review!");
});

test("an invalid item is not run: the validation error shows and nothing is sent", async () => {
  const { app, calls } = await openTodo({ "GET /proxy:/todo/tasks": { body: tasksBody({ tasks: [] }) } });
  await app.press("id:todo-empty-add");
  await app.waitFor("id:todo-task-editor");
  // A new item has no content yet.
  await app.press("id:todo-task-actions");
  await app.press("text:Run manually");
  await app.waitFor("TODO content is required.");
  expect(agentWrites(calls).length).toBe(0);
});

test("an item whose topic exists offers Open topic right above Duplicate", async () => {
  const { app, calls } = await openTodo({
    "GET /proxy:/topics/_cron_task-1": { body: { id: "_cron_task-1", title: "Review" } },
  });
  await app.press("id:todo-item-task-1");
  await app.waitUntil(() => calls.some((call) => call.uri === "/topics/_cron_task-1"));
  await app.press("id:todo-task-actions");
  await app.waitFor("text:Open topic");
  const texts = app.texts();
  expect(texts.indexOf("Open topic") + 1).toBe(texts.indexOf("Duplicate"));
  expect(texts.indexOf("Run manually") + 1).toBe(texts.indexOf("Open topic"));
  await app.press("text:Open topic");
  await app.waitUntil(() => lastLocation(app).endsWith("/chat/_cron_task-1"));
  expect(agentWrites(calls).length).toBe(0);
});

test("a topic that does not come offers a lookup-only retry; closing the dialog keeps the run", async () => {
  const { app, calls } = await openTodo({
    "POST /proxy:/todo/tasks/task-2/run": { body: { ok: true } },
    "GET /proxy:/topics/_cron_task-2": { status: 500, body: { error: "topics unavailable" } },
  });
  await app.press("id:todo-item-task-2");
  await app.press("id:todo-task-actions");
  await app.press("text:Run manually");
  await app.waitFor('"Report" will start soon; it may wait for a free slot first. Could not look up its topic: topics unavailable', { timeout: 4000 });
  const lookups = () => calls.filter((call) => call.uri === "/topics/_cron_task-2").length;
  const before = lookups();
  await app.press("id:dialog-action-retry");
  await app.waitUntil(() => lookups() > before);
  await app.press("id:dialog-action-dismiss");
  await app.waitFor("id:todo-run-dialog", { state: "gone" });
  expect(proxied(calls, "POST", "/todo/tasks/task-2/run").length).toBe(1);
});

test("running and waiting items say so, and a running item cannot be run again", async () => {
  const { app } = await openTodo({
    "GET /proxy:/todo/tasks": {
      body: tasksBody({
        runs: [
          { id: "task-1", state: "running", started_at: "2026-11-04T03:00:00Z" },
          { id: "task-2", state: "queued" },
          { id: "__heartbeat__", state: "running" },
        ],
      }),
    },
  });
  await app.waitFor("id:todo-item-task-1");
  expect(app.texts()).toContain("Running · Every 30 minutes");
  expect(app.texts()).toContain("Running · Every Monday and Wednesday at 9:15 AM");
  expect(app.texts()).toContain("Waiting · On Jan 2 at 12:30 PM");
  await app.press("id:todo-item-task-1");
  await app.press("id:todo-task-actions");
  await expect(app.press("text:Run manually")).rejects.toMatchObject({ code: "ERR_NSH_TEST_DISABLED" });
});

/** A runtime whose TODO runs the test changes: `state.runs` and `state.finished` as /todo/runs lists them. */
function liveRuns(initial: any[]) {
  const state = { runs: initial, finished: [] as any[] };
  return {
    state,
    api: {
      "GET /proxy:/todo/tasks": () => ({ body: tasksBody({ runs: state.runs }) }),
      "GET /proxy:/todo/runs": () => ({ body: { runs: state.runs, finished: state.finished } }),
    } as Record<string, unknown>,
  };
}

const RUN_A = { id: "task-1", run_id: "run_a", state: "running", started_at: "2030-01-01T09:15:00Z" };

test("Stop stops the item's running run once, and says so only when the run has ended", async () => {
  const live = liveRuns([RUN_A]);
  const { app, calls } = await openTodo({
    ...live.api,
    "POST /proxy:/todo/tasks/task-1/stop": () => ({ status: 202, body: { status: "stopping", id: "task-1", run_id: "run_a" } }),
  });
  await app.press("id:todo-item-task-1");
  await app.waitFor("id:todo-stop");
  expect(app.texts()).toContain("Stop");
  await app.press("id:todo-stop");
  await app.waitFor("text:Stopping…");
  // Pending: a second press sends nothing.
  await expect(app.press("id:todo-stop")).rejects.toMatchObject({ code: "ERR_NSH_TEST_DISABLED" });
  const stops = proxied(calls, "POST", "/todo/tasks/task-1/stop");
  expect(stops.length).toBe(1);
  expect(stops[0].json).toEqual({ run_id: "run_a" });

  // Taken but still winding down: no word of success yet.
  live.state.runs = [{ ...RUN_A, stopping: true }];
  const polls = () => proxied(calls, "GET", "/todo/runs").length;
  const before = polls();
  await app.waitUntil(() => polls() > before, { timeout: 4000 });
  expect(app.shows("text:/^Stopped/")).toBe(false);
  expect(app.texts()).toContain("Stopping…");

  live.state.runs = [];
  live.state.finished = [{ id: "task-1", run_id: "run_a", status: "canceled", stopping: true, finished_at: "2030-01-01T09:16:00Z" }];
  await app.waitFor('Stopped "Review". What it already did is not undone.', { timeout: 4000 });
  await app.waitFor("id:todo-stop", { state: "gone" });
  await app.waitFor("text:/^Last run .+ · Stopped$/");
  // The item itself was left alone: the stop is all the page sent.
  expect(agentWrites(calls).map((call) => `${call.method} ${call.uri}`)).toEqual(["POST /todo/tasks/task-1/stop"]);
});

test("a run that finishes before it stops says so, and the next run has a Stop of its own", async () => {
  const live = liveRuns([RUN_A]);
  const { app, calls } = await openTodo({
    ...live.api,
    "POST /proxy:/todo/tasks/task-1/stop": (request: ApiRequest) => ({
      status: 202,
      body: { status: "stopping", id: "task-1", run_id: request.json?.run_id },
    }),
  });
  await app.press("id:todo-item-task-1");
  await app.press("id:todo-stop");
  await app.waitFor("text:Stopping…");
  // The run completed anyway, and the item's schedule started its next run.
  live.state.runs = [{ ...RUN_A, run_id: "run_b", started_at: "2030-01-01T09:20:00Z" }];
  live.state.finished = [{ id: "task-1", run_id: "run_a", status: "done", stopping: true, finished_at: "2030-01-01T09:16:00Z" }];
  await app.waitFor('"Review" finished before it could stop.', { timeout: 4000 });
  expect(app.shows("text:/^Stopped/")).toBe(false);
  await app.waitFor("text:/^Last run .+ · Done$/");
  // The new run is not being stopped: its Stop is ready, and names it.
  await app.waitFor("text:Stop");
  await app.press("id:todo-stop");
  await app.waitFor("text:Stopping…");
  expect(proxied(calls, "POST", "/todo/tasks/task-1/stop").map((call) => call.json?.run_id)).toEqual(["run_a", "run_b"]);
});

test("a stop answered with the run's end needs no wait", async () => {
  const live = liveRuns([RUN_A]);
  const { app } = await openTodo({
    ...live.api,
    "POST /proxy:/todo/tasks/task-1/stop": () => {
      live.state.runs = [];
      return { body: { status: "failed", id: "task-1", run_id: "run_a" } };
    },
  });
  await app.press("id:todo-item-task-1");
  await app.press("id:todo-stop");
  await app.waitFor('"Review" failed before it could stop.');
  await app.waitFor("text:/^Last run .+ · Failed$/");
  await app.waitFor("id:todo-stop", { state: "gone" });
});

test("a failed stop says why and can be tried again; a run that is gone says so", async () => {
  const live = liveRuns([RUN_A]);
  let answers = 0;
  const { app, calls } = await openTodo({
    ...live.api,
    "POST /proxy:/todo/tasks/task-1/stop": () => {
      answers += 1;
      return answers === 1
        ? { status: 503, body: { error: "runtime busy" } }
        : { status: 404, body: { error: "this run is not running", status: "not_found" } };
    },
  });
  await app.press("id:todo-item-task-1");
  await app.press("id:todo-stop");
  await app.waitFor("Could not stop the run: runtime busy");
  // Still running: Stop is offered again, not stuck pending.
  await app.waitFor("text:Stop");
  expect(app.shows("text:Stopping…")).toBe(false);
  await app.press("id:todo-stop");
  await app.waitFor('"Review" is no longer running.');
  expect(proxied(calls, "POST", "/todo/tasks/task-1/stop").length).toBe(2);
  expect(app.shows("text:/^Stopped/")).toBe(false);
});

test("idle and waiting items and Heartbeat offer no Stop", async () => {
  const { app, calls } = await openTodo(
    liveRuns([
      { id: "task-2", run_id: "run_q", state: "queued" },
      { id: "__heartbeat__", run_id: "run_h", state: "running" },
    ]).api,
  );
  await app.press("id:todo-item-task-1");
  await app.waitFor("id:todo-task-editor");
  expect(app.shows("id:todo-stop")).toBe(false);
  await app.press("id:todo-item-task-2");
  await app.waitFor("text:Report");
  expect(app.shows("id:todo-stop")).toBe(false);
  await app.press("id:todo-heartbeat-item");
  await app.waitFor("text:Inbox");
  expect(app.shows("id:todo-stop")).toBe(false);
  expect(agentWrites(calls).length).toBe(0);
});

test("a run someone else is stopping shows Stopping… and sends nothing", async () => {
  const { app, calls } = await openTodo(liveRuns([{ ...RUN_A, stopping: true }]).api);
  await app.press("id:todo-item-task-1");
  await app.waitFor("text:Stopping…");
  await expect(app.press("id:todo-stop")).rejects.toMatchObject({ code: "ERR_NSH_TEST_DISABLED" });
  expect(agentWrites(calls).length).toBe(0);
});

test("on a phone the open item's editor offers Stop while it runs", async () => {
  const live = liveRuns([RUN_A]);
  const { app, calls } = await openTodo(
    {
      ...live.api,
      "POST /proxy:/todo/tasks/task-1/stop": () => ({ status: 202, body: { status: "stopping", id: "task-1", run_id: "run_a" } }),
    },
    { width: 390, height: 844 },
  );
  await app.press("id:todo-item-task-1");
  await app.waitFor("id:todo-task-editor");
  await app.press("id:todo-stop");
  await app.waitFor("text:Stopping…");
  live.state.runs = [];
  live.state.finished = [{ id: "task-1", run_id: "run_a", status: "canceled", stopping: true, finished_at: "2030-01-01T09:16:00Z" }];
  await app.waitFor('Stopped "Review". What it already did is not undone.', { timeout: 4000 });
  expect(proxied(calls, "POST", "/todo/tasks/task-1/stop").length).toBe(1);
});

test("the repeat tabs, weekdays and custom cron rewrite the schedule and its preview", async () => {
  const { app, calls } = await openTodo();
  await app.press("id:todo-item-task-1");
  await app.waitFor("Every Monday and Wednesday at 9:15 AM, run Review");
  await app.press("id:todo-weekday-5");
  await app.waitFor("Every Monday, Wednesday, and Friday at 9:15 AM, run Review");
  // The last day cannot be turned off.
  await app.press("id:todo-weekday-1");
  await app.press("id:todo-weekday-3");
  await app.press("id:todo-weekday-5");
  await app.waitFor("Every Friday at 9:15 AM, run Review");
  await app.press("text:Daily");
  await app.waitFor("Every day at 9:15 AM, run Review");
  await app.press("text:Hourly");
  expect(app.value("id:todo-repeat-minute")).toBe("15");
  // 150 is past the hour: the minute is 59, and the field shows it.
  await app.type("id:todo-repeat-minute", "0");
  await app.waitFor("Every hour at minute 59, run Review");
  await app.waitUntil(() => app.value("id:todo-repeat-minute") === "59");
  await app.press("text:Custom");
  await app.clear("id:todo-custom-cron");
  await app.type("id:todo-custom-cron", "bad cron");
  await app.waitFor("Cron is invalid. Use five numeric fields with valid ranges.");
  expect(app.enabled("id:todo-save")).toBe(false);
  await app.clear("id:todo-custom-cron");
  await app.type("id:todo-custom-cron", "*/10 * * * *");
  await app.waitFor("Every 10 minutes, run Review");
  await app.press("id:todo-save");
  await app.waitFor("Saved");
  expect(proxied(calls, "PUT", "/todo/tasks")[0].json.tasks[0].cron).toBe("*/10 * * * *");
});

test("a monthly day is kept within 1 to 31", async () => {
  const { app, calls } = await openTodo();
  await app.press("id:todo-item-task-1");
  await app.press("text:Monthly");
  expect(app.value("id:todo-repeat-month-day")).toBe("1");
  await app.type("id:todo-repeat-month-day", "5");
  await app.waitUntil(() => app.value("id:todo-repeat-month-day") === "15");
  await app.type("id:todo-repeat-month-day", "9");
  // 159 is past the month: the field shows 31 again.
  await app.waitUntil(() => app.value("id:todo-repeat-month-day") === "31");
  await app.press("id:todo-save");
  await app.waitFor("Saved");
  expect(proxied(calls, "PUT", "/todo/tasks")[0].json.tasks[0].cron).toBe("15 9 31 * *");
});

test("switching a recurring item to one-time gives it a run time", async () => {
  const { app, calls } = await openTodo();
  await app.press("id:todo-item-task-1");
  await app.press("label:Schedule");
  await app.press("text:One-Time");
  await app.waitFor("id:todo-at");
  await app.press("id:todo-save");
  await app.waitFor("Saved");
  const saved = proxied(calls, "PUT", "/todo/tasks")[0].json.tasks[0];
  expect(saved.cron).toBeUndefined();
  expect(saved.at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
});

test("the timezone, model and chat pickers set the item's fields", async () => {
  const { app, calls } = await openTodo({
    "GET /proxy:/todo/tasks": {
      body: tasksBody({
        llm_profiles: [{ name: "reviewer", model: "gpt-5.2" }],
        llm_default_route: { model: "claude-sonnet-4-5" },
        chat_options: [{ chat_id: "tg:42", name: "Team", type: "group", platform: "telegram" }],
      }),
    },
  });
  await app.press("id:todo-item-task-2");
  await app.press("label:Timezone");
  await app.press("text:UTC+8 · Shanghai");
  await app.press("label:LLM Profile");
  await app.press("text:reviewer");
  await app.press("label:Notify Chat");
  await app.press("text:Team");
  await app.press("id:todo-save");
  await app.waitFor("Saved");
  expect(proxied(calls, "PUT", "/todo/tasks")[0].json.tasks[1]).toMatchObject({
    tz: "UTC+8",
    llm_profile: "reviewer",
    chat_id: "tg:42",
  });
});

test("bash environment rows are validated and saved", async () => {
  const { app, calls } = await openTodo();
  await app.press("id:todo-item-task-2");
  await app.press("id:todo-bash-env-add");
  await app.type("id:todo-bash-env-name-0", "1BAD");
  await app.waitFor(
    "Invalid bash environment variable name: 1BAD. Use letters, digits, and underscores; the first character cannot be a digit.",
  );
  expect(app.enabled("id:todo-save")).toBe(false);
  await app.clear("id:todo-bash-env-name-0");
  await app.type("id:todo-bash-env-name-0", "MODE");
  await app.type("id:todo-bash-env-value-0", "review");
  await app.press("id:todo-bash-env-add");
  await app.press("id:todo-bash-env-remove-1");
  await app.press("id:todo-save");
  await app.waitFor("Saved");
  expect(proxied(calls, "PUT", "/todo/tasks")[0].json.tasks[1].bash_env).toEqual([{ name: "MODE", value: "review" }]);
});

test("disabling an item moves it to the end of the list", async () => {
  const { app, calls } = await openTodo();
  await app.press("id:todo-item-task-1");
  await app.press("id:todo-enabled");
  await app.waitUntil(() => app.texts().indexOf("Review") > app.texts().indexOf("Report"));
  await app.press("id:todo-save");
  await app.waitFor("Saved");
  expect(proxied(calls, "PUT", "/todo/tasks")[0].json.tasks[0]).toMatchObject({ id: "task-1", enabled: false });
});

test("the calendar shows a month of runs; a day lists its items, and an item opens its editor", async () => {
  const { app } = await openTodo();
  await app.waitFor("id:todo-item-task-1");
  await app.press("id:todo-view-toggle");
  await app.waitFor("id:todo-calendar");
  await app.waitUntil(() => lastLocation(app).includes("view=calendar"));
  expect(lastLocation(app)).toMatch(/month=\d{4}-\d{2}/);

  const month = lastLocation(app).match(/month=(\d{4})-(\d{2})/)!;
  const next = new Date(Number(month[1]), Number(month[2]), 1);
  await app.press("label:Next month");
  await app.waitUntil(() =>
    lastLocation(app).includes(`month=${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}`),
  );
  const { app: jan } = await openTodo({}, { location: `${LOCATION}?view=calendar&month=2030-01` });
  await jan.waitFor("January 2030");
  await jan.waitFor("id:todo-calendar-day-2030-01-02 >> text:Report");
  await jan.press("id:todo-calendar-day-2030-01-02");
  await jan.waitFor("id:todo-day-detail");
  await jan.waitFor("Scheduled · 2");
  await jan.press("id:todo-day-item-task-2");
  await jan.waitFor("id:todo-task-editor");
  expect(jan.value("id:todo-title")).toBe("Report");
  // Another day selects the day again.
  await jan.press("id:todo-calendar-day-2030-01-03");
  await jan.waitFor("Scheduled · 0");
  await jan.waitFor("No TODOs scheduled for this day.");
  // Back to the list.
  await jan.press("id:todo-view-toggle");
  await jan.waitFor("id:todo-index");
});

test("a month with nothing on it says so", async () => {
  const { app } = await openTodo(
    { "GET /proxy:/todo/tasks": { body: tasksBody({ tasks: [] }) } },
    { location: `${LOCATION}?view=calendar&month=2030-01` },
  );
  await app.waitFor("No TODOs this month");
});

test("the workspace picker browses the agent's folders and fills in the chosen one", async () => {
  const { app, calls } = await openTodo({
    "GET /proxy:/workspace/browse": (request: ApiRequest) => {
      const uri = new URL(`http://x${request.uri}`);
      const path = uri.searchParams.get("path");
      if (path === "~") {
        return {
          body: {
            state_dir: "/home/u/.morph",
            items: [
              { name: "projects", path: "/home/u/projects", is_dir: true, has_children: true },
              { name: "notes.txt", path: "/home/u/notes.txt", is_dir: false },
            ],
          },
        };
      }
      if (path === "/home/u/projects") {
        return { body: { items: [{ name: "morph", path: "/home/u/projects/morph", is_dir: true }] } };
      }
      return { status: 500, body: { error: "no such directory" } };
    },
    "POST /proxy:/workspace/directory": (request: ApiRequest) => ({
      body: { path: `${request.json.parent_path}/${request.json.name}` },
    }),
  });
  await app.press("id:todo-item-task-1");
  await app.press("id:todo-workspace-browse");
  await app.waitFor("id:workspace-dir-picker");
  await app.waitFor("text:projects");
  expect(app.shows("label:State Dir")).toBe(true);
  expect(app.enabled("id:workspace-confirm")).toBe(false);
  await app.press("id:workspace-row-/home/u/projects");
  await app.waitFor("id:workspace-row-/home/u/projects/morph");
  expect(app.texts()).toContain("/home/u/projects");
  // A new folder under the selection.
  await app.press("id:workspace-new-directory");
  await app.type("id:workspace-directory-name", "reports");
  await app.press("id:workspace-create-directory");
  await app.waitUntil(() => app.texts().includes("/home/u/projects/reports"));
  expect(proxied(calls, "POST", "/workspace/directory")[0].json).toEqual({ parent_path: "/home/u/projects", name: "reports" });
  await app.press("id:workspace-confirm");
  await app.waitFor("id:workspace-dir-picker", { state: "gone" });
  expect(app.value("id:todo-workspace-dir")).toBe("/home/u/projects/reports");
  // It is remembered for next time.
  const saved = app.host.calls().filter((call) => call.name === "morph.kv.set");
  expect(JSON.stringify(saved)).toContain("/home/u/projects/reports");
  await app.press("id:todo-save");
  await app.waitFor("Saved");
  expect(proxied(calls, "PUT", "/todo/tasks")[0].json.tasks[0].workspace_dir).toBe("/home/u/projects/reports");
  // Clearing goes back to the default workspace.
  await app.press("id:todo-workspace-clear");
  expect(app.value("id:todo-workspace-dir")).toBe("");
});

test("a workspace folder that cannot be read shows the error in the picker", async () => {
  const { app } = await openTodo({ "GET /proxy:/workspace/browse": { status: 500, body: { error: "permission denied" } } });
  await app.press("id:todo-item-task-1");
  await app.press("id:todo-workspace-browse");
  await app.waitFor("permission denied");
  await app.press("id:workspace-cancel");
  await app.waitFor("id:workspace-dir-picker", { state: "gone" });
});

test("the desktop app offers its native folder picker for the local agent", async () => {
  const { app } = await openTodo(
    { "GET /proxy:/workspace/browse": { body: { items: [] } } },
    {
      runtime: "desktop",
      features: ["pickDirectory"],
      host: { "morph.desktop.pickDirectory": "/Users/me/work" },
    },
  );
  await app.press("id:todo-item-task-1");
  await app.press("id:todo-workspace-browse");
  await app.waitFor("Nothing to show here.");
  await app.press("id:workspace-native-pick");
  await app.waitUntil(() => app.texts().includes("/Users/me/work"));
  await app.press("id:workspace-confirm");
  await app.waitUntil(() => app.value("id:todo-workspace-dir") === "/Users/me/work");
});

test("Heartbeat edits its workflows with its own Save", async () => {
  const { app, calls } = await openTodo({
    "PUT /proxy:/heartbeat/workflows": (request: ApiRequest) => ({ body: { items: request.json?.items } }),
  });
  await app.press("id:todo-heartbeat-item");
  await app.waitFor("The heartbeat runs its switched-on workflows, in this order, on a schedule.");
  await app.waitUntil(() => app.value("id:todo-heartbeat-workflow-title-0") === "Inbox");
  expect(app.enabled("id:todo-heartbeat-save")).toBe(false);
  // Add a second workflow, name it, move it first and switch the inbox off.
  await app.press("id:todo-heartbeat-add");
  await app.waitFor("id:todo-heartbeat-workflow-1");
  expect(app.enabled("id:todo-heartbeat-save")).toBe(false);
  await app.type("id:todo-heartbeat-workflow-title-1", "Calendar");
  await app.press("id:todo-heartbeat-workflow-up-1");
  await app.waitUntil(() => app.value("id:todo-heartbeat-workflow-title-0") === "Calendar");
  await app.press("id:todo-heartbeat-workflow-enabled-1");
  await app.press("id:todo-heartbeat-save");
  await app.waitFor("Saved");
  const items = proxied(calls, "PUT", "/heartbeat/workflows")[0].json.items;
  expect(items.map((item: any) => item.title)).toEqual(["Calendar", "Inbox"]);
  expect(items[0].id).toBe("");
  expect(items[1]).toEqual({ id: "hb-1", title: "Inbox", instructions: "Check the inbox.", enabled: false });
});

test("a heartbeat workflow can be deleted, and a disabled heartbeat says so", async () => {
  const { app, calls } = await openTodo({
    "GET /proxy:/todo/tasks": { body: tasksBody({ heartbeat_enabled: false }) },
    "PUT /proxy:/heartbeat/workflows": (request: ApiRequest) => ({ body: { items: request.json?.items } }),
  });
  await app.waitFor("id:todo-heartbeat-item >> text:Disabled");
  await app.press("id:todo-heartbeat-item");
  await app.waitFor("The heartbeat task is disabled.");
  await app.waitFor("id:todo-heartbeat-workflow-0");
  await app.press("id:todo-heartbeat-workflow-delete-0");
  await app.waitFor("No workflows yet. Without one switched on there is no heartbeat task.");
  await app.press("id:todo-heartbeat-save");
  await app.waitFor("Saved");
  expect(proxied(calls, "PUT", "/heartbeat/workflows")[0].json.items).toEqual([]);
});

test("on a phone the list and the editor take turns, with a back button and a floating add", async () => {
  const { app, calls } = await openTodo({}, { width: 390, height: 844 });
  await app.waitFor("id:todo-item-task-1");
  expect(app.shows("id:todo-fab")).toBe(true);
  expect(app.shows("id:todo-add")).toBe(false);
  expect(app.shows("id:todo-task-editor")).toBe(false);
  await app.press("id:todo-item-task-2");
  await app.waitFor("id:todo-task-editor");
  expect(app.shows("id:todo-index")).toBe(false);
  expect(app.shows("id:todo-fab")).toBe(false);
  expect(app.shows("id:todo-back")).toBe(true);
  expect(app.texts()).toContain("Report");
  await app.press("id:todo-back");
  await app.waitFor("id:todo-index");
  await app.press("id:todo-fab");
  await app.waitFor("id:todo-task-editor");
  expect(app.value("id:todo-title")).toBe("Unititled TODO");
  expect(agentWrites(calls).length).toBe(0);
});

test("on a phone the calendar shows counts and the day's agenda", async () => {
  const { app } = await openTodo({}, { width: 390, height: 844, location: `${LOCATION}?view=calendar&month=2030-01` });
  await app.waitFor("January 2030");
  await app.waitFor("id:todo-calendar-day-2030-01-02");
  expect(app.shows("id:todo-calendar-add")).toBe(false);
  await app.press("id:todo-calendar-day-2030-01-02");
  await app.waitFor("Selected day");
  await app.press("text:Report");
  await app.waitFor("id:todo-task-editor");
  expect(app.shows("id:todo-calendar")).toBe(false);
});

test("a day with more than three runs folds the rest behind +N more", async () => {
  const daily = (id: string, title: string) => ({ id, title, content: "x", cron: "0 9 * * *", tz: "UTC" });
  const { app } = await openTodo(
    {
      "GET /proxy:/todo/tasks": {
        body: tasksBody({ tasks: [daily("a", "Alpha"), daily("b", "Beta"), daily("c", "Gamma"), daily("d", "Delta")] }),
      },
    },
    { location: `${LOCATION}?view=calendar&month=2030-01` },
  );
  await app.waitFor("id:todo-calendar-day-2030-01-15 >> text:+1 more");
  await app.press("id:todo-calendar-day-2030-01-15 >> text:+1 more");
  await app.waitFor("text:2030-01-15");
  await app.waitFor("Scheduled · 4");
  await app.press("label:/Delta/ >> nth=1");
  await app.waitFor("id:todo-task-editor");
  expect(app.value("id:todo-title")).toBe("Delta");
});

test("notifying the console user asks for notification permission first", async () => {
  let answer = "denied";
  const { app, calls } = await openTodo(
    {
      "GET /proxy:/todo/tasks": {
        body: tasksBody({ chat_options: [{ chat_id: "console:user", name: "Console", platform: "console" }] }),
      },
    },
    { host: { "morph.notify.request": () => answer } },
  );
  await app.press("id:todo-item-task-1");
  await app.press("label:Notify Chat");
  await app.press("text:Console User");
  await app.waitFor("System notifications are blocked. Enable them in browser or system settings.");
  expect(app.enabled("id:todo-save")).toBe(false);
  answer = "granted";
  await app.press("label:Notify Chat");
  await app.press("text:Console User");
  await app.waitUntil(() => app.enabled("id:todo-save"));
  await app.press("id:todo-save");
  await app.waitFor("Saved");
  expect(proxied(calls, "PUT", "/todo/tasks")[0].json.tasks[0].chat_id).toBe("console:user");
});
