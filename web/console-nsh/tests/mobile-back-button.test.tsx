// Every page-bar back arrow is the standard round icon button (CircleButton, plain), as the TODO
// head's calendar toggle is: on a phone a 38pt circle (BAR_BUTTON_SIZE, 16pt arrow in its middle),
// centred in its 57pt bar the way the toggle is in the TODO head, and as far in from the bar's start
// as the toggle is from the head's end (the phone gutter). For MobileBar (Contacts, Memories, Skills)
// and a PageBar led by BackButton (Chat, TODO, Settings, the skill store). Context's arrow, the one
// that also shows on wide windows, keeps its 32pt desktop size there, round too. Back presses and
// accessible names stay as they were. Headless nsh has no style query, so the circle is checked on
// the classes BackButton draws with (circleButtonClass of backButtonCircle) and its geometry on the
// frames, on Android and the web, light and dark. The real pages' back navigation: contacts,
// memories, todo, context, skills-store, audit and android tests.
import { expect, open, test } from "nsh/test";
import { backButtonCircle, BAR_ICON_SIZE, circleButtonClass, CIRCLE_BUTTON_SIZES, type CircleButtonSize } from "../components/ui";

type Frame = { x: number; y: number; w: number; h: number };

const BARS = ["mobile-bar", "page-bar", "desktop-bar"];

async function openBars(width: number, platform: "linux" | "android", colorScheme: "light" | "dark" = "light") {
  const app = await open("./fixtures/mobile-back-button-app.tsx", { width, height: 900, platform, locale: "en-US", colorScheme });
  const frames = () => JSON.parse(app.texts().find((text) => text.startsWith("{")) ?? "{}") as Record<string, Frame>;
  const needed = ["index", "head-action", ...BARS, ...BARS.flatMap((bar) => [`${bar}.back`, `${bar}.back-icon`])];
  await app.waitUntil(() => needed.every((name) => Boolean(frames()[name])));
  await app.wait(100);
  return { app, frames: frames() };
}

const centerX = (frame: Frame) => frame.x + frame.w / 2;
const centerY = (frame: Frame) => frame.y + frame.h / 2;
const right = (frame: Frame) => frame.x + frame.w;

/** A back arrow is a `side` circle with its 16pt arrow in the middle. */
function expectCircle(frames: Record<string, Frame>, bar: string, side: number) {
  const back = frames[`${bar}.back`];
  const icon = frames[`${bar}.back-icon`];
  expect(Math.abs(back.w - side)).toBeLessThan(0.5);
  expect(Math.abs(back.h - side)).toBeLessThan(0.5);
  expect(Math.abs(icon.w - BAR_ICON_SIZE)).toBeLessThan(0.5);
  expect(Math.abs(icon.h - BAR_ICON_SIZE)).toBeLessThan(0.5);
  expect(Math.abs(centerX(icon) - centerX(back))).toBeLessThanOrEqual(0.5);
  expect(Math.abs(centerY(icon) - centerY(back))).toBeLessThanOrEqual(0.5);
}

test("a back arrow is drawn as a plain circle button: round, the bar's side, the plain fills", () => {
  const classes = (size: CircleButtonSize) => circleButtonClass({ size, variant: "plain" }).split(/\s+/);
  // Phones: the bar size, a 38pt circle, whatever the page asks for on wide windows.
  expect(backButtonCircle(true)).toBe("md");
  expect(backButtonCircle(true, "xs")).toBe("md");
  // Wide windows: the bar size, or the page's (Context's 32pt).
  expect(backButtonCircle(false)).toBe("md");
  expect(backButtonCircle(false, "xs")).toBe("sm");
  expect(CIRCLE_BUTTON_SIZES.md).toBe(38);
  expect(CIRCLE_BUTTON_SIZES.sm).toBe(32);
  for (const [size, side] of [["md", "size-[38px]"], ["sm", "size-8"]] as const) {
    const look = classes(size);
    // Round, the glyph in the middle, as the TODO head's toggle; the plain button's hover and press.
    for (const c of ["rounded-full", side, "items-center", "justify-center", "hover:bg-hover", "active:bg-press"]) expect(look).toContain(c);
    // No square corners, no fill or ring at rest.
    for (const c of look) expect(/^rounded-\(|^bg-|^border/.test(c)).toBe(false);
  }
});

// The phone gutter: 12pt up to 620pt wide, 14pt up to 980.
const PHONES = [
  { name: "an Android phone", width: 390, platform: "android" as const, gutter: 12, colorScheme: "light" as const },
  { name: "an Android phone in dark mode", width: 390, platform: "android" as const, gutter: 12, colorScheme: "dark" as const },
  { name: "a phone-wide web window", width: 390, platform: "linux" as const, gutter: 12, colorScheme: "light" as const },
  { name: "a phone-wide web window in dark mode", width: 390, platform: "linux" as const, gutter: 12, colorScheme: "dark" as const },
  { name: "a tablet-wide phone layout", width: 800, platform: "linux" as const, gutter: 14, colorScheme: "light" as const },
];

for (const item of PHONES) {
  test(`on ${item.name} every page-bar back arrow is a circle matching the TODO calendar toggle`, async () => {
    const { frames } = await openBars(item.width, item.platform, item.colorScheme);
    const toggle = frames["head-action"];
    // The reference: the calendar toggle, a 38pt circle, the phone gutter in from the head's end.
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
      expectCircle(frames, bar, 38);
    }
  });
}

for (const colorScheme of ["light", "dark"] as const) {
  test(`on a desktop (${colorScheme}) a page-bar back arrow keeps the size its page gives it`, async () => {
    const { frames } = await openBars(1280, "linux", colorScheme);
    // Context's arrow: the 32pt it always had on wide windows, now a 32pt circle.
    expectCircle(frames, "desktop-bar", 32);
    // With no desktop size the bar's size holds everywhere.
    expectCircle(frames, "page-bar", 38);
    expectCircle(frames, "mobile-bar", 38);
  });
}

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
