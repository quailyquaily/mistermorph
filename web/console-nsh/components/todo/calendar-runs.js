// What the job calendar shows, worked out without the framework: which runs fall on which day,
// which of them fold to a mark, how a busy day collapses, and how a day lists them in full.
//
// - Past: what ran, from the run history (GET /todo/runs/history), whatever started it.
// - Future: what is planned, every schedule trigger of every enabled job, and after each planned
//   run the jobs that use its job.
// - Today: both; a run that is waiting or running is never folded or collapsed.
//
// One rule for days: a run belongs to the day its moment falls on in the display time zone (the
// browser's), whatever zone its schedule was written in. A recorded run's moment is when it was
// queued (for a scheduled run, the schedule's minute); a planned run's is the minute its trigger
// fires. `wallClock` (lib/core/todo-calendar.js) is the one clock both go through.
import { cronMatches, parseCronExpression } from "../../lib/core/cron.js";
import { atMinute, wallClock } from "../../lib/core/todo-calendar.js";

const MINUTE_MS = 60 * 1000;
/** The schedule trigger a job's own at or cron makes (internal/cron/triggers.go). */
export const LEGACY_TRIGGER_ID = "trg-schedule";
/** As many runs of one job, alike, on one day are one entry with a count. */
export const COLLAPSE_AT = 4;
/** A cell writes this many lines, then "+N more". */
export const MAX_LINES = 5;
/** A cell draws this many folded marks, then one mark per kind with a count. */
export const MAX_MARKS = 5;
/** A phone's cell draws this many marks for runs that differ. */
export const MAX_PHONE_MARKS = 4;
/** How deep a chain of jobs is followed when planning (the runtime's own limit is lower). */
const MAX_PLAN_DEPTH = 8;

const RUN_STATES = ["queued", "running", "done", "failed", "canceled", "skipped"];

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function dateKey(parts) {
  return `${String(parts.year).padStart(4, "0")}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

function normalizeTrigger(raw) {
  return {
    id: text(raw?.id),
    kind: text(raw?.kind),
    at: text(raw?.at),
    cron: text(raw?.cron),
    tz: text(raw?.tz),
    channel: text(raw?.channel),
  };
}

/**
 * A job as the calendar needs it: `{ id, enabled, triggers, uses }`, `uses` being the IDs of the
 * jobs whose every finished run starts this one.
 *
 * `task` is the page's item and `stored` the same job as GET /todo/tasks answered it. The triggers
 * are the task's own when it carries them, else the stored ones, else (a legacy answer) the one
 * schedule its at or cron makes. The task's own at, cron and tz stand for its first schedule
 * trigger, so an edit made on the page shows before it is saved.
 */
export function jobWiring(task, stored) {
  const id = text(task?.id);
  const own = Array.isArray(task?.triggers);
  const source = own ? task.triggers : Array.isArray(stored?.triggers) ? stored.triggers : null;
  const at = text(task?.at);
  const cron = text(task?.cron);
  const tz = text(task?.tz);
  const legacy = at || cron ? { id: LEGACY_TRIGGER_ID, kind: "schedule", at, cron, tz, channel: "" } : null;
  let triggers;
  if (!source) {
    triggers = legacy ? [legacy] : [];
  } else {
    triggers = source.map(normalizeTrigger).filter((trigger) => trigger.kind);
    if (!own && legacy) {
      const first = triggers.findIndex((trigger) => trigger.kind === "schedule");
      if (first < 0) {
        triggers = [legacy, ...triggers];
      } else {
        triggers = triggers.map((trigger, index) => (index === first ? { ...trigger, at, cron, tz } : trigger));
      }
    }
  }
  const usesSource = Array.isArray(task?.uses) ? task.uses : Array.isArray(stored?.uses) ? stored.uses : [];
  const uses = [];
  for (const use of usesSource) {
    const from = text(use?.job_id);
    if (from && from !== id && !uses.includes(from)) {
      uses.push(from);
    }
  }
  return { id, enabled: task?.enabled !== false, triggers, uses };
}

/** Whether a trigger is a schedule that repeats (a cron), not a single moment. */
export function triggerRepeats(trigger) {
  return trigger?.kind === "schedule" && !!trigger.cron && !trigger.at;
}

/**
 * The repeating jobs, each once, for the strip above the grid: an enabled job with a repeating
 * schedule (`{ jobId, triggers }`, its repeating triggers), followed by the enabled jobs chained off
 * it (`{ jobId, after }`, the job whose runs start it).
 */
export function repeatingJobs(jobs) {
  const list = (Array.isArray(jobs) ? jobs : []).filter((job) => job?.id && job.enabled);
  const out = [];
  const seen = new Set();
  const addDependents = (fromId, depth) => {
    if (depth > MAX_PLAN_DEPTH) return;
    for (const job of list) {
      if (seen.has(job.id) || !job.uses.includes(fromId)) continue;
      seen.add(job.id);
      out.push({ jobId: job.id, triggers: [], after: fromId });
      addDependents(job.id, depth + 1);
    }
  };
  for (const job of list) {
    const triggers = job.triggers.filter(triggerRepeats);
    if (triggers.length === 0 || seen.has(job.id)) continue;
    seen.add(job.id);
    out.push({ jobId: job.id, triggers, after: "" });
    addDependents(job.id, 1);
  }
  return out;
}

const HOUR_MS = 60 * MINUTE_MS;

function wallFromUTC(pseudo) {
  const date = new Date(pseudo);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    weekday: date.getUTCDay(),
  };
}

const wallAsUTC = (wall) => Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);

/**
 * A zone's wall clock for times asked in rising order, minute by minute. Asking the platform for
 * every minute of six weeks is tens of thousands of date formats per zone (seconds on a phone), so
 * it is asked once an hour and the minutes between are counted on, which is exact while the zone's
 * offset holds. An hour whose two ends are not sixty minutes apart on the wall (a clock change) is
 * asked minute by minute.
 */
function steppedClock(clock) {
  let start = NaN;
  let startWall = 0;
  let steady = false;
  let nextWall = NaN;
  return (time) => {
    if (!(time >= start && time < start + HOUR_MS)) {
      const carried = time === start + HOUR_MS && Number.isFinite(nextWall);
      start = time;
      startWall = carried ? nextWall : wallAsUTC(clock(time));
      nextWall = wallAsUTC(clock(time + HOUR_MS));
      steady = nextWall - startWall === HOUR_MS;
    }
    return steady ? wallFromUTC(startWall + (time - start)) : clock(time);
  };
}

/**
 * Every minute a schedule trigger of an enabled job fires in [from, to): `{ jobId, triggerId,
 * time, date, repeating }`, `time` in milliseconds and `date` its day in the display zone. A
 * trigger that does not parse plans nothing.
 */
export function planOccurrences(jobs, from, to, displayTimezone) {
  const fromTime = from instanceof Date ? from.getTime() : Number(from);
  const toTime = to instanceof Date ? to.getTime() : Number(to);
  if (!Number.isFinite(fromTime) || !Number.isFinite(toTime) || toTime <= fromTime) {
    return [];
  }
  const displayZone = text(displayTimezone) || "UTC";
  const displayClock = wallClock(displayZone);
  const groups = new Map();
  for (const job of Array.isArray(jobs) ? jobs : []) {
    if (!job?.id || !job.enabled) continue;
    for (const trigger of job.triggers) {
      if (trigger.kind !== "schedule" || (trigger.at === "") === (trigger.cron === "")) continue;
      try {
        const zone = trigger.tz || displayZone;
        let group = groups.get(zone);
        if (!group) {
          group = { clock: wallClock(zone), once: new Map(), recurring: [] };
          groups.set(zone, group);
        }
        const item = { jobId: job.id, triggerId: trigger.id };
        if (trigger.at) {
          const minute = atMinute(trigger.at);
          group.once.set(minute, [...(group.once.get(minute) || []), item]);
        } else {
          group.recurring.push({ ...item, cron: parseCronExpression(trigger.cron) });
        }
      } catch {
        // An invalid schedule or zone: the editor says so; the calendar plans nothing for it.
      }
    }
  }
  const out = [];
  const firstMinute = Math.ceil(fromTime / MINUTE_MS) * MINUTE_MS;
  for (const group of groups.values()) {
    const wallAt = steppedClock(group.clock);
    for (let time = firstMinute; time < toTime; time += MINUTE_MS) {
      const wall = wallAt(time);
      const once = group.once.size
        ? group.once.get(`${dateKey(wall)} ${pad2(wall.hour)}:${pad2(wall.minute)}`)
        : undefined;
      let date = "";
      const add = (item, repeating) => {
        date = date || dateKey(displayClock(time));
        out.push({ jobId: item.jobId, triggerId: item.triggerId, time, date, repeating });
      };
      if (once) once.forEach((item) => add(item, false));
      for (const item of group.recurring) {
        if (cronMatches(item.cron, wall)) add(item, true);
      }
    }
  }
  return out.sort((left, right) => left.time - right.time);
}

/** The day `time` falls on in the display zone, as YYYY-MM-DD. */
export function dayOf(time, displayTimezone) {
  return dateKey(wallClock(text(displayTimezone) || "UTC")(time));
}

/**
 * The entries of every day, as a Map from YYYY-MM-DD to a list in time order.
 *
 * An entry: `{ key, jobId, date, time, state, cause, error, runId, repeating, parentKey }`.
 * `state` is the run's status, or "planned". `cause` is `{ kind, triggerId, fromJobId, note,
 * waiting }` (`waiting`: planned behind a run that is still going). `repeating`: the run came from
 * a repeating schedule, or from a job chained off such a run. `parentKey` names the entry of the
 * same day that started it.
 *
 * `runs` are GET /todo/runs/history items, `occurrences` planOccurrences' answer (those after
 * `now` are planned), `jobs` the jobWiring list.
 */
export function buildCalendar({ jobs, runs, occurrences, now, timezone }) {
  const jobList = (Array.isArray(jobs) ? jobs : []).filter((job) => job?.id);
  const jobsById = new Map(jobList.map((job) => [job.id, job]));
  const jobOrder = new Map(jobList.map((job, index) => [job.id, index]));
  const displayClock = wallClock(text(timezone) || "UTC");
  const nowTime = now instanceof Date ? now.getTime() : Number(now);
  const entries = [];

  // What ran.
  const records = [];
  const byRunId = new Map();
  for (const raw of Array.isArray(runs) ? runs : []) {
    const jobId = text(raw?.job_id);
    const runId = text(raw?.run_id);
    const state = text(raw?.status);
    const time = Date.parse(text(raw?.queued_at) || text(raw?.started_at));
    if (!jobId || !RUN_STATES.includes(state) || !Number.isFinite(time) || (runId && byRunId.has(runId))) {
      continue;
    }
    const record = {
      key: runId ? `run:${runId}` : `run:${jobId}:${time}:${records.length}`,
      jobId,
      runId,
      state,
      time,
      date: dateKey(displayClock(time)),
      error: text(raw?.error),
      kind: text(raw?.cause?.kind),
      triggerId: text(raw?.cause?.trigger_id),
      fromJobId: text(raw?.cause?.from_job_id),
      originRunId: text(raw?.cause?.origin_run_id),
      note: text(raw?.cause?.note),
    };
    records.push(record);
    if (runId) byRunId.set(runId, record);
  }
  const repeats = (record) => {
    if (record.kind === "schedule") {
      const trigger = jobsById.get(record.jobId)?.triggers.find((item) => item.id === record.triggerId);
      return triggerRepeats(trigger);
    }
    if (record.kind === "job") {
      // A chained run is as its chain's first run is.
      const origin = byRunId.get(record.originRunId);
      return !!origin && origin !== record && origin.kind !== "job" && repeats(origin);
    }
    return false;
  };
  const sameChain = (record, other) =>
    !!record.originRunId && (other.originRunId === record.originRunId || other.runId === record.originRunId);
  const entryOf = new Map();
  const recordsByJob = new Map();
  for (const record of records) {
    const list = recordsByJob.get(record.jobId);
    if (list) list.push(record);
    else recordsByJob.set(record.jobId, [record]);
  }
  for (const record of records) {
    let parentKey = "";
    if (record.kind === "job" && record.fromJobId) {
      let parent = null;
      for (const other of recordsByJob.get(record.fromJobId) || []) {
        if (other === record || other.time > record.time || !sameChain(record, other)) {
          continue;
        }
        if (!parent || other.time > parent.time) parent = other;
      }
      if (parent && parent.date === record.date) parentKey = parent.key;
    }
    const entry = {
      key: record.key,
      jobId: record.jobId,
      date: record.date,
      time: record.time,
      state: record.state,
      cause: { kind: record.kind, triggerId: record.triggerId, fromJobId: record.fromJobId, note: record.note, waiting: false },
      error: record.error,
      runId: record.runId,
      repeating: repeats(record),
      parentKey,
    };
    entries.push(entry);
    entryOf.set(record.key, entry);
  }

  // What is planned behind an entry: the enabled jobs that use its job, and theirs in turn. `seen`
  // keeps a job reached by two paths of one chain to one entry, as the runtime does.
  const planDependents = (parent, waiting, seen, depth) => {
    if (depth > MAX_PLAN_DEPTH) return;
    for (const job of jobList) {
      if (!job.enabled || seen.has(job.id) || !job.uses.includes(parent.jobId)) continue;
      seen.add(job.id);
      const entry = {
        key: `plan:${job.id}:after:${parent.key}`,
        jobId: job.id,
        date: parent.date,
        time: parent.time,
        state: "planned",
        cause: { kind: "job", triggerId: "", fromJobId: parent.jobId, note: "", waiting },
        error: "",
        runId: "",
        repeating: parent.repeating,
        parentKey: parent.key,
      };
      entries.push(entry);
      planDependents(entry, waiting, seen, depth + 1);
    }
  };

  // A run still going: the jobs that use its job start when it ends, unless the chain already
  // reached them.
  for (const record of records) {
    if (record.state !== "running" && record.state !== "queued") continue;
    const entry = entryOf.get(record.key);
    const seen = new Set([record.jobId]);
    const origin = record.originRunId || record.runId;
    for (const other of records) {
      if (origin && other.kind === "job" && other.originRunId === origin) seen.add(other.jobId);
    }
    planDependents(entry, true, seen, 1);
  }

  // What is planned.
  for (const occurrence of Array.isArray(occurrences) ? occurrences : []) {
    if (!(occurrence.time > nowTime) || !jobsById.get(occurrence.jobId)?.enabled) continue;
    const entry = {
      key: `plan:${occurrence.jobId}:${occurrence.triggerId}:${occurrence.time}`,
      jobId: occurrence.jobId,
      date: occurrence.date,
      time: occurrence.time,
      state: "planned",
      cause: { kind: "schedule", triggerId: occurrence.triggerId, fromJobId: "", note: "", waiting: false },
      error: "",
      runId: "",
      repeating: !!occurrence.repeating,
      parentKey: "",
    };
    entries.push(entry);
    planDependents(entry, false, new Set([occurrence.jobId]), 1);
  }

  const rank = (entry) => (entry.state === "planned" ? 1 : 0);
  entries.sort(
    (left, right) =>
      left.time - right.time ||
      rank(left) - rank(right) ||
      (jobOrder.get(left.jobId) ?? 1e9) - (jobOrder.get(right.jobId) ?? 1e9) ||
      (left.key < right.key ? -1 : left.key > right.key ? 1 : 0),
  );
  const days = new Map();
  for (const entry of entries) {
    const list = days.get(entry.date);
    if (list) list.push(entry);
    else days.set(entry.date, [entry]);
  }
  return days;
}

/** A run that is waiting or running now. */
export function isLive(entry) {
  return entry.state === "running" || entry.state === "queued";
}

/**
 * Whether an entry folds to a mark in a cell: a repeating run that ended as usual (done), or one
 * that is planned. A failed, canceled or skipped one is written out; so is every run started some
 * other way (by hand, a poke, a message), and one that is waiting or running.
 */
export function isQuiet(entry) {
  return !!entry.repeating && (entry.state === "done" || entry.state === "planned");
}

/**
 * A day's rows: its entries with the frequent ones collapsed and each chained run under the run
 * that started it.
 *
 * Runs of one job that are alike (the same outcome, started the same way) become one row with
 * `count`, once there are COLLAPSE_AT of them; `time` is the first's and `lastTime` the last's, so
 * the range stays readable. Live runs are never collapsed. A row: an entry plus `{ count,
 * lastTime, depth }`, `depth` 0 at the top and one more under each parent.
 */
export function dayRows(entries, collapseAt = COLLAPSE_AT) {
  const list = Array.isArray(entries) ? entries : [];
  const groups = new Map();
  for (const entry of list) {
    const key = isLive(entry)
      ? entry.key
      : [entry.jobId, entry.state, entry.cause.kind, entry.cause.triggerId, entry.cause.fromJobId, entry.cause.waiting ? 1 : 0].join("\u0000");
    const group = groups.get(key);
    if (group) group.push(entry);
    else groups.set(key, [entry]);
  }
  // Where each entry went: itself, or the row that stands for its group.
  const rowKeyOf = new Map();
  const drafts = [];
  for (const group of groups.values()) {
    if (group.length >= collapseAt) {
      const first = group[0];
      const row = { ...first, key: `group:${first.key}`, count: group.length, lastTime: group[group.length - 1].time, members: group };
      group.forEach((entry) => rowKeyOf.set(entry.key, row.key));
      drafts.push(row);
    } else {
      for (const entry of group) {
        rowKeyOf.set(entry.key, entry.key);
        drafts.push({ ...entry, count: 1, lastTime: entry.time, members: [entry] });
      }
    }
  }
  const rows = drafts.map(({ members, ...row }) => {
    // A collapsed row hangs under a parent only when all its runs do, under one row.
    const parents = new Set(members.map((entry) => (entry.parentKey ? rowKeyOf.get(entry.parentKey) || "" : "")));
    const parentKey = parents.size === 1 ? [...parents][0] : "";
    return { ...row, parentKey: parentKey === row.key ? "" : parentKey };
  });
  const order = new Map(list.map((entry, index) => [entry.key, index]));
  const position = (row) => order.get(row.key.startsWith("group:") ? row.key.slice(6) : row.key) ?? 0;
  rows.sort((left, right) => position(left) - position(right));

  const keys = new Set(rows.map((row) => row.key));
  const children = new Map();
  const roots = [];
  for (const row of rows) {
    if (row.parentKey && keys.has(row.parentKey)) {
      const under = children.get(row.parentKey);
      if (under) under.push(row);
      else children.set(row.parentKey, [row]);
    } else {
      roots.push({ ...row, parentKey: "" });
    }
  }
  const out = [];
  const visit = (row, depth) => {
    out.push({ ...row, depth });
    if (depth < MAX_PLAN_DEPTH) (children.get(row.key) || []).forEach((child) => visit(child, depth + 1));
  };
  roots.forEach((row) => visit(row, 0));
  return out;
}

/** How a row's mark is drawn: "on" (ran), "off" (hollow: planned, skipped, canceled), "error", "running", "pending". */
export function markTone(state) {
  switch (state) {
    case "done":
      return "on";
    case "failed":
      return "error";
    case "running":
      return "running";
    case "queued":
      return "pending";
    default:
      return "off";
  }
}

/**
 * A desktop cell: `{ marks, lines, more }`.
 *
 * Folded, the quiet rows are marks beside the day number, `{ tone, count }` each: one per row,
 * filled ("on") for ran and hollow ("off") for planned, `count` 0. More than MAX_MARKS of them
 * would wrap into the text, so they become one mark per tone with its count. The other rows are
 * the cell's lines (`{ row, inset }`, `inset` under a parent that is written just above), MAX_LINES
 * of them, and `more` counts the rest. Unfolded, every row is a line and there are no marks.
 */
export function cellView(rows, { folded = true, maxLines = MAX_LINES, maxMarks = MAX_MARKS } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const quiet = folded ? list.filter(isQuiet) : [];
  const written = folded ? list.filter((row) => !isQuiet(row)) : list;
  let marks = quiet.map((row) => ({ tone: markTone(row.state), count: 0 }));
  if (marks.length > maxMarks) {
    marks = ["on", "off"]
      .map((tone) => ({ tone, count: marks.filter((mark) => mark.tone === tone).length }))
      .filter((mark) => mark.count > 0);
  }
  const writtenKeys = new Set(written.map((row) => row.key));
  const lines = written.slice(0, maxLines).map((row) => ({ row, inset: !!row.parentKey && writtenKeys.has(row.parentKey) }));
  return { marks, lines, more: written.length - lines.length };
}

/**
 * A phone cell's marks, `{ tone, small }` each: one small mark when the day's repeating runs went
 * as usual (filled once any ran, hollow while all are planned), then a full one for each row that
 * differs, MAX_PHONE_MARKS at most.
 */
export function phoneMarks(rows, max = MAX_PHONE_MARKS) {
  const list = Array.isArray(rows) ? rows : [];
  const quiet = list.filter(isQuiet);
  const marks = [];
  if (quiet.length > 0) {
    marks.push({ tone: quiet.some((row) => row.state === "done") ? "on" : "off", small: true });
  }
  list
    .filter((row) => !isQuiet(row))
    .slice(0, max)
    .forEach((row) => marks.push({ tone: markTone(row.state), small: false }));
  return marks;
}

/** Where today's list changes from what has started to what is planned: the first planned top row's index, or -1. */
export function nowIndex(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const first = list.findIndex((row) => row.depth === 0 && row.state === "planned");
  return first > 0 ? first : -1;
}

/** A cause's note with the job IDs in it replaced by the jobs' names (`titleOf(id)`, "" when unknown). */
export function noteText(note, jobIds, titleOf) {
  let out = text(note);
  if (!out) return "";
  const ids = [...(Array.isArray(jobIds) ? jobIds : [])].filter(Boolean).sort((left, right) => right.length - left.length);
  for (const id of ids) {
    if (!out.includes(id)) continue;
    const title = text(titleOf(id));
    if (title) out = out.split(id).join(title);
  }
  return out;
}
