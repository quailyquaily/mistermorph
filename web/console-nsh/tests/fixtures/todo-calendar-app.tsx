// A test entry for tests/todo-calendar.test.tsx: the job calendar (TodoCalendar) with the day's
// list beside it on a desktop (TodoDayList, as the page draws it) or under it on a phone, on a
// clock that stands still (Monday, 23 November 2026, 09:02 UTC) and a runtime
// made here: five jobs and a month of recorded runs.
//
// The jobs: Morning report (weekdays at 9:00), Team digest (after each Morning report), Sweep
// (every 30 minutes), Backup (two schedules: daily at 6:00, Saturdays at 18:00) and Release notes
// (a poke only). What ran is in `RUNS` below.
//
// Controls (test IDs): `fx-hold` keeps the answers to history requests back until `fx-release`
// (the oldest one held) or `fx-release-last`; `fx-fail` makes the next history request fail;
// `fx-live` changes the live runs (a run of Release notes starts); `fx-next` shows December;
// `fx-none` leaves no repeating job; `fx-later` moves the clock to 09:31. Read out as text:
// `sel=<date>`, `open=<job>`, `history=<n>` (requests so far), `range=<from>..<to>` (the last
// one's), `held=<n>`, and the frames of the calendar's parts as JSON.
import { batch, mount, signal, Text, View } from "nsh";
import { isMobile } from "../../lib/shell";
import { TodoCalendar } from "../../components/todo/TodoCalendar";
import { type CalendarDayView, TodoDayList } from "../../components/todo/TodoDayList";
import type { PartFrame } from "../../components/shared/partProbe";
import type { TodoTask } from "../../components/todo/todo-state";

// Headless runs resolve the display time zone (Intl) to UTC, so the fixture's times are UTC's.
const at = (day: number, hour: number, minute = 0, month = 10) => new Date(Date.UTC(2026, month, day, hour, minute));
const now = signal(at(23, 9, 2).getTime());

const task = (id: string, title: string, extra: Record<string, unknown> = {}) =>
  ({ _key: `k-${id}`, id, title, enabled: true, at: "", cron: "", tz: "", ...extra }) as unknown as TodoTask;
const schedule = (id: string, cron: string) => ({ id, kind: "schedule", cron });
const TASKS = [
  task("report", "Morning report", { cron: "0 9 * * 1-5" }),
  task("digest", "Team digest", { triggers: [], uses: [{ job_id: "report" }] }),
  task("sweep", "Sweep", { cron: "*/30 * * * *" }),
  task("backup", "Backup", { triggers: [schedule("trg-daily", "0 6 * * *"), schedule("trg-sat", "0 18 * * 6")] }),
  task("notes", "Release notes", { triggers: [{ id: "trg-poke", kind: "poke" }] }),
];
const QUIET_TASKS = [TASKS[4]];

let serial = 0;
function run(job: string, status: string, when: Date, cause: Record<string, string> = {}, error = "") {
  serial += 1;
  const id = cause.run_id || `run-${serial}`;
  return {
    run_id: id,
    job_id: job,
    status,
    queued_at: when.toISOString(),
    error,
    cause: { kind: "schedule", trigger_id: "trg-schedule", from_job_id: "", origin_run_id: id, note: "", ...cause, run_id: undefined },
  };
}
const after = (origin: string, note = "") => ({ kind: "job", trigger_id: "", from_job_id: "report", origin_run_id: origin, note });
const RUNS = [
  // Tuesday the 17th: the usual morning, then the report again by hand, with its digest.
  run("backup", "done", at(17, 6), { trigger_id: "trg-daily" }),
  run("report", "done", at(17, 9), { run_id: "r17" }),
  run("digest", "done", at(17, 9, 1), after("r17")),
  run("report", "done", at(17, 14, 10), { run_id: "m17", kind: "manual", trigger_id: "" }),
  run("digest", "done", at(17, 14, 11), after("m17")),
  // Thursday the 19th: the report failed, so its digest was skipped.
  run("backup", "done", at(19, 6), { trigger_id: "trg-daily" }),
  run("report", "failed", at(19, 9), { run_id: "r19" }, "the model timed out"),
  run("digest", "skipped", at(19, 9), after("r19", "input job report failed")),
  // Friday the 20th: Sweep ran all day.
  ...Array.from({ length: 48 }, (_, index) => run("sweep", "done", at(20, 0, index * 30))),
  // Sunday the 22nd: a poke.
  run("notes", "done", at(22, 17, 42), { kind: "poke", trigger_id: "trg-poke" }),
  // Today: Sweep so far, Backup, and the report running.
  ...Array.from({ length: 19 }, (_, index) => run("sweep", "done", at(23, 0, index * 30))),
  run("backup", "done", at(23, 6), { trigger_id: "trg-daily" }),
  run("report", "running", at(23, 9), { run_id: "r23" }),
];
const LIVE_RUN = run("notes", "queued", at(23, 9, 1), { kind: "manual", trigger_id: "" });

const frames = signal<Record<string, PartFrame>>({});
const selected = signal("");
const opened = signal("");
const day = signal<CalendarDayView | null>(null);
const month = signal("2026-11");
const live = signal(false);
const quiet = signal(false);
const hold = signal(false);
const failNext = signal(false);
const requests = signal(0);
const lastRange = signal("");
const held = signal<(() => void)[]>([]);

function answer(pathname: string) {
  const query = new URLSearchParams(pathname.split("?")[1] || "");
  const from = Date.parse(query.get("from") || "");
  const to = Date.parse(query.get("to") || "");
  const all = live() ? [...RUNS, LIVE_RUN] : RUNS;
  const items = all
    .filter((item) => Date.parse(item.queued_at) >= from && Date.parse(item.queued_at) < to)
    .sort((left, right) => Date.parse(right.queued_at) - Date.parse(left.queued_at));
  return { items, limit: 500 };
}

async function fetch(pathname: string) {
  if (!pathname.startsWith("/todo/runs/history")) return { tasks: [] };
  const query = new URLSearchParams(pathname.split("?")[1] || "");
  batch(() => {
    requests.update((count) => count + 1);
    lastRange.set(`${String(query.get("from")).slice(0, 10)}..${String(query.get("to")).slice(0, 10)}`);
  });
  if (failNext()) {
    failNext.set(false);
    throw new Error("the runtime is away");
  }
  if (hold()) {
    await new Promise<void>((resolve) => held.update((list) => [...list, resolve]));
  }
  return answer(pathname);
}

function release(last: boolean) {
  const list = held();
  const resolve = last ? list[list.length - 1] : list[0];
  if (!resolve) return;
  held.set(list.filter((item) => item !== resolve));
  resolve();
}

// The parts the tests measure: the head, and a few days' cells.
const MEASURED = /^(head|view-tab-calendar|view-tab-calendar-icon|(day|number|marks|lines)-2026-11-(17|19|23|24))$/;

function Control(props: { id: string; onPress: () => void }) {
  return (
    <View class="px-1" testID={props.id} onPress={props.onPress}>
      <Text class="text-[6px]">{props.id}</Text>
    </View>
  );
}

function Page() {
  const report = (name: string, frame: PartFrame) => {
    if (MEASURED.test(name)) frames.update((all) => ({ ...all, [name]: frame }));
  };
  return (
    <View class="flex-1 bg-paper">
      <View class="flex-1 flex-row gap-1">
        <View class={isMobile() ? "flex-1" : "flex-[1.45]"}>
          <TodoCalendar
            mobile={isMobile()}
            tasks={quiet() ? QUIET_TASKS : TASKS}
            taskTitle={(item) => item.title}
            liveKey={live() ? "notes:queued" : ""}
            divider
            now={now}
            month={month()}
            fetch={fetch}
            onSelectDate={(selection) => selected.set(selection.date)}
            onSelectTask={(item) => opened.set(item.id)}
            onDay={(view) => day.set(view)}
            onPartLayout={report}
          />
        </View>
        <If when={!isMobile()}>
          <View class="min-w-90 flex-[0.55] p-2">
            <TodoDayList day={day()} onOpen={(id) => opened.set(id)} />
          </View>
        </If>
      </View>
      <View class="flex-row">
        <Control id="fx-hold" onPress={() => hold.set(true)} />
        <Control id="fx-release" onPress={() => release(false)} />
        <Control id="fx-release-last" onPress={() => release(true)} />
        <Control id="fx-flow" onPress={() => hold.set(false)} />
        <Control id="fx-fail" onPress={() => failNext.set(true)} />
        <Control id="fx-live" onPress={() => live.set(true)} />
        <Control id="fx-next" onPress={() => month.set("2026-12")} />
        <Control id="fx-none" onPress={() => quiet.set(true)} />
        <Control id="fx-later" onPress={() => now.set(at(23, 9, 31).getTime())} />
      </View>
      <Text class="text-[6px]">{`sel=${selected()}`}</Text>
      <Text class="text-[6px]">{`open=${opened()}`}</Text>
      <Text class="text-[6px]">{`history=${requests()}`}</Text>
      <Text class="text-[6px]">{`range=${lastRange()}`}</Text>
      <Text class="text-[6px]">{`held=${held().length}`}</Text>
      <Text class="text-[6px]">{JSON.stringify(frames())}</Text>
    </View>
  );
}

mount(() => <Page />);
