// Popups on phones (design/mobile-popups.md): every menu, select, date picker, picker bubble and
// dialog the console draws is the floating paper of More and the agent switcher there: a small
// gap from the window's left, right and bottom outside the system's insets and the keyboard, never
// above the status bar, tall content scrolling inside it, sliding in from above the window's top
// edge (at once with reduced motion). The desktops keep their dropdowns at the trigger and their
// centred dialogs. The numbers are lib/mobilePopup.ts's; the frames and motion come from
// tests/fixtures/mobile-popup-app.tsx (the bottom navigation's own two are in
// tests/mobile-bottom-nav.test.tsx, the dialogs' actions in tests/dialog-sheet.test.tsx). The
// paper's four round corners are one inline `borderRadius` (POPUP_RADIUS) headless tests cannot
// read back: what is checked here is that its bottom edge, corners included, ends above the inset.
import type { Platform, SafeArea } from "nsh/test";
import { expect, open, test } from "nsh/test";
import { mobilePopupEntrance, mobilePopupFrame, POPUP_GAP, POPUP_MAX_WIDTH, POPUP_MIN_HEIGHT } from "../lib/mobilePopup";
import { joinDateValue, splitDateValue } from "../components/shared/DateField";

type Frame = { x: number; y: number; w: number; h: number };
type Sample = { t: number; y: number; s: number; o: number };

/** A phone with three-button navigation: a 24pt status bar, a 48pt navigation bar. */
const BUTTONS = { top: 24, right: 0, bottom: 48, left: 0 };
/** An iPhone: its notch and home indicator. */
const HOME_INDICATOR = { top: 47, right: 0, bottom: 34, left: 0 };
/** A phone on its side: the notch at the left, the navigation bar at the right, a gesture handle. */
const SIDEWAYS = { top: 0, right: 48, bottom: 21, left: 44 };

/** The popups behind a trigger: how the test opens each, and its layer's name in the report. */
const DROPDOWNS = [
  { kind: "a menu of commands", trigger: "id:menu", name: "Topic", row: "Rename" },
  { kind: "a settings list", trigger: "label:Unit", name: "unit-popup", row: "hours" },
  { kind: "a picker bubble", trigger: "id:picker", name: "picker-popup", row: "Choice 2" },
  { kind: "a select", trigger: "label:Plain", name: "select-popup", row: "Choice 2" },
  { kind: "a searchable select", trigger: "label:Searchable", name: "search-popup", row: "Choice 2" },
  { kind: "a TODO select", trigger: "label:Chat", name: "todo-popup", row: "Choice 2" },
  { kind: "a date and time picker", trigger: "label:Run at", name: "date-popup", row: "17" },
  { kind: "a date picker that clears", trigger: "label:Since", name: "since-popup", row: "17" },
] as const;
/** The dialogs: their opening button, and their layer's name. */
const DIALOGS = [
  { kind: "a dialog", trigger: "id:open-modal", name: "modal", widest: 560 },
  { kind: "a message", trigger: "id:open-message", name: "message", widest: 500 },
  { kind: "the attachment sources", trigger: "id:open-attach", name: "attach", widest: 560 },
  { kind: "a settings dialog", trigger: "id:open-setting", name: "setting", widest: 720 },
] as const;

interface Options {
  platform?: Platform;
  width?: number;
  height?: number;
  safeArea?: SafeArea | null;
  reducedMotion?: boolean;
  long?: boolean;
}

async function openFixture(options: Options = {}) {
  const width = options.width ?? 390;
  const height = options.height ?? 844;
  const platform = options.platform ?? "android";
  const app = await open("./fixtures/mobile-popup-app.tsx", {
    width,
    height,
    locale: "en-US",
    platform,
    safeArea: options.safeArea ?? null,
    reducedMotion: options.reducedMotion ?? false,
    host: { params: { long: !!options.long } },
  });
  const report = () => JSON.parse(app.texts().find((text) => text.startsWith("{")) ?? "{}") as Record<string, unknown>;
  const frame = (name: string) => report()[`${name}.panel`] as Frame | undefined;
  await app.waitFor("id:close-all");
  /** Opens a popup and waits for its paper to have come in. */
  const show = async (trigger: string, name: string) => {
    await app.press(trigger);
    await app.waitUntil(() => frame(name) !== undefined);
    await app.wait(450);
    return frame(name)!;
  };
  /** Closes whatever is open: Back on Android (the system's dismissal), Escape's owner elsewhere. */
  const dismiss = async () => {
    if (platform === "android") await app.back();
    else await app.press("id:close-all");
    await app.wait(350);
  };
  /** Opens a popup and gives its paper's motion, sampled from its first layout on. */
  const sampled = async (trigger: string, name: string) => {
    await app.press(trigger);
    await app.waitUntil(() => report()[`${name}.motion`] !== undefined);
    return report()[`${name}.motion`] as Sample[];
  };
  return { app, report, frame, show, dismiss, sampled, width, height };
}

/** The paper keeps POPUP_GAP from the left, the right and the bottom, outside `area` and `keyboard`, and stays under the status bar. */
function expectFloating(
  frame: Frame,
  window: { width: number; height: number },
  area: { top: number; right: number; bottom: number; left: number },
  keyboard = 0,
  widest = POPUP_MAX_WIDTH,
) {
  const left = area.left + POPUP_GAP;
  const right = window.width - area.right - POPUP_GAP;
  const bottom = window.height - Math.max(area.bottom, keyboard) - POPUP_GAP;
  // The bottom gap is in view above the inset: the paper's own edge (its round corners) ends there.
  expect(Math.abs(frame.y + frame.h - bottom)).toBeLessThan(0.5);
  expect(frame.x).toBeGreaterThanOrEqual(left - 0.5);
  expect(frame.x + frame.w).toBeLessThanOrEqual(right + 0.5);
  // As wide as the room, up to the paper's widest, centred in it.
  const room = right - left;
  expect(Math.abs(frame.w - Math.min(room, widest))).toBeLessThan(0.5);
  expect(Math.abs(frame.x - left - (room - frame.w) / 2)).toBeLessThan(1);
  expect(frame.y).toBeGreaterThanOrEqual(area.top + POPUP_GAP - 0.5);
}

test("the paper's place: a gap outside every inset, the keyboard in place of the bottom one", () => {
  // No insets: the gap alone, on every side; the paper is as tall as what is left.
  expect(mobilePopupFrame({ width: 390, height: 844 })).toEqual({ top: 12, right: 12, bottom: 12, left: 12, maxHeight: 820, maxWidth: 366 });
  // A status bar and a navigation bar: the gap is added to each, so the bottom one shows above the bar.
  expect(mobilePopupFrame({ width: 390, height: 844, area: BUTTONS })).toEqual({ top: 36, right: 12, bottom: 60, left: 12, maxHeight: 748, maxWidth: 366 });
  expect(mobilePopupFrame({ width: 390, height: 844, area: HOME_INDICATOR }).bottom).toBe(46);
  // The keyboard covers the navigation bar: its height replaces the inset, never both.
  expect(mobilePopupFrame({ width: 390, height: 844, area: BUTTONS, keyboard: 300 })).toEqual({ top: 36, right: 12, bottom: 312, left: 12, maxHeight: 496, maxWidth: 366 });
  // A keyboard lower than the bar (a floating one): the bar still.
  expect(mobilePopupFrame({ width: 390, height: 844, area: BUTTONS, keyboard: 20 }).bottom).toBe(60);
  // Landscape: the notch and the navigation bar at the sides, the paper no wider than its widest.
  expect(mobilePopupFrame({ width: 844, height: 390, area: SIDEWAYS })).toEqual({ top: 12, right: 60, bottom: 33, left: 56, maxHeight: 345, maxWidth: POPUP_MAX_WIDTH });
  // A narrow phone: the gaps stay, the paper takes what is left.
  expect(mobilePopupFrame({ width: 288, height: 624 }).maxWidth).toBe(264);
  // Over the bottom navigation: its room (which ends with the gap) replaces the inset and the gap,
  // unless the keyboard reaches higher; More and the agents take 62% of the page at most.
  expect(mobilePopupFrame({ width: 390, height: 844, area: { bottom: 34 }, below: 124 }).bottom).toBe(124);
  expect(mobilePopupFrame({ width: 390, height: 844, below: 78, keyboard: 300 }).bottom).toBe(312);
  expect(mobilePopupFrame({ width: 390, height: 844, below: 78, share: 0.62 }).maxHeight).toBe(523);
  // Hardly any room (a keyboard on a phone on its side): a least height, scrolling inside; never negative.
  expect(mobilePopupFrame({ width: 844, height: 390, keyboard: 320 }).maxHeight).toBe(POPUP_MIN_HEIGHT);
  expect(mobilePopupFrame({ width: 0, height: 0 }).maxWidth).toBe(0);
  // Insets that are not numbers count for nothing.
  expect(mobilePopupFrame({ width: 390, height: 844, area: { top: Number.NaN, bottom: -3 }, keyboard: Number.NaN }).bottom).toBe(12);
});

test("the paper comes from above the window's top edge, wherever it lands", () => {
  // A paper 300pt tall whose top is at 484: out of sight once it is 784pt (and a point) up.
  expect(mobilePopupEntrance(484, 300, 844)).toBe(-785);
  expect(mobilePopupEntrance(0, 100, 844)).toBe(-101);
  // Not laid out yet: a window's height up, never in view.
  expect(mobilePopupEntrance(0, 0, 844)).toBe(-844);
  expect(mobilePopupEntrance(0, 0, 0)).toBe(-1);
  for (const [y, height] of [[36, 748], [500, 120], [0, 844]] as const) {
    expect(mobilePopupEntrance(y, height, 844)).toBeLessThan(0);
    expect(y + height + mobilePopupEntrance(y, height, 844)).toBeLessThan(0);
  }
});

test("a date picker's value: the date, and the time when it has a time field", () => {
  expect(splitDateValue("2026-03-04T09:30")).toEqual({ date: "2026-03-04", time: "09:30" });
  expect(splitDateValue("2026-03-04 09:30:15")).toEqual({ date: "2026-03-04", time: "09:30:15" });
  expect(splitDateValue("2026-03-04")).toEqual({ date: "2026-03-04", time: "" });
  expect(splitDateValue(null)).toEqual({ date: "", time: "" });
  expect(splitDateValue(["2026-03-04", null])).toEqual({ date: "", time: "" });
  expect(joinDateValue("2026-03-17", "09:30", true, "2026-01-01")).toBe("2026-03-17T09:30");
  expect(joinDateValue("2026-03-17", "09:30", false, "2026-01-01")).toBe("2026-03-17");
  // A time set before any date: today's; a date with no time yet: midnight.
  expect(joinDateValue("", "10:15", true, "2026-01-01")).toBe("2026-01-01T10:15");
  expect(joinDateValue("2026-03-17", "", true, "2026-01-01")).toBe("2026-03-17T00:00");
});

for (const [label, options] of [
  ["an Android phone with three-button navigation", { platform: "android", safeArea: BUTTONS }],
  ["an iPhone", { platform: "ios", safeArea: HOME_INDICATOR }],
  ["a narrow browser window", { platform: "linux", safeArea: null }],
  ["a 320pt phone", { platform: "android", width: 320, height: 640, safeArea: BUTTONS }],
  ["a phone on its side", { platform: "android", width: 844, height: 390, safeArea: SIDEWAYS }],
] as const) {
  test(`on ${label} every dropdown, bubble and dialog is the floating paper: gaps left, right and below, above the inset`, async () => {
    const run = await openFixture(options);
    const area = options.safeArea ?? { top: 0, right: 0, bottom: 0, left: 0 };
    const flow = run.report().flow;
    for (const popup of [...DROPDOWNS, ...DIALOGS]) {
      const frame = await run.show(popup.trigger, popup.name);
      // A dropdown's paper is never wider than POPUP_MAX_WIDTH; a dialog keeps its own widest.
      expectFloating(frame, run, area, 0, "widest" in popup ? popup.widest : POPUP_MAX_WIDTH);
      // Declared in a column of controls, the popup takes no room there, open or shut.
      expect(run.report().flow).toBe(flow);
      await run.dismiss();
    }
    run.app.dispose();
  });
}

test("a tall list scrolls inside the paper, which stays under the status bar; its last rows are reached", async () => {
  const run = await openFixture({ safeArea: BUTTONS, long: true });
  const most = mobilePopupFrame({ width: run.width, height: run.height, area: BUTTONS }).maxHeight;
  for (const popup of DROPDOWNS.filter((item) => !item.name.includes("date") && !item.name.includes("since") && item.name !== "unit-popup")) {
    const frame = await run.show(popup.trigger, popup.name);
    expectFloating(frame, run, BUTTONS);
    expect(frame.h).toBeLessThanOrEqual(most + 0.5);
    // Taller than the few rows' paper: the long list fills the room it is given.
    expect(frame.h).toBeGreaterThan(400);
    await run.dismiss();
  }
  // The last of a long menu's commands is chosen from inside the paper (it scrolls there).
  await run.show("id:menu", "Topic");
  await run.app.scroll("label:Rename", 4000);
  await run.app.press("label:More 29");
  await run.app.waitUntil(() => run.report().chosen === "more29");
  // A long dialog: its body scrolls, its actions stay in the paper, as tall as a finger needs.
  const dialog = await run.show("id:open-modal", "modal");
  expectFloating(dialog, run, BUTTONS);
  expect(Math.abs(dialog.h - most)).toBeLessThanOrEqual(1);
  expect((run.report()["modal.save"] as { h: number }).h).toBeGreaterThanOrEqual(38);
  await run.app.press("id:modal-save");
  await run.app.waitFor("id:modal-save", { state: "gone" });
  run.app.dispose();
});

test("with the software keyboard up every paper stands on it, the gap above it, and shrinks to the room left", async () => {
  const run = await openFixture({ safeArea: BUTTONS, long: true });
  await run.app.press("id:keyboard-up");
  const most = mobilePopupFrame({ width: run.width, height: run.height, area: BUTTONS, keyboard: 300 }).maxHeight;
  for (const popup of [DROPDOWNS[0], DROPDOWNS[2], DROPDOWNS[4], DROPDOWNS[6], DIALOGS[0], DIALOGS[3]]) {
    const frame = await run.show(popup.trigger, popup.name);
    // The keyboard covers the navigation bar: its height, not both.
    expectFloating(frame, run, BUTTONS, 300, "widest" in popup ? popup.widest : POPUP_MAX_WIDTH);
    expect(frame.h).toBeLessThanOrEqual(most + 0.5);
    await run.dismiss();
  }
  // An open paper follows the keyboard as it comes up and goes down.
  const down = await run.app.press("id:keyboard-down").then(() => run.show("label:Searchable", "search-popup"));
  expectFloating(down, run, BUTTONS);
  await run.app.press("id:keyboard-up");
  await run.app.waitUntil(() => Math.abs(run.frame("search-popup")!.y + run.frame("search-popup")!.h - (844 - 300 - POPUP_GAP)) < 0.5);
  await run.app.press("id:keyboard-down");
  await run.app.waitUntil(() => Math.abs(run.frame("search-popup")!.y + run.frame("search-popup")!.h - (844 - 48 - POPUP_GAP)) < 0.5);
  run.app.dispose();
});

test("each paper slides in from above the window's top edge, never from below", async () => {
  const run = await openFixture({ safeArea: BUTTONS });
  for (const popup of [DROPDOWNS[0], DROPDOWNS[2], DROPDOWNS[3], DROPDOWNS[6], DIALOGS[0], DIALOGS[1]]) {
    const samples = await run.sampled(popup.trigger, popup.name);
    const frame = run.frame(popup.name)!;
    const ys = samples.map((sample) => sample.y);
    // It starts out of sight above the top edge: its whole frame, and more, up.
    expect(Math.min(...ys)).toBeLessThanOrEqual(-(frame.y + frame.h));
    // Never below its place: the translation is negative all the way, and ends at rest.
    expect(Math.max(...ys)).toBe(0);
    expect(ys[ys.length - 1]).toBe(0);
    // Once it moves it only comes down.
    const moving = ys.slice(ys.findIndex((y) => y > Math.min(...ys)));
    expect(moving.length).toBeGreaterThan(2);
    for (let i = 1; i < moving.length; i += 1) expect(moving[i]).toBeGreaterThanOrEqual(moving[i - 1]);
    // It slides; it does not scale or fade in as a desktop dialog does.
    const shown = samples.filter((sample) => sample.y > Math.min(...ys));
    expect(shown.every((sample) => sample.s === 1 && sample.o === 1)).toBe(true);
    await run.dismiss();
  }
  run.app.dispose();
});

test("with reduced motion each paper is in its place at once, the same place", async () => {
  const moving = await openFixture({ safeArea: BUTTONS });
  const still = await openFixture({ safeArea: BUTTONS, reducedMotion: true });
  for (const popup of [DROPDOWNS[0], DROPDOWNS[3], DROPDOWNS[6], DIALOGS[0]]) {
    const samples = await still.sampled(popup.trigger, popup.name);
    const frame = still.frame(popup.name)!;
    // No displacement in view: wherever it is drawn it is at rest (before its first layout it
    // waits out of sight above, never part-way).
    const hidden = -(frame.y + frame.h);
    expect(samples.every((sample) => sample.y === 0 || sample.y <= hidden)).toBe(true);
    expect(samples[samples.length - 1].y).toBe(0);
    expect(samples.filter((sample) => sample.y === 0).length).toBeGreaterThan(samples.length / 2);
    expect(frame).toEqual(await moving.show(popup.trigger, popup.name));
    await still.dismiss();
    await moving.dismiss();
  }
  moving.app.dispose();
  still.app.dispose();
});

test("the papers keep what their popups do: choosing, cancelling, their names and roles", async () => {
  const run = await openFixture({ safeArea: BUTTONS });
  const { app } = run;
  const chosen = () => run.report().chosen;

  // A menu: its commands are menu items by name, a disabled one inert, a choice closes the paper.
  await run.show("id:menu", "Topic");
  await app.waitFor("text:TOPIC");
  await expect(app.press("role:menuitem[Locked]")).rejects.toThrow();
  await app.press("role:menuitem[Delete]");
  await app.waitUntil(() => chosen() === "delete");
  await app.waitFor("text:TOPIC", { state: "gone" });
  // Cancelled (Back): nothing chosen, the paper gone.
  await run.show("id:menu", "Topic");
  await run.dismiss();
  await app.waitFor("text:TOPIC", { state: "gone" });
  expect(chosen()).toBe("delete");

  // A select: a row pressed is reported, and the paper goes.
  await run.show("label:Plain", "select-popup");
  await app.press("role:option[Choice 3]");
  await app.waitUntil(() => chosen() === "select:v3");
  await app.waitFor("id:select-popup-list", { state: "gone" });

  // A searchable select: its filter narrows the rows.
  await run.show("label:Searchable", "search-popup");
  await app.type("id:search-popup-filter", "Choice 2");
  await app.waitFor("role:option[Choice 0]", { state: "gone" });
  await app.press("role:option[Choice 2]");
  await app.waitUntil(() => chosen() === "search:v2");

  // A settings list and a picker bubble.
  await run.show("label:Unit", "unit-popup");
  await app.press("role:option[hours]");
  await app.waitUntil(() => chosen() === "unit:3600");
  await run.show("id:picker", "picker-popup");
  await app.press("id:picker-option-v0");
  await app.waitUntil(() => chosen() === "picker:v0");
  await app.waitFor("id:picker-option-v0", { state: "gone" });

  // A date and time picker: a day sets the date, keeps the time and closes the paper.
  await run.show("label:Run at", "date-popup");
  await app.press("id:date-popup-content >> text:17");
  await app.waitUntil(() => chosen() === "date:2026-03-17T09:30");
  await app.waitFor("id:date-popup-content", { state: "gone" });
  // One that clears: no button while there is no date, then it clears and closes.
  await run.show("label:Since", "since-popup");
  expect(app.count("id:since-popup-clear")).toBe(0);
  await app.press("id:since-popup-content >> text:17");
  await app.waitUntil(() => String(chosen()).startsWith("since:20"));
  await app.waitFor("id:since-popup-content", { state: "gone" });
  await run.show("label:Since", "since-popup");
  await app.press("id:since-popup-clear");
  await app.waitUntil(() => chosen() === "since:");

  // The attachment sources: a choice is reported.
  await run.show("id:open-attach", "attach");
  await app.press("id:attach-files");
  await app.waitUntil(() => chosen() === "attach:files");
  app.dispose();
});

for (const [label, options] of [
  ["a desktop window", { platform: "linux", width: 1280, height: 800 }],
  ["a tablet-wide desktop window", { platform: "linux", width: 800, height: 800 }],
] as const) {
  test(`${label} keeps its dropdowns at their triggers and its dialogs centred`, async () => {
    const run = await openFixture(options);
    const { app } = run;
    // The menu, the lists and the calendars are nsh/base's popups at the trigger: no paper is made.
    await app.press("id:menu");
    await app.waitFor("role:menuitem[Rename]");
    expect(run.frame("Topic")).toBeUndefined();
    await app.press("role:menuitem[Rename]");
    await app.waitUntil(() => run.report().chosen === "rename");
    await app.press("label:Plain");
    await app.waitFor("role:menuitemcheckbox[Choice 3]");
    await app.press("role:menuitemcheckbox[Choice 3]");
    await app.waitUntil(() => run.report().chosen === "select:v3");
    await app.press("id:picker");
    await app.waitFor("id:picker-tail");
    await app.press("id:picker-option-v0");
    await app.waitUntil(() => run.report().chosen === "picker:v0");
    for (const name of ["Topic", "select-popup", "picker-popup", "unit-popup", "date-popup"]) expect(run.frame(name)).toBeUndefined();

    // A dialog: centred in the window, its own width, well clear of every edge; it settles in
    // with a fade and a scale, and never slides.
    const samples = await run.sampled("id:open-modal", "modal");
    const dialog = run.frame("modal")!;
    expect(dialog.w).toBe(560);
    expect(Math.abs(dialog.x - (run.width - dialog.w) / 2)).toBeLessThan(1);
    expect(Math.abs(dialog.y - (run.height - dialog.h) / 2)).toBeLessThan(1);
    expect(samples.every((sample) => sample.y === 0)).toBe(true);
    expect(samples.some((sample) => sample.o < 1)).toBe(true);
    expect(samples[samples.length - 1].s).toBe(1);
    await app.press("id:close-all");
    const message = await run.show("id:open-message", "message");
    expect(message.w).toBe(500);
    expect(Math.abs(message.y - (run.height - message.h) / 2)).toBeLessThan(1);
    app.dispose();
  });
}
