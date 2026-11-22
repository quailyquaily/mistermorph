// A test entry for tests/todo-flow.test.tsx: the Flow view (TodoFlow) on jobs the fixture holds, as
// the jobs page will mount it. The fixture is the page: it takes the view's callbacks, writes each
// down (`calls:[…]`) and, unless told not to (`hold`), changes its jobs as the page would, so the
// view gets new props. The modes along the top: `proto` (the prototype's nine jobs), `skip` (a link
// that skips a column), `forty` (40 jobs, 60 links); `replay` and `live` switch the replay of the
// last chain on and off; `busy` a save under way; `stop` ends every run (no live pulses). The
// parts' frames and what the view did on the way (`events:`) are read out beside them.
import { batch, mount, signal, Text, View } from "nsh";
import { isMobile } from "../../lib/shell";
import { probeTodoFlow, TodoFlow, type FlowJob, type FlowRunStep } from "../../components/todo/TodoFlow";
import type { PartFrame } from "../../components/shared/partProbe";

const job = (id: string, title: string, note: string, uses: string[] = [], more: Partial<FlowJob> = {}): FlowJob => ({
  id,
  title,
  note,
  enabled: true,
  running: false,
  uses: uses.map((job_id) => ({ job_id })),
  join: "all",
  ...more,
});

const PROTO: FlowJob[] = [
  job("report", "Morning report", "Weekdays 09:00 or when poked", [], { running: true }),
  job("digest", "Team digest", "Tells Slack #team", ["report"]),
  job("risk", "Risk summary", "Tells Console User", ["report"]),
  job("brief", "Weekly brief", "Tells Slack #leads", ["digest", "risk"]),
  job("peer", "Answer build questions", "When Lucy asks over Agent Link", ["report"]),
  job("notes", "Draft release notes", "Only when you start it", ["report"]),
  job("triage", "Triage family requests", "When Family group writes on Telegram"),
  job("heartbeat", "Heartbeat", "Every 30 minutes"),
  job("backup", "Check the backups", "Every day at 02:00", [], { enabled: false }),
];

/** The last chain: Risk summary failed, so Weekly brief was skipped. */
const LAST_RUN: FlowRunStep[] = [
  { job_id: "report", status: "done", note: "Today 09:00, by schedule" },
  { job_id: "digest", status: "done", note: "Finished" },
  { job_id: "risk", status: "failed", note: "Failed: the model timed out" },
  { job_id: "brief", status: "skipped", note: "Skipped: Risk summary failed" },
];

/** c uses b and, past b's column, a. */
const SKIP: FlowJob[] = [
  job("a", "Alpha", "Every hour", [], { running: true }),
  job("b", "Beta", "After Alpha", ["a"]),
  job("d", "Delta", "After Alpha", ["a"]),
  job("c", "Gamma", "After Beta", ["b", "a"]),
];

/** Forty jobs and sixty links, the same every time. */
function forty(): FlowJob[] {
  let state = 7;
  const next = () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
  const jobs = Array.from({ length: 40 }, (_, i) => job(`j${i}`, `Job number ${i}`, i % 3 ? "Every day at 09:00" : "When poked", [], { enabled: i % 9 !== 8, running: i === 0 }));
  let made = 0;
  while (made < 60) {
    const to = 1 + Math.floor(next() * 39);
    const back = next() < 0.75 ? 1 + Math.floor(next() * 6) : 1 + Math.floor(next() * to);
    const from = Math.max(0, to - back);
    if (jobs[to].uses.some((use) => use.job_id === `j${from}`)) continue;
    jobs[to].uses.push({ job_id: `j${from}` });
    // One more draw per link, so the graph stays the one the tests measured.
    next();
    made++;
  }
  return jobs;
}

const SETS = { proto: PROTO, skip: SKIP, forty: forty() };
type SetName = keyof typeof SETS;

const set = signal<SetName>("proto");
const jobs = signal<FlowJob[]>(PROTO);
const replay = signal<FlowRunStep[] | null>(null);
const busy = signal(false);
const hold = signal(false);
const calls = signal<string[]>([]);
const frames = signal<Record<string, PartFrame>>({});

/** What the view did on the way, each with the milliseconds since the one before. */
const events = signal<string[]>([]);
let lastEvent = 0;

probeTodoFlow(
  (name, frame) => frames.update((all) => ({ ...all, [name]: frame })),
  (event) => {
    const now = Date.now();
    const since = lastEvent ? now - lastEvent : 0;
    lastEvent = now;
    events.update((all) => [...all, `${event}@${since}`]);
  },
);

const call = (name: string, ...args: string[]) => calls.update((all) => [...all, `${name}(${args.join(",")})`]);
/** The page's side of an edit: the jobs with `id` changed. */
const change = (id: string, edit: (item: FlowJob) => FlowJob) => {
  if (!hold()) jobs.update((all) => all.map((item) => (item.id === id ? edit(item) : item)));
};

function Switch(props: { id: string; label: () => string; onPress: () => void }) {
  return (
    <View class="px-2 py-1" testID={props.id} onPress={() => props.onPress()}>
      <Text class="text-xs">{props.label()}</Text>
    </View>
  );
}

function Page() {
  const choose = (name: SetName) =>
    batch(() => {
      frames.set({});
      calls.set([]);
      events.set([]);
      replay.set(null);
      set.set(name);
      jobs.set(SETS[name]);
    });
  return (
    <View class="flex-1 bg-background">
      <View class="flex-row items-center">
        <Switch id="set-proto" label={() => "proto"} onPress={() => choose("proto")} />
        <Switch id="set-skip" label={() => "skip"} onPress={() => choose("skip")} />
        <Switch id="set-forty" label={() => "forty"} onPress={() => choose("forty")} />
        <Switch
          id="replay"
          label={() => "replay"}
          onPress={() =>
            batch(() => {
              events.set([]);
              replay.set([...LAST_RUN]);
            })
          }
        />
        <Switch id="live" label={() => "live"} onPress={() => replay.set(null)} />
        <Switch id="busy" label={() => `busy:${busy()}`} onPress={() => busy.set(!busy())} />
        <Switch id="hold" label={() => `hold:${hold()}`} onPress={() => hold.set(!hold())} />
        <Switch id="stop" label={() => "stop"} onPress={() => jobs.update((all) => all.map((item) => ({ ...item, running: false })))} />
        <Text class="text-xs">{`set:${set()} replay:${replay() ? "on" : "off"}`}</Text>
      </View>
      <Text class="text-[6px]" style={{ numberOfLines: 1 }}>{`calls:${JSON.stringify(calls())}`}</Text>
      <Text class="text-[6px]" style={{ numberOfLines: 1 }}>{`uses:${jobs().map((item) => `${item.id}<${item.uses.map((use) => `${use.job_id}`).join("+")}/${item.join}`).join(" ")}`}</Text>
      <Text class="text-[6px]" style={{ numberOfLines: 1 }}>{`events:${JSON.stringify(events())}`}</Text>
      <Text class="text-[6px]" style={{ numberOfLines: 1 }}>{`frames:${JSON.stringify(frames())}`}</Text>
      {/* A fresh view for each set, so every part reports its frame anew. */}
      <Each of={[set()]} key={(name) => name}>
        {() => (
          <TodoFlow
            jobs={jobs()}
            replay={replay()}
            mobile={isMobile()}
            busy={busy()}
            onOpenJob={(id) => call("open", id)}
            onAddUse={(id, used) => {
              call("add", id, used);
              change(id, (item) => ({ ...item, uses: [...item.uses, { job_id: used }] }));
            }}
            onRemoveUse={(id, used) => {
              call("remove", id, used);
              change(id, (item) => ({ ...item, uses: item.uses.filter((use) => use.job_id !== used) }));
            }}
            onSetJoin={(id, join) => {
              call("join", id, join);
              change(id, (item) => ({ ...item, join }));
            }}
          />
        )}
      </Each>
    </View>
  );
}

mount(() => <Page />);
