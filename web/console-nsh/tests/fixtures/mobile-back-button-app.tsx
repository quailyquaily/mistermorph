// A test entry for tests/mobile-back-button.test.tsx: the page bars that carry a back arrow, laid
// out one under another as the pages do, beside the reference they must match, the real TODO list
// head (TodoIndex on a phone, its calendar toggle last). The bars: MobileBar (Contacts, Memories,
// Skills while an item is open), a PageBar whose leading row starts with BackButton (Chat, TODO,
// Settings, the skill store), and the same with a desktop size (Context, which keeps its 32pt arrow
// on wide windows). Each bar, each back arrow and its arrow glyph report their frames on the page;
// they are read out as JSON beside them, and presses on the arrows are counted.
import { mount, signal, Text, View, type JSX, type ViewRef } from "nsh";
import { BackButton, PageBar, PageTitle } from "../../components/ui";
import { MobileBar } from "../../components/knowledge/parts";
import { TodoIndex } from "../../components/todo/TodoIndex";
import type { PartFrame } from "../../components/shared/partProbe";
import type { TodoState, TodoTask } from "../../components/todo/todo-state";

const frames = signal<Record<string, PartFrame>>({});
const presses = signal<string[]>([]);
const report = (name: string, frame: PartFrame) => frames.update((all) => ({ ...all, [name]: frame }));
const pressed = (name: string) => () => presses.update((all) => [...all, name]);

const task = (id: string, title: string) => ({ _key: `k-${id}`, id, title, enabled: true, cron: "0 9 * * *" }) as unknown as TodoTask;
const tasks = [task("digest", "Daily digest")];

const state = {
  addTask: () => undefined,
  toggleTodoView: () => undefined,
  heartbeatDisabled: () => false,
  heartbeatIndexMeta: () => "Every 30 minutes",
  heartbeatLoading: () => false,
  heartbeatRun: () => null,
  heartbeatSelected: () => false,
  selectHeartbeat: () => undefined,
  isArrived: () => false,
  loading: () => false,
  tasks: () => tasks,
  orderedTasks: () => tasks,
  taskListDisplayTask: (item: TodoTask) => item,
  taskTitle: (item: TodoTask) => item.title,
  scheduleLabel: (item: TodoTask) => item.cron,
  taskRun: () => null,
  runStateLabel: () => "",
  selectedTaskKey: () => "",
  selectTask: () => undefined,
} as unknown as TodoState;

/** A view that reports its own frame on the page as `name`. */
function Probe(props: { name: string; children?: JSX.Element; class?: string }) {
  let node: ViewRef | undefined;
  return (
    <View
      class={props.class}
      ref={(value: ViewRef) => {
        node = value;
      }}
      onLayout={() => {
        node
          ?.measure()
          .then((m) => m && report(props.name, { x: m.pagePosition.x, y: m.pagePosition.y, w: m.bounds.size.width, h: m.bounds.size.height }))
          .catch(() => undefined);
      }}
    >
      {props.children}
    </View>
  );
}

function Page() {
  return (
    <View class="flex-1 bg-background">
      <Text class="text-[6px]">{JSON.stringify(frames())}</Text>
      <Text class="text-[6px]">{`presses:${presses().join(",")}`}</Text>
      <Probe name="mobile-bar">
        <MobileBar title="An open contact" backLabel="Contacts" onBack={pressed("mobile-bar")} onPartLayout={(part, frame) => report(`mobile-bar.${part}`, frame)} />
      </Probe>
      <Probe name="page-bar">
        <PageBar
          leading={
            <View class="flex-1 flex-row items-center gap-2">
              <BackButton title="Topics" testID="page-back" onPress={pressed("page-bar")} onPartLayout={(part, frame) => report(`page-bar.${part}`, frame)} />
              <PageTitle text="An open topic" />
            </View>
          }
        />
      </Probe>
      <Probe name="desktop-bar">
        <PageBar
          leading={
            <View class="flex-1 flex-row items-center gap-2">
              <BackButton
                title="Back to the topic"
                testID="desktop-back"
                desktopSize="xs"
                onPress={pressed("desktop-bar")}
                onPartLayout={(part, frame) => report(`desktop-bar.${part}`, frame)}
              />
              <PageTitle text="Context" />
            </View>
          }
        />
      </Probe>
      <View class="flex-1">
        <TodoIndex state={state} mobile onPartLayout={report} />
      </View>
    </View>
  );
}

mount(() => <Page />);
