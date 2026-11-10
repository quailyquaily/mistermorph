// The Topics and Contacts searches on a touch phone: hidden until the list is pulled down from its
// top (components/shared/pullSearch.ts), then at the top of the list; on a desktop (and a
// desktop's window narrowed to the phone layout) they always show, at the top of the list too
// (tests/desktop-index-search.test.tsx).
import type { App } from "nsh/test";
import { expect, test } from "nsh/test";
import { openConsole, type ApiRequest } from "./harness";

const NOW = new Date().toISOString();
const EMPTY = { body: { items: [] } };

function topic(id: string, title: string) {
  return { id, title, created_at: NOW, updated_at: NOW };
}
const TOPICS = [topic("topic-1", "Trip plans"), topic("topic-2", "Recipes")];
/** Enough topics that the phone's list scrolls well past a screen. */
const MANY = Array.from({ length: 40 }, (_, i) => topic(`topic-${i + 1}`, `Topic ${i + 1}`));

function chatApi(topics: unknown[]) {
  return {
    "GET /proxy:/topics": { body: { items: topics } },
    "GET /proxy:/tasks": (request: ApiRequest) =>
      request.uri?.includes("topic_id=topic-1")
        ? { body: { items: [{ id: "t1", task: "Where to go?", topic_id: "topic-1", status: "done", created_at: NOW, started_at: NOW, finished_at: NOW, result: { final: { output: "Try Lisbon." } } }] } }
        : EMPTY,
    "GET /proxy:/todo/tasks": EMPTY,
  };
}

const ALICE = { contact_id: "tg:1001", nickname: "Alice", kind: "human", channel: "telegram", tg_username: "alice", status: "active" };
const BOB = { contact_id: "tg:1002", nickname: "Bob", kind: "human", channel: "telegram", tg_username: "bob", status: "active" };
function contactsApi(items: unknown[]) {
  return { "GET /proxy:/contacts/list": () => ({ body: { items } }), "GET /proxy:/memories": EMPTY };
}

/** A deliberate pull: well past the reveal distance once rubber-banded. */
const PULL = { x: 0, y: 220 };

/** Whether a key typed lands in the field (it has the focus: the keyboard is up). */
async function focused(app: App, selector: string) {
  const before = app.value(selector) ?? "";
  await app.keyboard.press("`");
  const after = app.value(selector) ?? "";
  if (after === before) return false;
  await app.keyboard.press("backspace");
  await app.waitUntil(() => app.value(selector) === before);
  return true;
}

async function openPhoneTopics(topics: unknown[] = TOPICS, location = "/e/default/chat") {
  const { app } = await openConsole({ platform: "android", location, api: chatApi(topics) });
  await app.waitFor("id:chat-topic-list");
  return app;
}

test("on a phone the topic search is hidden, and a pull down from the list's top shows it without the keyboard", async () => {
  const app = await openPhoneTopics();
  await app.waitFor("id:chat-topic-topic-1");
  expect(app.shows("id:chat-topics-search")).toBe(false);
  // The head keeps its view toggles and the list its New button.
  expect(app.shows("id:chat-topics-view-cron")).toBe(true);
  expect(app.shows("id:chat-topics-view-tags")).toBe(true);
  expect(app.shows("id:chat-topic-new-fab")).toBe(true);

  await app.drag("id:chat-topic-list", PULL);
  await app.waitFor("id:chat-topics-search");
  expect(app.value("id:chat-topics-search")).toBe("");
  expect(await focused(app, "id:chat-topics-search")).toBe(false);
  // The field is the list's: it is inside the scroll view, not the head.
  expect(app.shows("id:chat-topic-list >> id:chat-topics-search")).toBe(true);
  expect(app.shows("id:chat-topics-view-cron")).toBe(true);
  expect(app.shows("id:chat-topic-new-fab")).toBe(true);

  // A tap focuses it; it filters as on a desktop, and its clear button empties it but keeps it.
  await app.type("id:chat-topics-search", "trip");
  await app.waitFor("id:chat-topic-topic-2", { state: "gone" });
  expect(app.shows("id:chat-topic-topic-1")).toBe(true);
  await app.press("id:chat-topics-search-clear");
  await app.waitFor("id:chat-topic-topic-2");
  expect(app.shows("id:chat-topics-search")).toBe(true);
});

test("on a phone sideways, upward and short drags of the topic list leave the search hidden", async () => {
  const app = await openPhoneTopics();
  await app.waitFor("id:chat-topic-topic-1");
  await app.drag("id:chat-topic-list", { x: 220, y: 0 });
  await app.drag("id:chat-topic-list", { x: -200, y: 40 });
  await app.drag("id:chat-topic-list", { x: 0, y: -200 });
  // Pulled a little and let go: cancelled.
  await app.drag("id:chat-topic-list", { x: 0, y: 30 });
  await app.wait(50);
  expect(app.shows("id:chat-topics-search")).toBe(false);
  // The rows still take presses.
  await app.press("id:chat-topic-topic-1");
  await app.waitFor("text:Try Lisbon.");
});

test("on a phone scrolling back up to the top does not show the topic search; a new pull from the top does", async () => {
  const app = await openPhoneTopics(MANY);
  await app.waitFor("id:chat-topic-topic-1");
  await app.scroll("id:chat-topic-list", 600);
  // One drag back past the top: it began lower down, so it only scrolls.
  await app.drag("id:chat-topic-list", { x: 0, y: 1200 });
  await app.wait(50);
  expect(app.shows("id:chat-topics-search")).toBe(false);
  // Scrolled down and back up by ordinary scrolling: the list works as before.
  await app.scroll("id:chat-topic-list", 400);
  await app.scroll("id:chat-topic-list", -400);
  await app.waitFor("id:chat-topic-topic-1");
  expect(app.shows("id:chat-topics-search")).toBe(false);
  await app.drag("id:chat-topic-list", PULL);
  await app.waitFor("id:chat-topics-search");
});

test("on a phone an empty topic list (no TODO runs) can be pulled for the search too", async () => {
  const app = await openPhoneTopics();
  await app.press("id:chat-topics-view-cron");
  await app.waitFor("id:chat-topic-topic-1", { state: "gone" });
  expect(app.shows("id:chat-topics-search")).toBe(false);
  await app.drag("id:chat-topic-list", PULL);
  await app.waitFor("id:chat-topics-search");
});

test("on a phone the topic search and its query stay while the page lives, through a topic and a rotation", async () => {
  const app = await openPhoneTopics();
  await app.drag("id:chat-topic-list", PULL);
  await app.type("id:chat-topics-search", "trip");
  await app.waitFor("id:chat-topic-topic-2", { state: "gone" });
  await app.press("id:chat-topic-topic-1");
  await app.waitFor("text:Try Lisbon.");
  await app.back();
  await app.waitFor("id:chat-topic-list");
  expect(app.value("id:chat-topics-search")).toBe("trip");
  expect(app.shows("id:chat-topic-topic-2")).toBe(false);
  // Wide (a tablet's landscape): the desktop layout, the one search at the list's top with its query.
  await app.setViewport(1280, 800);
  await app.waitFor("id:chat-topic-sidebar");
  expect(app.value("id:chat-topics-search")).toBe("trip");
  expect(app.count("id:chat-topics-search")).toBe(1);
  expect(app.shows("id:chat-topic-list >> id:chat-topics-search")).toBe(true);
  await app.setViewport(390, 844);
  await app.waitFor("id:chat-topic-list");
  expect(app.value("id:chat-topics-search")).toBe("trip");
  // Emptied, the field stays for the page's life.
  await app.press("id:chat-topics-search-clear");
  await app.waitFor("id:chat-topic-topic-2");
  expect(app.shows("id:chat-topics-search")).toBe(true);
});

test("on a desktop the topic search shows at once at the list's top, also in a window narrowed to the phone layout", async () => {
  const wide = await openConsole({ location: "/e/default/chat", api: chatApi(TOPICS) });
  await wide.app.waitFor("id:chat-topic-topic-1");
  expect(wide.app.shows("id:chat-topics-search")).toBe(true);
  expect(wide.app.shows("id:chat-topic-list >> id:chat-topics-search")).toBe(true);

  const narrow = await openConsole({ location: "/e/default/chat", width: 390, height: 844, api: chatApi(TOPICS) });
  await narrow.app.waitFor("id:chat-topic-topic-1");
  expect(narrow.app.shows("id:chat-topics-search")).toBe(true);
});

async function openPhoneContacts(api: Record<string, unknown>) {
  const { app } = await openConsole({ platform: "android", location: "/e/default/contacts", api: api as any });
  await app.waitFor("id:contacts-list");
  return app;
}

test("on a phone the contacts filter is hidden, and a pull down from the list's top shows it at the list's head", async () => {
  const app = await openPhoneContacts(contactsApi([ALICE, BOB]));
  await app.waitFor("id:contact-row:tg:1001");
  expect(app.shows("id:contacts-filter")).toBe(false);
  // Sideways, upward and short drags do not show it.
  await app.drag("id:contacts-list", { x: 220, y: 0 });
  await app.drag("id:contacts-list", { x: 0, y: -200 });
  await app.drag("id:contacts-list", { x: 0, y: 30 });
  await app.wait(50);
  expect(app.shows("id:contacts-filter")).toBe(false);

  await app.drag("id:contacts-list", PULL);
  await app.waitFor("id:contacts-filter");
  expect(app.shows("id:contacts-list >> id:contacts-filter")).toBe(true);
  expect(await focused(app, "id:contacts-filter")).toBe(false);

  // Filtering down to nothing and back keeps the one field, focused, with its text.
  await app.type("id:contacts-filter", "zzz");
  await app.waitFor("text:No matching contacts");
  expect(await focused(app, "id:contacts-filter")).toBe(true);
  await app.keyboard.press("backspace");
  await app.keyboard.press("backspace");
  await app.keyboard.press("backspace");
  await app.waitFor("id:contact-row:tg:1002");
  await app.type("id:contacts-filter", "bob");
  await app.waitFor("id:contact-row:tg:1001", { state: "gone" });
  expect(app.shows("id:contact-row:tg:1002")).toBe(true);
  await app.press("id:contacts-filter-clear");
  await app.waitFor("id:contact-row:tg:1001");
  expect(app.shows("id:contacts-filter")).toBe(true);
});

test("on a phone the contacts filter stays with its query after a contact's card", async () => {
  const app = await openPhoneContacts(contactsApi([ALICE, BOB]));
  await app.drag("id:contacts-list", PULL);
  await app.type("id:contacts-filter", "ali");
  await app.waitFor("id:contact-row:tg:1002", { state: "gone" });
  await app.press("id:contact-row:tg:1001");
  await app.waitFor("id:contact-detail");
  await app.press("id:mobile-back");
  await app.waitFor("id:contacts-list");
  expect(app.value("id:contacts-filter")).toBe("ali");
  expect(app.shows("id:contact-row:tg:1002")).toBe(false);
});

test("on a phone an empty or failed contacts list can be pulled for the filter", async () => {
  const empty = await openPhoneContacts(contactsApi([]));
  await empty.waitFor("text:No contacts");
  expect(empty.shows("id:contacts-filter")).toBe(false);
  await empty.drag("id:contacts-list", PULL);
  await empty.waitFor("id:contacts-filter");
  expect(empty.shows("text:No contacts")).toBe(true);

  const broken = await openPhoneContacts({ "GET /proxy:/contacts/list": { status: 500, body: { error: "contacts unavailable" } } });
  await broken.waitFor("text:contacts unavailable");
  expect(broken.shows("id:contacts-filter")).toBe(false);
  await broken.drag("id:contacts-list", PULL);
  await broken.waitFor("id:contacts-filter");
  expect(broken.shows("text:contacts unavailable")).toBe(true);
});

test("on a desktop the contacts filter shows at once at the list's top, also in a window narrowed to the phone layout", async () => {
  const wide = await openConsole({ location: "/e/default/contacts", api: contactsApi([ALICE]) as any });
  await wide.app.waitFor("id:contact-row:tg:1001");
  expect(wide.app.shows("id:contacts-filter")).toBe(true);
  expect(wide.app.shows("id:contacts-list >> id:contacts-filter")).toBe(true);

  const narrow = await openConsole({ location: "/e/default/contacts", width: 420, api: contactsApi([ALICE]) as any });
  await narrow.app.waitFor("id:contact-row:tg:1001");
  expect(narrow.app.shows("id:contacts-filter")).toBe(true);
});
