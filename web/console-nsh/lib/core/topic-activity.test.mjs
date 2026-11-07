import assert from "node:assert/strict";
import test from "node:test";

import { activelyViewedTopic, createTopicActivityTracker, cronRunningCount, normalizeTopicActivity, topicActivitySignature } from "./topic-activity.js";

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
  assert.deepEqual(activity.get("alpha"), { status: "running", running: 2, pending: 0, cronRunning: 0 });
  assert.deepEqual(activity.get("beta"), { status: "pending", running: 1, pending: 1, cronRunning: 0 });
  assert.deepEqual(activity.get("delta"), { status: "running", running: 0, pending: 0, cronRunning: 0 });
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

// The TODO toggle's running count: the TODO runs the server counts as running, summed
// over the whole activity snapshot, whatever the sidebar lists.
const cronRow = (id, cronRunning, extra = {}) => ({ id, status: "running", running: cronRunning, cron_running: cronRunning, ...extra });
function cronCount(state, rows) {
  if (rows !== undefined) state.apply(state.beginRequest(), rows);
  return cronRunningCount(state.snapshot());
}

test("the TODO running count sums every topic's TODO runs and ignores the rest", () => {
  const state = tracker();
  assert.equal(cronCount(state), 0);
  assert.equal(cronCount(state, []), 0);
  // Chat tasks, queued work and pending questions bring no cron_running.
  assert.equal(cronCount(state, [running("chat"), { id: "_cron_a", status: "running", running: 1 }, { id: "_cron_b", status: "pending", running: 0, pending: 1 }]), 0);
  assert.equal(cronCount(state, [cronRow("_cron_a", 1)]), 1);
  // Topics the sidebar does not list (or has not loaded) count too, and so does a pending topic's
  // running TODO run.
  assert.equal(cronCount(state, [cronRow("_cron_a", 1), cronRow("_cron_b", 2), cronRow("_cron_c", 1, { status: "pending", pending: 1 }), running("chat")]), 4);
  for (const bad of [{ cron_running: -2 }, { cron_running: "x" }, { cron_running: null }]) {
    assert.equal(cronCount(state, [{ ...cronRow("_cron_a", 1), ...bad }]), 0);
  }
  assert.equal(cronRunningCount(undefined), 0);
  assert.equal(cronRunningCount(new Map()), 0);
});

test("the TODO running count follows runs as they end, whatever they end as", () => {
  for (const ending of [done("s1", "2026-11-06T09:00:00Z", "_cron_a"), { id: "_cron_a", status: "" }]) {
    const state = tracker();
    assert.equal(cronCount(state, [cronRow("_cron_a", 2)]), 2);
    // One of several ends: the mark stays.
    assert.equal(cronCount(state, [cronRow("_cron_a", 1)]), 1);
    // The last one ends (done, or failed/cancelled which leave no completion): it clears.
    assert.equal(cronCount(state, [ending]), 0);
    assert.equal(cronCount(state, []), 0);
  }
});

test("replayed and duplicate activity never inflates the TODO running count", () => {
  const state = tracker();
  const rows = Object.freeze([cronRow("_cron_a", 1), cronRow("_cron_b", 1)]);
  for (let i = 0; i < 3; i++) assert.equal(cronCount(state, rows), 2);
  // A topic listed twice counts once, as its last row says.
  assert.equal(cronCount(state, [cronRow("_cron_a", 1), cronRow("_cron_a", 1)]), 1);
  assert.equal(topicActivitySignature(state.snapshot()), "_cron_a:running:1:0:1");
});

test("the TODO running count survives errors and stale replies, and clears with the endpoint", () => {
  const state = tracker();
  assert.equal(cronCount(state, [cronRow("_cron_a", 2)]), 2);
  // A failed request never applies; a malformed reply is no evidence that runs ended.
  state.beginRequest();
  assert.equal(cronCount(state), 2);
  assert.equal(cronCount(state, undefined), 2);
  assert.equal(cronCount(state, { topics: [] }), 2);
  // An older request answering after a newer one is dropped, in both directions.
  const older = state.beginRequest();
  const newer = state.beginRequest();
  state.apply(newer, [cronRow("_cron_a", 1)]);
  state.apply(older, [cronRow("_cron_a", 3)]);
  assert.equal(cronCount(state), 1);
  const slow = state.beginRequest();
  state.apply(state.beginRequest(), []);
  state.apply(slow, [cronRow("_cron_a", 1)]);
  assert.equal(cronCount(state), 0);
  // Another endpoint starts from nothing, and a reply meant for the old one cannot land.
  assert.equal(cronCount(state, [cronRow("_cron_a", 1)]), 1);
  const fromA = state.beginRequest();
  state.setEndpoint("endpoint-b");
  assert.equal(cronCount(state), 0);
  state.apply(fromA, [cronRow("_cron_a", 1)]);
  assert.equal(cronCount(state), 0);
  assert.equal(cronCount(state, [cronRow("_cron_x", 1)]), 1);
  // Topics turned off (no endpoint) show nothing.
  state.setEndpoint("");
  assert.equal(cronCount(state), 0);
});

test("the TODO running count changes the activity signature, so the view republishes it", () => {
  const one = normalizeTopicActivity([cronRow("_cron_a", 1)]);
  const plain = normalizeTopicActivity([{ id: "_cron_a", status: "running", running: 1 }]);
  assert.notEqual(topicActivitySignature(one), topicActivitySignature(plain));
  assert.equal(one.get("_cron_a").cronRunning, 1);
});
