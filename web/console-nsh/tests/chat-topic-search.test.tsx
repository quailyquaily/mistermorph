// Chat's topic search: a filter on the titles of the loaded topics in the sidebar's current view.
import { expect, test } from "nsh/test";
import { openConsole, type ApiRequest } from "./harness";

const NOW = new Date().toISOString();

function topic(id: string, title: string, extra: Record<string, unknown> = {}) {
  return { id, title, created_at: NOW, updated_at: NOW, ...extra };
}

function doneTask(id: string, task: string, output: string, topicID: string) {
  return { id, task, topic_id: topicID, status: "done", created_at: NOW, started_at: NOW, finished_at: NOW, result: { final: { output } } };
}

const TOPICS = [
  topic("topic-1", "Trip plans", { tags: ["pinned"] }),
  topic("topic-2", "Recipes", { tags: ["food"] }),
  topic("topic-3", "", { tags: ["food"] }),
];

function history(request: ApiRequest) {
  const uri = request.uri || "";
  if (uri.includes("topic_id=topic-1")) return { body: { items: [doneTask("t1", "Where to go?", "Try **Lisbon**.", "topic-1")] } };
  if (uri.includes("topic_id=topic-2")) return { body: { items: [doneTask("t2", "Soup ideas", "Make a miso soup.", "topic-2")] } };
  return { body: { items: [] } };
}

const NO_MATCH = (query: string) => `No loaded topic title matches “${query}”.`;
const OLDER_HINT = "Load older topics to search further back.";

test("the search filters by title, ignoring case and outer spaces, and an empty one shows every topic", async () => {
  const { app } = await openConsole({
    location: "/e/default/chat",
    api: { "GET /proxy:/topics": { body: { items: TOPICS } }, "GET /proxy:/tasks": history },
  });
  await app.waitFor("id:chat-topics-search");
  await app.waitFor("id:chat-topic-topic-3");
  await app.type("id:chat-topics-search", "  rECIp ");
  await app.waitFor("id:chat-topic-topic-1", { state: "gone" });
  expect(app.shows("id:chat-topic-topic-2")).toBe(true);
  expect(app.shows("id:chat-topic-topic-3")).toBe(false);
  // A group without a match goes; the dated group with the match stays.
  expect(app.shows("PINNED")).toBe(false);
  expect(app.shows("TODAY")).toBe(true);
  // An untitled topic is found by the title the row shows.
  await app.clear("id:chat-topics-search");
  await app.type("id:chat-topics-search", "untitled");
  await app.waitFor("id:chat-topic-topic-3");
  expect(app.shows("id:chat-topic-topic-2")).toBe(false);
  // Only spaces is no search.
  await app.clear("id:chat-topics-search");
  await app.type("id:chat-topics-search", "   ");
  await app.waitFor("id:chat-topic-topic-1");
  expect(app.shows("id:chat-topic-topic-2")).toBe(true);
  expect(app.shows("id:chat-topic-topic-3")).toBe(true);
  // Nothing matches: the list says so.
  await app.clear("id:chat-topics-search");
  await app.type("id:chat-topics-search", "zebra");
  await app.waitFor(NO_MATCH("zebra"));
  expect(app.shows("id:chat-topic-topic-1")).toBe(false);
  expect(app.shows(OLDER_HINT)).toBe(false);
  // The field's clear button brings every topic back.
  await app.press("id:chat-topics-search-clear");
  await app.waitFor("id:chat-topic-topic-1");
  expect(app.shows("id:chat-topic-topic-2")).toBe(true);
  expect(app.shows(NO_MATCH("zebra"))).toBe(false);
});

test("a match in a folded group shows while the search lasts, and the group's fold is kept", async () => {
  const { app } = await openConsole({
    location: "/e/default/chat",
    api: { "GET /proxy:/topics": { body: { items: TOPICS } }, "GET /proxy:/tasks": history },
  });
  await app.waitFor("id:chat-topic-group-pinned");
  await app.press("id:chat-topic-group-pinned");
  await app.waitFor("id:chat-topic-topic-1", { state: "gone" });
  const foldWrites = () =>
    app.host.calls().filter((call) => call.name === "morph.kv.set" && String((call.data as any)?.key || "").includes("topicGroupsCollapsed")).length;
  const writesBefore = foldWrites();
  await app.type("id:chat-topics-search", "trip");
  await app.waitFor("id:chat-topic-topic-1");
  // While searching the heading is a plain label, not a fold toggle.
  expect(app.shows("id:chat-topic-group-pinned")).toBe(false);
  expect(app.shows("PINNED")).toBe(true);
  await app.press("id:chat-topics-search-clear");
  await app.waitFor("id:chat-topic-group-pinned");
  expect(app.shows("id:chat-topic-topic-1")).toBe(false);
  expect(foldWrites()).toBe(writesBefore);
  // The tag view's folds behave the same.
  await app.press("id:chat-topics-view-tags");
  await app.waitFor("id:chat-topic-group-tag:food");
  await app.press("id:chat-topic-group-tag:food");
  await app.waitFor("id:chat-topic-topic-2", { state: "gone" });
  await app.clear("id:chat-topics-search");
  await app.type("id:chat-topics-search", "RECIPES");
  await app.waitFor("id:chat-topic-topic-2");
  expect(app.shows("food")).toBe(true);
  await app.clear("id:chat-topics-search");
  await app.waitFor("id:chat-topic-topic-2", { state: "gone" });
  expect(app.shows("id:chat-topic-group-tag:food")).toBe(true);
});

test("the search stays within the current view", async () => {
  const { app } = await openConsole({
    location: "/e/default/chat",
    api: {
      "GET /proxy:/topics": { body: { items: [...TOPICS, topic("_cron_job1", "Daily digest")] } },
      "GET /proxy:/tasks": history,
      "GET /proxy:/todo/tasks": { body: { tasks: [{ id: "job1", llm_profile: "" }] } },
    },
  });
  await app.waitFor("id:chat-topics-search");
  // TODO runs are not in the date view, so they are not found there.
  await app.type("id:chat-topics-search", "daily");
  await app.waitFor(NO_MATCH("daily"));
  await app.press("id:chat-topics-view-cron");
  await app.waitFor("Daily digest");
  expect(app.shows(NO_MATCH("daily"))).toBe(false);
  // The query stays across views and filters the new one.
  await app.clear("id:chat-topics-search");
  await app.type("id:chat-topics-search", "trip");
  await app.waitFor(NO_MATCH("trip"));
  expect(app.shows("Daily digest")).toBe(false);
  await app.press("id:chat-topics-view-cron");
  await app.waitFor("id:chat-topic-topic-1");
  expect(app.shows("id:chat-topic-topic-2")).toBe(false);
});

test("typing a search neither changes the open topic nor navigates", async () => {
  const { app, calls } = await openConsole({
    location: "/e/default/chat/topic-1",
    api: { "GET /proxy:/topics": { body: { items: TOPICS } }, "GET /proxy:/tasks": history },
  });
  await app.waitFor("text:Try Lisbon.");
  await app.waitFor("id:chat-topic-selection");
  const navigations = () => app.host.calls().filter((call) => call.name === "morph.history").length;
  const navigationsBefore = navigations();
  await app.type("id:chat-topics-search", "recipes");
  await app.waitFor("id:chat-topic-topic-1", { state: "gone" });
  expect(app.shows("text:Try Lisbon.")).toBe(true);
  expect(app.shows("text:Make a miso soup.")).toBe(false);
  expect(calls.some((call) => call.uri?.includes("topic_id=topic-2"))).toBe(false);
  expect(navigations()).toBe(navigationsBefore);
  // Escape clears the field, and the open topic's row is back.
  await app.keyboard.press("escape");
  await app.waitFor("id:chat-topic-topic-1");
  expect(app.shows("text:Try Lisbon.")).toBe(true);
});

test("older topics loaded during a search join it, without the search loading anything itself", async () => {
  const { app, calls } = await openConsole({
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
  const topicLoads = () => calls.filter((call) => call.method === "GET" && /\/topics(\?|$)/.test(call.uri || "")).length;
  const loadsBefore = topicLoads();
  await app.type("id:chat-topics-search", "old notes");
  await app.waitFor(NO_MATCH("old notes"));
  await app.waitFor(OLDER_HINT);
  expect(topicLoads()).toBe(loadsBefore);
  await app.press("id:chat-topics-load-older");
  await app.waitFor("id:chat-topic-topic-9");
  expect(app.shows(NO_MATCH("old notes"))).toBe(false);
  expect(app.shows("id:chat-topic-topic-1")).toBe(false);
  await app.waitFor("id:chat-topics-load-older", { state: "gone" });
});

test("on a phone the topic list has the search too", async () => {
  const { app } = await openConsole({
    location: "/e/default/chat",
    width: 390,
    height: 844,
    api: { "GET /proxy:/topics": { body: { items: TOPICS } }, "GET /proxy:/tasks": history },
  });
  await app.waitFor("id:chat-topic-sidebar");
  await app.type("id:chat-topics-search", "trip");
  await app.waitFor("id:chat-topic-topic-2", { state: "gone" });
  expect(app.shows("id:chat-topic-topic-1")).toBe(true);
});
