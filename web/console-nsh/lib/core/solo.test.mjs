import assert from "node:assert/strict";
import test from "node:test";
import { isSoloTopicID, liveSoloThreads, soloSourcesOf, soloThreadEnded, soloThreadOf, topicStartedFromSolo } from "./solo.js";

test("Solo's topic and the threads it started", () => {
  assert.equal(isSoloTopicID(" _solo "), true);
  assert.equal(isSoloTopicID("_solo2"), false);
  assert.equal(topicStartedFromSolo({ started_from: "_solo" }), true);
  assert.equal(topicStartedFromSolo({ id: "t1" }), false);
});

test("a task's thread record", () => {
  assert.equal(soloThreadOf({ result: { final: { output: "x" } } }), null);
  assert.equal(soloThreadOf({ result: { solo_thread: { topic_id: "t1" } } }), null);
  const card = soloThreadOf({ result: { solo_thread: { kind: "card", topic_id: "t1", task_id: "k1", title: " Build ", workspace: "~/p", state: "bogus" } } });
  assert.deepEqual(card, { kind: "card", topicID: "t1", taskID: "k1", title: "Build", workspace: "~/p", state: "running", summary: "", finishedAt: "", continued: false });
  const summary = soloThreadOf({ result: { solo_thread: { kind: "summary", topic_id: "t1", task_id: "k1", state: "failed", summary: "boom", continued: true } } });
  assert.equal(summary.kind, "summary");
  assert.equal(summary.state, "failed");
  assert.equal(summary.continued, true);
  // A history item already read reads the same.
  assert.deepEqual(soloThreadOf({ soloThread: { topic_id: "t1", task_id: "k1", state: "done" } }).state, "done");
});

test("a reply's sources: known kinds, once each, in order", () => {
  assert.deepEqual(soloSourcesOf({}), []);
  assert.deepEqual(
    soloSourcesOf({ result: { solo_sources: [{ kind: "topic", id: "t1", label: "A" }, { kind: "bogus" }, { kind: "topic", id: "t1" }, { kind: "memory" }] } }),
    [
      { kind: "topic", id: "t1", label: "A" },
      { kind: "memory", id: "", label: "" },
    ],
  );
});

test("the threads still running in a history", () => {
  assert.equal(soloThreadEnded("waiting"), false);
  assert.equal(soloThreadEnded("canceled"), true);
  const items = [
    { soloThread: { kind: "card", topicID: "a", state: "running" } },
    { soloThread: { kind: "card", topicID: "b", state: "done" } },
    { soloThread: { kind: "summary", topicID: "c", state: "running" } },
    { soloThread: { kind: "card", topicID: "d", state: "waiting" } },
    { role: "user" },
  ];
  assert.deepEqual(liveSoloThreads(items), ["a", "d"]);
});
