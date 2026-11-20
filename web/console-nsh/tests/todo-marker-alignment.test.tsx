// The TODO list's markers are centred under the icon of its head's last button (its middle axis,
// not the button's outer edge): Add on a desktop, the calendar toggle on a phone (Add floats over
// the list). On a phone the head keeps its buttons at the pages' phone gutter and the markers move
// in under the icon; on a desktop the rows keep the list's gutters and the head's buttons move in
// over the markers. For Heartbeat and items in every marker state (on, off, queued, running), long
// titles that stop short of the markers, and the empty list's add row, a dashed box that keeps the
// pages' gutter on both sides on a phone (not edge to edge, as the rows). The topic list's marks:
// tests/topic-status-alignment.test.tsx.
import { expect, open, test } from "nsh/test";

type Frame = { x: number; y: number; w: number; h: number };

const ITEM_IDS = ["heartbeat", "running", "queued", "on", "off"];

async function openIndex(width: number, mode: "list" | "empty") {
  const app = await open("./fixtures/todo-marker-alignment-app.tsx", { width, height: 900, platform: "linux", locale: "en-US" });
  const frames = () => JSON.parse(app.texts().find((text) => text.startsWith("{")) ?? "{}") as Record<string, Frame>;
  if (mode !== "list") {
    await app.press(`id:mode-${mode}`);
  }
  const head = ["index", "head-action"];
  const needed = [...head, ...(mode === "empty" ? ["empty-add", "empty-text", "empty-marker"] : [...ITEM_IDS.map((id) => `marker-${id}`), ...ITEM_IDS.map((id) => `title-${id}`)])];
  await app.waitUntil(() => needed.every((name) => Boolean(frames()[name])));
  await app.wait(100);
  return { app, frames };
}

const right = (frame: Frame) => frame.x + frame.w;
const centerX = (frame: Frame) => frame.x + frame.w / 2;

// The head's last button: a whole 38pt icon-only square (the icon in its middle) ending `inset` in
// from the index's right edge. Returns its centre, the axis the markers are centred on.
function expectHead(all: Record<string, Frame>, inset: number): number {
  const action = all["head-action"];
  expect(Math.abs(action.w - 38)).toBeLessThan(0.5);
  expect(Math.abs(right(all.index) - right(action) - inset)).toBeLessThan(0.5);
  return centerX(action);
}

// width: the window; inset: where the head's last button ends, in from the index's right edge;
// add: whether Add is in the head (a desktop).
const CASES = [
  { name: "a desktop", width: 1280, inset: 16, add: true },
  { name: "a tablet-wide desktop", width: 1024, inset: 16, add: true },
  { name: "a phone", width: 390, inset: 12, add: false },
  { name: "a tablet-wide phone layout", width: 800, inset: 14, add: false },
];

for (const item of CASES) {
  test(`on ${item.name} the TODO markers are centred under the head's last icon`, async () => {
    const { app, frames } = await openIndex(item.width, "list");
    expect(await app.shows("id:todo-add")).toBe(item.add);
    expect(await app.shows("id:todo-view-toggle")).toBe(true);
    const all = frames();
    const axis = expectHead(all, item.inset);
    for (const id of ITEM_IDS) {
      // The 16pt slot the 7pt mark sits in the middle of.
      const marker = all[`marker-${id}`];
      expect(Math.abs(marker.w - 16)).toBeLessThan(0.5);
      expect(Math.abs(centerX(marker) - axis)).toBeLessThan(0.5);
      expect(right(marker)).toBeLessThan(right(all.index));
      // On a desktop the rows end 16pt in, as the topic and contact rows do, where Add ends: the
      // slot ends the row's 10pt padding and 1pt border inside that.
      if (item.add) expect(Math.abs(right(all.index) - right(marker) - (16 + 1 + 10))).toBeLessThan(0.5);
      // The title column stops short of its marker (the row's 10pt gap) and keeps its room.
      const title = all[`title-${id}`];
      expect(right(title)).toBeLessThan(marker.x - 9.5);
      expect(title.w).toBeGreaterThan(150);
    }
  });
}

// The empty list's add row. gutter: the dashed box's inset from the index's edges on both sides
// (the pages' phone gutter, `gutterX`; the list's 16pt on a desktop); padding: the box's right
// padding inside its 1pt border, which keeps the icon on the axis.
const EMPTY_CASES = [
  { name: "a desktop", width: 1280, inset: 16, gutter: 16, padding: 10, add: true },
  { name: "a phone", width: 390, inset: 12, gutter: 12, padding: 10, add: false },
  { name: "a narrow phone", width: 320, inset: 12, gutter: 12, padding: 10, add: false },
  { name: "a tablet-wide phone layout", width: 800, inset: 14, gutter: 14, padding: 10, add: false },
];

for (const item of EMPTY_CASES) {
  test(`on ${item.name} with no items yet the add row keeps its gutters and its icon is centred under the head's last icon`, async () => {
    const { app, frames } = await openIndex(item.width, "empty");
    const all = frames();
    const axis = expectHead(all, item.inset);
    const { index, "empty-add": box, "empty-text": text, "empty-marker": marker } = all;
    expect(Math.abs(centerX(marker) - axis)).toBeLessThan(0.5);
    // The dashed box: the same gutter on both sides, the whole border inside the index.
    expect(Math.abs(box.x - index.x - item.gutter)).toBeLessThan(0.5);
    expect(Math.abs(right(index) - right(box) - item.gutter)).toBeLessThan(0.5);
    expect(Math.abs(box.w - (index.w - 2 * item.gutter))).toBeLessThan(0.5);
    // Its content lies inside the border: the text column, the 10pt gap, the 16pt icon slot.
    expect(text.x).toBeGreaterThan(box.x + 1);
    expect(right(text)).toBeLessThan(marker.x - 9.5);
    expect(Math.abs(marker.w - 16)).toBeLessThan(0.5);
    expect(Math.abs(right(box) - right(marker) - (1 + item.padding))).toBeLessThan(0.5);
    expect(text.y).toBeGreaterThan(box.y);
    expect(text.y + text.h).toBeLessThan(box.y + box.h);
    // Room for the label and the hint (wrapped on the narrowest phones), neither dropped.
    expect(text.w).toBeGreaterThan(item.add ? 200 : item.width - 80);
    expect(await app.shows("text:No scheduled TODOs")).toBe(true);
    expect(await app.shows("text:Give the agent a one-time or recurring task.")).toBe(true);
    // The whole row is still the add action.
    expect(app.texts()).toContain("adds:0");
    await app.press("id:todo-empty-add");
    await app.waitUntil(() => app.texts().includes("adds:1"));
  });
}

// The rows of a list with items stay edge to edge on a phone, and at the list's 16pt gutter on a
// desktop: only the empty add row moved in.
for (const item of [CASES[0], CASES[2]]) {
  test(`on ${item.name} the rows of a list with items keep their width`, async () => {
    const { frames } = await openIndex(item.width, "list");
    const all = frames();
    for (const id of ITEM_IDS) {
      const padding = item.add ? 10 : item.inset + 19 - 8 - 1;
      const rowRight = right(all[`marker-${id}`]) + padding + 1;
      expect(Math.abs(right(all.index) - rowRight - (item.add ? 16 : 0))).toBeLessThan(0.5);
    }
  });
}
