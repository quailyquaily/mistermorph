// The phone's bottom navigation on the chat's new-topic page (FT87): it shows there, with Topics
// active and every slot going where it goes; the new-topic form, and the composer of a first send
// that failed, stay usable above it; an open topic keeps its own bar-less layout; the desktop has
// no bottom navigation. Headless runs report no frames and a press reaches a view under the bar,
// so the clearance is checked through the bar's room at the foot of the chat column
// (`chat-main-bar-room`, components/frame/mobileBar.tsx); the geometry itself was checked in Chrome.
import type { App } from "nsh/test";
import { expect, test } from "nsh/test";
import { isNavPathActive } from "../lib/shell";
import { MOBILE_LOCATION_KEY, openConsole, type ApiHandler } from "./harness";

const NOW = new Date().toISOString();
const TOPICS = { body: { items: [{ id: "topic-1", title: "Ops", created_at: NOW, updated_at: NOW }] } };
const EMPTY = { body: { items: [] } };
/** A phone with gesture navigation: a 24pt status bar, a 16pt gesture handle. */
const BARS = { top: 24, right: 0, bottom: 16, left: 0 };

/** The last location the app wrote to the address bar. */
function lastLocation(app: { host: { calls(): { name: string; data: any }[] } }) {
  const writes = app.host.calls().filter((call) => call.name === "morph.history");
  return String(writes.at(-1)?.data?.url || "");
}
/** Where the phone app is: the location it saves for its next launch. */
const androidLocation = (app: App) => String(app.storage()[MOBILE_LOCATION_KEY] || "");

async function openNewTopic(options: { platform?: "android"; width?: number; height?: number; api?: Record<string, ApiHandler> } = {}) {
  const opened = await openConsole({
    location: "/e/default/chat",
    width: options.width ?? 390,
    height: options.height ?? 844,
    ...(options.platform ? { platform: options.platform, safeArea: BARS } : {}),
    api: { "GET /proxy:/topics": TOPICS, "GET /proxy:/tasks": EMPTY, "GET /proxy:/todo/tasks": EMPTY, ...options.api },
  });
  const { app } = opened;
  await app.waitFor("id:chat-topic-new-fab");
  await app.press("id:chat-topic-new-fab");
  await app.waitFor("id:chat-placeholder");
  await app.waitFor("id:chat-composer-input");
  return opened;
}

for (const platform of [undefined, "android"] as const) {
  const where = platform ? "the Android phone" : "a narrow web window";
  test(`on ${where} the new topic shows the bottom navigation, whose slots still navigate`, async () => {
    const { app } = await openNewTopic({ platform });
    expect(app.shows("id:mobile-bottom-nav")).toBe(true);
    expect(app.shows("id:sidebar")).toBe(false);
    // The form is centred above the bar, which keeps its room at the foot of the column.
    expect(app.shows("id:chat-main-bar-room")).toBe(true);
    // Topics is the active slot: the new topic's address is under it (MobileBottomNav's isActive).
    const here = () => (platform ? androidLocation(app) : lastLocation(app));
    await app.waitUntil(() => here() === "/e/default/chat");
    expect(isNavPathActive({ id: "/e/default/chat" }, here())).toBe(true);
    expect(isNavPathActive({ id: "/e/default/todo" }, here())).toBe(false);
    // The form stays usable with the bar there: the field takes text and Send can be pressed.
    await app.type("id:chat-composer-input", "Plan a trip");
    expect(app.enabled("id:chat-composer-send")).toBe(true);
    // More opens over the page and closes again.
    await app.press("id:mobile-nav-more");
    await app.waitFor("id:mobile-more");
    await app.press("id:mobile-nav-more");
    await app.waitFor("id:mobile-more", { state: "gone" });
    await app.press("id:mobile-nav-todo");
    await app.waitUntil(() => here() === "/e/default/todo");
    await app.press("id:mobile-nav-chat");
    await app.waitUntil(() => here() === "/e/default/chat");
    await app.waitFor("id:mobile-bottom-nav");
  });
}

test("a new topic whose first send fails keeps its composer usable above the bottom navigation", async () => {
  let posts = 0;
  const { app } = await openNewTopic({
    api: {
      "POST /proxy:/tasks": () => {
        posts += 1;
        return { status: 500, body: { error: "queue full" } };
      },
    },
  });
  await app.type("id:chat-composer-input", "Plan a trip");
  await app.press("id:chat-composer-send");
  await app.waitUntil(() => posts === 1);
  await app.waitFor("text:queue full >> nth=0");
  // Still the new topic: the conversation layout with its composer at the foot, and the bar.
  expect(lastLocation(app)).toBe("/e/default/chat");
  expect(app.shows("id:mobile-bottom-nav")).toBe(true);
  expect(app.shows("id:chat-placeholder")).toBe(false);
  expect(app.shows("id:chat-main-bar-room")).toBe(true);
  await app.type("id:chat-composer-input", "Plan a trip again");
  await app.press("id:chat-composer-send");
  await app.waitUntil(() => posts === 2);
});

test("an open topic keeps its layout without the bottom navigation", async () => {
  const { app } = await openConsole({
    location: "/e/default/chat",
    width: 390,
    height: 844,
    api: { "GET /proxy:/topics": TOPICS, "GET /proxy:/tasks": EMPTY },
  });
  await app.waitFor("id:chat-topic-topic-1");
  await app.press("id:chat-topic-topic-1");
  await app.waitFor("id:chat-back");
  await app.waitFor("id:mobile-bottom-nav", { state: "gone" });
  await app.waitFor("id:chat-composer-input");
  // Its composer sits at the foot of the window, with no room kept for a bar.
  expect(app.shows("id:chat-main-bar-room")).toBe(false);
});

test("the desktop's new topic has the sidebar and no bottom navigation", async () => {
  const { app } = await openConsole({
    location: "/e/default/chat",
    api: { "GET /proxy:/topics": TOPICS, "GET /proxy:/tasks": EMPTY },
  });
  await app.waitFor("id:chat-topic-new");
  await app.press("id:chat-topic-new");
  await app.waitFor("id:chat-placeholder");
  expect(app.shows("id:sidebar")).toBe(true);
  expect(app.shows("id:mobile-bottom-nav")).toBe(false);
  expect(app.shows("id:chat-main-bar-room")).toBe(false);
  await app.type("id:chat-composer-input", "Hello");
  expect(app.enabled("id:chat-composer-send")).toBe(true);
});
