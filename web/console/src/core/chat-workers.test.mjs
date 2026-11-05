import assert from "node:assert/strict";
import test from "node:test";

import { normalizeActivity, taskListHistoryItems } from "./chat-task-history.js";
import {
  normalizeActivityWorkers,
  rosterWorkers,
  workerAvatar,
  workerProcessLabel,
  workerSections,
  workerState,
} from "./chat-workers.js";

const serverWorkers = [
  {
    id: "worker-1", name: "Milo", kind: "subagent", status: "failed", activity_id: "spawn-1",
    error: "gave up", summary: "partial", result: "partial answer\nwith detail", processes: [{ pid: 0, program: "x" }],
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

test("workerSections shows the error, the result and the output, with the summary as a fallback", () => {
  const kinds = (worker) => workerSections(worker).map((section) => section.kind);
  assert.deepEqual(workerSections({ error: " boom ", result: "first\nsecond: 42", output: "  keep\n spacing\n", summary: "sum" }), [
    { kind: "error", text: "boom" },
    { kind: "result", text: "first\nsecond: 42" },
    { kind: "output", text: "  keep\n spacing\n" },
  ]);
  assert.deepEqual(kinds({ result: "answer", summary: "answer" }), ["result"]);
  assert.deepEqual(workerSections({ output: " \n ", result: " ", summary: " sum " }), [{ kind: "summary", text: "sum" }]);
  assert.deepEqual(kinds({ error: "boom", summary: "boom" }), ["error"]);
  assert.deepEqual(workerSections({}), []);
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
  assert.deepEqual(roster.map((worker) => [worker.name, worker.state, worker.sections.map((section) => section.kind)]), [
    ["Milo", "failed", ["error", "result"]],
    ["Nova", "done", ["output"]],
  ]);
  assert.equal(roster[0].sections[1].text, "partial answer\nwith detail");
  assert.deepEqual(rosterWorkers(null, "done"), []);
});

test("coder output keeps line boundaries through live normalization and restored history", () => {
  for (const stream of ["codex", "claude"]) {
    for (const output of [
      "Codex is starting\nCodex is working\nCodex is working\n",
      "\n  par", "\n  partial\n\tline  \n", "\n", "", " \t",
      "Codex is startingCodex is working", // Old corrupt history is not repaired by guessing.
    ]) {
      const entry = { id: "coder", kind: "tool", name: "coder", stream, output };
      const raw = { current: entry, history: [entry], workers: [
        { id: "worker", name: "Milo", kind: "coder", stream, output },
      ] };
      const live = normalizeActivity(raw);
      const tasks = JSON.parse(JSON.stringify([
        { id: "task", status: "done", task: "code", result: { activity: raw, final: { output: "done" } } },
      ]));
      const restored = taskListHistoryItems(tasks, (key) => key).find((item) => item.activity).activity;
      for (const activity of [live, normalizeActivity(live), restored]) {
        assert.equal(activity.current.output, output);
        assert.equal(activity.history[0].output, output);
        assert.equal(activity.workers[0].output, output);
        if (output.trim()) {
          assert.deepEqual(workerSections(activity.workers[0]), [{ kind: "output", text: output }]);
        }
      }
    }
  }
});
