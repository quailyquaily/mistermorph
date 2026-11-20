// The pages' last answers (docs/feat/feat_20261120_console_local_cache.md): a page that was seen
// before opens with what it showed, while it asks the runtime again; in the phone app also after
// the app was closed, from its store on disk.
import type { App } from "nsh/test";
import { expect, test } from "nsh/test";
import { openConsole, type ApiHandler, type ApiRequest } from "./harness";

const NOW = new Date().toISOString();

function topic(id: string, title: string) {
  return { id, title, created_at: NOW, updated_at: NOW };
}
function doneTask(id: string, task: string, output: string, topicID: string) {
  return { id, task, topic_id: topicID, status: "done", created_at: NOW, started_at: NOW, finished_at: NOW, result: { final: { output } } };
}
function runningTask(id: string, task: string, topicID: string) {
  return { id, task, topic_id: topicID, status: "running", created_at: NOW, started_at: NOW };
}
function todoBody(titles: string[]) {
  return {
    tasks: titles.map((title, i) => ({ id: `task-${i}`, title, content: "Check it", cron: "15 9 * * 1", tz: "UTC" })),
    system_tasks: [{ id: "__heartbeat__", cron: "*/30 * * * *" }],
    chat_options: [],
    llm_profiles: [],
    heartbeat_enabled: true,
    runs: [],
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A route that answers `body`, slowly, and notes what the app shows while it waits: a test's
 * steps wait for the app's requests, so the screen during one is read from inside it.
 */
function watched(body: unknown) {
  let app: App | null = null;
  const seen: { texts: string[]; spinner: boolean }[] = [];
  const handler: ApiHandler = async () => {
    const answer = body;
    if (app) {
      await sleep(150);
      seen.push({ texts: app.texts(), spinner: app.shows("id:chat-topics-loading") });
    }
    return { body: answer };
  };
  return {
    handler,
    /** From now on the route notes the screen of `next`, and answers `body`. */
    watch(next: App, nextBody: unknown = body) {
      app = next;
      body = nextBody;
    },
    /** What the app showed while the last request waited. */
    last: () => seen[seen.length - 1],
    asked: () => seen.length,
  };
}

const gone = (app: App, selector: string) => app.waitFor(selector, { state: "gone" });

test("the topic list opens again with the topics it had, and takes the runtime's answer when it comes", async () => {
  const topics = watched({ items: [topic("topic-1", "Trip plans"), topic("topic-2", "Recipes")] });
  const { app } = await openConsole({
    platform: "android",
    location: "/e/default/chat",
    api: { "GET /proxy:/topics": topics.handler, "GET /proxy:/tasks": { body: { items: [] } } },
  });
  await app.waitFor("Trip plans");
  await app.press("id:mobile-nav-todo");
  await app.waitFor("id:todo-heartbeat-item");
  await gone(app, "Trip plans");

  topics.watch(app, { items: [topic("topic-1", "Trip plans"), topic("topic-3", "Garden")] });
  await app.press("id:mobile-nav-chat");
  await app.waitFor("Garden");
  // While the runtime had not answered, the list was last time's, with no spinner.
  expect(topics.asked()).toBe(1);
  expect(topics.last().texts).toContain("Trip plans");
  expect(topics.last().texts).toContain("Recipes");
  expect(topics.last().texts).not.toContain("Garden");
  expect(topics.last().spinner).toBe(false);
  expect(app.shows("Recipes")).toBe(false);
});

test("the first visit has nothing to show: the spinner, as before", async () => {
  const topics = watched({ items: [topic("topic-1", "Trip plans")] });
  const { app } = await openConsole({
    platform: "android",
    location: "/e/default/todo",
    api: { "GET /proxy:/topics": topics.handler, "GET /proxy:/tasks": { body: { items: [] } } },
  });
  await app.waitFor("id:todo-heartbeat-item");
  topics.watch(app);
  await app.press("id:mobile-nav-chat");
  await app.waitFor("Trip plans");
  expect(topics.last().texts).not.toContain("Trip plans");
  expect(topics.last().spinner).toBe(true);
});

test("the to-do list opens again with its items", async () => {
  const tasks = watched(todoBody(["Water the plants", "Call the bank"]));
  const { app } = await openConsole({
    platform: "android",
    location: "/e/default/todo",
    api: { "GET /proxy:/todo/tasks": tasks.handler },
  });
  await app.waitFor("Water the plants");
  await app.press("id:mobile-nav-chat");
  await gone(app, "Water the plants");

  tasks.watch(app, todoBody(["Water the plants", "Call the bank today"]));
  await app.press("id:mobile-nav-todo");
  await app.waitFor("Call the bank today");
  expect(tasks.last().texts).toContain("Water the plants");
  expect(tasks.last().texts).toContain("Call the bank");
  expect(app.shows("Call the bank")).toBe(false);
  expect(app.count("id:todo-item-task-1")).toBe(1);
});

test("a conversation opens again with its finished runs, and the run still under way comes with the answer", async () => {
  const history = watched({ items: [doneTask("t1", "Where to go?", "Try Lisbon.", "topic-1")] });
  const { app } = await openConsole({
    platform: "android",
    location: "/e/default/chat",
    api: {
      "GET /proxy:/topics": { body: { items: [topic("topic-1", "Trip plans"), topic("topic-2", "Recipes")] } },
      "GET /proxy:/tasks": (request: ApiRequest) =>
        (request.uri || "").includes("topic_id=topic-1") ? (history.handler as (request: ApiRequest) => Promise<{ body: unknown }>)(request) : { body: { items: [] } },
      "GET /proxy:/tasks/t2": { body: runningTask("t2", "And where to stay?", "topic-1") },
    },
  });
  await app.waitFor("Trip plans");
  await app.press("id:chat-topic-topic-1");
  await app.waitFor("id:chat-back");
  await app.waitFor("text:Try Lisbon.");
  await app.back();
  await app.waitFor("id:chat-back", { state: "gone" });
  await app.press("id:chat-topic-topic-2");
  await app.waitFor("id:chat-back");
  await gone(app, "text:Try Lisbon.");
  await app.back();
  await app.waitFor("id:chat-back", { state: "gone" });

  // Another device asked meanwhile, and that run is under way.
  history.watch(app, { items: [runningTask("t2", "And where to stay?", "topic-1"), doneTask("t1", "Where to go?", "Try Lisbon.", "topic-1")] });
  await app.press("id:chat-topic-topic-1");
  await app.waitFor("text:And where to stay?");
  await app.waitFor("text:Try Lisbon.");
  expect(history.last().texts).toContain("Try Lisbon.");
  expect(history.last().texts).not.toContain("And where to stay?");

  // The run still under way is not kept: the next opening shows the finished one alone, then asks.
  await app.back();
  await app.waitFor("id:chat-back", { state: "gone" });
  await app.press("id:chat-topic-topic-2");
  await app.waitFor("id:chat-back");
  await app.back();
  await app.waitFor("id:chat-back", { state: "gone" });
  await app.press("id:chat-topic-topic-1");
  await app.waitFor("text:And where to stay?");
  expect(history.last().texts).toContain("Try Lisbon.");
  expect(history.last().texts).not.toContain("And where to stay?");
});

test("the phone app, closed and opened again, shows its last topics and to-do items before the runtime answers", async () => {
  const api = (topics: ApiHandler, tasks: ApiHandler) => ({
    "GET /proxy:/topics": topics,
    "GET /proxy:/tasks": { body: { items: [] } },
    "GET /proxy:/todo/tasks": tasks,
  });
  const first = await openConsole({
    platform: "android",
    cacheFiles: true,
    location: "/e/default/chat",
    api: api({ body: { items: [topic("topic-1", "Trip plans")] } }, { body: todoBody(["Water the plants"]) }),
  });
  await first.app.waitFor("Trip plans");
  await first.app.press("id:mobile-nav-todo");
  await first.app.waitFor("Water the plants");
  // The store takes the answers a moment after they came.
  const files = () => Object.keys(first.app.storage()).filter((key) => key.startsWith("cachefs:") && !key.endsWith("index.json"));
  await first.app.waitUntil(() => files().length >= 3, { timeout: 10000 });
  const kept = Object.fromEntries(Object.entries(first.app.storage()).filter(([key]) => key.startsWith("cachefs:")));

  // The app opens on another page, so the two pages are first opened while it is watched.
  const topics = watched({ items: [topic("topic-1", "Trip plans"), topic("topic-9", "New topic since")] });
  const tasks = watched(todoBody(["Water the plants", "New item since"]));
  const second = await openConsole({
    platform: "android",
    cacheFiles: true,
    location: "/e/default/contacts",
    kv: kept,
    api: api(topics.handler, tasks.handler),
  });
  await second.app.waitFor("id:mobile-nav-chat");
  topics.watch(second.app);
  tasks.watch(second.app);
  await second.app.press("id:mobile-nav-chat");
  await second.app.waitFor("New topic since");
  expect(topics.last().texts).toContain("Trip plans");
  expect(topics.last().texts).not.toContain("New topic since");
  expect(topics.last().spinner).toBe(false);
  await second.app.press("id:mobile-nav-todo");
  await second.app.waitFor("New item since");
  expect(tasks.last().texts).toContain("Water the plants");
  expect(tasks.last().texts).not.toContain("New item since");
});

test("a session the console rejects takes the kept answers with it, on the device too", async () => {
  let rejected = false;
  const expires = new Date(Date.now() + 86400000).toISOString();
  const { app } = await openConsole({
    platform: "android",
    cacheFiles: true,
    password: true,
    kv: { mistermorph_console_auth_v1: JSON.stringify({ token: "token-1", expiresAt: expires, account: "console" }) },
    location: "/e/default/chat",
    api: {
      "GET /auth/me": () => (rejected ? { status: 401, body: { error: "unauthorized" } } : { body: { account: "console", expires_at: expires } }),
      "GET /proxy:/topics": { body: { items: [topic("topic-1", "Trip plans")] } },
      "GET /proxy:/tasks": { body: { items: [] } },
    },
  });
  await app.waitFor("Trip plans");
  const entries = () => Object.keys(app.storage()).filter((key) => key.startsWith("cachefs:") && !key.endsWith("index.json"));
  await app.waitUntil(() => entries().length >= 1, { timeout: 10000 });
  rejected = true;
  await app.press("id:mobile-nav-todo");
  await app.waitFor("id:login-password");
  await app.waitUntil(() => entries().length === 0, { timeout: 10000 });
});
