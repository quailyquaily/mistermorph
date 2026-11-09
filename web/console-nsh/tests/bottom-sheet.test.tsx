// Dropdowns that are sheets at the bottom of the screen on touch screens (nsh/base's Menu, Select and
// DatePicker; components/ui.tsx's DropdownMenu and SelectField, the composer's add menu and model
// picker): nsh pads them with nothing, so each keeps its own padding above the navigation bar or
// gesture handle (`bottomSheetInsets`, lib/systemInsets.ts; `bottomSheetStyle`, components/ui.tsx),
// or above the keyboard instead of it while it lifts, never both. Frames come from
// tests/fixtures/bottom-sheet-app.tsx. The desktops' popups are unchanged.
import type { App, Platform, SafeArea } from "nsh/test";
import { expect, open, test } from "nsh/test";
import { bottomSheetInsets } from "../lib/systemInsets";

type Frame = { x: number; y: number; w: number; h: number; px?: number; py?: number };

const HEIGHT = 844;
/** A phone with gesture navigation: a 24pt status bar, a 16pt gesture handle. */
const BARS = { top: 24, right: 0, bottom: 16, left: 0 };
/** A phone with three-button navigation: a 48pt navigation bar. */
const BUTTONS = { top: 24, right: 0, bottom: 48, left: 0 };
/** An iPhone: its home indicator. */
const HOME_INDICATOR = { top: 47, right: 0, bottom: 34, left: 0 };

const near = (actual: number | undefined, expected: number) => {
  expect(typeof actual).toBe("number");
  expect(Math.abs((actual as number) - expected)).toBeLessThan(0.5);
};

async function openGallery(platform: Platform, safeArea?: SafeArea, height = HEIGHT) {
  const app = await open("./fixtures/bottom-sheet-app.tsx", { width: 390, height, locale: "en-US", platform, safeArea: safeArea ?? null });
  const frames = () => JSON.parse(app.texts().find((text) => text.startsWith("{")) ?? "{}") as Record<string, Frame>;
  await app.waitFor("text:menu");
  return { app, frames };
}

/** Opens a sheet and waits until `name` is measured on the surface. */
async function openSheet(app: App, frames: () => Record<string, Frame>, trigger: string, name: string) {
  await app.press(`text:${trigger}`);
  await app.waitUntil(() => frames()[name]?.py !== undefined);
  // The sheet's motion has come in: the rows are where they stay.
  await app.wait(600);
  return frames()[name];
}

const bottom = (frame: Frame) => (frame.py ?? 0) + frame.h;

test("the bottom of a sheet: the bottom inset under its own padding, its rows' room kept", () => {
  // No inset, no keyboard: as its classes draw it.
  expect(bottomSheetInsets({}, 0, 844, 8)).toBeUndefined();
  expect(bottomSheetInsets({ top: 24, bottom: 0 }, 0, 844, 8, 320)).toBeUndefined();
  expect(bottomSheetInsets({ top: 24, bottom: Number.NaN }, Number.NaN, 844, 8, 320)).toBeUndefined();
  // A gesture handle: 8pt padding above it; a max-h-80 list grows by it, so its rows keep 320pt.
  expect(bottomSheetInsets(BARS, 0, 844, 8, 320)).toEqual({ paddingBottom: 24, maxHeight: 336 });
  // Three-button navigation, a class with no max-h: within the screen below the status bar.
  expect(bottomSheetInsets(BUTTONS, 0, 844, 8)).toEqual({ paddingBottom: 56, maxHeight: 820 });
  // No padding of its own (the agent switcher's scroll pads its rows): the inset alone.
  expect(bottomSheetInsets(BARS, 0, 844, 0, 384)).toEqual({ paddingBottom: 16, maxHeight: 400 });
  // A keyboard it rises above covers the navigation bar: its height replaces the inset, not both.
  expect(bottomSheetInsets(BUTTONS, 300, 844, 4, 320)).toEqual({ paddingBottom: 304, maxHeight: 620 });
  expect(bottomSheetInsets({ top: 24, bottom: 0 }, 300, 844, 4, 320)).toEqual({ paddingBottom: 304, maxHeight: 620 });
  // A keyboard lower than the bar (a floating one): the bar still.
  expect(bottomSheetInsets(BUTTONS, 20, 844, 4, 320)).toEqual({ paddingBottom: 52, maxHeight: 368 });
  // A short window: the rows keep to the room under the status bar, and never a negative height.
  expect(bottomSheetInsets(BARS, 0, 300, 8, 320)).toEqual({ paddingBottom: 24, maxHeight: 276 });
  expect(bottomSheetInsets(BARS, 500, 390, 4, 320)).toEqual({ paddingBottom: 504, maxHeight: 500 });
});

for (const [name, platform, safeArea, inset] of [
  ["Android, a gesture handle", "android", BARS, 16],
  ["Android, three-button navigation", "android", BUTTONS, 48],
  ["Android, no insets", "android", undefined, 0],
  ["iOS, a home indicator", "ios", HOME_INDICATOR, 34],
] as const) {
  test(`on ${name} a menu's last row keeps its padding above the bottom inset`, async () => {
    const { app, frames } = await openGallery(platform, safeArea);
    // DropdownMenu's: 8pt padding and a 1pt border under its rows.
    near(bottom(await openSheet(app, frames, "menu", "menu-items")), HEIGHT - inset - 8 - 1);
    await app.back();
    await app.waitFor("text:Row 0", { state: "gone" });

    // The model picker's: 4pt padding, 1pt border, and its row's own 6pt (py-1.5) under the last row.
    await openSheet(app, frames, "select", "select-row-2");
    near(bottom(frames()["select-row-2"]), HEIGHT - inset - 4 - 1 - 6);
  });
}

test("a long list's sheet keeps the rows' room above the inset, and still scrolls to its end", async () => {
  const plain = await openGallery("android", { top: 24 });
  const top = (await openSheet(plain.app, plain.frames, "long-select", "long-select-row-0")).py!;
  const inset = await openGallery("android", BARS);
  const raised = await openSheet(inset.app, inset.frames, "long-select", "long-select-row-0");
  // The whole max-h-80 sheet moves up by the inset: as many rows show as without one.
  near(raised.py, top - 16);
  await inset.app.scroll("text:Row 3", 3000);
  await inset.app.press("text:Row 29");
  await inset.app.waitFor("text:opened= chosen=v29 field=a");

  // A menu of a SelectField (max-h-80): its top moves up by the inset too.
  await inset.app.waitFor("text:Row 29", { state: "gone" });
  const menuTop = (await openSheet(inset.app, inset.frames, "long-menu", "long-menu-items")).py!;
  near(menuTop, HEIGHT - 16 - 320 + 1 + 8);
  plain.app.dispose();
  inset.app.dispose();
});

test("a sheet rising above the keyboard takes the keyboard's height, not the inset on top", async () => {
  const { app, frames } = await openGallery("android", BUTTONS);
  await app.press("id:keyboard-up");
  await openSheet(app, frames, "select", "select-row-2");
  // A 300pt keyboard (it covers the 48pt bar): 300, not 348.
  near(bottom(frames()["select-row-2"]), HEIGHT - 300 - 4 - 1 - 6);
  await app.back();
  await app.waitFor("text:Row 0", { state: "gone" });

  // Down again: the bar's inset.
  await app.press("id:keyboard-down");
  await app.press("text:select");
  await app.wait(600);
  await app.waitUntil(() => Math.abs(bottom(frames()["select-row-2"]) - (HEIGHT - 48 - 4 - 1 - 6)) < 0.5);
});

test("a long list above the keyboard on a short window stays below the status bar", async () => {
  const { app, frames } = await openGallery("android", BARS, 390);
  await app.press("id:keyboard-up");
  const first = await openSheet(app, frames, "long-select", "long-select-row-0");
  // 390 - 24 - 300 = 66pt of room: the sheet starts right under the status bar, not above it.
  expect(first.py!).toBeGreaterThan(24);
  expect(first.py!).toBeLessThan(390 - 300);
});

test("on the desktop the popups open at their trigger, whatever the insets", async () => {
  const withInsets = await openGallery("linux", BUTTONS);
  const menu = await openSheet(withInsets.app, withInsets.frames, "menu", "menu-items");
  const plain = await openGallery("linux");
  const plainMenu = await openSheet(plain.app, plain.frames, "menu", "menu-items");
  // Below its trigger near the top, not at the bottom of the window; the same with or without insets.
  expect(menu.py!).toBeLessThan(200);
  near(menu.py, plainMenu.py!);
  near(menu.h, plainMenu.h);
  withInsets.app.dispose();
  plain.app.dispose();
});

test("on a phone with insets the shared dropdowns still open, choose and close", async () => {
  const { app } = await openGallery("android", BUTTONS);
  // DropdownMenu: an item runs and closes the sheet.
  await app.press("id:dropdown-trigger");
  await app.press("text:Second action");
  await app.waitFor("text:Second action", { state: "gone" });
  await app.waitFor("text:opened= chosen=second field=a");
  // Dismissed with Back: nothing chosen.
  await app.press("id:dropdown-trigger");
  await app.waitFor("text:First action");
  await app.back();
  await app.waitFor("text:First action", { state: "gone" });
  await app.waitFor("text:opened= chosen=second field=a");
  // SelectField: the choice reaches the field.
  await app.press("id:field");
  await app.press("text:Bravo");
  await app.waitFor("text:opened= chosen=second field=b");
});
