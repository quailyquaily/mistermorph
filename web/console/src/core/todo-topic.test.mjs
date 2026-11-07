import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { topicSidebarViewFor } from "./chat-cron-topics.js";
import {
  findTodoTopic,
  todoTopicChatPath,
  todoTopicID,
  todoTopicsEndpointRef,
  waitForTodoTopic,
  TODO_TOPIC_CANCELLED,
  TODO_TOPIC_ERROR,
  TODO_TOPIC_POLL_TIMEOUT_MS,
  TODO_TOPIC_READY,
  TODO_TOPIC_UNAVAILABLE,
} from "./todo-topic.js";

const chatView = await readFile(new URL("../views/ChatView.js", import.meta.url), "utf8");
const todoView = await readFile(new URL("../views/TodoView.js", import.meta.url), "utf8");
const messageDialog = await readFile(new URL("../components/ui/AppMessageDialog.js", import.meta.url), "utf8");
const i18n = await readFile(new URL("../i18n/index.js", import.meta.url), "utf8");

test("a TODO item's topic is the runtime's _cron_<task id> topic, opened on the Topics page", () => {
  assert.equal(todoTopicID(" task-1 "), "_cron_task-1");
  assert.equal(todoTopicID(""), "");
  assert.equal(todoTopicID(null), "");
  assert.equal(todoTopicChatPath("_cron_a b"), "/chat/_cron_a%20b");
  assert.equal(todoTopicChatPath(""), "");
});

test("topics are looked up on the endpoint the Topics page lists them for", () => {
  const endpoints = {
    console: { endpoint_ref: "console", can_submit: true, mode: "console" },
    mapped: { endpoint_ref: "mapped", submit_endpoint_ref: "console", mode: "channel" },
    channel: { endpoint_ref: "channel", can_submit: true, mode: "channel" },
    readonly: { endpoint_ref: "readonly", can_submit: false, mode: "console" },
  };
  const byRef = (ref) => endpoints[ref] || null;
  assert.equal(todoTopicsEndpointRef("console", byRef), "console");
  assert.equal(todoTopicsEndpointRef("mapped", byRef), "console");
  assert.equal(todoTopicsEndpointRef("channel", byRef), "");
  assert.equal(todoTopicsEndpointRef("readonly", byRef), "");
  assert.equal(todoTopicsEndpointRef("missing", byRef), "");
  assert.equal(todoTopicsEndpointRef("console", null), "");
});

test("findTodoTopic reads the item's topic and tells a missing one from a failure", async () => {
  const calls = [];
  const fetchFor = (answer) => async (ref, path, options) => {
    calls.push({ ref, path, options });
    return answer();
  };
  assert.equal(await findTodoTopic(fetchFor(() => ({ id: "_cron_t1" })), "ep", "t1"), "_cron_t1");
  assert.deepEqual(calls, [{ ref: "ep", path: "/topics/_cron_t1", options: undefined }], "a single GET");
  assert.equal(await findTodoTopic(fetchFor(() => ({ id: "default" })), "ep", "t1"), "");
  const notFound = Object.assign(new Error("not found"), { status: 404 });
  assert.equal(await findTodoTopic(fetchFor(() => { throw notFound; }), "ep", "t1"), "");
  const down = Object.assign(new Error("unavailable"), { status: 503 });
  await assert.rejects(findTodoTopic(fetchFor(() => { throw down; }), "ep", "t1"), down);
  calls.length = 0;
  assert.equal(await findTodoTopic(fetchFor(() => ({ id: "_cron_" })), "", "t1"), "");
  assert.equal(await findTodoTopic(fetchFor(() => ({ id: "_cron_" })), "ep", " "), "");
  assert.equal(calls.length, 0);
});

// A clock that only moves when the poll sleeps, so the waits are exact and instant.
function fakeClock() {
  let time = 0;
  const sleeps = [];
  return {
    sleeps,
    now: () => time,
    sleep: async (ms) => {
      sleeps.push(ms);
      time += ms;
    },
  };
}

test("waitForTodoTopic finds a topic that is there at once, or appears later", async () => {
  const clock = fakeClock();
  assert.deepEqual(await waitForTodoTopic(async () => "_cron_t1", clock), {
    status: TODO_TOPIC_READY, topicID: "_cron_t1", error: null,
  });
  assert.deepEqual(clock.sleeps, []);
  let asked = 0;
  const delayed = await waitForTodoTopic(async () => (++asked < 4 ? "" : "_cron_t1"), { ...clock, intervalMs: 1000 });
  assert.equal(delayed.status, TODO_TOPIC_READY);
  assert.equal(asked, 4);
  assert.deepEqual(clock.sleeps, [1000, 1000, 1000]);
});

test("waitForTodoTopic gives up after its timeout, about half a minute by default", async () => {
  assert.equal(TODO_TOPIC_POLL_TIMEOUT_MS, 30000);
  const clock = fakeClock();
  let asked = 0;
  const result = await waitForTodoTopic(async () => { asked += 1; return ""; }, clock);
  assert.deepEqual(result, { status: TODO_TOPIC_UNAVAILABLE, topicID: "", error: null });
  assert.equal(clock.now(), 30000);
  assert.equal(asked, 31);
  const short = fakeClock();
  await waitForTodoTopic(async () => "", { ...short, intervalMs: 1000, timeoutMs: 2500 });
  assert.deepEqual(short.sleeps, [1000, 1000, 500], "the last wait ends at the deadline");
});

test("waitForTodoTopic stops at a failed lookup and when it is aborted", async () => {
  const failure = new Error("offline");
  const failed = await waitForTodoTopic(async () => { throw failure; }, fakeClock());
  assert.deepEqual(failed, { status: TODO_TOPIC_ERROR, topicID: "", error: failure });

  const aborted = new AbortController();
  aborted.abort();
  let asked = 0;
  const before = await waitForTodoTopic(async () => { asked += 1; return "_cron_t1"; }, { ...fakeClock(), signal: aborted.signal });
  assert.equal(before.status, TODO_TOPIC_CANCELLED);
  assert.equal(asked, 0);

  const during = new AbortController();
  const late = await waitForTodoTopic(async () => { during.abort(); return "_cron_t1"; }, { ...fakeClock(), signal: during.signal });
  assert.equal(late.status, TODO_TOPIC_CANCELLED, "an answer after the abort is dropped");

  const sleeping = new AbortController();
  asked = 0;
  const pending = waitForTodoTopic(async () => { asked += 1; return ""; }, { signal: sleeping.signal, intervalMs: 60000 });
  await new Promise(setImmediate);
  sleeping.abort();
  assert.equal((await pending).status, TODO_TOPIC_CANCELLED, "the real wait ends at the abort");
  assert.equal(asked, 1);
});

test("opening a TODO item's topic turns the TODO runs list on, never off", () => {
  for (const view of ["date", "tags", "agents", "cron"]) {
    assert.equal(topicSidebarViewFor("_cron_t1", view), "cron", view);
    assert.equal(topicSidebarViewFor(" _cron_t1 ", view), "cron", view);
    assert.equal(topicSidebarViewFor("default", view), view, view);
    assert.equal(topicSidebarViewFor("_agentlink_a", view), view, view);
    assert.equal(topicSidebarViewFor("", view), view, view);
    assert.equal(topicSidebarViewFor(undefined, view), view, view);
  }
});

test("the Topics page sets the list before loading, so the target stays selected", () => {
  assert.match(chatView, /const topicSidebarView = ref\(topicSidebarViewFor\(route\.params\.topic_id, loadTopicSidebarView\(\)\)\);/u);
  assert.match(
    chatView,
    /\(topicID\) => \{\s*topicSidebarView\.value = topicSidebarViewFor\(topicID, topicSidebarView\.value\);\s*void syncTopicFromRoute\(\)/u,
  );
  // The target is fetched on its own when it is not on the first page of topics.
  assert.match(chatView, /const targetTopicID = preferredTopicID \|\| currentID;[\s\S]*?`\/topics\/\$\{encodeURIComponent\(targetTopicID\)\}`/u);
  assert.match(chatView, /if \(preferredTopicID && items\.some\(\(topic\) => normalizeTopicID\(topic\?\.id\) === preferredTopicID\)\) \{\s*selectedTopicID\.value = preferredTopicID;/u);
});

test("the TODO view shows its run dialog with the console's components", () => {
  assert.match(todoView, /<AppMessageDialog\s+v-model="runDialogOpen"\s+icon="PhTimer"\s+:title="t\('todo_run_dialog_title'\)"\s+:text="runDialogText"\s+:actions="runDialogActions"/u);
  assert.match(todoView, /!runningTaskKey\.value &&\s*!runDialogOpen\.value &&/u);
  assert.doesNotMatch(todoView, /todo_run_success/u);
});

test("message dialog buttons may be disabled or loading; others are unchanged", () => {
  assert.match(messageDialog, /:disabled="act\.disabled === true"\s+:loading="act\.loading === true"\s+@click="act\.action"/u);
  assert.match(messageDialog, /message-dialog-text q-c-dark-2" aria-live="polite">\{\{ text \}\}/u);
});

test("the topic entry and run dialog are translated", () => {
  for (const key of [
    "todo_action_open_topic",
    "todo_run_dialog_title",
    "todo_run_dialog_text",
    "todo_run_dialog_topic_checking",
    "todo_run_dialog_topic_ready",
    "todo_run_dialog_topic_unavailable",
    "todo_run_dialog_topic_error",
    "todo_run_dialog_check_again",
  ]) {
    assert.equal(i18n.match(new RegExp(`\\b${key}:`, "gu"))?.length, 3, key);
  }
  assert.doesNotMatch(i18n, /\btodo_run_success:/u);
});
