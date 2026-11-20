// The phone's drawers from the right and the system's bars and cutouts (lib/systemInsets.ts
// `rightSheetInsets`, lib/shell.ts `rightSheetPopupStyle`): the shared `SidePane` sheet (Settings'
// panes, the channels' settings, Audit's details, ...), the skill store's panel and the chat's
// workspace sheet are layers over the whole surface, outside the app's frame. Each pads its popup
// by the insets of the edges it touches, once: the paper runs under the bars, the head, the
// scrolling body and the foot's actions stay clear of them. A wide window's pane is a column inside
// the frame and pads nothing. Frames come from tests/fixtures/right-drawers-app.tsx, laid out by
// the headless engine: no device, no software keyboard (its part is checked on the numbers).
import type { Platform, SafeArea } from "nsh/test";
import { expect, open, test } from "nsh/test";
import { rightSheetInsets, rightSheetPadding } from "../lib/systemInsets";

type Frame = { x: number; y: number; w: number; h: number; px?: number; py?: number };

const SHEETS = ["side", "store", "workspace"] as const;
const PARTS = ["body", "head", "scroll", "foot"] as const;
/** The skill store's card stands this far in from its sheet's edges (SkillStorePage.tsx). */
const STORE_GAPS = { top: 6, right: 4, bottom: 4 };
const NO_GAPS = { top: 0, right: 0, bottom: 0 };
const NONE = { top: 0, right: 0, bottom: 0, left: 0 };

async function openDrawers(options: { platform: Platform; width?: number; height?: number; safeArea?: SafeArea }) {
  const width = options.width ?? 390;
  const height = options.height ?? 844;
  const app = await open("./fixtures/right-drawers-app.tsx", { width, height, locale: "en-US", platform: options.platform, safeArea: options.safeArea });
  const frames = () => JSON.parse(app.texts().find((text) => text.startsWith("{")) ?? "{}") as Record<string, Frame>;
  const placed = (name: string) => frames()[name]?.py !== undefined;
  await app.waitUntil(() => [...SHEETS, "column"].every((sheet) => PARTS.every((part) => placed(`${sheet}-${part}`))) && placed("page"));
  return { app, frames, width, height };
}

const near = (actual: number, expected: number) => expect(Math.abs(actual - expected)).toBeLessThan(0.75);

/** A drawer's content is exactly the surface less `area` (and the drawer's own `gaps`) at the top, the right and the bottom. */
function expectInside(f: Record<string, Frame>, sheet: string, size: { width: number; height: number }, area: typeof NONE, gaps = NO_GAPS) {
  const body = f[`${sheet}-body`];
  const head = f[`${sheet}-head`];
  const scroll = f[`${sheet}-scroll`];
  const foot = f[`${sheet}-foot`];
  const top = area.top + gaps.top;
  const bottom = size.height - area.bottom - gaps.bottom;
  // The head starts right under the status bar or the cutout: not under it, not the inset twice.
  near(body.py!, top);
  near(head.py!, top);
  near(head.h, 57);
  // The foot's action ends right above the navigation bar or the gesture handle.
  near(foot.py! + foot.h, bottom);
  near(foot.h, 56);
  // The scrolling body takes all the room between them, and still has some.
  near(scroll.py!, top + 57);
  near(scroll.h, bottom - top - 57 - 56);
  expect(scroll.h).toBeGreaterThan(100);
  // The right edge keeps inside a cutout or a navigation bar at the side.
  near(body.px! + body.w, size.width - area.right - gaps.right);
  near(foot.px! + foot.w, size.width - area.right - gaps.right);
  // The open side is in the middle of the surface: the drawer is no wider than its 88% or 92%.
  expect(body.px!).toBeGreaterThan(0);
}

const CASES: Array<[string, { platform: Platform; width?: number; height?: number; safeArea?: SafeArea }, typeof NONE]> = [
  ["an Android phone with gesture navigation", { platform: "android", safeArea: { top: 24, right: 0, bottom: 16, left: 0 } }, { top: 24, right: 0, bottom: 16, left: 0 }],
  ["an Android phone with three-button navigation", { platform: "android", safeArea: { top: 32, right: 0, bottom: 48, left: 0 } }, { top: 32, right: 0, bottom: 48, left: 0 }],
  ["an Android phone with a tall cutout", { platform: "android", safeArea: { top: 52, right: 0, bottom: 16, left: 0 } }, { top: 52, right: 0, bottom: 16, left: 0 }],
  [
    "an Android phone on its side, the navigation bar at the right, a cutout at the left",
    { platform: "android", width: 844, height: 390, safeArea: { top: 24, right: 48, bottom: 0, left: 32 } },
    { top: 24, right: 48, bottom: 0, left: 0 },
  ],
  [
    "an Android phone on its other side, the cutout at the right",
    { platform: "android", width: 844, height: 390, safeArea: { top: 0, right: 32, bottom: 16, left: 0 } },
    { top: 0, right: 32, bottom: 16, left: 0 },
  ],
  ["an Android phone that reports no insets", { platform: "android" }, NONE],
  ["an Android phone with zero insets", { platform: "android", safeArea: NONE }, NONE],
  ["an iPhone", { platform: "ios", safeArea: { top: 59, right: 0, bottom: 34, left: 0 } }, { top: 59, right: 0, bottom: 34, left: 0 }],
  [
    "an iPhone on its side",
    { platform: "ios", width: 844, height: 390, safeArea: { top: 0, right: 59, bottom: 21, left: 59 } },
    { top: 0, right: 59, bottom: 21, left: 0 },
  ],
  ["an iPhone without insets", { platform: "ios", safeArea: NONE }, NONE],
];

for (const [name, options, area] of CASES) {
  test(`on ${name} every right drawer keeps its head, body and foot inside the safe area, once`, async () => {
    const { frames, width, height } = await openDrawers(options);
    const f = frames();
    expectInside(f, "side", { width, height }, area);
    expectInside(f, "workspace", { width, height }, area);
    // The skill store's card keeps its own small gaps from the sheet's edges on top of the insets.
    expectInside(f, "store", { width, height }, area, STORE_GAPS);
  });
}

for (const [name, options] of [
  ["a narrow browser window", { platform: "linux" }],
  ["a phone browser that reports insets", { platform: "linux", safeArea: { top: 47, right: 0, bottom: 34, left: 0 } }],
  ["a phone browser on its side", { platform: "linux", width: 844, height: 390, safeArea: { top: 0, right: 47, bottom: 21, left: 47 } }],
  ["a desktop window", { platform: "linux", width: 1280, height: 800 }],
  ["a Mac window", { platform: "macos", width: 1280, height: 800 }],
] as Array<[string, { platform: Platform; width?: number; height?: number; safeArea?: SafeArea }]>) {
  test(`in ${name} the drawers are as they were: no inset, the store's own gaps only`, async () => {
    const { frames, width, height } = await openDrawers(options);
    const f = frames();
    expectInside(f, "side", { width, height }, NONE);
    expectInside(f, "workspace", { width, height }, NONE);
    expectInside(f, "store", { width, height }, NONE, STORE_GAPS);
  });
}

test("a pane beside the list is inside the frame, which has taken the insets: it pads nothing", async () => {
  const area = { top: 24, right: 48, bottom: 0, left: 32 };
  const { frames } = await openDrawers({ platform: "android", width: 844, height: 390, safeArea: area });
  const f = frames();
  // The frame moved the page inside the bars; the column starts where the page's row does.
  near(f.page.py!, area.top);
  near(f.page.px!, area.left);
  near(f["column-body"].px! + f["column-body"].w, 844 - area.right);
  // Its head is at the column's own top (under the page's two lines of text), with no inset inside.
  near(f["column-head"].y, 0);
  near(f["column-body"].w, 160 - 1);
  near(f["column-foot"].py! + f["column-foot"].h, 390 - area.bottom);
  near(f["column-body"].h, f["column-head"].h + f["column-scroll"].h + f["column-foot"].h);
});

test("the drawers' actions are pressed where they are drawn, and each closes its own drawer", async () => {
  const { app } = await openDrawers({ platform: "android", safeArea: { top: 24, right: 0, bottom: 48, left: 0 } });
  // The newest sheet is on top: the store's, then the side pane, then the workspace sheet.
  for (const [index, sheet] of ["store", "side", "workspace"].entries()) {
    await app.press(`id:${sheet}-close`);
    await app.waitFor(`id:${sheet}-close`, { state: "gone" });
    expect(app.texts()).toContain(`closed=${["store", "side", "workspace"].slice(0, index + 1).join(",")}`);
  }
});

test("a turn of the phone lays the drawers out again inside the same insets", async () => {
  // The headless engine turns the surface but keeps the insets it was opened with (the landscape
  // insets are the cases above): the drawers follow the new size, still clear of the bars.
  const area = { top: 24, right: 0, bottom: 16, left: 0 };
  const { app, frames } = await openDrawers({ platform: "android", safeArea: area });
  near(frames()["side-head"].py!, 24);
  await app.setViewport(844, 390);
  await app.waitUntil(() => SHEETS.every((sheet) => Math.abs(frames()[`${sheet}-foot`].py! + frames()[`${sheet}-foot`].h - (390 - 16)) < 5));
  const f = frames();
  expectInside(f, "side", { width: 844, height: 390 }, area);
  expectInside(f, "workspace", { width: 844, height: 390 }, area);
  expectInside(f, "store", { width: 844, height: 390 }, area, STORE_GAPS);
});

test("the right sheet's insets: top, right and bottom from the system, nothing for the keyboard twice", () => {
  const bars = { top: 24, right: 0, bottom: 48, left: 0 };
  expect(rightSheetInsets(bars)).toEqual({ top: 24, right: 0, bottom: 48, left: 0 });
  expect(rightSheetInsets({})).toEqual(NONE);
  expect(rightSheetInsets(NONE, 0)).toEqual(NONE);
  // Android lays the sheet's window out above the keyboard, which covers the navigation bar: the
  // sheet's foot is the keyboard's top, with neither the inset nor the keyboard's height under it.
  expect(rightSheetInsets(bars, 320)).toEqual({ top: 24, right: 0, bottom: 0, left: 0 });
  // The keyboard goes down: the inset is back.
  expect(rightSheetInsets(bars, 0).bottom).toBe(48);
  // Landscape: the side the sheet is docked at, never the open one.
  expect(rightSheetInsets({ top: 0, right: 48, bottom: 0, left: 32 })).toEqual({ top: 0, right: 48, bottom: 0, left: 0 });
  expect(rightSheetInsets({ top: Number.NaN, right: -1, bottom: undefined }, Number.NaN)).toEqual(NONE);
});

test("the right sheet's padding: the insets once, on top of the sheet's own gaps; nothing where there are none", () => {
  // No insets on this platform, no padding of its own: no style at all (the classes stand).
  expect(rightSheetPadding(null)).toBe(undefined);
  // No insets, own gaps: the gaps alone (the skill store in a browser).
  expect(rightSheetPadding(null, STORE_GAPS)).toEqual({ paddingTop: 6, paddingRight: 4, paddingBottom: 4 });
  // Zero insets: zero padding.
  expect(rightSheetPadding(NONE)).toEqual({ paddingTop: 0, paddingRight: 0, paddingBottom: 0 });
  expect(rightSheetPadding(NONE, STORE_GAPS)).toEqual({ paddingTop: 6, paddingRight: 4, paddingBottom: 4 });
  // Insets: each once, never a left one.
  const insets = rightSheetInsets({ top: 24, right: 48, bottom: 16, left: 32 });
  expect(rightSheetPadding(insets)).toEqual({ paddingTop: 24, paddingRight: 48, paddingBottom: 16 });
  expect(rightSheetPadding(insets, STORE_GAPS)).toEqual({ paddingTop: 30, paddingRight: 52, paddingBottom: 20 });
});
