import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeFinishedTodoRuns,
  normalizeTodoRuns,
  todoRunsSignature,
  TODO_RUN_CANCELED,
  TODO_RUN_QUEUED,
  TODO_RUN_RUNNING,
} from "./todo-runs.js";

test("normalizeTodoRuns keys running and queued items by ID", () => {
  const runs = normalizeTodoRuns([
    { id: " build ", run_id: " run_1 ", state: "running", started_at: "2026-11-04T03:00:00Z", queued_at: "2026-11-04T03:00:00Z", stopping: true },
    { id: "review", state: "queued", manual: true, started_at: "0001-01-01T00:00:00Z" },
    { id: "", state: "running" },
    { id: "odd", state: "paused" },
    null,
  ]);
  assert.deepEqual([...runs.keys()], ["build", "review"]);
  assert.deepEqual(runs.get("build"), {
    state: TODO_RUN_RUNNING,
    manual: false,
    startedAt: "2026-11-04T03:00:00Z",
    runID: "run_1",
    stopping: true,
  });
  assert.deepEqual(runs.get("review"), { state: TODO_RUN_QUEUED, manual: true, startedAt: "", runID: "", stopping: false });
});

test("normalizeTodoRuns treats a missing list as nothing running", () => {
  assert.equal(normalizeTodoRuns(undefined).size, 0);
  assert.equal(normalizeTodoRuns({ runs: [] }).size, 0);
});

test("todoRunsSignature ignores order and changes with state", () => {
  const a = normalizeTodoRuns([{ id: "x", state: "running" }, { id: "y", state: "queued" }]);
  const b = normalizeTodoRuns([{ id: "y", state: "queued" }, { id: "x", state: "running" }]);
  const c = normalizeTodoRuns([{ id: "y", state: "running" }, { id: "x", state: "running" }]);
  assert.equal(todoRunsSignature(a), todoRunsSignature(b));
  assert.notEqual(todoRunsSignature(a), todoRunsSignature(c));
  assert.equal(todoRunsSignature(new Map()), "");
});

test("todoRunsSignature changes with a new execution or a stop", () => {
  const a = normalizeTodoRuns([{ id: "x", run_id: "run_1", state: "running" }]);
  const b = normalizeTodoRuns([{ id: "x", run_id: "run_2", state: "running" }]);
  const c = normalizeTodoRuns([{ id: "x", run_id: "run_1", state: "running", stopping: true }]);
  assert.notEqual(todoRunsSignature(a), todoRunsSignature(b));
  assert.notEqual(todoRunsSignature(a), todoRunsSignature(c));
});

test("normalizeFinishedTodoRuns keys known outcomes by run ID", () => {
  const finished = normalizeFinishedTodoRuns([
    { id: "x", run_id: "run_1", status: "canceled", stopping: true },
    { id: "x", run_id: "run_2", status: "exploded" },
    { id: "y", status: "done" },
    null,
  ]);
  assert.deepEqual([...finished.keys()], ["run_1"]);
  assert.deepEqual(finished.get("run_1"), { id: "x", status: TODO_RUN_CANCELED, stopping: true });
  assert.equal(normalizeFinishedTodoRuns(undefined).size, 0);
});
