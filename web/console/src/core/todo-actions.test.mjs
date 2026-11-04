import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";
import { computed, effectScope, nextTick, reactive, ref, watch } from "vue";
import { createArrivalTracker, createHighlightWindow } from "./arrivals.js";
import { isValidCronExpression } from "./cron.js";
import { normalizeTodoRuns, todoRunsSignature, TODO_RUN_RUNNING } from "./todo-runs.js";

const source = (await readFile(new URL("../views/TodoView.js", import.meta.url), "utf8"))
  .replace(/^import[\s\S]*?;\n/gm, "")
  .replace("export default TodoView;", "globalThis.TodoView = TodoView;");
const i18n = (await readFile(new URL("../i18n/index.js", import.meta.url), "utf8"))
  .replace(/^import[\s\S]*?;\n/gm, "")
  .replace(/export \{[\s\S]*?\};/u, "globalThis.translate = translate;");
const plain = (value) => JSON.parse(JSON.stringify(value));
const task = (extra = {}) => ({
  id: "task-1", title: "Review", content: "Original content", cron: "15 9 * * 1,3",
  tz: "UTC+9", workspace_dir: "workspaces/review", chat_id: "console:user",
  llm_profile: "reviewer", bash_env: [{ name: "MODE", value: "review" }], ...extra,
});

async function mount(t, { rows = [task()], runs = [], request = async () => ({}), lang = "en" } = {}) {
  const calls = [];
  const errors = [];
  const successes = [];
  const context = {
    computed, ref, watch, createArrivalTracker, createHighlightWindow, isValidCronExpression,
    normalizeTodoRuns, todoRunsSignature, TODO_RUN_RUNNING,
    AppSkeleton: {}, AppFab: {}, AppPage: {}, AppMarkdownEditor: {}, AppTabs: {},
    TodoCalendar: {}, WorkspaceDirPickerDialog: {},
    ...Object.fromEntries(["Discord", "WeChat", "WhatsApp", "Bluesky", "X", "Lark", "Line", "Slack", "Telegram"]
      .map((name) => [`channel${name}LogoURL`, ""])),
    useNotice: () => ({ error: (message) => errors.push(message), success: (message) => successes.push(message) }),
    useRoute: () => ({ query: {} }), useRouter: () => ({ replace() {} }),
    onMounted() {}, onUnmounted() {},
    endpointState: reactive({ selectedRef: "endpoint-one" }),
    localeState: { lang }, i18nExtensions: {},
    runtimeApiFetch: async (path, options) => {
      if (path === "/todo/runs") return { runs };
      if (!options) return { tasks: rows, runs };
      calls.push({ path, ...plain(options) });
      return request(path, options);
    },
  };
  vm.runInNewContext(i18n, context);
  vm.runInNewContext(source, context);
  const scope = effectScope();
  const view = scope.run(() => context.TodoView.setup());
  t.after(() => scope.stop());
  await view.load();
  if (view.tasks.value.length) view.selectTask(view.tasks.value[0]);
  return { view, calls, errors, successes, context };
}

function menu(view, id) {
  return view.taskActionMenuItems.value.find((item) => item.id === id);
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("dirty manual run waits for save and runs the persisted content exactly once", async (t) => {
  const saved = deferred();
  const ran = deferred();
  let persisted;
  let executed;
  const { view, calls } = await mount(t, { request: async (_path, options) => {
    if (options.method === "PUT") {
      await saved.promise;
      persisted = plain(options.body.tasks[0]);
    } else {
      executed = persisted.content;
      await ran.promise;
    }
    return {};
  } });
  view.updateTaskField(view.selectedTask.value, "content", "Edited content");
  view.updateRepeatTime(view.selectedTask.value, "10:45");
  assert.equal(menu(view, "run-manually").disabled, false);
  const pending = menu(view, "run-manually").action();
  assert.deepEqual(calls.map((call) => call.method), ["PUT"]);
  assert.equal(menu(view, "run-manually").disabled, true);
  await view.runSelectedTaskNow();
  saved.resolve();
  await new Promise(setImmediate);
  assert.equal(executed, "Edited content");
  assert.equal(persisted.cron, "45 10 * * 1,3");
  assert.deepEqual(calls.map((call) => call.method), ["PUT", "POST"]);
  assert.equal(calls[1].path, "/todo/tasks/task-1/run");
  await view.runSelectedTaskNow();
  assert.equal(calls.length, 2);
  ran.resolve();
  await pending;
  assert.equal(view.runningTaskKey.value, "");
  assert.equal(menu(view, "run-manually").disabled, false);
});

test("clean tasks run directly, and run errors release the launch guard", async (t) => {
  const { view, calls, errors } = await mount(t, { request: async () => { throw new Error("Run failed"); } });
  await view.runSelectedTaskNow();
  assert.deepEqual(calls.map((call) => call.method), ["POST"]);
  assert.deepEqual(errors, ["Run failed"]);
  assert.equal(view.runningTaskKey.value, "");
});

test("failed save shows the Save error and never runs; retry saves again", async (t) => {
  const { view, calls, errors } = await mount(t, { request: async () => { throw new Error("Save failed"); } });
  view.updateTaskField(view.selectedTask.value, "content", "Unsaved content");
  await view.runSelectedTaskNow();
  assert.deepEqual(calls.map((call) => call.method), ["PUT"]);
  assert.deepEqual(errors, ["Save failed"]);
  assert.equal(view.canSave.value, true);
  assert.equal(view.runningTaskKey.value, "");
  await view.runSelectedTaskNow();
  assert.deepEqual(calls.map((call) => call.method), ["PUT", "PUT"]);
});

test("invalid form uses the same validation error as Save and makes no request", async (t) => {
  const { view, calls, errors } = await mount(t);
  view.updateTaskField(view.selectedTask.value, "content", "");
  assert.equal(menu(view, "run-manually").disabled, false);
  await view.save();
  const saveError = errors.at(-1);
  assert.ok(saveError);
  errors.length = 0;
  await view.runSelectedTaskNow();
  assert.deepEqual(errors, [saveError]);
  assert.equal(calls.length, 0);
});

test("validation of another unsaved task prevents saving and running", async (t) => {
  const { view, calls, errors } = await mount(t, { rows: [task(), task({ id: "task-2", content: "" })] });
  view.updateTaskField(view.selectedTask.value, "content", "Edited");
  await view.runSelectedTaskNow();
  assert.ok(errors.length);
  assert.equal(calls.length, 0);
});

test("loading, saving, running, heartbeat, missing identity and empty selection guard manual run", async (t) => {
  const { view, calls } = await mount(t);
  for (const [field, busy, idle] of [["loading", true, false], ["saving", true, false], ["runningTaskKey", "other", ""]]) {
    view[field].value = busy;
    assert.equal(menu(view, "run-manually").disabled, true);
    await view.runSelectedTaskNow();
    view[field].value = idle;
  }
  view.tasks.value[0].id = "";
  await view.runSelectedTaskNow();
  view.selectHeartbeat();
  assert.equal(menu(view, "run-manually").disabled, true);
  await view.runSelectedTaskNow();
  view.selectedTaskKey.value = "";
  await view.runSelectedTaskNow();
  assert.equal(calls.length, 0);
  const empty = await mount(t, { rows: [] });
  assert.equal(menu(empty.view, "run-manually").disabled, true);
  await empty.view.runSelectedTaskNow();
  assert.equal(empty.calls.length, 0);
});

for (const change of ["selection", "endpoint", "identity", "loading"]) {
  test(`a changed ${change} during save cannot launch a different target`, async (t) => {
    const saved = deferred();
    const { view, calls, context } = await mount(t, {
      rows: [task(), task({ id: "task-2" })], request: () => saved.promise,
    });
    view.updateTaskField(view.selectedTask.value, "content", "Edited");
    const pending = view.runSelectedTaskNow();
    if (change === "selection") view.selectTask(view.tasks.value[1]);
    if (change === "endpoint") context.endpointState.selectedRef = "endpoint-two";
    if (change === "identity") view.tasks.value[0].id = "replacement";
    if (change === "loading") view.loading.value = true;
    saved.resolve({});
    await pending;
    assert.deepEqual(calls.map((call) => call.method), ["PUT"]);
    assert.equal(view.runningTaskKey.value, "");
  });
}

for (const schedule of [{ cron: "15 9 * * 1,3" }, { cron: "", at: "2027-01-02 12:30" }]) {
  test(`duplicate retains displayed fields and dirty source for ${schedule.at ? "one-time" : "recurring"} tasks`, async (t) => {
    const { view, calls } = await mount(t, { rows: [task({ ...schedule, enabled: false }), task({ id: "task-3" })] });
    view.isMobile.value = true;
    view.updateTaskField(view.selectedTask.value, "content", "Edited content");
    view.updateBashEnvField(view.selectedTask.value, 0, "value", "edited");
    const original = plain(view.selectedTask.value);
    menu(view, "duplicate").action();
    const copy = view.selectedTask.value;
    assert.equal(view.tasks.value.length, 3);
    assert.equal(view.tasks.value[1]._key, copy._key);
    assert.equal(view.tasks.value[2].id, "task-3");
    assert.notEqual(copy.id, original.id);
    assert.notEqual(copy.id, "task-3");
    assert.notEqual(copy._key, original._key);
    assert.equal(copy.title, "Review (copy)");
    assert.deepEqual(plain(copy), { ...original, id: copy.id, _key: copy._key, title: copy.title });
    assert.deepEqual(plain(view.tasks.value[0]), original);
    assert.equal(view.showEditorPane.value, true);
    assert.equal(view.runningTaskKey.value, "");
    assert.equal(view.canSave.value, true);
    assert.equal(calls.length, 0, "duplication only changes local state");
    copy.repeat_weekdays.push(5);
    view.updateBashEnvField(copy, 0, "value", "copy only");
    assert.deepEqual(plain(view.tasks.value[0]), original, "nested arrays do not share mutations");
    await view.save();
    assert.equal(calls[0].body.tasks[0].content, "Edited content");
    assert.equal(calls[0].body.tasks[0].bash_env[0].value, "edited");
    assert.equal(calls[0].body.tasks[1].bash_env[0].value, "copy only");
  });
}

test("an unsaved duplicate can be run via Save with its new ID", async (t) => {
  const { view, calls } = await mount(t);
  menu(view, "duplicate").action();
  const id = view.selectedTask.value.id;
  await view.runSelectedTaskNow();
  assert.deepEqual(calls.map((call) => call.method), ["PUT", "POST"]);
  assert.equal(calls[0].body.tasks[1].id, id);
  assert.equal(calls[1].path, `/todo/tasks/${id}/run`);
});

test("duplicate is guarded during loading, saving and without an ordinary selection", async (t) => {
  const { view, calls } = await mount(t);
  for (const field of ["loading", "saving"]) {
    view[field].value = true;
    assert.equal(menu(view, "duplicate").disabled, true);
    menu(view, "duplicate").action();
    view[field].value = false;
  }
  view.selectHeartbeat();
  assert.equal(menu(view, "duplicate").disabled, true);
  menu(view, "duplicate").action();
  view.selectedTaskKey.value = "";
  assert.equal(menu(view, "duplicate").disabled, true);
  menu(view, "duplicate").action();
  assert.equal(view.tasks.value.length, 1);
  assert.equal(calls.length, 0);
  const empty = await mount(t, { rows: [] });
  assert.equal(menu(empty.view, "duplicate").disabled, true);
  menu(empty.view, "duplicate").action();
  assert.equal(empty.view.tasks.value.length, 0);
});

for (const [lang, label, title] of [["en", "Duplicate", "Review (copy)"], ["zh", "复制", "Review（副本）"], ["ja", "複製", "Review（コピー）"]]) {
  test(`${lang} translates Duplicate and its copy marker, directly above Move up`, async (t) => {
    const { view } = await mount(t, { lang });
    const items = view.taskActionMenuItems.value;
    const index = items.findIndex((item) => item.id === "duplicate");
    assert.equal(items[index + 1].id, "move-up");
    assert.equal(items[index].title, label);
    items[index].action();
    await nextTick();
    assert.equal(view.selectedTask.value.title, title);
  });
}

test("the list shows which TODO items are running or waiting, and a running item cannot be started again", async (t) => {
  const { view, calls } = await mount(t, {
    rows: [task(), task({ id: "task-2", title: "Build" }), task({ id: "task-3", title: "Idle" })],
    runs: [
      { id: "task-1", state: "running", started_at: "2026-11-04T03:00:00Z" },
      { id: "task-2", state: "queued" },
      { id: "__heartbeat__", state: "running" },
    ],
  });
  const [first, second, third] = view.tasks.value;
  assert.equal(view.taskRun(first).state, "running");
  assert.equal(view.runStateLabel(view.taskRun(first)), "Running");
  assert.equal(view.runMarkerType(view.taskRun(first), "success"), "primary");
  assert.equal(view.runMarkerClass(view.taskRun(first)), "todo-run-marker is-running");
  assert.equal(view.runStateLabel(view.taskRun(second)), "Waiting");
  assert.equal(view.runMarkerType(view.taskRun(second), "success"), "warning");
  assert.equal(view.taskRun(third), null);
  assert.equal(view.runMarkerType(view.taskRun(third), "success"), "success");
  assert.equal(view.heartbeatRun().state, "running");

  // task-1 is selected and running: Run now stays off and sends nothing.
  assert.equal(view.canRunSelectedTask.value, false);
  await view.runSelectedTaskNow();
  assert.equal(calls.length, 0);
  view.selectTask(third);
  assert.equal(view.canRunSelectedTask.value, true);
});
