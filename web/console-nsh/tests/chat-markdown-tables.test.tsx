// A reply's tables (components/chat/ChatMarkdown.tsx) on phones: a table wider than the reply
// scrolls sideways inside its own scroll view, which is as wide as the box the reply is in (the
// page's column, a reply's body, a question card's row, a narrow panel, a list item), so nothing
// around it widens; the table keeps the same width in every box, its last columns and their links
// are reached by scrolling, and a vertical drag that starts on it still scrolls the page. Tables
// that fit have nothing to scroll and the same size on a phone and on a desktop.
// Fixture: tests/fixtures/markdown-tables-app.tsx; the last tests open the console's chat.
import { expect, open, test, type App } from "nsh/test";
import { CHAT_MARKDOWN_CLASSES } from "../components/chat/ChatMarkdown";
import { openConsole, type ApiRequest } from "./harness";

const FIXTURE = "./fixtures/markdown-tables-app.tsx";
// The fixture's column has 12pt of padding on each side; a reply leaves 10pt on its right.
const PAD = 12;
const SIDE_ROOM = 10;
// The question row's label (w-16) and gap (gap-2); the panel's 240pt and its 1pt border.
const LABEL = 64 + 8;
const PANEL = 240 - 2;

interface Frame {
  x: number;
  y: number;
  width: number;
  height: number;
}

function state(app: App): { offset: number; frames: Record<string, Frame> } {
  const text = app.texts().find((line) => line.startsWith('{"offset"'));
  if (!text) throw new Error("no report");
  return JSON.parse(text);
}

// Where the scroll view around `selector` is along its axis and how far it goes, as nsh/test says
// when a scroll step cannot move it ("… it is at 12 of 641").
async function stuck(app: App, selector: string, by: number): Promise<{ at: number; of: number } | null> {
  try {
    await app.scroll(selector, by);
    return null;
  } catch (error) {
    const match = /it is at (-?[\d.]+) of (-?[\d.]+)/.exec(String((error as Error)?.message ?? error));
    if (!match) throw error;
    return { at: Number(match[1]), of: Number(match[2]) };
  }
}

/** How far the table's scroll view around `selector` scrolls (0: it fits); leaves it at its start. */
async function extent(app: App, selector: string): Promise<number> {
  const first = await stuck(app, selector, 1200);
  if (first) return first.of;
  const end = await stuck(app, selector, 1);
  if (!end) throw new Error(`${selector} still scrolls after 1200pt`);
  await app.scroll(selector, -end.of);
  return end.of;
}

/** Whether the scroll view around `selector` is at its start (it cannot go back). */
async function atStart(app: App, selector: string) {
  const back = await stuck(app, selector, -1);
  if (back) return back.at === 0;
  // It moved back by one: put it where it was.
  await app.scroll(selector, 1);
  return false;
}

const near = (a: number, b: number, by = 1.5) => Math.abs(a - b) <= by;

async function openPhone(platform?: "android") {
  const app = await open(FIXTURE, { width: 390, height: 844, locale: "en-US", ...(platform ? { platform } : {}) });
  await app.waitUntil(() => {
    const frames = state(app).frames;
    return ["column", "page", "reply", "question", "panel", "list", "fit", "prose", "empty", "stream"].every((name) => name in frames);
  });
  return app;
}

for (const platform of [undefined, "android"] as const) {
  const on = platform ? " (Android app)" : " (phone browser)";

  test(`a wide table scrolls inside its own box at phone width; the boxes around it keep their width${on}`, async () => {
    const app = await openPhone(platform);
    const { frames } = state(app);
    const column = frames.column.width - 2 * PAD;
    expect(near(column, 390 - 2 * PAD)).toBe(true);
    // Nothing around a table grows to its width: each box is as wide as its place.
    expect(near(frames.page.width, column)).toBe(true);
    expect(near(frames.reply.width, column - SIDE_ROOM)).toBe(true);
    expect(near(frames.question.width, column)).toBe(true);
    expect(near(frames["panel-box"].width, 240)).toBe(true);
    expect(near(frames.list.width, column)).toBe(true);

    // Each table scrolls; its width (scroll view + how far it scrolls) is the same in every box,
    // so the cells keep their widths and the scroll view is the box's width.
    const page = await extent(app, "id:tables-page >> text:Service");
    const width = page + column;
    expect(page).toBeGreaterThan(200);
    const reply = await extent(app, "id:tables-reply >> text:Service");
    expect(near(width - reply, column - SIDE_ROOM)).toBe(true);
    const question = await extent(app, "id:tables-question >> text:Service");
    expect(near(width - question, column - LABEL)).toBe(true);
    const panel = await extent(app, "id:tables-panel >> text:Service");
    expect(near(width - panel, PANEL)).toBe(true);
    // In a list item, the item's indent narrows the scroll view, not the table.
    const list = await extent(app, "id:tables-list >> text:Service");
    expect(list).toBeGreaterThan(page);
    expect(width - list).toBeLessThan(column);
    expect(width - list).toBeGreaterThan(column - 48);
  });

  test(`the last columns and their links are reached by scrolling the table${on}`, async () => {
    const app = await openPhone(platform);
    const owner = "id:tables-reply >> text:platform team";
    expect(await atStart(app, owner)).toBe(true);
    await app.scroll(owner, 1200);
    expect(await atStart(app, owner)).toBe(false);
    await app.press(owner);
    await app.press("id:tables-reply >> text:search");
    expect(app.openedUrls()).toEqual(["https://example.com/platform", "https://example.com/search"]);
  });

  test(`a vertical drag on a table scrolls the page, a sideways one the table${on}`, async () => {
    const app = await openPhone(platform);
    const cell = "id:tables-page >> text:billing-worker";
    expect(state(app).offset).toBe(0);
    await app.drag(cell, { y: -200 });
    const scrolled = state(app).offset;
    expect(scrolled).toBeGreaterThan(100);
    expect(await atStart(app, cell)).toBe(true);
    await app.drag(cell, { x: -150 });
    expect(await atStart(app, cell)).toBe(false);
    expect(state(app).offset).toBe(scrolled);
  });

  test(`tables that fit have nothing to scroll; a streamed table scrolls once it outgrows the reply${on}`, async () => {
    const app = await openPhone(platform);
    const column = state(app).frames.column.width - 2 * PAD;
    expect(await extent(app, "id:tables-fit >> text:mode")).toBe(0);
    // Two columns of prose fit by wrapping the long cell.
    expect(await extent(app, "id:tables-prose >> text:retry")).toBe(0);
    // Empty Markdown takes no room.
    expect(state(app).frames.empty.height).toBe(0);

    expect(await extent(app, "id:tables-stream >> text:build")).toBe(0);
    await app.press("tables-grow");
    await app.waitFor("id:tables-stream >> text:/notify the release channel/");
    expect(await extent(app, "id:tables-stream >> text:build")).toBeGreaterThan(100);
    expect(near(state(app).frames.stream.width, column)).toBe(true);
  });
}

test("on a desktop a table as wide as the column fits, and in a reply's 736pt body it scrolls as before", async () => {
  const phone = await openPhone();
  const column = state(phone).frames.column.width - 2 * PAD;
  const width = (await extent(phone, "id:tables-page >> text:Service")) + column;
  const fit = state(phone).frames.fit;
  phone.dispose();

  const app = await open(FIXTURE, { width: 1280, height: 900, locale: "en-US" });
  await app.waitUntil(() => "fit" in state(app).frames && "reply" in state(app).frames);
  expect(await extent(app, "id:tables-page >> text:Service")).toBe(0);
  expect(near(state(app).frames.reply.width, 736)).toBe(true);
  const reply = await extent(app, "id:tables-reply >> text:Service");
  expect(near(reply + 736, width)).toBe(true);
  // A table that fits is the same on a phone and a desktop.
  expect(await extent(app, "id:tables-fit >> text:mode")).toBe(0);
  expect(state(app).frames.fit.height).toBe(fit.height);
});

test("the frame's right line is drawn by the rows, at the cells' end, not by the scroll view", () => {
  // A table cut by the reply's edge shows open cells there (more to scroll to); the frame closes at
  // the cells' end. The table as wide as its cells, at most the text's width.
  expect(CHAT_MARKDOWN_CLASSES.table.split(" ")).toEqual(["max-w-full", "self-start"]);
  expect(CHAT_MARKDOWN_CLASSES.tableRow.split(" ")).toContain("border-r");
});

const NOW = new Date().toISOString();
const REPLY = [
  "Here is the status:",
  "",
  "| Service | Region | Status | Latency p50 | Latency p99 | Owner | Notes |",
  "| --- | --- | --- | ---: | ---: | --- | --- |",
  "| api-gateway | us-east-1 | Running | 12 ms | 180 ms | [platform team](https://example.com/platform) | Rolled out on Tuesday |",
  "| billing-worker | eu-west-2 | Degraded | 40 ms | 1200 ms | payments | Queue backlog after the migration |",
  "",
  "And a small one:",
  "",
  "| Key | Value |",
  "| --- | --- |",
  "| mode | fit |",
].join("\n");
const TASK = {
  id: "t1",
  task: "Show the status",
  topic_id: "topic-1",
  created_at: NOW,
  started_at: NOW,
  finished_at: NOW,
  status: "done",
  result: { final: { output: REPLY } },
};
const API = {
  "GET /proxy:/topics": { body: { items: [{ id: "topic-1", title: "Ops", created_at: NOW, updated_at: NOW }] } },
  "GET /proxy:/tasks": (request: ApiRequest) => ({ body: { items: request.uri?.includes("topic_id=topic-1") ? [TASK] : [] } }),
};

for (const platform of [undefined, "android"] as const) {
  test(`in the chat on a phone, a reply's wide table scrolls inside the reply and its links open${platform ? " (Android app)" : ""}`, async () => {
    const { app } = await openConsole({ location: "/e/default/chat/topic-1", api: API, width: 390, height: 844, ...(platform ? { platform } : {}) });
    await app.waitFor("id:chat-item-agent >> text:Here is the status:");
    const wide = "id:chat-item-agent >> text:Service";
    expect(await extent(app, wide)).toBeGreaterThan(200);
    expect(await extent(app, "id:chat-item-agent >> text:mode")).toBe(0);
    await app.scroll(wide, 1200);
    await app.press("id:chat-item-agent >> text:platform team");
    expect(app.openedUrls()).toEqual(["https://example.com/platform"]);
  });
}
