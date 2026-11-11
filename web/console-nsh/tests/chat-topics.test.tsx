// Chat's topic list and topic panel: groups, opening a topic, activity marks, the TODO runs toggle,
// tags, pin and delete, and the failures of each (renaming: chat-topic-rename.test.tsx).
import type { App } from "nsh/test";
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

test("the TODO toggle's clock hands turn as long as the runs, through a failed poll, and the toggle works meanwhile", async () => {
  let cronRunning = 2;
  let pollFails = false;
  const { app } = await openConsole({
    location: "/e/default/chat",
    clock: true,
    api: {
      "GET /proxy:/topics": { body: { items: [...TOPICS, topic("_cron_job1", "Daily digest")] } },
      "GET /proxy:/tasks": history,
      "GET /proxy:/topics/activity": () =>
        pollFails
          ? { status: 503, body: { error: "runtime is restarting" } }
          : { body: { topics: cronRunning ? [{ id: "_cron_job1", status: "running", running: 1, cron_running: cronRunning }] : [] } },
      "GET /proxy:/todo/tasks": { body: { tasks: [{ id: "job1", llm_profile: "" }] } },
    },
  });
  await app.waitFor("id:chat-cron-running");
  expect(app.enabled("id:chat-topics-view-cron")).toBe(true);
  // Running is a status, not a busy toggle: it opens the TODO list and back, one press each.
  await app.press("id:chat-topics-view-cron");
  await app.waitFor("Daily digest");
  expect(app.shows("Trip plans")).toBe(false);
  expect(app.count("id:chat-cron-running")).toBe(1);
  await app.press("id:chat-topics-view-cron");
  await app.waitFor("Trip plans");
  // One of two ends: still running.
  cronRunning = 1;
  await app.clock!.runFor(5000);
  await app.waitFor("label:TODO runs — 1 running");
  expect(app.count("id:chat-cron-running")).toBe(1);
  // A failed poll is not the end of the runs: the hands keep turning.
  pollFails = true;
  await app.clock!.runFor(5000);
  expect(app.count("id:chat-cron-running")).toBe(1);
  // The last one ends: the hands settle and the toggle is plain again.
  pollFails = false;
  cronRunning = 0;
  await app.clock!.runFor(5000);
  await app.waitFor("id:chat-cron-running", { state: "gone" });
  await app.waitFor("label:TODO runs");
  await app.press("id:chat-topics-view-cron");
  await app.waitFor("Daily digest");
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
  expect(app.shows("label:Remove tag weekly")).toBe(false);
  expect(app.shows("label:Remove tag food")).toBe(true);
  // Delete, after the confirmation.
  await app.press("id:chat-topic-delete");
  await app.waitFor("Delete topic \"Recipes\"? This hides its tasks from the default view.");
  await app.press("id:dialog-action-delete");
  await app.waitUntil(() => deleted);
  await app.waitFor("id:chat-topic-topic-2", { state: "gone" });
});

/* ---------- adding tags from the panel ---------- */

/** The panel open on `topicID`, its tag saves answered with the tags sent (or `failTags`). */
async function openTagPanel(options: { topics: any[]; topicID: string; platform?: "android"; failTags?: boolean }) {
  const saves: string[][] = [];
  const opened = await openConsole({
    location: `/e/default/chat/${options.topicID}`,
    // The phone's panel is a sheet, opened with its toggle.
    kv: options.platform ? {} : PANEL_OPEN,
    platform: options.platform,
    api: {
      "GET /proxy:/topics": { body: { items: options.topics } },
      "GET /proxy:/tasks": history,
      [`PUT /proxy:/topics/${options.topicID}/tags`]: (request: ApiRequest) => {
        saves.push(request.json.tags);
        return options.failTags
          ? { status: 500, body: { error: "tags store is down" } }
          : { body: { ...options.topics.find((item) => item.id === options.topicID), tags: request.json.tags } };
      },
      [`GET /proxy:/topic/${options.topicID}/metadata`]: { body: { workspace: { workspace_dir: "", source: "none" } } },
    },
  });
  return { ...opened, saves };
}

/** Whether the tag field has the focus: a key typed lands in it. */
async function tagFieldFocused(app: App) {
  const before = app.value("id:chat-topic-tags-input") ?? "";
  await app.keyboard.press("q");
  const after = app.value("id:chat-topic-tags-input") ?? "";
  if (after === before) return false;
  await app.keyboard.press("backspace");
  await app.waitUntil(() => app.value("id:chat-topic-tags-input") === before);
  return true;
}

test("a press on the panel's tag box opens the known tags, and picking one saves it with the pin and lists the topic under it", async () => {
  const { app, saves } = await openTagPanel({ topics: TOPICS, topicID: "topic-1" });
  await app.waitFor("id:chat-topic-tags");
  // The tag view lists the pinned topic once, in the pinned group.
  await app.press("id:chat-topics-view-tags");
  await app.waitFor("id:chat-topic-group-pinned");
  expect(app.count("id:chat-topic-topic-1")).toBe(1);
  // A press on the box (not the field) focuses the field, which offers the other topics' tags.
  await app.press("id:chat-topic-tags");
  await app.waitFor("role:option[food]");
  await app.press("role:option[food]");
  await app.waitUntil(() => saves.length === 1);
  // The pin stays, first; the tag is saved, shown as a chip, and no longer offered.
  expect(saves[0]).toEqual(["pinned", "food"]);
  await app.waitFor("label:Remove tag food");
  await app.waitFor("role:option[food]", { state: "gone" });
  // The topic list follows without a reload: the topic is in the food group too.
  await app.waitUntil(() => app.count("id:chat-topic-topic-1") === 2);
  // The field still has the focus for the next tag.
  expect(await tagFieldFocused(app)).toBe(true);
});

test("with no tags anywhere a press on the box still lets the first tag be typed", async () => {
  const topics = [topic("topic-1", "Trip plans")];
  const { app, saves } = await openTagPanel({ topics, topicID: "topic-1" });
  await app.waitFor("id:chat-topic-tags");
  await app.press("id:chat-topic-tags");
  expect(await tagFieldFocused(app)).toBe(true);
  expect(app.count("role:option")).toBe(0);
  await app.type("id:chat-topic-tags-input", "weekly");
  await app.submit("id:chat-topic-tags-input");
  await app.waitUntil(() => saves.length === 1);
  expect(saves[0]).toEqual(["weekly"]);
  await app.waitFor("label:Remove tag weekly");
});

test("a tag the topic has already is not added again, and the topic keeps its tags", async () => {
  const { app, saves } = await openTagPanel({ topics: TOPICS, topicID: "topic-2" });
  await app.waitFor("label:Remove tag food");
  await app.type("id:chat-topic-tags-input", "Food");
  await app.submit("id:chat-topic-tags-input");
  await app.waitUntil(() => (app.value("id:chat-topic-tags-input") ?? "") === "");
  expect(saves).toEqual([]);
  expect(app.count("label:Remove tag food")).toBe(1);
  // A new one goes after it.
  await app.type("id:chat-topic-tags-input", "soup, Food");
  await app.waitUntil(() => saves.length === 1);
  expect(saves[0]).toEqual(["food", "soup"]);
});

test("a tag picked from the box that fails to save says so and goes away", async () => {
  const { app, saves } = await openTagPanel({ topics: TOPICS, topicID: "topic-1", failTags: true });
  await app.waitFor("id:chat-topic-tags");
  await app.press("id:chat-topic-tags");
  await app.press("role:option[food]");
  await app.waitFor("tags store is down");
  expect(saves).toEqual([["pinned", "food"]]);
  expect(app.shows("label:Remove tag food")).toBe(false);
  // The pin is still there: the topic stays in the pinned group.
  expect(app.shows("id:chat-topic-group-pinned")).toBe(true);
});

test("on an Android phone a tap on the sheet's tag box opens the known tags, and a tapped tag is saved", async () => {
  const { app, saves } = await openTagPanel({ topics: TOPICS, topicID: "topic-1", platform: "android" });
  await app.waitFor("id:chat-workspace-toggle");
  await app.press("id:chat-workspace-toggle");
  await app.waitFor("id:chat-topic-tags");
  await app.press("id:chat-topic-tags");
  await app.waitFor("role:option[food]");
  await app.press("role:option[food]");
  await app.waitUntil(() => saves.length === 1);
  expect(saves[0]).toEqual(["pinned", "food"]);
  await app.waitFor("label:Remove tag food");
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
