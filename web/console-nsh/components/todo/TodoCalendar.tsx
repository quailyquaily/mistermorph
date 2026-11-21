// The job calendar: a month of what ran and what is planned, the month in the route's `month`
// query. A past day shows what ran, from the run history, whatever started it; a future day shows
// what is planned, every schedule trigger of every enabled job; today shows both.
//
// It is the list's page turned into a month (TodoIndex): the same head, days on hairlines, the
// list's status square as the only mark. And it says each thing once:
// - A repeating run that went as usual is not news, so in a cell it is a mark beside the day
//   number (filled: ran; hollow: planned), and the strip above the grid names each repeating job
//   once, with its cadence. A cell's text is only what differs: a run started some other way, and
//   a repeating run that failed, was stopped or was skipped. "Show in days" writes them all out.
// - The chosen day lists every run in full (TodoDayList): beside the grid on a desktop, where the
//   page draws it from `onDay`; under the grid on a phone, where the cells are marks only.
// - A cell is one button: it chooses its day. The day's list is where a run opens its job.
//
// Days: a run belongs to the day its moment falls on in the browser's time zone, whatever zone its
// schedule was written in (calendar-runs.js has the rule and the clock; the grid's days and
// "today" are the same zone's).
import { cleanup, computed, effect, signal, Text, untracked, View, windowSize } from "nsh";
import { Button as BaseButton } from "nsh/base";
import { currentLocale, translate } from "../../lib/core/context.js";
import { formatDate } from "../../lib/core/intl-format.js";
import { visibleCalendarDays } from "../../lib/core/todo-calendar.js";
import { currentRoute, locationOf, navigate } from "../../lib/router";
import { gutterX, gutterY } from "../frame/metrics";
import { BAR_ICON_SIZE, Button, CircleButton, LoadingLine, StatusMark, type StatusState } from "../ui";
import { createPartProbe, type PartLayoutListener } from "../shared/partProbe";
import {
  buildCalendar,
  cellView,
  dayOf,
  dayRows,
  jobWiring,
  MAX_MARKS,
  noteText,
  nowIndex,
  phoneMarks,
  planOccurrences,
  repeatingJobs,
  triggerRepeats,
} from "./calendar-runs.js";
import { TODO_HEAD_HEIGHT } from "./TodoIndex";
import { type CalendarDayItem, type CalendarDayView, TodoDayList } from "./TodoDayList";
import { TodoViewToggle } from "./TodoViewToggle";
import { createTodoHistory, type HistoryFetch } from "./todo-history";
import * as model from "./todo-model.js";
import type { CalendarSelection, TodoTask } from "./todo-state";

const t = translate as (key: string, vars?: Record<string, unknown> | null) => string;
const MONTH_PATTERN = /^(\d{4})-(\d{2})$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
/** How often "now" moves: what is planned turns into what ran within this long. */
const CLOCK_MS = 30 * 1000;

function pad2(value: number) {
  return String(value).padStart(2, "0");
}

function monthKey(date: Date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`;
}

function monthDate(value: unknown) {
  const match = String(value || "").match(MONTH_PATTERN);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (year < 1 || month < 1 || month > 12) {
    return null;
  }
  const date = new Date(year, month - 1, 1);
  return date.getFullYear() === year && date.getMonth() === month - 1 ? date : null;
}

function dateFromKey(value: unknown) {
  const match = String(value || "").match(DATE_PATTERN);
  if (!match) {
    return null;
  }
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function addDays(date: Date, count: number) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + count);
}

function browserTimezone() {
  try {
    return String(Intl.DateTimeFormat().resolvedOptions().timeZone || "").trim() || "UTC";
  } catch {
    return "UTC";
  }
}

interface CalendarDay {
  key: string;
  day: number;
  inMonth: boolean;
}

interface Trigger {
  id: string;
  kind: string;
  at: string;
  cron: string;
  tz: string;
  channel: string;
}

interface Job {
  id: string;
  enabled: boolean;
  triggers: Trigger[];
  uses: string[];
}

/** A day's row (calendar-runs.js dayRows): a run, or several alike with their count. */
interface Row {
  key: string;
  jobId: string;
  date: string;
  time: number;
  lastTime: number;
  count: number;
  depth: number;
  state: string;
  cause: { kind: string; triggerId: string; fromJobId: string; note: string; waiting: boolean };
  error: string;
  repeating: boolean;
  parentKey: string;
}

interface Cell {
  marks: { tone: StatusState; count: number }[];
  lines: { row: Row; inset: boolean }[];
  more: number;
}

/**
 * Where the calendar's first row under its head is centred, from the page's top: the strip (its
 * hairline, 5pt, a 32pt button) or, without one, about where the weekdays stand. The day's list
 * beside the grid puts its title on that line.
 */
export const CALENDAR_SIDE_TOP = TODO_HEAD_HEIGHT + 22 - 12;

// Folded or written out, for the session: the choice outlives the page, not the app.
const foldedCells = signal(true);

export interface TodoCalendarProps {
  tasks: TodoTask[];
  tasksLoading?: boolean;
  /** Phones: marks in the cells, the chosen day's list below, no add button (the page's floating one adds). */
  mobile?: boolean;
  taskTitle: (task: TodoTask) => string;
  /** Changes whenever the page's live runs do (/todo/runs): the history is read again. */
  liveKey?: string;
  /** A desktop: the hairline at the calendar's right edge, toward the day's list beside it. */
  divider?: boolean;
  onAddTask?: () => void;
  onSelectDate?: (selection: CalendarSelection) => void;
  onSelectTask?: (task: TodoTask) => void;
  onShowList?: () => void;
  /** The chosen day in full, each time it changes: a desktop page draws it beside the grid (TodoDayList). */
  onDay?: (day: CalendarDayView) => void;
  /** Hears where parts lie on the page (tests): `view-toggle` and `view-toggle-icon` (the list
   * toggle in the head and its icon), `head` (the head's row), and per day `day-<date>`,
   * `number-<date>`, `marks-<date>` and `lines-<date>` (a cell, its number, its row of marks, its text). */
  onPartLayout?: PartLayoutListener;
  /** The current time (tests); the system's by default. */
  now?: () => number;
  /** The month shown when the route names none (tests), as YYYY-MM. */
  month?: string;
  /** The runtime API helper (tests). */
  fetch?: HistoryFetch;
}

export function TodoCalendar(props: TodoCalendarProps) {
  const parts = createPartProbe(() => props.onPartLayout);
  const timezone = browserTimezone();
  const selectedDate = signal("");

  const clock = signal(Date.now());
  const timer = setInterval(() => clock.set(Date.now()), CLOCK_MS);
  cleanup(() => clearInterval(timer));
  const now = () => (props.now ? props.now() : clock());
  const todayKey = computed(() => dayOf(now(), timezone) as string);

  const activeMonthKey = computed(() => {
    const today = dateFromKey(todayKey()) || new Date();
    return monthKey(monthDate(currentRoute()?.query?.month) || monthDate(props.month) || today);
  });
  const activeMonth = computed(() => monthDate(activeMonthKey())!);
  const days = computed(() => visibleCalendarDays(activeMonth()) as CalendarDay[]);
  // What is read and planned: the six weeks on screen and a day more at each end. The grid's days
  // are cut at the machine's midnights and a run's day is the time zone's (calendar-runs.js); where
  // a runtime gives the two different offsets, the spare days keep the first and last day whole.
  const range = computed(() => {
    const first = dateFromKey(days()[0]?.key) || activeMonth();
    return { from: addDays(first, -1), to: addDays(first, 43) };
  });
  const weeks = computed(() => {
    const list = days();
    return Array.from({ length: 6 }, (_, index) => ({ key: list[index * 7]?.key ?? String(index), days: list.slice(index * 7, index * 7 + 7) }));
  });

  const taskByID = computed(() => {
    const result = new Map<string, TodoTask>();
    props.tasks.forEach((task) => {
      const id = String(task?.id || "").trim();
      if (id && !result.has(id)) {
        result.set(id, task);
      }
    });
    return result;
  });
  const history = createTodoHistory({
    range,
    liveKey: () => props.liveKey ?? "",
    // The stored jobs are read again when the page's list is replaced (a load, a save), not on each edit.
    jobsKey: () => props.tasks.map((task) => task._key).join("|"),
    fetch: untracked(() => props.fetch),
  });
  const jobs = computed(() => [...taskByID().values()].map((task) => jobWiring(task, history.stored().get(task.id)) as Job));
  const jobByID = computed(() => new Map(jobs().map((job) => [job.id, job])));
  // Planning walks every minute of the days ahead, so it is done for a list of jobs and a range,
  // not each time the clock moves: from the day before today, the clock then choosing what is still ahead.
  const occurrences = computed(() => {
    const today = addDays(dateFromKey(todayKey()) || new Date(), -1);
    const from = today.getTime() > range().from.getTime() ? today : range().from;
    try {
      return planOccurrences(jobs(), from, range().to, timezone);
    } catch (error) {
      console.warn("todo calendar: planning failed", (error as Error)?.message || error);
      return [];
    }
  });
  const rowsByDate = computed(() => {
    const entries = buildCalendar({ jobs: jobs(), runs: history.runs(), occurrences: occurrences(), now: now(), timezone }) as Map<string, unknown[]>;
    const result = new Map<string, Row[]>();
    days().forEach((day) => {
      const list = entries.get(day.key);
      if (list) result.set(day.key, dayRows(list) as Row[]);
    });
    return result;
  });
  // As the clock moves, what was planned comes due and what was running ends, and the page's live
  // runs do not always show it (a run shorter than a poll): the history is read again when a
  // planned minute has passed, and at each move of the clock while a run in it is still going.
  let duePassed = -1;
  effect(() => {
    const time = now();
    untracked(() => {
      const planned = occurrences() as { time: number }[];
      let passed = 0;
      while (passed < planned.length && planned[passed].time <= time) passed += 1;
      const going = history.runs().some((run) => run.status === "running" || run.status === "queued");
      if (duePassed >= 0 && (passed !== duePassed || going)) history.reload();
      duePassed = passed;
    });
  });
  const rowsFor = (date: string) => rowsByDate().get(date) || NO_ROWS;
  const isEmpty = computed(() => !props.tasksLoading && !history.loading() && rowsByDate().size === 0);
  const strip = computed(() => repeatingJobs(jobs()) as { jobId: string; triggers: Trigger[]; after: string }[]);

  /* ---------- words ---------- */

  const weekdayLabels = () => [
    t("todo_weekday_sun"),
    t("todo_weekday_mon"),
    t("todo_weekday_tue"),
    t("todo_weekday_wed"),
    t("todo_weekday_thu"),
    t("todo_weekday_fri"),
    t("todo_weekday_sat"),
  ];
  const monthTitle = () =>
    formatDate(activeMonth(), currentLocale(), { year: "numeric", month: props.mobile ? "short" : "long" });
  const timeText = (time: number) =>
    formatDate(new Date(time), currentLocale(), { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: timezone });
  const jobTitle = (jobId: string) => {
    const task = taskByID().get(jobId);
    return task ? props.taskTitle(task) : t("todo_calendar_job_gone");
  };
  const triggerOf = (row: Row) => jobByID().get(row.jobId)?.triggers.find((trigger) => trigger.id === row.cause.triggerId);
  /** A schedule in words, as the list writes a job's ("Every weekday at 9:00 AM"). */
  const cadence = (trigger: Trigger) =>
    model.schedulePreviewText(model.normalizeTask({ at: trigger.at, cron: trigger.cron, tz: trigger.tz })) as string;
  const rowTitle = (row: Row) => (row.count > 1 ? `${jobTitle(row.jobId)} ×${row.count}` : jobTitle(row.jobId));

  /** What started a run, and how it ended when not as usual. */
  function causeText(row: Row) {
    if (row.state === "skipped") {
      const note = noteText(row.cause.note, [...taskByID().keys()], (id: string) => (taskByID().has(id) ? jobTitle(id) : "")) as string;
      return note ? t("todo_calendar_skipped_because", { note }) : t("todo_calendar_skipped");
    }
    const words: string[] = [];
    const trigger = triggerOf(row);
    switch (row.cause.kind) {
      case "schedule":
        // Several alike are named by their cadence; one run's time is beside it already.
        words.push(row.count > 1 && trigger && triggerRepeats(trigger) ? cadence(trigger) : t("todo_calendar_cause_schedule"));
        break;
      case "manual":
        words.push(t("todo_calendar_cause_manual"));
        break;
      case "poke":
        words.push(t("todo_calendar_cause_poke"));
        break;
      case "message":
        words.push(trigger?.channel ? t("todo_calendar_cause_message_on", { channel: trigger.channel }) : t("todo_calendar_cause_message"));
        break;
      case "job":
        words.push(t(row.cause.waiting ? "todo_calendar_cause_job_waiting" : "todo_calendar_cause_job", { job: jobTitle(row.cause.fromJobId) }));
        break;
    }
    // A collapsed row's time is its first run's: the last one's keeps the range readable.
    if (row.count > 1 && row.lastTime > row.time) words.push(t("todo_calendar_until", { time: timeText(row.lastTime) }));
    if (row.state === "failed") words.push(row.error ? t("todo_calendar_failed_because", { error: row.error }) : t("todo_calendar_failed"));
    if (row.state === "canceled") words.push(t("todo_calendar_canceled"));
    // A waiting run says so: its orange mark alone is not a known sign (as in the list).
    if (row.state === "queued") words.push(t("todo_run_state_queued"));
    return words.join(" · ");
  }

  // A run planned behind another has no minute of its own.
  const rowTime = (row: Row) => (row.state === "planned" && row.cause.kind === "job" ? "" : timeText(row.time));
  const tone = (row: Row): StatusState => {
    switch (row.state) {
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
  };
  const stateWord = (row: Row) =>
    row.state === "running" ? t("todo_run_state_running") : row.state === "planned" ? t("todo_calendar_planned") : "";

  function dayItems(date: string): CalendarDayItem[] {
    const rows = rowsFor(date);
    const split = date === todayKey() ? (nowIndex(rows) as number) : -1;
    const items: CalendarDayItem[] = [];
    rows.forEach((row, index) => {
      if (index === split) {
        items.push({ ...NOW_ITEM, now: t("todo_calendar_now", { time: timeText(now()) }) });
      }
      const title = rowTitle(row);
      const cause = causeText(row);
      const time = rowTime(row);
      items.push({
        key: row.key,
        now: "",
        jobId: row.jobId,
        open: taskByID().has(row.jobId),
        title,
        cause,
        danger: row.state === "failed",
        quiet: row.state === "planned" || row.state === "skipped",
        time,
        tone: tone(row),
        depth: row.depth,
        // The mark is not read out: the name says what it shows.
        label: [time, title, cause, stateWord(row)].filter(Boolean).join(", "),
      });
    });
    return items;
  }

  const dayTitle = (date: string) => {
    const day = dateFromKey(date);
    return day ? formatDate(day, currentLocale(), { weekday: "short", month: "short", day: "numeric" }) : date;
  };
  const selectedDay = computed<CalendarDayView>(() => {
    const date = selectedDate();
    const today = date === todayKey();
    return {
      date,
      title: today ? t("todo_calendar_today") : dayTitle(date),
      meta: today ? dayTitle(date) : "",
      items: date ? dayItems(date) : [],
      pending: history.loading(),
    };
  });
  // The page's state hears the long date, as before.
  const selectedDateTitle = () => {
    const date = dateFromKey(selectedDate());
    return date ? formatDate(date, currentLocale(), { year: "numeric", month: "long", day: "numeric" }) : selectedDate();
  };
  const selectedJobIDs = computed(() => [...new Set(rowsFor(selectedDate()).map((row) => row.jobId))].filter((id) => taskByID().has(id)));

  /* ---------- choosing ---------- */

  function emitDateSelection(activate: boolean) {
    props.onSelectDate?.({
      date: untracked(selectedDate),
      title: untracked(selectedDateTitle),
      task_ids: untracked(selectedJobIDs),
      activate,
    });
  }

  function selectDate(day: CalendarDay) {
    selectedDate.set(day.key);
    emitDateSelection(true);
  }

  function openJob(jobId: string) {
    const task = untracked(taskByID).get(jobId);
    if (task) props.onSelectTask?.(task);
  }

  function goToMonth(next: Date) {
    const route = untracked(currentRoute);
    void navigate(locationOf(route?.path || "/", { ...(route?.query || {}), view: "calendar", month: monthKey(next) }));
  }

  function setMonth(delta: number) {
    const month = untracked(activeMonth);
    goToMonth(new Date(month.getFullYear(), month.getMonth() + delta, 1));
  }

  function showToday() {
    const today = dateFromKey(untracked(todayKey)) || new Date();
    selectedDate.set(untracked(todayKey));
    emitDateSelection(true);
    goToMonth(today);
  }

  // A new month selects today when it shows it, else its first day.
  effect(() => {
    const key = activeMonthKey();
    untracked(() => {
      const today = todayKey();
      selectedDate.set(days().some((day) => day.key === today) ? today : `${key}-01`);
      emitDateSelection(true);
    });
  });

  // The selected day's jobs are reported again when they change.
  let lastJobs: string | null = null;
  effect(() => {
    const ids = selectedJobIDs().join("\u0000");
    untracked(() => {
      if (lastJobs !== null && lastJobs !== ids) {
        emitDateSelection(false);
      }
      lastJobs = ids;
    });
  });

  // The chosen day, in full, for the list beside the grid.
  effect(() => {
    const day = selectedDay();
    untracked(() => props.onDay?.(day));
  });

  /* ---------- the grid ---------- */

  // The grid's width tells how many marks fit beside a day's number: a row of them never wraps
  // into the cell's text, so past that many it is one mark per kind with a count.
  const gridWidth = signal(0);
  const maxMarks = () => {
    if (gridWidth() <= 0) return MAX_MARKS;
    // A cell's padding (16) and its number with the gap after it (22); a mark and its gap take 8.
    const room = gridWidth() / 7 - 16 - 22;
    return Math.max(1, Math.min(MAX_MARKS, Math.floor((room + 3) / 8)));
  };
  const cellOf = (date: string) => cellView(rowsFor(date), { folded: foldedCells(), maxMarks: maxMarks() }) as Cell;
  const windowHeight = () => windowSize().height;

  const dayLabel = (day: CalendarDay) => {
    const date = dateFromKey(day.key);
    const name = date ? formatDate(date, currentLocale(), { weekday: "long", month: "long", day: "numeric" }) : day.key;
    const label = t("todo_calendar_day_label", { date: name, count: rowsFor(day.key).length });
    return day.key === todayKey() ? `${t("todo_calendar_today")}, ${label}` : label;
  };
  const numberClass = (day: CalendarDay) =>
    day.key === todayKey() ? "font-semibold text-foreground" : day.inMonth ? "font-normal text-subtle" : "font-normal text-placeholder";
  // A day stands on a hairline; today's is the warm one. The chosen day is tinted, as a selected row.
  const dayClass = (day: CalendarDay) =>
    `border-t ${day.key === todayKey() ? "border-warn" : "border-line-soft"} ${
      day.key === selectedDate() ? "bg-selection" : "hover:bg-hover-faint"
    }`;
  const lineClass = (row: Row) =>
    row.state === "failed" ? "text-danger" : row.state === "planned" || row.state === "skipped" ? "text-muted-foreground" : "text-foreground";

  /** A day of the month on a desktop: its number, the folded marks beside it, then what differs in words. */
  const DayCell = (dayProps: { day: () => CalendarDay }) => {
    const day = () => dayProps.day();
    const cell = computed(() => cellOf(day().key));
    return (
      <View class="min-w-0 flex-1" {...parts.probe(() => `day-${day().key}`)}>
        <BaseButton
          onPress={() => selectDate(day())}
          selected={day().key === selectedDate()}
          accessibilityLabel={dayLabel(day())}
          testID={`todo-calendar-day-${day().key}`}
          // `grow`, not `flex-1`: a day is as tall as its text needs, and the week with it (a share
          // of the height alone would let a full day's lines run out of its cell).
          class={`grow gap-[5px] rounded-b-md px-2 pb-2 pt-[7px] ${dayClass(day())}`}
          style={{ transitionProperty: "colors", transitionDuration: 180 }}
        >
          <View class="mb-0.5 flex-row items-center gap-1.5">
            <View {...parts.probe(() => `number-${day().key}`)}>
              <Text class={`font-mono text-xs leading-[16.2px] ${numberClass(day())}`}>{String(day().day)}</Text>
            </View>
            {/* One line of marks, clipped rather than wrapped. */}
            <View
              class="h-[9px] flex-1 flex-row items-center justify-end gap-[3px] overflow-hidden"
              accessibilityElementsHidden
              testID={`todo-calendar-marks-${day().key}`}
              {...parts.probe(() => `marks-${day().key}`)}
            >
              <Each of={cell().marks}>
                {(mark) => (
                  <View class="flex-row items-center gap-0.5" testID={`todo-calendar-mark-${mark().tone}`}>
                    <StatusMark state={mark().tone} size={5} corner={1.5} />
                    <If when={mark().count > 0}>
                      <Text class="font-mono text-[10px] leading-[9px] text-muted-foreground">{String(mark().count)}</Text>
                    </If>
                  </View>
                )}
              </Each>
            </View>
          </View>
          <If when={cell().lines.length > 0}>
            <View class="gap-[5px]" {...parts.probe(() => `lines-${day().key}`)}>
              <Each of={cell().lines} key={(line) => line.row.key}>
                {(line) => (
                  <View class="flex-row items-center gap-1.5" style={{ paddingLeft: line().inset ? 10 : 0 }}>
                    <StatusMark state={tone(line().row)} size={6} corner={2} />
                    <Text class={`min-w-0 flex-1 text-xs leading-[16px] ${lineClass(line().row)}`} style={{ numberOfLines: 1 }}>
                      {rowTitle(line().row)}
                    </Text>
                  </View>
                )}
              </Each>
            </View>
          </If>
          <If when={cell().more > 0}>
            <Text class="pl-3 font-mono text-[11px] leading-[15.4px] text-placeholder">{t("todo_calendar_more", { count: cell().more })}</Text>
          </If>
        </BaseButton>
      </View>
    );
  };

  /** A day on a phone: its number, and under it one small mark for the usual repeats and a full one per run that differs. */
  const PhoneCell = (dayProps: { day: () => CalendarDay }) => {
    const day = () => dayProps.day();
    const marks = computed(() => phoneMarks(rowsFor(day().key)) as { tone: StatusState; small: boolean }[]);
    return (
      <View class="min-w-0 flex-1" {...parts.probe(() => `day-${day().key}`)}>
        <BaseButton
          onPress={() => selectDate(day())}
          selected={day().key === selectedDate()}
          accessibilityLabel={dayLabel(day())}
          testID={`todo-calendar-day-${day().key}`}
          class={`h-[52px] items-center gap-[5px] rounded-b-lg pt-[7px] ${dayClass(day())}`}
        >
          <Text class={`font-mono text-[13px] leading-[16px] ${numberClass(day())}`}>{String(day().day)}</Text>
          <View class="h-2 flex-row items-center gap-[3px]" accessibilityElementsHidden {...parts.probe(() => `marks-${day().key}`)}>
            <Each of={marks()}>
              {(mark) => (
                <View testID={`todo-calendar-mark-${mark().tone}${mark().small ? "-small" : ""}`}>
                  <StatusMark state={mark().tone} size={mark().small ? 4 : 6} corner={1.5} />
                </View>
              )}
            </Each>
          </View>
        </BaseButton>
      </View>
    );
  };

  // Where the grid's text starts: a cell's inset, which the head, the strip and the weekdays share.
  const INSET = 8;

  return (
    <View
      class={`flex-1 ${props.divider && !props.mobile ? "border-r border-line-soft" : ""}`}
      accessibilityLabel={t("todo_view_calendar")}
      testID="todo-calendar"
    >
      {/* The head, as the list's (TodoIndex): the title, here with the month beside it, then the
          way through months, the view toggle and, on a desktop, Add (a phone's floating button
          adds). The toggle and Add end the row as they end the list's, the same circles at the
          same height. */}
      <View
        class="flex-row items-center border-b border-transparent"
        style={{
          height: TODO_HEAD_HEIGHT,
          paddingLeft: gutterX() + (props.mobile ? 0 : INSET),
          paddingRight: gutterX(),
        }}
        {...parts.probe(() => "head")}
      >
        <Text class="text-xl font-normal leading-[24px] tracking-[-0.6px] text-foreground" role="header" style={{ numberOfLines: 1 }}>
          {t("todo_title")}
        </Text>
        <Text
          class="ml-3 min-w-0 flex-1 text-xl font-normal leading-[24px] tracking-[-0.6px] text-muted-foreground"
          style={{ numberOfLines: 1 }}
          testID="todo-calendar-month"
        >
          {monthTitle()}
        </Text>
        <View class="mr-1">
          <Button variant="plain" size="xs" label={t("todo_calendar_today")} testID="todo-calendar-today" onPress={showToday} />
        </View>
        <CircleButton icon="PhCaretLeft" iconSize={14} title={t("todo_calendar_previous")} onPress={() => setMonth(-1)} />
        <CircleButton icon="PhCaretRight" iconSize={14} title={t("todo_calendar_next")} onPress={() => setMonth(1)} />
        <TodoViewToggle calendar onPress={() => props.onShowList?.()} onPartLayout={props.onPartLayout} />
        <If when={!props.mobile}>
          <CircleButton icon="PhPlus" iconSize={BAR_ICON_SIZE} title={t("todo_action_add")} testID="todo-calendar-add" onPress={() => props.onAddTask?.()} />
        </If>
      </View>

      <View style={{ paddingHorizontal: props.mobile ? 12 : gutterX(), paddingBottom: props.mobile ? 0 : gutterY() }} class={props.mobile ? "" : "grow"}>
        {/* The repeating jobs, each named once: the cells then only mark them. A phone's cells are
            marks alone, with nothing to unfold, and its list below names every run. */}
        <If when={!props.mobile && strip().length > 0}>
          <View
            class="flex-row items-center gap-[18px] border-y border-line-soft py-[5px]"
            style={{ paddingHorizontal: INSET }}
            testID="todo-calendar-repeating"
          >
            <Text class="font-mono text-[11px] font-medium uppercase leading-[15.4px] tracking-[1.32px] text-muted-foreground">
              {t("todo_calendar_repeating")}
            </Text>
            <View class="min-w-0 flex-1 flex-row flex-wrap items-center gap-x-[18px] gap-y-1">
              <Each of={strip()} key={(item) => item.jobId}>
                {(item) => (
                  <View class="flex-row items-center gap-1.5" testID={`todo-calendar-repeating-${item().jobId}`}>
                    <StatusMark state="on" size={6} corner={2} />
                    <Text class="text-[13px] leading-[19px] text-foreground" style={{ numberOfLines: 1 }}>
                      {jobTitle(item().jobId)}
                      <Text class="text-muted-foreground">
                        {`  ${
                          item().after
                            ? t("todo_calendar_after", { job: jobTitle(item().after) })
                            : item().triggers.map(cadence).join(" · ")
                        }`}
                      </Text>
                    </Text>
                  </View>
                )}
              </Each>
            </View>
            <Button
              variant="plain"
              size="xs"
              label={foldedCells() ? t("todo_calendar_unfold") : t("todo_calendar_fold")}
              testID="todo-calendar-fold"
              onPress={() => foldedCells.set(!untracked(foldedCells))}
            />
          </View>
        </If>

        {/* Reading what ran: a hairline that moves, in room that is always there. */}
        <View class="h-0.5">
          <If when={history.loading()}>
            <LoadingLine label={t("todo_calendar_history_loading")} testID="todo-calendar-loading" />
          </If>
        </View>
        <If when={history.error()}>
          <View class="flex-row items-center gap-2 pb-1" style={{ paddingHorizontal: INSET }} testID="todo-calendar-error">
            <Text class="min-w-0 flex-1 text-xs leading-[17.4px] text-danger">{t("todo_calendar_history_error", { error: history.error() })}</Text>
            <Button variant="plain" size="xs" label={t("todo_calendar_history_retry")} testID="todo-calendar-retry" onPress={history.reload} />
          </View>
        </If>

        <View class={`flex-row ${props.mobile ? "" : "pt-3"}`} role="row">
          <Each of={weekdayLabels()}>
            {(label) => (
              <View class={`min-w-0 flex-1 ${props.mobile ? "items-center pb-1 pt-1.5" : "px-2 pb-1.5"}`}>
                <Text
                  class="font-mono text-[11px] font-medium uppercase leading-[15.4px] tracking-[1.32px] text-muted-foreground"
                  style={{ numberOfLines: 1 }}
                >
                  {label()}
                </Text>
              </View>
            )}
          </Each>
        </View>

        <If
          when={!props.tasksLoading}
          else={
            <View class="min-h-105 gap-2 pt-1" accessibilityLabel={t("todo_view_calendar")}>
              <Each of={[0, 1, 2]}>{() => <View class="h-[118px] animate-pulse rounded-(--radius) bg-muted" />}</Each>
            </View>
          }
        >
          <View
            class={`relative ${props.mobile ? "" : "grow"}`}
            style={props.mobile ? undefined : { minHeight: Math.min(720, windowHeight() - 150) }}
            onLayout={(event) => gridWidth.set(event.bounds.size.width)}
            role="grid"
          >
            <Each of={weeks()} key={(week) => week.key}>
              {(week) => (
                <View class={`flex-row ${props.mobile ? "" : "min-h-28 grow"}`}>
                  <Each of={week().days} key={(day) => day.key}>
                    {(day) => (
                      <If when={props.mobile} else={<DayCell day={day} />}>
                        <PhoneCell day={day} />
                      </If>
                    )}
                  </Each>
                </View>
              )}
            </Each>
            {/* Nothing ran and nothing is planned on these days: the note over the grid, which shows through blurred. */}
            <If when={isEmpty()}>
              <View
                class="absolute inset-0 items-center justify-center gap-[5px] bg-paper-soft p-6 backdrop-blur-[3px]"
                style={{ pointerEvents: "none" }}
              >
                <Text class="text-center text-base font-semibold text-foreground">{t("todo_calendar_empty")}</Text>
                <Text class="text-center text-base text-muted-foreground">{t("todo_calendar_empty_hint")}</Text>
              </View>
            </If>
          </View>
        </If>
      </View>

      <If when={props.mobile}>
        <View style={{ paddingHorizontal: gutterX(), paddingTop: 14 }}>
          <TodoDayList mobile day={selectedDay()} onOpen={openJob} testID="todo-calendar-agenda" />
        </View>
      </If>
    </View>
  );
}

const NO_ROWS: Row[] = [];
const NOW_ITEM: CalendarDayItem = {
  key: "now",
  now: "",
  jobId: "",
  open: false,
  title: "",
  cause: "",
  danger: false,
  quiet: false,
  time: "",
  tone: "off",
  depth: 0,
  label: "",
};
