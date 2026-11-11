// Page transitions in the console on phones (components/frame/PageStack.tsx, lib/navMotion.ts):
// which way each committed navigation moves, through page controls, the bottom navigation, the
// browser's history and Android's Back. The page host names its layers by how they came in
// (`page-layer.in.<presentation>`, the page going out `page-layer-out`); the layer that stays after
// a slide tells which slide it was. Mid-slide lifecycles are in tests/page-stack.test.tsx and
// tests/pane-stack.test.tsx.
import type { App } from "nsh/test";
import { expect, test } from "nsh/test";
import { MOBILE_LOCATION_KEY, openConsole } from "./harness";

const NOW = new Date().toISOString();
const TOPICS = { body: { items: [{ id: "topic-1", title: "Ops", created_at: NOW, updated_at: NOW }] } };
const EMPTY = { body: { items: [] } };
const QUIET = { "GET /proxy:/todo/tasks": EMPTY, "GET /proxy:/tasks": EMPTY, "GET /proxy:/topics": TOPICS };

const location = (app: App) => String(app.storage()[MOBILE_LOCATION_KEY] || "");
const layer = (app: App, presentation: string) => app.count(`id:page-layer.in.${presentation}`);
/** The slide has ended: one page, none going out. */
const settled = (app: App) => app.waitUntil(() => app.count("id:page-layer-out") === 0);

test("bottom navigation moves pages as tiles in its order; Android's Back replays them reversed", async () => {
  const { app } = await openConsole({ platform: "android", location: "/e/default/todo", api: QUIET });
  await app.waitFor("id:mobile-bottom-nav");
  // The first page arrives without motion.
  expect(layer(app, "none")).toBe(1);

  // TODO → Contacts: an earlier page of the strip, from the left.
  await app.press("id:mobile-nav-contacts");
  await app.waitUntil(() => location(app) === "/e/default/contacts");
  expect(layer(app, "tab-back")).toBe(1);
  await settled(app);
  expect(app.count("id:todo-page")).toBe(0);

  // Contacts → Memories (More): a later one, from the right.
  await app.press("id:mobile-nav-more");
  await app.press("id:mobile-more-memories");
  await app.waitUntil(() => location(app) === "/e/default/memories");
  expect(layer(app, "tab-forward")).toBe(1);
  await settled(app);

  await app.back();
  await app.waitUntil(() => location(app) === "/e/default/contacts");
  expect(layer(app, "tab-back")).toBe(1);
  await app.back();
  await app.waitUntil(() => location(app) === "/e/default/todo");
  expect(layer(app, "tab-forward")).toBe(1);
  await settled(app);
  expect(app.count("id:contacts-page")).toBe(0);
});

test("a page further in slides in from the right, Back slides it out to the right", async () => {
  const { app } = await openConsole({ platform: "android", location: "/e/default/settings/system", api: QUIET });
  await app.waitFor("id:settings-open-logs");
  await app.press("id:settings-open-logs");
  await app.waitUntil(() => location(app) === "/e/default/logs");
  expect(layer(app, "push")).toBe(1);
  await settled(app);
  expect(app.count("id:settings-page")).toBe(0);

  await app.back();
  await app.waitUntil(() => location(app) === "/e/default/settings/system");
  expect(layer(app, "pop")).toBe(1);
  await settled(app);
  await app.waitFor("id:settings-open-logs");
});

test("the browser's back and forward buttons replay the step they undo or redo", async () => {
  const { app } = await openConsole({ width: 390, height: 844, location: "/e/default/todo", api: QUIET });
  await app.waitFor("id:mobile-bottom-nav");
  await app.press("id:mobile-nav-contacts");
  await app.waitFor("id:contacts-page");
  expect(layer(app, "tab-back")).toBe(1);
  await settled(app);

  // Back: TODO comes back from the right, as the reverse of the step.
  await app.host.send("morph.pop", { location: "/e/default/todo" });
  await app.waitFor("id:todo-page");
  expect(layer(app, "tab-forward")).toBe(1);
  await settled(app);
  // Forward: the step again.
  await app.host.send("morph.pop", { location: "/e/default/contacts" });
  await app.waitFor("id:contacts-page");
  expect(layer(app, "tab-back")).toBe(1);
  await settled(app);
  expect(app.count("id:todo-page")).toBe(0);
});

test("rapid switches end on the last page, with nothing left behind", async () => {
  const { app } = await openConsole({ platform: "android", location: "/e/default/todo", api: QUIET });
  await app.waitFor("id:mobile-bottom-nav");
  await app.press("id:mobile-nav-contacts");
  await app.press("id:mobile-nav-chat");
  await app.press("id:mobile-nav-todo");
  await app.waitUntil(() => location(app) === "/e/default/todo");
  await settled(app);
  expect(app.count("id:todo-page")).toBe(1);
  expect(app.count("id:contacts-page")).toBe(0);
  expect(app.count("id:chat-page")).toBe(0);
  expect(app.count("id:page-stack")).toBe(1);
});

test("with reduced motion pages switch at once", async () => {
  const { app } = await openConsole({ width: 390, height: 844, location: "/e/default/todo", api: QUIET, reducedMotion: true });
  await app.waitFor("id:mobile-bottom-nav");
  await app.press("id:mobile-nav-contacts");
  await app.waitFor("id:contacts-page");
  expect(app.count("id:page-layer-out")).toBe(0);
  expect(app.count("id:todo-page")).toBe(0);
  expect(layer(app, "none")).toBe(1);
});

test("wide windows keep the page entrance and no outgoing page", async () => {
  const { app } = await openConsole({ location: "/e/default/todo", api: QUIET });
  await app.waitFor("id:todo-page");
  await app.press("id:nav-contacts");
  await app.waitFor("id:contacts-page");
  expect(app.count("id:page-layer-out")).toBe(0);
  expect(app.count("id:todo-page")).toBe(0);
  expect(layer(app, "rise")).toBe(1);
});

test("a topic opens and closes within the chat page: its own slide, the same page", async () => {
  const { app } = await openConsole({ platform: "android", location: "/e/default/chat", api: QUIET });
  await app.waitFor("id:chat-topic-topic-1");
  await app.press("id:chat-topic-topic-1");
  await app.waitFor("id:chat-back");
  await app.waitUntil(() => location(app) === "/e/default/chat/topic-1");
  // No new page: the chat page moved its own panes.
  expect(layer(app, "none")).toBe(1);
  await app.waitFor("id:chat-topic-sidebar", { state: "gone" });

  await app.back();
  await app.waitFor("id:chat-topic-sidebar");
  await app.waitUntil(() => location(app) === "/e/default/chat");
  await app.waitFor("id:chat-conversation-pane", { state: "gone" });
  expect(layer(app, "none")).toBe(1);
  expect(app.count("id:page-layer-out")).toBe(0);
  // The topic is let go once the conversation has gone.
  await app.waitFor("id:chat-back", { state: "gone" });
});

test("a cancelled leave moves nothing", async () => {
  const { app } = await openConsole({
    platform: "android",
    location: "/e/default/settings",
    api: {
      ...QUIET,
      "GET /settings/agent": {
        body: {
          config_revision: "rev-1",
          llm: { inference_provider: "openai", model: "gpt-5.2", profiles: [], fallback_profiles: [] },
          tools: { web_search: { enabled: false } },
          mcp: { servers: [] },
          config_values: {},
          field_states: {},
        },
      },
    },
  });
  await app.waitFor("id:settings-section-tools");
  await app.press("id:settings-section-tools");
  await app.waitFor("id:settings-tool-web_search-switch");
  await app.press("id:settings-tool-web_search-switch");
  await app.waitFor("id:settings-save-bar");

  await app.press("id:mobile-nav-contacts");
  await app.waitFor("id:dialog-action-cancel");
  await app.press("id:dialog-action-cancel");
  await app.waitFor("id:dialog-action-cancel", { state: "gone" });
  expect(location(app)).toBe("/e/default/settings/tools");
  expect(app.count("id:page-layer-out")).toBe(0);
  expect(app.count("id:contacts-page")).toBe(0);
  expect(layer(app, "none")).toBe(1);
});
