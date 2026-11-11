// A task whose question (ask_user) waits for the person's answer says so, in the reply, its
// progress panel and the topic list, instead of showing it at work; the answer sets it running
// again, a finished task keeps its own status, and queued work is never waiting for an answer.
import { expect, test } from "nsh/test";
import { openConsole, type ApiRequest } from "./harness";

const NOW = new Date().toISOString();
const TOPICS = { body: { items: [{ id: "topic-1", title: "Ops", created_at: NOW, updated_at: NOW }] } };
const CHAT = "/e/default/chat/topic-1";
const QUESTION = { id: "q1", text: "Which city?", options: [{ label: "Lisbon" }, { label: "Porto" }], status: "open" };
const ACTIVITY = { current: { id: "call-1", kind: "tool", name: "ask_user", status: "running" }, history: [] };

function task(id: string, extra: Record<string, unknown>) {
  return { id, task: "Plan the trip", topic_id: "topic-1", created_at: NOW, started_at: NOW, ...extra };
}

function listOf(...items: unknown[]) {
  return (request: ApiRequest) => (request.uri?.includes("topic_id=topic-1") ? { body: { items } } : { body: { items: [] } });
}

test("an open question says the reply waits for the answer, and the answer sets it running again", async () => {
  let answered = false;
  const waiting = task("t1", { status: "running", awaiting_answer: true, result: { questions: [QUESTION], activity: ACTIVITY } });
  const resumed = task("t1", {
    status: "running",
    result: { questions: [{ ...QUESTION, status: "answered", answer: "Porto", option: 1 }], activity: ACTIVITY },
  });
  const { app } = await openConsole({
    location: CHAT,
    api: {
      "GET /proxy:/topics": TOPICS,
      "GET /proxy:/tasks": (request: ApiRequest) => listOf(answered ? resumed : waiting)(request),
      "GET /proxy:/tasks/t1": () => ({ body: answered ? resumed : waiting }),
      "GET /proxy:/topics/activity": () => ({
        body: { topics: [answered ? { id: "topic-1", status: "running", running: 1 } : { id: "topic-1", status: "waiting", running: 1, waiting: 1 }] },
      }),
      "POST /proxy:/tasks/t1/answer": () => {
        answered = true;
        return { body: { answered: true, answer: "Porto" } };
      },
    },
  });
  await app.waitFor("id:chat-question");
  await app.waitFor("id:chat-waiting-answer");
  await app.waitFor("label:Waiting for your answer");
  // The topic's mark is the orange one of a task waiting for the person, with its own words.
  await app.waitFor("id:chat-topic-status-waiting");
  await app.waitFor("label:A task is waiting for your answer");
  expect(app.shows("id:chat-topic-status-running")).toBe(false);
  // Its progress panel waits too.
  await app.press("id:chat-status-activity");
  await app.waitFor("id:chat-detail-mark-pending");

  await app.press("label:Porto");
  await app.waitUntil(() => answered);
  await app.waitFor("id:chat-waiting-answer", { state: "gone", timeout: 4000 });
  await app.waitFor("id:chat-detail-mark-running");
  await app.waitFor("id:chat-topic-status-running", { timeout: 8000 });
  expect(app.shows("id:chat-topic-status-waiting")).toBe(false);
});

test("after a reload, a running task the server says waits for an answer shows the wait", async () => {
  // No questions yet (the stream has not sent them): the task's awaiting_answer decides.
  const waiting = task("t1", { status: "running", awaiting_answer: true });
  const { app } = await openConsole({
    location: CHAT,
    api: {
      "GET /proxy:/topics": TOPICS,
      "GET /proxy:/tasks": listOf(waiting),
      "GET /proxy:/tasks/t1": { body: waiting },
    },
  });
  await app.waitFor("id:chat-waiting-answer");
});

test("a question that expired, or a finished task, is not waiting for an answer", async () => {
  for (const reply of [
    task("t1", { status: "running", result: { questions: [{ ...QUESTION, status: "expired" }] } }),
    task("t1", { status: "done", finished_at: NOW, result: { questions: [QUESTION], final: { output: "Lisbon it is." } } }),
    task("t1", { status: "failed", finished_at: NOW, error: "timed out", result: { questions: [QUESTION] } }),
    task("t1", { status: "canceled", finished_at: NOW, error: "stopped by user", awaiting_answer: true }),
  ]) {
    const { app } = await openConsole({
      location: CHAT,
      api: { "GET /proxy:/topics": TOPICS, "GET /proxy:/tasks": listOf(reply), "GET /proxy:/tasks/t1": { body: reply } },
    });
    await app.waitFor("id:chat-item-agent");
    if ((reply as any).result?.questions) await app.waitFor("id:chat-question");
    expect(app.shows("id:chat-waiting-answer")).toBe(false);
  }
});

test("queued work and a task without questions keep their own marks", async () => {
  const queued = task("t1", { status: "queued", awaiting_answer: true, result: { questions: [] } });
  const { app } = await openConsole({
    location: CHAT,
    api: {
      "GET /proxy:/topics": TOPICS,
      "GET /proxy:/tasks": listOf(queued),
      "GET /proxy:/tasks/t1": { body: queued },
      "GET /proxy:/topics/activity": { body: { topics: [{ id: "topic-1", status: "running", running: 1 }] } },
    },
  });
  await app.waitFor("id:chat-item-agent");
  await app.waitFor("id:chat-topic-status-running");
  await app.waitFor("label:A task is running");
  expect(app.shows("id:chat-waiting-answer")).toBe(false);
});

test("the task list calls a running task waiting for its answer so, and nothing else", async () => {
  const { app } = await openConsole({
    location: "/e/default/audit",
    api: {
      "GET /proxy:/audit/files": { body: { default_file: "guard_audit.jsonl", items: [{ name: "guard_audit.jsonl" }] } },
      "GET /proxy:/audit/logs": { body: { exists: true, items: [] } },
      "GET /proxy:/tasks": {
        body: {
          items: [
            { id: "ask", task: "Ask about the trip", status: "running", awaiting_answer: true, created_at: "2026-11-10T09:00:00Z" },
            { id: "work", task: "Work on the trip", status: "running", created_at: "2026-11-10T08:00:00Z" },
            { id: "wait", task: "Queued trip", status: "queued", awaiting_answer: true, created_at: "2026-11-10T07:00:00Z" },
          ],
          next_cursor: "",
        },
      },
    },
  });
  await app.press("id:audit-tasks");
  await app.waitFor("Ask about the trip");
  await app.waitFor("Waiting for answer");
  await app.waitFor("Running");
  await app.waitFor("Queued");
  expect(app.texts().filter((text) => text === "Waiting for answer").length).toBe(1);
});
