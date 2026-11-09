// The chat's topic and workspace panel on phones, a sheet from the right: its segmented tabs span
// the 57pt row in equal halves, and on Android the sheet (an Overlay outside the app's frame)
// keeps its tabs and content out from under the status bar and the navigation bar by itself, once.
// The wide window's panel row keeps its layout. Frames come from tests/fixtures/workspace-sheet-app.tsx;
// the rest runs the whole console (lib/systemInsets.ts, pages/chat/WorkspacePanel.tsx).
import type { App, SafeArea } from "nsh/test";
import { expect, open, test } from "nsh/test";
import { rightSheetInsets } from "../lib/systemInsets";
import { openConsole } from "./harness";

type Frame = { x: number; y: number; w: number; h: number; px?: number; py?: number };

/** A phone with gesture navigation: a 24pt status bar, a 16pt gesture handle. */
const BARS = { top: 24, right: 0, bottom: 16, left: 0 };
const NOW = new Date().toISOString();
const topic = (id: string, title: string) => ({ id, title, created_at: NOW, updated_at: NOW });
const QUIET = { "GET /proxy:/todo/tasks": { body: { items: [] } }, "GET /proxy:/tasks": { body: { items: [] } } };

async function openGallery(options: { platform: "android" | "linux"; safeArea?: SafeArea }) {
  const app = await open("./fixtures/workspace-sheet-app.tsx", { width: 390, height: 844, locale: "en-US", ...options });
  const frames = () => JSON.parse(app.texts().find((text) => text.startsWith("{")) ?? "{}") as Record<string, Frame>;
  const placed = (name: string) => frames()[name]?.py !== undefined;
  await app.waitUntil(() => ["page", "sheet-body", "phone-row", "wide-row"].every(placed) && Boolean(frames()["phone-tab-workspace"]));
  return { app, frames };
}

const near = (actual: number, expected: number) => expect(Math.abs(actual - expected)).toBeLessThan(0.5);

for (const [name, safeArea, top, bottom] of [
  ["a status bar and a gesture handle", BARS, 24, 16],
  ["no insets", undefined, 0, 0],
] as const) {
  test(`on Android with ${name} the sheet keeps out from under the system bars once`, async () => {
    const { frames } = await openGallery({ platform: "android", safeArea });
    const f = frames();
    // The frame moves the page below the status bar...
    near(f.page.py!, top);
    // ...but the sheet covers the whole surface: its own padding takes the status bar, so its
    // tabs start right under it, not under the frame's inset again (2 × top) nor under the bar (0).
    near(f["sheet-body"].y, top);
    near(f["sheet-body"].py!, top);
    near(f["phone-row"].py!, top);
    // And at the bottom it keeps above the gesture handle.
    near(f["sheet-body"].h, 844 - top - bottom);
  });
}

test("off Android the sheet adds no inset", async () => {
  const { frames } = await openGallery({ platform: "linux" });
  near(frames().page.py!, 0);
  near(frames()["sheet-body"].py!, 0);
  near(frames()["sheet-body"].h, 844);
});

test("the sheet's tabs are a 57pt row with the segmented control across it in equal halves", async () => {
  const { frames } = await openGallery({ platform: "android", safeArea: BARS });
  const f = frames();
  const row = f["phone-row"];
  const topicTab = f["phone-tab-topic"];
  const workspaceTab = f["phone-tab-workspace"];
  // As tall as a page's bar, as wide as the sheet.
  near(row.h, 57);
  near(row.w, f["sheet-body"].w);
  // The options share the control (the row less its 16pt gutters, the 1pt outline and 2pt inset)
  // equally, end to end: no part of the outlined box is a dead area.
  const inner = row.w - 32 - 2 - 4;
  near(topicTab.w, inner / 2);
  near(workspaceTab.w, inner / 2);
  near(topicTab.x, 3);
  near(workspaceTab.x, topicTab.x + topicTab.w);
  // The 32pt options sit in the middle of the 38pt control, itself in the middle of the row.
  near(topicTab.h, 32);
  near(workspaceTab.y, topicTab.y);
  near(topicTab.y, 3);
});

test("the wide window's panel row keeps its layout: low in its row, options as wide as their labels", async () => {
  const { frames } = await openGallery({ platform: "linux", safeArea: undefined });
  const f = frames();
  // 8pt above the 38pt control, nothing below.
  near(f["wide-row"].h, 46);
  near(f["wide-tab-topic"].y, 3);
  near(f["wide-tab-topic"].x, 3);
  near(f["wide-tab-workspace"].x, f["wide-tab-topic"].x + f["wide-tab-topic"].w);
  // Not stretched: each option fits its label.
  expect(f["wide-tab-workspace"].w).toBeGreaterThan(f["wide-tab-topic"].w);
  expect(f["wide-tab-topic"].w + f["wide-tab-workspace"].w).toBeLessThan(314 - 24 - 38 - 8 - 6);
});

test("a press on a sheet's tab selects it, and the selected label is the ink one", async () => {
  const { app } = await openGallery({ platform: "android", safeArea: BARS });
  const label = (name: string) => app.spanStyle(`id:phone-row >> role:tab[${name}] >> text:${name}`);
  const ink = label("Topic").color;
  const muted = label("Workspace").color;
  expect(ink).not.toBe(muted);
  expect(label("Topic").fontSize).toBe(14);
  await app.press("id:phone-row >> role:tab[Workspace]");
  await app.waitFor("text:Workspace body");
  expect(app.texts()).toContain("open=true tab=workspace presses=1");
  expect(label("Workspace").color).toBe(ink);
  expect(label("Topic").color).toBe(muted);
  await app.press("id:phone-row >> role:tab[Topic]");
  await app.waitFor("text:Topic body");
  expect(label("Topic").color).toBe(ink);
});

test("the right sheet's insets: the status bar, its side, the bottom bar or the keyboard; never its open side", () => {
  expect(rightSheetInsets(BARS, 0)).toEqual({ top: 24, right: 0, bottom: 16, left: 0 });
  // Zero or unreported insets: nothing at all.
  expect(rightSheetInsets({}, 0)).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
  expect(rightSheetInsets({ top: 0, right: 0, bottom: 0, left: 0 }, 0)).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
  // The keyboard covers the navigation bar: its height replaces the bottom inset.
  expect(rightSheetInsets(BARS, 300)).toEqual({ top: 24, right: 0, bottom: 300, left: 0 });
  // Landscape with button navigation: the bar at the right is the sheet's edge, the cutout at the
  // left is under the scrim.
  expect(rightSheetInsets({ top: 24, right: 48, bottom: 0, left: 32 }, 0)).toEqual({ top: 24, right: 48, bottom: 0, left: 0 });
  // Garbage from the platform is no room.
  expect(rightSheetInsets({ top: Number.NaN, bottom: -4 }, Number.NaN)).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
});

/* ---------- the whole console ---------- */

async function openTopic(app: App) {
  await app.waitFor("id:chat-workspace-toggle");
  await app.press("id:chat-workspace-toggle");
  await app.waitFor("id:chat-workspace-panel");
}

for (const safeArea of [BARS, undefined]) {
  test(`the Android phone's sheet opens, switches tabs and keeps them, closes and reopens (${safeArea ? "insets" : "no insets"})`, async () => {
    const { app } = await openConsole({
      platform: "android",
      safeArea,
      location: "/e/default/chat/topic-1",
      api: {
        ...QUIET,
        "GET /proxy:/topics": { body: { items: [topic("topic-1", "Ops")] } },
        "GET /proxy:/topic/topic-1/metadata": { body: { workspace: { workspace_dir: "", source: "none" } } },
      },
    });
    // A first open: the topic tab, with both tabs offered.
    await openTopic(app);
    expect(app.count("role:tab")).toBe(2);
    await app.waitFor("id:chat-topic-panel");
    // The workspace tab: nothing attached yet, and attaching is offered.
    await app.press("role:tab[Workspace]");
    await app.waitFor("No workspace attached");
    await app.waitFor("id:chat-workspace-attach");
    expect(app.shows("id:chat-topic-panel")).toBe(false);
    // Back closes the sheet, not the topic.
    await app.back();
    await app.waitFor("id:chat-workspace-panel", { state: "gone" });
    expect(app.shows("id:chat-back")).toBe(true);
    // Reopened, it is on the tab it was left on.
    await openTopic(app);
    await app.waitFor("id:chat-workspace-attach");
    await app.press("role:tab[Topic]");
    await app.waitFor("id:chat-topic-panel");
    await app.back();
    await app.waitFor("id:chat-workspace-panel", { state: "gone" });
  });
}

test("a TODO item's topic with no workspace has one tab in the sheet, and it works", async () => {
  const { app } = await openConsole({
    platform: "android",
    safeArea: BARS,
    location: "/e/default/chat/_cron_job1",
    api: {
      ...QUIET,
      "GET /proxy:/topics": { body: { items: [topic("_cron_job1", "Daily digest")] } },
      "GET /proxy:/topic/_cron_job1/metadata": { body: { workspace: { workspace_dir: "", source: "none" } } },
    },
  });
  await openTopic(app);
  await app.waitFor("id:chat-topic-panel");
  expect(app.count("role:tab")).toBe(1);
  await app.press("role:tab[Topic]");
  expect(app.shows("id:chat-topic-panel")).toBe(true);
  await app.back();
  await app.waitFor("id:chat-workspace-panel", { state: "gone" });
});

test("on a wide window the panel stays beside the conversation with its toggle in the tab row", async () => {
  const { app } = await openConsole({
    location: "/e/default/chat/topic-1",
    kv: { mistermorph_console_workspace_sidebar_open_v1: "true" },
    api: {
      ...QUIET,
      "GET /proxy:/topics": { body: { items: [topic("topic-1", "Ops")] } },
      "GET /proxy:/topic/topic-1/metadata": { body: { workspace: { workspace_dir: "", source: "none" } } },
    },
  });
  await app.waitFor("id:chat-workspace-panel");
  expect(app.count("role:tab")).toBe(2);
  expect(app.shows("id:chat-workspace-toggle")).toBe(true);
  await app.press("role:tab[Workspace]");
  await app.waitFor("No workspace attached");
  await app.press("id:chat-workspace-toggle");
  await app.waitFor("id:chat-workspace-panel", { state: "gone" });
  await app.press("id:chat-workspace-toggle");
  await app.waitFor("id:chat-workspace-panel");
  await app.waitFor("No workspace attached");
});
