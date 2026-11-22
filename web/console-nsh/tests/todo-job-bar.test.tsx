// A TODO topic's toolbar as drawn (components/chat/TodoJobBar.tsx): two icon buttons in the bottom
// navigation's slots, no text on them, each named (accessible name and tooltip) for what it does.
// Start is the primary button (a white Play on the solid primary fill); Stop is as solid, but red: a
// red Stop square on an opaque pale-red fill, legible in either theme (red on the primary blue would
// not be); View Job is the navigation's quiet glyph. The capsule's padding is the same above, below,
// beside and between the buttons. Headless nsh has no image or style query, so each glyph's test id
// names what it draws: `<button>-icon.<glyph>.<look>.<tint token>`. The fixture
// (tests/fixtures/todo-job-bar-app.tsx) mounts the real bar in each of the chat's states;
// tests/chat-todo-job.test.tsx drives the same bar through the real page and the runtime's answers.
import { expect, open, test } from "nsh/test";
import {
  TODO_JOB_COMPACT_HEIGHT,
  TODO_JOB_COMPACT_INSET,
  TODO_JOB_COMPACT_SIZE,
  TODO_JOB_NAV_SIZE,
  TODO_JOB_BUTTON_GAP,
  TODO_JOB_BUTTON_HEIGHT,
  TODO_JOB_BUTTON_WIDTH,
  TODO_JOB_FOCUS_RING,
  TODO_JOB_ICON_SIZE,
  TODO_JOB_STOP_TINT,
  todoJobButtonLook,
} from "../components/chat/TodoJobBar";
import { BAR_INSET, MOBILE_NAV_HEIGHT, mobileNavSlots, NAV_SLOT_MAX } from "../components/frame/mobileBar";

type Frame = { x: number; y: number; w: number; h: number };
type Report = {
  state: string;
  presses: { start: number; stop: number; view: number };
  frames: Record<string, Frame>;
  colours: Record<string, string>;
  icons: { start: string; stop: string; view: string };
};

const TOGGLE = "chat-todo-job-toggle-icon";
const VIEW = "chat-todo-job-view-icon";
const GLYPHS = {
  start: `id:${TOGGLE}.PhPlay.primary.primary-foreground`,
  starting: `id:${TOGGLE}.PhPlay.busy.ink`,
  startOff: `id:${TOGGLE}.PhPlay.disabled.on-disabled`,
  stop: `id:${TOGGLE}.PhStop.stop.danger`,
  stopping: `id:${TOGGLE}.PhStop.busy.danger`,
  view: `id:${VIEW}.PhListChecks.quiet.muted-foreground`,
  viewOff: `id:${VIEW}.PhListChecks.disabled.plain-disabled-text`,
};
const TOGGLE_GLYPHS = [GLYPHS.start, GLYPHS.starting, GLYPHS.startOff, GLYPHS.stop, GLYPHS.stopping];

type Rgba = [number, number, number, number];

function rgba(hex: string): Rgba {
  const digits = hex.replace("#", "");
  const full = digits.length === 6 ? `${digits}ff` : digits;
  return [0, 2, 4, 6].map((at) => parseInt(full.slice(at, at + 2), 16) / 255) as Rgba;
}

/** `top` at `alpha` laid over the opaque `under`. */
function over(top: Rgba, under: Rgba, alpha = top[3]): Rgba {
  return [0, 1, 2].map((i) => top[i] * alpha + under[i] * (1 - alpha)).concat(1) as Rgba;
}

function luminance(color: Rgba) {
  const channel = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channel(color[0]) + 0.7152 * channel(color[1]) + 0.0722 * channel(color[2]);
}

function contrast(a: Rgba, b: Rgba) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** The capsule's hairline (GlassCapsule's `border-[0.5px]`). */
const HAIRLINE = 0.5;
const near = (actual: number, expected: number, slack = 0.5) => expect(Math.abs(actual - expected)).toBeLessThanOrEqual(slack);
const classes = (value: string | undefined) => (value ?? "").split(/\s+/).filter(Boolean);

test("Start is the primary button, Stop a solid red one, View Job the navigation's quiet glyph", () => {
  const start = todoJobButtonLook("start");
  expect(start).toMatchObject({ look: "primary", glyph: "PhPlay", filled: true, icon: "primary-foreground" });
  for (const c of ["bg-primary", "border-[0.5px]", "border-primary-line"]) expect(classes(start.box)).toContain(c);
  for (const c of classes(start.box)) expect(/danger|destructive|transparent/.test(c)).toBe(false);

  const stop = todoJobButtonLook("stop");
  expect(stop).toMatchObject({ look: "stop", glyph: "PhStop", filled: true, icon: "danger" });
  // Opaque: the card under a red tint, with a red hairline; never the primary blue.
  expect(classes(stop.box)).toContain("bg-card");
  expect(classes(stop.box)).toContain("border-danger/35");
  expect(classes(stop.tint)).toContain(`bg-danger/${Math.round(TODO_JOB_STOP_TINT * 100)}`);
  for (const c of [...classes(stop.box), ...classes(stop.tint)]) expect(/primary|ink|transparent/.test(c)).toBe(false);

  const view = todoJobButtonLook("view");
  expect(view).toMatchObject({ look: "quiet", glyph: "PhListChecks", filled: false, icon: "muted-foreground" });
  expect(view.tint).toBeUndefined();
  for (const c of classes(view.box)) expect(/^bg-(?!transparent)/.test(c)).toBe(false);
  // Three colours apart.
  expect(new Set([start.icon, stop.icon, view.icon]).size).toBe(3);
  // A keyboard focus shows on each: a ring inside the pill (seen in Chrome on Tab), and a fill.
  expect(TODO_JOB_FOCUS_RING).toMatch(/^group-focus-visible:border-/);
  expect(classes(start.box)).toContain("focus:bg-primary-hover");
  expect(classes(stop.tint)).toContain("group-focus:bg-danger/18");
  expect(classes(view.box)).toContain("focus:bg-hover");
});

test("busy and disabled looks: the beam's soft fill while starting, Stop kept red while stopping, pale when they cannot act", () => {
  expect(todoJobButtonLook("start", { busy: true })).toMatchObject({ look: "busy", glyph: "PhPlay", icon: "ink", beam: "primary" });
  expect(todoJobButtonLook("start", { disabled: true })).toMatchObject({ look: "disabled", icon: "on-disabled" });
  expect(classes(todoJobButtonLook("start", { disabled: true }).box)).toContain("bg-primary-disabled");
  // Busy wins over disabled (a run on its way is disabled too).
  expect(todoJobButtonLook("start", { busy: true, disabled: true }).look).toBe("busy");
  const stopping = todoJobButtonLook("stop", { busy: true, disabled: true });
  expect(stopping).toMatchObject({ look: "busy", glyph: "PhStop", icon: "danger", beam: "danger" });
  expect(classes(stopping.box)).toContain("bg-card");
  expect(classes(stopping.tint)).toContain("bg-danger/12");
  // No hover or focus deepening while it cannot act.
  expect(classes(stopping.tint).some((c) => c.includes(":"))).toBe(false);
  expect(todoJobButtonLook("stop", { disabled: true })).toMatchObject({ look: "disabled", icon: "danger-disabled-text" });
  expect(todoJobButtonLook("view", { disabled: true })).toMatchObject({ look: "disabled", icon: "plain-disabled-text" });
});

test("the buttons are the navigation's slots: as tall and wide, with its 24pt glyphs", () => {
  expect(TODO_JOB_BUTTON_HEIGHT).toBe(MOBILE_NAV_HEIGHT - BAR_INSET * 2);
  expect(TODO_JOB_BUTTON_WIDTH).toBe(NAV_SLOT_MAX);
  // The navigation's slot on a phone has the same width (five slots on a 390pt phone).
  expect(mobileNavSlots(390, 5).slot).toBe(TODO_JOB_BUTTON_WIDTH);
  expect(TODO_JOB_ICON_SIZE).toBe(24);
  expect(TODO_JOB_BUTTON_GAP).toBe(BAR_INSET);
});

async function openBar(options: { width: number; height?: number; platform?: "linux" | "android"; colorScheme?: "light" | "dark" }) {
  const app = await open("./fixtures/todo-job-bar-app.tsx", { height: 600, locale: "en-US", ...options });
  const report = () => JSON.parse(app.texts().find((text) => text.startsWith("{")) ?? "{}") as Report;
  await app.waitUntil(() => ["capsule", "row", "toggle", "view", "toggle-icon", "view-icon"].every((name) => report().frames?.[name]));
  return { app, report };
}

/** The one glyph the toggle draws now, and no other. */
function expectToggle(app: { count(selector: string): number }, glyph: string) {
  for (const other of TOGGLE_GLYPHS) expect(app.count(other)).toBe(other === glyph ? 1 : 0);
}

/** No text on the bar's buttons: their names are read out and shown on hover only. */
function expectNoLabels(app: { count(selector: string): number }) {
  expect(app.count("id:chat-todo-job-bar >> text:/Start|Stop|View Job/")).toBe(0);
}

for (const platform of ["linux", "android"] as const) {
  for (const colorScheme of ["light", "dark"] as const) {
    test(`${platform}, ${colorScheme}: Start's white Play on the primary fill and Stop's red square on its pale-red fill read clearly`, async () => {
      const { app, report } = await openBar({ width: 390, platform, colorScheme });
      const colour = (name: string) => rgba(report().colours[name]);
      expectToggle(app, GLYPHS.start);
      expect(app.count(GLYPHS.view)).toBe(1);
      expectNoLabels(app);
      const icons = report().icons;
      // Start: white on the primary fill, well past the 4.5:1 of text.
      expect(contrast(colour(icons.start), colour("primary"))).toBeGreaterThan(4.5);
      // Stop: red on its fill (the danger tint over the opaque card), past 4.5:1 too.
      const stopFill = over(colour("danger"), colour("card"), TODO_JOB_STOP_TINT);
      expect(contrast(colour(icons.stop), stopFill)).toBeGreaterThan(4.5);
      // The fill is not the card: it shows as a filled button.
      expect(contrast(stopFill, colour("card"))).toBeGreaterThan(1.1);
      // The same red on the primary blue would not read: why Stop has a fill of its own.
      expect(contrast(colour("danger"), colour("primary"))).toBeLessThan(3);
      // Stop's glyph is another colour than Start's and View Job's.
      expect(report().colours[icons.stop]).not.toBe(report().colours[icons.start]);
      expect(report().colours[icons.stop]).not.toBe(report().colours[icons.view]);

      await app.press("id:set-running");
      expectToggle(app, GLYPHS.stop);
      expectNoLabels(app);
    });
  }
}

for (const width of [1400, 390, 320]) {
  test(`${width}pt: the capsule's padding is the same above, below, beside and between the buttons`, async () => {
    const { app, report } = await openBar({ width, platform: width < 768 ? "android" : "linux" });
    // A phone's capsule is the navigation's; a desktop's is the compact one of the job's page (38pt).
    const phone = width < 768;
    const size = phone ? TODO_JOB_NAV_SIZE : TODO_JOB_COMPACT_SIZE;
    const inset = phone ? BAR_INSET : TODO_JOB_COMPACT_INSET;
    for (const state of ["idle", "running", "stopping", "gone"]) {
      await app.press(`id:set-${state}`);
      await app.waitUntil(() => report().state === state);
      const { capsule, row, toggle, view } = report().frames;
      for (const button of [toggle, view]) {
        near(button.h, size.height);
        near(button.w, size.width);
        near(button.y, view.y);
      }
      const top = row.y + toggle.y;
      const bottom = capsule.h - (row.y + toggle.y + toggle.h);
      const left = row.x + toggle.x;
      const right = capsule.w - (row.x + view.x + view.w);
      const gap = view.x - (toggle.x + toggle.w);
      // The capsule's padding inside its 0.5pt hairline all round, and the same between the
      // buttons (headless layout snaps the 4.5pt to whole points: 4 on one side, 5 on the other).
      for (const side of [top, bottom, left, right]) near(side, inset + HAIRLINE);
      near(top + bottom, left + right);
      near(gap, inset);
      // A phone's is as tall as the navigation's capsule: its slots, padding and hairline.
      near(capsule.h, phone ? MOBILE_NAV_HEIGHT + 2 * HAIRLINE : TODO_JOB_COMPACT_HEIGHT);
      // Each glyph centred in its button (24pt on a phone, 16pt on a desktop).
      for (const [icon, button] of [
        [report().frames["toggle-icon"], toggle],
        [report().frames["view-icon"], view],
      ]) {
        near(icon.w, size.icon);
        near(icon.h, size.icon);
        near(icon.x, (button.w - icon.w) / 2);
        near(icon.y, (button.h - icon.h) / 2);
      }
      // Inside the window, even on a narrow phone.
      expect(capsule.x).toBeGreaterThanOrEqual(0);
      expect(capsule.x + capsule.w).toBeLessThanOrEqual(width);
    }
  });
}

test("idle, running, starting, stopping, loading, failed and gone: the right glyph, name, busy beam and press", async () => {
  const { app, report } = await openBar({ width: 390, platform: "android" });
  const bar = "id:chat-todo-job-bar";
  // Idle: Start acts once per press; View Job opens the item.
  expect(app.count(`${bar} >> role:button`)).toBe(2);
  expect(app.count("label:Start")).toBe(1);
  expect(app.count("label:View Job")).toBe(1);
  expect(app.enabled("id:chat-todo-job-toggle")).toBe(true);
  expect(app.count("id:chat-todo-job-toggle-loading")).toBe(0);
  expect(app.count("id:chat-todo-job-toggle-focus-ring")).toBe(1);
  expect(app.count("id:chat-todo-job-view-focus-ring")).toBe(1);
  await app.press("id:chat-todo-job-toggle");
  await app.press("id:chat-todo-job-view");
  expect(report().presses).toEqual({ start: 1, stop: 0, view: 1 });

  // Running: Stop, red, and it stops (not Start).
  await app.press("id:set-running");
  expectToggle(app, GLYPHS.stop);
  expect(app.count("label:Stop")).toBe(1);
  expect(app.count("label:Start")).toBe(0);
  await app.press("id:chat-todo-job-toggle");
  expect(report().presses).toEqual({ start: 1, stop: 1, view: 1 });

  // Starting: the busy primary button, the beam running, no press taken.
  await app.press("id:set-starting");
  expectToggle(app, GLYPHS.starting);
  expect(app.count("label:Start")).toBe(1);
  expect(app.enabled("id:chat-todo-job-toggle")).toBe(false);
  expect(app.count("id:chat-todo-job-toggle-loading")).toBe(1);
  expect(app.enabled("id:chat-todo-job-view")).toBe(true);

  // Stopping: still Stop and still red, busy, no press taken.
  await app.press("id:set-stopping");
  expectToggle(app, GLYPHS.stopping);
  expect(app.count("label:Stop")).toBe(1);
  expect(app.enabled("id:chat-todo-job-toggle")).toBe(false);
  expect(app.count("id:chat-todo-job-toggle-loading")).toBe(1);

  // Loading the item: Start shown, disabled, no beam.
  await app.press("id:set-loading");
  expectToggle(app, GLYPHS.startOff);
  expect(app.enabled("id:chat-todo-job-toggle")).toBe(false);
  expect(app.count("id:chat-todo-job-toggle-loading")).toBe(0);
  expect(app.count(GLYPHS.view)).toBe(1);

  // Failed: said above the capsule, never in it; Start disabled, the item's page still open.
  await app.press("id:set-failed");
  await app.waitFor("id:chat-todo-job-error");
  expect(app.count(`${bar} >> text:/Could not load/`)).toBe(0);
  expectToggle(app, GLYPHS.startOff);
  expect(app.enabled("id:chat-todo-job-view")).toBe(true);

  // Gone: both buttons stay, disabled, pale.
  await app.press("id:set-gone");
  await app.waitFor("id:chat-todo-job-note");
  expectToggle(app, GLYPHS.startOff);
  expect(app.count(GLYPHS.viewOff)).toBe(1);
  expect(app.enabled("id:chat-todo-job-toggle")).toBe(false);
  expect(app.enabled("id:chat-todo-job-view")).toBe(false);
  expect(app.count(`${bar} >> role:button`)).toBe(2);
  expectNoLabels(app);
  // None of the disabled or busy states took a press.
  expect(report().presses).toEqual({ start: 1, stop: 1, view: 1 });
});

test("each button's name shows as its tooltip under the pointer", async () => {
  const { app } = await openBar({ width: 1400, platform: "linux" });
  expect(app.texts().includes("Start")).toBe(false);
  await app.hover("id:chat-todo-job-toggle");
  await app.waitUntil(() => app.texts().includes("Start"));
  await app.hover("id:chat-todo-job-view");
  await app.waitUntil(() => app.texts().includes("View Job"));
  await app.press("id:set-running");
  await app.hover("id:chat-todo-job-toggle");
  await app.waitUntil(() => app.texts().includes("Stop"));
});
