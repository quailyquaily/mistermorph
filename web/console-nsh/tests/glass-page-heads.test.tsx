// The heads of the Topics list, Contacts, Settings and Usage as glass (components/frame/glassBar.tsx),
// on the real pages, on a phone and a desktop: where the window draws glass each page's scroller is
// pulled up under its head by exactly the head's height and its content starts with that much room,
// so the list runs on behind the head and its first row lies where it lay without glass. Where the
// window draws none (no `backdrop-filter`, "reduce transparency", Android before 12, the desktop
// app: tests/glass-surfaces.test.tsx has the policy) the scroller starts at the head's foot, as it
// always did. Headless nsh has no frame or style query: each scroller's content start is reported
// by its `BarRoom` (tests/barRoomConsole.tsx, `barRooms(app)`), with glass the room itself, without
// a mark of no height in its place. The look of the glass (tint, blur) is tests/glass-surfaces.test.tsx.
import type { App } from "nsh/test";
import { expect, test } from "nsh/test";
import { barRooms, openConsole, type BarRoomReport } from "./harness";

const NOW = new Date().toISOString();
const TOPICS = { body: { items: Array.from({ length: 40 }, (_, i) => ({ id: `topic-${i + 1}`, title: `Topic ${i + 1}`, tags: ["food"], created_at: NOW, updated_at: NOW })) } };
const CONTACTS = {
  body: {
    items: Array.from({ length: 40 }, (_, i) => ({ contact_id: `tg:${1000 + i}`, nickname: `Person ${i + 1}`, kind: "human", channel: "telegram", tg_username: `person${i + 1}`, status: "active" })),
  },
};
const USAGE = { body: { summary: { requests: 3, input_tokens: 2000, total_cost: 2, cost_currency: "USD" }, models: [], days: [] } };
const API = { "GET /proxy:/topics": TOPICS, "GET /proxy:/contacts/list": CONTACTS, "GET /proxy:/stats/llm/usage": USAGE };
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };
type Form = "phone" | "desktop";
const PAGES = ["topics", "contacts", "settings", "stats"] as const;
type PageName = (typeof PAGES)[number];
/** What shows once each page's list is there. */
const READY: Record<PageName, string> = { topics: "id:chat-topic-topic-40", contacts: "Person 1", settings: "id:settings-search", stats: "id:stats-hero" };
const HEAD = 57;

async function goTo(app: App, form: Form, page: PageName, ready: string = READY[page]) {
  if (page !== "topics") {
    if (form === "desktop") await app.press(`id:nav-${page}`);
    else if (page === "contacts") await app.press("id:mobile-nav-contacts");
    else {
      await app.press("id:mobile-nav-more");
      await app.press(`id:mobile-more-${page}`);
    }
  }
  await app.waitFor(ready);
}

/** Opens the console at the Topics list and visits the four pages: where each one's list starts under its head. */
async function tour(form: Form, glass: boolean, api: Record<string, unknown> = API, ready: Partial<Record<PageName, string>> = {}) {
  const { app } = await openConsole({ ...(form === "phone" ? PHONE : DESKTOP), glass, barRooms: true, location: "/e/default/chat", api: api as never });
  const rooms = barRooms(app);
  const found = {} as Record<PageName, BarRoomReport>;
  for (const page of PAGES) {
    // The Topics list is up as the console opens: its report may be there already.
    if (page !== "topics") rooms.mark();
    await goTo(app, form, page, ready[page]);
    // The page's own list: the one report that settles (Settings' head grows by its search as it is measured).
    await app.waitUntil(() => rooms.last() !== null);
    await app.wait(300);
    found[page] = rooms.last()!;
  }
  return { app, rooms, found };
}

const near = (a: number, b: number) => Math.abs(a - b) < 0.5;

for (const form of ["phone", "desktop"] as const) {
  test(`${form}, glass: the Topics, Contacts, Settings and Usage lists run on under their heads, and start where they did`, async () => {
    const opaque = await tour(form, false);
    const glass = await tour(form, true);
    for (const page of PAGES) {
      const off = opaque.found[page];
      const on = glass.found[page];
      // Without glass: no room, and the list starts at the head's foot.
      expect(off.room).toBe(0);
      expect(off.h).toBe(0);
      // With glass the content starts with the head's room, exactly as tall as the head...
      expect(on.room).toBeGreaterThanOrEqual(HEAD);
      expect(near(on.h, on.room)).toBe(true);
      // ... at the head's own top: the scroller is pulled up by the head's height, no more, no less,
      expect(near(on.y + on.h, off.y)).toBe(true);
      // so the first row is where it was, and as wide.
      expect(near(on.x, off.x)).toBe(true);
      expect(near(on.w, off.w)).toBe(true);
    }
    // The page heads are the 57pt bar; Settings' takes its search with it (one bar over the list).
    for (const page of ["topics", "contacts", "stats"] as const) expect(glass.found[page].room).toBe(HEAD);
    expect(glass.found.settings.room).toBeGreaterThan(HEAD + 30);
    // Every head starts at the same top of the page, and a list's column is at least a phone's row wide.
    for (const page of PAGES) {
      expect(near(glass.found[page].y, glass.found.topics.y)).toBe(true);
      expect(near(opaque.found[page].y - opaque.found.topics.y, glass.found[page].room - HEAD)).toBe(true);
      expect(glass.found[page].w).toBeGreaterThan(300);
    }
  });
}

test("glass: each of the four pages has one room, of its head, and a window without glass has none", async () => {
  for (const form of ["phone", "desktop"] as const) {
    for (const glass of [true, false]) {
      const { app, found } = await tour(form, glass);
      // The last page of the tour (Usage) is up: its room alone is drawn.
      expect(app.count("id:bar-room-57")).toBe(glass ? 1 : 0);
      expect(found.stats.room).toBe(glass ? HEAD : 0);
      app.dispose();
    }
  }
});

test("desktop, glass: the heads' controls work over a scrolled list", async () => {
  const { app } = await openConsole({ ...DESKTOP, glass: true, barRooms: true, location: "/e/default/chat", api: API });
  // Topics: scrolled, the rows pass under the head; its view toggle and New still take presses.
  await app.waitFor(READY.topics);
  await app.scroll("id:chat-topic-list", 400);
  await app.press("id:chat-topics-view-tags");
  await app.waitFor("id:chat-topic-group-tag:food");
  await app.press("id:chat-topics-view-tags");
  expect(app.shows("id:chat-topic-new")).toBe(true);
  // Contacts: the kind tabs in the head.
  await goTo(app, "desktop", "contacts");
  await app.scroll("id:contacts-list", 400);
  await app.press("id:contacts-tab-agent");
  await app.waitFor("id:contacts-tab-agent-selected");
  await app.waitFor("id:contacts-empty");
  await app.press("id:contacts-tab-human");
  await app.waitFor("Person 1");
  // Settings: the search under the head is part of the bar, and still takes text.
  await goTo(app, "desktop", "settings");
  await app.scroll("id:settings-index", 200);
  await app.type("id:settings-search", "zzzz-nothing");
  expect(app.value("id:settings-search")).toBe("zzzz-nothing");
  expect(app.count("id:bar-room-57")).toBe(0);
  // Usage: the page's bar keeps its title over the scrolled body.
  await goTo(app, "desktop", "stats");
  await app.scroll("id:stats-hero", 300);
  expect(app.shows("id:stats-page")).toBe(true);
  expect(app.count("id:bar-room-57")).toBe(1);
});

test("phone, glass: empty and failed lists start under their heads' room, readable below the head", async () => {
  const api = {
    "GET /proxy:/topics": TOPICS,
    "GET /proxy:/contacts/list": { body: { items: [] } },
    // No stub for the usage: the page's request fails.
  };
  const empty = await tour("phone", true, api, { contacts: "id:contacts-empty", stats: "id:stats-page" });
  // Contacts with nobody: the note lies in the list, after the head's room.
  expect(empty.found.contacts.room).toBe(HEAD);
  expect(near(empty.found.contacts.y, empty.found.topics.y)).toBe(true);
  // Usage that failed to load: the page is up with its room all the same.
  expect(empty.found.stats.room).toBe(HEAD);
  expect(empty.app.shows("id:stats-page")).toBe(true);
  empty.app.dispose();

  const failed = await openConsole({ ...PHONE, glass: true, barRooms: true, location: "/e/default/contacts", api: { "GET /proxy:/contacts/list": { status: 500, body: { error: "boom" } } } });
  const rooms = barRooms(failed.app);
  await failed.app.waitFor("id:contacts-error");
  await failed.app.waitUntil(() => rooms.last() !== null);
  expect(rooms.last()!.room).toBe(HEAD);
  expect(failed.app.shows("id:contacts-error")).toBe(true);
});
