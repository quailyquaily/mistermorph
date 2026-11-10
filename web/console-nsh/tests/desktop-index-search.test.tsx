// The Topics and Contacts searches on a desktop: one field, the list's first view (it scrolls with
// the list), never in the head, which keeps the title and its buttons. It filters, clears and
// takes Escape as before, stays while the list loads, fails or is empty, and keeps its query (and
// stays one) as the window crosses the mobile breakpoint and back. (Contacts' loading state cannot
// be held headless: its filter heads the list whatever the store's state, as the error shows.)
import { expect, open, test } from "nsh/test";
import { openConsole, type ApiRequest } from "./harness";

const NOW = new Date().toISOString();
const EMPTY = { body: { items: [] } };

function topic(id: string, title: string) {
  return { id, title, created_at: NOW, updated_at: NOW };
}
const TOPICS = [topic("topic-1", "Trip plans"), topic("topic-2", "Recipes")];

function chatApi(topics: unknown) {
  return {
    "GET /proxy:/topics": typeof topics === "function" ? topics : { body: { items: topics } },
    "GET /proxy:/tasks": (_request: ApiRequest) => EMPTY,
    "GET /proxy:/todo/tasks": EMPTY,
  } as Record<string, any>;
}

const ALICE = { contact_id: "tg:1001", nickname: "Alice", kind: "human", channel: "telegram", tg_username: "alice", status: "active" };
const BOB = { contact_id: "tg:1002", nickname: "Bob", kind: "human", channel: "telegram", tg_username: "bob", status: "active" };
function contactsApi(list: unknown) {
  return {
    "GET /proxy:/contacts/list": typeof list === "function" ? list : () => ({ body: { items: list } }),
    "GET /proxy:/memories": EMPTY,
  } as Record<string, any>;
}

test("on a desktop the topic search is the list's one field, not the head's, and filters, clears and takes Escape", async () => {
  const { app } = await openConsole({ location: "/e/default/chat", api: chatApi(TOPICS) });
  await app.waitFor("id:chat-topic-topic-1");
  expect(app.count("id:chat-topics-search")).toBe(1);
  expect(app.shows("id:chat-topic-list >> id:chat-topics-search")).toBe(true);
  // The head keeps its title and buttons.
  expect(app.shows("id:chat-topics-title")).toBe(true);
  expect(app.shows("id:chat-topics-view-cron")).toBe(true);
  expect(app.shows("id:chat-topics-view-tags")).toBe(true);
  expect(app.shows("id:chat-topic-new")).toBe(true);

  await app.type("id:chat-topics-search", "trip");
  await app.waitFor("id:chat-topic-topic-2", { state: "gone" });
  expect(app.shows("id:chat-topic-topic-1")).toBe(true);
  await app.press("id:chat-topics-search-clear");
  await app.waitFor("id:chat-topic-topic-2");
  await app.type("id:chat-topics-search", "rec");
  await app.waitFor("id:chat-topic-topic-1", { state: "gone" });
  await app.keyboard.press("escape");
  await app.waitUntil(() => app.value("id:chat-topics-search") === "");
  await app.waitFor("id:chat-topic-topic-1");
  expect(app.count("id:chat-topics-search")).toBe(1);
});

test("on a desktop the topic search shows while the topics load (its spinner under it) and in a view with none", async () => {
  // A pending request stops every step of the console's harness: the real sidebar on a stand-in
  // controller holds the loading state instead.
  const app = await open("./fixtures/topic-sidebar-search-app.tsx", { width: 1280, height: 800, platform: "linux", locale: "en-US", reducedMotion: true });
  await app.waitFor("id:chat-topic-list >> id:chat-topics-search");
  expect(app.count("id:chat-topics-search")).toBe(1);
  expect(app.shows("id:chat-topic-list >> id:chat-topics-loading")).toBe(true);
  await app.type("id:chat-topics-search", "trip");
  await app.press("id:fixture-loaded");
  await app.waitFor("id:chat-topic-topic-1");
  expect(app.shows("id:chat-topics-loading")).toBe(false);
  expect(app.shows("id:chat-topic-topic-2")).toBe(false);
  expect(app.value("id:chat-topics-search")).toBe("trip");
  expect(app.count("id:chat-topics-search")).toBe(1);
  // Loading again (no rows), then the phone layout of a desktop's window: the same one field.
  await app.press("id:fixture-reload");
  await app.waitFor("id:chat-topic-topic-1", { state: "gone" });
  expect(app.shows("id:chat-topic-list >> id:chat-topics-search")).toBe(true);
  await app.press("id:fixture-mobile");
  expect(app.count("id:chat-topics-search")).toBe(1);
  expect(app.value("id:chat-topics-search")).toBe("trip");

  // A view with no topics (no TODO runs) keeps it; a console with no topics at all shows no topic
  // list (and so no search) on a desktop, as before.
  const empty = await openConsole({ location: "/e/default/chat", api: chatApi(TOPICS) });
  await empty.app.waitFor("id:chat-topic-topic-1");
  await empty.app.press("id:chat-topics-view-cron");
  await empty.app.waitFor("id:chat-topic-topic-1", { state: "gone" });
  expect(empty.app.shows("id:chat-topic-list >> id:chat-topics-search")).toBe(true);
  expect(empty.app.count("id:chat-topics-search")).toBe(1);
});

test("on a desktop the topic search keeps its query and stays one field across the mobile breakpoint", async () => {
  const { app } = await openConsole({ location: "/e/default/chat", api: chatApi(TOPICS) });
  await app.waitFor("id:chat-topic-topic-1");
  await app.type("id:chat-topics-search", "trip");
  await app.waitFor("id:chat-topic-topic-2", { state: "gone" });
  for (const [width, height] of [[420, 800], [1280, 800], [900, 700], [1280, 800]]) {
    await app.setViewport(width, height);
    await app.waitFor("id:chat-topic-list >> id:chat-topics-search");
    expect(app.count("id:chat-topics-search")).toBe(1);
    expect(app.value("id:chat-topics-search")).toBe("trip");
    expect(app.shows("id:chat-topic-topic-2")).toBe(false);
  }
});

test("on a desktop the contacts filter is the list's one field, not the head's, and filters, clears and takes Escape", async () => {
  const { app } = await openConsole({ location: "/e/default/contacts", api: contactsApi([ALICE, BOB]) });
  await app.waitFor("id:contact-row:tg:1001");
  expect(app.count("id:contacts-filter")).toBe(1);
  expect(app.shows("id:contacts-list >> id:contacts-filter")).toBe(true);
  expect(app.shows("id:contacts-index >> text:Contacts")).toBe(true);

  await app.type("id:contacts-filter", "bob");
  await app.waitFor("id:contact-row:tg:1001", { state: "gone" });
  expect(app.shows("id:contact-row:tg:1002")).toBe(true);
  await app.press("id:contacts-filter-clear");
  await app.waitFor("id:contact-row:tg:1001");
  await app.type("id:contacts-filter", "zzz");
  await app.waitFor("text:No matching contacts");
  expect(app.shows("id:contacts-list >> id:contacts-filter")).toBe(true);
  await app.keyboard.press("escape");
  await app.waitUntil(() => app.value("id:contacts-filter") === "");
  await app.waitFor("id:contact-row:tg:1002");
  // A pick keeps the index and its one filter beside the card.
  await app.press("id:contact-row:tg:1002");
  await app.waitFor("id:contact-detail");
  expect(app.count("id:contacts-filter")).toBe(1);
});

test("on a desktop the contacts filter shows while the list is empty or failed", async () => {
  const empty = await openConsole({ location: "/e/default/contacts", api: contactsApi([]) });
  await empty.app.waitFor("text:No contacts");
  expect(empty.app.shows("id:contacts-list >> id:contacts-filter")).toBe(true);

  const broken = await openConsole({
    location: "/e/default/contacts",
    api: contactsApi(() => ({ status: 500, body: { error: "contacts unavailable" } })),
  });
  await broken.app.waitFor("text:contacts unavailable");
  expect(broken.app.shows("id:contacts-list >> id:contacts-filter")).toBe(true);
  expect(broken.app.count("id:contacts-filter")).toBe(1);
});

test("on a desktop the contacts filter keeps its query and stays one field across the mobile breakpoint", async () => {
  const { app } = await openConsole({ location: "/e/default/contacts", api: contactsApi([ALICE, BOB]) });
  await app.waitFor("id:contact-row:tg:1001");
  await app.type("id:contacts-filter", "ali");
  await app.waitFor("id:contact-row:tg:1002", { state: "gone" });
  for (const [width, height] of [[420, 800], [1280, 800], [900, 700], [1280, 800]]) {
    await app.setViewport(width, height);
    await app.waitFor("id:contacts-list >> id:contacts-filter");
    expect(app.count("id:contacts-filter")).toBe(1);
    expect(app.value("id:contacts-filter")).toBe("ali");
    expect(app.shows("id:contact-row:tg:1002")).toBe(false);
  }
});
