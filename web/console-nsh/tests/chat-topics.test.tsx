// Chat's topic list and topic panel: groups, opening a topic, activity marks, the TODO runs toggle,
// tags, pin, regenerate and delete, and the failures of each.
import { expect, test } from "nsh/test";
import { openConsole, type ApiRequest } from "./harness";

const NOW = new Date().toISOString();
const PANEL_OPEN = { mistermorph_console_workspace_sidebar_open_v1: "true" };

function topic(id: string, title: string, extra: Record<string, unknown> = {}) {
  return { id, title, created_at: NOW, updated_at: NOW, ...extra };
}

function doneTask(id: string, task: string, output: string, topicID: string) {
  return { id, task, topic_id: topicID, status: "done", created_at: NOW, started_at: NOW, finished_at: NOW, result: { final: { output } } };
}

const TOPICS = [topic("topic-1", "Trip plans", { tags: ["pinned"] }), topic("topic-2", "Recipes", { tags: ["food"] })];

function history(request: ApiRequest) {
  const uri = request.uri || "";
  if (uri.includes("topic_id=topic-1")) return { body: { items: [doneTask("t1", "Where to go?", "Try **Lisbon**.", "topic-1")] } };
  if (uri.includes("topic_id=topic-2")) return { body: { items: [doneTask("t2", "Soup ideas", "Make a miso soup.", "topic-2")] } };
  return { body: { items: [] } };
}

test("the list groups pinned and dated topics, and opening one shows its conversation", async () => {
  const { app, calls } = await openConsole({
    location: "/e/default/chat",
    api: { "GET /proxy:/topics": { body: { items: TOPICS } }, "GET /proxy:/tasks": history },
  });
  await app.waitFor("id:chat-topic-sidebar");
  await app.waitFor("PINNED");
  await app.waitFor("TODAY");
  await app.waitFor("Trip plans");
  await app.waitFor("Choose a topic on the left, or write below to start another thread.");
  await app.press("id:chat-topic-topic-2");
  await app.waitFor("text:Make a miso soup.");
  await app.waitFor("Soup ideas");
  expect(calls.some((call) => call.uri?.includes("topic_id=topic-2"))).toBe(true);
  // Folding the pinned group hides its topic and shows its count.
  await app.press("id:chat-topic-group-pinned");
  await app.waitFor("id:chat-topic-topic-1", { state: "gone" });
  await app.press("id:chat-topic-group-pinned");
  await app.waitFor("id:chat-topic-topic-1");
});

test("a topic in the address opens at once, and the tag view groups by tag", async () => {
  const { app } = await openConsole({
    location: "/e/default/chat/topic-1",
    api: { "GET /proxy:/topics": { body: { items: TOPICS } }, "GET /proxy:/tasks": history },
  });
  await app.waitFor("text:Try Lisbon.");
  await app.press("id:chat-topics-view-tags");
  // In the tag view a group's label is the tag, in its own case (the date view's are capitals).
  await app.waitFor("food");
  await app.waitFor("id:chat-topic-group-tag:food");
  await app.press("id:chat-topics-view-tags");
  await app.waitFor("TODAY");
});

test("activity marks follow the runtime, and the TODO toggle counts running runs", async () => {
  const { app } = await openConsole({
    location: "/e/default/chat",
    api: {
      "GET /proxy:/topics": { body: { items: [...TOPICS, topic("_cron_job1", "Daily digest")] } },
      "GET /proxy:/tasks": history,
      "GET /proxy:/topics/activity": {
        body: {
          topics: [
            { id: "topic-2", status: "running", running: 1 },
            { id: "_cron_job1", status: "running", running: 1, cron_running: 2 },
          ],
        },
      },
      "GET /proxy:/todo/tasks": { body: { tasks: [{ id: "job1", llm_profile: "" }], llm_default_route: { inference_provider: "openai", model: "gpt-5.2" } } },
    },
  });
  await app.waitFor("id:chat-topic-status-running");
  await app.waitFor("label:TODO runs — 2 running");
  await app.waitFor("id:chat-cron-running");
  // The TODO view lists the items' topics with their model.
  await app.press("id:chat-topics-view-cron");
  await app.waitFor("Daily digest");
  await app.waitUntil(() => app.texts().some((text) => text.endsWith("· gpt-5.2")));
  expect(app.shows("Trip plans")).toBe(false);
  await app.press("id:chat-topics-view-cron");
  await app.waitFor("Trip plans");
});

test("the TODO view says so when no item has run", async () => {
  const { app } = await openConsole({
    location: "/e/default/chat",
    api: { "GET /proxy:/topics": { body: { items: TOPICS } }, "GET /proxy:/tasks": history, "GET /proxy:/todo/tasks": { body: { tasks: [] } } },
  });
  await app.waitFor("id:chat-topics-view-cron");
  await app.press("id:chat-topics-view-cron");
  await app.waitFor("No TODO item has run yet. Once an item runs, its runs appear here in a topic of its own.");
});

test("the topic panel pins, tags and deletes the topic, and puts things back when a save fails", async () => {
  let tagsFail = false;
  let deleted = false;
  const { app, calls } = await openConsole({
    location: "/e/default/chat/topic-2",
    kv: PANEL_OPEN,
    api: {
      "GET /proxy:/topics": () => ({ body: { items: deleted ? [TOPICS[0]] : TOPICS } }),
      "GET /proxy:/tasks": history,
      "PUT /proxy:/topics/topic-2/tags": (request: ApiRequest) =>
        tagsFail ? { status: 500, body: { error: "tags store is down" } } : { body: topic("topic-2", "Recipes", { tags: request.json.tags }) },
      "DELETE /proxy:/topics/topic-2": () => {
        deleted = true;
        return { body: {} };
      },
      "GET /proxy:/topic/topic-2/metadata": {
        body: { workspace: { workspace_dir: "", source: "none" }, context: { available: true, used_input_tokens: 5000, context_window_tokens: 100000 } },
      },
    },
  });
  await app.waitFor("id:chat-topic-panel");
  await app.waitFor("id:chat-topic-context-ratio");
  expect(app.texts()).toContain("5.0%");
  // Pin.
  await app.press("id:chat-topic-pin");
  await app.waitUntil(() => calls.some((call) => call.method === "PUT" && call.json?.tags?.includes("pinned")));
  await app.waitFor("id:chat-topic-group-pinned");
  // A tag that fails to save goes away again, with the error.
  tagsFail = true;
  await app.type("id:chat-topic-tags-input", "weekly");
  await app.submit("id:chat-topic-tags-input");
  await app.waitFor("tags store is down");
  // Delete, after the confirmation.
  await app.press("id:chat-topic-delete");
  await app.waitFor("Delete topic \"Recipes\"? This hides its tasks from the default view.");
  await app.press("id:dialog-action-delete");
  await app.waitUntil(() => deleted);
  await app.waitFor("id:chat-topic-topic-2", { state: "gone" });
});

test("a failed delete says why and keeps the topic", async () => {
  const { app } = await openConsole({
    location: "/e/default/chat/topic-2",
    kv: PANEL_OPEN,
    api: {
      "GET /proxy:/topics": { body: { items: TOPICS } },
      "GET /proxy:/tasks": history,
      "DELETE /proxy:/topics/topic-2": { status: 500, body: { error: "cannot delete now" } },
    },
  });
  await app.waitFor("id:chat-topic-delete");
  await app.press("id:chat-topic-delete");
  await app.press("id:dialog-action-delete");
  await app.waitFor("cannot delete now");
  expect(app.shows("id:chat-topic-topic-2")).toBe(true);
});

test("topics that fail to load show the error", async () => {
  const { app } = await openConsole({
    location: "/e/default/chat",
    api: { "GET /proxy:/topics": { status: 500, body: { error: "topics unavailable" } } },
  });
  await app.waitFor("topics unavailable");
});

test("older topics load on demand", async () => {
  const { app } = await openConsole({
    location: "/e/default/chat",
    api: {
      "GET /proxy:/topics": (request: ApiRequest) =>
        request.uri?.includes("cursor=c2")
          ? { body: { items: [topic("topic-9", "Old notes", { updated_at: "2024-01-02T00:00:00Z" })], next_cursor: "" } }
          : { body: { items: TOPICS, next_cursor: "c2" } },
      "GET /proxy:/tasks": history,
    },
  });
  await app.waitFor("id:chat-topics-load-older");
  await app.press("id:chat-topics-load-older");
  await app.waitFor("Old notes");
  await app.waitFor("id:chat-topics-load-older", { state: "gone" });
});
