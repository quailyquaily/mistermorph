import assert from "node:assert/strict";
import test from "node:test";

import { normalizeTodoRuns, todoRunsSignature, TODO_RUN_QUEUED, TODO_RUN_RUNNING } from "./todo-runs.js";

test("normalizeTodoRuns keys running and queued items by ID", () => {
  const runs = normalizeTodoRuns([
    { id: " build ", state: "running", started_at: "2026-11-04T03:00:00Z", queued_at: "2026-11-04T03:00:00Z" },
    { id: "review", state: "queued", manual: true, started_at: "0001-01-01T00:00:00Z" },
    { id: "", state: "running" },
    { id: "odd", state: "paused" },
    null,
  ]);
  assert.deepEqual([...runs.keys()], ["build", "review"]);
  assert.deepEqual(runs.get("build"), { state: TODO_RUN_RUNNING, manual: false, startedAt: "2026-11-04T03:00:00Z" });
  assert.deepEqual(runs.get("review"), { state: TODO_RUN_QUEUED, manual: true, startedAt: "" });
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
