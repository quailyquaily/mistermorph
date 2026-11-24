// A test entry for tests/todo-job-bar.test.tsx: the real TodoJobBar (a TODO topic's toolbar) in the
// state the buttons above it set (idle, running, starting, stopping, loading, failed, gone), with
// the presses each action got, the frames of its capsule, row, buttons and glyphs (onPartLayout),
// and the colours its looks are drawn in, in the theme shown, read out as JSON text last.
import { mount, signal, Text, token, View } from "nsh";
import { Button } from "nsh/base";
import { TodoJobBar, todoJobButtonLook } from "../../components/chat/TodoJobBar";

type Frame = { x: number; y: number; w: number; h: number };
type State = "idle" | "running" | "starting" | "stopping" | "loading" | "failed" | "gone";

/** The bar's props in each state, as ChatPage's TodoJobToolbar gives them from components/chat/todoJob.ts. */
const STATES: Record<State, { running: boolean; busy: boolean; toggleEnabled: boolean; viewEnabled: boolean; note?: string; error?: string }> = {
  idle: { running: false, busy: false, toggleEnabled: true, viewEnabled: true },
  running: { running: true, busy: false, toggleEnabled: true, viewEnabled: true },
  starting: { running: false, busy: true, toggleEnabled: false, viewEnabled: true },
  stopping: { running: true, busy: true, toggleEnabled: false, viewEnabled: true },
  loading: { running: false, busy: false, toggleEnabled: false, viewEnabled: true },
  failed: { running: false, busy: false, toggleEnabled: false, viewEnabled: true, error: "Could not load the job: store unreadable" },
  gone: { running: false, busy: false, toggleEnabled: false, viewEnabled: false, note: "The job “Daily digest” no longer exists." },
};

const state = signal<State>("idle");
const presses = signal({ start: 0, stop: 0, view: 0 });
const frames = signal<Record<string, Frame>>({});

const press = (name: "start" | "stop" | "view") => presses.update((all) => ({ ...all, [name]: all[name] + 1 }));

/** The colours of a token list, as `token()` gives them (`#rrggbbaa`). */
const colours = (names: string[]) => Object.fromEntries(names.map((name) => [name, String(token(name as "card")).toLowerCase()]));

const looks = {
  start: todoJobButtonLook("start"),
  stop: todoJobButtonLook("stop"),
  view: todoJobButtonLook("view"),
};

function Set(props: { name: State }) {
  return (
    <Button testID={`set-${props.name}`} onPress={() => state.set(props.name)}>
      <Text>{props.name}</Text>
    </Button>
  );
}

mount(() => (
  <View class="flex-1 gap-2 bg-paper p-2">
    <View class="flex-row flex-wrap gap-1">
      <Set name="idle" />
      <Set name="running" />
      <Set name="starting" />
      <Set name="stopping" />
      <Set name="loading" />
      <Set name="failed" />
      <Set name="gone" />
    </View>
    <View class="w-full items-center">
      <TodoJobBar
        running={STATES[state()].running}
        busy={STATES[state()].busy}
        toggleEnabled={STATES[state()].toggleEnabled}
        viewEnabled={STATES[state()].viewEnabled}
        note={STATES[state()].note}
        error={STATES[state()].error}
        onStart={() => press("start")}
        onStop={() => press("stop")}
        onView={() => press("view")}
        onPartLayout={(name, frame) => frames.update((all) => ({ ...all, [name]: frame }))}
      />
    </View>
    <Text>
      {JSON.stringify({
        state: state(),
        presses: presses(),
        frames: frames(),
        colours: colours(["primary", "primary-foreground", "card", "danger", "muted-foreground", "ink"]),
        icons: { start: looks.start.icon, stop: looks.stop.icon, view: looks.view.icon },
      })}
    </Text>
  </View>
));
