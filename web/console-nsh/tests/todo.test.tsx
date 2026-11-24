// The TODO page: the list, the editor, save, duplicate, delete, run now and its dialog, the topic
// entry, schedules, the calendar, the workspace picker, Heartbeat and the phone layout.
import { expect, test } from "nsh/test";
import { type ApiRequest, openConsole } from "./harness";

const LOCATION = "/e/default/todo";
// The form of a job ID the Console and the agent make (internal/cron/jobid.go).
const JOB_ID = /^job-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

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


type Shown = { count(selector: string): number; waitUntil(check: () => boolean): Promise<unknown> };

/**
 * Waits until the page has nothing on its way to the agent: its changes are saved, or its form is
 * not valid and so is not sent (the page's unseen `todo-save-<state>` mark, todo-state's saveState).
 */
async function still(app: Shown) {
  await app.waitUntil(() => app.count("id:todo-save-saved") + app.count("id:todo-save-invalid") > 0);
}

/**
 * A job has no Save: its form is saved once it has been still for a moment. Waits for at least
 * `count` saves and for nothing to be left to save, and gives what the last save sent.
 */
async function saved(app: Shown, calls: ApiRequest[], count = 1) {
  await app.waitUntil(() => proxied(calls, "PUT", "/todo/tasks").length >= count && app.count("id:todo-save-saved") > 0);
  return proxied(calls, "PUT", "/todo/tasks").at(-1)!.json;
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

test("the list shows Heartbeat and the items with their schedules, and no item is open", async () => {
  const { app } = await openTodo();
  await app.waitFor("id:todo-item-task-1");
  expect(app.texts()).toContain("Heartbeat");
  expect(app.texts()).toContain("Every 30 minutes");
  expect(app.texts()).toContain("Every Monday and Wednesday at 9:15 AM");
  expect(app.texts()).toContain("On Jan 2 at 12:30 PM");
  // The list is the page: an item opens in its place, so none is open and there is no way back.
  expect(app.shows("id:todo-task-editor")).toBe(false);
  expect(app.shows("id:todo-back")).toBe(false);
});

test("an item opens in the list's place, and the back arrow returns to the list", async () => {
  const { app } = await openTodo();
  await app.press("id:todo-item-task-1");
  await app.waitFor("id:todo-task-editor");
  expect(app.shows("id:todo-index")).toBe(false);
  await app.press("id:todo-back");
  await app.waitFor("id:todo-item-task-2");
  expect(app.shows("id:todo-task-editor")).toBe(false);
});

test("items that are switched off sit under their own heading, after the others", async () => {
  const { app } = await openTodo({
    "GET /proxy:/todo/tasks": {
      body: tasksBody({
        tasks: [
          { id: "task-1", title: "Review", content: "x", cron: "15 9 * * 1,3", tz: "UTC+9", enabled: false },
          { id: "task-2", title: "Report", content: "Write it", at: "2030-01-02 12:30", tz: "UTC" },
        ],
      }),
    },
  });
  await app.waitFor("id:todo-item-task-1");
  const texts = app.texts();
  expect(texts.indexOf("Report")).toBeLessThan(texts.indexOf("OFF"));
  expect(texts.indexOf("OFF")).toBeLessThan(texts.indexOf("Review"));
  expect(app.shows("id:todo-index-off >> id:todo-item-task-1")).toBe(true);
  expect(app.shows("id:todo-index-off >> id:todo-item-task-2")).toBe(false);
});

test("an edit is saved by itself once the form is still: no Save, every item sent with the edit, and nothing said", async () => {
  const { app, calls } = await openTodo();
  await app.press("id:todo-item-task-1");
  await app.waitFor("id:todo-task-editor");
  // A job has no Save button; opening it sends nothing.
  expect(app.count("id:todo-save")).toBe(0);
  await still(app);
  expect(proxied(calls, "PUT", "/todo/tasks").length).toBe(0);
  await app.clear("id:todo-title");
  await app.type("id:todo-title", "Weekly review");
  const sent = await saved(app, calls);
  expect(sent.tasks).toEqual([
    { id: "task-1", title: "Weekly review", content: "Original content", cron: "15 9 * * 1,3", tz: "UTC+9" },
    { id: "task-2", title: "Report", content: "Write it", at: "2030-01-02 12:30", tz: "UTC" },
  ]);
  // The save is the page's own: no "Saved" each time, and the form stayed open to typing.
  expect(app.texts()).not.toContain("Saved");
  expect(app.value("id:todo-title")).toBe("Weekly review");
  // Saved, the form sends nothing more.
  const count = proxied(calls, "PUT", "/todo/tasks").length;
  await still(app);
  expect(proxied(calls, "PUT", "/todo/tasks").length).toBe(count);
  // Back on the list, the item has its new name.
  await app.press("id:todo-back");
  await app.waitFor("id:todo-item-task-1 >> text:Weekly review");
});

test("a job's bar holds back, its switch and its toolbar, and no title; a phone floats the toolbar at the page's foot", async () => {
  const { app } = await openTodo();
  await app.press("id:todo-item-task-1");
  await app.waitFor("id:todo-task-editor");
  for (const id of ["todo-back", "todo-enabled", "todo-toolbar"]) expect(app.shows(`id:todo-bar-row >> id:${id}`)).toBe(true);
  expect(app.shows("id:todo-bar-row >> id:todo-run")).toBe(true);
  // The job is named by its title field alone, and the form has neither the switch nor the toolbar.
  expect(app.count("id:todo-bar-row >> text:Review")).toBe(0);
  expect(app.count("id:todo-task-editor >> id:todo-enabled")).toBe(0);
  expect(app.count("id:todo-task-editor >> id:todo-toolbar")).toBe(0);
  expect(app.count("id:todo-save")).toBe(0);
  // The fields say what they are; no note under the directory.
  expect(app.shows("id:todo-llm-profile")).toBe(true);
  expect(app.shows("id:todo-workspace-dir")).toBe(true);
  expect(app.count("text:Absolute directory this job runs in. Leave empty to use the default workspace.")).toBe(0);

  // A phone: the same bar without the toolbar, which floats at the page's foot as the bottom navigation does.
  const phone = await openTodo({}, { width: 390, height: 844 });
  await phone.app.press("id:todo-item-task-1");
  await phone.app.waitFor("id:todo-task-editor");
  for (const id of ["todo-back", "todo-enabled"]) expect(phone.app.shows(`id:todo-bar-row >> id:${id}`)).toBe(true);
  expect(phone.app.count("id:todo-bar-row >> id:todo-toolbar")).toBe(0);
  expect(phone.app.count("id:todo-bar-row >> text:Review")).toBe(0);
  expect(phone.app.count("id:todo-task-editor >> id:todo-toolbar")).toBe(0);
  expect(phone.app.shows("id:todo-foot-bar >> role:toolbar")).toBe(true);
  expect(phone.app.shows("id:todo-foot-bar >> id:todo-run")).toBe(true);
  expect(phone.app.count("id:todo-save")).toBe(0);
  expect(phone.app.count("text:Absolute directory this job runs in. Leave empty to use the default workspace.")).toBe(0);
  // Heartbeat has no title field: the bar names it.
  await phone.app.press("id:todo-back");
  await phone.app.press("id:todo-heartbeat-item");
  await phone.app.waitFor("id:todo-bar-row >> text:Heartbeat");
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
  await app.press("id:todo-back");
  await app.press("id:todo-item-task-3");
  await app.waitFor("text:/^Last run .+ · Done$/");
  await app.press("id:todo-back");
  await app.press("id:todo-item-task-2");
  await app.waitFor("text:Not run yet");
  expect(app.shows("text:/· Failed$/")).toBe(false);

  await app.clear("id:todo-title");
  await app.type("id:todo-title", "Report v2");
  await saved(app, calls);
  const sent = proxied(calls, "PUT", "/todo/tasks").at(-1)!.json.tasks;
  expect(sent.some((task: any) => "last_run_at" in task || "last_run_status" in task)).toBe(false);
});

test("a failed save shows the error and keeps the edit, which the next change saves", async () => {
  let fail = true;
  const { app, calls } = await openTodo({
    "PUT /proxy:/todo/tasks": (request: ApiRequest) =>
      fail ? { status: 500, body: { error: "disk full" } } : { body: { ...tasksBody(), tasks: request.json?.tasks } },
  });
  await app.press("id:todo-item-task-2");
  await app.type("id:todo-title", " now");
  await app.waitFor("disk full");
  expect(app.value("id:todo-title")).toBe("Report now");
  // The edit is kept: the next change saves it with the rest.
  fail = false;
  const failed = proxied(calls, "PUT", "/todo/tasks").length;
  await app.type("id:todo-title", "!");
  const sent = await saved(app, calls, failed + 1);
  expect(sent.tasks[1].title).toBe("Report now!");
});

test("a failed load says so and the list offers to add the first item", async () => {
  const { app } = await openTodo({ "GET /proxy:/todo/tasks": { status: 500, body: { error: "agent offline" } } });
  await app.waitFor("agent offline");
  await app.waitFor("No jobs yet");
});

test("an empty list adds a new item that is saved once it has content", async () => {
  const { app, calls } = await openTodo({ "GET /proxy:/todo/tasks": { body: tasksBody({ tasks: [] }) } });
  await app.waitFor("No jobs yet");
  await app.press("id:todo-empty-add");
  await app.waitFor("id:todo-task-editor");
  expect(app.value("id:todo-title")).toBe("Untitled job");
  // Content is required, but its absence is not shouted at; without it nothing is sent.
  await still(app);
  expect(proxied(calls, "PUT", "/todo/tasks").length).toBe(0);
  expect(app.texts()).not.toContain("The job needs to say what to do.");
  await app.type("id:todo-content-source", "Water the plants");
  await saved(app, calls);
  const body = proxied(calls, "PUT", "/todo/tasks").at(-1)!.json;
  expect(body.tasks.length).toBe(1);
  expect(body.tasks[0]).toMatchObject({ title: "Untitled job", content: "Water the plants" });
  // A new item's ID is a job ID, as the agent makes them: job-<uuid v4>.
  expect(body.tasks[0].id).toMatch(JOB_ID);
  expect(body.tasks[0].at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  // A new item runs in the browser's UTC offset.
  expect(body.tasks[0].tz).toMatch(/^UTC([+-]\d{1,2})?$/);
});

test("Duplicate copies the item below it under a new id", async () => {
  const { app, calls } = await openTodo();
  await app.press("id:todo-item-task-1");
  await app.press("id:todo-task-actions");
  await app.press("text:Duplicate");
  await app.waitUntil(() => app.value("id:todo-title") === "Review (copy)");
  await saved(app, calls);
  const tasks = proxied(calls, "PUT", "/todo/tasks").at(-1)!.json.tasks;
  expect(tasks.length).toBe(3);
  expect([tasks[0].id, tasks[2].id]).toEqual(["task-1", "task-2"]);
  // The copy is a new job with an ID of its own; the items it sits between keep theirs.
  expect(tasks[1].id).toMatch(JOB_ID);
  await app.press("id:todo-back");
  await app.waitFor(`id:todo-item-${tasks[1].id}`);
  expect(tasks[1]).toMatchObject({ title: "Review (copy)", content: "Original content", cron: "15 9 * * 1,3" });
});

test("Delete asks first, then saves the list without the item", async () => {
  const { app, calls } = await openTodo();
  await app.press("id:todo-item-task-2");
  await app.press("id:todo-task-actions");
  await app.press("text:Delete");
  await app.waitFor('Delete job "Report"? This takes effect immediately.');
  await app.press("id:dialog-action-cancel");
  await app.waitFor("id:todo-delete-dialog", { state: "gone" });
  expect(proxied(calls, "PUT", "/todo/tasks").length).toBe(0);
  await app.press("id:todo-task-actions");
  await app.press("text:Delete");
  await app.press("id:dialog-action-delete");
  await app.waitFor("Deleted");
  await app.waitFor("id:todo-item-task-2", { state: "gone" });
  expect(proxied(calls, "PUT", "/todo/tasks").at(-1)!.json.tasks.map((task: { id: string }) => task.id)).toEqual(["task-1"]);
  // The deleted item's page closes: the list is back, without it.
  expect(app.shows("id:todo-item-task-1")).toBe(true);
  expect(app.shows("id:todo-task-editor")).toBe(false);
});

test("a failed delete keeps the item", async () => {
  const { app } = await openTodo({ "PUT /proxy:/todo/tasks": { status: 500, body: { error: "locked" } } });
  await app.press("id:todo-item-task-2");
  await app.press("id:todo-task-actions");
  await app.press("text:Delete");
  await app.press("id:dialog-action-delete");
  await app.waitFor("locked");
  // Its page stays open with the item, and the list still has it.
  expect(app.value("id:todo-title")).toBe("Report");
  await app.press("id:todo-back");
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
  await app.waitFor("id:todo-toolbar");
  // No topic yet: the way to it is there but takes no press.
  await expect(app.press("id:todo-open-topic")).rejects.toMatchObject({ code: "ERR_NSH_TEST_DISABLED" });
  await app.press("id:todo-run");
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
  await app.press("id:todo-run");
  await app.waitFor("queue is full");
  expect(app.shows("id:todo-run-dialog")).toBe(false);
  const order = agentWrites(calls)
    .map((call) => `${call.method} ${(call.uri || "").split("?")[0]}`);
  expect(order).toEqual(["PUT /todo/tasks", "POST /todo/tasks/task-1/run"]);
  expect(proxied(calls, "PUT", "/todo/tasks").at(-1)!.json.tasks[0].title).toBe("Review!");
});

test("an invalid item is not run: the validation error shows and nothing is sent", async () => {
  const { app, calls } = await openTodo({ "GET /proxy:/todo/tasks": { body: tasksBody({ tasks: [] }) } });
  await app.press("id:todo-empty-add");
  await app.waitFor("id:todo-task-editor");
  // A new item has no content yet.
  await app.press("id:todo-run");
  await app.waitFor("The job needs to say what to do.");
  expect(agentWrites(calls).length).toBe(0);
});

test("an item whose topic exists opens it from its toolbar; the menu keeps the other actions", async () => {
  const { app, calls } = await openTodo({
    "GET /proxy:/topics/_cron_task-1": { body: { id: "_cron_task-1", title: "Review" } },
  });
  await app.press("id:todo-item-task-1");
  await app.waitUntil(() => calls.some((call) => call.uri === "/topics/_cron_task-1"));
  // Start and the topic are the toolbar's own; the menu no longer repeats them.
  await app.press("id:todo-task-actions");
  await app.waitFor("text:Duplicate");
  expect(app.shows("text:Run manually")).toBe(false);
  expect(app.shows("text:Open topic")).toBe(false);
  await app.press("text:Duplicate");
  await app.waitUntil(() => app.value("id:todo-title") === "Review (copy)");
  await app.press("id:todo-back");
  await app.press("id:todo-item-task-1");
  await app.waitUntil(() => app.enabled("id:todo-open-topic"));
  await app.press("id:todo-open-topic");
  await app.waitUntil(() => lastLocation(app).endsWith("/chat/_cron_task-1"));
  // The copy is saved by the page; nothing was run.
  expect(agentWrites(calls).every((call) => call.method === "PUT" && call.uri === "/todo/tasks")).toBe(true);
});

test("a topic that does not come offers a lookup-only retry; closing the dialog keeps the run", async () => {
  const { app, calls } = await openTodo({
    "POST /proxy:/todo/tasks/task-2/run": { body: { ok: true } },
    "GET /proxy:/topics/_cron_task-2": { status: 500, body: { error: "topics unavailable" } },
  });
  await app.press("id:todo-item-task-2");
  await app.press("id:todo-run");
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
  // A running item has the turning ring and no word for it; its state is in its name for screen
  // readers. A waiting one says so.
  expect(app.texts()).toContain("Every 30 minutes");
  expect(app.texts().some((text) => /Running/.test(text))).toBe(false);
  expect(app.shows("label:Review, Running")).toBe(true);
  expect(app.shows("label:Heartbeat, Running")).toBe(true);
  expect(app.texts()).toContain("Waiting · On Jan 2 at 12:30 PM");
  await app.press("id:todo-item-task-1");
  await app.press("id:todo-task-actions");
  await expect(app.press("id:todo-run")).rejects.toMatchObject({ code: "ERR_NSH_TEST_DISABLED" });
});

/** A runtime whose Job runs the test changes: `state.runs` and `state.finished` as /todo/runs lists them. */
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
  // Stop is an icon button: named, its label not drawn.
  expect(app.count("label:Stop")).toBe(1);
  expect(app.texts()).not.toContain("Stop");
  await app.press("id:todo-stop");
  await app.waitFor("label:Stopping…");
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
  expect(app.count("label:Stopping…")).toBe(1);

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
  await app.waitFor("label:Stopping…");
  // The run completed anyway, and the item's schedule started its next run.
  live.state.runs = [{ ...RUN_A, run_id: "run_b", started_at: "2030-01-01T09:20:00Z" }];
  live.state.finished = [{ id: "task-1", run_id: "run_a", status: "done", stopping: true, finished_at: "2030-01-01T09:16:00Z" }];
  await app.waitFor('"Review" finished before it could stop.', { timeout: 4000 });
  expect(app.shows("text:/^Stopped/")).toBe(false);
  await app.waitFor("text:/^Last run .+ · Done$/");
  // The new run is not being stopped: its Stop is ready, and names it.
  await app.waitFor("label:Stop");
  await app.press("id:todo-stop");
  await app.waitFor("label:Stopping…");
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
  await app.waitFor("label:Stop");
  expect(app.shows("label:Stopping…")).toBe(false);
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
  await app.press("id:todo-back");
  await app.press("id:todo-item-task-2");
  await app.waitFor("text:Report");
  expect(app.shows("id:todo-stop")).toBe(false);
  await app.press("id:todo-back");
  await app.press("id:todo-heartbeat-item");
  await app.waitFor("text:Inbox");
  expect(app.shows("id:todo-stop")).toBe(false);
  expect(agentWrites(calls).length).toBe(0);
});

test("a run someone else is stopping shows Stopping… and sends nothing", async () => {
  const { app, calls } = await openTodo(liveRuns([{ ...RUN_A, stopping: true }]).api);
  await app.press("id:todo-item-task-1");
  await app.waitFor("label:Stopping…");
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
  await app.waitFor("label:Stopping…");
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
  // An invalid form is not sent.
  await still(app);
  expect(proxied(calls, "PUT", "/todo/tasks").every((call) => call.json.tasks[0].cron !== "bad cron")).toBe(true);
  await app.clear("id:todo-custom-cron");
  await app.type("id:todo-custom-cron", "*/10 * * * *");
  await app.waitFor("Every 10 minutes, run Review");
  await saved(app, calls);
  expect(proxied(calls, "PUT", "/todo/tasks").at(-1)!.json.tasks[0].cron).toBe("*/10 * * * *");
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
  await saved(app, calls);
  expect(proxied(calls, "PUT", "/todo/tasks").at(-1)!.json.tasks[1]).toMatchObject({
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
  // An invalid form is not sent.
  await still(app);
  expect(JSON.stringify(proxied(calls, "PUT", "/todo/tasks").map((call) => call.json))).not.toContain("1BAD");
  await app.clear("id:todo-bash-env-name-0");
  await app.type("id:todo-bash-env-name-0", "MODE");
  await app.type("id:todo-bash-env-value-0", "review");
  await app.press("id:todo-bash-env-add");
  await app.press("id:todo-bash-env-remove-1");
  await saved(app, calls);
  expect(proxied(calls, "PUT", "/todo/tasks").at(-1)!.json.tasks[1].bash_env).toEqual([{ name: "MODE", value: "review" }]);
});

/** The calendar's own read: the recorded runs queued in the range it asks for (none, unless given). */
function historyApi(items: Record<string, any>[] = []) {
  return {
    "GET /proxy:/todo/runs/history": (request: ApiRequest) => {
      const query = new URLSearchParams((request.uri || "").split("?")[1] || "");
      const from = Date.parse(query.get("from") || "");
      const to = Date.parse(query.get("to") || "");
      const inRange = items.filter((item) => Date.parse(item.queued_at) >= from && Date.parse(item.queued_at) < to);
      return { body: { items: inRange, limit: Number(query.get("limit")) } };
    },
  };
}

function ranRun(run_id: string, job_id: string, status: string, queued_at: string, cause: Record<string, string> = {}, error = "") {
  return {
    run_id,
    job_id,
    status,
    queued_at,
    error,
    cause: { kind: "schedule", trigger_id: "trg-schedule", from_job_id: "", origin_run_id: run_id, note: "", ...cause },
  };
}

const calendarDay = (date: string) => `id:todo-calendar-day-${date}`;

test("the calendar shows a month of what is planned; a day lists its runs, and a run opens its job", async () => {
  const { app } = await openTodo(historyApi());
  await app.waitFor("id:todo-item-task-1");
  // The views are tabs of the one page: the list's is the current one.
  expect(app.shows("id:todo-view-list-selected")).toBe(true);
  await app.press("id:todo-view-calendar");
  await app.waitFor("id:todo-calendar");
  expect(app.shows("id:todo-view-calendar-selected")).toBe(true);
  await app.waitUntil(() => lastLocation(app).includes("view=calendar"));
  expect(lastLocation(app)).toMatch(/month=\d{4}-\d{2}/);

  const month = lastLocation(app).match(/month=(\d{4})-(\d{2})/)!;
  const next = new Date(Number(month[1]), Number(month[2]), 1);
  await app.press("label:Next month");
  await app.waitUntil(() =>
    lastLocation(app).includes(`month=${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}`),
  );
  // Today goes back to this month.
  await app.press("id:todo-calendar-today");
  await app.waitUntil(() => lastLocation(app).includes(`month=${month[1]}-${month[2]}`));
  expect(app.count("label:/^Today, /")).toBe(1);

  const { app: jan } = await openTodo(historyApi(), { location: `${LOCATION}?view=calendar&month=2030-01` });
  await jan.waitFor("January 2030");
  // The one-time job is written in its day. The repeating one is a hollow mark there.
  await jan.waitFor(`${calendarDay("2030-01-02")} >> text:Report`);
  expect(jan.shows(`${calendarDay("2030-01-02")} >> text:Review`)).toBe(false);
  expect(jan.count(`${calendarDay("2030-01-02")} >> id:todo-calendar-mark-off`)).toBe(1);
  // The day's list, beside the grid, has both.
  await jan.press(calendarDay("2030-01-02"));
  await jan.waitFor("id:todo-day-detail");
  await jan.waitFor("id:todo-day-detail >> text:Wed, Jan 2");
  expect(jan.shows("id:todo-day-detail >> text:Review")).toBe(true);
  expect(jan.shows("id:todo-day-detail >> text:Report")).toBe(true);
  expect(jan.count("id:todo-day-detail >> text:By schedule")).toBe(2);
  await jan.press("id:todo-day-item-task-2");
  await jan.waitFor("id:todo-task-editor");
  expect(jan.value("id:todo-title")).toBe("Report");
  // Another day selects the day again.
  await jan.press(calendarDay("2030-01-03"));
  await jan.waitFor("id:todo-day-detail >> text:Thu, Jan 3");
  await jan.waitFor("No jobs scheduled for this day.");
  // The list's tab shows the list again.
  await jan.press("id:todo-view-list");
  await jan.waitFor("id:todo-index");
});

test("a month with nothing on it says so", async () => {
  const { app } = await openTodo(
    { "GET /proxy:/todo/tasks": { body: tasksBody({ tasks: [] }) }, ...historyApi() },
    { location: `${LOCATION}?view=calendar&month=2030-01` },
  );
  await app.waitFor("No jobs this month");
});

// January 2020 is over: its days show what ran. Review has two schedules and a poke, and Report
// runs after each Review (as GET /todo/tasks stores them: `triggers` and `uses`).
const WIRED_TASKS = [
  {
    id: "task-1",
    title: "Review",
    content: "Review it",
    cron: "0 9 * * *",
    tz: "UTC",
    triggers: [
      { id: "trg-a", kind: "schedule", cron: "0 9 * * *", tz: "UTC" },
      { id: "trg-b", kind: "schedule", cron: "0 18 * * 6", tz: "UTC" },
      { id: "trg-p", kind: "poke" },
    ],
  },
  { id: "task-2", title: "Report", content: "Write it", triggers: [], uses: [{ job_id: "task-1" }] },
];
const afterReview = (origin: string, note = "") => ({ kind: "job", trigger_id: "", from_job_id: "task-1", origin_run_id: origin, note });
const RAN = [
  ranRun("r1", "task-1", "done", "2020-01-07T09:00:00Z", { trigger_id: "trg-a" }),
  ranRun("d1", "task-2", "done", "2020-01-07T09:01:00Z", afterReview("r1")),
  ranRun("r3", "task-1", "failed", "2020-01-08T09:00:00Z", { trigger_id: "trg-a" }, "the model timed out"),
  ranRun("d3", "task-2", "skipped", "2020-01-08T09:00:00Z", afterReview("r3", "input job task-1 failed")),
  ranRun("r4", "task-1", "done", "2020-01-09T12:00:00Z", { kind: "poke", trigger_id: "trg-p" }),
  ranRun("d4", "task-2", "done", "2020-01-09T12:01:00Z", afterReview("r4")),
  ranRun("r2", "task-1", "done", "2020-01-11T18:00:00Z", { trigger_id: "trg-b" }),
  ranRun("d2", "task-2", "done", "2020-01-11T18:01:00Z", afterReview("r2")),
];

test("a past month shows what ran, from the run history: the usual repeats as marks, the rest in words", async () => {
  const marks = (app: any, date: string, kind: string) => app.count(`${calendarDay(date)} >> id:todo-calendar-mark-${kind}`);
  const { app, calls } = await openTodo(
    { "GET /proxy:/todo/tasks": { body: tasksBody({ tasks: WIRED_TASKS }) }, ...historyApi(RAN) },
    { location: `${LOCATION}?view=calendar&month=2020-01` },
  );
  await app.waitFor("January 2020");
  // The 7th: Review by its daily schedule and the Report after it, as usual: two marks, no words.
  await app.waitUntil(() => marks(app, "2020-01-07", "on") === 2);
  // No strip names the repeating jobs above the grid.
  expect(app.count("id:todo-calendar-repeating")).toBe(0);
  // The month's days were asked for, a full page at a time.
  const asked = proxied(calls, "GET", "/todo/runs/history");
  expect(asked.length).toBe(1);
  const query = new URLSearchParams(asked[0].uri!.split("?")[1]);
  expect(query.get("limit")).toBe("500");
  expect(query.get("from")).toMatch(/^2019-12-2[78]T/);
  expect(query.get("to")).toMatch(/^2020-02-0[89]T/);
  expect(app.shows(`${calendarDay("2020-01-07")} >> text:Review`)).toBe(false);
  // The 11th, a Saturday: the run of the second schedule folds too.
  expect(marks(app, "2020-01-11", "on")).toBe(2);
  expect(app.shows(`${calendarDay("2020-01-11")} >> text:Review`)).toBe(false);
  // The 8th: the failure and the skipped Report are written.
  expect(marks(app, "2020-01-08", "on")).toBe(0);
  expect(app.shows(`${calendarDay("2020-01-08")} >> text:Review`)).toBe(true);
  expect(app.shows(`${calendarDay("2020-01-08")} >> text:Report`)).toBe(true);
  // The 9th: a poke, and the Report it led to, are never folded.
  expect(marks(app, "2020-01-09", "on")).toBe(0);
  expect(app.shows(`${calendarDay("2020-01-09")} >> text:Review`)).toBe(true);
  expect(app.shows(`${calendarDay("2020-01-09")} >> text:Report`)).toBe(true);
  // A past day shows no plan: nothing ran on the 10th.
  expect(marks(app, "2020-01-10", "on") + marks(app, "2020-01-10", "off")).toBe(0);
  expect(app.shows(`${calendarDay("2020-01-10")} >> text:Review`)).toBe(false);

  // The day's list says what happened, the Report under the Review that led to it.
  await app.press(calendarDay("2020-01-08"));
  await app.waitFor("id:todo-day-detail >> text:Wed, Jan 8");
  expect(app.shows("id:todo-day-detail >> text:By schedule · failed: the model timed out")).toBe(true);
  expect(app.shows("id:todo-day-detail >> text:Skipped: input job Review failed")).toBe(true);
  expect(app.count("id:todo-day-detail >> id:todo-day-row-d1 >> text:Report")).toBe(1);
  await app.press(calendarDay("2020-01-09"));
  await app.waitFor("id:todo-day-detail >> text:By poke");
  expect(app.shows("id:todo-day-detail >> text:After Review")).toBe(true);
  await app.press("id:todo-day-item-task-1");
  await app.waitFor("id:todo-task-editor");
  expect(app.value("id:todo-title")).toBe("Review");

  // Another month asks for its own days.
  await app.press("label:Previous month");
  await app.waitFor("December 2019");
  await app.waitUntil(() => proxied(calls, "GET", "/todo/runs/history").length === 2);
  expect(new URLSearchParams(proxied(calls, "GET", "/todo/runs/history")[1].uri!.split("?")[1]).get("from")).toMatch(/^2019-11-(29|30)T/);
});

test("a run history that cannot be read says so, and the plan still shows", async () => {
  const { app, calls } = await openTodo(
    { "GET /proxy:/todo/runs/history": { status: 500, body: { error: "history is away" } } },
    { location: `${LOCATION}?view=calendar&month=2030-01` },
  );
  await app.waitFor("id:todo-calendar-error");
  expect(app.texts().some((text) => text.startsWith("Could not read what ran: "))).toBe(true);
  await app.waitFor(`${calendarDay("2030-01-02")} >> text:Report`);
  const before = proxied(calls, "GET", "/todo/runs/history").length;
  await app.press("id:todo-calendar-retry");
  await app.waitUntil(() => proxied(calls, "GET", "/todo/runs/history").length === before + 1);
});

test("the calendar reads the history again when a job starts running", async () => {
  const live = liveRuns([]);
  const { app, calls } = await openTodo({ ...live.api, ...historyApi() }, { location: `${LOCATION}?view=calendar&month=2030-01` });
  await app.waitFor("January 2030");
  const asked = () => proxied(calls, "GET", "/todo/runs/history").length;
  await app.waitUntil(() => asked() >= 1);
  await app.wait(300);
  const before = asked();
  live.state.runs = [RUN_A];
  // The page polls its live runs every five seconds.
  await app.waitUntil(() => asked() > before, { timeout: 9000 });
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
  const kept = app.host.calls().filter((call) => call.name === "morph.kv.set");
  expect(JSON.stringify(kept)).toContain("/home/u/projects/reports");
  await saved(app, calls);
  expect(proxied(calls, "PUT", "/todo/tasks").at(-1)!.json.tasks[0].workspace_dir).toBe("/home/u/projects/reports");
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
  // The job is named by its title field, not by the bar.
  expect(app.value("id:todo-title")).toBe("Report");
  await app.press("id:todo-back");
  await app.waitFor("id:todo-index");
  await app.press("id:todo-fab");
  await app.waitFor("id:todo-task-editor");
  expect(app.value("id:todo-title")).toBe("Untitled job");
  expect(agentWrites(calls).length).toBe(0);
});

test("on a phone the calendar's days are marks, and the chosen day's list is under the grid", async () => {
  const { app } = await openTodo(historyApi(), { width: 390, height: 844, location: `${LOCATION}?view=calendar&month=2030-01` });
  await app.waitFor("Jan 2030");
  await app.waitFor(calendarDay("2030-01-02"));
  expect(app.shows("id:todo-calendar-add")).toBe(false);
  // The repeating Review is the small mark, the one-time Report a full one; neither is written in the grid.
  await app.waitUntil(() => app.count(`${calendarDay("2030-01-02")} >> id:todo-calendar-mark-off-small`) === 1);
  expect(app.count(`${calendarDay("2030-01-02")} >> id:todo-calendar-mark-off`)).toBe(1);
  expect(app.shows(`${calendarDay("2030-01-02")} >> text:Report`)).toBe(false);
  await app.press(calendarDay("2030-01-02"));
  await app.waitFor("Selected day");
  await app.waitFor("id:todo-calendar-agenda >> text:Wed, Jan 2");
  expect(app.shows("id:todo-calendar-agenda >> text:Review")).toBe(true);
  await app.press("text:Report");
  await app.waitFor("id:todo-task-editor");
  // The task slides in over the calendar, which goes once the slide has ended.
  await app.waitFor("id:todo-calendar", { state: "gone" });
});

test("a day writes five runs and counts the rest; its list has them all", async () => {
  const once = (id: string, title: string, minute: number) => ({ id, title, content: "x", at: `2030-01-15 09:0${minute}`, tz: "UTC" });
  const names = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta", "Eta"];
  const { app } = await openTodo(
    {
      "GET /proxy:/todo/tasks": { body: tasksBody({ tasks: names.map((title, index) => once(title.toLowerCase(), title, index)) }) },
      ...historyApi(),
    },
    { location: `${LOCATION}?view=calendar&month=2030-01` },
  );
  await app.waitFor(`${calendarDay("2030-01-15")} >> text:+2 more`);
  expect(app.shows(`${calendarDay("2030-01-15")} >> text:Epsilon`)).toBe(true);
  expect(app.shows(`${calendarDay("2030-01-15")} >> text:Zeta`)).toBe(false);
  // The whole cell chooses the day; the day's list is complete.
  await app.press(calendarDay("2030-01-15"));
  await app.waitFor("id:todo-day-detail >> text:Tue, Jan 15");
  expect(app.count("id:todo-day-detail >> id:todo-day-row-d0")).toBe(7);
  await app.press("id:todo-day-item-eta");
  await app.waitFor("id:todo-task-editor");
  expect(app.value("id:todo-title")).toBe("Eta");
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
  await still(app);
  expect(proxied(calls, "PUT", "/todo/tasks").length).toBe(0);
  answer = "granted";
  await app.press("label:Notify Chat");
  await app.press("text:Console User");
  await saved(app, calls);
  expect(proxied(calls, "PUT", "/todo/tasks").at(-1)!.json.tasks[0].chat_id).toBe("console:user");
});

test("on the desktop, notifying the console user needs the system's notification service, asked once", async () => {
  let requests = 0;
  let answer: () => string = () => {
    throw new Error("timed out");
  };
  const { app, calls } = await openTodo(
    {
      "GET /proxy:/todo/tasks": {
        body: tasksBody({ chat_options: [{ chat_id: "console:user", name: "Console", platform: "console" }] }),
      },
    },
    {
      runtime: "desktop",
      features: ["notifications"],
      host: {
        "morph.notify.request": () => {
          requests += 1;
          return answer();
        },
      },
    },
  );
  await app.press("id:todo-item-task-1");
  await app.press("label:Notify Chat");
  await app.press("text:Console User");
  await app.waitFor("System notifications are unavailable: the system's notification service did not answer.");
  expect(requests).toBe(1);
  answer = () => "unsupported";
  await app.press("label:Notify Chat");
  await app.press("text:Console User");
  await app.waitUntil(() => requests === 2);
  await still(app);
  expect(proxied(calls, "PUT", "/todo/tasks").length).toBe(0);
  answer = () => "granted";
  await app.press("label:Notify Chat");
  await app.press("text:Console User");
  await app.waitUntil(() => requests === 3);
  await saved(app, calls);
  expect(proxied(calls, "PUT", "/todo/tasks").at(-1)!.json.tasks[0].chat_id).toBe("console:user");
});

/* ---------- the content: a plain textarea with the reference toolbar ---------- */

const CONTACTS = {
  "GET /proxy:/contacts/list": { body: { items: [{ contact_id: "tg:42", nickname: "Alice", channel: "telegram" }] } },
  "GET /proxy:/contacts/chat-profile": {
    body: { items: [{ chat_id: "tg:-100", name: "Team", platform: "telegram", type: "group" }] },
  },
};

test("the content is a plain textarea under the reference toolbar, with no Markdown preview", async () => {
  const { app, calls } = await openTodo();
  await app.press("id:todo-item-task-1");
  await app.waitFor("id:todo-content-source");
  // The stored Markdown shows as it is, in a regular field.
  expect(app.value("id:todo-content-source")).toBe("Original content");
  expect(app.shows("id:todo-content-edit")).toBe(false);
  expect(app.shows("id:todo-content-preview")).toBe(false);
  expect(app.shows("id:todo-content-frame")).toBe(false);
  expect(app.enabled("id:markdown-editor-mention")).toBe(true);
  expect(app.enabled("id:markdown-editor-conversation")).toBe(true);
  // Typed Markdown (a line break, a list) goes in and out unchanged.
  await app.type("id:todo-content-source", "\n- **step** one");
  expect(app.value("id:todo-content-source")).toBe("Original content\n- **step** one");
  await saved(app, calls);
  const tasks = proxied(calls, "PUT", "/todo/tasks").at(-1)!.json.tasks;
  expect(tasks[0]).toMatchObject({ id: "task-1", content: "Original content\n- **step** one" });
  expect(tasks[1]).toMatchObject({ id: "task-2", content: "Write it" });
});

test("a contact and a conversation picked from the toolbar go into the content, which keeps the focus", async () => {
  const { app, calls } = await openTodo(CONTACTS);
  await app.press("id:todo-item-task-2");
  await app.waitFor("id:todo-content-source");
  await app.press("id:markdown-editor-mention");
  await app.waitFor("id:markdown-editor-mention-dialog");
  await app.waitFor("text:Alice");
  await app.press("text:Alice");
  await app.waitUntil(() => app.value("id:todo-content-source") === "Write it [Alice](tg:42)");
  // The caret is back in the field, after the mention.
  await app.keyboard.press("x");
  await app.waitUntil(() => app.value("id:todo-content-source") === "Write it [Alice](tg:42)x");
  await app.press("id:markdown-editor-conversation");
  await app.waitFor("text:Team");
  await app.press("text:Team");
  await app.waitUntil(() => app.value("id:todo-content-source") === "Write it [Alice](tg:42)x [Team](tg:-100)");
  await saved(app, calls);
  const tasks = proxied(calls, "PUT", "/todo/tasks").at(-1)!.json.tasks;
  expect(tasks[1]).toMatchObject({ id: "task-2", content: "Write it [Alice](tg:42)x [Team](tg:-100)" });
});

test("another item's content shows in the same field, and a mention goes into that item only", async () => {
  const { app, calls } = await openTodo(CONTACTS);
  await app.press("id:todo-item-task-1");
  await app.type("id:todo-content-source", " today");
  await app.press("id:todo-back");
  await app.press("id:todo-item-task-2");
  await app.waitUntil(() => app.value("id:todo-content-source") === "Write it");
  await app.press("id:markdown-editor-mention");
  await app.press("text:Alice");
  await app.waitUntil(() => app.value("id:todo-content-source") === "Write it [Alice](tg:42)");
  await saved(app, calls);
  const tasks = proxied(calls, "PUT", "/todo/tasks").at(-1)!.json.tasks;
  expect(tasks.find((task: { id: string }) => task.id === "task-2").content).toBe("Write it [Alice](tg:42)");
  expect(tasks.find((task: { id: string }) => task.id === "task-1").content).not.toContain("Alice");
});

/* ---------- job references: "[label](job:<id>)" ---------- */

const JOB_DIALOG = "id:markdown-editor-job-dialog";

test("a job picked from the toolbar goes into the content as a reference to its ID, and the caret stays", async () => {
  const { app, calls } = await openTodo();
  await app.press("id:todo-item-task-2");
  await app.waitFor("id:todo-content-source");
  expect(app.enabled("id:markdown-editor-job")).toBe(true);
  await app.press("id:markdown-editor-job");
  await app.waitFor(JOB_DIALOG);
  // Every saved job is listed with its schedule and its ID, the item being edited too.
  await app.waitFor(`${JOB_DIALOG} >> text:Review`);
  expect(app.shows(`${JOB_DIALOG} >> text:15 9 * * 1,3 · task-1`)).toBe(true);
  expect(app.shows(`${JOB_DIALOG} >> text:Report`)).toBe(true);
  expect(app.shows(`${JOB_DIALOG} >> text:2030-01-02 12:30 · task-2`)).toBe(true);
  await app.press(`${JOB_DIALOG} >> text:Review`);
  await app.waitFor(JOB_DIALOG, { state: "gone" });
  await app.waitUntil(() => app.value("id:todo-content-source") === "Write it [Review](job:task-1)");
  // The caret is back in the field, after the reference.
  await app.keyboard.press("x");
  await app.waitUntil(() => app.value("id:todo-content-source") === "Write it [Review](job:task-1)x");
  await saved(app, calls);
  const tasks = proxied(calls, "PUT", "/todo/tasks").at(-1)!.json.tasks;
  expect(tasks[1]).toMatchObject({ id: "task-2", content: "Write it [Review](job:task-1)x" });
  expect(tasks[0]).toMatchObject({ id: "task-1", content: "Original content" });
  // Picking only reads the list: nothing was run, changed or deleted for it.
  expect(agentWrites(calls).map((call) => `${call.method} ${call.uri}`)).toEqual(["PUT /todo/tasks"]);
});

test("the job list filters, tells same-named jobs apart by ID, and keeps the label safe", async () => {
  const { app } = await openTodo({
    "GET /proxy:/todo/tasks": {
      body: tasksBody({
        tasks: [
          { id: "job-aaaa", title: "Daily [ops] report", content: "A", cron: "0 9 * * *" },
          { id: "job-bbbb", title: "Daily [ops] report", content: "B", cron: "0 18 * * *", enabled: false },
          { id: "job-cccc", title: "", content: "C", at: "2031-05-06 07:08" },
          { id: "bad id (1)", title: "Unreferenceable", content: "D", cron: "0 1 * * *" },
        ],
      }),
    },
  });
  await app.press("id:todo-item-job-cccc");
  await app.waitFor("id:todo-content-source");
  await app.press("id:markdown-editor-job");
  await app.waitFor(`${JOB_DIALOG} >> text:0 9 * * * · job-aaaa`);
  expect(app.shows(`${JOB_DIALOG} >> text:0 18 * * * · disabled · job-bbbb`)).toBe(true);
  expect(app.shows(`${JOB_DIALOG} >> text:Untitled job`)).toBe(true);
  // An ID that cannot stand in "(job:<id>)" is not offered.
  expect(app.shows(`${JOB_DIALOG} >> text:Unreferenceable`)).toBe(false);
  // The filter reads titles and the schedule-and-ID line.
  await app.type("label:Select a job", "bbbb");
  await app.waitFor(`${JOB_DIALOG} >> text:0 9 * * * · job-aaaa`, { state: "gone" });
  expect(app.shows(`${JOB_DIALOG} >> text:Untitled job`)).toBe(false);
  await app.press(`${JOB_DIALOG} >> text:0 18 * * * · disabled · job-bbbb`);
  // Brackets in the title would end the label early: they are left out of it. The ID is the job.
  await app.waitUntil(() => app.value("id:todo-content-source") === "C [Daily ops report](job:job-bbbb)");
});

test("a job reference typed by hand is kept as typed, and the list is read again each time it opens", async () => {
  let title = "Review";
  let fail = false;
  const { app, calls } = await openTodo({
    "GET /proxy:/todo/tasks": () =>
      fail
        ? { status: 500, body: { error: "boom" } }
        : { body: tasksBody({ tasks: [{ id: "task-1", title, content: "Original content", cron: "15 9 * * 1,3", tz: "UTC+9" }, { id: "task-2", title: "Report", content: "Write it", at: "2030-01-02 12:30", tz: "UTC" }] }) },
  });
  await app.press("id:todo-item-task-2");
  await app.waitFor("id:todo-content-source");
  await app.type("id:todo-content-source", " after [any label at all](job:task-1)");
  expect(app.value("id:todo-content-source")).toBe("Write it after [any label at all](job:task-1)");
  // The job is renamed elsewhere: the next pick has its new title, and the same ID.
  title = "Weekly review";
  await app.press("id:markdown-editor-job");
  await app.waitFor(`${JOB_DIALOG} >> text:Weekly review`);
  await app.press(`${JOB_DIALOG} >> text:Weekly review`);
  await app.waitUntil(() => app.value("id:todo-content-source") === "Write it after [any label at all](job:task-1) [Weekly review](job:task-1)");
  // A list that cannot be read says so, and inserts nothing.
  fail = true;
  await app.press("id:markdown-editor-job");
  await app.waitFor(`${JOB_DIALOG} >> text:Could not load jobs.`);
  await app.press(`${JOB_DIALOG} >> label:Close`);
  await app.waitFor(JOB_DIALOG, { state: "gone" });
  fail = false;
  expect(app.value("id:todo-content-source")).toBe("Write it after [any label at all](job:task-1) [Weekly review](job:task-1)");
  await saved(app, calls);
  expect(proxied(calls, "PUT", "/todo/tasks").at(-1)!.json.tasks[1].content).toBe(
    "Write it after [any label at all](job:task-1) [Weekly review](job:task-1)",
  );
});

test("a save sends the revision the list was read at, and one the list has moved past is refused without losing the edit", async () => {
  let revision = 7;
  let stale = false;
  const { app, calls } = await openTodo({
    "GET /proxy:/todo/tasks": () => ({ body: tasksBody({ revision }) }),
    "PUT /proxy:/todo/tasks": (request: ApiRequest) => {
      if (stale || request.json?.revision !== revision) {
        return { status: 409, body: { error: "the job list changed since it was read; nothing was saved, reload it and try again (read at revision 7, now 8)" } };
      }
      revision += 1;
      return { body: { ...tasksBody({ revision }), tasks: request.json?.tasks } };
    },
  });
  await app.press("id:todo-item-task-1");
  await app.waitFor("id:todo-task-editor");
  await app.clear("id:todo-title");
  await app.type("id:todo-title", "Weekly review");
  await saved(app, calls);
  // Each save sends the revision the one before it returned.
  const first = proxied(calls, "PUT", "/todo/tasks").length;
  await app.type("id:todo-title", "!");
  await saved(app, calls, first + 1);
  expect(proxied(calls, "PUT", "/todo/tasks").map((call) => call.json.revision)).toEqual(
    proxied(calls, "PUT", "/todo/tasks").map((_, index) => 7 + index),
  );
  // The agent adds a job meanwhile: the next save is refused and says why; the edit stays.
  stale = true;
  await app.type("id:todo-title", " again");
  await app.waitUntil(() => app.texts().some((text: string) => text.startsWith("The list of jobs changed since this page loaded it")));
  expect(app.value("id:todo-title")).toBe("Weekly review! again");
});

test("a TODO list that could not be imported shows the agent's report of each rejected record", async () => {
  const report = "cron.yaml was not imported into agent.db (nothing was imported; fix or remove the records named here and the import runs again): record 2: task id is missing";
  const { app } = await openTodo({ "GET /proxy:/todo/tasks": { status: 409, body: { error: report } } });
  await app.waitFor(report);
});

/* ---------- triggers and the jobs a job uses ---------- */

// A runtime that knows triggers lists them on every job (and the jobs a job uses, and its join rule).
function linkedTasks() {
  return [
    { id: "report", title: "Morning report", content: "Summarize", cron: "0 9 * * *", tz: "UTC", triggers: [{ id: "trg-schedule", kind: "schedule", cron: "0 9 * * *", tz: "UTC" }] },
    {
      id: "digest",
      title: "Team digest",
      content: "Rewrite it",
      triggers: [],
      uses: [{ job_id: "report" }],
    },
    { id: "notes", title: "Release notes", content: "Draft", triggers: [{ id: "hook", kind: "poke" }] },
  ];
}

function openLinked(overrides: Record<string, unknown> = {}) {
  return openTodo({
    "GET /proxy:/todo/tasks": {
      body: tasksBody({ tasks: linkedTasks(), chat_options: [{ chat_id: "tg:-100", platform: "telegram", type: "group", name: "Family" }] }),
    },
    "PUT /proxy:/todo/tasks": (request: ApiRequest) => ({ body: { ...tasksBody(), tasks: request.json?.tasks } }),
    ...overrides,
  });
}

test("the list says what starts a job with no schedule, and its page offers no schedule controls", async () => {
  const { app } = await openLinked();
  await app.waitFor("id:todo-item-digest");
  // The list says what starts each job: another job finishing, a poke, or a schedule and more.
  expect(app.shows("id:todo-item-digest >> text:Each time Morning report finishes")).toBe(true);
  expect(app.shows("id:todo-item-notes >> text:When its URL is poked")).toBe(true);
  await app.press("id:todo-item-digest");
  await app.waitFor("id:todo-task-editor");
  expect(app.shows("text:No schedule")).toBe(true);
  expect(app.shows("id:todo-preview")).toBe(false);
  expect(app.shows("id:todo-timezone")).toBe(false);
});

test("the page offers no poke or message trigger to add; one a job already has is shown, kept by a save and can be removed", async () => {
  const { app, calls } = await openLinked({
    "GET /proxy:/todo/tasks": {
      body: tasksBody({
        tasks: linkedTasks().map((task) =>
          task.id === "notes" ? { ...task, triggers: [...task.triggers, { id: "chat", kind: "message", channel: "telegram", chat_id: "tg:-100" }] } : task,
        ),
        chat_options: [{ chat_id: "tg:-100", platform: "telegram", type: "group", name: "Family" }],
      }),
    },
  });
  // A job with a schedule only: nothing about pokes or messages.
  await app.press("id:todo-item-report");
  await app.waitFor("id:todo-task-editor");
  for (const id of ["todo-triggers", "todo-trigger-poke", "todo-trigger-message-add"]) expect(app.count(`id:${id}`)).toBe(0);
  expect(app.texts()).not.toContain("When its URL is poked");
  expect(app.texts()).not.toContain("Message from");
  // A job that has such triggers (set through the agent or the API) lists them.
  await app.press("id:todo-back");
  await app.press("id:todo-item-notes");
  await app.waitFor("id:todo-triggers");
  expect(app.shows("id:todo-trigger-0 >> text:When its URL is poked")).toBe(true);
  expect(app.shows("id:todo-trigger-1 >> text:When a message arrives in Family")).toBe(true);
  for (const id of ["todo-trigger-poke", "todo-trigger-message-add"]) expect(app.count(`id:${id}`)).toBe(0);
  await app.press("id:todo-trigger-1-remove");
  await app.waitFor("text:When a message arrives in Family", { state: "gone" });
  await saved(app, calls);
  const sent = proxied(calls, "PUT", "/todo/tasks").at(-1)!.json.tasks;
  // The poke trigger is sent as it was; the others are untouched.
  expect(sent[2].triggers).toEqual([{ kind: "poke", id: "hook" }]);
  expect(sent[0]).toMatchObject({ id: "report", cron: "0 9 * * *", tz: "UTC" });
  expect(sent[0].triggers).toEqual([{ kind: "schedule", id: "trg-schedule", cron: "0 9 * * *", tz: "UTC" }]);
  expect(sent[1]).toEqual({ id: "digest", title: "Team digest", content: "Rewrite it", triggers: [], uses: [{ job_id: "report" }] });
});

test("a job's page lists what it uses and what uses it, and each name opens that job", async () => {
  const { app } = await openLinked();
  await app.press("id:todo-item-digest");
  await app.waitFor("id:todo-uses");
  expect(app.shows("id:todo-use-report >> text:Morning report")).toBe(true);
  // One behaviour, nothing to choose per job; the block's label says it, with no note under it.
  expect(app.count("id:todo-uses-note")).toBe(0);
  expect(app.count("id:todo-use-report-mode")).toBe(0);
  await app.press("label:Morning report");
  await app.waitUntil(() => app.value("id:todo-title") === "Morning report");
  expect(app.shows("id:todo-used-by-digest >> text:Team digest")).toBe(true);
  expect(app.count("id:todo-used-by-note")).toBe(0);
});

test("a use is added and removed; a job that depends on this one is not offered", async () => {
  const { app, calls } = await openLinked();
  await app.press("id:todo-item-digest");
  await app.waitFor("id:todo-uses");
  await app.press("id:todo-use-add");
  await app.press("text:Release notes");
  await app.waitFor("id:todo-use-notes");
  await saved(app, calls);
  expect(proxied(calls, "PUT", "/todo/tasks").at(-1)!.json.tasks[1].uses).toEqual([
    { job_id: "report" },
    { job_id: "notes" },
  ]);
  await app.press("id:todo-use-notes-remove");
  await app.waitFor("id:todo-use-notes", { state: "gone" });
  // Morning report is used by Team digest, so it cannot use Team digest in turn.
  await app.press("id:todo-back");
  await app.press("id:todo-item-report");
  await app.waitFor("id:todo-uses");
  // (Team digest is named once on the page, under "Used by"; the list of jobs to use adds no second.)
  const before = app.count("text:Team digest");
  await app.press("id:todo-use-add");
  await app.waitFor("text:Release notes");
  expect(app.count("text:Team digest")).toBe(before);
});

test("a runtime that knows no triggers gets the form as before, with nothing about triggers or uses", async () => {
  const { app, calls } = await openTodo();
  await app.press("id:todo-item-task-1");
  await app.waitFor("id:todo-task-editor");
  expect(app.shows("id:todo-triggers")).toBe(false);
  expect(app.shows("id:todo-uses")).toBe(false);
  await app.press("id:todo-schedule-mode");
  expect(app.shows("text:No schedule")).toBe(false);
  expect(calls.length).toBeGreaterThan(0);
});

/* ---------- writing a job in words ---------- */

test("a sentence in the list's composer goes to the agent, and a note leads to the topic where it writes the job", async () => {
  const { app, calls } = await openTodo({
    "POST /proxy:/tasks": { body: { id: "task-new", status: "queued", topic_id: "topic-9" } },
  });
  await app.waitFor("id:todo-compose");
  expect(app.shows("id:todo-compose-note")).toBe(false);
  await app.type("id:chat-composer-input", "every Monday at 8, summarize open issues");
  await app.press("id:chat-composer-send");
  await app.waitFor("id:todo-compose-note");
  const posts = proxied(calls, "POST", "/tasks");
  expect(posts.length).toBe(1);
  // The page asks the agent; it does not parse the sentence itself.
  expect(posts[0].json.task).toContain("every Monday at 8, summarize open issues");
  expect(posts[0].json.task).toContain("job_manage");
  expect(posts[0].json.trigger).toEqual({ source: "ui", event: "job_compose", ref: "web/console/todo" });
  expect(app.value("id:chat-composer-input")).toBe("");
  await app.press("id:todo-compose-topic");
  await app.waitUntil(() => lastLocation(app).endsWith("/chat/topic-9"));
});

test("a request the agent does not take says why and keeps the sentence", async () => {
  const { app } = await openTodo({ "POST /proxy:/tasks": { status: 500, body: { error: "busy" } } });
  await app.waitFor("id:todo-compose");
  await app.type("id:chat-composer-input", "water the plants on Sunday");
  await app.press("id:chat-composer-send");
  await app.waitFor("text:/Could not ask the agent: .*busy/");
  expect(app.value("id:chat-composer-input")).toBe("water the plants on Sunday");
  expect(app.shows("id:todo-compose-note")).toBe(false);
});

/* ---------- run history ---------- */

const CAUSE = { trigger_id: "", from_job_id: "", origin_run_id: "r1", note: "" };
const HISTORY = [
  { run_id: "r3", job_id: "digest", status: "skipped", queued_at: "2030-01-02T09:01:00Z", finished_at: "2030-01-02T09:01:00Z", cause: { ...CAUSE, kind: "job", from_job_id: "report", note: "input job report failed" } },
  { run_id: "r2", job_id: "report", status: "failed", queued_at: "2030-01-02T09:00:00Z", started_at: "2030-01-02T09:00:01Z", finished_at: "2030-01-02T09:05:00Z", error: "the model timed out", cause: { ...CAUSE, kind: "schedule" } },
  { run_id: "r1", job_id: "report", status: "done", queued_at: "2030-01-01T17:42:00Z", started_at: "2030-01-01T17:42:00Z", finished_at: "2030-01-01T17:42:41Z", cause: { ...CAUSE, kind: "poke" } },
];

function runsApi(calls: string[] = []) {
  return {
    "GET /proxy:/todo/runs/history": (request: ApiRequest) => {
      calls.push(request.uri || "");
      const jobID = new URL(`http://x${request.uri}`).searchParams.get("job_id");
      return { body: { items: jobID ? HISTORY.filter((run) => run.job_id === jobID) : HISTORY, limit: 50 } };
    },
  };
}

test("a job's page lists its runs with why each started and how a failed one ended, in place of the last-run line", async () => {
  const asked: string[] = [];
  const { app } = await openLinked(runsApi(asked));
  await app.press("id:todo-item-report");
  await app.waitFor("id:todo-runs");
  expect(asked.some((uri) => uri.includes("job_id=report"))).toBe(true);
  expect(app.shows("id:todo-run-row-r2 >> text:By schedule")).toBe(true);
  expect(app.shows("id:todo-run-row-r2 >> text:Failed: the model timed out")).toBe(true);
  expect(app.shows("id:todo-run-row-r1 >> text:By a poke")).toBe(true);
  // A finished run's mark says so: only its duration is written.
  expect(app.shows("id:todo-run-row-r1 >> text:41 s")).toBe(true);
  expect(app.shows("id:todo-run-row-r1 >> text:Finished")).toBe(false);
  expect(app.shows("id:todo-run-row-r3")).toBe(false);
  expect(app.shows("id:todo-last-run")).toBe(false);
});

test("beside the list, Today names each run's job and cause, and a run opens its job", async () => {
  const { app } = await openLinked(runsApi());
  await app.waitFor("id:todo-today");
  expect(app.shows("id:todo-today >> text:Today")).toBe(true);
  expect(app.shows("id:todo-run-row-r3 >> text:Team digest")).toBe(true);
  expect(app.shows("id:todo-run-row-r3 >> text:By Morning report · Skipped: input job report failed")).toBe(true);
  await app.press("id:todo-run-row-r2");
  await app.waitUntil(() => app.value("id:todo-title") === "Morning report");
});

test("a runtime without the run history shows no Today and keeps the last-run line", async () => {
  const { app } = await openLinked();
  await app.waitFor("id:todo-item-report");
  expect(app.shows("id:todo-today")).toBe(false);
  await app.press("id:todo-item-report");
  await app.waitFor("id:todo-last-run");
  expect(app.shows("id:todo-runs")).toBe(false);
});

/* ---------- the flow view ---------- */

test("the flow tab shows the jobs as a graph under the same head, with no way back; the list's tab shows the list", async () => {
  const { app } = await openLinked();
  await app.waitFor("id:todo-item-report");
  await app.press("id:todo-view-flow");
  await app.waitFor("id:todo-flow-page");
  await app.waitUntil(() => lastLocation(app).includes("view=flow"));
  for (const title of ["Morning report", "Team digest", "Release notes"]) expect(app.shows(`text:${title}`)).toBe(true);
  // The link says what Team digest waits for; its line says only the rest.
  expect(app.shows("text:Each time Morning report finishes")).toBe(false);
  // A view of the page, not a page under it: the same title and tabs, and no back arrow.
  expect(app.shows("id:todo-flow-page >> text:Jobs")).toBe(true);
  expect(app.shows("id:todo-view-flow-selected")).toBe(true);
  expect(app.count("id:todo-flow-back")).toBe(0);
  await app.press("id:todo-view-list");
  await app.waitFor("id:todo-item-report");
  expect(app.shows("id:todo-flow-page")).toBe(false);
});

test("a runtime that knows no triggers offers no flow view", async () => {
  const { app } = await openTodo();
  await app.waitFor("id:todo-item-task-1");
  expect(app.shows("id:todo-view-flow")).toBe(false);
});
