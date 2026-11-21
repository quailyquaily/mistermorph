// A test entry for tests/todo-marker-alignment.test.tsx: the real TODO list (TodoIndex) on a
// stand-in page state, as the TODO page lays it out (the whole page, on a desktop as on a phone), with Heartbeat and items in every marker state (on, off, queued, running) and long
// titles. The frames its head's last button, markers and titles lie at are read out beside it. The
// modes along the top: `list` and `empty` (no items yet: the add row in their place). `adds:N`
// counts the presses of Add (the head's button or the empty list's add row).
import { batch, mount, signal, Text, View } from "nsh";
import { isMobile } from "../../lib/shell";
import { TodoIndex } from "../../components/todo/TodoIndex";
import type { PartFrame } from "../../components/shared/partProbe";
import type { TodoRun, TodoState, TodoTask } from "../../components/todo/todo-state";

type Mode = "list" | "empty";

const mode = signal<Mode>("list");
const frames = signal<Record<string, PartFrame>>({});
const adds = signal(0);

const LONG = "A very long TODO item title that runs well past the width of the list so it has to wrap and clamp at two lines";
const task = (id: string, title: string, enabled = true) =>
  ({ _key: `k-${id}`, id, title, enabled, cron: "0 9 * * *" }) as unknown as TodoTask;
const tasks = [task("running", LONG), task("queued", "Queued behind the weekly report"), task("on", "Daily digest"), task("off", LONG, false)];
const runs: Record<string, TodoRun> = {
  running: { state: "running", manual: false, startedAt: "", runID: "run-running", stopping: false },
  queued: { state: "queued", manual: false, startedAt: "", runID: "run-queued", stopping: false },
};
const empty = () => mode() === "empty";

const state = {
  addTask: () => adds.update((count) => count + 1),
  toggleTodoView: () => undefined,
  heartbeatDisabled: () => false,
  heartbeatIndexMeta: () => "Every 30 minutes",
  heartbeatLoading: () => false,
  placeholderRows: () => false,
  tasksPending: () => false,
  heartbeatRun: () => null,
  heartbeatSelected: () => false,
  selectHeartbeat: () => undefined,
  isArrived: () => false,
  loading: () => false,
  tasks: () => (empty() ? [] : tasks),
  orderedTasks: () => (empty() ? [] : tasks),
  taskListDisplayTask: (item: TodoTask) => item,
  taskTitle: (item: TodoTask) => item.title,
  scheduleLabel: (item: TodoTask) => item.cron,
  taskRun: (item: TodoTask) => runs[item.id] ?? null,
  runStateLabel: (run: TodoRun | null) => (run ? run.state : ""),
  selectedTaskKey: () => "k-on",
  selectTask: () => undefined,
} as unknown as TodoState;

function ModeButton(props: { mode: Mode }) {
  return (
    <View
      class="px-2 py-1"
      testID={`mode-${props.mode}`}
      onPress={() =>
        batch(() => {
          frames.set({});
          mode.set(props.mode);
        })
      }
    >
      <Text class="text-xs">{props.mode}</Text>
    </View>
  );
}

function Index() {
  const report = (name: string, frame: PartFrame) => frames.update((all) => ({ ...all, [name]: frame }));
  return (
    <View class="flex-1">
      <TodoIndex state={state} mobile={isMobile()} onPartLayout={report} />
    </View>
  );
}

function Page() {
  return (
    <View class="flex-1 bg-background">
      <View class="flex-row items-center">
        <ModeButton mode="list" />
        <ModeButton mode="empty" />
        <Text class="text-xs">{mode()}</Text>
        <Text class="text-xs">{`adds:${adds()}`}</Text>
      </View>
      <Text class="text-[6px]">{JSON.stringify(frames())}</Text>
      <View class="flex-1 flex-row gap-1">
        {/* A fresh list for each mode, so every part reports its frame anew. */}
        <If when={mode() === "list"} else={<Index />}>
          <Index />
        </If>
        <If when={!isMobile()}>
          <View class="flex-1" />
        </If>
      </View>
    </View>
  );
}

mount(() => <Page />);
