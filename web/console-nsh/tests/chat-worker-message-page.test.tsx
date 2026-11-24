// Messaging a running subagent from the chat page: its panel's field posts the message for that
// worker alone (`steer_target_child_id`), never as a new message of the conversation; a worker the
// runtime reports finished keeps the draft, and the main agent gets it only when asked.
import { expect, test } from "nsh/test";
import { openConsole, type ApiRequest } from "./harness";

const NOW = new Date().toISOString();
const TOPICS = { body: { items: [{ id: "topic-1", title: "Ops", created_at: NOW, updated_at: NOW }] } };
const CHAT = "/e/default/chat/topic-1";
const NO_WORKSPACE = { body: { workspace: { workspace_dir: "", source: "none" } } };

const RUNNING = {
  id: "t1",
  task: "Write three haiku",
  topic_id: "topic-1",
  created_at: NOW,
  started_at: NOW,
  status: "running",
  result: {
    activity: {
      history: [{ id: "spawn-1", kind: "tool", name: "spawn", status: "running", args: { task: "write a haiku about cats" } }],
      workers: [{ id: "worker-1", name: "Curie", name_index: 1, avatar_index: 0, kind: "subagent", status: "running", activity_id: "spawn-1" }],
    },
  },
};

async function openRunning(answer: (request: ApiRequest) => { status?: number; body: unknown }) {
  const posts: any[] = [];
  const { app } = await openConsole({
    location: CHAT,
    api: {
      "GET /proxy:/topics": TOPICS,
      "GET /proxy:/tasks": (request: ApiRequest) => ({ body: { items: request.uri?.includes("topic_id=topic-1") ? [RUNNING] : [] } }),
      "GET /proxy:/tasks/t1": { body: RUNNING },
      "GET /proxy:/topic/topic-1/metadata": NO_WORKSPACE,
      "POST /proxy:/tasks": (request: ApiRequest) => {
        posts.push(request.json);
        return answer(request);
      },
    },
  });
  await app.waitFor("label:Curie · Subagent · Running");
  await app.press("label:Curie · Subagent · Running");
  await app.waitFor("id:chat-worker-message-input");
  return { app, posts };
}

test("the worker panel's field sends to that worker, and the message shows queued in its record", async () => {
  const { app, posts } = await openRunning((request) => ({
    body: { id: "t1", status: "running", topic_id: "topic-1", steer_target_task_id: "t1", steer_target_child_id: request.json?.steer_target_child_id, steer_status: "queued" },
  }));
  await app.type("id:chat-worker-message-input", "use metric units");
  await app.press("id:chat-worker-message-send");
  await app.waitUntil(() => posts.length === 1);
  expect(posts[0]).toMatchObject({ task: "use metric units", topic_id: "topic-1", steer_target_child_id: "worker-1" });
  await app.waitUntil(() => app.count("id:chat-worker-message-status.queued") === 1);
  // Not a message of the conversation.
  expect(app.count("id:chat-item-user")).toBe(1);
});

test("a worker the runtime reports finished keeps the draft; the main agent gets it only when asked", async () => {
  const { app, posts } = await openRunning((request) =>
    request.json?.steer_target_child_id
      ? { status: 409, body: { code: "child_finished", error: "Curie has already finished, so your message was not sent.", task_id: "t1", child_id: "worker-1" } }
      : { body: { id: "t2", status: "running", topic_id: "topic-1", steer_target_task_id: "t1" } },
  );
  await app.type("id:chat-worker-message-input", "also add a title");
  await app.press("id:chat-worker-message-send");
  await app.waitUntil(() => app.count("id:chat-worker-message-error") === 1);
  expect(app.texts()).toContain("Curie has already finished, so this was not sent.");
  expect(posts.length).toBe(1);

  await app.press("id:chat-worker-message-to-parent");
  await app.waitUntil(() => posts.length === 2);
  expect(posts[1].task).toBe("also add a title");
  expect(posts[1].steer_target_child_id).toBeUndefined();
  await app.waitUntil(() => app.count("id:chat-item-user") === 2);
});
