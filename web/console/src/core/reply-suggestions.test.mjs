import assert from "node:assert/strict";
import test from "node:test";

import { latestAnswerTaskID, replySuggestionView } from "./reply-suggestions.js";

const answer = (extra = {}) => ({ role: "agent", status: "done", taskId: "t2", ...extra });

test("latestAnswerTaskID is the last item only when it is a finished answer not awaiting approval", () => {
  assert.equal(latestAnswerTaskID([{ role: "user" }, answer()]), "t2");
  assert.equal(latestAnswerTaskID([answer(), { role: "user", taskId: "t3" }]), "");
  assert.equal(latestAnswerTaskID([answer({ status: "running" })]), "");
  assert.equal(latestAnswerTaskID([answer({ approval: { status: "pending" } })]), "");
  assert.equal(latestAnswerTaskID([answer({ approval: { status: "denied" } })]), "t2");
  assert.equal(latestAnswerTaskID([]), "");
});

const result = {
  task_id: "t2",
  enabled: true,
  expects_reply: true,
  min_probability: 0.6,
  suggestions: [
    { text: "Option 1", probability: 0.3 },
    { text: "Option 2", probability: 0.65 },
    { text: "Option 3", probability: 0.1 },
  ],
};

test("desktop gets the top reply as ghost text only above the bar", () => {
  assert.deepEqual(replySuggestionView({ result, taskID: "t2" }), { ghost: "Option 2", chips: [] });
  assert.equal(replySuggestionView({ result: { ...result, min_probability: 0.7 }, taskID: "t2" }).ghost, "");
});

test("phones get the likely replies as chips, most likely first", () => {
  const view = replySuggestionView({ result, taskID: "t2", mobile: true });
  assert.equal(view.ghost, "");
  assert.deepEqual(view.chips.map((c) => c.text), ["Option 2", "Option 1"]);
});

test("nothing is offered while typing, sending, read-only, dismissed, stale, or off", () => {
  const cases = [
    { input: "x" },
    { sending: true },
    { readonly: true },
    { dismissedTaskID: "t2" },
    { taskID: "t9" },
    { result: { ...result, enabled: false } },
    { result: { ...result, expects_reply: false } },
  ];
  for (const extra of cases) {
    const view = replySuggestionView({ result, taskID: "t2", ...extra });
    assert.deepEqual(view, { ghost: "", chips: [] }, JSON.stringify(extra));
  }
});
