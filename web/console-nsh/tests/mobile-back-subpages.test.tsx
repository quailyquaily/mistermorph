// On a phone only a page below another has a back action: its bar's back arrow, and on Android the
// system's Back (the back button, or the edge swipe gesture navigation turns into the same event),
// which the app takes only while a page registers what its arrow does (lib/systemBack.ts). The
// page hierarchy decides, never the history:
// - a navigation page's own list (Topics, Contacts, TODO, Memories, Skills, Stats, Audit,
//   Settings' sections) has no back arrow and takes no Back, also after other pages were opened
//   before it: there Back is the system's, which leaves the app;
// - a page below one (an open item, the skill store, Logs) has both, and they go to its parent,
//   also when the app opened on it with nothing before it;
// - back on the list both are gone at once, while the page or the pane left still slides out.
// Sheets and dialogs still close first, wide windows have no phone arrows, and on the web nothing
// listens to Back (the browser's own stays the browser's): tests/android.test.tsx. The bottom
// navigation follows the same hierarchy: tests/mobile-nav-roots.test.tsx.
import type { App } from "nsh/test";
import { expect, test } from "nsh/test";
import { MOBILE_LOCATION_KEY, openConsole, type ApiHandler } from "./harness";

const NOW = new Date().toISOString();
const EMPTY = { body: { items: [] } };
const TOPICS = { body: { items: [{ id: "topic-1", title: "Ops", created_at: NOW, updated_at: NOW }] } };
const ALICE = { contact_id: "tg:1001", nickname: "Alice", kind: "human", channel: "telegram", status: "active" };
const STORE = {
  repo: "morph/skills",
  skills: [{ id: "weather", name: "Weather", description: "Forecasts", version: "1.0.0", tags: ["util"], files: [] }],
};
const API: Record<string, ApiHandler> = {
  "GET /proxy:/tasks": EMPTY,
  "GET /proxy:/topics": TOPICS,
  "GET /proxy:/contacts/list": { body: { items: [ALICE] } },
  "GET /proxy:/memories": { body: { items: [] } },
  "GET /proxy:/audit/files": { body: { default_file: "guard_audit.jsonl", items: [{ name: "guard_audit.jsonl" }] } },
  "GET /proxy:/audit/logs": { body: { exists: true, items: [] } },
  "GET /proxy:/logs/latest": { body: { file: "/state/logs/morph.jsonl", has_next: false, items: [] } },
  "GET /settings/agent/skills/store": { body: STORE },
  "GET /settings/agent/skills/detail": { body: { content: "# Weather skill\n", revision: "doc-1" } },
  "GET /settings/agent/skills": {
    body: {
      enabled: true,
      load: [],
      roots: ["/home/me/.morph/skills"],
      config_revision: "rev-1",
      skills: [{ id: "weather", name: "Weather", description: "Forecasts", dir: "/home/me/.morph/skills/weather", loaded: true, files: [] }],
    },
  },
};

/** Every page's back arrow (a page bar's; the context inspector's shows on wide windows too). */
const BACK_ARROWS = ["chat-back", "mobile-back", "todo-back", "settings-back", "audit-ledger-back", "store-back", "logs-back", "context-back"];
const NAV = "id:mobile-bottom-nav";

/** Where the phone app is: the location it saves for its next launch. */
const location = (app: App) => String(app.storage()[MOBILE_LOCATION_KEY] || "");
/** The last location the app wrote to the address bar (the web). */
function lastLocation(app: App) {
  const writes = app.host.calls().filter((call) => call.name === "morph.history");
  return String((writes.at(-1)?.data as any)?.url || "");
}

async function openPhone(where: string, options: { android?: boolean; slowSlides?: boolean; width?: number } = {}) {
  const android = options.android ?? true;
  const { app } = await openConsole({
    location: where,
    width: options.width ?? 390,
    height: 844,
    ...(android ? { platform: "android" as const } : {}),
    ...(options.slowSlides ? { slowSlides: true } : {}),
    api: API,
  });
  return app;
}

/** Back with nothing in the app to take it: the system's own back, which leaves the app. */
async function expectSystemBack(app: App) {
  await expect(app.back()).rejects.toMatchObject({ code: "ERR_NSH_TEST_NO_BACK" });
}

const arrows = (app: App) => BACK_ARROWS.filter((id) => app.count(`id:${id}`) > 0);

/** A navigation page's own list: no back arrow, and Back is not the app's. */
async function expectRoot(app: App, android = true) {
  await app.waitFor(NAV);
  await app.waitUntil(() => arrows(app).length === 0);
  if (android) await expectSystemBack(app);
  // Refusing Back changed nothing.
  expect(arrows(app)).toEqual([]);
  expect(app.count(NAV)).toBe(1);
}

/** Opens a navigation page from the bottom navigation (its bar, or More). */
async function openTab(app: App, page: string, android = true) {
  if (app.count(`id:mobile-nav-${page}`) > 0) {
    await app.press(`id:mobile-nav-${page}`);
  } else {
    await app.press("id:mobile-nav-more");
    await app.waitFor(`id:mobile-more-${page}`);
    await app.press(`id:mobile-more-${page}`);
  }
  const path = `/e/default/${page}`;
  await app.waitUntil(() => (android ? location(app) : lastLocation(app)) === path);
  await app.waitFor("id:mobile-more", { state: "gone" });
}

const ROOT_PAGES: [page: string, shows: string][] = [
  ["contacts", "id:contacts-index"],
  ["memories", "id:memories-index"],
  ["skills", "id:skills-index"],
  ["stats", "id:stats-page"],
  ["audit", "id:audit-index"],
  ["settings", "id:settings-index"],
  ["chat", "id:chat-topic-sidebar"],
  ["todo", "id:todo-page"],
];

test("navigation pages reached from one another take no Back and show no back arrow, whatever the history", async () => {
  const app = await openPhone("/e/default/todo");
  await app.waitFor("id:todo-page");
  await expectRoot(app);
  // Each one is opened over the ones before it: the run's history grows, the answer stays.
  for (const [page, shows] of ROOT_PAGES) {
    await openTab(app, page);
    await app.waitFor(shows);
    await expectRoot(app);
    expect(location(app)).toBe(`/e/default/${page}`);
  }
});

test("in a narrow web window navigation pages show no back arrow after switching between them", async () => {
  const app = await openPhone("/e/default/todo", { android: false });
  await app.waitFor("id:todo-page");
  await expectRoot(app, false);
  for (const [page, shows] of ROOT_PAGES) {
    await openTab(app, page, false);
    await app.waitFor(shows);
    await expectRoot(app, false);
  }
  // Nothing listens to Back on the web: the browser's own button stays the browser's.
  await expectSystemBack(app);
});

test("an item opened on a page reached from another has both; back on the list both are gone", async () => {
  const app = await openPhone("/e/default/todo");
  await app.waitFor("id:todo-page");
  await openTab(app, "contacts");
  await app.waitFor("id:contact-row:tg:1001");
  await expectRoot(app);

  // The contact: its arrow shows and Back does what the arrow does.
  await app.press("id:contact-row:tg:1001");
  await app.waitFor("id:contact-detail");
  await app.waitFor("id:mobile-back");
  await app.back();
  await app.waitFor("id:contacts-index");
  await app.waitFor("id:mobile-back", { state: "gone" });
  // On the list again, TODO still before it in the history: Back is the system's.
  expect(location(app)).toBe("/e/default/contacts");
  await expectRoot(app);

  // The arrow itself leaves the same way.
  await app.press("id:contact-row:tg:1001");
  await app.waitFor("id:mobile-back");
  await app.press("id:mobile-back");
  await app.waitFor("id:mobile-back", { state: "gone" });
  await expectRoot(app);

  // A topic, a settings section: the same on other pages of the navigation.
  await openTab(app, "chat");
  await app.waitFor("id:chat-topic-sidebar");
  await app.press("id:chat-topic-topic-1");
  await app.waitFor("id:chat-back");
  await app.back();
  await app.waitFor("id:chat-back", { state: "gone" });
  await app.waitUntil(() => location(app) === "/e/default/chat");
  await expectRoot(app);

  await openTab(app, "settings");
  await app.waitFor("id:settings-section-system");
  await app.press("id:settings-section-system");
  await app.waitFor("id:settings-back");
  await app.back();
  await app.waitFor("id:settings-back", { state: "gone" });
  await app.waitUntil(() => location(app) === "/e/default/settings");
  // The page before Settings (Chat) is not where Back goes: Settings' sections are a root.
  await expectRoot(app);
});

test("the skill store is a page below Skills: Back and its arrow open Skills, also when the app opened on it", async () => {
  // Opened on the store: nothing before it in this run.
  const app = await openPhone("/e/default/skills/store");
  await app.waitFor("id:store-page");
  await app.waitFor("id:store-back");
  expect(app.count(NAV)).toBe(0);
  await app.back();
  await app.waitFor("id:skills-index");
  await app.waitUntil(() => location(app) === "/e/default/skills");
  await app.waitFor("id:store-page", { state: "gone" });
  await expectRoot(app);

  // Opened from Skills: back to it by Back, then by the arrow; the store is left behind each time.
  for (const leave of ["back", "arrow"]) {
    await app.press("id:skills-store");
    await app.waitUntil(() => location(app) === "/e/default/skills/store");
    await app.waitFor("id:store-back");
    if (leave === "back") await app.back();
    else await app.press("id:store-back");
    await app.waitUntil(() => location(app) === "/e/default/skills");
    await app.waitFor("id:store-page", { state: "gone" });
    await expectRoot(app);
  }
});

test("Logs is a page below Settings: Back and its arrow open the System section, also when the app opened on it", async () => {
  const app = await openPhone("/e/default/logs");
  await app.waitFor("id:logs-page");
  await app.waitFor("id:logs-back");
  expect(app.count(NAV)).toBe(0);
  await app.back();
  // Its parent is the section that opens it, itself a level below the sections.
  await app.waitUntil(() => location(app) === "/e/default/settings/system");
  await app.waitFor("id:settings-open-logs");
  await app.waitFor("id:logs-page", { state: "gone" });
  await app.waitFor("id:settings-back");
  expect(app.count(NAV)).toBe(0);

  // From the section and back by the arrow, then up to the sections: a root again.
  await app.press("id:settings-open-logs");
  await app.waitUntil(() => location(app) === "/e/default/logs");
  await app.waitFor("id:logs-back");
  await app.press("id:logs-back");
  await app.waitUntil(() => location(app) === "/e/default/settings/system");
  await app.waitFor("id:logs-page", { state: "gone" });
  await app.back();
  await app.waitFor("id:settings-index");
  await app.waitFor("id:settings-back", { state: "gone" });
  await expectRoot(app);
});

test("in a narrow web window Logs leads with the back arrow to Settings; a wide window has none", async () => {
  const phone = await openPhone("/e/default/logs", { android: false });
  await phone.waitFor("id:logs-page");
  await phone.waitFor("id:logs-back");
  await phone.waitFor("role:header[Logs]");
  // Nothing of the app's takes Back there.
  await expectSystemBack(phone);
  await phone.press("id:logs-back");
  await phone.waitUntil(() => lastLocation(phone) === "/e/default/settings/system");
  await phone.waitFor("id:settings-open-logs");
  // A navigation like any other on the web: the browser's history keeps Logs.
  const write = phone.host.calls().filter((call) => call.name === "morph.history").at(-1);
  expect((write?.data as any)?.op).toBe("push");

  const wide = await openPhone("/e/default/logs", { android: false, width: 1280 });
  await wide.waitFor("id:logs-page");
  await wide.waitFor("role:header[Logs]");
  expect(wide.count("id:logs-back")).toBe(0);
});

test("a wide Android window has no phone arrows: Logs shows none and takes no Back", async () => {
  const app = await openPhone("/e/default/logs", { width: 1280 });
  await app.waitFor("id:logs-page");
  expect(app.count("id:logs-back")).toBe(0);
  await expectSystemBack(app);
});

test("Back is gone at once on the list a page below it returned to, while that page still slides out", async () => {
  const app = await openPhone("/e/default/skills/store", { slowSlides: true });
  await app.waitFor("id:store-back");
  await app.back();
  await app.waitUntil(() => location(app) === "/e/default/skills");
  await app.waitFor("id:skills-index");
  // The store, with its arrow, is still on its way out: it no longer takes Back, and Skills,
  // a root, never does.
  expect(app.count("id:page-layer-out")).toBe(1);
  expect(app.count("id:store-page")).toBe(1);
  await expectSystemBack(app);
  expect(location(app)).toBe("/e/default/skills");

  // A resize ends the slide (as a rotation would): the store and its arrow are gone.
  await app.setViewport(390, 843);
  await app.waitFor("id:store-page", { state: "gone" });
  await expectRoot(app);
});
