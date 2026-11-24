// Blurred glass (lib/glassPolicy.ts, lib/glass.ts, components/frame/glassBar.tsx): the composer's
// frame, the bars over scrolling lists and the phone's bottom navigation share one tint and one
// blur where the window draws glass, and are opaque where it does not (no `backdrop-filter`, the
// reader asked for less transparency, Android before 12, the desktop app). A glass bar's scroller
// runs on under the bar and starts with the bar's room, so nothing moves at the top of a list; a
// window without glass is laid out exactly as before. Headless nsh has no style query: the look is
// checked on the classes and style the surfaces draw with, the layout on frames, and the real
// pages on the marks the surfaces carry (`bar-room-<pt>`, `chat-composer-frame.glass`,
// `mobile-nav-capsule.glass`).
import type { App } from "nsh/test";
import { expect, open, test } from "nsh/test";
import { browserBackdropFilter, GLASS_BLUR, GLASS_TINT, glassAvailable, glassFill } from "../lib/glassPolicy";
import { composerFrameClass } from "../components/chat/composerField";
import { openConsole } from "./harness";

type Frame = { x: number; y: number; w: number; h: number };
interface Report {
  enabled: boolean;
  bar: string;
  nav: string;
  composer: string;
  composerFrame: string;
  style: { backdropFilter?: string };
  barClass: string;
  room: number;
  frames: Record<string, Frame>;
}

/* ---------- the policy ---------- */

test("glass is drawn only where the window blurs a backdrop", () => {
  // A browser: by `backdrop-filter`.
  expect(glassAvailable({ os: "web", backdropFilter: true })).toBe(true);
  expect(glassAvailable({ os: "web", backdropFilter: false })).toBe(false);
  expect(glassAvailable({ os: "web" })).toBe(false);
  // Android: from API 31, where nsh draws the blur.
  expect(glassAvailable({ os: "android", version: "31" })).toBe(true);
  expect(glassAvailable({ os: "android", version: "35" })).toBe(true);
  expect(glassAvailable({ os: "android", version: "30" })).toBe(false);
  expect(glassAvailable({ os: "android", version: "" })).toBe(false);
  expect(glassAvailable({ os: "android" })).toBe(false);
  expect(glassAvailable({ os: "ios", version: "17.5" })).toBe(true);
  // The desktop app's renderer draws no backdrop blur.
  for (const os of ["linux", "macos", "windows"]) expect(glassAvailable({ os, backdropFilter: true })).toBe(false);
});

test("a reader who asked for less transparency gets opaque surfaces everywhere", () => {
  expect(glassAvailable({ os: "web", backdropFilter: true, reducedTransparency: true })).toBe(false);
  expect(glassAvailable({ os: "android", version: "35", reducedTransparency: true })).toBe(false);
  expect(glassAvailable({ os: "ios", reducedTransparency: true })).toBe(false);
});

test("a browser is asked for backdrop-filter, by its prefixed name too", () => {
  const asked: string[] = [];
  const css = (known: string[]) => ({
    supports: (property: string, value: string) => {
      asked.push(`${property}: ${value}`);
      return known.includes(property);
    },
  });
  expect(browserBackdropFilter({ CSS: css(["backdrop-filter"]) })).toBe(true);
  expect(browserBackdropFilter({ CSS: css(["-webkit-backdrop-filter"]) })).toBe(true);
  expect(browserBackdropFilter({ CSS: css([]) })).toBe(false);
  expect(asked).toContain("backdrop-filter: blur(1px)");
  // No CSS object (a window that is not a browser), or one that throws.
  expect(browserBackdropFilter({})).toBe(false);
  expect(browserBackdropFilter({ CSS: {} })).toBe(false);
  expect(
    browserBackdropFilter({
      CSS: {
        supports: () => {
          throw new Error("no");
        },
      },
    }),
  ).toBe(false);
});

test("the surfaces share one tint, and are opaque without glass", () => {
  expect(glassFill("bar", true)).toBe(`bg-paper/${GLASS_TINT}`);
  expect(glassFill("nav", true)).toBe(`bg-card/${GLASS_TINT}`);
  expect(glassFill("composer", true)).toBe(`bg-dialog/${GLASS_TINT}`);
  // The tint keeps most of the fill, so text on it stays readable over busy content.
  expect(GLASS_TINT).toBeGreaterThanOrEqual(70);
  expect(GLASS_TINT).toBeLessThan(100);
  // Without glass: the navigation's card, opaque (no tint with nothing blurred behind it); the
  // composer's own field fill; a bar adds nothing to the page's paper.
  expect(glassFill("nav", false)).toBe("bg-card");
  expect(glassFill("composer", false)).toBe("bg-field");
  expect(glassFill("bar", false)).toBe("");
  for (const surface of ["bar", "nav", "composer"] as const) expect(glassFill(surface, false)).not.toContain("/");
});

test("the composer's frame changes only its fill for glass", () => {
  for (const mobile of [true, false]) {
    const plain = composerFrameClass(mobile).split(" ");
    const glass = composerFrameClass(mobile, true).split(" ");
    expect(plain).toContain("bg-field");
    expect(glass).toContain(`bg-dialog/${GLASS_TINT}`);
    expect(glass).not.toContain("bg-field");
    // The border, the radius, the focus shadow and its easing are the same.
    expect(glass.filter((name) => !name.startsWith("bg-"))).toEqual(plain.filter((name) => !name.startsWith("bg-")));
  }
});

/* ---------- the surfaces and the bars, laid out ---------- */

/** The index search's box under a column's head: its field (44pt in the phone layout, 38 on a desktop) and its 6 + 2pt spacing. */
const SEARCH_BOX = 52;
const DESKTOP_SEARCH_BOX = 46;
/** No scroller starts with a bar's room (selectors match whole test ids). */
const noBarRoom = (app: App) => [57, 57 + SEARCH_BOX, 57 + DESKTOP_SEARCH_BOX].every((room) => !app.shows(`id:bar-room-${room}`));

async function openSurfaces(platform: "linux" | "android" = "linux") {
  const app = await open("./fixtures/glass-surfaces-app.tsx", { width: 900, height: 600, platform, locale: "en-US" });
  const read = () => JSON.parse(app.texts().find((text) => text.startsWith('{"enabled"')) ?? "{}") as Report;
  const needed = ["bare-bar", "bare-scroll", "bare-first", "page", "page-row", "index", "index-row", "detail", "detail-row"];
  await app.waitUntil(() => needed.every((name) => Boolean(read().frames?.[name])));
  await app.wait(100);
  return { app, read };
}

async function setGlass(app: App, read: () => Report, on: boolean) {
  await app.press(on ? "id:glass-on" : "id:glass-off");
  await app.waitUntil(() => read().enabled === on);
  await app.wait(150);
  return read();
}

test("a window that draws no glass keeps every surface opaque and every list under its bar", async () => {
  const { app, read } = await openSurfaces();
  // The headless desktop window: no glass on its own.
  expect(read().enabled).toBe(false);
  const off = await setGlass(app, read, false);
  expect(off.style).toEqual({});
  expect(off.nav).toBe("bg-card");
  expect(off.composer).toBe("bg-field");
  expect(off.bar).toBe("");
  expect(off.barClass).toBe("");
  expect(off.room).toBe(0);
  expect(noBarRoom(app)).toBe(true);
  // The scroller starts at its bar's foot.
  expect(Math.abs(off.frames["bare-scroll"].y - 57)).toBeLessThan(0.5);
  expect(Math.abs(off.frames["bare-scroll"].h - (400 - 57))).toBeLessThan(0.5);
  expect(Math.abs(off.frames["bare-first"].y)).toBeLessThan(0.5);
});

test("with glass the surfaces take the tint and the blur, and only their backdrop blurs", async () => {
  const { app, read } = await openSurfaces();
  const on = await setGlass(app, read, true);
  expect(on.style).toEqual({ backdropFilter: `blur(${GLASS_BLUR}px)` });
  expect(on.bar).toBe(`bg-paper/${GLASS_TINT}`);
  expect(on.nav).toBe(`bg-card/${GLASS_TINT}`);
  expect(on.composer).toBe(`bg-dialog/${GLASS_TINT}`);
  expect(on.composerFrame.split(" ")).toContain(`bg-dialog/${GLASS_TINT}`);
  // A bar is above the scroller pulled under it.
  expect(on.barClass.split(" ")).toEqual(["relative", "z-10", `bg-paper/${GLASS_TINT}`]);
  // No surface dims or blurs what it holds: no `opacity`, no `filter` on the surface itself.
  for (const classes of [on.bar, on.nav, on.composer, on.barClass, on.composerFrame]) {
    expect(/(^| )opacity-|(^| )blur|backdrop-opacity/.test(classes)).toBe(false);
  }
  expect(Object.keys(on.style)).toEqual(["backdropFilter"]);
});

test("a glass bar's list runs on under the bar, and nothing moves at the top of the list", async () => {
  const { app, read } = await openSurfaces();
  const off = await setGlass(app, read, false);
  const on = await setGlass(app, read, true);
  expect(on.room).toBe(57);
  // The scroller is pulled up behind the bar and is that much taller; the bar stays where it was.
  expect(Math.abs(on.frames["bare-scroll"].y)).toBeLessThan(0.5);
  expect(Math.abs(on.frames["bare-scroll"].h - 400)).toBeLessThan(0.5);
  expect(on.frames["bare-bar"]).toEqual(off.frames["bare-bar"]);
  // Its content starts with the bar's room: the first row lies at the bar's foot, as before.
  expect(Math.abs(on.frames["bare-first"].y - 57)).toBeLessThan(0.5);
  // The real bars: a Page that scrolls as one, an index column (its head and the search under it
  // are one bar), a phone's MobileBar. Each first row is where it was without glass.
  for (const name of ["page", "index", "detail"]) {
    expect(on.frames[name]).toEqual(off.frames[name]);
    expect(Math.abs(on.frames[`${name}-row`].y - off.frames[`${name}-row`].y)).toBeLessThan(0.5);
    expect(Math.abs(on.frames[`${name}-row`].x - off.frames[`${name}-row`].x)).toBeLessThan(0.5);
    // Below its bar.
    expect(on.frames[`${name}-row`].y).toBeGreaterThanOrEqual(on.frames[name].y + 57);
  }
  expect(app.count("id:bar-room-57")).toBe(3);
  // The index column's room is its head and its search together.
  expect(app.count(`id:bar-room-${57 + SEARCH_BOX}`)).toBe(1);
  // Back without glass (a reader turning "reduce transparency" on): the rooms go, the rows stay.
  const again = await setGlass(app, read, false);
  expect(noBarRoom(app)).toBe(true);
  for (const name of ["page", "index", "detail"]) expect(Math.abs(again.frames[`${name}-row`].y - off.frames[`${name}-row`].y)).toBeLessThan(0.5);
  expect(again.frames["bare-scroll"]).toEqual(off.frames["bare-scroll"]);
});

/* ---------- the real pages ---------- */

const NOW = new Date().toISOString();
const TOPICS = { body: { items: Array.from({ length: 30 }, (_, i) => ({ id: `topic-${i + 1}`, title: `Topic ${i + 1}`, created_at: NOW, updated_at: NOW })) } };
const TASKS = {
  body: {
    items: Array.from({ length: 12 }, (_, i) => ({
      id: `t${i}`,
      task: `Question ${i}`,
      topic_id: "topic-3",
      status: "done",
      created_at: NOW,
      started_at: NOW,
      finished_at: NOW,
      result: { final: { output: `Answer ${i}. ${"More words of the answer. ".repeat(30)}` } },
    })),
  },
};
const API = { "GET /proxy:/topics": TOPICS, "GET /proxy:/tasks": TASKS };
const PHONE = { width: 390, height: 844 };

test("phone, glass: the topics' head, the bottom navigation, a conversation's bar and its composer", async () => {
  const { app } = await openConsole({ ...PHONE, glass: true, location: "/e/default/chat", api: API });
  await app.waitFor("id:chat-topic-topic-3");
  // The topic list runs on under its head; the navigation floats over it as glass.
  expect(app.count("id:bar-room-57")).toBe(1);
  expect(app.shows("id:mobile-nav-capsule.glass")).toBe(true);
  expect(app.shows("id:mobile-bottom-nav")).toBe(true);
  for (const slot of ["chat", "contacts", "todo", "more", "agent"]) expect(app.shows(`id:mobile-nav-${slot}`)).toBe(true);
  // An open topic: the history runs on under the bar (its own top room) and behind the composer.
  await app.press("id:chat-topic-topic-3");
  await app.waitFor("id:chat-composer-frame.glass");
  expect(app.shows("id:chat-back")).toBe(true);
  expect(app.shows("id:chat-composer-input")).toBe(true);
  expect(app.shows("id:chat-composer-send")).toBe(true);
  // The fade under the composer is solid only below the frame (its footer line), once measured.
  await app.waitFor("id:chat-composer-float.glass");
  // The field still takes text.
  await app.type("id:chat-composer-input", "hello");
  expect(app.shows("id:chat-composer-frame.glass")).toBe(true);
});

test("phone, no glass: the same pages keep their opaque surfaces and their old layout", async () => {
  const { app } = await openConsole({ ...PHONE, location: "/e/default/chat", api: API });
  await app.waitFor("id:chat-topic-topic-3");
  expect(noBarRoom(app)).toBe(true);
  expect(app.shows("id:mobile-nav-capsule")).toBe(true);
  expect(app.shows("id:mobile-nav-capsule.glass")).toBe(false);
  await app.press("id:chat-topic-topic-3");
  await app.waitFor("id:chat-composer-frame");
  expect(app.shows("id:chat-composer-frame.glass")).toBe(false);
  expect(app.shows("id:chat-composer-float")).toBe(true);
});

test("desktop, glass: the second column's heads are glass over their lists", async () => {
  const { app } = await openConsole({ glass: true, location: "/e/default/chat/topic-3", api: API });
  await app.waitFor("id:chat-topic-topic-3");
  await app.waitFor("id:chat-composer-frame.glass");
  // The Topics column's list runs on under its head; the conversation has no bar of its own.
  expect(app.count("id:bar-room-57")).toBe(1);
  // No bottom navigation on a wide window.
  expect(app.shows("id:mobile-bottom-nav")).toBe(false);
  // Contacts, TODO and Settings: each list under its column's head (Settings' with its search).
  await app.press("id:nav-contacts");
  await app.waitFor("id:contacts-index");
  await app.waitUntil(() => app.count("id:bar-room-57") === 1);
  await app.press("id:nav-todo");
  await app.waitFor("id:todo-index");
  await app.waitUntil(() => app.count("id:bar-room-57") === 1);
  await app.press("id:nav-settings");
  await app.waitFor("id:settings-index");
  await app.waitUntil(() => app.count(`id:bar-room-${57 + DESKTOP_SEARCH_BOX}`) === 1);
  // A page that scrolls as one (Usage): its body runs on under the page's bar.
  await app.press("id:nav-stats");
  await app.waitFor("id:stats-page");
  await app.waitUntil(() => app.count("id:bar-room-57") === 1);
});

test("glass: a bar that lies over a toolbar and a framed table, not a list, stays as it was", async () => {
  const { app } = await openConsole({ glass: true, location: "/e/default/logs" });
  await app.waitFor("id:logs-page");
  await app.waitFor("id:logs-stream");
  await app.wait(200);
  expect(noBarRoom(app)).toBe(true);
});

test("Android: glass from Android 12 on, by the window's own answer", async () => {
  const { read } = await openSurfaces("android");
  const report = read();
  // The headless Android window reports its API level; the surfaces follow the policy for it.
  expect(typeof report.enabled).toBe("boolean");
  expect(report.nav).toBe(report.enabled ? `bg-card/${GLASS_TINT}` : "bg-card");
  expect(report.room).toBe(report.enabled ? 57 : 0);
});
