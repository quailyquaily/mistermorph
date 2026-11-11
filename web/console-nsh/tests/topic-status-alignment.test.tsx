// The topic list's status marks end where the head's last button ends (its outer edge, not its
// icon): New on a desktop and on a phone with New in the head, the tag toggle in a phone's split
// mode (New floats over the list). Both sit at the shared right inset, the pages' phone gutter on
// phones and 30pt on desktops, for running, pending and unread topics, long titles and TODO runs;
// titles keep their room and stop short of the marks, and nothing runs past the sidebar.
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
  const needed = ["sidebar", "head-action", ...(mode === "empty" ? [] : [...STATUS_IDS.map((id) => `status-${id}`), ...TITLE_IDS.map((id) => `title-${id}`)])];
  await app.waitUntil(() => needed.every((name) => Boolean(frames()[name])));
  await app.wait(100);
  return { app, frames };
}

const right = (frame: Frame) => frame.x + frame.w;

// width: the window; inset: where the head's last button and the marks end, in from the sidebar's
// outer right edge (the 314pt sidebar has 4pt of right padding of its own, a split one none).
const CASES = [
  { name: "a desktop", width: 1280, mode: "plus" as const, inset: 30 + 4, newInHead: true },
  { name: "a phone with New in the head", width: 390, mode: "plus" as const, inset: 12 + 4, newInHead: true },
  { name: "a phone in split mode", width: 390, mode: "split" as const, inset: 12, newInHead: false },
  { name: "a tablet-wide phone layout in split mode", width: 800, mode: "split" as const, inset: 14, newInHead: false },
];

for (const item of CASES) {
  test(`on ${item.name} the status marks end at the head's last button`, async () => {
    const { app, frames } = await openSidebar(item.width, item.mode);
    expect(await app.shows("id:chat-topic-new")).toBe(item.newInHead);
    const all = frames();
    const sidebar = all.sidebar;
    const action = all["head-action"];
    // The last button is a whole 38pt hit area, ending at the inset.
    expect(Math.abs(action.w - 38)).toBeLessThan(0.5);
    expect(Math.abs(right(sidebar) - right(action) - item.inset)).toBeLessThan(0.5);
    for (const id of STATUS_IDS) {
      const mark = all[`status-${id}`];
      expect(Math.abs(mark.w - 7)).toBeLessThan(0.5);
      // Same outer right edge as the button, inside the sidebar.
      expect(Math.abs(right(mark) - right(action))).toBeLessThan(0.5);
      expect(mark.x).toBeGreaterThan(sidebar.x);
      // The title stops short of its mark (the row's 10pt gap), never under it.
      const title = all[`title-${id}`];
      expect(right(title)).toBeLessThan(mark.x - 9.5);
    }
    // Every title keeps its room; one with no mark runs up to the inset and no further.
    for (const id of TITLE_IDS) expect(all[`title-${id}`].w).toBeGreaterThan(150);
    expect(Math.abs(right(all["title-plain"]) - right(action))).toBeLessThan(0.5);
  });
}

test("with no topics yet the head's last button keeps the inset", async () => {
  const { app, frames } = await openSidebar(390, "empty");
  expect(await app.shows("id:chat-topic-new")).toBe(false);
  const all = frames();
  expect(Math.abs(right(all.sidebar) - right(all["head-action"]) - 12)).toBeLessThan(0.5);
});
