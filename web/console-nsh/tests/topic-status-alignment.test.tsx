// The topic list's status marks are centred under the icon of the head's last button (its middle
// axis, not the button's outer edge): New on a desktop and on a phone with New in the head, the tag
// toggle in a phone's split mode (New floats over the list). The head keeps its buttons where they
// were (the last one ends at the pages' phone gutter on phones, and where the rows end on desktops, 16pt in); the marks
// move under the icon, for running, pending and unread topics, long titles and TODO runs. Titles
// keep their room and stop short of the marks (a title with no mark where a mark would end), and
// nothing runs past the sidebar. TODO's own list: tests/todo-marker-alignment.test.tsx.
import { expect, open, test } from "nsh/test";

type Frame = { x: number; y: number; w: number; h: number };

const STATUS_IDS = ["running", "pending", "unread", "_cron_daily", "tagged"];
const TITLE_IDS = [...STATUS_IDS, "plain"];

async function openSidebar(width: number, mode: "plus" | "split" | "empty") {
  const app = await open("./fixtures/topic-status-alignment-app.tsx", { width, height: 900, platform: "linux", locale: "en-US" });
  const frames = () => JSON.parse(app.texts().find((text) => text.startsWith("{")) ?? "{}") as Record<string, Frame>;
  if (mode !== "plus") {
    await app.press(`id:mode-${mode}`);
  }
  const head = ["sidebar", "head-action", "head-icon"];
  const needed = [...head, ...(mode === "empty" ? [] : [...STATUS_IDS.map((id) => `status-${id}`), ...TITLE_IDS.map((id) => `title-${id}`)])];
  await app.waitUntil(() => needed.every((name) => Boolean(frames()[name])));
  await app.wait(100);
  return { app, frames };
}

const right = (frame: Frame) => frame.x + frame.w;
const centerX = (frame: Frame) => frame.x + frame.w / 2;

// The head's last button: a whole 38pt hit area ending `inset` in from the sidebar's outer right
// edge (the 314pt sidebar has 4pt of right padding of its own, a split one none), and its 14pt icon
// in the middle of it. Returns the icon, the axis the marks are centred on.
function expectHead(all: Record<string, Frame>, inset: number): Frame {
  const action = all["head-action"];
  const icon = all["head-icon"];
  expect(Math.abs(action.w - 38)).toBeLessThan(0.5);
  expect(Math.abs(right(all.sidebar) - right(action) - inset)).toBeLessThan(0.5);
  expect(Math.abs(icon.w - 14)).toBeLessThan(0.5);
  expect(Math.abs(centerX(icon) - centerX(action))).toBeLessThan(0.5);
  return icon;
}

// width: the window; inset: where the head's last button ends, in from the sidebar's outer right
// edge (unchanged by the marks' alignment).
const CASES = [
  { name: "a desktop", width: 1280, mode: "plus" as const, inset: 16 + 4, newInHead: true },
  { name: "a tablet-wide desktop", width: 1024, mode: "plus" as const, inset: 16 + 4, newInHead: true },
  { name: "a phone with New in the head", width: 390, mode: "plus" as const, inset: 12 + 4, newInHead: true },
  { name: "a phone in split mode", width: 390, mode: "split" as const, inset: 12, newInHead: false },
  { name: "a tablet-wide phone layout in split mode", width: 800, mode: "split" as const, inset: 14, newInHead: false },
];

for (const item of CASES) {
  test(`on ${item.name} the status marks are centred under the head's last icon`, async () => {
    const { app, frames } = await openSidebar(item.width, item.mode);
    expect(await app.shows("id:chat-topic-new")).toBe(item.newInHead);
    const all = frames();
    const sidebar = all.sidebar;
    const icon = expectHead(all, item.inset);
    for (const id of STATUS_IDS) {
      const mark = all[`status-${id}`];
      expect(Math.abs(mark.w - 7)).toBeLessThan(0.5);
      // Centre on centre, not edge on edge: the mark ends half a button less half a mark
      // (15.5pt) further in than the button. Layout snaps frames to whole points, so an odd 7pt
      // mark's centre lies half a point off an even 14pt icon's at best.
      expect(Math.abs(centerX(mark) - centerX(icon))).toBeLessThanOrEqual(0.5);
      expect(mark.x).toBeGreaterThan(sidebar.x);
      expect(right(mark)).toBeLessThan(right(sidebar) - item.inset);
      // The title stops short of its mark (the row's 10pt gap), never under it.
      const title = all[`title-${id}`];
      expect(right(title)).toBeLessThan(mark.x - 9.5);
    }
    // Every title keeps its room; one with no mark runs up to where a mark would end, no further.
    for (const id of TITLE_IDS) expect(all[`title-${id}`].w).toBeGreaterThan(150);
    expect(Math.abs(right(all["title-plain"]) - (centerX(icon) + 3.5))).toBeLessThanOrEqual(0.5);
  });
}

test("with no topics yet the head's last button keeps its place", async () => {
  const { app, frames } = await openSidebar(390, "empty");
  expect(await app.shows("id:chat-topic-new")).toBe(false);
  expectHead(frames(), 12);
});
