// The phone's workbench and the system's insets (components/frame/Workbench.tsx, lib/systemInsets.ts):
// on a phone the sheet runs to the bottom edge of the screen and takes the bottom inset (Android's
// gesture handle or navigation bar, a phone browser's home indicator) inside its own dark ink, so
// nothing of another colour shows under it and what it shows (Progress, also when it failed) stays
// above the system's controls. The inset is taken once: on Android the frame never takes the bottom
// on phones, the foot of the page's column does while the sheet is shut (`frame-foot-<pt>`) and
// gives it to the sheet while it is open, so the room above it stays the same; the frame keeps its
// top and side insets (the sheet takes none of them there), while a browser's side insets past the
// sheet's 8pt margin are the sheet's. Closing gives the bottom back to the column. Wide windows and
// phones without insets are as before. Headless runs report no frames, so the sheet's padding is in
// its testID (`workbench-sheet.bottom-<pt>.sides-<left>-<right>`); the keyboard (none headless) is
// checked on the numbers in tests/android.test.tsx.
import type { App, SafeArea } from "nsh/test";
import { expect, test } from "nsh/test";
import { openConsole, type ApiRequest } from "./harness";

const NOW = new Date().toISOString();
const CHAT = "/e/default/chat/topic-1";
const TOPICS = { body: { items: [{ id: "topic-1", title: "Ops", created_at: NOW, updated_at: NOW }] } };
const NO_WORKSPACE = { body: { workspace: { workspace_dir: "", source: "none" } } };

const DONE = {
  id: "t1",
  task: "Clean the disk",
  topic_id: "topic-1",
  created_at: NOW,
  started_at: NOW,
  finished_at: NOW,
  status: "done",
  result: { final: { output: "All done." }, activity: { history: [{ id: "a1", kind: "tool", name: "bash", status: "done", args: { cmd: "du -sh" } }] } },
};
const FAILED = {
  ...DONE,
  status: "failed",
  error: "disk full",
  result: { activity: { history: [{ id: "a1", kind: "tool", name: "bash", status: "failed", args: { cmd: "rm -rf /tmp/x" }, error: "permission denied" }] } },
};

function api(task: unknown) {
  return {
    "GET /proxy:/topics": TOPICS,
    "GET /proxy:/tasks": (request: ApiRequest) => ({ body: { items: request.uri?.includes("topic_id=topic-1") ? [task] : [] } }),
    "GET /proxy:/topic/topic-1/metadata": NO_WORKSPACE,
  };
}

/** Android phones: gesture navigation (24pt status bar, 16pt handle), and button navigation (48pt bar). */
const GESTURE = { top: 24, right: 0, bottom: 16, left: 0 };
const BUTTONS = { top: 24, right: 0, bottom: 48, left: 0 };
/** Android on its side, button navigation: the bar on the right, a cutout on the left. */
const SIDEWAYS = { top: 24, right: 48, bottom: 0, left: 32 };
/** A phone browser upright (home indicator), and on its side (cutout on both sides, a shorter indicator). */
const UPRIGHT = { top: 47, right: 0, bottom: 34, left: 0 };
const ON_ITS_SIDE = { top: 0, right: 47, bottom: 21, left: 47 };
const NONE = { top: 0, right: 0, bottom: 0, left: 0 };

/** The column's foot (0 tall, so never shown, when nothing is kept there). */
const foot = (app: App) => [16, 48].find((pt) => app.count(`id:frame-foot-${pt}`) > 0) ?? 0;

const sheet = (bottom: number, left = 0, right = 0) => `id:workbench-sheet.bottom-${bottom}.sides-${left}-${right}`;

async function openChat(options: { android: boolean; safeArea: SafeArea; width?: number; height?: number; task?: unknown }) {
  const { app } = await openConsole({
    ...(options.android ? { platform: "android" as const } : {}),
    safeArea: options.safeArea,
    width: options.width ?? 390,
    height: options.height ?? 844,
    location: CHAT,
    api: api(options.task ?? DONE),
  });
  await app.waitFor("id:chat-status-card");
  return app;
}

/** Opens Progress in the workbench; it shows inside the sheet with the given padding. */
async function openProgress(app: App, padding: string) {
  await app.press("id:chat-status-activity");
  await app.waitFor("id:workbench >> id:chat-detail-activity");
  expect(app.count(padding)).toBe(1);
  expect(app.shows(`id:workbench >> ${padding} >> id:chat-detail-panel`)).toBe(true);
}

async function closeProgress(app: App) {
  await app.press("id:chat-detail-close");
  await app.waitFor("id:chat-detail-panel", { state: "gone" });
  await app.waitFor("id:workbench", { state: "gone" });
}

for (const [name, safeArea, inset] of [
  ["gesture navigation", GESTURE, 16],
  ["button navigation", BUTTONS, 48],
] as const) {
  test(`on an Android phone with ${name} the open workbench takes the bottom inset from the column's foot, and gives it back`, async () => {
    const app = await openChat({ android: true, safeArea });
    // An open topic: no navigation strip; the column's foot keeps the page above the bar, the frame
    // only the status bar (its bottom stays 0 throughout, so the room above the sheet never moves).
    await app.waitUntil(() => foot(app) === inset);
    expect(app.count("id:app-frame.bottom-0")).toBe(1);
    await openProgress(app, sheet(inset));
    expect(app.shows("id:chat-detail-panel >> text:du -sh")).toBe(true);
    await app.waitUntil(() => foot(app) === 0);
    expect(app.count("id:app-frame.bottom-0")).toBe(1);
    await closeProgress(app);
    await app.waitUntil(() => foot(app) === inset);
    expect(app.count("id:app-frame.bottom-0")).toBe(1);
    // Again, and Back closes it the same way.
    await openProgress(app, sheet(inset));
    await app.waitUntil(() => foot(app) === 0);
    await app.back();
    await app.waitFor("id:workbench", { state: "gone" });
    await app.waitUntil(() => foot(app) === inset);
  });
}

test("on an Android phone failed progress shows in the same sheet, above the bar", async () => {
  const app = await openChat({ android: true, safeArea: BUTTONS, task: FAILED });
  await openProgress(app, sheet(48));
  expect(app.shows("id:chat-detail-panel >> text:rm -rf /tmp/x")).toBe(true);
  await app.waitUntil(() => foot(app) === 0);
});

test("on an Android phone on its side the frame keeps the side insets: the sheet takes none", async () => {
  const app = await openChat({ android: true, safeArea: SIDEWAYS, width: 844, height: 390 });
  await openProgress(app, sheet(0));
  expect(foot(app)).toBe(0);
  expect(app.count("id:app-frame.bottom-0")).toBe(1);
});

test("on an Android phone without insets nothing is added anywhere", async () => {
  const app = await openChat({ android: true, safeArea: NONE });
  expect(foot(app)).toBe(0);
  await openProgress(app, sheet(0));
  expect(foot(app)).toBe(0);
  expect(app.count("id:app-frame.bottom-0")).toBe(1);
});

for (const [name, safeArea, width, height, padding] of [
  ["upright, over the home indicator", UPRIGHT, 390, 844, sheet(34)],
  ["on its side, clear of the cutouts", ON_ITS_SIDE, 844, 390, sheet(21, 39, 39)],
  ["without insets, as before", NONE, 390, 844, sheet(0)],
] as const) {
  test(`in a phone browser ${name}, the workbench takes the insets inside its ink`, async () => {
    const app = await openChat({ android: false, safeArea, width, height });
    await openProgress(app, padding);
    // The web's frame takes no inset (only the keyboard's height): no foot, no frame padding.
    expect(foot(app)).toBe(0);
    expect(app.count("id:app-frame.bottom-0")).toBe(1);
    await closeProgress(app);
    await openProgress(app, padding);
  });
}

test("on a wide window the workbench takes no inset, whatever the window reports", async () => {
  const app = await openChat({ android: false, safeArea: UPRIGHT, width: 1280, height: 800 });
  await openProgress(app, sheet(0));
  expect(foot(app)).toBe(0);
});
