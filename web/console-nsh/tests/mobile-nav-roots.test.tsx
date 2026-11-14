// The phone's bottom navigation shows on the navigation's own pages only (lib/shell.ts
// `mobileBottomNavVisible`): a page's list (Contacts, TODO, Memories, Skills, Audit, Settings'
// sections, Chat's topics) has it; an item opened in place of the list (a contact, a subject, a
// task, a skill, a log, a settings section) and a page below the navigation (an open topic, Logs,
// the skill store, an address that matches no page) do not, whether opened by a press, by an
// address, or by going back in the history; back on the list it shows again. While it is gone its
// room at the foot of the page goes too, and on Android the foot of the page's column keeps the page
// above the gesture handle instead (`frame-foot-<pt>`, components/Shell.tsx; the frame's own bottom
// padding, `app-frame.bottom-<pt>`, stays 0 on phones). Wide windows have no bottom navigation. The chat's new topic is in tests/chat-new-topic-nav.test.tsx.
import type { App } from "nsh/test";
import { expect, test } from "nsh/test";
import type { Route } from "../lib/router";
import { isMobileNavRoot } from "../lib/shell";
import { MOBILE_LOCATION_KEY, openConsole, type ApiHandler } from "./harness";

const NOW = new Date().toISOString();
const EMPTY = { body: { items: [] } };
const TOPICS = { body: { items: [{ id: "topic-1", title: "Ops", created_at: NOW, updated_at: NOW }] } };
const QUIET = { "GET /proxy:/todo/tasks": EMPTY, "GET /proxy:/tasks": EMPTY, "GET /proxy:/topics": TOPICS };
/** A phone with gesture navigation: a 24pt status bar, a 16pt gesture handle. */
const BARS = { top: 24, right: 0, bottom: 16, left: 0 };

const ALICE = { contact_id: "tg:1001", nickname: "Alice", kind: "human", channel: "telegram", status: "active" };
const CONTACTS = {
  "GET /proxy:/contacts/list": { body: { items: [ALICE] } },
  "GET /proxy:/memories": { body: { items: [] } },
};
const MEMORIES = {
  "GET /proxy:/contacts/list": { body: { items: [{ contact_id: "tg:2", nickname: "Bob" }] } },
  "GET /proxy:/memories": {
    body: {
      items: [
        { id: "m1", name: "bob-job", subject: "contact:tg:2", type: "person", visibility: "private", description: "Bob is a pilot", body: "Flies cargo.", updated_at: NOW },
      ],
    },
  },
};
const SKILLS = {
  "GET /settings/agent/skills/store": { status: 404, body: { error: "not found" } },
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
const TODO = {
  "GET /proxy:/todo/tasks": {
    body: {
      tasks: [{ id: "task-1", title: "Report", content: "Write it", cron: "15 9 * * 1", tz: "UTC" }],
      system_tasks: [{ id: "__heartbeat__", cron: "*/30 * * * *" }],
      chat_options: [],
      llm_profiles: [],
      heartbeat_enabled: true,
      runs: [],
    },
  },
  "GET /proxy:/todo/runs": { body: { runs: [] } },
  "GET /proxy:/heartbeat/workflows": { body: { items: [] } },
};
const AUDIT = {
  "GET /proxy:/audit/files": { body: { default_file: "guard_audit.jsonl", items: [{ name: "guard_audit.jsonl" }, { name: "guard_audit.deny.jsonl" }] } },
  "GET /proxy:/audit/logs": { body: { exists: true, items: [] } },
};

const NAV = "id:mobile-bottom-nav";
const location = (app: App) => String(app.storage()[MOBILE_LOCATION_KEY] || "");
/** The last location the app wrote to the address bar. */
function lastLocation(app: App) {
  const writes = app.host.calls().filter((call) => call.name === "morph.history");
  return String((writes.at(-1)?.data as any)?.url || "");
}

/** A narrow web window, or the Android phone with its system bars. */
async function openPhone(where: string, api: Record<string, ApiHandler>, android = false) {
  const { app } = await openConsole({
    location: where,
    width: 390,
    height: 844,
    ...(android ? { platform: "android" as const, safeArea: BARS } : {}),
    api: { ...QUIET, ...api },
  });
  return app;
}

/** The bottom navigation shows, with its room at the foot of the page; on Android it draws under the handle. */
async function expectNav(app: App, android = false) {
  await app.waitFor(NAV);
  if (android) await app.waitFor("id:app-frame.bottom-0");
  if (android) await app.waitUntil(() => app.count("id:frame-foot-16") === 0);
}
/** No bottom navigation: on Android the column's foot keeps the page above the gesture handle. */
async function expectNoNav(app: App, android = false) {
  await app.waitFor(NAV, { state: "gone" });
  expect(app.count("id:mobile-nav-more")).toBe(0);
  if (android) await app.waitFor("id:frame-foot-16");
  if (android) expect(app.count("id:app-frame.bottom-0")).toBe(1);
}

function route(path: string, meta: Route["meta"] = {}, page: Route["page"] = "contacts") {
  return { path, meta, page };
}

test("the navigation's own pages are roots; pages below them and unknown addresses are not", () => {
  for (const path of ["/e/default/chat", "/e/default/contacts", "/e/default/todo", "/e/default/memories", "/e/default/skills", "/e/default/stats", "/e/default/audit", "/e/default/settings", "/e/ep_remote/contacts", "/e/default/todo/"]) {
    expect(isMobileNavRoot(route(path))).toBe(true);
  }
  for (const path of ["/e/default/chat/topic-1", "/e/default/chat/topic-1/context", "/e/default/skills/store", "/e/default/logs", "/e/default/contacts/x", "/overview", "/login", "/"]) {
    expect(isMobileNavRoot(route(path))).toBe(false);
  }
  // Meta overrides the address: an open topic never is; Settings' section address is the
  // Settings page, whose open section (not its address) hides the navigation.
  expect(isMobileNavRoot(route("/e/default/chat/topic-1", { endpointScoped: true, mobileBottomNav: false }, "chat"))).toBe(false);
  expect(isMobileNavRoot(route("/e/default/settings/persona", { endpointScoped: true, mobileBottomNav: true }, "settings"))).toBe(true);
  // An address that matches no page, even one under a navigation page's address, and no route.
  expect(isMobileNavRoot(route("/e/default/contacts", {}, "notFound"))).toBe(false);
  expect(isMobileNavRoot(null)).toBe(false);
});

for (const android of [false, true]) {
  const where = android ? "the Android phone" : "a narrow web window";

  test(`on ${where} the contacts list has the bottom navigation and a contact does not`, async () => {
    const app = await openPhone("/e/default/contacts", CONTACTS, android);
    await app.waitFor("id:contact-row:tg:1001");
    await expectNav(app, android);
    await app.press("id:contact-row:tg:1001");
    await app.waitFor("id:contact-detail");
    await expectNoNav(app, android);
    // No room kept at the foot of the contact for a bar that is not there.
    expect(app.count("id:contact-detail-bar-room")).toBe(0);
    if (android) await app.back();
    else await app.press("id:mobile-back");
    await app.waitFor("id:contacts-index");
    await expectNav(app, android);
    expect(location(app) || lastLocation(app)).toBe("/e/default/contacts");
    // Again: opening and closing never leaves the navigation hidden.
    await app.press("id:contact-row:tg:1001");
    await expectNoNav(app, android);
    await app.press("id:mobile-back");
    await expectNav(app, android);
    await app.press("id:mobile-nav-todo");
    await app.waitFor("id:todo-page");
    await expectNav(app, android);
  });

  test(`on ${where} an open settings section hides the bottom navigation, also when its address opened it`, async () => {
    const app = await openPhone("/e/default/settings", {}, android);
    await app.waitFor("id:settings-index");
    await expectNav(app, android);
    await app.press("id:settings-section-system");
    await app.waitFor("id:settings-open-logs");
    await expectNoNav(app, android);
    // A page below Settings (Logs) has none either; back in the history, the section still has none.
    await app.press("id:settings-open-logs");
    await app.waitFor("id:logs-page");
    await expectNoNav(app, android);
    if (android) await app.back();
    else await app.host.send("morph.pop", { location: "/e/default/settings/system" });
    await app.waitFor("id:settings-open-logs");
    await app.waitFor("id:logs-page", { state: "gone" });
    await expectNoNav(app, android);
    await app.press("id:settings-back");
    await app.waitFor("id:settings-index");
    await expectNav(app, android);
  });
}

test("a section opened by its address has no bottom navigation; its back arrow shows the sections with it", async () => {
  const app = await openPhone("/e/default/settings/system", {}, true);
  await app.waitFor("id:settings-open-logs");
  await expectNoNav(app, true);
  await app.press("id:settings-back");
  await app.waitFor("id:settings-index");
  // Nothing before the section in this run: the sections show under the section's address.
  expect(location(app)).toBe("/e/default/settings/system");
  await expectNav(app, true);
});

test("a memories subject (opened by its address too) has no bottom navigation; the index has it", async () => {
  const app = await openPhone("/e/default/memories?subject=contact:tg:2", MEMORIES);
  await app.waitFor("text:Bob is a pilot");
  await expectNoNav(app);
  await app.press("id:mobile-back");
  await app.waitFor("id:memories-index");
  await expectNav(app);
});

test("a skill named by the address has no bottom navigation; a name the list lacks shows the list with it", async () => {
  const app = await openPhone("/e/default/skills?skill=weather", SKILLS);
  await app.waitFor("text:Weather skill");
  await expectNoNav(app);
  await app.press("id:mobile-back");
  await app.waitFor("id:skills-index");
  await expectNav(app);
  await app.press("id:skill-row:weather");
  await app.waitFor("text:Weather skill");
  await expectNoNav(app);

  const missing = await openPhone("/e/default/skills?skill=nope", SKILLS);
  await missing.waitFor("id:skill-row:weather");
  await expectNav(missing);
});

test("the skill store, an open topic, its context and an unknown address have no bottom navigation", async () => {
  const store = await openPhone("/e/default/skills/store", SKILLS);
  await store.waitFor("id:store-page");
  await expectNoNav(store);
  await store.press("id:store-back");
  await store.waitFor("id:skills-index");
  await expectNav(store);

  const topic = await openPhone("/e/default/chat/topic-1", {}, true);
  await topic.waitFor("id:chat-composer-input");
  await expectNoNav(topic, true);
  await topic.back();
  await topic.waitFor("id:chat-topic-topic-1");
  await expectNav(topic, true);

  const context = await openPhone("/e/default/chat/topic-1/context", {});
  await context.waitFor("id:context-page");
  await expectNoNav(context);

  const unknown = await openPhone("/e/default/nowhere", {});
  await unknown.waitUntil(() => unknown.texts().includes("/e/default/nowhere"));
  await expectNoNav(unknown);
});

test("an open task hides the bottom navigation; back on the list it shows", async () => {
  const app = await openPhone("/e/default/todo", TODO);
  await app.waitFor("id:todo-item-task-1");
  await expectNav(app);
  await app.press("id:todo-item-task-1");
  await app.waitFor("id:todo-task-editor");
  await expectNoNav(app);
  await app.press("id:todo-back");
  await app.waitFor("id:todo-index");
  await expectNav(app);
});

test("an open audit log hides the bottom navigation; Android's Back to the files shows it", async () => {
  const app = await openPhone("/e/default/audit", AUDIT, true);
  await app.waitFor("id:audit-file-guard_audit.deny.jsonl");
  await expectNav(app, true);
  await app.press("id:audit-file-guard_audit.deny.jsonl");
  await expectNoNav(app, true);
  await app.back();
  await app.waitFor("id:audit-file-guard_audit.deny.jsonl");
  await expectNav(app, true);
});

test("a contact open when the window narrows to a phone: the list comes back, with the navigation", async () => {
  const { app } = await openConsole({ location: "/e/default/contacts", api: { ...QUIET, ...CONTACTS } });
  await app.waitFor("id:contact-row:tg:1001");
  await app.press("id:contact-row:tg:1001");
  await app.waitFor("id:contact-detail");
  // The desktop: the sidebar, never the bottom navigation, with an item open or not.
  expect(app.shows("id:sidebar")).toBe(true);
  expect(app.count(NAV)).toBe(0);
  await app.setViewport(390, 844);
  await app.waitFor("id:contacts-index");
  await expectNav(app);
  await app.press("id:contact-row:tg:1001");
  await expectNoNav(app);
  await app.setViewport(1280, 800);
  await app.waitFor("id:sidebar");
  expect(app.count(NAV)).toBe(0);
});
