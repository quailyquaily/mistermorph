import assert from "node:assert/strict";
import test from "node:test";

import { findTodoTopic, todoTopicID } from "./todo-topic.js";

const JOB = "job-0b7e5d1c-2f7a-4c2e-9a51-1d2f3e4a5b6c";

function fetchReturning(topic) {
  return async (_ref, path) => {
    if (topic === null) {
      const error = new Error("not found");
      error.status = 404;
      throw error;
    }
    return { path, ...topic };
  };
}

test("an item's topic is _cron_<job id> and names the job", async () => {
  assert.equal(todoTopicID(JOB), `_cron_${JOB}`);
  assert.equal(await findTodoTopic(fetchReturning({ id: `_cron_${JOB}`, job_id: JOB }), "default", JOB), `_cron_${JOB}`);
  // An earlier agent sends no job_id; the topic's ID names the job.
  assert.equal(await findTodoTopic(fetchReturning({ id: "_cron_task-1" }), "default", "task-1"), "_cron_task-1");
  // A topic that names another job is not the item's.
  assert.equal(await findTodoTopic(fetchReturning({ id: `_cron_${JOB}`, job_id: "job-other" }), "default", JOB), "");
  assert.equal(await findTodoTopic(fetchReturning(null), "default", JOB), "");
});
