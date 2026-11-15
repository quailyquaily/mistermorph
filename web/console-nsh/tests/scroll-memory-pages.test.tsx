// Remembered scroll positions on the console's own pages (lib/scrollMemory.ts): switching pages in
// the sidebar, or in a phone's bottom navigation, and coming back finds a page's list (column 2)
// and what is open beside it (column 3) where they were left. Each page keeps its own; the
// conversation is restored by the message that was at the top of the view, for the same topic
// only, and is left at its newest message when it was there; another item in column 2 starts
// column 3 at the top; nothing is written to storage, the host or the server.
// The helper's own cases (late and shorter content, agents, readiness) are in
// tests/scroll-memory.test.tsx. The console reports its areas through tests/scrollProbeConsole.tsx.
import type { App } from "nsh/test";
import { expect, test } from "nsh/test";
import { LOCAL_REF, openConsole, scrollProbe, type ApiRequest } from "./harness";

const NOW = new Date().toISOString();
const EMPTY = { body: { items: [] } };
const topic = (id: string, title: string) => ({ id, title, created_at: NOW, updated_at: NOW });
const TOPICS = Array.from({ length: 60 }, (_, i) => topic(`topic-${i + 1}`, `Topic ${i + 1}`));
const task = (i: number, topicID: string) => ({
  id: `${topicID}-t${i}`,
  task: `Question ${i}`,
  topic_id: topicID,
  status: "done",
  created_at: NOW,
  started_at: NOW,
  finished_at: NOW,
  result: { final: { output: `Answer ${i}. ${"More words of the answer. ".repeat(60)}` } },
});
const CONTACTS = Array.from({ length: 80 }, (_, i) => ({
  contact_id: `tg:${1000 + i}`,
  nickname: `Person ${i + 1}`,
  kind: "human",
  channel: "telegram",
  tg_username: `person${i + 1}`,
  status: "active",
}));
const api = {
  "GET /proxy:/topics": { body: { items: TOPICS } },
  "GET /proxy:/tasks": (request: ApiRequest) => {
    const id = /topic_id=([^&]+)/.exec(request.uri ?? "")?.[1];
    return id ? { body: { items: Array.from({ length: 30 }, (_, i) => task(30 - i, id)) } } : EMPTY;
  },
  "GET /proxy:/todo/tasks": EMPTY,
  "GET /proxy:/contacts/list": () => ({ body: { items: CONTACTS } }),
  "GET /proxy:/memories": EMPTY,
};
const key = (page: string, column: number, area: string) => `${page}|${LOCAL_REF}|${column}|${area}`;

/**
 * Waits for what the probe reports. Its posts reach the test without a change of the app, which is
 * what `app.waitUntil` looks again after: this looks again every 50 ms.
 */
async function until(app: App, condition: () => boolean, timeout = 5000) {
  for (let waited = 0; waited < timeout && !condition(); waited += 50) await app.wait(50);
  expect(condition()).toBe(true);
}

const TOPICS_AREA = key("chat", 2, "topics");
const HISTORY_AREA = key("chat", 3, "history");
const LIBRARY_AREA = key("contacts", 2, "library");
const SECTION_AREA = key("settings", 3, "section");

/** Scrolls the conversation up from its newest message, and waits until its place is remembered. */
async function scrollHistoryUp(app: App, probe: ReturnType<typeof scrollProbe>, by: number) {
  // Headless, the list reports its opening scroll to the end only with the next one.
  await app.scroll("id:chat-history", -5);
  await app.scroll("id:chat-history", -by);
  await app.wait(300);
  const saved = (await probe.saved())[HISTORY_AREA];
  expect(saved?.anchor?.id).toBeTruthy();
  return saved;
}

test("in the sidebar, Topics and Contacts each come back where they were left: the lists and the conversation", async () => {
  const { app } = await openConsole({ location: "/e/default/chat/topic-3", api, scrollProbe: true });
  const probe = scrollProbe(app);
  await app.waitFor("id:chat-topic-topic-3");
  await app.waitFor("id:chat-history");
  await app.scroll("id:chat-topic-list", 500);
  await until(app, () => probe.live(TOPICS_AREA) === 500);
  const place = await scrollHistoryUp(app, probe, 900);
  expect(place.selection).toBe("topic-3");

  // Contacts, never opened: its library starts at the top.
  await app.press("id:nav-contacts");
  await app.waitFor("text:Person 1");
  await app.wait(300);
  expect(probe.live(LIBRARY_AREA) ?? 0).toBe(0);
  await app.scroll("id:contacts-index", 400);
  await until(app, () => probe.live(LIBRARY_AREA) === 400);

  // Back to Topics: the list where it was, and the conversation at the same message.
  probe.mark();
  await app.press("id:nav-chat");
  await app.waitFor("id:chat-topic-list");
  await until(app, () => probe.live(TOPICS_AREA) === 500);
  await app.waitFor("id:chat-history");
  await app.wait(600);
  // The reader's place again: a scroll of a point and back makes the headless list report it.
  await app.scroll("id:chat-history", -1);
  await app.scroll("id:chat-history", 1);
  await app.wait(300);
  const back = (await probe.saved())[HISTORY_AREA];
  expect(back.selection).toBe("topic-3");
  expect(back.anchor?.id).toBe(place.anchor?.id);
  expect(Math.abs((back.anchor?.offset ?? 0) - (place.anchor?.offset ?? 0))).toBeLessThan(2);

  // And Contacts kept its own.
  probe.mark();
  await app.press("id:nav-contacts");
  await app.waitFor("text:Person 20");
  await until(app, () => probe.live(LIBRARY_AREA) === 400);
  const all = await probe.saved();
  expect(all[TOPICS_AREA].y).toBe(500);
  expect(all[LIBRARY_AREA].y).toBe(400);
});

test("a conversation left at its newest message opens there again, and another topic forgets the place", async () => {
  const { app } = await openConsole({ location: "/e/default/chat/topic-3", api, scrollProbe: true });
  const probe = scrollProbe(app);
  await app.waitFor("id:chat-history");
  await app.waitFor("text:Question 1");
  // At the end: nothing to remember.
  await app.scroll("id:chat-history", -5);
  await app.scroll("id:chat-history", 5);
  await app.wait(300);
  expect((await probe.saved())[HISTORY_AREA]).toBe(undefined);
  await app.press("id:nav-contacts");
  await app.waitFor("text:Person 1");
  await app.press("id:nav-chat");
  await app.waitFor("id:chat-history");
  await app.waitFor("text:Question 1");
  await app.wait(400);
  expect((await probe.saved())[HISTORY_AREA]).toBe(undefined);

  // Scrolled up, then another topic: its conversation opens at its end, and the place is gone.
  await scrollHistoryUp(app, probe, 900);
  await app.press("id:chat-topic-topic-2");
  await app.waitUntil(() => app.requests().some((request) => request.url.includes("topic-2")));
  await app.waitFor("id:chat-history");
  await app.wait(500);
  expect((await probe.saved())[HISTORY_AREA]).toBe(undefined);
  // Back on the first topic: its end, not the old place.
  await app.press("id:chat-topic-topic-3");
  await app.waitFor("id:chat-history");
  await app.wait(500);
  expect(app.texts().some((text) => text.startsWith("Question 1"))).toBe(true);
  expect((await probe.saved())[HISTORY_AREA]).toBe(undefined);
});

test("a settings section comes back where it was, and another section starts at the top", async () => {
  const { app } = await openConsole({ location: "/e/default/settings", api, scrollProbe: true });
  const probe = scrollProbe(app);
  await app.waitFor("id:settings-persona");
  await app.wait(300);
  await app.scroll("id:settings-persona", 150);
  await until(app, () => probe.live(SECTION_AREA) === 150);
  expect((await probe.saved())[SECTION_AREA]).toEqual({ y: 150, selection: "persona" });

  probe.mark();
  await app.press("id:nav-contacts");
  await app.waitFor("id:contacts-index");
  await app.press("id:nav-settings");
  await app.waitFor("id:settings-persona");
  await until(app, () => probe.live(SECTION_AREA) === 150);

  // Another section: the top, and nothing kept for the one before.
  probe.mark();
  await app.press("id:settings-section-security");
  await until(app, () => probe.live(SECTION_AREA) === 0);
  expect((await probe.saved())[SECTION_AREA]).toBe(undefined);
  await app.press("id:settings-section-persona");
  await app.waitFor("id:settings-persona");
  await app.wait(300);
  expect(probe.live(SECTION_AREA)).toBe(0);
});

test("on a phone, the bottom navigation brings Topics and Contacts back where they were", async () => {
  const { app } = await openConsole({ platform: "android", location: "/e/default/chat", api, scrollProbe: true });
  const probe = scrollProbe(app);
  await app.waitFor("id:chat-topic-topic-1");
  await app.scroll("id:chat-topic-list", 700);
  await until(app, () => probe.live(TOPICS_AREA) === 700);
  await app.press("id:mobile-nav-contacts");
  await app.waitFor("text:Person 1");
  await app.wait(400);
  expect(probe.live(LIBRARY_AREA) ?? 0).toBe(0);
  await app.scroll("id:contacts-index", 900);
  await until(app, () => probe.live(LIBRARY_AREA) === 900);

  probe.mark();
  await app.press("id:mobile-nav-chat");
  await app.waitFor("id:chat-topic-list");
  await until(app, () => probe.live(TOPICS_AREA) === 700);
  probe.mark();
  await app.press("id:mobile-nav-contacts");
  await app.waitFor("id:contacts-index");
  await until(app, () => probe.live(LIBRARY_AREA) === 900);
});

test("the places are kept in memory only: no storage, no host call, no request; the console opened again starts at the top", async () => {
  const opened = await openConsole({ location: "/e/default/chat", api, scrollProbe: true });
  const app = opened.app;
  const probe = scrollProbe(app);
  await app.waitFor("id:chat-topic-topic-1");
  await app.wait(300);
  const stored = JSON.stringify(app.storage());
  const kept = () => app.host.calls().concat(app.host.posts()).filter((message) => !message.name.startsWith("morph.fixture."));
  const hostBefore = kept().length;
  const requestsBefore = opened.calls.length;
  await app.scroll("id:chat-topic-list", 500);
  await until(app, () => probe.live(TOPICS_AREA) === 500);
  await app.wait(300);
  expect((await probe.saved())[TOPICS_AREA].y).toBe(500);
  // Scrolling wrote nothing anywhere.
  expect(JSON.stringify(app.storage())).toBe(stored);
  expect(kept().length).toBe(hostBefore);
  expect(opened.calls.length).toBe(requestsBefore);
  expect(JSON.stringify(kept())).not.toContain("|2|topics");

  // A reload: the same saved values handed to a new console.
  const again = await openConsole({ location: "/e/default/chat", api, scrollProbe: true, kv: app.storage() });
  const fresh = scrollProbe(again.app);
  await again.app.waitFor("id:chat-topic-topic-1");
  await again.app.wait(600);
  expect(await fresh.saved()).toEqual({});
  expect(fresh.live(TOPICS_AREA) ?? 0).toBe(0);
});
