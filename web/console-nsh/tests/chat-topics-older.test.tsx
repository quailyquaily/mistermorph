// The topic list's "Load older topics" (FT173). Its pages one press at a time, without an app
// (pages/chat/olderTopics.ts: a held fetch would hold a headless app's every step); the control in
// the real TopicSidebar (fixtures/topic-load-older-app.tsx: its frames beside the topic rows, its
// idle, loading, failed and gone states, the reader's place as a page lands); and through the real
// console, in the date and tag views and during a search (older pages by cursor, a failure in the
// control rather than the notices, a retry). The search's own note: tests/chat-topic-search.test.tsx.
import type { App } from "nsh/test";
import { expect, open, test } from "nsh/test";
import { createOlderTopicPages, type OlderTopicPage } from "../pages/chat/olderTopics";
import { openConsole, type ApiRequest } from "./harness";

/* ---------- the pages, without an app ---------- */

function heldPages(cursor = "c2") {
  const asked: Array<{ cursor: string; settle: (page: OlderTopicPage | Error) => void }> = [];
  const landed: OlderTopicPage[] = [];
  const state = { cursor, blocked: false };
  const pages = createOlderTopicPages({
    cursor: () => state.cursor,
    blocked: () => state.blocked,
    fetch: (at) =>
      new Promise((resolve, reject) => {
        asked.push({ cursor: at, settle: (page) => (page instanceof Error ? reject(page) : resolve(page)) });
      }),
    land: (page) => {
      landed.push(page);
      state.cursor = page.nextCursor;
    },
    errorText: (error) => (error instanceof Error && error.message) || "load failed",
  });
  return { pages, asked, landed, state };
}

test("a press asks for the page after the cursor once: more presses while it is on its way ask nothing", async () => {
  const { pages, asked, landed } = heldPages();
  const first = pages.load();
  expect(pages.loading()).toBe(true);
  expect(await pages.load()).toBe(false);
  expect(await pages.load()).toBe(false);
  expect(asked.map((ask) => ask.cursor)).toEqual(["c2"]);
  asked[0].settle({ items: [{ id: "old" }], nextCursor: "c3" });
  expect(await first).toBe(true);
  expect(pages.loading()).toBe(false);
  expect(landed.map((page) => page.nextCursor)).toEqual(["c3"]);
  // The next press asks for the next page.
  void pages.load();
  expect(asked.map((ask) => ask.cursor)).toEqual(["c2", "c3"]);
});

test("a page that fails keeps the cursor and the list, says why, and the next press asks for it again", async () => {
  const { pages, asked, landed, state } = heldPages();
  const first = pages.load();
  asked[0].settle(new Error("topic store unavailable"));
  expect(await first).toBe(false);
  expect(pages.loading()).toBe(false);
  expect(pages.error()).toBe("topic store unavailable");
  expect(landed.length).toBe(0);
  expect(state.cursor).toBe("c2");
  // The retry: busy again, the failure gone while it runs, then the page lands.
  const retry = pages.load();
  expect(pages.loading()).toBe(true);
  expect(pages.error()).toBe("");
  expect(asked.map((ask) => ask.cursor)).toEqual(["c2", "c2"]);
  asked[1].settle({ items: [{ id: "old" }], nextCursor: "" });
  expect(await retry).toBe(true);
  expect(pages.error()).toBe("");
  // No older page left: a press asks nothing.
  expect(await pages.load()).toBe(false);
  expect(asked.length).toBe(2);
});

test("with no cursor, or while the first page loads, a press asks nothing", async () => {
  const none = heldPages("");
  expect(await none.pages.load()).toBe(false);
  expect(none.asked.length).toBe(0);
  const blocked = heldPages();
  blocked.state.blocked = true;
  expect(await blocked.pages.load()).toBe(false);
  expect(blocked.pages.loading()).toBe(false);
  expect(blocked.asked.length).toBe(0);
});

test("after a reset (another agent) the page on its way lands nowhere, and its failure says nothing", async () => {
  const { pages, asked, landed } = heldPages();
  const landing = pages.load();
  pages.reset();
  expect(pages.loading()).toBe(false);
  asked[0].settle({ items: [{ id: "old" }], nextCursor: "c3" });
  expect(await landing).toBe(false);
  expect(landed.length).toBe(0);
  const failing = pages.load();
  pages.reset();
  asked[1].settle(new Error("gone"));
  expect(await failing).toBe(false);
  expect(pages.error()).toBe("");
  // A failure is forgotten by a reset too.
  const third = pages.load();
  asked[2].settle(new Error("down"));
  await third;
  expect(pages.error()).toBe("down");
  pages.reset();
  expect(pages.error()).toBe("");
});

/* ---------- the control in the sidebar ---------- */

type Frame = { x: number; y: number; w: number; h: number };
type Report = { frames: Record<string, Frame>; offset: number; asks: number; loading: boolean };

function report(app: App): Report {
  return JSON.parse(app.texts().find((text) => text.startsWith('{"frames"')) ?? "{}") as Report;
}

const IDLE = "role:button[Load older topics]";
const LOADING = "role:button[Loading older topics...]";
const FAILED = "role:button[Couldn't load older topics. Try again]";

for (const screen of [
  // The desktop sidebar: 40pt rows inside its 16pt gutter; the phone's page: 44pt rows edge to edge.
  { name: "desktop", width: 1000, platform: "linux" as const, row: 40, gutter: 16 },
  { name: "phone", width: 390, platform: "android" as const, row: 44, gutter: 0 },
]) {
  const openList = async () => {
    const app = await open("./fixtures/topic-load-older-app.tsx", { width: screen.width, height: 600, platform: screen.platform, locale: "en-US" });
    await app.waitUntil(() => Boolean(report(app).frames?.["older-label"] && report(app).frames?.["title-t16"] && report(app).frames?.sidebar));
    return app;
  };

  test(`${screen.name}: the control is the list's last row, drawn as a topic row is`, async () => {
    const app = await openList();
    const { frames } = report(app);
    const sidebar = frames.sidebar;
    // The rows' width and inset, their height.
    expect(frames.older.x).toBe(sidebar.x + screen.gutter);
    expect(frames.older.w).toBe(sidebar.w - 2 * screen.gutter);
    expect(frames.older.h).toBe(screen.row);
    // Its label starts where the topics' titles do, after the 20pt icon box the rows have.
    expect(frames["older-label"].x).toBe(frames["title-t16"].x);
    expect(frames["older-icon"].w).toBe(20);
    expect(frames["older-icon"].h).toBe(20);
    expect(Math.abs(frames["older-icon"].y + 10 - (frames.older.y + frames.older.h / 2))).toBeLessThanOrEqual(0.5);
    // Under the last row, a row's 2pt below it.
    expect(frames.older.y).toBeGreaterThan(frames["title-t16"].y);
    expect(app.shows("id:chat-topics-load-older-icon")).toBe(true);
  });

  test(`${screen.name}: loading it is busy where it was and takes no second press; failed it says so, and a press tries again`, async () => {
    const app = await openList();
    const idle = report(app).frames.older;
    await app.press(IDLE);
    expect(report(app).asks).toBe(1);
    await app.waitFor(LOADING);
    await app.waitFor("id:chat-topics-load-older-loading");
    expect(app.shows("id:chat-topics-load-older-icon")).toBe(false);
    // The label stays (the look says it is busy); its name says so to assistive tech.
    expect(app.shows("text:Load older topics")).toBe(true);
    // Busy, a press there asks nothing.
    await app.press("id:chat-topics-load-older");
    await app.press("id:chat-topics-load-older");
    expect(report(app).asks).toBe(1);
    expect(report(app).frames.older).toEqual(idle);
    // Failed: the same row, in place, saying so with its mark; nothing else in the list says it.
    await app.press("id:fail");
    await app.waitFor(FAILED);
    await app.waitFor("text:Couldn't load. Try again");
    await app.waitFor("id:chat-topics-load-older-failed");
    expect(app.shows("id:chat-topics-load-older-loading")).toBe(false);
    expect(report(app).frames.older).toEqual(idle);
    await app.press(FAILED);
    expect(report(app).asks).toBe(2);
    await app.waitFor(LOADING);
    expect(app.shows("id:chat-topics-load-older-failed")).toBe(false);
    await app.press("id:land-end");
    await app.waitFor("text:Older 1.1");
    await app.waitFor(IDLE);
  });

  // A phone (Android, headless) moves no keyboard focus between views.
  if (screen.name === "desktop")
  test(`${screen.name}: the keyboard reaches it and presses it; busy, a key asks nothing`, async () => {
    const app = await openList();
    // Tab goes through the head and the rows to it (headless, Space presses a focused view; in a
    // browser Enter does too).
    for (let i = 0; i < 40 && report(app).asks === 0; i++) {
      await app.keyboard.press("tab");
      await app.keyboard.press("space");
    }
    expect(report(app).asks).toBe(1);
    await app.waitFor(LOADING);
    await app.keyboard.press("space");
    await app.keyboard.press("enter");
    expect(report(app).asks).toBe(1);
  });

  test(`${screen.name}: older topics come in where the control was, and those that go higher up do not move the rows on screen`, async () => {
    const app = await openList();
    await app.scroll("id:chat-topic-list", 4000);
    await app.waitUntil(() => report(app).offset > 0);
    const end = report(app).offset;
    // At the end: its topics after the last row; the list stays where it was.
    await app.press(IDLE);
    await app.press("id:land-end");
    await app.waitFor("text:Older 1.3");
    await app.wait(100);
    expect(report(app).offset).toBe(end);
    // Into the pinned group at the top: the list scrolls by the three rows that grew above, so the
    // rows on screen stay put.
    await app.press(IDLE);
    await app.press("id:land-top");
    await app.waitFor("text:Older 2.1");
    await app.waitUntil(() => report(app).offset !== end);
    expect(report(app).offset).toBe(end + 3 * (screen.row + 2));
  });

  test(`${screen.name}: with no older page left the control goes, and its room with it`, async () => {
    const app = await openList();
    const lastTitle = report(app).frames["title-t16"];
    await app.press(IDLE);
    await app.press("id:land-last");
    await app.waitFor("text:Older 1.3");
    await app.waitFor("id:chat-topics-load-older", { state: "gone" });
    expect(app.shows(LOADING)).toBe(false);
    expect(app.shows(FAILED)).toBe(false);
    expect(lastTitle.y).toBeGreaterThan(0);
  });
}

test("while the first page reloads the control takes no press", async () => {
  const app = await open("./fixtures/topic-load-older-app.tsx", { width: 1000, height: 600, platform: "linux", locale: "en-US" });
  await app.waitFor(IDLE);
  await app.press("id:refreshing");
  await app.press("id:chat-topics-load-older").catch(() => {});
  expect(report(app).asks).toBe(0);
  await app.press("id:refreshing");
  await app.press(IDLE);
  expect(report(app).asks).toBe(1);
});

/* ---------- through the console ---------- */

const NOW = new Date().toISOString();
const topic = (id: string, title: string, extra: Record<string, unknown> = {}) => ({ id, title, created_at: NOW, updated_at: NOW, ...extra });
const OLD = "2024-01-02T00:00:00Z";
const FIRST = [topic("topic-1", "Trip plans", { tags: ["travel"] }), topic("topic-2", "Recipes", { tags: ["food"] })];
const param = (request: ApiRequest, name: string) => new URLSearchParams((request.uri ?? "").split("?")[1] ?? "").get(name);
const olderAsks = (calls: ApiRequest[]) => calls.filter((call) => call.method === "GET" && call.uri?.startsWith("/topics?") && param(call, "cursor")).map((call) => param(call, "cursor"));

/** The topics in pages: the first with cursor c2; c2 fails while `fail.c2` is set. */
function pagedTopics(fail: { c2: boolean }) {
  return (request: ApiRequest) => {
    const cursor = param(request, "cursor");
    if (cursor === "c2") {
      if (fail.c2) return { status: 500, body: { error: "topic store unavailable" } };
      return { body: { items: [topic("topic-9", "Old notes", { updated_at: OLD, created_at: OLD, tags: ["food"] })], next_cursor: "" } };
    }
    return { body: { items: FIRST, next_cursor: "c2" } };
  };
}

test("a failed older page shows in the control, not the notices, and the retry loads it", async () => {
  const fail = { c2: true };
  const { app, calls } = await openConsole({
    location: "/e/default/chat",
    api: { "GET /proxy:/topics": pagedTopics(fail), "GET /proxy:/tasks": { body: { items: [] } } },
  });
  await app.press(IDLE);
  await app.waitFor(FAILED);
  // The reason is the control's tooltip and description, never a notice of its own.
  expect(app.shows("role:alert >> text:topic store unavailable")).toBe(false);
  expect(app.shows("Trip plans")).toBe(true);
  expect(olderAsks(calls)).toEqual(["c2"]);
  fail.c2 = false;
  await app.press(FAILED);
  await app.waitFor("Old notes");
  await app.waitFor("id:chat-topics-load-older", { state: "gone" });
  expect(olderAsks(calls)).toEqual(["c2", "c2"]);
});

test("in the tag view the control is there too, and an older topic joins its tag's group", async () => {
  const { app, calls } = await openConsole({
    location: "/e/default/chat",
    api: { "GET /proxy:/topics": pagedTopics({ c2: false }), "GET /proxy:/tasks": { body: { items: [] } } },
  });
  await app.waitFor("Trip plans");
  await app.press("id:chat-topics-view-tags");
  await app.waitFor("id:chat-topic-group-tag:food");
  await app.press(IDLE);
  await app.waitFor("Old notes");
  await app.waitFor("id:chat-topics-load-older", { state: "gone" });
  expect(olderAsks(calls)).toEqual(["c2"]);
});

test("during a search with no match the note and the control stay together, and a failure keeps the note", async () => {
  const fail = { c2: true };
  const { app } = await openConsole({
    location: "/e/default/chat",
    api: { "GET /proxy:/topics": pagedTopics(fail), "GET /proxy:/tasks": { body: { items: [] } } },
  });
  await app.waitFor(IDLE);
  await app.type("id:chat-topics-search", "old notes");
  await app.waitFor("Load older topics to search further back.");
  await app.press(IDLE);
  await app.waitFor(FAILED);
  expect(app.shows("Load older topics to search further back.")).toBe(true);
  fail.c2 = false;
  await app.press(FAILED);
  await app.waitFor("id:chat-topic-topic-9");
  await app.waitFor("id:chat-topics-load-older", { state: "gone" });
  expect(app.shows("Load older topics to search further back.")).toBe(false);
});
