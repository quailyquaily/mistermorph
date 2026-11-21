// A test entry for tests/todo-view-toggle.test.tsx: the TODO page's two heads, the list's
// (TodoIndex) and the calendar's (TodoCalendar), as the page lays them out on a desktop (the list in
// its 310pt column, the calendar across the page) or a phone, on a stand-in page state. The view
// toggle switches between them as on the page; the frames of the toggle and its icon in the head
// shown are read out beside it.
import { batch, mount, signal, Text, View } from "nsh";
import { isMobile } from "../../lib/shell";
import { TodoIndex } from "../../components/todo/TodoIndex";
import { TodoCalendar } from "../../components/todo/TodoCalendar";
import type { PartFrame } from "../../components/shared/partProbe";
import type { TodoState, TodoTask } from "../../components/todo/todo-state";

const calendar = signal(false);
const frames = signal<Record<string, PartFrame>>({});

const show = (next: boolean) =>
  batch(() => {
    frames.set({});
    calendar.set(next);
  });

const state = {
  addTask: () => undefined,
  toggleTodoView: () => show(!calendar()),
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
  tasks: () => [],
  orderedTasks: () => [],
  taskListDisplayTask: (item: TodoTask) => item,
  taskTitle: (item: TodoTask) => item.title,
  scheduleLabel: (item: TodoTask) => item.cron,
  whenLabel: (item: TodoTask) => item.cron,
  setTodoView: () => {},
  composeText: Object.assign(() => "", { set: () => {} }),
  composeSending: () => false,
  composeTopicID: () => "",
  composeJob: async () => {},
  openComposeTopic: () => {},
  taskRun: () => null,
  runStateLabel: () => "",
  selectedTaskKey: () => null,
  selectTask: () => undefined,
} as unknown as TodoState;

function Page() {
  const report = (name: string, frame: PartFrame) => frames.update((all) => ({ ...all, [name]: frame }));
  return (
    <View class="flex-1 bg-background">
      <View class="flex-1 flex-row">
        <If
          when={calendar()}
          else={
            <View class="flex-1">
              <TodoIndex state={state} mobile={isMobile()} onPartLayout={report} />
            </View>
          }
        >
          <TodoCalendar
            mobile={isMobile()}
            tasks={[]}
            taskTitle={(task) => task.title}
            fetch={async () => ({ items: [], tasks: [] })}
            onShowList={() => show(false)}
            onPartLayout={report}
          />
        </If>
      </View>
      <Text testID="out-view">view={calendar() ? "calendar" : "list"}</Text>
      <Text class="text-[6px]">{JSON.stringify(frames())}</Text>
    </View>
  );
}

mount(() => <Page />);
