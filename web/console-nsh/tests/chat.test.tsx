// Chat: the topic list, the conversation, the composer and the reply that follows a send.
import { expect, test } from "nsh/test";
import { openConsole, type ApiRequest } from "./harness";

const CHAT = "/e/default/chat";
const NOW = new Date().toISOString();

function topic(id: string, title: string, extra: Record<string, unknown> = {}) {
  return { id, title, created_at: NOW, updated_at: NOW, ...extra };
}

function doneTask(id: string, task: string, output: string, topicID = "topic-1") {
  return {
    id,
    task,
    topic_id: topicID,
    status: "done",
    created_at: NOW,
    started_at: NOW,
    finished_at: NOW,
    result: { final: { output } },
  };
}

test("with no topics the chat opens on its landing composer", async () => {
  const { app } = await openConsole({ location: CHAT });
  await app.waitFor("id:chat-placeholder");
  await app.waitFor("New Topic");
  await app.waitFor("Write something here to start a new chat.");
  await app.waitFor("id:chat-composer-input");
  expect(app.enabled("id:chat-composer-send")).toBe(false);
});

test("a message sent from the landing composer starts a topic and shows the reply", async () => {
  let polls = 0;
  let created = false;
  const { app, calls } = await openConsole({
    location: CHAT,
    api: {
      "POST /proxy:/tasks": (request: ApiRequest) => {
        created = true;
        expect(request.json.task).toBe("Hello there");
        expect(request.json.trigger).toMatchObject({ source: "ui", event: "chat_submit" });
        return { body: { id: "task-1", status: "queued", topic_id: "topic-1" } };
      },
      "GET /proxy:/topics": () => ({ body: { items: created ? [topic("topic-1", "Greetings")] : [] } }),
      "GET /proxy:/tasks/task-1": () => {
        polls += 1;
        return polls < 2
          ? { body: { id: "task-1", task: "Hello there", status: "running", topic_id: "topic-1", created_at: NOW } }
          : { body: doneTask("task-1", "Hello there", "Hi! **Nice** to meet you.") };
      },
      "GET /proxy:/tasks": (request: ApiRequest) =>
        request.uri?.includes("topic_id=topic-1")
          ? { body: { items: polls >= 2 ? [doneTask("task-1", "Hello there", "Hi! **Nice** to meet you.")] : [] } }
          : { body: { items: [] } },
    },
  });
  await app.waitFor("id:chat-composer-input");
  await app.type("id:chat-composer-input", "Hello there");
  expect(app.enabled("id:chat-composer-send")).toBe(true);
  await app.press("id:chat-composer-send");
  await app.waitFor("Hello there");
  await app.waitFor("text:Hi! Nice to meet you.", { timeout: 8000 });
  await app.waitFor("Greetings");
  expect(calls.some((call) => call.method === "POST" && call.uri === "/tasks")).toBe(true);
  expect(app.value("id:chat-composer-input")).toBe("");
});

test("a topic in the address that the agent does not have falls back to the landing composer", async () => {
  const { app } = await openConsole({
    location: `${CHAT}/gone`,
    api: {
      "GET /proxy:/topics": { body: { items: [topic("topic-1", "Ops")] } },
      "GET /proxy:/topics/gone": { status: 404, body: { error: "not found" } },
      "GET /proxy:/tasks": { body: { items: [] } },
    },
  });
  await app.waitFor("id:chat-placeholder");
  await app.waitFor("New Topic");
});
