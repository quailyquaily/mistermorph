// The phone's bottom navigation: its five slots (Chat, Contacts, TODO, More, the agent) sit side by
// side, none reaching under another, each wide enough to press, on the narrowest phones, in
// landscape and with larger text; the active pill covers its own slot and no other; and More and
// the agent open the same sheet: as wide as the window less the bar's margins, above the bar, and
// no taller than its rows.
import { expect, open, test } from "nsh/test";
import { mobileNavSlots, mobileSheetFrame, NAV_SLOT_MAX } from "../components/frame/mobileBar";
import { POPUP_GAP, POPUP_MAX_WIDTH } from "../lib/mobilePopup";

type Frame = { x: number; y: number; w: number; h: number; from?: number };

const SLOTS = ["mobile-nav-chat", "mobile-nav-contacts", "mobile-nav-todo", "mobile-nav-more", "mobile-nav-agent"];
/** The smallest press target the platforms ask for. */
const MIN_TARGET = 44;

async function openNav(width: number, height: number, extra: Record<string, unknown> = {}) {
  const app = await open("./fixtures/mobile-bottom-nav-app.tsx", { width, height, platform: "android", locale: "en-US", ...extra });
  const frames = () => JSON.parse(app.texts().find((text) => text.startsWith("{")) ?? "{}") as Record<string, Frame>;
  await app.waitFor("id:mobile-bottom-nav");
  await app.waitUntil(() => SLOTS.every((slot) => frames()[slot]));
  /** A sheet's sampled progress (0 out of sight, 1 in its place) after it was told to open or close. */
  const motion = () =>
    JSON.parse((app.texts().find((text) => text.startsWith("motion:")) ?? "motion:{}").slice(7)) as Record<string, { t: number; p: number }[]>;
  const sampled = async (label: string) => {
    await app.waitUntil(() => motion()[label] !== undefined);
    return motion()[label];
  };
  return { app, frames, sampled };
}

/** The slots' frames side by side: each its own stretch of the row, as wide as a press needs. */
function expectSeparateSlots(frames: Record<string, Frame>, width: number) {
  const row = SLOTS.map((slot) => frames[slot]);
  for (const frame of row) {
    expect(frame).toBeDefined();
    expect(frame.w).toBeGreaterThanOrEqual(MIN_TARGET);
    expect(frame.w).toBeLessThanOrEqual(NAV_SLOT_MAX);
    expect(frame.h).toBeGreaterThanOrEqual(MIN_TARGET);
  }
  for (let i = 1; i < row.length; i++) {
    // No overlap and no gap: each slot starts where the one before it ends.
    expect(Math.abs(row[i].x - (row[i - 1].x + row[i - 1].w))).toBeLessThan(0.5);
    expect(Math.abs(row[i].w - row[0].w)).toBeLessThan(0.5);
  }
  expect(row[0].x).toBeGreaterThanOrEqual(0);
  // The whole row fits the window, inside the capsule's margins.
  expect(row[0].w * row.length).toBeLessThanOrEqual(width - 2 * 12);
}

/** The active pill lies exactly on slot `name`. */
function expectHighlightOn(frames: Record<string, Frame>, name: string) {
  const pill = frames.highlight;
  const slot = frames[name];
  expect(pill).toBeDefined();
  expect(Math.abs(pill.x - slot.x)).toBeLessThan(0.5);
  expect(Math.abs(pill.w - slot.w)).toBeLessThan(0.5);
}

test("the slots' geometry fits the strip without overlapping", () => {
  // 320 and 360pt phones, a 360pt phone at 125% page zoom or display size (288pt), landscape.
  for (const width of [288, 320, 360, 390, 740, 980]) {
    const { slot, rowWidth, left } = mobileNavSlots(width, 5);
    expect(slot).toBeGreaterThanOrEqual(MIN_TARGET);
    expect(slot).toBeLessThanOrEqual(NAV_SLOT_MAX);
    expect(Number.isInteger(slot)).toBe(true);
    expect(rowWidth).toBe(slot * 5);
    // The row and the capsule's padding (4pt), hairline and side margins (12pt) fit the window.
    expect(rowWidth + 2 * (12 + 4 + 0.5)).toBeLessThanOrEqual(width);
    for (let i = 1; i < 5; i++) expect(left(i) - left(i - 1)).toBe(slot);
  }
  expect(mobileNavSlots(320, 5).slot).toBe(57);
  expect(mobileNavSlots(360, 5).slot).toBe(NAV_SLOT_MAX);
  expect(mobileNavSlots(844, 5).slot).toBe(NAV_SLOT_MAX);
});

for (const [label, width, height] of [
  ["a 320pt phone", 320, 640],
  ["a 360pt phone", 360, 780],
  ["a 360pt phone with larger display size", 288, 624],
  ["a phone in landscape", 780, 360],
] as const) {
  test(`on ${label} the slots sit side by side, and the pill covers only the active one`, async () => {
    const { app, frames } = await openNav(width, height);
    expectSeparateSlots(frames(), width);
    if (width >= 360) expect(frames()["mobile-nav-chat"].w).toBe(NAV_SLOT_MAX);

    // Every destination takes its press: More and the agent open their sheets, and the pill moves
    // onto the slot that is now active.
    await app.press("id:mobile-nav-more");
    await app.waitFor("id:mobile-more");
    await app.waitUntil(() => Boolean(frames().highlight));
    expectHighlightOn(frames(), "mobile-nav-more");

    await app.press("id:mobile-nav-agent");
    await app.waitFor("id:mobile-agents-list");
    await app.waitFor("id:mobile-more", { state: "gone" });
    await app.waitUntil(() => Math.abs(frames().highlight.x - frames()["mobile-nav-agent"].x) < 0.5);
    expectHighlightOn(frames(), "mobile-nav-agent");
    await app.keyboard.press("escape");
    await app.waitFor("id:mobile-agents-list", { state: "gone" });
    // (The primary pages' slots navigate: tests/shell.test.tsx presses them in the console at 320pt.)
  });
}

test("rotating the phone refits the slots", async () => {
  const { app, frames } = await openNav(320, 640);
  expect(frames()["mobile-nav-chat"].w).toBe(57);
  await app.setViewport(640, 320);
  await app.waitUntil(() => frames()["mobile-nav-chat"].w === NAV_SLOT_MAX);
  expectSeparateSlots(frames(), 640);
  await app.setViewport(320, 640);
  await app.waitUntil(() => frames()["mobile-nav-chat"].w === 57);
  expectSeparateSlots(frames(), 320);
});

test("a sheet floats above the bar, inset as the bar is, and leaves room above it", () => {
  // A 780pt page whose bar takes 90pt (58 + 8 below + 12 clear + 12 of system bar): the same gap
  // at the sides as above the bar (the room ends with it), 62% of the page at most.
  expect(mobileSheetFrame(360, 780, 90)).toEqual({ top: 12, right: 12, bottom: 90, left: 12, maxHeight: Math.floor(780 * 0.62), maxWidth: 336 });
  // In landscape the room between the top gap and the bar holds it: 360 - 12 - 90, capped at 62%.
  expect(mobileSheetFrame(780, 360, 90).maxHeight).toBe(Math.floor(360 * 0.62));
  // Never wider than the popups' widest.
  expect(mobileSheetFrame(780, 360, 90).maxWidth).toBe(POPUP_MAX_WIDTH);
  // Without the bar it keeps the gap from the foot too, above the bottom inset.
  expect(mobileSheetFrame(360, 780, 0).bottom).toBe(12);
  expect(mobileSheetFrame(360, 780, 0, { bottom: 34 }).bottom).toBe(46);
  // The insets the page lies under (a phone browser on its side): the gap inside each.
  expect(mobileSheetFrame(780, 360, 90, { left: 44, right: 48 })).toMatchObject({ left: 56, right: 60 });
  // The keyboard over the page's foot (the agents' filter): above it, when it reaches higher than the bar.
  expect(mobileSheetFrame(360, 780, 90, {}, 300).bottom).toBe(312);
  // Never shorter than a few rows.
  expect(mobileSheetFrame(360, 200, 90).maxHeight).toBe(120);
});

/** A sheet's frame: the page's width less the popups' gap at each side (12pt, the bar's margins),
 * up to the popups' widest and centred; its foot the same gap off the page's, above the bottom
 * inset `area` leaves (the fixture has no route, so no bar room); and it comes in from below. */
function expectFloatingSheet(
  frames: Record<string, Frame>,
  name: string,
  width: number,
  height: number,
  area: { left: number; right: number; bottom: number; top?: number } = { left: 0, right: 0, bottom: 0 },
) {
  const sheet = frames[name];
  expect(sheet).toBeDefined();
  const room = width - area.left - area.right - 2 * POPUP_GAP;
  const wide = Math.min(room, POPUP_MAX_WIDTH);
  expect(Math.abs(sheet.w - wide)).toBeLessThan(0.5);
  expect(Math.abs(sheet.x - (area.left + POPUP_GAP + (room - wide) / 2))).toBeLessThan(0.5);
  expect(sheet.y).toBeGreaterThanOrEqual(POPUP_GAP);
  // The gap under it shows above the inset: the sheet's own bottom edge ends there.
  expect(Math.abs(sheet.y + sheet.h - (height - area.bottom - POPUP_GAP))).toBeLessThan(0.5);
  // It slides up from below the page's bottom edge: out of sight there (its top past the foot),
  // never from above.
  expect(sheet.from).toBeGreaterThan(0);
  expect(sheet.y + (sheet.from as number)).toBeGreaterThan(height);
}

for (const [label, width, height] of [
  ["a 360pt phone", 360, 780],
  ["a phone in landscape", 780, 360],
] as const) {
  test(`on ${label} More and the agents open the same floating sheet`, async () => {
    const { app, frames } = await openNav(width, height, { host: { params: { agents: 3 } } });
    await app.press("id:mobile-nav-more");
    await app.waitFor("id:mobile-more-sheet");
    await app.waitUntil(() => Boolean(frames()["mobile-more"]));
    expectFloatingSheet(frames(), "mobile-more", width, height);

    await app.press("id:mobile-nav-agent");
    await app.waitFor("id:mobile-agents-list");
    await app.waitFor("id:mobile-more", { state: "gone" });
    await app.waitUntil(() => Boolean(frames()["mobile-agents"]));
    expectFloatingSheet(frames(), "mobile-agents", width, height);
    expect(app.count("role:option")).toBe(4);
    await app.keyboard.press("escape");
    await app.waitFor("id:mobile-agents", { state: "gone" });
  });
}

test("in a phone browser More and the agents keep the gap inside the notch, the side bar and the home indicator", async () => {
  // An iPhone's browser: the frame takes no inset there, so the sheets' layer does.
  for (const [width, height, area] of [
    [390, 844, { top: 47, right: 0, bottom: 34, left: 0 }],
    [844, 390, { top: 0, right: 48, bottom: 21, left: 44 }],
  ] as const) {
    const { app, frames } = await openNav(width, height, { platform: "ios", safeArea: area, host: { params: { agents: 3 } } });
    await app.press("id:mobile-nav-more");
    await app.waitUntil(() => Boolean(frames()["mobile-more"]));
    expectFloatingSheet(frames(), "mobile-more", width, height, area);
    expect(frames()["mobile-more"].y).toBeGreaterThanOrEqual(area.top + POPUP_GAP);
    await app.press("id:mobile-nav-agent");
    await app.waitUntil(() => Boolean(frames()["mobile-agents"]));
    expectFloatingSheet(frames(), "mobile-agents", width, height, area);
    await app.dispose();
  }
});

test("More and the agents slide up from below the page's bottom edge, and back down out of sight", async () => {
  const height = 780;
  const { app, frames, sampled } = await openNav(360, height, { host: { params: { agents: 3 } } });
  for (const [slot, name, part] of [
    ["mobile-nav-more", "mobile-more", "mobile-more-sheet"],
    ["mobile-nav-agent", "mobile-agents", "mobile-agents-list"],
  ] as const) {
    for (const turn of [1, 2]) {
      await app.press(`id:${slot}`);
      await app.waitFor(`id:${part}`);
      const sheet = frames()[name];
      const from = sheet.from as number;
      // Out of sight is below: a positive translation that puts the sheet's top past the page's foot.
      expect(from).toBeGreaterThan(0);
      expect(sheet.y + from).toBeGreaterThan(height);
      // The sheet is `from * (1 - progress)` below its place: coming in, that only shrinks, from
      // the whole way down to none.
      const coming = (await sampled(`${name}.in${turn}`)).map((s) => from * (1 - s.p));
      expect(sheet.y + coming[0]).toBeGreaterThan(height - 40);
      for (let i = 1; i < coming.length; i++) expect(coming[i]).toBeLessThanOrEqual(coming[i - 1]);
      expect(coming.filter((y) => y > 0 && y < from).length).toBeGreaterThan(2);
      for (const y of coming) expect(y).toBeGreaterThanOrEqual(0);
      expect(coming[coming.length - 1]).toBe(0);

      // Closed (the same slot again), it only sinks, to out of sight, and is unmounted there.
      await app.press(`id:${slot}`);
      const going = (await sampled(`${name}.out${turn}`)).map((s) => from * (1 - s.p));
      expect(going[0]).toBeLessThan(from * 0.5);
      for (let i = 1; i < going.length; i++) expect(going[i]).toBeGreaterThanOrEqual(going[i - 1]);
      expect(going.filter((y) => y > 0 && y < from).length).toBeGreaterThan(2);
      expect(going[going.length - 1]).toBe(from);
      await app.waitFor(`id:${name}`, { state: "gone" });
      expect(app.count(`id:${part}`)).toBe(0);
    }
  }
  await app.dispose();
});

test("More opened again while it goes out turns back from where it is", async () => {
  const { app, frames, sampled } = await openNav(360, 780, { host: { params: { agents: 3 } } });
  await app.press("id:mobile-nav-more");
  await app.waitFor("id:mobile-more-sheet");
  await sampled("mobile-more.in1");
  const from = frames()["mobile-more"].from as number;
  await app.press("id:bounce-more");
  const back = (await sampled("mobile-more.in2")).map((s) => from * (1 - s.p));
  // Part way down when it turned (the lowest point; values read a frame late): it never went out
  // of sight nor jumped there, and from that point it only comes up, to its place.
  const lowest = back.reduce((at, y, i) => (y > back[at] ? i : at), 0);
  expect(back[lowest]).toBeGreaterThan(0);
  expect(back[lowest]).toBeLessThan(from * 0.95);
  for (let i = lowest + 1; i < back.length; i++) expect(back[i]).toBeLessThanOrEqual(back[i - 1]);
  expect(back[back.length - 1]).toBe(0);
  // It was never taken down: the sheet is there, open, and takes presses.
  expect(app.count("id:mobile-more-sheet")).toBe(1);
  await app.keyboard.press("escape");
  await app.waitFor("id:mobile-more", { state: "gone" });
  await app.dispose();
});

test("with reduced motion More and the agents are in place at once, in the same place", async () => {
  const moving = await openNav(360, 780, { host: { params: { agents: 3 } } });
  const still = await openNav(360, 780, { reducedMotion: true, host: { params: { agents: 3 } } });
  for (const [slot, name, part] of [
    ["mobile-nav-more", "mobile-more", "mobile-more-sheet"],
    ["mobile-nav-agent", "mobile-agents", "mobile-agents-list"],
  ] as const) {
    for (const run of [moving, still]) {
      await run.app.press(`id:${slot}`);
      await run.app.waitFor(`id:${part}`);
      await run.app.waitUntil(() => Boolean(run.frames()[name]));
    }
    const { from: _moving, ...rest } = moving.frames()[name];
    const { from: _still, ...same } = still.frames()[name];
    expect(same).toEqual(rest);
    // Closed, it is gone at once (no slide to wait for).
    await still.app.press(`id:${slot}`);
    expect(still.app.count(`id:${part}`)).toBe(0);
    await moving.app.press(`id:${slot}`);
    await moving.app.waitFor(`id:${name}`, { state: "gone" });
  }
  await moving.app.dispose();
  await still.app.dispose();
});

test("the agents' sheet is as tall as its rows, with no empty stretch to scroll", async () => {
  const heights: number[] = [];
  for (const agents of [1, 3]) {
    const { app, frames } = await openNav(390, 844, { host: { params: { agents } } });
    await app.press("id:mobile-nav-agent");
    await app.waitFor("id:mobile-agents-list");
    await app.waitUntil(() => Boolean(frames()["mobile-agents"]));
    await app.wait(400);
    heights.push(frames()["mobile-agents"].h);
    await app.dispose();
  }
  // Two more rows, two rows taller (44pt a row and the gap between rows): the list follows its rows.
  const perRow = (heights[1] - heights[0]) / 2;
  expect(perRow).toBeGreaterThan(40);
  expect(perRow).toBeLessThan(50);
  // One agent: the title, one row, the overview row and the padding, nothing else.
  expect(heights[0]).toBeLessThan(39 + 2 * 50 + 30);
});

test("a long list of agents is held under the window's top, and scrolls", async () => {
  const { app, frames } = await openNav(360, 640, { host: { params: { agents: 30 } } });
  await app.press("id:mobile-nav-agent");
  await app.waitFor("id:mobile-agents-list");
  await app.waitUntil(() => Boolean(frames()["mobile-agents"]));
  const sheet = frames()["mobile-agents"];
  expect(sheet.h).toBeLessThanOrEqual(640 * 0.62 + 0.5);
  expect(sheet.y).toBeGreaterThan(0);
  // More than eight agents: the filter heads the list.
  expect(app.shows("id:mobile-agents-filter")).toBe(true);
  await app.press("id:mobile-agent-option-ep_29");
  await app.waitFor("id:mobile-agents", { state: "gone" });
});
