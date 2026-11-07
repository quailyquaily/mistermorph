import test from "node:test";
import assert from "node:assert/strict";

import { createArrivalTracker } from "./arrivals.js";

test("first load and scope changes do not count as arrivals", () => {
  const tracker = createArrivalTracker();
  assert.deepEqual([...tracker.update(["a", "b"], "topic-1")], []);
  assert.deepEqual([...tracker.update(["x", "y"], "topic-2")], []);
});

test("items appended at the end arrive; older items loaded above do not", () => {
  const tracker = createArrivalTracker();
  tracker.update(["a", "b"], "t");
  assert.deepEqual([...tracker.update(["a", "b", "c", "d"], "t")], ["c", "d"]);
  assert.deepEqual([...tracker.update(["old1", "old2", "a", "b", "c", "d"], "t")], []);
  assert.deepEqual([...tracker.update(["old1", "old2", "a", "b", "c", "d"], "t")], []);
});

test("a wholesale replacement in the same scope is a reload, not arrivals", () => {
  const tracker = createArrivalTracker();
  tracker.update(["local-1", "local-2"], "t");
  assert.deepEqual([...tracker.update(["task:user", "task:agent"], "t")], []);
});

test("an empty list resets, so the next load is a first sight", () => {
  const tracker = createArrivalTracker();
  tracker.update(["a"], "t");
  tracker.update([], "t");
  assert.deepEqual([...tracker.update(["a", "b"], "t")], []);
});

test("newest-first lists count items above the first known one", () => {
  const tracker = createArrivalTracker({ edge: "start" });
  tracker.update(["c", "b", "a"], "logs");
  assert.deepEqual([...tracker.update(["e", "d", "c", "b", "a"], "logs")], ["e", "d"]);
  assert.deepEqual([...tracker.update(["e", "d", "c", "b", "a", "older"], "logs")], []);
});

test("reset forgets everything", () => {
  const tracker = createArrivalTracker();
  tracker.update(["a"], "t");
  tracker.reset();
  assert.deepEqual([...tracker.update(["a", "b"], "t")], []);
});

import { contentKeys, createChangeTracker, createHighlightWindow } from "./arrivals.js";

test("change tracker reports known items whose signature changed", () => {
  const tracker = createChangeTracker();
  assert.deepEqual([...tracker.update([{ id: "a", signature: "running" }], "s")], []);
  assert.deepEqual([...tracker.update([{ id: "a", signature: "done" }, { id: "b", signature: "new" }], "s")], ["a"]);
  assert.deepEqual([...tracker.update([{ id: "a", signature: "failed" }], "other")], []);
});

test("highlight window expires ids after the window", () => {
  let t = 1000;
  const win = createHighlightWindow(500, () => t);
  win.add(["a"]);
  assert.equal(win.has("a"), true);
  t = 1400;
  win.add(["b"]);
  assert.equal(win.has("a"), true);
  t = 1600;
  assert.equal(win.has("a"), false);
  assert.equal(win.has("b"), true);
});

test("content keys keep identical rows distinct and stable when rows append", () => {
  assert.deepEqual(contentKeys(["x", "y", "x"]), ["x#1", "y#1", "x#2"]);
  assert.deepEqual(contentKeys(["x", "y", "x", "z"]).slice(0, 3), contentKeys(["x", "y", "x"]));
});

test("sorted lists count a new item wherever it lands", () => {
  const tracker = createArrivalTracker({ edge: "any" });
  tracker.update(["a", "c"], "todo");
  assert.deepEqual([...tracker.update(["a", "b", "c"], "todo")], ["b"]);
});
