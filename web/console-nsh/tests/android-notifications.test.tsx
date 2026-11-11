// Task notifications in the Android app. The app's page (and the console's notification socket)
// is suspended in the background, so the APK's native part (android/src/.../TaskNotifier.java)
// tells of finished tasks while the app is away; here the test plays it. The console configures it
// with the session, the server's API address and the texts, asks the permission through it from
// Settings' notifications row (the same row the web console has), and opens the topic of a
// pressed notification: the topic when it still exists, the chat when it does not.
import type { App } from "nsh/test";
import { expect, test } from "nsh/test";
import { MOBILE_LOCATION_KEY, openConsole } from "./harness";

const NOW = new Date().toISOString();
const TOPICS = { body: { items: [{ id: "topic-1", title: "Ops", created_at: NOW, updated_at: NOW }] } };
const QUIET = {
  "GET /proxy:/todo/tasks": { body: { items: [] } },
  "GET /proxy:/tasks": { body: { items: [] } },
  "GET /proxy:/topics": TOPICS,
  "GET /proxy:/topics/topic-1": { body: { id: "topic-1", title: "Ops", created_at: NOW, updated_at: NOW } },
};

type Calls = { host: { calls(): { name: string; data: any }[] } };
const named = (app: Calls, name: string) => app.host.calls().filter((call) => call.name === name);
const location = (app: App) => String(app.storage()[MOBILE_LOCATION_KEY] || "");

/** The native part, as the APK's MorphApplication answers `morph.notify.*`; `pressed` lists the topics taken. */
function nativeHost(options: { state?: string; request?: string; pressed?: string[] } = {}) {
  const pressed = [...(options.pressed ?? [])];
  return {
    "morph.notify.state": options.state ?? "granted",
    "morph.notify.request": options.request ?? "granted",
    "morph.notify.configure": null,
    "morph.notify.take": () => {
      const topic = pressed.shift();
      return topic ? { topic_id: topic } : null;
    },
  };
}

test("the native part gets the session, the server's API address and the texts", async () => {
  const { app } = await openConsole({ platform: "android", location: "/e/default/todo", host: nativeHost(), api: QUIET });
  await app.waitFor("id:mobile-bottom-nav");
  await app.waitUntil(() => named(app, "morph.notify.configure").some((call) => call.data?.token === "token-1"));
  const settings = named(app, "morph.notify.configure").at(-1)!.data;
  expect(settings.api).toBe("http://console.test/api");
  expect(settings.texts).toEqual({
    untitled: "Untitled Topic",
    done: "Task finished",
    failed: "Task failed",
    channel: "Topic task notifications",
  });
  // Leaving the app is the native part's to watch: the page shows nothing itself.
  await app.setLifecycle("background");
  await app.setLifecycle("active");
  expect(named(app, "morph.notify.show").length).toBe(0);
});

test("a notification pressed while the app was closed opens its topic at the start", async () => {
  const { app } = await openConsole({
    platform: "android",
    location: "/e/default/todo",
    host: nativeHost({ pressed: ["topic-1"] }),
    api: QUIET,
  });
  await app.waitUntil(() => location(app) === "/e/default/chat/topic-1");
});

test("a notification pressed while the app was in the background opens its topic when it comes back", async () => {
  const pressed: string[] = [];
  const host = nativeHost();
  const { app } = await openConsole({
    platform: "android",
    location: "/e/default/todo",
    host: {
      ...host,
      "morph.notify.take": () => {
        const topic = pressed.shift();
        return topic ? { topic_id: topic } : null;
      },
    },
    api: QUIET,
  });
  await app.waitFor("id:mobile-bottom-nav");
  await app.setLifecycle("background");
  pressed.push("topic-1");
  await app.setLifecycle("active");
  await app.host.send("morph.notify.opened", {});
  await app.waitUntil(() => location(app) === "/e/default/chat/topic-1");
});

test("a pressed notification of a topic that is gone opens the chat instead", async () => {
  const { app, calls } = await openConsole({
    platform: "android",
    location: "/e/default/todo",
    host: nativeHost({ pressed: ["deleted-topic"] }),
    api: { ...QUIET, "GET /proxy:/topics/deleted-topic": { status: 404, body: { error: "topic not found" } } },
  });
  await app.waitUntil(() => calls.some((call) => call.uri === "/topics/deleted-topic"));
  await app.waitUntil(() => location(app) === "/e/default/chat");
});

test("Settings' notifications row asks the native part, and says where to allow blocked ones", async () => {
  const { app } = await openConsole({
    platform: "android",
    location: "/e/default/settings/system",
    host: nativeHost({ state: "default", request: "granted" }),
    api: { ...QUIET, "GET /settings/auto-update": { body: { enabled: false } } },
  });
  await app.waitFor("Notification permission has not been granted.");
  // The app never asks by itself: only the row's button does.
  expect(named(app, "morph.notify.request").length).toBe(0);
  await app.press("Enable notifications");
  await app.waitFor("Notifications are enabled.");
  expect(named(app, "morph.notify.request").length).toBe(1);

  const blocked = await openConsole({
    platform: "android",
    location: "/e/default/settings/system",
    host: nativeHost({ state: "denied" }),
    api: { ...QUIET, "GET /settings/auto-update": { body: { enabled: false } } },
  });
  await blocked.app.waitFor("Notifications are blocked. Allow them for this app in the system settings.");
  expect(blocked.app.enabled("Enable notifications")).toBe(false);
});

test("an APK without the native part has no notifications, and nothing breaks", async () => {
  const { app } = await openConsole({
    platform: "android",
    location: "/e/default/settings/system",
    host: { "morph.file.pick": [] },
    api: { ...QUIET, "GET /settings/auto-update": { body: { enabled: false } } },
  });
  await app.waitFor("This build of the app cannot show notifications.");
  expect(app.enabled("Enable notifications")).toBe(false);
});
