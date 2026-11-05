import assert from "node:assert/strict";
import test from "node:test";

import { activelyViewedTopic, createTopicActivityTracker, normalizeTopicActivity, topicActivitySignature } from "./topic-activity.js";

test("normalizeTopicActivity keys running and pending topics by ID", () => {
  const activity = normalizeTopicActivity([
    { id: " alpha ", status: "running", running: 2, pending: 0 },
    { id: "beta", status: "pending", running: 1, pending: 1 },
    { id: "", status: "running" },
    { id: "gamma", status: "done" },
    { id: "delta", status: "running", running: "x", pending: -3 },
    null,
  ]);
  assert.deepEqual([...activity.keys()], ["alpha", "beta", "delta"]);
  assert.deepEqual(activity.get("alpha"), { status: "running", running: 2, pending: 0 });
  assert.deepEqual(activity.get("beta"), { status: "pending", running: 1, pending: 1 });
  assert.deepEqual(activity.get("delta"), { status: "running", running: 0, pending: 0 });
  assert.equal(normalizeTopicActivity(undefined).size, 0);
  assert.equal(normalizeTopicActivity({ topics: [] }).size, 0);
});

test("topicActivitySignature ignores order and changes with counts and status", () => {
  const a = normalizeTopicActivity([{ id: "x", status: "running", running: 1 }, { id: "y", status: "pending", pending: 1 }]);
  const b = normalizeTopicActivity([{ id: "y", status: "pending", pending: 1 }, { id: "x", status: "running", running: 1 }]);
  const c = normalizeTopicActivity([{ id: "x", status: "running", running: 2 }, { id: "y", status: "pending", pending: 1 }]);
  assert.equal(topicActivitySignature(a), topicActivitySignature(b));
  assert.notEqual(topicActivitySignature(a), topicActivitySignature(c));
  assert.equal(topicActivitySignature(new Map()), "");
});

test("the chat view polls topic activity and shows a status mark at the right of each topic", async () => {
  const { readFile } = await import("node:fs/promises");
  const view = await readFile(new URL("../views/ChatView.js", import.meta.url), "utf8");
  const styles = await readFile(new URL("../views/ChatView.css", import.meta.url), "utf8");
  assert.match(view, /runtimeApiFetchForEndpoint\(endpointRef, "\/topics\/activity"\)/u);
  assert.match(view, /window\.setInterval\(\(\) => void refreshTopicActivity\(\), TOPIC_ACTIVITY_REFRESH_INTERVAL_MS\)/u);
  assert.match(view, /onUnmounted\(\(\) => \{\s*viewActive = false;\s*stopTopicActivityRefresh\(\);/u);
  // The mark follows the title inside the topic button, so it sits at the item's right.
  assert.match(view, /chat-topic-item-title[^\n]*\n\s*<\/span>\s*<span\s+v-if="topicActivityState\(topic\)"\s+:class="\['chat-topic-item-status', 'is-' \+ topicActivityState\(topic\)\]"/u);
  // A finished task and a newly followed one refresh the indicators at once.
  assert.match(view, /closeTaskStream\(taskID\);\s*void refreshTopicActivity\(\);/u);
  // The mark is the console's status mark: its size, square corners and colours come from the
  // shared tokens. Finished is the plain filled mark; running is hollow with a breathing fill.
  assert.match(styles, /\.chat-topic-item:has\(\.chat-topic-item-status\)\s*\{\s*grid-template-columns: 16px minmax\(0, 1fr\) var\(--status-mark-size\);/u);
  assert.match(styles, /\.chat-topic-item-status\s*\{[^}]*width: var\(--status-mark-size\);[^}]*border: 1px solid currentColor;\s*border-radius: 1px;\s*color: var\(--status-on\);\s*background: currentColor;/u);
  assert.match(styles, /\.chat-topic-item-status\.is-pending\s*\{\s*color: var\(--status-pending\);/u);
  assert.match(styles, /\.chat-topic-item-status\.is-running\s*\{\s*background: transparent;/u);
  assert.match(styles, /\.chat-topic-item-status\.is-running::after\s*\{[^}]*animation: chat-topic-status-fill /u);
  assert.match(styles, /prefers-reduced-motion: reduce\)\s*\{\s*\.chat-topic-item-status\.is-running::after\s*\{\s*animation: none;\s*opacity: 0;/u);
  assert.doesNotMatch(styles, /\.chat-topic-item-status[^{]*\{[^}]*(border-radius: 50%|--q-c-green|--q-c-orange)/u);
  assert.match(view, /window\.addEventListener\("focus", onPageVisibilityChange\)/u);
  assert.match(view, /window\.removeEventListener\("focus", onPageVisibilityChange\)/u);
  assert.match(view, /function onPageVisibilityChange\(\) \{\s*acknowledgeViewedTopic\(\)/u);
  assert.match(view, /\[selectedTopicID\.value, showChatPane\.value, creatingTopic\.value\],\s*acknowledgeViewedTopic,\s*\{ flush: "post" \}/u);
});

// Exercise the same tracker used by ChatView; acknowledgements never mutate API rows.
const done = (task = "a", at = "2026-11-05T09:00:00Z", id = "topic") => ({
  id, status: "", latest_done_task_id: task, latest_done_at: at,
});
const running = (id = "topic") => ({ id, status: "running", running: 1 });
function tracker() {
  const state = createTopicActivityTracker();
  state.setEndpoint("endpoint-a");
  return state;
}
function poll(state, rows, viewed = "") {
  state.apply(state.beginRequest(), rows, viewed);
  return state.snapshot().get("topic")?.status || "";
}

test("first load and newly discovered topics establish historical baselines", () => {
  const state = tracker();
  assert.equal(poll(state, [done()]), "");
  assert.equal(poll(state, [done(), done("old", undefined, "other")]), "");
  assert.equal(state.snapshot().has("other"), false);
  assert.equal(poll(state, [done("b", "2026-11-05T10:00:00Z")]), "done");
  assert.equal(poll(state, []), "done");
});

test("successful running-to-done persists until entering the topic without altering history", () => {
  const state = tracker();
  assert.equal(poll(state, [running()]), "running");
  const response = Object.freeze([Object.freeze(done())]);
  assert.equal(poll(state, response), "done");
  assert.equal(poll(state, response), "done");
  state.acknowledge("other");
  assert.equal(state.snapshot().get("topic").status, "done");
  state.acknowledge("topic");
  assert.equal(state.snapshot().has("topic"), false);
  assert.equal(poll(state, response), "");
  assert.deepEqual(response, [done()]);
});

test("completion while actively viewed is acknowledged and cannot reappear", () => {
  const state = tracker();
  poll(state, [running()]);
  assert.equal(poll(state, [done()], "topic"), "");
  assert.equal(poll(state, [done()]), "");
});

test("visibility requires focus and the actual chat pane, including mobile navigation", () => {
  const visible = { topicID: "topic", viewActive: true, visibilityState: "visible", focused: true, showChatPane: true, creatingTopic: false };
  assert.equal(activelyViewedTopic(visible), "topic");
  for (const hidden of [
    { visibilityState: "hidden" }, { focused: false }, { showChatPane: false },
    { creatingTopic: true }, { viewActive: false },
  ]) {
    const state = tracker();
    poll(state, [running()]);
    const viewed = activelyViewedTopic({ ...visible, ...hidden });
    assert.equal(viewed, "");
    assert.equal(poll(state, [done()], viewed), "done");
    state.acknowledge(activelyViewedTopic(visible));
    assert.equal(state.snapshot().size, 0);
    assert.equal(poll(state, [done()]), "");
  }
});

test("running and pending take precedence and survive acknowledgement of an older completion", () => {
  for (const status of ["running", "pending"]) {
    const state = tracker();
    poll(state, [running()]);
    assert.equal(poll(state, [done()]), "done");
    const next = { ...done(), status, running: 1, pending: status === "pending" ? 1 : 0 };
    assert.equal(poll(state, [next]), status);
    state.acknowledge("topic");
    assert.equal(state.snapshot().get("topic").status, status);
    assert.equal(poll(state, [done("b", "2026-11-05T10:00:00Z")]), "done");
  }
});

test("disappearance, failed/cancelled tasks, malformed responses and errors do not imply success", () => {
  for (const rows of [[], [{ id: "topic", status: "" }], [{ id: "topic", status: "failed" }], [{ id: "topic", status: "canceled" }], [done("", undefined)], [done("a", "invalid")]]) {
    const state = tracker();
    poll(state, [running()]);
    assert.notEqual(poll(state, rows), "done");
  }
  const state = tracker();
  poll(state, [running()]);
  // A rejected request never calls apply; malformed success responses are also ignored.
  state.beginRequest();
  assert.equal(state.snapshot().get("topic").status, "running");
  assert.equal(poll(state, undefined), "running");
  assert.equal(poll(state, { topics: [] }), "running");
  assert.equal(poll(state, [done()]), "done");
  assert.equal(poll(state, undefined), "done");
});

test("stale responses and old endpoint requests cannot overwrite newer running state", () => {
  const state = tracker();
  poll(state, [running()]);
  const old = state.beginRequest();
  poll(state, [{ ...running(), running: 2 }]);
  state.apply(old, [done()], "topic");
  assert.equal(state.snapshot().get("topic").running, 2);
  const fromA = state.beginRequest();
  state.setEndpoint("endpoint-b");
  state.apply(fromA, [done()]);
  assert.equal(state.snapshot().size, 0);
  assert.equal(poll(state, [done()]), "");
  assert.equal(poll(state, [done("b", "2026-11-05T10:00:00Z")]), "done");
  state.setEndpoint("endpoint-a");
  assert.equal(state.snapshot().size, 0);
  assert.equal(poll(state, [done()]), "");
});

test("same endpoint remount preserves unread state; old completions never become unread again", () => {
  const state = tracker();
  poll(state, [done()]);
  assert.equal(poll(state, [done("b", "2026-11-05T10:00:00Z")]), "done");
  state.setEndpoint("endpoint-a");
  assert.equal(state.snapshot().get("topic").status, "done");
  state.acknowledge("topic");
  assert.equal(poll(state, [done("older", "2026-11-05T08:00:00Z")]), "");
  assert.equal(poll(state, [done()]), "");
  assert.equal(poll(state, [done("b", "2026-11-05T10:00:00Z")]), "");
});
