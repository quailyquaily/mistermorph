// Dialogs on phones (components/ui.tsx DialogLayer, under Modal, MessageDialog and SettingDialog):
// the floating paper of More and the agent switcher (design/mobile-popups.md, lib/mobilePopup.ts).
// It keeps a small gap from the window's sides and from the bottom, above the room the system
// takes there (the navigation bar, gesture handle or home indicator; the keyboard instead while it
// is up), which the layer takes once: the paper is no taller for it. Exactly two footer actions
// share the row's width while other counts, and every desktop dialog, keep their own; the paper
// slides in from above the window's top edge and back out there, its contents mounted until it is
// out, and lands at once with reduced motion. Frames and motion come from
// tests/fixtures/dialog-sheet-app.tsx; the other popups are in tests/mobile-popup.test.tsx.
import type { Platform, SafeArea } from "nsh/test";
import { expect, open, test } from "nsh/test";
import { mobilePopupEntrance, mobilePopupFrame, POPUP_GAP } from "../lib/mobilePopup";

type Frame = { y: number; h: number; w: number };
type Sample = { t: number; y: number; s: number; o: number; alive: boolean };

const HEIGHT = 844;
/** A phone with three-button navigation: a 48pt navigation bar. */
const BUTTONS = { top: 24, right: 0, bottom: 48, left: 0 };
/** A phone with gesture navigation: a 16pt gesture handle. */
const GESTURE = { top: 24, right: 0, bottom: 16, left: 0 };
/** An iPhone: its home indicator. */
const HOME_INDICATOR = { top: 47, right: 0, bottom: 34, left: 0 };

async function openFixture(options: { platform?: Platform; width?: number; safeArea?: SafeArea | null; reducedMotion?: boolean } = {}) {
  const app = await open("./fixtures/dialog-sheet-app.tsx", {
    width: options.width ?? 390,
    height: HEIGHT,
    locale: "en-US",
    platform: options.platform ?? "android",
    safeArea: options.safeArea ?? null,
    reducedMotion: options.reducedMotion ?? false,
  });
  const report = () => JSON.parse(app.texts().find((text) => text.startsWith("{")) ?? "{}") as Record<string, unknown>;
  const frame = (key: string) => report()[key] as Frame;
  const width = (key: string) => report()[key] as number;
  const samples = (key: string) => report()[key] as Sample[];
  await app.waitFor("id:open-two");
  /** Opens a dialog and waits until its entrance has been sampled. */
  const show = async (kind: string, opening = 1) => {
    await app.press(`id:open-${kind}`);
    await app.waitUntil(() => report()[`${kind}.in${opening}`] !== undefined);
    return samples(`${kind}.in${opening}`);
  };
  /** Waits until the closing of a dialog has been sampled. */
  const closed = async (kind: string, opening = 1) => {
    await app.waitUntil(() => report()[`${kind}.out${opening}`] !== undefined);
    return samples(`${kind}.out${opening}`);
  };
  /** Closes the open dialog: Back on Android (the system's dismissal), its owner elsewhere. */
  const dismiss = async () => {
    if ((options.platform ?? "android") === "android") await app.back();
    else await app.press("id:close-all");
  };
  return { app, report, frame, width, samples, show, closed, dismiss };
}

/** How far up a paper is out of sight (lib/mobilePopup.ts): what it slides by. */
const away = (panel: Frame) => mobilePopupEntrance(panel.y, panel.h, HEIGHT);

for (const [name, platform, safeArea, inset] of [
  ["Android, three-button navigation", "android", BUTTONS, 48],
  ["iOS, a home indicator", "ios", HOME_INDICATOR, 34],
] as const) {
  test(`on ${name} each dialog's paper floats above the bottom inset, a gap under it and at its sides`, async () => {
    const bare = await openFixture({ platform, safeArea: null });
    const withInset = await openFixture({ platform, safeArea });
    for (const kind of ["two", "message2", "setting", "bare"]) {
      for (const run of [bare, withInset]) {
        await run.show(kind);
        await run.dismiss();
        await run.closed(kind);
      }
      const plain = bare.frame(`${kind}.panel`);
      const sheet = withInset.frame(`${kind}.panel`);
      // The paper ends a gap above the bottom edge, and above the inset where there is one: the
      // layer takes the room once, so the paper is no taller for it (nothing is padded twice, and
      // its own bottom edge, with its round corners, shows above the inset).
      expect(plain.y + plain.h).toBe(HEIGHT - POPUP_GAP);
      expect(sheet.y + sheet.h).toBe(HEIGHT - inset - POPUP_GAP);
      expect(sheet.h).toBe(plain.h);
      // The same gap at each side.
      expect(sheet.w).toBe(390 - 2 * POPUP_GAP);
      // Below the status bar.
      expect(sheet.y).toBeGreaterThanOrEqual(safeArea.top + POPUP_GAP);
    }
    // The footer's row is the paper's last, inside its hairline.
    const footer = withInset.frame("two.footer");
    expect(footer.y + footer.h).toBe(HEIGHT - inset - POPUP_GAP - 1);
    bare.app.dispose();
    withInset.app.dispose();
  });
}

test("a long dialog keeps its body to the room above the inset, its actions in view", async () => {
  const { app, frame, show, closed } = await openFixture({ safeArea: BUTTONS });
  await show("long");
  const panel = frame("long.panel");
  expect(panel.y + panel.h).toBe(HEIGHT - 48 - POPUP_GAP);
  // The room between the status bar and the navigation bar, less the gap at each end.
  expect(panel.h).toBe(mobilePopupFrame({ width: 390, height: HEIGHT, area: BUTTONS }).maxHeight);
  expect(panel.y).toBe(BUTTONS.top + POPUP_GAP);
  const footer = frame("long.footer");
  expect(footer.y + footer.h).toBe(HEIGHT - 48 - POPUP_GAP - 1);
  // The body still scrolls under the title bar, the footer staying where it is.
  await app.scroll("id:row-0", 1200);
  await app.wait(100);
  expect(frame("long.footer")).toEqual(footer);
  expect(frame("long.panel")).toEqual(panel);
  await app.press("id:dialog-long-close");
  await closed("long");
  expect(app.count("id:body-long")).toBe(0);
  app.dispose();
});

test("on a phone two footer actions share the row equally; one, three and the desktops keep their widths", async () => {
  const phone = await openFixture({ safeArea: BUTTONS });
  await phone.show("two");
  const b0 = phone.width("two.b0");
  const b1 = phone.width("two.b1");
  expect(b0).toBe(b1);
  // The row's whole width (the paper's, inside its hairlines) between its 16pt sides, less the 8pt gap.
  expect(b0 + b1 + 8 + 32).toBe(phone.frame("two.footer").w);
  await phone.app.press("id:two-action-0");
  await phone.closed("two");

  // Three: each as wide as its label.
  await phone.show("three");
  expect(phone.width("three.b2")).toBeGreaterThan(phone.width("three.b1"));
  expect(phone.width("three.b0")).toBeGreaterThan(phone.width("three.b1"));
  await phone.app.press("id:three-action-0");
  await phone.closed("three");

  // One: as wide as its label, at the row's end.
  await phone.show("one");
  expect(phone.width("one.b0")).toBeLessThan(120);
  await phone.app.press("id:one-action-0");
  await phone.closed("one");

  // The actions that show count: a third that comes and goes changes the row, open.
  await phone.show("toggle");
  expect(phone.width("toggle.b0")).not.toBe(phone.width("toggle.b1"));
  await phone.app.press("id:toggle-third");
  await phone.app.waitUntil(() => phone.width("toggle.b0") === phone.width("toggle.b1"));
  expect(phone.width("toggle.b0")).toBeGreaterThan(150);
  await phone.app.press("id:toggle-third");
  await phone.app.waitUntil(() => phone.width("toggle.b0") !== phone.width("toggle.b1"));
  expect(phone.width("toggle.b0")).toBeLessThan(120);
  phone.app.dispose();

  // A desktop dialog's actions keep their own widths, even two.
  const desktop = await openFixture({ platform: "linux", width: 1280 });
  await desktop.show("two");
  expect(desktop.width("two.b0")).toBeLessThan(100);
  expect(desktop.width("two.b1")).toBeGreaterThan(desktop.width("two.b0") * 2);
  expect(desktop.frame("two.panel").w).toBe(560);
  await desktop.app.press("id:two-action-0");
  await desktop.closed("two");
  desktop.app.dispose();
});

/** The samples from the first one in which the panel can be seen. */
const drawn = (samples: Sample[]) => samples.slice(Math.max(0, samples.findIndex((s) => s.o > 0)));

function expectSlideIn(samples: Sample[], panel: Frame) {
  const shown = drawn(samples);
  const out = away(panel);
  // Until its first layout it waits further up, out of sight; then it starts just out of sight
  // above the window's top edge (its own frame up): the first frame in sight is near that (samples
  // come every 16ms or so), not part way down. It is never below its place.
  const inSight = shown.filter((s) => s.y > out);
  expect(inSight[0].y).toBeLessThan(out * 0.8);
  expect(shown.some((s) => s.y < 0 && s.y > out)).toBe(true);
  for (let i = 1; i < shown.length; i++) expect(shown[i].y).toBeGreaterThanOrEqual(shown[i - 1].y);
  for (const s of shown) expect(s.y).toBeLessThanOrEqual(0);
  expect(shown[shown.length - 1].y).toBe(0);
  // Sliding, not fading or growing.
  for (const s of shown) {
    expect(s.o).toBe(1);
    expect(s.s).toBe(1);
  }
}

function expectSlideOut(samples: Sample[], panel: Frame, body = true) {
  const out = away(panel);
  for (let i = 1; i < samples.length; i++) expect(samples[i].y).toBeLessThanOrEqual(samples[i - 1].y);
  // On the way up its contents stay mounted, and they go once it is out of sight.
  const moving = samples.filter((s) => s.y < 0 && s.y > out);
  expect(moving.length).toBeGreaterThan(2);
  for (const s of moving) {
    if (body) expect(s.alive).toBe(true);
    expect(s.o).toBe(1);
  }
  expect(samples[samples.length - 1].y).toBe(out);
  expect(samples[samples.length - 1].alive).toBe(false);
}

// The slide is the same code on both phones; the insets above are what differ between them.
for (const [name, platform, safeArea] of [["an Android phone", "android", BUTTONS]] as const) {
  test(`on ${name} a dialog slides in from above the top edge and back out there, the same each time it opens`, async () => {
    const { app, frame, show, closed, dismiss } = await openFixture({ platform, safeArea });
    for (const kind of ["two", "message2", "setting", "bare"]) {
      const first = await show(kind);
      const panel = frame(`${kind}.panel`);
      expectSlideIn(first, panel);
      await dismiss();
      expectSlideOut(await closed(kind), panel, kind !== "bare");
      expect(app.count(`id:body-${kind}`)).toBe(0);
      // Again: the same entrance, the same frame.
      expectSlideIn(await show(kind, 2), panel);
      expect(frame(`${kind}.panel`)).toEqual(panel);
      await dismiss();
      expectSlideOut(await closed(kind, 2), panel, kind !== "bare");
    }
    app.dispose();
  });
}

test("a dialog opened again while it goes out turns back from where it is, its contents never unmounted", async () => {
  const { app, frame, show, closed, samples, report } = await openFixture({ safeArea: BUTTONS });
  await show("two");
  const out = away(frame("two.panel"));
  await app.press("id:bounce-two");
  await closed("two");
  await app.waitUntil(() => report()["two.in2"] !== undefined);
  const back = samples("two.in2");
  // Part way up when it turned (the highest point; values read a frame late): it never went out
  // of sight, nor jumped back to the top, and from there it only comes down.
  const highest = back.reduce((at, s, i) => (s.y < back[at].y ? i : at), 0);
  expect(back[highest].y).toBeLessThan(0);
  expect(back[highest].y).toBeGreaterThan(out * 0.95);
  for (let i = highest + 1; i < back.length; i++) expect(back[i].y).toBeGreaterThanOrEqual(back[i - 1].y);
  expect(back[back.length - 1].y).toBe(0);
  for (const s of [...samples("two.out1").filter((s) => s.t < 90), ...back]) expect(s.alive).toBe(true);
  expect(app.count("id:body-two")).toBe(1);
  app.dispose();
});

test("a dialog that lost its body and footer still opens, slides and closes (close button and back)", async () => {
  const { app, frame, show, closed } = await openFixture({ safeArea: GESTURE });
  expectSlideIn(await show("bare"), frame("bare.panel"));
  await app.press("id:dialog-bare-close");
  expectSlideOut(await closed("bare"), frame("bare.panel"), false);
  await show("bare", 2);
  await app.back();
  await closed("bare", 2);
  expect(app.count("id:dialog-bare-close")).toBe(0);
  app.dispose();
});

test("with reduced motion a dialog is in place at once and goes at once", async () => {
  const { app, show, closed } = await openFixture({ safeArea: BUTTONS, reducedMotion: true });
  for (const kind of ["two", "setting"]) {
    const entrance = drawn(await show(kind));
    for (const s of entrance) expect(s.y).toBe(0);
    await app.back();
    expect(app.count(`id:body-${kind}`)).toBe(0);
    const exit = await closed(kind);
    expect(exit.some((s) => s.alive)).toBe(false);
  }
  app.dispose();
});

test("a desktop dialog keeps its settle in place: no slide", async () => {
  const { app, show, closed } = await openFixture({ platform: "linux", width: 1280 });
  const entrance = await show("two");
  for (const s of entrance) expect(s.y).toBe(0);
  const growing = drawn(entrance);
  expect(growing[0].s).toBeLessThan(1);
  expect(growing[growing.length - 1]).toMatchObject({ s: 1, o: 1 });
  await app.press("id:dialog-two-close");
  const exit = await closed("two");
  for (const s of exit) expect(s.y).toBe(0);
  expect(exit[exit.length - 1].o).toBe(0);
  expect(exit.some((s) => s.alive && s.o > 0 && s.o < 1)).toBe(true);
  app.dispose();
});

/** How long a motion ran, in the samples' milliseconds: from the first sample past its start to
 *  the first at its end, and the sample nearest the middle of that time. */
function run(samples: Sample[], started: (s: Sample) => boolean, ended: (s: Sample) => boolean) {
  const first = samples.findIndex(started);
  const last = samples.findIndex((s, i) => i >= first && ended(s));
  expect(first).toBeGreaterThanOrEqual(0);
  expect(last).toBeGreaterThan(first);
  const middle = (samples[first].t + samples[last].t) / 2;
  const nearest = samples.reduce((best, s) => (Math.abs(s.t - middle) < Math.abs(best.t - middle) ? s : best));
  return { ms: samples[last].t - samples[first].t, middle: nearest };
}

test("a dialog goes out quicker than it came in (280ms, 200ms), leaving fast as the phone's other popups do", async () => {
  const { app, frame, show, closed, dismiss } = await openFixture({ safeArea: BUTTONS });
  const entrance = drawn(await show("two"));
  const out = away(frame("two.panel"));
  await dismiss();
  const exit = await closed("two");
  const coming = run(entrance, (s) => s.y > out, (s) => s.y === 0);
  const going = run(exit, (s) => s.y < 0, (s) => s.y === out);
  // 80ms quicker, give or take a sampled frame either side.
  expect(going.ms).toBeLessThan(coming.ms - 32);
  // MOTION_EXIT_EASE starts slow: half way through its time it has gone less than half the way.
  expect(going.middle.y).toBeGreaterThan(out * 0.5);
  app.dispose();
});

test("a desktop dialog goes out quicker than it settled in (180ms, 140ms), leaving fast", async () => {
  const { app, show, closed } = await openFixture({ platform: "linux", width: 1280 });
  const entrance = await show("two");
  await app.press("id:dialog-two-close");
  const exit = await closed("two");
  const coming = run(entrance, (s) => s.o > 0, (s) => s.o === 1);
  const going = run(exit, (s) => s.o < 1, (s) => s.o === 0);
  expect(going.ms).toBeLessThan(coming.ms);
  // Still mostly there half way through: it fades on MOTION_EXIT_EASE, not the settling curve.
  expect(going.middle.o).toBeGreaterThan(0.5);
  app.dispose();
});
