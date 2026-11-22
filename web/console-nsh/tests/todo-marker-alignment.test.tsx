// The TODO list is a notebook page: every item's marker lies on one edge of the left margin and
// every name starts on one line, the margin's width after it, whatever the marker's state (on, off,
// queued, running) and however long the name. The page keeps the same room at both sides: the
// pages' gutter on a phone, and on a desktop a column no wider than a page of text, centred. The
// head keeps that column: its title starts at the column's edge (the gutter on a phone, as every
// page's title does), not set in by the margin, and its last button ends where the rows end. The empty list's add row, a dashed box, starts where the names do too. The topic
// list's marks: tests/topic-status-alignment.test.tsx.
import { expect, open, test } from "nsh/test";

type Frame = { x: number; y: number; w: number; h: number };

const ITEM_IDS = ["heartbeat", "running", "queued", "on", "off"];
/** The margin a marker sits in (TODO_MARGIN) and the column's limit on a desktop (TODO_LIST_MAX_WIDTH). */
const MARGIN = 28;
const MAX_WIDTH = 760;

async function openIndex(width: number, mode: "list" | "empty") {
  const app = await open("./fixtures/todo-marker-alignment-app.tsx", { width, height: 900, platform: "linux", locale: "en-US" });
  const frames = () => JSON.parse(app.texts().find((text) => text.startsWith("{")) ?? "{}") as Record<string, Frame>;
  if (mode !== "list") {
    await app.press(`id:mode-${mode}`);
  }
  const head = ["index", "head-title", "head-action", "marker-heartbeat", "title-heartbeat"];
  const needed = [...head, ...(mode === "empty" ? ["empty-add", "empty-text", "empty-marker"] : [...ITEM_IDS.map((id) => `marker-${id}`), ...ITEM_IDS.map((id) => `title-${id}`)])];
  await app.waitUntil(() => needed.every((name) => Boolean(frames()[name])));
  await app.wait(100);
  return { app, frames };
}

const right = (frame: Frame) => frame.x + frame.w;
const near = (a: number, b: number) => Math.abs(a - b) < 0.5;

// width: the window; add: whether Add is in the head (a desktop; on a phone it floats over the list).
const CASES = [
  { name: "a desktop", width: 1280, add: true },
  { name: "a tablet-wide desktop", width: 1024, add: true },
  { name: "a phone", width: 390, add: false },
  { name: "a tablet-wide phone layout", width: 800, add: false },
];

/** The page's column, from Heartbeat's row: where the margin starts and where the rows end. */
function column(all: Record<string, Frame>) {
  return { left: all["marker-heartbeat"].x, right: right(all["title-heartbeat"]) };
}

for (const item of CASES) {
  test(`on ${item.name} the TODO markers share one edge of the margin and the names one line`, async () => {
    const { app, frames } = await openIndex(item.width, "list");
    expect(await app.shows("id:todo-add")).toBe(item.add);
    expect(await app.shows("id:todo-view-calendar")).toBe(true);
    const all = frames();
    const col = column(all);
    for (const id of ITEM_IDS) {
      // The 16pt slot the 7pt mark sits at the left of.
      const marker = all[`marker-${id}`];
      expect(near(marker.w, 16)).toBe(true);
      expect(near(marker.x, col.left)).toBe(true);
      // The name's column starts the margin's width in and runs to the column's end.
      const title = all[`title-${id}`];
      expect(near(title.x, col.left + MARGIN)).toBe(true);
      expect(near(right(title), col.right)).toBe(true);
      expect(title.w).toBeGreaterThan(250);
    }
    // The same room at both sides, and on a desktop no wider than a page of text.
    const index = all.index;
    // (within a point: the gutter is a fraction of the width on some sizes).
    expect(Math.abs(col.left - index.x - (right(index) - col.right))).toBeLessThan(1.5);
    if (item.add) expect(col.right - col.left).toBeLessThan(MAX_WIDTH + 0.5);
    // The head spans the pane, whatever the column's width: its last button (the last of the
    // views' tabs, a whole 38pt circle) ends at the pane's right gutter and its title starts at
    // the left one. On a phone the column is the pane, so they are the column's edges too.
    const action = all["head-action"];
    expect(near(action.w, 38)).toBe(true);
    const gutter = all["head-title"].x - index.x;
    // (within a point and a half: the gutter is a fraction of the width on some sizes).
    expect(Math.abs(right(index) - right(action) - gutter)).toBeLessThan(1.5);
    expect(gutter).toBeGreaterThanOrEqual(12);
    expect(gutter).toBeLessThanOrEqual(28);
    if (!item.add) expect(near(all["head-title"].x, col.left)).toBe(true);
    // On a phone that edge is the pages' gutter (gutterX: 12pt, 14pt on a wide one), where every
    // other page's title starts.
    if (!item.add) expect(near(all["head-title"].x - index.x, item.width <= 620 ? 12 : 14)).toBe(true);
  });
}

for (const item of [CASES[0], CASES[2], { name: "a narrow phone", width: 320, add: false }]) {
  test(`on ${item.name} with no items yet the add row starts where the names do and keeps the column`, async () => {
    const { app, frames } = await openIndex(item.width, "empty");
    const all = frames();
    const col = column(all);
    const { "empty-add": box, "empty-text": text, "empty-marker": marker } = all;
    // The dashed box: from the names' line to the column's end.
    expect(near(box.x, col.left + MARGIN)).toBe(true);
    expect(near(right(box), col.right)).toBe(true);
    // Its content lies inside the border: the text column, a gap, the 16pt icon slot.
    expect(text.x).toBeGreaterThan(box.x + 1);
    expect(right(text)).toBeLessThan(marker.x - 9.5);
    expect(near(marker.w, 16)).toBe(true);
    expect(right(marker)).toBeLessThan(right(box) - 1);
    expect(text.y).toBeGreaterThan(box.y);
    expect(text.y + text.h).toBeLessThan(box.y + box.h);
    // Room for the label and the hint (wrapped on the narrowest phones), neither dropped.
    expect(text.w).toBeGreaterThan(item.add ? 200 : item.width - 120);
    expect(await app.shows("text:No jobs yet")).toBe(true);
    expect(await app.shows("text:Give the agent a one-time or recurring task.")).toBe(true);
    // The whole row is still the add action.
    expect(app.texts()).toContain("adds:0");
    await app.press("id:todo-empty-add");
    await app.waitUntil(() => app.texts().includes("adds:1"));
  });
}
