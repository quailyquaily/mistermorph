// The job calendar (TodoCalendar) and the chosen day's list (TodoDayList), on a clock that stands
// still and a runtime made in the fixture (tests/fixtures/todo-calendar-app.tsx: its jobs and what
// ran are listed there). Today is Monday, 23 November 2026, 09:02.
//
// Past days show what ran and future days what is planned. A repeating run that went as usual is
// a mark beside the day number; a cell's text is only what differs. The strip names the repeating
// jobs once and unfolds the cells; the day's list is complete, a chained run under the run that
// started it. On a phone the cells are marks alone and the list follows the grid.
//
// Headless runs draw nothing to look at: these check what is shown, in which order, and where the
// parts lie (frames), not colours, type or the marks' shapes. The grouping and folding rules are
// tested without the framework in components/todo/calendar-runs.test.mjs.
import { expect, open, test } from "nsh/test";

type Frame = { x: number; y: number; w: number; h: number };
type App = Awaited<ReturnType<typeof open>>;

async function openCalendar(width = 1280, height = 900) {
  const app = await open("./fixtures/todo-calendar-app.tsx", { width, height, platform: "linux", locale: "en-US" });
  await app.waitFor("text:history=1");
  await app.waitFor("id:todo-calendar-day-2026-11-17");
  return app;
}

const day = (date: number) => `id:todo-calendar-day-2026-11-${String(date).padStart(2, "0")}`;
const marks = (app: App, date: number, kind: string) => app.count(`${day(date)} >> id:todo-calendar-mark-${kind}`);
const writes = (app: App, date: number, text: string) => app.shows(`${day(date)} >> text:${text}`);
const frames = (app: App) => JSON.parse(app.texts().find((text) => text.startsWith("{")) ?? "{}") as Record<string, Frame>;
/** The day list's texts, in order (from its title to the fixture's controls). */
function listed(app: App, title: string) {
  const texts = app.texts();
  return texts.slice(texts.lastIndexOf(title), texts.indexOf("fx-hold"));
}

test("a past day shows what ran and a future day what is planned; the usual repeats are marks, the text is what differs", async () => {
  const app = await openCalendar();
  // Tuesday the 17th: Backup, the report and its digest went as usual (three filled marks); the
  // report started by hand, and the digest it started, are written.
  expect(marks(app, 17, "on")).toBe(3);
  expect(marks(app, 17, "off")).toBe(0);
  expect(writes(app, 17, "Morning report")).toBe(true);
  expect(writes(app, 17, "Team digest")).toBe(true);
  expect(writes(app, 17, "Backup")).toBe(false);
  // The 19th: the failed report and the digest skipped for it are written; Backup is a mark.
  expect(marks(app, 19, "on")).toBe(1);
  expect(writes(app, 19, "Morning report")).toBe(true);
  expect(writes(app, 19, "Team digest")).toBe(true);
  // The 20th: 48 runs of Sweep are one mark, and no text.
  expect(marks(app, 20, "on")).toBe(1);
  expect(writes(app, 20, "Sweep ×48")).toBe(false);
  // The 22nd: a poke is never folded.
  expect(marks(app, 22, "on") + marks(app, 22, "off")).toBe(0);
  expect(writes(app, 22, "Release notes")).toBe(true);
  // Nothing ran on the 18th, and the past shows no plan.
  expect(marks(app, 18, "on") + marks(app, 18, "off")).toBe(0);
  // Tomorrow: the report, its digest, Sweep and Backup are planned, hollow, with no text.
  expect(marks(app, 24, "off")).toBe(4);
  expect(marks(app, 24, "on")).toBe(0);
  expect(writes(app, 24, "Morning report")).toBe(false);
  // Saturday the 28th: Sweep, and Backup once for each of its two schedules that fire that day.
  expect(marks(app, 28, "off")).toBe(3);
});

test("today shows both, and its running job is written, never folded", async () => {
  const app = await openCalendar();
  expect(app.count("label:/^Today, /")).toBe(1);
  expect(app.count("label:/^Today, Monday, November 23, entries: 5$/")).toBe(1);
  // Ran: Sweep so far and Backup. Planned: the rest of Sweep, and the digest behind the running report.
  expect(marks(app, 23, "on")).toBe(2);
  expect(marks(app, 23, "off")).toBe(2);
  expect(writes(app, 23, "Morning report")).toBe(true);
  // Today is the chosen day at first, and its list has the line between what started and what is planned.
  await app.waitFor("text:sel=2026-11-23");
  expect(listed(app, "Today")).toEqual([
    "Today",
    "12:00 AM",
    "Sweep ×19",
    "Every 30 minutes · until 09:00 AM",
    "06:00 AM",
    "Backup",
    "By schedule",
    "09:00 AM",
    "Morning report",
    "By schedule",
    "Team digest",
    "As soon as Morning report finishes",
    "NOW 09:02 AM",
    "09:30 AM",
    "Sweep ×29",
    "Every 30 minutes · until 11:30 PM",
  ]);
  expect(app.count("id:todo-day-now")).toBe(1);
  // The running report is named as running for a screen reader; on screen its ring says it.
  expect(app.count("label:09:00 AM, Morning report, By schedule, Running")).toBe(1);
  expect(app.texts().includes("Running")).toBe(false);
});

test("the strip names each repeating job once, from the jobs' schedules, and unfolds the cells and folds them again", async () => {
  const app = await openCalendar();
  expect(app.texts()).toContain("REPEATING");
  const strip = app.texts().slice(app.texts().indexOf("REPEATING") + 1, app.texts().indexOf("Show in days"));
  expect(strip).toEqual([
    "Morning report  Every Monday, Tuesday, Wednesday, Thursday, and Friday at 9 AM",
    // A chained job repeats with the job that starts it.
    "Team digest  after Morning report",
    "Sweep  Every 30 minutes",
    // A job with two repeating schedules is named once, with both. A job only a poke starts is not there.
    "Backup  Every day at 6 AM · Every Saturday at 6 PM",
  ]);
  expect(app.count("id:todo-calendar-repeating-backup")).toBe(1);
  expect(app.shows("id:todo-calendar-repeating-notes")).toBe(false);

  await app.press("id:todo-calendar-fold");
  await app.waitFor("label:Fold");
  // Unfolded: every run is written, and nothing is a mark.
  expect(marks(app, 24, "off") + marks(app, 24, "on")).toBe(0);
  for (const text of ["Morning report", "Team digest", "Sweep ×48", "Backup"]) expect(writes(app, 24, text)).toBe(true);
  expect(writes(app, 20, "Sweep ×48")).toBe(true);
  // Five lines to a cell, the rest behind a count (with one more run, today has six rows).
  expect(writes(app, 23, "+1 more")).toBe(false);
  await app.press("id:fx-live");
  await app.waitFor(`${day(23)} >> text:+1 more`);
  // A full day is as tall as its lines: they do not run out of the cell.
  await app.wait(100);
  const all = frames(app);
  expect(all["lines-2026-11-23"].h).toBe(95);
  expect(all["lines-2026-11-23"].y + 95 <= all["day-2026-11-23"].y + all["day-2026-11-23"].h - 8).toBe(true);
  // The week is as tall as its tallest day.
  expect(all["day-2026-11-24"].h).toBe(all["day-2026-11-23"].h);

  await app.press("id:todo-calendar-fold");
  await app.waitFor("label:Show in days");
  expect(marks(app, 24, "off")).toBe(4);
  expect(writes(app, 24, "Sweep ×48")).toBe(false);
  expect(writes(app, 23, "+1 more")).toBe(false);

  // No repeating job: no strip.
  await app.press("id:fx-none");
  await app.waitFor("id:todo-calendar-repeating", { state: "gone" });
});

test("the chosen day lists every run in full, a chained run under the run that started it, and a run opens its job", async () => {
  const app = await openCalendar();
  await app.press(day(17));
  await app.waitFor("text:sel=2026-11-17");
  await app.waitFor("text:Tue, Nov 17");
  expect(listed(app, "Tue, Nov 17")).toEqual([
    "Tue, Nov 17",
    "06:00 AM",
    "Backup",
    "By schedule",
    "09:00 AM",
    "Morning report",
    "By schedule",
    "09:01 AM",
    "Team digest",
    "After Morning report",
    "02:10 PM",
    "Morning report",
    "Started by hand",
    "02:11 PM",
    "Team digest",
    "After Morning report",
  ]);
  // Each digest is one level in, under its report.
  expect(app.count("id:todo-day-row-d0")).toBe(3);
  expect(app.count("id:todo-day-row-d1")).toBe(2);
  expect(app.count("id:todo-day-row-d1 >> text:Team digest")).toBe(2);
  expect(app.shows("id:todo-day-now")).toBe(false);
  await app.press("id:todo-day-item-digest >> nth=0");
  await app.waitFor("text:open=digest");

  // A frequent job is one entry with its count, its cadence and its range.
  await app.press(day(20));
  await app.waitFor("text:Fri, Nov 20");
  expect(listed(app, "Fri, Nov 20")).toEqual(["Fri, Nov 20", "12:00 AM", "Sweep ×48", "Every 30 minutes · until 11:30 PM"]);

  // A planned day: the digest has no minute of its own, it follows the report.
  await app.press(day(24));
  await app.waitFor("text:Tue, Nov 24");
  expect(listed(app, "Tue, Nov 24")).toEqual([
    "Tue, Nov 24",
    "12:00 AM",
    "Sweep ×48",
    "Every 30 minutes · until 11:30 PM",
    "06:00 AM",
    "Backup",
    "By schedule",
    "09:00 AM",
    "Morning report",
    "By schedule",
    "Team digest",
    "After Morning report",
  ]);
  expect(app.count("label:09:00 AM, Morning report, By schedule, planned")).toBe(1);

  // A day nothing ran on says so.
  await app.press(day(18));
  await app.waitFor("No jobs scheduled for this day.");
});

test("a failure is written where it happened, and the skipped dependent says which input failed", async () => {
  const app = await openCalendar();
  await app.press(day(19));
  await app.waitFor("text:Thu, Nov 19");
  expect(listed(app, "Thu, Nov 19")).toEqual([
    "Thu, Nov 19",
    "06:00 AM",
    "Backup",
    "By schedule",
    "09:00 AM",
    "Morning report",
    "By schedule · failed: the model timed out",
    "09:00 AM",
    "Team digest",
    // The runtime's note names the job by its ID; the list names it.
    "Skipped: input job Morning report failed",
  ]);
  expect(app.count("id:todo-day-row-d1 >> text:Team digest")).toBe(1);
});

test("the history is read again when a live run changes; a failed read says so, keeps what is shown and can be tried again", async () => {
  const app = await openCalendar();
  expect(app.shows("id:todo-calendar-loading")).toBe(false);
  expect(app.shows("id:todo-calendar-error")).toBe(false);
  expect(writes(app, 23, "Release notes")).toBe(false);

  // A run starts (the page's live runs change), and the read it causes fails.
  await app.press("id:fx-fail");
  await app.press("id:fx-live");
  await app.waitFor("text:history=2");
  await app.waitFor("text:Could not read what ran: the runtime is away");
  // What was read before stays.
  expect(writes(app, 17, "Morning report")).toBe(true);
  expect(marks(app, 17, "on")).toBe(3);
  expect(app.shows("id:todo-calendar-loading")).toBe(false);

  await app.press("id:todo-calendar-retry");
  await app.waitFor("text:history=3");
  await app.waitFor("id:todo-calendar-error", { state: "gone" });
  // The new run, waiting, is written in today's cell.
  await app.waitFor(`${day(23)} >> text:Release notes`);
  expect(app.count("label:09:01 AM, Release notes, Started by hand · Waiting")).toBe(1);
});

test("another month asks for its own days and shows as loading until its answer comes; an older answer is not taken for it", async () => {
  const app = await openCalendar();
  expect(app.texts().some((text) => /^range=2026-10-3[01]\.\.2026-12-1[23]$/.test(text))).toBe(true);
  await app.press("id:fx-hold");
  await app.press("id:fx-next");
  await app.waitFor("text:held=1");
  await app.waitFor("December 2026");
  await app.waitFor("text:sel=2026-12-01");
  await app.waitFor("id:todo-calendar-loading");
  // December's six weeks, with a day to spare at each end.
  expect(app.texts().some((text) => /^range=2026-11-2[78]\.\.2027-01-1[01]$/.test(text))).toBe(true);
  // The plan does not wait for the history.
  expect(app.count("id:todo-calendar-day-2026-12-02 >> id:todo-calendar-mark-off")).toBe(4);
  // The chosen day says nothing yet rather than "nothing".
  expect(app.texts().includes("No jobs scheduled for this day.")).toBe(false);

  // A live run changes while the month is being read: a second request, the first now stale.
  await app.press("id:fx-live");
  await app.waitFor("text:held=2");
  await app.press("id:fx-release");
  await app.waitFor("text:held=1");
  await app.wait(100);
  expect(app.shows("id:todo-calendar-loading")).toBe(true);
  await app.press("id:fx-release-last");
  await app.waitFor("id:todo-calendar-loading", { state: "gone" });
  expect(app.texts()).toContain("history=3");
});

test("as the clock moves, a planned run that came due is looked for in the history", async () => {
  const app = await openCalendar();
  expect(app.texts()).toContain("NOW 09:02 AM");
  await app.press("id:fx-later");
  // 09:30 has passed: the history is read again (nothing recorded it here), and the plan starts at 10:00.
  await app.waitFor("text:history=2");
  await app.waitFor("NOW 09:31 AM");
  const today = listed(app, "Today");
  expect(today.slice(today.indexOf("NOW 09:31 AM"))).toEqual(["NOW 09:31 AM", "10:00 AM", "Sweep ×28", "Every 30 minutes · until 11:30 PM"]);
  expect(app.shows("id:todo-calendar-loading")).toBe(false);
});

// Headless frames snap to whole points.
const within = (inner: Frame, outer: Frame) =>
  inner.x >= outer.x - 0.5 && inner.y >= outer.y - 0.5 && inner.x + inner.w <= outer.x + outer.w + 0.5 && inner.y + inner.h <= outer.y + outer.h + 0.5;

test("on a desktop the marks stay on the day number's line, above the cell's text", async () => {
  const app = await openCalendar();
  await app.waitUntil(() => Boolean(frames(app)["lines-2026-11-23"] && frames(app)["marks-2026-11-24"] && frames(app)["view-tab-calendar"]));
  const all = frames(app);
  for (const date of ["2026-11-17", "2026-11-19", "2026-11-23", "2026-11-24"]) {
    const cell = all[`day-${date}`];
    const number = all[`number-${date}`];
    const row = all[`marks-${date}`];
    // One line of marks, 9pt high, right of the number and inside the cell's 8pt inset.
    expect(row.h).toBe(9);
    expect(within(row, cell)).toBe(true);
    expect(row.x >= number.x + number.w).toBe(true);
    expect(row.x + row.w <= cell.x + cell.w - 7.5).toBe(true);
    // On the number's line.
    expect(Math.abs(row.y + row.h / 2 - (number.y + number.h / 2)) <= 1).toBe(true);
    const lines = all[`lines-${date}`];
    if (lines) {
      expect(lines.y >= row.y + row.h).toBe(true);
      expect(within(lines, cell)).toBe(true);
      // The text starts where the number does.
      expect(lines.x).toBe(number.x);
    }
  }
  // The 24th has marks only: no text block at all.
  expect(all["lines-2026-11-24"]).toBe(undefined);
  // Seven equal days across.
  expect(Math.abs(all["day-2026-11-17"].w - all["day-2026-11-19"].w) <= 1).toBe(true);
  // The head: the list's 57pt row, the toggle a 38pt circle in its middle.
  expect(all.head.h).toBe(57);
  expect(all["view-tab-calendar"].w).toBe(38);
  expect(Math.abs(all["view-tab-calendar"].y + 19 - 28.5) <= 0.5).toBe(true);
  expect(app.shows("id:todo-calendar-add")).toBe(true);
});

test("on a phone the cells are marks alone, and the chosen day's list follows the grid", async () => {
  const app = await openCalendar(390, 844);
  expect(app.texts()).toContain("Nov 2026");
  expect(app.shows("id:todo-calendar-repeating")).toBe(false);
  expect(app.shows("id:todo-calendar-add")).toBe(false);
  // One small mark for the repeats that went as usual, a full one per run that differs.
  expect(marks(app, 17, "on-small")).toBe(1);
  expect(marks(app, 17, "on")).toBe(2);
  expect(writes(app, 17, "Morning report")).toBe(false);
  // The 19th: Backup as usual, the failure, the skipped digest.
  expect(marks(app, 19, "on-small")).toBe(1);
  expect(marks(app, 19, "error")).toBe(1);
  expect(marks(app, 19, "off")).toBe(1);
  // Tomorrow: planned only, one small hollow mark.
  expect(marks(app, 24, "off-small")).toBe(1);
  expect(marks(app, 24, "off") + marks(app, 24, "on")).toBe(0);
  // Today: the repeats so far, and the running report.
  expect(marks(app, 23, "on-small")).toBe(1);
  expect(marks(app, 23, "running")).toBe(1);

  // The list under the grid is today's, in full.
  expect(app.shows("id:todo-calendar-agenda >> text:Today")).toBe(true);
  expect(app.shows("id:todo-calendar-agenda >> text:Sweep ×19")).toBe(true);
  expect(app.shows("id:todo-calendar-agenda >> text:As soon as Morning report finishes")).toBe(true);
  expect(app.count("id:todo-calendar-agenda >> id:todo-day-now")).toBe(1);

  await app.press(day(17));
  await app.waitFor("text:sel=2026-11-17");
  await app.waitFor("id:todo-calendar-agenda >> text:Tue, Nov 17");
  expect(app.count("id:todo-calendar-agenda >> id:todo-day-row-d0")).toBe(3);
  expect(app.count("id:todo-calendar-agenda >> id:todo-day-row-d1 >> text:Team digest")).toBe(2);
  expect(app.shows("id:todo-calendar-agenda >> text:Started by hand")).toBe(true);
  await app.press("id:todo-day-item-report >> nth=1");
  await app.waitFor("text:open=report");

  // A day is 52pt high, its marks inside it under the number; the list starts below the grid.
  await app.waitUntil(() => Boolean(frames(app)["marks-2026-11-24"] && frames(app)["day-2026-11-24"]));
  const all = frames(app);
  for (const date of ["2026-11-17", "2026-11-23", "2026-11-24"]) {
    expect(all[`day-${date}`].h).toBe(52);
    expect(all[`marks-${date}`].h).toBe(8);
    expect(within(all[`marks-${date}`], all[`day-${date}`])).toBe(true);
  }
  // Seven days fill the width between the 12pt margins.
  expect(Math.abs(all["day-2026-11-17"].w - (390 - 24) / 7) <= 1).toBe(true);
});
