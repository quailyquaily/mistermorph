// The phone's bottom navigation follows the page's scrolling (lib/navScroll.ts,
// docs/console/mobile-bottom-nav.md): expanded (icons over labels) at first, compact (icons only)
// once the content went NAV_COMPACT_AFTER points down, expanded again once it came
// NAV_EXPAND_AFTER points back up, and always at the top. Small reversals, rubber bands past
// either end and the app's own restores change nothing; another page, or another scroller, starts
// expanded. It never hides: every slot keeps its name and its press. Its geometry in both states:
// tests/mobile-bottom-nav.test.tsx.
import type { App } from "nsh/test";
import { expect, test } from "nsh/test";
import {
  NAV_COMPACT_AFTER,
  NAV_EXPAND_AFTER,
  NAV_SCROLL_START,
  navCompact,
  noteNavScroll,
  resetNavScroll,
  stepNavScroll,
  type NavScrollSample,
  type NavScrollState,
} from "../lib/navScroll";
import { LOCAL_REF, openConsole, scrollProbe } from "./harness";

/** Runs the samples from the start (a 600pt scroller over 2000pt of content unless they say). */
function run(samples: (Partial<NavScrollSample> & { y: number })[], from: NavScrollState = NAV_SCROLL_START) {
  const states: NavScrollState[] = [];
  let state = from;
  for (const sample of samples) {
    state = stepNavScroll(state, { source: "a", viewport: 600, content: 2000, ...sample });
    states.push(state);
  }
  return states;
}
const compactAfter = (ys: number[], extra: Partial<NavScrollSample> = {}) => run(ys.map((y) => ({ y, ...extra }))).map((s) => s.compact);

test("the thresholds: 32pt down compacts, 24pt back up expands", () => {
  expect(NAV_COMPACT_AFTER).toBe(32);
  expect(NAV_EXPAND_AFTER).toBe(24);
  expect(compactAfter([0, 31])).toEqual([false, false]);
  expect(compactAfter([0, 32])).toEqual([false, true]);
  // Many small reports add up.
  expect(compactAfter([0, 4, 9, 15, 22, 28, 33])).toEqual([false, false, false, false, false, false, true]);
  // Compact at 300: 23pt up is not enough, 24 is.
  expect(compactAfter([0, 300, 277])).toEqual([false, true, true]);
  expect(compactAfter([0, 300, 276])).toEqual([false, true, false]);
});

test("small reversals move inside the band and flip nothing", () => {
  // Expanded: down 20, back 8, down again: compact only 32pt below the highest point (0).
  expect(compactAfter([0, 20, 12, 25, 31, 32])).toEqual([false, false, false, false, false, true]);
  // Compact: a finger's jitter up and down never expands it; the turning point is the lowest
  // point reached, so up 20, down 10, up 13 (23 from 300) stays, and 24 from it expands.
  expect(compactAfter([0, 300, 280, 290, 277, 276])).toEqual([false, true, true, true, true, false]);
  // Going on down while compact moves the turning point along: 24 up from the new lowest.
  expect(compactAfter([0, 300, 500, 480, 476])).toEqual([false, true, true, true, false]);
  // Expanded after going up: the highest point is where it expanded, so a little more down stays.
  expect(compactAfter([0, 300, 276, 290, 307, 308])).toEqual([false, true, false, false, false, true]);
});

test("at the top it is always expanded, however it got there", () => {
  expect(compactAfter([0, 300, 1])).toEqual([false, true, false]);
  expect(compactAfter([0, 40, 0.5])).toEqual([false, true, false]);
  // The app putting it at the top (a scroller pulled back as its content went) expands it too.
  const states = run([{ y: 0 }, { y: 300 }, { y: 0, programmatic: true }]);
  expect(states.map((s) => s.compact)).toEqual([false, true, false]);
});

test("rubber bands past either end count as resting at that end", () => {
  // 2000pt of content in 600: the end is 1400. A bounce past it and back is no movement up.
  expect(compactAfter([0, 1400, 1460, 1430, 1400])).toEqual([false, true, true, true, true]);
  // A pull past the top (a refresh, the hidden search): at the top, then a short way down.
  expect(compactAfter([0, -60, -10, 0, 20])).toEqual([false, false, false, false, false]);
  // Offsets that are no numbers are the top.
  expect(compactAfter([0, 300, Number.NaN])).toEqual([false, true, false]);
});

test("content too short to scroll stays expanded", () => {
  // 20pt to scroll at most: never 32 down.
  expect(compactAfter([0, 20, 60, 200], { content: 620 })).toEqual([false, false, false, false]);
  // Content shorter than the scroller.
  expect(compactAfter([0, 300], { content: 400 })).toEqual([false, false]);
  // Content that got shorter under a compact capsule: the scroller is pulled back to its top.
  const states = run([{ y: 0 }, { y: 300 }, { y: 0, content: 500, programmatic: true }]);
  expect(states[2].compact).toBe(false);
});

test("another scroller starts afresh, and the app's own scrolling is never a direction", () => {
  // Compact on A; B, moved by the reader, takes over expanded from its own offset.
  let states = run([{ y: 0 }, { y: 300 }, { source: "b", y: 500 }, { source: "b", y: 520 }, { source: "b", y: 532 }]);
  expect(states.map((s) => [s.source, s.compact])).toEqual([
    ["a", false],
    ["a", true],
    ["b", false],
    ["b", false],
    ["b", true],
  ]);
  // A restore in another scroller (a page's other column) does not take the capsule from A.
  states = run([{ y: 0 }, { y: 300 }, { source: "b", y: 800, programmatic: true }]);
  expect(states[2]).toEqual(states[1]);
  // A restore in A (its remembered place put back) moves the turning point, not the state: from
  // 900 it takes 32pt more of the reader's to compact.
  states = run([{ y: 0 }, { y: 900, programmatic: true }, { y: 920 }, { y: 932 }]);
  expect(states.map((s) => s.compact)).toEqual([false, false, false, true]);
  // The first report after a reset is the start, not a movement.
  expect(run([{ y: 700 }]).map((s) => s.compact)).toEqual([false]);
  // The app's report from no followed scroller is not heard at all.
  expect(run([{ y: 700, programmatic: true }])[0]).toEqual(NAV_SCROLL_START);
});

test("the shared state follows the reports and resets", () => {
  resetNavScroll();
  noteNavScroll({ source: "x", y: 0, viewport: 600, content: 2000 });
  noteNavScroll({ source: "x", y: 100, viewport: 600, content: 2000 });
  expect(navCompact()).toBe(true);
  resetNavScroll();
  expect(navCompact()).toBe(false);
  // After a reset, the old scroller's next report is a start again.
  noteNavScroll({ source: "x", y: 140, viewport: 600, content: 2000 });
  expect(navCompact()).toBe(false);
  resetNavScroll();
});

// The console itself, on a phone.

const NOW = new Date().toISOString();
const EMPTY = { body: { items: [] } };
const topics = (count: number) =>
  Array.from({ length: count }, (_, i) => ({ id: `topic-${i + 1}`, title: `Topic ${i + 1}`, created_at: NOW, updated_at: NOW }));
const CONTACTS = Array.from({ length: 80 }, (_, i) => ({
  contact_id: `tg:${1000 + i}`,
  nickname: `Person ${i + 1}`,
  kind: "human",
  channel: "telegram",
  tg_username: `person${i + 1}`,
  status: "active",
}));
const api = (topicCount = 60) => ({
  "GET /proxy:/topics": { body: { items: topics(topicCount) } },
  "GET /proxy:/tasks": EMPTY,
  "GET /proxy:/todo/tasks": EMPTY,
  "GET /proxy:/contacts/list": () => ({ body: { items: CONTACTS } }),
  "GET /proxy:/memories": EMPTY,
});

const EXPANDED = "id:mobile-nav-row.expanded";
const COMPACT = "id:mobile-nav-row.compact";
const LIST = "id:chat-topic-list";

/** Scrolls by `dy` and lets the report arrive. */
async function scroll(app: App, selector: string, dy: number) {
  await app.scroll(selector, dy);
  await app.wait(60);
}
/** The scroller's first report after a page opens is where its movement starts (lib/navScroll.ts). */
async function begin(app: App, selector: string) {
  await scroll(app, selector, 1);
}
const state = (app: App) => (app.count(COMPACT) ? "compact" : app.count(EXPANDED) ? "expanded" : "none");

/** Every destination in the strip, by the name assistive technology reads, and its label's state. */
function expectNamedSlots(app: App) {
  for (const name of ["Topics", "Contacts", "Jobs", "More"]) {
    expect(app.count(`id:mobile-bottom-nav >> label:${name}`)).toBe(1);
  }
  expect(app.count("id:mobile-bottom-nav >> label:/^Agent: /")).toBe(1);
}

for (const android of [false, true]) {
  const where = android ? "the Android phone" : "a phone browser";

  test(`on ${where} the topic list's bar starts expanded, compacts reading down and expands coming back up`, async () => {
    const { app } = await openConsole({
      location: "/e/default/chat",
      width: 390,
      height: 844,
      api: api(),
      ...(android ? { platform: "android" as const, safeArea: { top: 24, right: 0, bottom: 16, left: 0 } } : {}),
    });
    await app.waitFor("id:chat-topic-topic-1");
    await app.waitFor(EXPANDED);
    expect(app.shows("id:mobile-nav-chat-label.shown")).toBe(true);
    expectNamedSlots(app);
    await begin(app, LIST);

    // Under the threshold: still expanded. Past it: compact, labels folded away.
    await scroll(app, LIST, 20);
    expect(state(app)).toBe("expanded");
    await scroll(app, LIST, 20);
    await app.waitFor(COMPACT);
    expect(app.shows("id:mobile-nav-chat-label.shown")).toBe(false);
    // Compact, every destination keeps its name.
    expectNamedSlots(app);

    // Small reversals: nothing.
    await scroll(app, LIST, 200);
    await scroll(app, LIST, -10);
    await scroll(app, LIST, 6);
    await scroll(app, LIST, -12);
    expect(state(app)).toBe("compact");
    // Further up: expanded.
    await scroll(app, LIST, -20);
    await app.waitFor(EXPANDED);
    // Down again, then back to the top.
    await scroll(app, LIST, 300);
    await app.waitFor(COMPACT);
    await scroll(app, LIST, -100000);
    await app.waitFor(EXPANDED);
    await app.dispose();
  });
}

test("another destination starts expanded, and its restored place does not compact it", async () => {
  const { app } = await openConsole({ location: "/e/default/chat", width: 390, height: 844, api: api(), scrollProbe: true });
  const probe = scrollProbe(app);
  const topicsArea = `chat|${LOCAL_REF}|2|topics`;
  await app.waitFor("id:chat-topic-topic-1");
  await begin(app, LIST);
  await scroll(app, LIST, 500);
  await app.waitFor(COMPACT);

  // Pressed in the compact capsule, Contacts opens, expanded.
  await app.press("id:mobile-nav-contacts");
  await app.waitFor("id:contacts-index");
  await app.waitFor(EXPANDED);
  await begin(app, "id:contacts-index");
  await scroll(app, "id:contacts-index", 400);
  await app.waitFor(COMPACT);

  // Back to Topics: the list comes back 500pt down (lib/scrollMemory.ts), the bar expanded, and
  // the restore is no movement of the reader's.
  probe.mark();
  await app.press("id:mobile-nav-chat");
  await app.waitFor("id:chat-topic-topic-1");
  await app.waitFor(EXPANDED);
  for (let waited = 0; waited < 5000 && probe.live(topicsArea) !== 501; waited += 50) await app.wait(50);
  expect(probe.live(topicsArea)).toBe(501);
  await app.wait(300);
  expect(state(app)).toBe("expanded");
  // From there, the reader's own scrolling counts again.
  await scroll(app, LIST, 10);
  await scroll(app, LIST, 40);
  await app.waitFor(COMPACT);

  // More and the agent work from the compact capsule too.
  await app.press("id:mobile-nav-more");
  await app.waitFor("id:mobile-more-sheet");
  await app.keyboard.press("escape");
  await app.waitFor("id:mobile-more", { state: "gone" });
  await app.press("id:mobile-nav-agent");
  await app.waitFor("id:mobile-agents-list");
  await app.keyboard.press("escape");
  await app.waitFor("id:mobile-agents", { state: "gone" });
  expect(state(app)).toBe("compact");
  await app.dispose();
});

test("a list too short to scroll keeps the bar expanded", async () => {
  const { app } = await openConsole({ location: "/e/default/chat", width: 390, height: 844, api: api(3) });
  await app.waitFor("id:chat-topic-topic-3");
  await app.waitFor(EXPANDED);
  // Nothing to scroll (the headless runner refuses the scroll; a browser's wheel moves nothing).
  let refused = false;
  try {
    await app.scroll(LIST, 200);
  } catch {
    refused = true;
  }
  expect(refused).toBe(true);
  await app.wait(100);
  expect(state(app)).toBe("expanded");
  expect(app.shows("id:mobile-nav-chat-label.shown")).toBe(true);
  await app.dispose();
});

test("a topic (a page below the navigation) has no bar, and its list on the way back is expanded", async () => {
  const { app } = await openConsole({ location: "/e/default/chat", width: 390, height: 844, api: api() });
  await app.waitFor("id:chat-topic-topic-1");
  await begin(app, LIST);
  await scroll(app, LIST, 300);
  await app.waitFor(COMPACT);
  await app.press("id:chat-topic-topic-8");
  await app.waitFor("id:mobile-bottom-nav", { state: "gone" });
  await app.waitFor("id:chat-back");
  await app.press("id:chat-back");
  await app.waitFor(EXPANDED);
  await app.dispose();
});

test("on a desktop nothing changes: the sidebar, no bottom bar, whatever the scrolling", async () => {
  const { app } = await openConsole({ location: "/e/default/chat", api: api() });
  await app.waitFor("id:chat-topic-topic-1");
  await begin(app, LIST);
  await scroll(app, LIST, 400);
  expect(app.count("id:mobile-bottom-nav")).toBe(0);
  expect(app.count(EXPANDED) + app.count(COMPACT)).toBe(0);
  expect(app.shows("id:nav-contacts")).toBe(true);
  await app.dispose();
});
