import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCalendar,
  cellView,
  dayOf,
  dayRows,
  isQuiet,
  jobWiring,
  noteText,
  nowIndex,
  phoneMarks,
  planOccurrences,
  repeatingJobs,
} from "./calendar-runs.js";

const TZ = "UTC";
const at = (value) => new Date(value);

// Morning report repeats on weekdays, Team digest runs after each of its runs, Release notes is
// started by hand only, and Sweep runs every half hour.
const REPORT = jobWiring({ id: "report", cron: "0 9 * * 1-5", tz: "UTC" });
const DIGEST = jobWiring({ id: "digest" }, { uses: [{ job_id: "report", mode: "each" }], triggers: [] });
const NOTES = jobWiring({ id: "notes" }, { triggers: [{ id: "trg-poke", kind: "poke" }] });
const SWEEP = jobWiring({ id: "sweep", cron: "*/30 * * * *", tz: "UTC" });
const JOBS = [REPORT, DIGEST, NOTES, SWEEP];

function run(run_id, job_id, status, queued_at, cause = {}, error = "") {
  return {
    run_id,
    job_id,
    status,
    queued_at,
    error,
    cause: { kind: "schedule", trigger_id: "trg-schedule", from_job_id: "", origin_run_id: run_id, note: "", ...cause },
  };
}

function calendar(runs, { jobs = JOBS, now = "2026-11-23T09:02:00Z", from = "2026-11-01T00:00:00Z", to = "2026-12-06T00:00:00Z" } = {}) {
  return buildCalendar({ jobs, runs, occurrences: planOccurrences(jobs, at(from), at(to), TZ), now: at(now), timezone: TZ });
}

const rowsOf = (days, date) => dayRows(days.get(date) || []);
const titles = (rows) => rows.map((row) => `${"  ".repeat(row.depth)}${row.jobId}${row.count > 1 ? ` x${row.count}` : ""} ${row.state}`);

test("a legacy job has the one schedule trigger its cron makes", () => {
  assert.deepEqual(REPORT.triggers, [{ id: "trg-schedule", kind: "schedule", at: "", cron: "0 9 * * 1-5", tz: "UTC", channel: "" }]);
  assert.deepEqual(jobWiring({ id: "x" }).triggers, []);
  assert.equal(jobWiring({ id: "x", enabled: false }).enabled, false);
});

test("stored triggers are used, the page's own schedule standing for the first schedule trigger", () => {
  const stored = {
    triggers: [
      { id: "trg-poke", kind: "poke" },
      { id: "trg-a", kind: "schedule", cron: "0 9 * * *", tz: "UTC" },
      { id: "trg-b", kind: "schedule", cron: "0 18 * * 6", tz: "UTC" },
    ],
    uses: [
      { job_id: "report", mode: "each" },
      { job_id: "notes", mode: "latest" },
      { job_id: "x", mode: "each" },
    ],
  };
  // The page edited the first schedule to 10:00 and has not saved yet.
  const job = jobWiring({ id: "x", cron: "0 10 * * *", tz: "UTC" }, stored);
  assert.deepEqual(
    job.triggers.map((trigger) => `${trigger.id}:${trigger.kind}:${trigger.cron}`),
    ["trg-poke:poke:", "trg-a:schedule:0 10 * * *", "trg-b:schedule:0 18 * * 6"],
  );
  // Only "each" starts the job; a job does not use itself.
  assert.deepEqual(job.uses, ["report"]);
  // A task that carries its own triggers is taken as written.
  const own = jobWiring({ id: "y", cron: "0 10 * * *", triggers: [{ id: "trg-c", kind: "schedule", cron: "5 5 * * *" }] }, stored);
  assert.deepEqual(own.triggers.map((trigger) => trigger.cron), ["5 5 * * *"]);
});

test("the strip names each repeating job once, a chained job after the one that starts it", () => {
  const twice = jobWiring({ id: "twice" }, {
    triggers: [
      { id: "a", kind: "schedule", cron: "0 9 * * *" },
      { id: "b", kind: "schedule", cron: "0 18 * * *" },
      { id: "c", kind: "schedule", at: "2026-12-01 10:00" },
    ],
  });
  const off = jobWiring({ id: "off", enabled: false, cron: "0 1 * * *" });
  const once = jobWiring({ id: "once", at: "2026-12-01 10:00" });
  const strip = repeatingJobs([REPORT, DIGEST, NOTES, SWEEP, twice, off, once]);
  assert.deepEqual(
    strip.map((item) => `${item.jobId}:${item.triggers.map((trigger) => trigger.id).join("+")}:${item.after}`),
    ["report:trg-schedule:", "digest::report", "sweep:trg-schedule:", "twice:a+b:"],
  );
});

test("every schedule trigger of a job is planned, in the display zone's days", () => {
  const job = jobWiring({ id: "twice" }, {
    triggers: [
      { id: "a", kind: "schedule", cron: "0 9 * * *", tz: "UTC" },
      { id: "b", kind: "schedule", cron: "30 23 * * *", tz: "UTC" },
      { id: "c", kind: "schedule", at: "2026-11-24 10:00", tz: "UTC+9" },
      { id: "p", kind: "poke" },
    ],
  });
  const found = planOccurrences([job], at("2026-11-24T00:00:00Z"), at("2026-11-25T00:00:00Z"), "UTC+9");
  assert.deepEqual(
    found.map((item) => `${item.triggerId}@${new Date(item.time).toISOString()}=${item.date}${item.repeating ? " r" : ""}`),
    [
      // 10:00 in UTC+9 is 01:00 UTC.
      "c@2026-11-24T01:00:00.000Z=2026-11-24",
      "a@2026-11-24T09:00:00.000Z=2026-11-24 r",
      // 23:30 UTC is the next day in UTC+9: the run's day is the display zone's.
      "b@2026-11-24T23:30:00.000Z=2026-11-25 r",
    ],
  );
  assert.equal(dayOf(Date.parse("2026-11-24T23:30:00Z"), "UTC+9"), "2026-11-25");
  // A disabled job and a schedule that does not parse plan nothing.
  assert.deepEqual(planOccurrences([{ ...job, enabled: false }], at("2026-11-24T00:00:00Z"), at("2026-11-25T00:00:00Z"), TZ), []);
  assert.deepEqual(planOccurrences([jobWiring({ id: "bad", cron: "nope" })], at("2026-11-24T00:00:00Z"), at("2026-11-25T00:00:00Z"), TZ), []);
});

test("planning counts the minutes of an hour on, and agrees with the zone's clock across a clock change", () => {
  // New York leaves daylight time on 2026-11-01 (01:59 EDT is followed by 01:00 EST) and enters it
  // on 2026-03-08 (01:59 EST is followed by 03:00 EDT); Lord Howe moves by half an hour.
  for (const [zone, from, to] of [
    ["America/New_York", "2026-10-31T00:00:00Z", "2026-11-02T12:00:00Z"],
    ["America/New_York", "2026-03-07T00:00:00Z", "2026-03-09T12:00:00Z"],
    ["Australia/Lord_Howe", "2026-04-04T00:00:00Z", "2026-04-05T12:00:00Z"],
    ["Asia/Kolkata", "2026-11-23T00:00:00Z", "2026-11-24T00:00:00Z"],
  ]) {
    const job = jobWiring({ id: "j" }, {
      triggers: [
        { id: "a", kind: "schedule", cron: "*/20 1-3 * * *", tz: zone },
        { id: "b", kind: "schedule", cron: "45 23 * * 0,6", tz: zone },
      ],
    });
    const found = planOccurrences([job], at(from), at(to), zone).map((item) => `${item.triggerId}@${item.time}`);
    // Minute by minute, from the platform's own formatter.
    const format = new Intl.DateTimeFormat("en-CA-u-hc-h23", { timeZone: zone, hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" });
    const expected = [];
    for (let time = Date.parse(from); time < Date.parse(to); time += 60000) {
      const parts = Object.fromEntries(format.formatToParts(new Date(time)).map((part) => [part.type, part.value]));
      const hour = Number(parts.hour);
      const minute = Number(parts.minute);
      if (hour >= 1 && hour <= 3 && minute % 20 === 0) expected.push(`a@${time}`);
      if (hour === 23 && minute === 45 && ["Sat", "Sun"].includes(parts.weekday)) expected.push(`b@${time}`);
    }
    assert.deepEqual(found, expected, zone);
    assert.ok(found.length > 0, zone);
  }
});

test("a usual repeating run folds; a failed, canceled or skipped one does not", () => {
  const days = calendar(
    [
      run("r1", "report", "done", "2026-11-17T09:00:00Z"),
      run("r2", "report", "failed", "2026-11-18T09:00:00Z", {}, "the model timed out"),
      run("r3", "report", "canceled", "2026-11-19T09:00:00Z"),
      run("d1", "digest", "done", "2026-11-17T09:01:00Z", { kind: "job", trigger_id: "", from_job_id: "report", origin_run_id: "r1" }),
      run("d2", "digest", "skipped", "2026-11-18T09:01:00Z", { kind: "job", trigger_id: "", from_job_id: "report", origin_run_id: "r2", note: "input job report failed" }),
    ],
    { jobs: [REPORT, DIGEST, NOTES] },
  );
  const quiet = (date) => rowsOf(days, date).map((row) => `${row.jobId}:${row.state}:${isQuiet(row)}`);
  // The chained run of a repeating run is repeating too.
  assert.deepEqual(quiet("2026-11-17"), ["report:done:true", "digest:done:true"]);
  assert.deepEqual(quiet("2026-11-18"), ["report:failed:false", "digest:skipped:false"]);
  assert.deepEqual(quiet("2026-11-19"), ["report:canceled:false"]);

  const usual = cellView(rowsOf(days, "2026-11-17"));
  assert.deepEqual(usual.marks, [{ tone: "on", count: 0 }, { tone: "on", count: 0 }]);
  assert.deepEqual(usual.lines, []);
  const failed = cellView(rowsOf(days, "2026-11-18"));
  assert.deepEqual(failed.marks, []);
  assert.deepEqual(failed.lines.map((line) => `${line.row.jobId}:${line.row.state}:${line.inset}`), ["report:failed:false", "digest:skipped:true"]);
  assert.equal(failed.lines[0].row.error, "the model timed out");
  assert.equal(failed.lines[1].row.cause.note, "input job report failed");
  // Unfolded, every run is written.
  const open = cellView(rowsOf(days, "2026-11-17"), { folded: false });
  assert.deepEqual(open.marks, []);
  assert.deepEqual(open.lines.map((line) => line.row.jobId), ["report", "digest"]);
});

test("runs started some other way never fold, nor does a chain they start", () => {
  const days = calendar(
    [
      run("m1", "report", "done", "2026-11-17T14:10:00Z", { kind: "manual", trigger_id: "" }),
      run("m2", "digest", "done", "2026-11-17T14:11:00Z", { kind: "job", trigger_id: "", from_job_id: "report", origin_run_id: "m1" }),
      run("p1", "notes", "done", "2026-11-17T15:00:00Z", { kind: "poke", trigger_id: "trg-poke" }),
      run("g1", "notes", "done", "2026-11-17T16:00:00Z", { kind: "message", trigger_id: "trg-msg" }),
      // A schedule run whose trigger is gone, and one of a job that is gone: not known to repeat.
      run("s1", "report", "done", "2026-11-17T17:00:00Z", { trigger_id: "trg-old" }),
      run("s2", "gone", "done", "2026-11-17T18:00:00Z"),
    ],
    { jobs: [REPORT, DIGEST, NOTES] },
  );
  const rows = rowsOf(days, "2026-11-17");
  assert.deepEqual(rows.map(isQuiet), [false, false, false, false, false, false]);
  assert.deepEqual(cellView(rows).marks, []);
  assert.equal(cellView(rows).lines.length, 5);
  assert.equal(cellView(rows).more, 1);
});

test("a one-time schedule is planned in words, not as a mark", () => {
  const once = jobWiring({ id: "once", at: "2026-11-25 10:00", tz: "UTC" });
  const days = calendar([], { jobs: [once] });
  const rows = rowsOf(days, "2026-11-25");
  assert.deepEqual(titles(rows), ["once planned"]);
  assert.equal(isQuiet(rows[0]), false);
});

test("today shows what ran and what is planned; a running run is never folded", () => {
  const days = calendar(
    [
      run("r1", "report", "running", "2026-11-23T09:00:00Z"),
      run("n1", "notes", "queued", "2026-11-23T09:01:00Z", { kind: "manual", trigger_id: "" }),
    ],
    { jobs: [REPORT, DIGEST, NOTES] },
  );
  const rows = rowsOf(days, "2026-11-23");
  // The digest is expected as soon as the report finishes, under it.
  assert.deepEqual(titles(rows), ["report running", "  digest planned", "notes queued"]);
  assert.equal(rows[1].cause.waiting, true);
  assert.equal(isQuiet(rows[0]), false);
  const cell = cellView(rows);
  assert.deepEqual(cell.lines.map((line) => line.row.jobId), ["report", "notes"]);
  assert.deepEqual(cell.marks, [{ tone: "off", count: 0 }]);
  // The next day is planned only: both fold, hollow.
  assert.deepEqual(titles(rowsOf(days, "2026-11-24")), ["report planned", "  digest planned"]);
  assert.deepEqual(cellView(rowsOf(days, "2026-11-24")).marks, [{ tone: "off", count: 0 }, { tone: "off", count: 0 }]);
  // The past has no plan: nothing ran on the 20th, so nothing shows.
  assert.equal(days.has("2026-11-20"), false);
  // A chain that already reached the digest plans no second one.
  const reached = calendar(
    [
      run("r1", "report", "running", "2026-11-23T09:00:00Z"),
      run("d1", "digest", "skipped", "2026-11-23T09:00:30Z", { kind: "job", trigger_id: "", from_job_id: "report", origin_run_id: "r1" }),
    ],
    { jobs: [REPORT, DIGEST] },
  );
  assert.deepEqual(titles(rowsOf(reached, "2026-11-23")), ["report running", "  digest skipped"]);
});

test("a frequent job collapses to one row with a count and its range, per outcome", () => {
  const runs = [];
  for (let index = 0; index < 19; index += 1) {
    const time = new Date(Date.parse("2026-11-23T00:00:00Z") + index * 30 * 60000).toISOString();
    runs.push(run(`s${index}`, "sweep", index === 3 ? "failed" : "done", time));
  }
  const days = calendar(runs, { jobs: [SWEEP] });
  const rows = rowsOf(days, "2026-11-23");
  assert.deepEqual(titles(rows), ["sweep x18 done", "sweep failed", "sweep x29 planned"]);
  assert.equal(new Date(rows[0].time).toISOString(), "2026-11-23T00:00:00.000Z");
  assert.equal(new Date(rows[0].lastTime).toISOString(), "2026-11-23T09:00:00.000Z");
  assert.equal(new Date(rows[2].time).toISOString(), "2026-11-23T09:30:00.000Z");
  assert.equal(new Date(rows[2].lastTime).toISOString(), "2026-11-23T23:30:00.000Z");
  assert.equal(nowIndex(rows), 2);
  // In the cell: one filled and one hollow mark, and the failure in words.
  const cell = cellView(rows);
  assert.deepEqual(cell.marks, [{ tone: "on", count: 0 }, { tone: "off", count: 0 }]);
  assert.deepEqual(cell.lines.map((line) => `${line.row.jobId}:${line.row.state}`), ["sweep:failed"]);
  // Three alike stay three rows.
  assert.deepEqual(titles(dayRows((days.get("2026-11-23") || []).filter((entry) => entry.state === "done").slice(0, 3))), [
    "sweep done",
    "sweep done",
    "sweep done",
  ]);
  // A live run is never collapsed.
  const live = Array.from({ length: 5 }, (_, index) => run(`q${index}`, "sweep", "queued", `2026-11-23T08:0${index}:00Z`));
  assert.equal(dayRows(calendar(live, { jobs: [SWEEP] }).get("2026-11-23").filter((entry) => entry.state === "queued")).length, 5);
});

test("the runs chained off a collapsed row collapse under it", () => {
  const each = jobWiring({ id: "each" }, { uses: [{ job_id: "sweep", mode: "each" }] });
  const days = calendar([], { jobs: [SWEEP, each] });
  assert.deepEqual(titles(rowsOf(days, "2026-11-24")), ["sweep x48 planned", "  each x48 planned"]);
});

test("a row of marks never grows past its count: it becomes one mark per kind with a count", () => {
  const many = Array.from({ length: 7 }, (_, index) => jobWiring({ id: `j${index}`, cron: `${index} 8 * * *`, tz: "UTC" }));
  const runs = many.slice(0, 4).map((job, index) => run(`r${index}`, job.id, "done", `2026-11-23T08:0${index}:00Z`));
  const days = calendar(runs, { jobs: many, now: "2026-11-23T08:03:30Z" });
  assert.deepEqual(cellView(rowsOf(days, "2026-11-23")).marks, [{ tone: "on", count: 4 }, { tone: "off", count: 3 }]);
  assert.deepEqual(cellView(rowsOf(days, "2026-11-24")).marks, [{ tone: "off", count: 7 }]);
  assert.equal(cellView(rowsOf(days, "2026-11-24"), { maxMarks: 7 }).marks.length, 7);
  // Unfolded, five lines and the rest behind a count.
  const open = cellView(rowsOf(days, "2026-11-24"), { folded: false });
  assert.equal(open.lines.length, 5);
  assert.equal(open.more, 2);
});

test("a chained run is listed under the run that started it, on the same day", () => {
  const cause = (origin) => ({ kind: "job", trigger_id: "", from_job_id: "report", origin_run_id: origin });
  const days = calendar(
    [
      run("a1", "report", "done", "2026-11-17T09:00:00Z"),
      run("a2", "report", "done", "2026-11-17T14:00:00Z", { kind: "manual", trigger_id: "" }),
      run("b2", "digest", "done", "2026-11-17T14:02:00Z", cause("a2")),
      run("b1", "digest", "done", "2026-11-17T09:02:00Z", cause("a1")),
      run("x1", "notes", "done", "2026-11-17T09:01:00Z", { kind: "poke", trigger_id: "trg-poke" }),
      // Started late on the 17th, its digest ran after midnight: on the 18th it stands alone.
      run("a3", "report", "done", "2026-11-17T23:59:00Z", { kind: "manual", trigger_id: "" }),
      run("b3", "digest", "done", "2026-11-18T00:01:00Z", cause("a3")),
    ],
    { jobs: [REPORT, DIGEST, NOTES] },
  );
  assert.deepEqual(titles(rowsOf(days, "2026-11-17")), [
    "report done",
    "  digest done",
    "notes done",
    "report done",
    "  digest done",
    "report done",
  ]);
  assert.deepEqual(titles(rowsOf(days, "2026-11-18")), ["digest done"]);
  assert.equal(rowsOf(days, "2026-11-18")[0].cause.fromJobId, "report");
});

test("a job reached by two paths of one chain is planned once", () => {
  const b = jobWiring({ id: "b" }, { uses: [{ job_id: "report", mode: "each" }] });
  const c = jobWiring({ id: "c" }, { uses: [{ job_id: "report", mode: "each" }] });
  const d = jobWiring({ id: "d" }, { uses: [{ job_id: "b", mode: "each" }, { job_id: "c", mode: "each" }] });
  const loop = jobWiring({ id: "loop" }, { uses: [{ job_id: "d", mode: "each" }, { job_id: "loop", mode: "each" }] });
  const days = calendar([], { jobs: [REPORT, b, c, d, loop] });
  assert.deepEqual(titles(rowsOf(days, "2026-11-24")), ["report planned", "  b planned", "    d planned", "      loop planned", "  c planned"]);
});

test("a phone cell: one small mark for the usual repeats, a full one per run that differs", () => {
  const days = calendar(
    [
      run("r1", "report", "done", "2026-11-17T09:00:00Z"),
      run("m1", "notes", "done", "2026-11-17T10:00:00Z", { kind: "manual", trigger_id: "" }),
      run("r2", "report", "failed", "2026-11-18T09:00:00Z"),
      run("r3", "report", "running", "2026-11-23T09:00:00Z"),
    ],
    { jobs: [REPORT, NOTES] },
  );
  assert.deepEqual(phoneMarks(rowsOf(days, "2026-11-17")), [{ tone: "on", small: true }, { tone: "on", small: false }]);
  assert.deepEqual(phoneMarks(rowsOf(days, "2026-11-18")), [{ tone: "error", small: false }]);
  assert.deepEqual(phoneMarks(rowsOf(days, "2026-11-23")), [{ tone: "running", small: false }]);
  assert.deepEqual(phoneMarks(rowsOf(days, "2026-11-24")), [{ tone: "off", small: true }]);
  assert.deepEqual(phoneMarks([]), []);
  const six = Array.from({ length: 6 }, (_, index) => run(`m${index}`, `job${index}`, "done", `2026-11-17T1${index}:00:00Z`, { kind: "manual" }));
  assert.equal(phoneMarks(rowsOf(calendar(six, { jobs: [] }), "2026-11-17")).length, 4);
});

test("history rows that cannot be placed are left out, and a run is listed once", () => {
  const days = calendar(
    [
      run("r1", "report", "done", "2026-11-17T09:00:00Z"),
      run("r1", "report", "done", "2026-11-17T09:00:00Z"),
      run("r2", "report", "exploded", "2026-11-17T10:00:00Z"),
      run("r3", "", "done", "2026-11-17T10:00:00Z"),
      run("r4", "report", "done", "not a time"),
      null,
    ],
    { jobs: [REPORT] },
  );
  assert.deepEqual(titles(rowsOf(days, "2026-11-17")), ["report done"]);
});

test("a note names jobs by their titles", () => {
  const titleOf = (id) => ({ report: "Morning report", "report-2": "Second" })[id] || "";
  assert.equal(noteText("input job report failed", ["report", "report-2", "x"], titleOf), "input job Morning report failed");
  assert.equal(noteText("input job report-2 was skipped", ["report", "report-2"], titleOf), "input job Second was skipped");
  assert.equal(noteText("input job gone failed", ["gone"], titleOf), "input job gone failed");
  assert.equal(noteText("", ["report"], titleOf), "");
});
