// Where the Console's application keyboard shortcuts are on (lib/shortcutPolicy.ts): in a browser's
// desktop layout, in the desktop app at any width, and in the phone app only while its native part
// says a hardware keyboard is connected (lib/mobileHost.ts, android/src/.../HardwareKeyboard.java).
// Never in a browser's phone layout, and never on an unknown keyboard state. The one decision is
// behind the keys that act, the hints that name them and Settings' Keyboard shortcuts section, and
// all three follow a window resized, a keyboard connected or taken away and the app coming back.
//
// Headless `keyboard.press` is a hardware keyboard's key on every platform, so pressing keys in a
// phone layout or in the Android app is the "hardware keyboard is there" case; the tests here play
// the native part's answers (`morph.keyboard.state`) and events (`morph.keyboard.changed`). No
// device was involved.
import type { App } from "nsh/test";
import { expect, open, test } from "nsh/test";
import { MOBILE_BREAKPOINT } from "../lib/layout";
import { physicalKeyboardFrom } from "../lib/mobileHost";
import { shortcutsAllowed } from "../lib/shortcutPolicy";
import { MOBILE_LOCATION_KEY, openConsole, type ApiHandler, type ApiRequest, type ConsoleOptions } from "./harness";

const NOW = new Date().toISOString();
const TOPICS = { body: { items: [{ id: "topic-1", title: "Ops", created_at: NOW, updated_at: NOW }] } };
const EMPTY = { body: { items: [] } };
const SENT = {
  body: {
    items: [
      { id: "t1", topic_id: "topic-1", status: "done", task: "Check the logs", result: { final: { output: "Logs are fine." } }, created_at: NOW },
    ],
  },
};
const SECTIONS = "/e/default/settings";
const SHORTCUTS = "/e/default/settings/shortcuts";

/** The last location the app wrote: to the address bar, or (the phone app) to its storage. */
function location(app: App) {
  const saved = app.storage()[MOBILE_LOCATION_KEY];
  if (saved !== undefined) return String(saved);
  const writes = app.host.calls().filter((call) => call.name === "morph.history");
  return String((writes.at(-1)?.data as any)?.url || "");
}

/** Lets the app do whatever a key would have made it do. */
const settle = (app: App) => app.wait(300);

function chatApi(tasks: ApiHandler, posts: ApiRequest[] = []): Record<string, ApiHandler> {
  return {
    "GET /proxy:/topics": TOPICS,
    "GET /proxy:/tasks": tasks,
    "GET /proxy:/todo/tasks": EMPTY,
    "POST /proxy:/tasks": (request: ApiRequest) => {
      posts.push(request);
      return { body: { id: "n1", topic_id: "topic-1", status: "queued" } };
    },
  };
}

/** The native part of the Android app, whose word on the keyboard the test changes. */
function nativeKeyboard(initial: unknown) {
  const native = { answer: initial as unknown, fails: false, asked: 0 };
  return {
    native,
    host: {
      "morph.keyboard.state": () => {
        native.asked += 1;
        if (native.fails) throw new Error("the input service is gone");
        return native.answer;
      },
    },
  };
}

/* ---------- the decision ---------- */

test("the decision: desktop app always, a browser by its layout, the phone app by a known keyboard", () => {
  const keyboards = ["connected", "disconnected", "unknown"] as const;
  for (const keyboard of keyboards) {
    for (const mobileLayout of [true, false]) {
      // The desktop app: any width, whatever anything says of a keyboard.
      expect(shortcutsAllowed({ runtime: "desktop", mobileLayout, keyboard })).toBe(true);
      // A browser: the layout alone; a keyboard state never turns the phone layout's shortcuts on.
      expect(shortcutsAllowed({ runtime: "web", mobileLayout, keyboard })).toBe(!mobileLayout);
      // The phone app: a connected keyboard alone, phone or tablet width.
      expect(shortcutsAllowed({ runtime: "mobile", mobileLayout, keyboard })).toBe(keyboard === "connected");
    }
  }
  // Anything else is off.
  expect(shortcutsAllowed({ runtime: "tv" as never, mobileLayout: false, keyboard: "connected" })).toBe(false);
  expect(shortcutsAllowed({ runtime: "web", mobileLayout: undefined as never, keyboard: "connected" })).toBe(false);
  expect(shortcutsAllowed({ runtime: "mobile", mobileLayout: false, keyboard: "yes" as never })).toBe(false);
  expect(shortcutsAllowed({ runtime: "mobile", mobileLayout: false, keyboard: true as never })).toBe(false);
});

test("the native part's word is taken literally: anything else is unknown", () => {
  expect(physicalKeyboardFrom({ physical: "connected" })).toBe("connected");
  expect(physicalKeyboardFrom({ physical: "disconnected" })).toBe("disconnected");
  expect(physicalKeyboardFrom({ physical: "unknown" })).toBe("unknown");
  for (const odd of [null, undefined, "", "connected", true, 1, [], {}, { physical: true }, { physical: 1 }, { physical: "Connected" }, { physical: "yes" }, { connected: true }]) {
    expect(physicalKeyboardFrom(odd)).toBe("unknown");
  }
});

/* ---------- a browser ---------- */

test("a browser's desktop layout has the shortcuts, their hints and the Settings section", async () => {
  const { app } = await openConsole({ location: SECTIONS, api: chatApi(EMPTY) });
  await app.waitFor("id:settings-section-shortcuts");
  await app.hover("id:nav-contacts");
  await app.waitFor("text:Alt+Shift+2");
  await app.keyboard.press("alt+shift+2");
  await app.waitUntil(() => location(app) === "/e/default/contacts");
  await app.keyboard.press("shift+/");
  await app.waitUntil(() => location(app) === SHORTCUTS);
  await app.waitFor("id:settings-shortcuts");
});

test("a browser's phone layout has none of them, with a hardware keyboard's keys too", async () => {
  // A host that claims a keyboard changes nothing: a browser is never asked, and never heard.
  const { app } = await openConsole({
    width: 390,
    height: 844,
    location: SECTIONS,
    api: chatApi(EMPTY),
    host: { "morph.keyboard.state": { physical: "connected" } },
  });
  await app.waitFor("id:settings-section-general");
  expect(app.shows("id:settings-section-shortcuts")).toBe(false);
  expect(app.host.calls().some((call) => call.name === "morph.keyboard.state")).toBe(false);
  await app.host.send("morph.keyboard.changed", { physical: "connected" });
  await settle(app);
  expect(app.shows("id:settings-section-shortcuts")).toBe(false);

  // The keys of every default, and the desktop app's: nothing acts.
  for (const keys of ["alt+shift+2", "alt+shift+3", "alt+shift+,", "ctrl+2", "ctrl+shift+o", "ctrl+k", "ctrl+i", "ctrl+\\", "shift+/"]) {
    await app.keyboard.press(keys);
  }
  await settle(app);
  expect(location(app)).toBe(SECTIONS);
  expect(app.shows("id:settings-shortcuts")).toBe(false);
  await app.waitFor("id:settings-section-general");
});

test("the Settings address of the shortcuts opens the sections where they are off", async () => {
  const { app } = await openConsole({ width: 390, height: 844, location: SHORTCUTS, api: chatApi(EMPTY) });
  // The phone's list of sections, not a section: the address is replaced with Settings' own.
  await app.waitFor("id:settings-section-general");
  await app.waitUntil(() => location(app) === SECTIONS);
  expect(app.shows("id:settings-shortcuts")).toBe(false);
  expect(app.shows("id:settings-section-shortcuts")).toBe(false);
  expect(app.shows("text:Keyboard shortcuts")).toBe(false);
  // The other sections open as ever.
  await app.press("id:settings-section-general");
  await app.waitUntil(() => location(app) === "/e/default/settings/general");
});

test("resizing a browser window turns the shortcuts, the hints and the section off and on", async () => {
  const { app } = await openConsole({ location: SHORTCUTS, api: chatApi(EMPTY) });
  await app.waitFor("id:settings-shortcuts");
  expect(app.shows("id:settings-section-shortcuts")).toBe(true);

  // Narrow: the open section closes to the sections, and its keys are dead.
  await app.setViewport(MOBILE_BREAKPOINT, 800);
  await app.waitFor("id:settings-shortcuts", { state: "gone" });
  await app.waitUntil(() => location(app) === SECTIONS);
  await app.waitFor("id:settings-section-general");
  expect(app.shows("id:settings-section-shortcuts")).toBe(false);
  await app.keyboard.press("alt+shift+2");
  await app.keyboard.press("shift+/");
  await settle(app);
  expect(location(app)).toBe(SECTIONS);
  expect(app.shows("id:settings-shortcuts")).toBe(false);

  // Wide again, without a reload: the section is listed and the keys act.
  await app.setViewport(MOBILE_BREAKPOINT + 1, 800);
  await app.waitFor("id:settings-section-shortcuts");
  await app.keyboard.press("shift+/");
  await app.waitUntil(() => location(app) === SHORTCUTS);
  await app.waitFor("id:settings-shortcuts");
  await app.keyboard.press("alt+shift+2");
  await app.waitUntil(() => location(app) === "/e/default/contacts");
  await app.hover("id:nav-contacts");
  await app.waitFor("text:Alt+Shift+2");
});

test("recording a shortcut ends when the window turns narrow, and the keys stay as they were", async () => {
  const { app } = await openConsole({ location: SHORTCUTS, api: chatApi(EMPTY) });
  await app.waitFor("id:settings-shortcuts");
  await app.press("id:shortcut-change-chat-newTopic");
  await app.waitFor("id:shortcut-recording-chat-newTopic");
  await app.setViewport(390, 844);
  await app.waitFor("id:settings-shortcuts", { state: "gone" });
  // The recorder went with the section: the key is not taken for a new shortcut, nor saved.
  await app.keyboard.press("ctrl+shift+y");
  await settle(app);
  expect(app.host.calls().some((call) => call.name === "morph.kv.set" && (call.data as any)?.key === "mistermorph.shortcuts.web")).toBe(false);
  await app.setViewport(1280, 800);
  await app.waitFor("id:settings-section-shortcuts");
  await app.press("id:settings-section-shortcuts");
  await app.waitFor("id:settings-shortcuts");
  expect(app.shows("id:shortcut-recording-chat-newTopic")).toBe(false);
  expect(app.shows("id:shortcut-keys-chat-newTopic >> text:Ctrl+Shift+O")).toBe(true);
});

/* ---------- the composer ---------- */

test("in a browser's phone layout the composer's keys are the field's own: Enter, Up, Escape", async () => {
  const posts: ApiRequest[] = [];
  const { app } = await openConsole({ width: 390, height: 844, location: "/e/default/chat/topic-1", api: chatApi(SENT, posts) });
  await app.waitFor("text:Logs are fine.");
  // Send is not named with a key that does not send.
  expect(app.shows("label:Send Task")).toBe(true);
  expect(app.shows("label:Send Task (Enter)")).toBe(false);

  // Up in the empty field is the caret's: no sent message comes back.
  await app.press("id:chat-composer-input");
  await app.keyboard.press("up");
  await settle(app);
  expect(app.value("id:chat-composer-input")).toBe("");

  // Typing is typing, the shortcuts' typing keys included; Enter is a new line and sends nothing.
  await app.type("id:chat-composer-input", "Why");
  await app.keyboard.press("shift+/");
  await app.waitUntil(() => app.value("id:chat-composer-input") === "Why?");
  await app.keyboard.press("enter");
  await app.keyboard.press("x");
  await app.waitUntil(() => app.value("id:chat-composer-input") === "Why?\nx");
  await app.keyboard.press("ctrl+k");
  await app.keyboard.press("ctrl+i");
  await settle(app);
  expect(posts.length).toBe(0);
  expect(app.value("id:chat-composer-input")).toBe("Why?\nx");

  // The Send button sends.
  await app.press("id:chat-composer-send");
  await app.waitUntil(() => posts.length === 1);
  expect(posts[0].json.task).toBe("Why?\nx");
});

test("in a browser's desktop layout Enter sends and Up brings back what was sent", async () => {
  const posts: ApiRequest[] = [];
  const { app } = await openConsole({ location: "/e/default/chat/topic-1", api: chatApi(SENT, posts) });
  await app.waitFor("text:Logs are fine.");
  expect(app.shows("label:Send Task (Enter)")).toBe(true);
  await app.press("id:chat-composer-input");
  await app.keyboard.press("up");
  await app.waitUntil(() => app.value("id:chat-composer-input") === "Check the logs");
  await app.keyboard.press("enter");
  await app.waitUntil(() => posts.length === 1);
  expect(posts[0].json.task).toBe("Check the logs");
});

test("the composer follows the window: Enter sends while wide, is a new line while narrow", async () => {
  const posts: ApiRequest[] = [];
  const { app } = await openConsole({ location: "/e/default/chat/topic-1", api: chatApi(SENT, posts) });
  await app.waitFor("label:Send Task (Enter)");
  await app.setViewport(390, 844);
  await app.waitFor("label:Send Task");
  expect(app.shows("label:Send Task (Enter)")).toBe(false);
  await app.type("id:chat-composer-input", "one");
  await app.keyboard.press("enter");
  await app.keyboard.press("2");
  await app.waitUntil(() => app.value("id:chat-composer-input") === "one\n2");
  expect(posts.length).toBe(0);
  await app.setViewport(1280, 800);
  await app.waitFor("label:Send Task (Enter)");
  await app.press("id:chat-composer-input");
  await app.keyboard.press("enter");
  await app.waitUntil(() => posts.length === 1);
  expect(posts[0].json.task).toBe("one\n2");
});

test("a question's number keys and a panel's Escape act only where the shortcuts are on", async () => {
  // The fixture is a browser's page (no host): the window's width decides.
  const app = await open("./fixtures/shortcut-keys-app.tsx", { width: 390, height: 844, platform: "linux", locale: "en-US" });
  await app.waitFor("text:eligible:false");
  // The first choice has the keyboard focus. Its number does nothing; Enter presses it, as any button.
  await app.keyboard.press("tab");
  await app.keyboard.press("2");
  await app.keyboard.press("1");
  await app.keyboard.press("escape");
  await settle(app);
  expect(app.shows("text:answers:")).toBe(true);
  expect(app.shows("text:pane:open")).toBe(true);
  await app.keyboard.press("enter");
  await app.waitFor("text:answers:option:0");

  // Wide, with the same choice focused: the digits choose and Escape closes the panel.
  await app.setViewport(1280, 800);
  await app.waitFor("text:eligible:true");
  await app.keyboard.press("2");
  await app.waitFor("text:answers:option:0,option:1");
  await app.keyboard.press("escape");
  await app.waitFor("text:pane:closed");

  // Narrow again: off again.
  await app.setViewport(MOBILE_BREAKPOINT, 800);
  await app.waitFor("text:eligible:false");
  await app.keyboard.press("2");
  await settle(app);
  expect(app.shows("text:answers:option:0,option:1")).toBe(true);
});

/* ---------- the desktop app ---------- */

for (const [name, width, height] of [
  ["wide", 1280, 800],
  ["narrow", 390, 844],
] as const) {
  test(`the desktop app has the shortcuts at any width: ${name}`, async () => {
    const posts: ApiRequest[] = [];
    const options: ConsoleOptions = { runtime: "desktop", width, height, api: chatApi(SENT, posts) };
    const { app } = await openConsole({ ...options, location: "/e/default/chat/topic-1" });
    await app.waitFor("text:Logs are fine.");
    expect(app.shows("label:Send Task (Enter)")).toBe(true);
    await app.press("id:chat-composer-input");
    await app.keyboard.press("up");
    await app.waitUntil(() => app.value("id:chat-composer-input") === "Check the logs");
    await app.keyboard.press("enter");
    await app.waitUntil(() => posts.length === 1);
    await app.keyboard.press("ctrl+3");
    await app.waitUntil(() => location(app) === "/e/default/todo");
    await app.keyboard.press("shift+/");
    await app.waitUntil(() => location(app) === SHORTCUTS);
    await app.waitFor("id:settings-shortcuts");

    // Its address opens the section itself, and the section is listed.
    const direct = await openConsole({ ...options, location: SHORTCUTS });
    await direct.app.waitFor("id:settings-shortcuts");
    await settle(direct.app);
    expect(location(direct.app)).toBe(SHORTCUTS);
    const sections = await openConsole({ ...options, location: SECTIONS });
    await sections.app.waitFor("id:settings-section-shortcuts");
  });
}

test("the desktop app keeps the shortcuts while its window is resized", async () => {
  const { app } = await openConsole({ runtime: "desktop", location: SHORTCUTS, api: chatApi(EMPTY) });
  await app.waitFor("id:settings-shortcuts");
  // Narrow, Settings shows its sections (as for any section): Keyboard shortcuts is still one, at
  // its address, and opens.
  await app.setViewport(390, 844);
  await settle(app);
  expect(location(app)).toBe(SHORTCUTS);
  expect(app.shows("id:settings-section-shortcuts")).toBe(true);
  await app.press("id:settings-section-shortcuts");
  await app.waitFor("id:settings-shortcuts");
  await app.setViewport(1280, 800);
  await settle(app);
  expect(app.shows("id:settings-shortcuts")).toBe(true);
  await app.setViewport(390, 844);
  await app.keyboard.press("ctrl+3");
  await app.waitUntil(() => location(app) === "/e/default/todo");
});

/* ---------- the phone app ---------- */

/** The phone app with `keyboard` as its native part's word (none: no native part), on the sections of Settings. */
async function openPhoneApp(options: ConsoleOptions = {}) {
  const opened = await openConsole({ platform: "android", location: SECTIONS, api: chatApi(SENT), ...options });
  await opened.app.waitFor("id:settings-section-general");
  return opened;
}

/** Nothing of the shortcuts: no section, no acting key. The app stays where it is. */
async function expectOff(app: App) {
  const before = location(app);
  expect(app.shows("id:settings-section-shortcuts")).toBe(false);
  await app.keyboard.press("ctrl+3");
  await app.keyboard.press("shift+/");
  await settle(app);
  expect(location(app)).toBe(before);
  expect(app.shows("id:settings-shortcuts")).toBe(false);
}

test("the phone app without a hardware keyboard has no shortcuts: disconnected, unknown, no native part", async () => {
  await expectOff((await openPhoneApp({ keyboard: "disconnected" })).app);
  await expectOff((await openPhoneApp({ keyboard: "unknown" })).app);
  // An APK without the native part (and the iOS app): nothing answers.
  await expectOff((await openPhoneApp()).app);
  // An answer that is not the contract's.
  await expectOff((await openPhoneApp({ host: { "morph.keyboard.state": { physical: true } } })).app);
  await expectOff((await openPhoneApp({ host: { "morph.keyboard.state": "connected" } })).app);
  await expectOff((await openPhoneApp({ host: { "morph.keyboard.state": null } })).app);
  // A tablet's width changes nothing: the keyboard decides, not the layout.
  await expectOff((await openPhoneApp({ keyboard: "disconnected", width: 1280, height: 800 })).app);
  await expectOff((await openPhoneApp({ width: 1280, height: 800 })).app);
});

test("the phone app's address of the shortcuts opens the sections without a keyboard", async () => {
  for (const keyboard of ["disconnected", "unknown", undefined] as const) {
    const { app } = await openConsole({ platform: "android", location: SHORTCUTS, api: chatApi(EMPTY), keyboard });
    await app.waitFor("id:settings-section-general");
    await app.waitUntil(() => location(app) === SECTIONS);
    expect(app.shows("id:settings-shortcuts")).toBe(false);
    expect(app.shows("id:settings-section-shortcuts")).toBe(false);
  }
});

test("the phone app with a hardware keyboard has the shortcuts, at a phone's width and a tablet's", async () => {
  for (const [width, height] of [
    [390, 844],
    [1280, 800],
  ]) {
    const { app } = await openPhoneApp({ keyboard: "connected", width, height });
    await app.waitFor("id:settings-section-shortcuts");
    // The apps' defaults.
    await app.keyboard.press("ctrl+3");
    await app.waitUntil(() => location(app) === "/e/default/todo");
    await app.keyboard.press("shift+/");
    await app.waitUntil(() => location(app) === SHORTCUTS);
    await app.waitFor("id:settings-shortcuts");
    const direct = await openConsole({ platform: "android", location: SHORTCUTS, api: chatApi(EMPTY), keyboard: "connected", width, height });
    await direct.app.waitFor("id:settings-shortcuts");
  }
});

test("connecting and taking away a keyboard turns the phone app's shortcuts on and off at once", async () => {
  const { app } = await openPhoneApp({ keyboard: "disconnected" });
  await expectOff(app);

  await app.host.send("morph.keyboard.changed", { physical: "connected" });
  await app.waitFor("id:settings-section-shortcuts");
  await app.press("id:settings-section-shortcuts");
  await app.waitFor("id:settings-shortcuts");
  await app.waitUntil(() => location(app) === SHORTCUTS);

  // Taken away with the section open: back to the sections, and its keys are dead.
  await app.host.send("morph.keyboard.changed", { physical: "disconnected" });
  await app.waitFor("id:settings-shortcuts", { state: "gone" });
  await app.waitFor("id:settings-section-general");
  await app.waitUntil(() => location(app) === SECTIONS);
  await expectOff(app);

  // An event that says nothing clear is no keyboard either.
  await app.host.send("morph.keyboard.changed", { physical: "connected" });
  await app.waitFor("id:settings-section-shortcuts");
  await app.host.send("morph.keyboard.changed", { physical: "maybe" });
  await app.waitFor("id:settings-section-shortcuts", { state: "gone" });
  await expectOff(app);
  await app.host.send("morph.keyboard.changed", { physical: "connected" });
  await app.waitFor("id:settings-section-shortcuts");
  await app.host.send("morph.keyboard.changed", null);
  await app.waitFor("id:settings-section-shortcuts", { state: "gone" });
  await expectOff(app);

  await app.host.send("morph.keyboard.changed", { physical: "connected" });
  await app.waitFor("id:settings-section-shortcuts");
  await app.keyboard.press("ctrl+3");
  await app.waitUntil(() => location(app) === "/e/default/todo");
});

test("coming back to the phone app asks the native part again", async () => {
  const { native, host } = nativeKeyboard({ physical: "disconnected" });
  const { app } = await openPhoneApp({ host });
  expect(native.asked).toBe(1);
  await expectOff(app);

  // A keyboard connected while the app was away, with no event heard.
  await app.setLifecycle("background");
  native.answer = { physical: "connected" };
  expect(native.asked).toBe(1);
  await app.setLifecycle("active");
  await app.waitFor("id:settings-section-shortcuts");
  expect(native.asked).toBe(2);
  await app.keyboard.press("ctrl+3");
  await app.waitUntil(() => location(app) === "/e/default/todo");

  // Taken away while away.
  await app.setLifecycle("background");
  native.answer = { physical: "disconnected" };
  await app.setLifecycle("active");
  await app.waitUntil(() => native.asked === 3);
  await app.keyboard.press("ctrl+,");
  await settle(app);
  expect(location(app)).toBe("/e/default/todo");

  // A permission question (inactive, then active) asks again as well.
  native.answer = { physical: "connected" };
  await app.setLifecycle("inactive");
  await app.setLifecycle("active");
  await app.waitUntil(() => native.asked === 4);
  await app.keyboard.press("ctrl+,");
  await app.waitUntil(() => location(app) === SECTIONS);
  await app.waitFor("id:settings-section-shortcuts");

  // The native part fails when asked: unknown, so off, though a keyboard was there before.
  native.fails = true;
  await app.setLifecycle("background");
  await app.setLifecycle("active");
  await app.waitFor("id:settings-section-shortcuts", { state: "gone" });
  await expectOff(app);

  // And it answers again later.
  native.fails = false;
  await app.setLifecycle("background");
  await app.setLifecycle("active");
  await app.waitFor("id:settings-section-shortcuts");
});

test("an app without the native part never asks again, and hears no keyboard events", async () => {
  const { app } = await openPhoneApp();
  await app.setLifecycle("background");
  await app.setLifecycle("active");
  await app.host.send("morph.keyboard.changed", { physical: "connected" });
  await settle(app);
  await expectOff(app);
});

test("the phone app's composer: Enter sends and Up recalls only with a hardware keyboard", async () => {
  const posts: ApiRequest[] = [];
  const { app } = await openConsole({ platform: "android", location: "/e/default/chat/topic-1", api: chatApi(SENT, posts), keyboard: "disconnected" });
  await app.waitFor("text:Logs are fine.");
  expect(app.shows("label:Send Task")).toBe(true);
  expect(app.shows("label:Send Task (Enter)")).toBe(false);
  await app.press("id:chat-composer-input");
  await app.keyboard.press("up");
  await settle(app);
  expect(app.value("id:chat-composer-input")).toBe("");
  await app.type("id:chat-composer-input", "one");
  await app.keyboard.press("enter");
  await app.keyboard.press("2");
  await app.waitUntil(() => app.value("id:chat-composer-input") === "one\n2");
  expect(posts.length).toBe(0);

  await app.host.send("morph.keyboard.changed", { physical: "connected" });
  await app.waitFor("label:Send Task (Enter)");
  await app.keyboard.press("enter");
  await app.waitUntil(() => posts.length === 1);
  expect(posts[0].json.task).toBe("one\n2");
  await app.waitUntil(() => app.value("id:chat-composer-input") === "");
  await app.press("id:chat-composer-input");
  await app.keyboard.press("up");
  await app.waitUntil(() => app.value("id:chat-composer-input") !== "");

  await app.host.send("morph.keyboard.changed", { physical: "disconnected" });
  await app.waitFor("label:Send Task");
  expect(app.shows("label:Send Task (Enter)")).toBe(false);
});
