// A phone's page-bar back arrows are the same button as the TODO head's calendar toggle: a 38pt
// plain icon-only square (BAR_BUTTON_SIZE, 16pt icon), centred in its 57pt bar the way the toggle is
// in the TODO head, and as far in from the bar's start as the toggle is from the head's end (the
// phone gutter). For MobileBar (Contacts, Memories, Skills) and a PageBar led by BackButton (Chat,
// TODO, Settings, the skill store). Context's arrow, the one that also shows on wide windows, keeps
// its 32pt desktop size there. Back presses and accessible names stay as they were. The real pages'
// back navigation: contacts, memories, todo, context, skills-store and android tests.
import { expect, open, test } from "nsh/test";

type Frame = { x: number; y: number; w: number; h: number };

const BARS = ["mobile-bar", "page-bar", "desktop-bar"];

async function openBars(width: number, platform: "linux" | "android") {
  const app = await open("./fixtures/mobile-back-button-app.tsx", { width, height: 900, platform, locale: "en-US" });
  const frames = () => JSON.parse(app.texts().find((text) => text.startsWith("{")) ?? "{}") as Record<string, Frame>;
  const needed = ["index", "head-action", ...BARS, ...BARS.map((bar) => `${bar}.back`)];
  await app.waitUntil(() => needed.every((name) => Boolean(frames()[name])));
  await app.wait(100);
  return { app, frames: frames() };
}

const centerY = (frame: Frame) => frame.y + frame.h / 2;
const right = (frame: Frame) => frame.x + frame.w;

// The phone gutter: 12pt up to 620pt wide, 14pt up to 980.
const PHONES = [
  { name: "an Android phone", width: 390, platform: "android" as const, gutter: 12 },
  { name: "a phone-wide web window", width: 390, platform: "linux" as const, gutter: 12 },
  { name: "a tablet-wide phone layout", width: 800, platform: "linux" as const, gutter: 14 },
];

for (const item of PHONES) {
  test(`on ${item.name} every page-bar back arrow matches the TODO calendar toggle`, async () => {
    const { frames } = await openBars(item.width, item.platform);
    const toggle = frames["head-action"];
    // The reference: the calendar toggle, 38pt square, the phone gutter in from the head's end.
    expect(Math.abs(toggle.w - 38)).toBeLessThan(0.5);
    expect(Math.abs(toggle.h - 38)).toBeLessThan(0.5);
    expect(Math.abs(right(frames.index) - right(toggle) - item.gutter)).toBeLessThan(0.5);
    // Where its middle sits in the head (the index's top is the head's top; the head is 57pt).
    const toggleMiddle = centerY(toggle) - frames.index.y;
    for (const bar of BARS) {
      const back = frames[`${bar}.back`];
      expect(Math.abs(back.w - toggle.w)).toBeLessThan(0.5);
      expect(Math.abs(back.h - toggle.h)).toBeLessThan(0.5);
      expect(Math.abs(frames[bar].h - 57)).toBeLessThan(0.5);
      expect(Math.abs(centerY(back) - frames[bar].y - toggleMiddle)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(back.x - frames[bar].x - item.gutter)).toBeLessThan(0.5);
    }
  });
}

test("on a desktop a page-bar back arrow keeps the size its page gives it", async () => {
  const { frames } = await openBars(1280, "linux");
  // Context's arrow: the 32pt xs button it always had on wide windows.
  expect(Math.abs(frames["desktop-bar.back"].w - 32)).toBeLessThan(0.5);
  expect(Math.abs(frames["desktop-bar.back"].h - 32)).toBeLessThan(0.5);
  // With no desktop size the bar's size holds everywhere.
  expect(Math.abs(frames["page-bar.back"].w - 38)).toBeLessThan(0.5);
});

test("the back arrows keep their accessible names and presses", async () => {
  const { app } = await openBars(390, "android");
  const presses = () => app.texts().find((text) => text.startsWith("presses:")) ?? "";
  // Named by their labels (MobileBar's backLabel, BackButton's title).
  expect(app.count("label:Contacts")).toBe(1);
  expect(app.count("label:Topics")).toBe(1);
  await app.press("id:mobile-back");
  await app.press("id:page-back");
  await app.press("id:desktop-back");
  await app.waitUntil(() => presses() === "presses:mobile-bar,page-bar,desktop-bar");
});
