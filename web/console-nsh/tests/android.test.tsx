// The phone app on Android: Back (the back button, or the edge swipe gesture navigation turns into
// the same event) goes back through the app before it leaves it, and the frame keeps the pages
// out from under the status and navigation bars (lib/systemBack.ts, lib/systemInsets.ts).
import type { App } from "nsh/test";
import { expect, test } from "nsh/test";
import { dialogLayerInsets, frameInsets, workbenchInsets } from "../lib/systemInsets";
import { MOBILE_LOCATION_KEY, openConsole } from "./harness";

const NOW = new Date().toISOString();
const TOPICS = { body: { items: [{ id: "topic-1", title: "Ops", created_at: NOW, updated_at: NOW }] } };
const EMPTY = { body: { items: [] } };
const CONTEXT = {
  available: true,
  context_window_tokens: 100000,
  input_tokens: 1000,
  parts: [{ kind: "history", tokens: 1000, children: [{ kind: "message", role: "user", tokens: 1000, content: "Hi" }] }],
};
/** The TODO page's list and the chat's runs: none. */
const QUIET = { "GET /proxy:/todo/tasks": EMPTY, "GET /proxy:/tasks": EMPTY };
/** A phone with gesture navigation: a 24pt status bar, a 16pt gesture handle. */
const BARS = { top: 24, right: 0, bottom: 16, left: 0 };
/** A phone with button navigation: a 48pt navigation bar. */
const BUTTONS = { top: 24, right: 0, bottom: 48, left: 0 };

/** Where the app is: the location the phone app saves for its next launch. */
const location = (app: App) => String(app.storage()[MOBILE_LOCATION_KEY] || "");

/** Back with nothing in the app to take it: the system's own back, which leaves the app. */
async function expectSystemBack(app: App) {
  await expect(app.back()).rejects.toMatchObject({ code: "ERR_NSH_TEST_NO_BACK" });
}

test("on the first screen Back is the system's; after moving around it goes back through the pages", async () => {
  const { app } = await openConsole({
    platform: "android",
    safeArea: BARS,
    location: "/e/default/todo",
    api: QUIET,
  });
  await app.waitFor("id:mobile-bottom-nav");
  await app.waitUntil(() => location(app) === "/e/default/todo");
  await expectSystemBack(app);

  await app.press("id:mobile-nav-contacts");
  await app.waitUntil(() => location(app) === "/e/default/contacts");
  await app.press("id:mobile-nav-more");
  await app.press("id:mobile-more-memories");
  await app.waitUntil(() => location(app) === "/e/default/memories");

  await app.back();
  await app.waitUntil(() => location(app) === "/e/default/contacts");
  await app.back();
  await app.waitUntil(() => location(app) === "/e/default/todo");
  // Back at the first page: leaving is the system's again.
  await expectSystemBack(app);
});

test("Back closes the More and agent sheets before it leaves the page", async () => {
  const { app } = await openConsole({
    platform: "android",
    location: "/e/default/todo",
    api: QUIET,
  });
  await app.waitFor("id:mobile-bottom-nav");
  await app.press("id:mobile-nav-more");
  await app.waitFor("id:mobile-more");
  await app.back();
  await app.waitFor("id:mobile-more", { state: "gone" });
  expect(location(app)).toBe("/e/default/todo");

  await app.press("id:mobile-nav-agent");
  await app.waitFor("id:mobile-agents-list");
  await app.back();
  await app.waitFor("id:mobile-agents-list", { state: "gone" });
  await expectSystemBack(app);
});

test("Back from an open topic goes to the topic list, also when the app reopened on the topic", async () => {
  // Reopened where it was: no history in this run, the topic is the first screen.
  const { app } = await openConsole({
    platform: "android",
    location: "/e/default/chat/topic-1",
    api: { ...QUIET, "GET /proxy:/topics": TOPICS },
  });
  await app.waitFor("id:chat-back");
  await app.back();
  await app.waitFor("id:chat-topic-sidebar");
  // The conversation slides out to the right, its bar with it, then goes.
  await app.waitFor("id:chat-back", { state: "gone" });
  await app.waitUntil(() => location(app) === "/e/default/chat");
  await expectSystemBack(app);

  // Opened from the list: Back to the list, and nothing more to go back through.
  await app.press("id:chat-topic-topic-1");
  await app.waitFor("id:chat-back");
  await app.waitUntil(() => location(app) === "/e/default/chat/topic-1");
  await app.back();
  await app.waitFor("id:chat-topic-sidebar");
  await app.waitUntil(() => location(app) === "/e/default/chat");
  await expectSystemBack(app);
});

test("Back from a settings section goes to the sections, then to the page before", async () => {
  const { app } = await openConsole({
    platform: "android",
    location: "/e/default/todo",
    api: QUIET,
  });
  await app.waitFor("id:mobile-bottom-nav");
  await app.press("id:mobile-nav-more");
  await app.press("id:mobile-more-settings");
  await app.waitFor("id:settings-section-agent");
  await app.press("id:settings-section-agent");
  await app.waitFor("id:settings-back");

  await app.waitUntil(() => location(app) === "/e/default/settings/agent");

  await app.back();
  await app.waitFor("id:settings-back", { state: "gone" });
  await app.waitFor("id:settings-section-agent");
  await app.waitUntil(() => location(app) === "/e/default/settings");
  // The next Back leaves Settings: no press that only changes the address.
  await app.back();
  await app.waitUntil(() => location(app) === "/e/default/todo");
  await app.waitFor("id:settings-section-agent", { state: "gone" });
  await expectSystemBack(app);
});

test("Back steps up through the context inspector, then to its topic, also when the app reopened there", async () => {
  const { app } = await openConsole({
    platform: "android",
    location: "/e/default/chat/topic-1/context",
    api: { ...QUIET, "GET /proxy:/topics": TOPICS, "GET /proxy:/topic/topic-1/context": { body: CONTEXT } },
  });
  await app.waitFor("id:context-overview");
  await app.press("id:context-part-history");
  await app.waitFor("id:context-items");
  await app.back();
  await app.waitFor("id:context-overview");
  // Reopened on the inspector, nothing before it: its topic takes its place.
  await app.back();
  await app.waitFor("id:chat-back");
  await app.waitUntil(() => location(app) === "/e/default/chat/topic-1");
  await app.back();
  await app.waitFor("id:chat-topic-sidebar");
  await expectSystemBack(app);
});

test("Settings Back keeps the editor and draft on cancel, and leaves only after Discard", async () => {
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

  await app.back();
  await app.waitFor("id:dialog-action-cancel");
  await app.press("id:dialog-action-cancel");
  await app.waitFor("id:dialog-action-cancel", { state: "gone" });
  await app.waitUntil(() => location(app) === "/e/default/settings/tools");
  expect(app.shows("id:settings-tool-web_search-switch")).toBe(true);
  expect(app.shows("id:settings-back")).toBe(true);
  expect(app.shows("id:settings-index")).toBe(false);
  expect(app.shows("id:settings-save-bar")).toBe(true);
  // The changed value survived cancellation: toggling it back clears the draft.
  await app.press("id:settings-tool-web_search-switch");
  await app.waitFor("id:settings-save-bar", { state: "gone" });
  await app.press("id:settings-tool-web_search-switch");
  await app.waitFor("id:settings-save-bar");

  await app.back();
  await app.waitFor("id:dialog-action-confirm");
  expect(app.shows("id:settings-tool-web_search-switch")).toBe(true);
  await app.press("id:dialog-action-confirm");
  await app.waitFor("id:settings-index");
  await app.waitUntil(() => location(app) === "/e/default/settings");
  // The section keeps Tools on it while it slides out over the sections (page-transitions-back).
  await app.waitFor("id:settings-panel", { state: "gone" });
  expect(app.shows("id:settings-tool-web_search-switch")).toBe(false);
  expect(app.shows("id:settings-save-bar")).toBe(false);
  await expectSystemBack(app);
});

for (const restored of [true, false]) {
  test(`Context topbar Back does not leave the inspector in history (${restored ? "restored" : "opened from topic"})`, async () => {
    const { app } = await openConsole({
      platform: "android",
      location: `/e/default/chat/topic-1${restored ? "/context" : ""}`,
      api: {
        ...QUIET,
        "GET /proxy:/topics": TOPICS,
        "GET /proxy:/topic/topic-1/context": { body: CONTEXT },
        "GET /proxy:/topic/topic-1/metadata": {
          body: { context: { available: true, used_input_tokens: 1000, context_window_tokens: 100000 } },
        },
      },
    });
    if (!restored) {
      await app.waitFor("id:chat-workspace-toggle");
      await app.press("id:chat-workspace-toggle");
      await app.waitFor("id:chat-topic-context-inspect");
      await app.press("id:chat-topic-context-inspect");
    }
    await app.waitFor("id:context-overview");
    await app.press("id:context-part-history");
    await app.waitFor("id:context-items");
    await app.press("id:context-back");
    await app.waitFor("id:context-overview");
    expect(location(app)).toBe("/e/default/chat/topic-1/context");
    await app.press("id:context-back");
    await app.waitFor("id:chat-back");
    await app.waitUntil(() => location(app) === "/e/default/chat/topic-1");
    if (!restored) {
      // The topic restores its open workspace sheet; Back closes that before the topic.
      await app.waitFor("id:chat-topic-context-inspect");
      await app.back();
      await app.waitFor("id:chat-topic-context-inspect", { state: "gone" });
    }
    await app.back();
    await app.waitFor("id:chat-topic-sidebar");
    await app.waitUntil(() => location(app) === "/e/default/chat");
    await expectSystemBack(app);
  });
}

test("a dialog takes Back before the page: on the login page, Back closes the server dialog", async () => {
  const { app } = await openConsole({ platform: "android", password: true, location: "/e/default/todo" });
  await app.waitUntil(() => location(app).startsWith("/login"));
  await app.press("id:login-server-open");
  await app.waitFor("id:login-server-dialog");
  await app.back();
  await app.waitFor("id:login-server-dialog", { state: "gone" });
  expect(location(app).startsWith("/login")).toBe(true);
  // The login page took the place of the page asked for: Back leaves the app from there.
  await expectSystemBack(app);
});

test("on the web and the desktop nothing listens to Back: the browser's back button stays the browser's", async () => {
  const { app } = await openConsole({
    location: "/e/default/todo",
    width: 390,
    height: 844,
    api: QUIET,
  });
  await app.waitFor("id:mobile-bottom-nav");
  await app.press("id:mobile-nav-contacts");
  await app.waitUntil(() =>
    app.host.calls().some((call) => call.name === "morph.history" && (call.data as any)?.url === "/e/default/contacts"),
  );
  await expectSystemBack(app);
});

test("Android's frame takes the status bar at the top and the gesture handle at the bottom, once", () => {
  // Wide windows. The bottom navigation shows: it draws under the handle, the frame does not add it again.
  expect(frameInsets(BARS, 0, true)).toEqual({ frame: { top: 24, right: 0, bottom: 0, left: 0 }, bottomNav: 16, foot: 0 });
  // No bottom navigation: the frame keeps the page above the handle.
  expect(frameInsets(BARS, 0, false)).toEqual({ frame: { top: 24, right: 0, bottom: 16, left: 0 }, bottomNav: 0, foot: 0 });
  // The keyboard covers the navigation bar: its height replaces the bottom inset, everywhere.
  expect(frameInsets(BARS, 300, true)).toEqual({ frame: { top: 24, right: 0, bottom: 300, left: 0 }, bottomNav: 0, foot: 0 });
  expect(frameInsets(BARS, 300, false).frame.bottom).toBe(300);
  // Landscape with button navigation: the bar and the cutout are on the sides.
  expect(frameInsets({ top: 24, right: 48, bottom: 0, left: 32 }, 0, true)).toEqual({
    frame: { top: 24, right: 48, bottom: 0, left: 32 },
    bottomNav: 0,
    foot: 0,
  });
  // Before the first insets arrive (or none reported): nothing.
  expect(frameInsets({}, 0, true)).toEqual({ frame: { top: 0, right: 0, bottom: 0, left: 0 }, bottomNav: 0, foot: 0 });
});

test("on Android phones the page's column takes the bottom inset: its foot, the navigation, or the open workbench, once", () => {
  const shut = { workbench: false };
  const open = { workbench: true };
  // The navigation shows: it takes the inset under its card.
  expect(frameInsets(BARS, 0, true, shut)).toEqual({ frame: { top: 24, right: 0, bottom: 0, left: 0 }, bottomNav: 16, foot: 0 });
  // An open topic, login: the column's foot keeps the page above the handle (not the frame).
  expect(frameInsets(BARS, 0, false, shut)).toEqual({ frame: { top: 24, right: 0, bottom: 0, left: 0 }, bottomNav: 0, foot: 16 });
  // The workbench is open: its sheet takes it, the foot goes and the navigation over the page above takes none.
  expect(frameInsets(BARS, 0, false, open)).toEqual({ frame: { top: 24, right: 0, bottom: 0, left: 0 }, bottomNav: 0, foot: 0 });
  expect(frameInsets(BARS, 0, true, open)).toEqual({ frame: { top: 24, right: 0, bottom: 0, left: 0 }, bottomNav: 0, foot: 0 });
  expect(workbenchInsets(BARS, 0, true, 8)).toEqual({ bottom: 16, left: 0, right: 0 });
  // Button navigation (a 48pt bar) under the sheet.
  expect(frameInsets(BUTTONS, 0, false, open).foot).toBe(0);
  expect(workbenchInsets(BUTTONS, 0, true, 8).bottom).toBe(48);
  // The keyboard: the frame stands on it, in every case, and nothing else takes the inset.
  for (const phone of [shut, open]) {
    for (const nav of [true, false]) {
      expect(frameInsets(BARS, 300, nav, phone)).toEqual({ frame: { top: 24, right: 0, bottom: 300, left: 0 }, bottomNav: 0, foot: 0 });
    }
  }
  expect(workbenchInsets(BARS, 300, true, 8)).toEqual({ bottom: 0, left: 0, right: 0 });
  // Landscape with button navigation on the side: the frame keeps the sides; the sheet takes none of them.
  const SIDEWAYS = { top: 24, right: 48, bottom: 0, left: 32 };
  expect(frameInsets(SIDEWAYS, 0, false, open)).toEqual({ frame: { top: 24, right: 48, bottom: 0, left: 32 }, bottomNav: 0, foot: 0 });
  expect(workbenchInsets(SIDEWAYS, 0, true, 8)).toEqual({ bottom: 0, left: 0, right: 0 });
  // No insets: nothing anywhere.
  expect(frameInsets({}, 0, false, open)).toEqual({ frame: { top: 0, right: 0, bottom: 0, left: 0 }, bottomNav: 0, foot: 0 });
  expect(workbenchInsets({}, 0, true, 8)).toEqual({ bottom: 0, left: 0, right: 0 });
});

test("elsewhere (the web, iOS) the phone's workbench takes the bottom inset and the side insets past its margin itself", () => {
  // A phone held upright: the home indicator under the sheet.
  expect(workbenchInsets({ top: 47, right: 0, bottom: 34, left: 0 }, 0, false, 8)).toEqual({ bottom: 34, left: 0, right: 0 });
  // On its side: the cutout and the indicator; the sheet's 8pt margin already covers that much of a side.
  expect(workbenchInsets({ top: 0, right: 47, bottom: 21, left: 47 }, 0, false, 8)).toEqual({ bottom: 21, left: 39, right: 39 });
  // Side insets within the margin: nothing more.
  expect(workbenchInsets({ top: 0, right: 6, bottom: 0, left: 0 }, 0, false, 8)).toEqual({ bottom: 0, left: 0, right: 0 });
  // The keyboard is up: the frame stands on it, the sheet takes no bottom inset (once); the sides stay.
  expect(workbenchInsets({ top: 0, right: 47, bottom: 21, left: 47 }, 280, false, 8)).toEqual({ bottom: 0, left: 39, right: 39 });
  // Unreadable insets count as none.
  expect(workbenchInsets({ bottom: Number.NaN, left: -3 }, Number.NaN, false, 8)).toEqual({ bottom: 0, left: 0, right: 0 });
});

test("Android's dialogs keep out from under the system bars, rising with the keyboard on phones", () => {
  expect(dialogLayerInsets(BARS, 0, 0)).toEqual({ top: 24, right: 0, bottom: 16, left: 0 });
  expect(dialogLayerInsets(BARS, 280, 0)).toEqual({ top: 24, right: 0, bottom: 280, left: 0 });
  // Wide windows keep their 16pt margin inside the bars.
  expect(dialogLayerInsets({ top: 24, right: 48, bottom: 0, left: 0 }, 0, 16)).toEqual({ top: 40, right: 64, bottom: 16, left: 16 });
});

test("turning the phone to landscape keeps the places Back goes through", async () => {
  const { app } = await openConsole({
    platform: "android",
    safeArea: BARS,
    location: "/e/default/todo",
    api: QUIET,
  });
  await app.waitFor("id:mobile-bottom-nav");
  await app.press("id:mobile-nav-contacts");
  await app.waitUntil(() => location(app) === "/e/default/contacts");
  await app.setViewport(844, 390);
  await app.waitFor("id:mobile-bottom-nav");
  await app.back();
  await app.waitUntil(() => location(app) === "/e/default/todo");
});
