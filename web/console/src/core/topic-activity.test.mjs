import assert from "node:assert/strict";
import test from "node:test";

import { normalizeTopicActivity, topicActivitySignature } from "./topic-activity.js";

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

test("the chat view polls topic activity and shows a status dot at the right of each topic", async () => {
  const { readFile } = await import("node:fs/promises");
  const view = await readFile(new URL("../views/ChatView.js", import.meta.url), "utf8");
  const styles = await readFile(new URL("../views/ChatView.css", import.meta.url), "utf8");
  assert.match(view, /runtimeApiFetchForEndpoint\(endpointRef, "\/topics\/activity"\)/u);
  assert.match(view, /window\.setInterval\(\(\) => void refreshTopicActivity\(\), TOPIC_ACTIVITY_REFRESH_INTERVAL_MS\)/u);
  assert.match(view, /onUnmounted\(\(\) => \{\s*viewActive = false;\s*stopTopicActivityRefresh\(\);/u);
  // The dot follows the title inside the topic button, so it sits at the item's right.
  assert.match(view, /chat-topic-item-title[^\n]*\n\s*<\/span>\s*<span\s+v-if="topicActivityState\(topic\)"\s+:class="\['chat-topic-item-status', 'is-' \+ topicActivityState\(topic\)\]"/u);
  // A finished task and a newly followed one refresh the indicators at once.
  assert.match(view, /closeTaskStream\(taskID\);\s*void refreshTopicActivity\(\);/u);
  assert.match(styles, /\.chat-topic-item:has\(\.chat-topic-item-status\)\s*\{\s*grid-template-columns: 16px minmax\(0, 1fr\) 8px;/u);
  assert.match(styles, /prefers-reduced-motion: reduce\)\s*\{\s*\.chat-topic-item-status\.is-running/u);
});
