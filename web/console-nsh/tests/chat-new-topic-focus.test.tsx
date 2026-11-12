// A new topic opens with its composer focused (chatController's focusComposerOnEntry). On the
// Android phone it slides in over the topic list, and the keyboard came up for a field without the
// focus. Two things took it: the slide's end moved the pane's native view among its siblings (a
// zIndex change), which takes the focus off a field inside it while Android keeps the keyboard up;
// and the focus was asked for before the new topic's view had rendered where that happens after
// the tap's handler (the web), so it went to a composer gone or not there yet. The pane that stays
// now keeps its zIndex (tests/pane-stack.test.tsx), and the focus is asked for once, a microtask
// later, and on the phone apps once the pane is in place.
//
// Headless runs render as the change is made, keep the focus in the core whatever native views
// move, and draw no keyboard: the field has the focus when a key typed lands in it. The native
// mount order (the focus after the slide's end, no move of the pane after it) was read from
// `nsh test --trace`, and both losses were seen and fixed in Chrome (FT102).
import type { App } from "nsh/test";
import { expect, test } from "nsh/test";
import { createEntryFocus } from "../pages/chat/entryFocus";
import { openConsole } from "./harness";

const NOW = new Date().toISOString();
const TOPICS = { body: { items: [{ id: "topic-1", title: "Ops", created_at: NOW, updated_at: NOW }] } };
const EMPTY = { body: { items: [] } };
/** A phone with gesture navigation: a 24pt status bar, a 16pt gesture handle. */
const BARS = { top: 24, right: 0, bottom: 16, left: 0 };

/** Whether the field has the focus (the keyboard is up): a key typed lands in it. */
async function fieldFocused(app: App) {
  const before = app.value("id:chat-composer-input") ?? "";
  await app.keyboard.press("`");
  const after = app.value("id:chat-composer-input") ?? "";
  if (after === before) return false;
  await app.keyboard.press("backspace");
  await app.waitUntil(() => app.value("id:chat-composer-input") === before);
  return true;
}

async function openTopicList(options: { platform?: "android"; width?: number } = {}) {
  const opened = await openConsole({
    location: "/e/default/chat",
    width: options.width ?? 390,
    height: 844,
    ...(options.platform ? { platform: options.platform, safeArea: BARS } : {}),
    api: { "GET /proxy:/topics": TOPICS, "GET /proxy:/tasks": EMPTY, "GET /proxy:/todo/tasks": EMPTY, "GET /proxy:/llm/profiles": EMPTY },
  });
  const { app } = opened;
  // A phone's list has the new-topic button floating at its foot; a wide window's sidebar its own.
  await app.waitFor((options.width ?? 390) > 900 ? "id:chat-topic-new" : "id:chat-topic-new-fab");
  // Past the page's arrival (PANE_ARRIVAL_MS): the conversation slides in as a user's tap sees it.
  await app.wait(600);
  return opened;
}

/** The conversation has slid in: the topic list going out is gone. */
async function slidIn(app: App) {
  await app.waitFor("id:chat-composer-input");
  await app.waitFor("id:chat-topic-sidebar", { state: "gone" });
}

test("on the Android phone a new topic focuses its composer once it has slid in over the topic list", async () => {
  const { app } = await openTopicList({ platform: "android" });
  await app.press("id:chat-topic-new-fab");
  await slidIn(app);
  await app.waitFor("id:chat-placeholder");
  expect(await fieldFocused(app)).toBe(true);
  await app.keyboard.press("shift+h");
  await app.keyboard.press("i");
  await app.waitUntil(() => app.value("id:chat-composer-input") === "Hi");
});

test("on the Android phone a new topic opened again keeps its draft, focused with the caret after it", async () => {
  const { app } = await openTopicList({ platform: "android" });
  await app.press("id:chat-topic-new-fab");
  await slidIn(app);
  await app.type("id:chat-composer-input", "half a thought");
  await app.back();
  await app.waitFor("id:chat-topic-sidebar");
  await app.waitFor("id:chat-composer-input", { state: "gone" });

  await app.press("id:chat-topic-new-fab");
  await slidIn(app);
  await app.waitUntil(() => app.value("id:chat-composer-input") === "half a thought");
  expect(await fieldFocused(app)).toBe(true);
  await app.keyboard.press("shift+1");
  await app.waitUntil(() => app.value("id:chat-composer-input") === "half a thought!");
});

test("on the Android phone the focus stays with the field as the viewport changes after it came", async () => {
  const { app } = await openTopicList({ platform: "android" });
  await app.press("id:chat-topic-new-fab");
  // A resize while the conversation slides in ends the slide at once (PaneStack).
  await app.setViewport(390, 600);
  await slidIn(app);
  expect(await fieldFocused(app)).toBe(true);
  await app.setViewport(390, 844);
  expect(await fieldFocused(app)).toBe(true);
});

test("on the Android phone a sheet opened while the new topic slides in keeps the keyboard down", async () => {
  const { app } = await openTopicList({ platform: "android" });
  await app.press("id:chat-topic-new-fab");
  // Tapped before the slide ends: the add menu, a sheet at the foot of the screen.
  await app.press("id:chat-composer-add");
  await app.waitFor("text:Upload Files");
  await slidIn(app);
  await app.wait(400);
  expect(await fieldFocused(app)).toBe(false);
  // Closed without a choice: the field had no focus when it opened, and gets none.
  await app.back();
  await app.waitFor("text:Upload Files", { state: "gone" });
  await app.wait(400);
  expect(await fieldFocused(app)).toBe(false);
});

test("on the Android phone going back while the new topic slides in drops its focus; the next one still gets it", async () => {
  const { app } = await openTopicList({ platform: "android" });
  await app.press("id:chat-topic-new-fab");
  await app.press("id:chat-back");
  await app.waitFor("id:chat-topic-sidebar");
  await app.waitFor("id:chat-composer-input", { state: "gone" });
  await app.wait(400);

  await app.press("id:chat-topic-new-fab");
  await slidIn(app);
  expect(await fieldFocused(app)).toBe(true);
});

test("on the Android phone opening a topic from the list still leaves its field unfocused", async () => {
  const { app } = await openTopicList({ platform: "android" });
  await app.press("id:chat-topic-topic-1");
  await slidIn(app);
  await app.wait(400);
  expect(await fieldFocused(app)).toBe(false);
});

test("in a narrow desktop window a new topic focuses its composer too", async () => {
  const { app } = await openTopicList();
  await app.press("id:chat-topic-new-fab");
  await slidIn(app);
  expect(await fieldFocused(app)).toBe(true);
});

test("in a wide desktop window a new topic focuses its composer, with nothing sliding", async () => {
  const { app } = await openTopicList({ width: 1280 });
  await app.press("id:chat-topic-new");
  await app.waitFor("id:chat-placeholder");
  expect(await fieldFocused(app)).toBe(true);
});

/* ---------- entryFocus.ts ---------- */

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test("an entry focus with nothing to wait for focuses at once", () => {
  let focused = 0;
  const entry = createEntryFocus(() => (focused += 1));
  entry.request(null, () => false);
  expect(focused).toBe(1);
});

test("an entry focus waits for the view to arrive, then focuses once if still wanted", async () => {
  let focused = 0;
  let wanted = true;
  const entry = createEntryFocus(() => (focused += 1));
  const arrived = deferred();
  entry.request(arrived.promise, () => wanted);
  await flush();
  expect(focused).toBe(0);
  arrived.resolve();
  await flush();
  expect(focused).toBe(1);

  // Not wanted any more when it arrives (the user went on): nothing, and nothing later.
  const again = deferred();
  entry.request(again.promise, () => wanted);
  wanted = false;
  again.resolve();
  await flush();
  wanted = true;
  await flush();
  expect(focused).toBe(1);
});

test("a newer entry focus or a cancel drops the one waiting; a failed arrival focuses nothing", async () => {
  let focused = 0;
  const entry = createEntryFocus(() => (focused += 1));
  const first = deferred();
  const second = deferred();
  entry.request(first.promise, () => true);
  entry.request(second.promise, () => true);
  first.resolve();
  await flush();
  expect(focused).toBe(0);
  second.resolve();
  await flush();
  expect(focused).toBe(1);

  const third = deferred();
  entry.request(third.promise, () => true);
  entry.cancel();
  third.resolve();
  await flush();
  expect(focused).toBe(1);

  const failed = deferred();
  entry.request(failed.promise, () => true);
  failed.reject(new Error("gone"));
  await flush();
  expect(focused).toBe(1);
});
