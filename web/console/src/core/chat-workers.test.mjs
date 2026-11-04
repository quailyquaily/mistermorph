import assert from "node:assert/strict";
import test from "node:test";

import { normalizeActivity } from "./chat-task-history.js";
import {
  normalizeActivityWorkers,
  rosterWorkers,
  workerAvatar,
  workerOutput,
  workerProcessLabel,
  workerState,
} from "./chat-workers.js";

const serverWorkers = [
  {
    id: "worker-1", name: "Milo", kind: "subagent", status: "failed", activity_id: "spawn-1",
    error: "gave up", summary: "partial", processes: [{ pid: 0, program: "x" }],
  },
  {
    id: "worker-2", name: "Nova", kind: "coder", status: "running", activity_id: "coder-1", stream: "codex",
    output: "  # not markdown\n<b>raw</b>\n", processes: [{ pid: 4242, program: "codex", activity_id: "coder-1" }],
  },
  { id: "worker-2", name: "Nova again" },
  { id: "", name: "nameless id" },
  { id: "worker-3", name: "" },
];

test("normalizeActivityWorkers keeps valid workers once and is stable when run again", () => {
  const once = normalizeActivityWorkers(serverWorkers);
  assert.deepEqual(once.map((worker) => worker.id), ["worker-1", "worker-2"]);
  assert.deepEqual(once[0].processes, []);
  assert.deepEqual(once[1].processes, [{ pid: 4242, program: "codex", activityId: "coder-1" }]);
  assert.equal(once[1].kind, "coder");
  assert.equal(once[1].activityId, "coder-1");
  assert.deepEqual(normalizeActivityWorkers(once), once);
  assert.deepEqual(normalizeActivityWorkers(undefined), []);
});

test("normalizeActivity carries the roster through repeated normalization and alone", () => {
  const activity = normalizeActivity({ history: [{ id: "a", kind: "tool", name: "read_file" }], workers: serverWorkers, workers_omitted: 2 });
  assert.equal(activity.workers.length, 2);
  assert.equal(activity.workersOmitted, 2);
  const again = normalizeActivity(activity);
  assert.deepEqual(again.workers, activity.workers);
  assert.equal(again.workersOmitted, 2);
  // Workers whose entries all scrolled out still make an activity.
  const onlyWorkers = normalizeActivity({ workers: serverWorkers });
  assert.equal(onlyWorkers.workers.length, 2);
  assert.equal(normalizeActivity({ history: [] }), null);
  assert.deepEqual(normalizeActivity({ history: [{ id: "a", kind: "tool" }] }).workers, []);
});

test("workerState shows running, done, failed or canceled, and a live worker takes the task's ending", () => {
  assert.equal(workerState({ status: "running" }, "running"), "running");
  assert.equal(workerState({ status: "queued" }, "queued"), "running");
  assert.equal(workerState({ status: "" }, ""), "running");
  assert.equal(workerState({ status: "done" }, "failed"), "done");
  assert.equal(workerState({ status: "failed" }, "done"), "failed");
  assert.equal(workerState({ status: "running" }, "done"), "done");
  assert.equal(workerState({ status: "running" }, "canceled"), "canceled");
  assert.equal(workerState({ status: "canceled" }, "running"), "canceled");
});

test("workerOutput prefers the error, then raw output, then the summary", () => {
  assert.equal(workerOutput({ error: " boom ", output: "out", summary: "sum" }), "boom");
  assert.equal(workerOutput({ output: "  keep\n spacing\n", summary: "sum" }), "  keep\n spacing\n");
  assert.equal(workerOutput({ output: " \n ", summary: " sum " }), "sum");
  assert.equal(workerOutput({}), "");
  assert.equal(workerProcessLabel({ pid: 7, program: "bash" }), "bash PID 7");
  assert.equal(workerProcessLabel({ pid: 7, program: "" }), "PID 7");
});

test("workerAvatar depends on the name alone, is mirrored, and differs between names", () => {
  const a = workerAvatar("Milo");
  assert.deepEqual(workerAvatar(" Milo "), a);
  assert.ok(a.hue >= 0 && a.hue < 360);
  assert.ok(a.cells.length > 0);
  const filled = new Set(a.cells.map((cell) => `${cell.x},${cell.y}`));
  for (const cell of a.cells) {
    assert.ok(cell.x >= 0 && cell.x < 5 && cell.y >= 0 && cell.y < 5);
    assert.ok(filled.has(`${4 - cell.x},${cell.y}`), "pattern is mirrored");
  }
  const names = ["Milo", "Nova", "Iris", "Juno", "Milo-2", "Milo-3", "Otto", "Pia"];
  const looks = new Set(names.map((name) => JSON.stringify(workerAvatar(name))));
  assert.equal(looks.size, names.length);
});

test("rosterWorkers adds the state and note to show", () => {
  const activity = normalizeActivity({ workers: serverWorkers });
  const roster = rosterWorkers(activity, "done");
  assert.deepEqual(roster.map((worker) => [worker.name, worker.state, worker.note]), [
    ["Milo", "failed", "gave up"],
    ["Nova", "done", "  # not markdown\n<b>raw</b>\n"],
  ]);
  assert.deepEqual(rosterWorkers(null, "done"), []);
});
