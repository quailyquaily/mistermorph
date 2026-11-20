// The row above the oldest loaded message (FT145), through the real chat page and controller: it is
// there only while the runtime has an older page (`next_cursor`), asks for that page with the
// cursor, puts it before the messages already loaded, goes with the last page, and stays for a
// retry when the page fails to load. Its own layout and states: fixtures/chat-history-older-app.tsx.
// Where pages land on screen: tests/chat-scroll-anchor.test.tsx.
import type { App } from "nsh/test";
import { expect, open, test } from "nsh/test";
import { openConsole, type ApiRequest } from "./harness";

const TOPICS = { body: { items: [{ id: "topic-1", title: "Ops", created_at: "2025-01-01T00:00:00Z", updated_at: "2025-01-03T00:00:00Z" }] } };
const CHAT = "/e/default/chat/topic-1";

function task(n: number) {
  const at = `2025-01-0${n}T10:00:00Z`;
  return {
    id: `t${n}`,
    task: `Question ${n}`,
    topic_id: "topic-1",
    status: "done",
    created_at: at,
    started_at: at,
    finished_at: at,
    result: { final: { output: `Answer ${n}` } },
  };
}

/** A query parameter of the agent request a console proxy call carries. */
const param = (request: ApiRequest, name: string) => new URLSearchParams((request.uri ?? "").split("?")[1] ?? "").get(name);

/** The topic's tasks in pages, newest first: `pages[cursor]` (the first page under ""). */
function paged(pages: Record<string, { items: unknown[]; next?: string } | { status: number }>) {
  return (request: ApiRequest) => {
    if (!request.uri?.includes("topic_id=topic-1")) return { body: { items: [] } };
    const page = pages[param(request, "cursor") ?? ""];
    if (!page) return { status: 404, body: { error: "no such page" } };
    if ("status" in page) return { status: page.status, body: { error: "history store down" } };
    return { body: { items: page.items, next_cursor: page.next ?? "" } };
  };
}

const olderRequests = (calls: ApiRequest[]) => calls.filter((call) => call.uri?.startsWith("/tasks?") && param(call, "cursor"));

test("with no older page there is no row above the conversation", async () => {
  const { app } = await openConsole({
    location: CHAT,
    api: { "GET /proxy:/topics": TOPICS, "GET /proxy:/tasks": paged({ "": { items: [task(3)] } }) },
  });
  await app.waitFor("text:Answer 3");
  expect(app.shows("id:chat-history-older")).toBe(false);
  expect(app.shows("id:chat-history-load-older")).toBe(false);
});

test("older pages load by cursor, oldest first, and the row goes with the last one", async () => {
  const { app, calls } = await openConsole({
    location: CHAT,
    api: {
      "GET /proxy:/topics": TOPICS,
      "GET /proxy:/tasks": paged({
        "": { items: [task(5), task(4)], next: "c2" },
        c2: { items: [task(3), task(2)], next: "c3" },
        c3: { items: [task(1)] },
      }),
    },
  });
  await app.waitFor("text:Answer 5");
  await app.waitFor("role:button[Load older messages]");
  await app.press("role:button[Load older messages]");
  await app.waitFor("text:Answer 2");
  // The page the cursor named, for this topic, asked for once; the row stays for the next.
  expect(olderRequests(calls).map((call) => [param(call, "cursor"), param(call, "topic_id")])).toEqual([["c2", "topic-1"]]);
  await app.waitFor("role:button[Load older messages]");
  await app.press("role:button[Load older messages]");
  await app.waitFor("text:Answer 1");
  await app.waitFor("id:chat-history-older", { state: "gone" });
  expect(olderRequests(calls).map((call) => param(call, "cursor"))).toEqual(["c2", "c3"]);
  // Oldest first, the pages before the messages that were loaded.
  const texts = app.texts();
  const order = [1, 2, 3, 4, 5].map((n) => texts.indexOf(`Question ${n}`));
  expect(order.every((at) => at >= 0)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
});

test("an older page that fails to load leaves the row for a retry", async () => {
  let fail = true;
  const pages = paged({ "": { items: [task(5)], next: "c2" }, c2: { items: [task(4)] } });
  const { app, calls } = await openConsole({
    location: CHAT,
    api: {
      "GET /proxy:/topics": TOPICS,
      "GET /proxy:/tasks": (request: ApiRequest) => {
        if (param(request, "cursor") && fail) return { status: 500, body: { error: "history store down" } };
        return pages(request);
      },
    },
  });
  await app.waitFor("text:Answer 5");
  await app.press("role:button[Load older messages]");
  await app.waitFor("text:history store down");
  // Idle again, the messages on screen kept.
  await app.waitFor("role:button[Load older messages]");
  expect(app.shows("text:Answer 5")).toBe(true);
  expect(olderRequests(calls).length).toBe(1);
  fail = false;
  await app.press("role:button[Load older messages]");
  await app.waitFor("text:Answer 4");
  await app.waitFor("id:chat-history-older", { state: "gone" });
  expect(olderRequests(calls).length).toBe(2);
});

type Frame = { x: number; y: number; w: number; h: number };
type RowReport = { frames: Record<"row" | "rule-start" | "button" | "rule-end", Frame>; loading: boolean; presses: number };

function rowReport(app: App): RowReport {
  return JSON.parse(app.texts().find((text) => text.startsWith('{"frames"')) ?? "{}") as RowReport;
}

const LONG_LABEL = "Load the older messages of this conversation from the history store";

for (const screen of [
  // The button's height: the console's 38pt command beside a pointer, the whole 44pt row on a phone.
  { name: "desktop", width: 1000, platform: "linux" as const, button: 38 },
  { name: "phone", width: 390, platform: "android" as const, button: 44 },
  { name: "small phone", width: 320, platform: "android" as const, button: 44 },
]) {
  const openRow = async () => {
    const app = await open("./fixtures/chat-history-older-app.tsx", { width: screen.width, height: 600, platform: screen.platform, locale: "en-US" });
    await app.waitUntil(() => Boolean(rowReport(app).frames?.["rule-end"]));
    return app;
  };

  test(`${screen.name}: the row spans the conversation's column, its button and rules on one centre line, the same idle and loading`, async () => {
    const app = await openRow();
    const idle = rowReport(app).frames;
    // The messages' column: at most 832pt, inside the 20pt gutters.
    expect(idle.row.w).toBe(Math.min(832, screen.width - 40));
    expect(idle.row.h).toBe(44);
    // The button itself is the target: a phone's is the row's whole height, no slop lent to it.
    expect(idle.button.h).toBe(screen.button);
    expect(idle.button.w).toBeGreaterThanOrEqual(44);
    const centre = idle.row.h / 2;
    expect(Math.abs(idle.button.y + idle.button.h / 2 - centre)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(idle.button.x + idle.button.w / 2 - idle.row.w / 2)).toBeLessThanOrEqual(0.5);
    for (const rule of [idle["rule-start"], idle["rule-end"]]) {
      expect(Math.abs(rule.y + rule.h / 2 - centre)).toBeLessThanOrEqual(0.5);
      expect(rule.w).toBeGreaterThan(40);
    }
    expect(idle["rule-start"].x).toBe(0);
    expect(idle["rule-end"].x + idle["rule-end"].w).toBe(idle.row.w);
    // The same room between each rule and the button.
    const gapStart = idle.button.x - (idle["rule-start"].x + idle["rule-start"].w);
    const gapEnd = idle["rule-end"].x - (idle.button.x + idle.button.w);
    expect(gapStart).toBe(8);
    expect(Math.abs(gapEnd - gapStart)).toBeLessThanOrEqual(1);
    // Loading: nothing moves, it says so, and presses do nothing.
    expect(app.shows("role:button[Loading older messages...]")).toBe(false);
    await app.press("role:button[Load older messages]");
    expect(rowReport(app).presses).toBe(1);
    await app.press("id:do-loading");
    await app.waitFor("role:button[Loading older messages...]");
    await app.waitFor("id:chat-history-load-older-loading");
    expect(app.shows("role:button[Load older messages]")).toBe(false);
    await app.press("id:chat-history-load-older").catch(() => {});
    const busy = rowReport(app);
    expect(busy.loading).toBe(true);
    expect(busy.presses).toBe(1);
    expect(busy.frames).toEqual(idle);
    // Idle again (a page landed, or failed to: the retry), it takes presses as before, where it was.
    await app.press("id:do-loading");
    await app.waitFor("role:button[Load older messages]");
    await app.waitFor("id:chat-history-load-older-loading", { state: "gone" });
    await app.press("role:button[Load older messages]");
    expect(rowReport(app).presses).toBe(2);
    expect(rowReport(app).frames).toEqual(idle);
  });

  test(`${screen.name}: a label too long for one line stays in the column, whole`, async () => {
    const app = await openRow();
    const short = rowReport(app).frames;
    await app.press("id:do-long");
    await app.waitUntil(() => rowReport(app).frames.button.w !== short.button.w);
    const long = rowReport(app).frames;
    expect(app.shows(`role:button[${LONG_LABEL}]`)).toBe(true);
    // Inside the column, a stub of each rule kept beside it, all on one centre line.
    expect(long.row.w).toBe(short.row.w);
    expect(long["rule-start"].x).toBe(0);
    expect(long["rule-start"].w).toBeGreaterThanOrEqual(16);
    expect(long["rule-end"].w).toBeGreaterThanOrEqual(16);
    expect(long["rule-end"].x + long["rule-end"].w).toBe(long.row.w);
    expect(long.button.x).toBeGreaterThanOrEqual(long["rule-start"].w);
    expect(long.button.x + long.button.w).toBeLessThanOrEqual(long["rule-end"].x);
    expect(Math.abs(long.button.y + long.button.h / 2 - long.row.h / 2)).toBeLessThanOrEqual(0.5);
    for (const rule of [long["rule-start"], long["rule-end"]]) expect(Math.abs(rule.y + rule.h / 2 - long.row.h / 2)).toBeLessThanOrEqual(0.5);
    if (long.button.w < short.row.w - 100) {
      // Room for it on one line: the row as it was.
      expect(long.row.h).toBe(44);
      expect(long.button.h).toBe(screen.button);
    } else {
      // It wraps, and the button and the row grow with its lines.
      expect(long.button.h).toBeGreaterThan(screen.button);
      expect(long.row.h).toBe(long.button.h);
    }
    // Still one command.
    await app.press(`role:button[${LONG_LABEL}]`);
    expect(rowReport(app).presses).toBe(1);
  });
}

test("the keyboard reaches the button and presses it; loading, it takes no key", async () => {
  const app = await open("./fixtures/chat-history-older-app.tsx", { width: 1000, height: 600, platform: "linux", locale: "en-US" });
  await app.waitUntil(() => Boolean(rowReport(app).frames?.["rule-end"]));
  // Third in the Tab order, after the fixture's two switches.
  for (let i = 0; i < 3; i++) await app.keyboard.press("tab");
  await app.keyboard.press("enter");
  await app.waitUntil(() => rowReport(app).presses === 1);
  expect(rowReport(app).loading).toBe(false);
  await app.keyboard.press("space");
  await app.waitUntil(() => rowReport(app).presses === 2);
  await app.press("id:do-loading");
  await app.waitFor("role:button[Loading older messages...]");
  await app.keyboard.press("enter");
  await app.keyboard.press("space");
  await app.wait(100);
  expect(rowReport(app).presses).toBe(2);
  expect(rowReport(app).loading).toBe(true);
});
