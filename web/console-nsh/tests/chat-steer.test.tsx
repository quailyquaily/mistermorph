// A message sent while the topic's task runs steers that task: the message gets a reply of its
// own, written by the model, and the task keeps running for its answer.
import { expect, test } from "nsh/test";
import { openConsole, type ApiRequest } from "./harness";

const NOW = new Date().toISOString();
const TOPICS = { body: { items: [{ id: "topic-1", title: "Stories", created_at: NOW, updated_at: NOW }] } };
const CHAT = "/e/default/chat/topic-1";
const REPLY = "Understood, I'll keep the story short from here on.";

function task(id: string, text: string, extra: Record<string, unknown>) {
  return { id, task: text, topic_id: "topic-1", created_at: NOW, started_at: NOW, ...extra };
}

const TARGET = task("t1", "Write a story about a fox", { status: "running" });

function steerTask(status: string) {
  return status === "done"
    ? task("s1", "make it shorter", {
        status: "done",
        finished_at: NOW,
        steer_target_task_id: "t1",
        result: { final: { output: REPLY }, steer_reply_status: "replied" },
      })
    : task("s1", "make it shorter", { status: "running", steer_target_task_id: "t1" });
}

test("a steered message shows the model's reply while the task keeps running", async () => {
  let submitted = false;
  let polls = 0;
  const { app } = await openConsole({
    location: CHAT,
    api: {
      "GET /proxy:/topics": TOPICS,
      "GET /proxy:/tasks": (request: ApiRequest) => {
        if (!request.uri?.includes("topic_id=topic-1")) return { body: { items: [] } };
        return { body: { items: submitted ? [TARGET, steerTask(polls >= 2 ? "done" : "running")] : [TARGET] } };
      },
      "GET /proxy:/tasks/t1": { body: TARGET },
      "POST /proxy:/tasks": (request: ApiRequest) => {
        expect(request.json.task).toBe("make it shorter");
        submitted = true;
        return { body: { id: "s1", status: "running", topic_id: "topic-1", steer_target_task_id: "t1" } };
      },
      "GET /proxy:/tasks/s1": () => {
        polls += 1;
        return { body: steerTask(polls >= 2 ? "done" : "running") };
      },
    },
  });
  await app.waitFor("Write a story about a fox");
  await app.type("id:chat-composer-input", "make it shorter");
  await app.press("id:chat-composer-send");
  await app.waitFor("make it shorter");
  await app.waitFor(`text:${REPLY}`, { timeout: 8000 });
  await app.waitUntil(() => polls >= 2);
  expect(app.shows("text:👌")).toBe(false);
});

test("a reloaded topic shows each steered message's reply and hides old acknowledgements", async () => {
  const legacy = task("s0", "use a fox named Rin", {
    status: "done",
    finished_at: NOW,
    steer_target_task_id: "t1",
    result: { final: { output: "👌" } },
  });
  const failed = task("s2", "and set it in winter", {
    status: "done",
    finished_at: NOW,
    steer_target_task_id: "t1",
    result: {
      final: { output: "Your message was added to the running task, but I could not write a reply to it (rate limited)." },
      steer_reply_status: "reply_failed",
    },
  });
  const items = [TARGET, legacy, steerTask("done"), failed];
  const { app } = await openConsole({
    location: CHAT,
    api: {
      "GET /proxy:/topics": TOPICS,
      "GET /proxy:/tasks": (request: ApiRequest) => (request.uri?.includes("topic_id=topic-1") ? { body: { items } } : { body: { items: [] } }),
      "GET /proxy:/tasks/t1": { body: TARGET },
    },
  });
  await app.waitFor("use a fox named Rin");
  await app.waitFor(`text:${REPLY}`);
  await app.waitFor("text:Your message was added to the running task, but I could not write a reply to it (rate limited).");
  expect(app.shows("text:👌")).toBe(false);
});
