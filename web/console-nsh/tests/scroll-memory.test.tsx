// Remembered scroll positions (lib/scrollMemory.ts), on tests/fixtures/scroll-memory-app.tsx: the
// page host with pages that remember a column 2 `Scroll` ("list"), a column 2 `List` ("tree") and
// a column 3 `Scroll` ("detail") that belongs to the selected item. Leaving a page and coming back
// restores each area on its own, per page and per agent; column 3 is restored for the same item
// only and starts at the top for any other; content that arrives late, is held back, or comes back
// shorter is handled; and nothing is kept outside the app's memory.
// The console's own pages are in tests/scroll-memory-pages.test.tsx.
import type { App } from "nsh/test";
import { expect, open, test } from "nsh/test";

const openApp = (clock = false) =>
  open("./fixtures/scroll-memory-app.tsx", { width: 900, height: 600, platform: "linux", locale: "en-US", clock: clock ? {} : null });

const json = (app: App, name: string) => JSON.parse((app.texts().find((text) => text.startsWith(`${name}=`)) ?? `${name}={}`).slice(name.length + 1));
/** An area's offset as its scroller last reported it since the page opened; `null` when it reported none. */
const live = (app: App, key: string): number | null => json(app, "live")[key] ?? null;
/** What is remembered now. */
async function saved(app: App): Promise<Record<string, { y: number; selection: string }>> {
  await app.press("id:read");
  return json(app, "saved");
}

const LIST = "chat||2|list";
const TREE = "chat||2|tree";
const DETAIL = "chat||3|detail";

async function start(clock = false) {
  const app = await openApp(clock);
  await app.waitFor("id:fixture-page.chat");
  return app;
}

/** Opens `page` (another page instance), and waits for it. */
async function go(app: App, page: string, id = `fixture-page.${page}`) {
  await app.press(`id:go-${page}`);
  await app.waitFor(`id:${id}`);
}

/** Leaves the chat page for the todo page and comes back. */
async function awayAndBack(app: App) {
  await go(app, "todo");
  await app.wait(50);
  await go(app, "chat");
}

test("areas never scrolled start at the top, and nothing is remembered for them", async () => {
  const app = await start();
  await app.wait(200);
  expect(await saved(app)).toEqual({});
  await awayAndBack(app);
  await app.wait(300);
  // No area moved: none reported an offset.
  expect(json(app, "live")).toEqual({});
  expect(await saved(app)).toEqual({});
});

test("leaving a page and coming back restores each of its areas, a Scroll and a List, on its own", async () => {
  const app = await start();
  await app.scroll("id:list", 300);
  await app.scroll("id:tree", 200);
  await app.scroll("id:detail", 120);
  await app.waitUntil(() => live(app, DETAIL) === 120);
  await awayAndBack(app);
  await app.waitUntil(() => live(app, LIST) === 300 && live(app, TREE) === 200 && live(app, DETAIL) === 120);
  expect(await saved(app)).toEqual({
    [LIST]: { y: 300, selection: "" },
    [TREE]: { y: 200, selection: "" },
    [DETAIL]: { y: 120, selection: "one" },
  });
  // Scrolled back to its top, an area is no longer remembered; the others are as they were.
  await app.scroll("id:tree", -200);
  await app.waitUntil(() => live(app, TREE) === 0);
  await awayAndBack(app);
  await app.waitUntil(() => live(app, LIST) === 300 && live(app, DETAIL) === 120);
  await app.wait(200);
  expect(live(app, TREE)).toBe(null);
  expect(Object.keys(await saved(app)).sort()).toEqual([LIST, DETAIL].sort());
});

test("pages keep their own places, and so do the same page of two agents", async () => {
  const app = await start();
  await app.scroll("id:list", 300);
  await go(app, "todo");
  await app.wait(200);
  // Another page's list is its own: it starts at the top.
  expect(live(app, "todo||2|list")).toBe(null);
  await app.scroll("id:list", 80);
  await app.waitUntil(() => live(app, "todo||2|list") === 80);
  await go(app, "agent-a", "fixture-page.chat");
  await app.wait(200);
  expect(live(app, "chat|ep_a|2|list")).toBe(null);
  await app.scroll("id:list", 440);
  await app.waitUntil(() => live(app, "chat|ep_a|2|list") === 440);
  await go(app, "agent-b", "fixture-page.chat");
  await app.wait(200);
  expect(live(app, "chat|ep_b|2|list")).toBe(null);
  await go(app, "agent-a", "fixture-page.chat");
  await app.waitUntil(() => live(app, "chat|ep_a|2|list") === 440);
  await go(app, "todo");
  await app.waitUntil(() => live(app, "todo||2|list") === 80);
  await go(app, "chat");
  await app.waitUntil(() => live(app, LIST) === 300);
  const all = await saved(app);
  expect(all[LIST].y).toBe(300);
  expect(all["todo||2|list"].y).toBe(80);
  expect(all["chat|ep_a|2|list"].y).toBe(440);
  expect(all["chat|ep_b|2|list"]).toBe(undefined);
});

test("column 3 goes back to the top when column 2's item changes, and keeps no place per item", async () => {
  const app = await start();
  await app.scroll("id:list", 300);
  await app.scroll("id:detail", 240);
  await app.waitUntil(() => live(app, DETAIL) === 240);
  // Another item: column 3 is at its top at once, its old place forgotten; column 2 stays.
  await app.press("id:select-two");
  await app.waitUntil(() => live(app, DETAIL) === 0);
  expect(live(app, LIST)).toBe(300);
  expect((await saved(app))[DETAIL]).toBe(undefined);
  // Back to the first item: still the top, not where it was read before.
  await app.press("id:select-one");
  await app.wait(200);
  expect(live(app, DETAIL)).toBe(0);
  await awayAndBack(app);
  await app.waitUntil(() => live(app, LIST) === 300);
  await app.wait(200);
  expect(live(app, DETAIL)).toBe(null);
});

test("column 3 is restored for the item it was left with, and not for one picked while away", async () => {
  const app = await start();
  await app.scroll("id:detail", 240);
  await app.waitUntil(() => live(app, DETAIL) === 240);
  // The same item on the way back: its place.
  await awayAndBack(app);
  await app.waitUntil(() => live(app, DETAIL) === 240);
  // Another item by the time the page is back: the top, and the old place is gone for good.
  await go(app, "todo");
  await app.press("id:select-two");
  await go(app, "chat");
  await app.wait(300);
  expect(live(app, DETAIL)).toBe(null);
  expect((await saved(app))[DETAIL]).toBe(undefined);
  await app.press("id:select-one");
  await app.wait(200);
  expect(live(app, DETAIL)).toBe(null);
});

test("a page that finds its item after it opens restores column 3 for the same item only", async () => {
  const app = await start();
  await app.scroll("id:detail", 240);
  await app.waitUntil(() => live(app, DETAIL) === 240);
  // The page comes back with no item yet, then finds the one it had.
  await go(app, "todo");
  await app.press("id:select-none");
  await go(app, "chat");
  await app.wait(200);
  expect(live(app, DETAIL)).toBe(null);
  expect((await saved(app))[DETAIL]).toEqual({ y: 240, selection: "one" });
  await app.press("id:select-one");
  await app.waitUntil(() => live(app, DETAIL) === 240);
  // It comes back with no item again, then finds another one.
  await go(app, "todo");
  await app.press("id:select-none");
  await go(app, "chat");
  await app.press("id:select-two");
  await app.wait(300);
  expect(live(app, DETAIL)).toBe(null);
  expect((await saved(app))[DETAIL]).toBe(undefined);
});

test("an item dropped inside the page forgets column 3, whose scroller may have gone with it", async () => {
  const app = await start();
  await app.scroll("id:detail", 240);
  await app.waitUntil(() => live(app, DETAIL) === 240);
  // Column 3 closes and the item goes in the same step (a phone going back to its list).
  await app.press("id:detail-off");
  await app.press("id:select-none");
  expect((await saved(app))[DETAIL]).toBe(undefined);
  // The same item opened again starts at the top.
  await app.press("id:select-one");
  await app.press("id:detail-on");
  await app.waitFor("id:detail");
  await app.wait(300);
  expect(live(app, DETAIL)).toBe(0);
  await app.scroll("id:detail", 40);
  await app.waitUntil(() => live(app, DETAIL) === 40);
});

test("content that arrives after the page is restored once it is there, and stays remembered until then", async () => {
  const app = await start();
  await app.scroll("id:list", 900);
  await app.scroll("id:tree", 700);
  await app.waitUntil(() => live(app, TREE) === 700);
  await app.press("id:late");
  await awayAndBack(app);
  // The page is there, its rows are not: nothing to scroll yet, and the places are kept.
  await app.wait(100);
  expect(app.texts().includes("row 1")).toBe(false);
  expect(live(app, LIST) ?? 0).toBe(0);
  const waiting = await saved(app);
  expect(waiting[LIST].y).toBe(900);
  expect(waiting[TREE].y).toBe(700);
  // The rows arrive (400 ms after the page).
  await app.waitUntil(() => live(app, LIST) === 900 && live(app, TREE) === 700);
});

test("a restore waits for the page's content to be ready", async () => {
  const app = await start();
  await app.scroll("id:list", 900);
  await app.waitUntil(() => live(app, LIST) === 900);
  await app.press("id:unready");
  await awayAndBack(app);
  await app.wait(1500);
  expect(live(app, LIST)).toBe(null);
  expect((await saved(app))[LIST].y).toBe(900);
  await app.press("id:ready");
  await app.waitUntil(() => live(app, LIST) === 900);
});

test("content that came back shorter is scrolled as far as it goes, and that becomes the place", async () => {
  const app = await start(true);
  await app.scroll("id:list", 1500);
  await app.scroll("id:tree", 1500);
  await app.wait(100);
  expect(live(app, LIST)).toBe(1500);
  await go(app, "todo");
  await app.press("id:rows-20");
  await go(app, "chat");
  await app.wait(300);
  // 20 rows of 40: the end of the content, well short of 1500.
  const end = live(app, LIST) as number;
  expect(end).toBeGreaterThan(0);
  expect(end).toBeLessThan(800);
  expect(live(app, TREE)).toBe(end);
  // Still hoping for the rest of the content.
  expect((await saved(app))[LIST].y).toBe(1500);
  // It never comes: the place is where the scroller is.
  await app.wait(6000);
  const kept = await saved(app);
  expect(kept[LIST].y).toBe(end);
  expect(kept[TREE].y).toBe(end);
  // Longer again later: nothing jumps to the old place.
  await app.press("id:rows-60");
  await app.wait(3000);
  expect(live(app, LIST)).toBe(end);
});

test("a list emptied under the reader (a reload, rows going as the page leaves) keeps its place", async () => {
  const app = await start();
  await app.scroll("id:list", 900);
  await app.waitUntil(() => live(app, LIST) === 900);
  // The content collapses and the scroller is pulled back with it: the place stays remembered.
  await app.press("id:rows-5");
  await app.waitUntil(() => live(app, LIST) === 0);
  expect((await saved(app))[LIST].y).toBe(900);
  await go(app, "todo");
  await app.press("id:rows-60");
  await go(app, "chat");
  await app.waitUntil(() => live(app, LIST) === 900);
});

test("content too short to scroll is left alone", async () => {
  const app = await start(true);
  await app.scroll("id:list", 600);
  await app.wait(100);
  expect(live(app, LIST)).toBe(600);
  await go(app, "todo");
  await app.press("id:rows-5");
  await go(app, "chat");
  await app.wait(7000);
  expect(app.texts().includes("row 5")).toBe(true);
  // Nothing to scroll: it stays at its top, and nothing is remembered for the area now.
  expect(live(app, LIST) ?? 0).toBe(0);
  expect((await saved(app))[LIST]).toBe(undefined);
});

test("the reader scrolling while a restore waits for content takes over", async () => {
  const app = await start(true);
  await app.scroll("id:list", 1500);
  await app.wait(100);
  await go(app, "todo");
  await app.press("id:rows-20");
  await go(app, "chat");
  await app.wait(300);
  const end = live(app, LIST) as number;
  expect(end).toBeLessThan(800);
  // The reader scrolls up from the content's end while the restore still waits.
  await app.scroll("id:list", -100);
  await app.wait(400);
  expect(live(app, LIST)).toBe(end - 100);
  expect((await saved(app))[LIST].y).toBe(end - 100);
  // The rest of the content arrives: the reader's place stands.
  await app.press("id:rows-60");
  await app.wait(3000);
  expect(live(app, LIST)).toBe(end - 100);
});

test("the places live in the app's memory only: nothing is stored, and an app opened again starts fresh", async () => {
  const app = await start();
  await app.scroll("id:list", 300);
  await app.scroll("id:detail", 120);
  await app.waitUntil(() => live(app, DETAIL) === 120);
  await awayAndBack(app);
  await app.waitUntil(() => live(app, LIST) === 300);
  expect(app.storage()).toEqual({});
  expect(app.requests()).toEqual([]);
  // A reload: a new app.
  const again = await start();
  await again.wait(300);
  expect(await saved(again)).toEqual({});
  expect(json(again, "live")).toEqual({});
  await again.scroll("id:list", 10);
  await again.waitUntil(() => live(again, LIST) === 10);
});
