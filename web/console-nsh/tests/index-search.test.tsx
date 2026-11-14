// The search under the head of Topics, Contacts and Settings is one field (IndexSearch in
// components/knowledge/parts.tsx): the same type, magnifier, clear button, size, gutters and place
// under the 57pt head on all three pages, on a desktop and on a phone, whatever the list shows.
import { expect, open, test } from "nsh/test";
import { openConsole } from "./harness";

type Frame = { x: number; y: number; w: number; h: number };
type Readout = { frames: Record<string, Frame>; metrics: { gutter: number; top: number; bottom: number; size: string } };

const NOW = new Date().toISOString();
const TOPICS = [{ id: "topic-1", title: "Trip plans", created_at: NOW, updated_at: NOW }];
const ALICE = { contact_id: "tg:1001", nickname: "Alice", kind: "human", channel: "telegram", tg_username: "alice", status: "active" };

const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 800, field: 38, gutter: 16, size: "sm" },
  { name: "phone", width: 390, height: 844, field: 44, gutter: 12, size: "md" },
] as const;

const PAGES = [
  {
    name: "Topics",
    location: "/e/default/chat",
    search: "chat-topics-search",
    placeholder: "Search topics",
    api: { "GET /proxy:/topics": { body: { items: TOPICS } }, "GET /proxy:/tasks": { body: { items: [] } } },
  },
  {
    name: "Contacts",
    location: "/e/default/contacts",
    search: "contacts-filter",
    placeholder: "Quick filter",
    api: { "GET /proxy:/contacts/list": { body: { items: [ALICE] } } },
  },
  {
    name: "Settings",
    location: "/e/default/settings",
    search: "settings-search",
    placeholder: "Search settings",
    api: {
      "GET /proxy:/persona/identity": {
        body: { exists: true, identity: { name: "Morph", name_alts: [], creature: "", vibe: "", emoji: "", soul: "# Soul", extra: {} } },
      },
      "GET /proxy/download:/persona/avatar": { status: 404, body: { error: "not found" } },
    },
  },
] as const;

for (const viewport of VIEWPORTS) {
  for (const page of PAGES) {
    test(`${page.name} on a ${viewport.name}: the shared index search, with its clear button and Escape`, async () => {
      const { app } = await openConsole({ location: page.location, width: viewport.width, height: viewport.height, api: page.api });
      await app.waitFor(`id:${page.search}-box`);
      // The placeholder is the accessible name; no field of its own beside the shared one.
      expect(app.count(`id:${page.search}`)).toBe(1);
      expect(app.shows(`text:${page.placeholder}`)).toBe(true);
      expect(app.shows(`id:${page.search}-clear`)).toBe(false);
      await app.type(`id:${page.search}`, "zz");
      // Clear empties it.
      await app.waitFor(`id:${page.search}-clear`);
      await app.press(`id:${page.search}-clear`);
      await app.waitUntil(() => app.value(`id:${page.search}`) === "");
      await app.waitFor(`id:${page.search}-clear`, { state: "gone" });
      // Escape empties it while it has the focus.
      await app.type(`id:${page.search}`, "zz");
      await app.keyboard.press("escape");
      await app.waitUntil(() => app.value(`id:${page.search}`) === "");
    });
  }

  test(`on a ${viewport.name} the search box sits under the 57pt head, as wide as the column, its field ${viewport.field}pt tall`, async () => {
    const app = await open("./fixtures/index-search-app.tsx", { width: viewport.width, height: viewport.height, platform: "linux", locale: "en-US" });
    const readout = () => JSON.parse(app.texts().find((text) => text.startsWith("{")) ?? "{}") as Readout;
    await app.waitUntil(() => Boolean(readout().frames?.search && readout().frames?.column));
    const { frames, metrics } = readout();
    expect(metrics).toEqual({ gutter: viewport.gutter, top: 6, bottom: 2, size: viewport.size });
    // More room above the field than below it (6pt, 2pt): the same 8pt in all.
    expect(metrics.top).toBeGreaterThan(metrics.bottom);
    expect(metrics.top + metrics.bottom).toBe(8);
    // Directly under the head, with no box of IndexColumn's `top` around it.
    expect(frames.search.x).toBe(0);
    expect(frames.search.y).toBe(57);
    expect(frames.search.w).toBe(frames.column.w);
    expect(frames.column.w).toBe(viewport.name === "phone" ? viewport.width : 310);
    // 6pt, the field, then 2pt below it: the box keeps its height.
    expect(Math.abs(frames.search.h - (viewport.field + 8))).toBeLessThan(0.5);
  });
}

test("both searches show while their lists load", async () => {
  // On a manual clock the lists answer only once the test moves the clock past their delay. Topics
  // on a phone: the desktop sidebar comes only with the first topics.
  const topics = await openConsole({
    location: "/e/default/chat",
    width: 390,
    height: 844,
    clock: true,
    api: { "GET /proxy:/topics": { body: { items: TOPICS }, delay: 2000 }, "GET /proxy:/tasks": { body: { items: [] } } },
  });
  await topics.app.waitFor("id:chat-topics-search-box", { timeout: 500 });
  expect(topics.app.shows("id:chat-topic-topic-1")).toBe(false);
  await topics.app.waitFor("id:chat-topic-topic-1");
  const contacts = await openConsole({
    location: "/e/default/contacts",
    clock: true,
    api: { "GET /proxy:/contacts/list": { body: { items: [ALICE] }, delay: 2000 } },
  });
  await contacts.app.waitFor("id:contacts-filter-box", { timeout: 500 });
  expect(contacts.app.shows("id:contact-row:tg:1001")).toBe(false);
  await contacts.app.waitFor("id:contact-row:tg:1001");
});

test("Contacts' search stays above a failed list and an empty one", async () => {
  const failed = await openConsole({
    location: "/e/default/contacts",
    api: { "GET /proxy:/contacts/list": { status: 500, body: { error: "contacts unavailable" } } },
  });
  await failed.app.waitFor("id:contacts-error");
  expect(failed.app.shows("id:contacts-filter-box")).toBe(true);
  const empty = await openConsole({ location: "/e/default/contacts", api: { "GET /proxy:/contacts/list": { body: { items: [] } } } });
  await empty.app.waitFor("id:contacts-empty");
  expect(empty.app.shows("id:contacts-filter-box")).toBe(true);
});
