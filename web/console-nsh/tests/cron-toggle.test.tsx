// The topic head's TODO runs toggle while TODO runs are running (pages/chat/TopicSidebar.tsx): the
// hands of its alarm clock turn, each its own way (components/motion/AdjustingClock.tsx), in place
// of a button's loading look, in all four running and selected states, without moving or resizing
// the 38pt square; the toggle stays a working toggle (one press, one switch) while it runs, and its
// hands are back at three o'clock once the runs end. With reduced motion they stand still at ten
// past ten instead.
import { expect, open, test } from "nsh/test";

async function openToggle(options: { platform?: "linux" | "android"; reducedMotion?: boolean; clock?: boolean } = {}) {
  return open("./fixtures/cron-toggle-app.tsx", {
    width: 390,
    height: 500,
    platform: options.platform ?? "linux",
    locale: "en-US",
    reducedMotion: options.reducedMotion,
    clock: options.clock ? {} : undefined,
  });
}

const read = (app: { texts(): string[] }, name: string) => app.texts().find((text) => text.startsWith(`${name}=`));

type Hands = { minute: number; hour: number; phase: string };

async function hands(app: Awaited<ReturnType<typeof openToggle>>): Promise<Hands> {
  await app.press("id:read-hands");
  const [minute, hour, phase] = (read(app, "hands") ?? "").replace(/^hands=/, "").split(",");
  return { minute: Number(minute), hour: Number(hour), phase };
}

const TAU = Math.PI * 2;
/** How far a hand went clockwise from `from` to `to` (within one lap). */
const turned = (from: number, to: number) => (((to - from) % TAU) + TAU) % TAU;
const near = (value: number, target: number, within = 0.01) => Math.abs(value - target) <= within;
/** Three o'clock (the icon's own hands) and ten past ten. */
const REST = { minute: 0, hour: TAU / 4 };
const STILL = { minute: TAU / 6, hour: (TAU * 10) / 12 + TAU / 144 };

function expectAt(at: Hands, pose: { minute: number; hour: number }, phase: string) {
  expect(at.phase).toBe(phase);
  expect(near(turned(pose.minute, at.minute), 0) || near(turned(pose.minute, at.minute), TAU)).toBe(true);
  expect(near(at.hour, pose.hour)).toBe(true);
}

for (const platform of ["linux", "android"] as const) {
  test(`${platform}: the hands turn only while running, and the toggle keeps its 38pt square and place`, async () => {
    const app = await openToggle({ platform });
    expect(app.count("id:chat-cron-running")).toBe(0);
    const idle = read(app, "frame");
    const center = read(app, "center");
    expect(idle).toMatch(/,38x38$/);

    // running; running + selected; selected; idle again.
    for (const flip of ["flip-running", "flip-active", "flip-running", "flip-active"]) {
      await app.press(`id:${flip}`);
      expect(read(app, "frame")).toBe(idle);
      expect(read(app, "center")).toBe(center);
      expect(app.enabled("id:toggle")).toBe(true);
    }
    // Back to idle and unselected after the four flips: nothing left turning.
    expect(app.count("id:chat-cron-running")).toBe(0);
  });
}

test("each running and selected combination: the turning follows running alone", async () => {
  const app = await openToggle();
  // idle, unselected
  expect(app.count("id:chat-cron-running")).toBe(0);
  // running, unselected
  await app.press("id:flip-running");
  expect(app.shows("id:chat-cron-running")).toBe(true);
  expect(app.shows("label:TODO runs — 2 running")).toBe(true);
  // running, selected
  await app.press("id:flip-active");
  expect(app.shows("id:chat-cron-running")).toBe(true);
  // idle, selected
  await app.press("id:flip-running");
  expect(app.count("id:chat-cron-running")).toBe(0);
  expect(app.shows("label:TODO runs")).toBe(true);
});

test("while running, the toggle is not busy: every press switches once and none is blocked", async () => {
  const app = await openToggle();
  await app.press("id:flip-running");
  expect(app.enabled("id:toggle")).toBe(true);
  await app.press("id:toggle");
  expect(read(app, "presses")).toBe("presses=1");
  await app.press("id:toggle");
  expect(read(app, "presses")).toBe("presses=2");
  expect(app.shows("id:chat-cron-running")).toBe(true);
  // The runs end: the hands stop and the toggle is as it was.
  await app.press("id:flip-running");
  expect(app.count("id:chat-cron-running")).toBe(0);
  await app.press("id:toggle");
  expect(read(app, "presses")).toBe("presses=3");
});

test("idle, the clock is the alarm icon at three o'clock, and the hands stay put", async () => {
  const app = await openToggle({ clock: true });
  expect(app.count("id:chat-cron-clock")).toBe(1);
  expectAt(await hands(app), REST, "rest");
  await app.clock!.runFor(2000);
  expectAt(await hands(app), REST, "rest");
  // Selected (the list is open) is a colour, not a motion.
  await app.press("id:flip-active");
  await app.clock!.runFor(1000);
  expectAt(await hands(app), REST, "rest");
});

test("running, the two hands turn apart: the minute hand a lap per 1.2 s, the hour hand a twelfth of that", async () => {
  const app = await openToggle({ clock: true });
  await app.press("id:flip-running");
  const start = await hands(app);
  expect(start.phase).toBe("turning");
  // A lap in four quarters: the hour hand creeps on evenly, a 48th of a lap each; the minute hand
  // goes a whole lap meanwhile, in strokes (fast mid-lap, slow near the top), so far more than the
  // hour hand, and unevenly.
  const minuteSteps: number[] = [];
  const hourSteps: number[] = [];
  let last = start;
  for (let quarter = 0; quarter < 4; quarter++) {
    await app.clock!.runFor(300);
    const now = await hands(app);
    expect(now.phase).toBe("turning");
    minuteSteps.push(turned(last.minute, now.minute));
    hourSteps.push(turned(last.hour, now.hour));
    last = now;
  }
  for (const step of hourSteps) expect(near(step, TAU / 48, 0.01)).toBe(true);
  for (let quarter = 0; quarter < 4; quarter++) expect(minuteSteps[quarter]).toBeGreaterThan(hourSteps[quarter]);
  expect(Math.max(...minuteSteps)).toBeGreaterThan(Math.min(...minuteSteps) * 2);
  const lap = last;
  const minuteBack = turned(start.minute, lap.minute);
  expect(near(minuteBack, 0, 0.05) || near(minuteBack, TAU, 0.05)).toBe(true);
  expect(near(turned(start.hour, lap.hour), TAU / 12, 0.02)).toBe(true);
  // Both are still going after many laps (they loop natively until the run ends).
  await app.clock!.runFor(4500);
  const later = await hands(app);
  expect(later.phase).toBe("turning");
  expect(near(turned(lap.hour, later.hour), (TAU / 12) * (4500 / 1200), 0.03)).toBe(true);
  expect(turned(lap.minute, later.minute)).toBeGreaterThan(0.1);
});

test("the runs end, the hands settle back to three o'clock; a new run turns them again", async () => {
  for (const selected of [false, true]) {
    const app = await openToggle({ clock: true });
    if (selected) await app.press("id:flip-active");
    await app.press("id:flip-running");
    await app.clock!.runFor(1700);
    expect((await hands(app)).phase).toBe("turning");
    await app.press("id:flip-running");
    await app.clock!.runFor(400);
    expectAt(await hands(app), REST, "rest");
    expect(app.count("id:chat-cron-running")).toBe(0);
    await app.clock!.runFor(2000);
    expectAt(await hands(app), REST, "rest");
    // Another run: turning from three o'clock again.
    await app.press("id:flip-running");
    await app.clock!.runFor(300);
    const again = await hands(app);
    expect(again.phase).toBe("turning");
    expect(turned(REST.minute, again.minute)).toBeGreaterThan(0.1);
    await app.press("id:flip-running");
    await app.clock!.runFor(400);
    expectAt(await hands(app), REST, "rest");
  }
});

test("unmounted while turning, the clock leaves nothing running, and comes back at rest", async () => {
  const app = await openToggle({ clock: true });
  await app.press("id:flip-running");
  await app.clock!.runFor(500);
  await app.press("id:flip-mounted");
  expect(app.count("id:chat-cron-clock")).toBe(0);
  await app.clock!.runFor(2000);
  await app.press("id:flip-running");
  await app.press("id:flip-mounted");
  expect(app.count("id:chat-cron-clock")).toBe(1);
  expectAt(await hands(app), REST, "rest");
  // Mounted while running: it turns from the first frame.
  await app.press("id:flip-mounted");
  await app.press("id:flip-running");
  await app.press("id:flip-mounted");
  expect((await hands(app)).phase).toBe("turning");
  expect(app.shows("id:chat-cron-running")).toBe(true);
});

for (const platform of ["linux", "android"] as const) {
  test(`${platform}: with reduced motion the hands stand at ten past ten while running, and nothing turns`, async () => {
    const app = await openToggle({ platform, reducedMotion: true, clock: true });
    expectAt(await hands(app), REST, "rest");
    const idle = read(app, "frame");
    await app.press("id:flip-running");
    expect(app.shows("id:chat-cron-running")).toBe(true);
    expectAt(await hands(app), STILL, "still");
    await app.clock!.runFor(3000);
    expectAt(await hands(app), STILL, "still");
    expect(read(app, "frame")).toBe(idle);
    await app.press("id:toggle");
    expect(read(app, "presses")).toBe("presses=1");
    // The runs end: three o'clock at once.
    await app.press("id:flip-running");
    expect(app.count("id:chat-cron-running")).toBe(0);
    expectAt(await hands(app), REST, "rest");
  });
}
