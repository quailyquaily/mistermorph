import assert from "node:assert/strict";
import test from "node:test";

import { cronTopicJobGone, cronTopicModels, cronTopicModelText, cronTopicsOf, topicJobID } from "./chat-cron-topics.js";

const JOB = "job-0b7e5d1c-2f7a-4c2e-9a51-1d2f3e4a5b6c";

test("a topic's job is its job_id, or the ID in a legacy _cron_ topic ID", () => {
  assert.equal(topicJobID({ id: `_cron_${JOB}`, job_id: JOB }), JOB);
  assert.equal(topicJobID({ id: "_cron_task-3" }), "task-3");
  assert.equal(topicJobID({ id: "_cron_task-3", job_id: " task-3 " }), "task-3");
  assert.equal(topicJobID({ id: "topic-x", job_id: JOB }), JOB);
  assert.equal(topicJobID({ id: "topic-x" }), "");
  assert.equal(topicJobID({ id: "_cron_" }), "");
  assert.equal(topicJobID(null), "");
});

test("TODO topics are the ones that name a job, newest first", () => {
  const topics = [
    { id: "own", updated_at: "2026-11-03" },
    { id: "_cron_task-3", updated_at: "2026-11-01" },
    { id: `_cron_${JOB}`, job_id: JOB, updated_at: "2026-11-02" },
  ];
  assert.deepEqual(
    cronTopicsOf(topics).map((topic) => topic.id),
    [`_cron_${JOB}`, "_cron_task-3"]
  );
});

test("the model row and the gone state look the job up by its ID", () => {
  const models = cronTopicModels({
    llm_default_route: { inference_provider: "openai", model: "gpt-5.2" },
    llm_profiles: [{ name: "batch", inference_provider: "xai", model: "grok" }],
    tasks: [{ id: JOB, llm_profile: "batch" }, { id: "task-3" }],
  });
  assert.equal(cronTopicModelText(models, { id: `_cron_${JOB}`, job_id: JOB }), "xai · grok");
  assert.equal(cronTopicModelText(models, { id: "_cron_task-3" }), "openai · gpt-5.2");
  // A job that is gone shows what its last run used, or that it is not scheduled.
  const gone = { id: "_cron_task-9", job_id: "task-9", llm_provider: "openai", llm_model: "gpt-4o" };
  assert.equal(cronTopicModelText(models, gone), "openai · gpt-4o");
  assert.equal(cronTopicModelText(models, { id: "_cron_task-8" }, { unscheduled: "No longer scheduled" }), "No longer scheduled");
  assert.equal(cronTopicJobGone(models, gone), true);
  assert.equal(cronTopicJobGone(models, { id: `_cron_${JOB}`, job_id: JOB }), false);
  assert.equal(cronTopicJobGone(null, gone), false);
  assert.equal(cronTopicJobGone(models, { id: "own" }), false);
});
