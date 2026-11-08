// The phone app on Android: Back (the back button, or the edge swipe gesture navigation turns into
// the same event) goes back through the app before it leaves it, and the frame keeps the pages
// out from under the status and navigation bars (lib/systemBack.ts, lib/systemInsets.ts).
import type { App } from "nsh/test";
import { expect, test } from "nsh/test";
import { dialogLayerInsets, frameInsets } from "../lib/systemInsets";
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
  await app.waitFor("id:mobile-agents");
  await app.back();
  await app.waitFor("id:mobile-agents", { state: "gone" });
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
  expect(app.shows("id:chat-back")).toBe(false);
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
  // The bottom navigation shows: it draws under the handle, the frame does not add it again.
  expect(frameInsets(BARS, 0, true)).toEqual({ frame: { top: 24, right: 0, bottom: 0, left: 0 }, bottomNav: 16 });
  // No bottom navigation (an open topic, login): the frame keeps the page above the handle.
  expect(frameInsets(BARS, 0, false)).toEqual({ frame: { top: 24, right: 0, bottom: 16, left: 0 }, bottomNav: 0 });
  // The keyboard covers the navigation bar: its height replaces the bottom inset, everywhere.
  expect(frameInsets(BARS, 300, true)).toEqual({ frame: { top: 24, right: 0, bottom: 300, left: 0 }, bottomNav: 0 });
  expect(frameInsets(BARS, 300, false).frame.bottom).toBe(300);
  // Landscape with button navigation: the bar and the cutout are on the sides.
  expect(frameInsets({ top: 24, right: 48, bottom: 0, left: 32 }, 0, true)).toEqual({
    frame: { top: 24, right: 48, bottom: 0, left: 32 },
    bottomNav: 0,
  });
  // Before the first insets arrive (or none reported): nothing.
  expect(frameInsets({}, 0, true)).toEqual({ frame: { top: 0, right: 0, bottom: 0, left: 0 }, bottomNav: 0 });
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
