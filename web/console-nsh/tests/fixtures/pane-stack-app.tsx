// A test entry for tests/pane-stack.test.tsx: a page's own levels on a phone
// (components/motion/PaneStack.tsx) — a list, an item, a detail of it — with a slide driver that
// holds every slide until "finish" is pressed. The item's title clears as the page goes back to the
// list (as a page whose selection is its route does); the item pane shows it through `held`.
import { batch, mount, signal, Text, untracked, View } from "nsh";
import { createPaneStack, PANE_ARRIVAL_MS } from "../../components/motion/PaneStack";
import type { SlideDriver } from "../../components/motion/pageSlide";

const level = signal<number | null>(0);
// The stack's arrival window: none, or the console's ("arrive" mounts a new stack with it).
const arrival = signal(0);
const item = signal("");
const plays = signal<string[]>([]);
const settledCount = signal(0);
// How many times each pane's content was created: a pane going out is the same one, never a new one.
const mounts = signal<number[]>([0, 0, 0]);
function Counted(props: { at: number; children?: any }) {
  untracked(() => mounts.set(mounts().map((n, i) => (i === props.at ? n + 1 : n))));
  return <View>{props.children}</View>;
}
let waiting: (() => void)[] = [];

const driver: SlideDriver = {
  play(_motion, from, to) {
    plays.update((list) => [...list, `${from}>${to}`]);
    return new Promise<void>((resolve) => {
      waiting.push(resolve);
    });
  },
};

function finish() {
  const list = waiting;
  waiting = [];
  for (const resolve of list) resolve();
}

const button = (id: string, onPress: () => void) => (
  <Text testID={id} class="p-1" onPress={onPress}>
    {id}
  </Text>
);

function Stack() {
  const panes = createPaneStack(() => level(), { driver, arrivalMs: untracked(arrival) });
  const shownItem = panes.held(1, () => item());
  const pane = (at: number, wanted: () => boolean, body: () => any) => (
    <If when={panes.shown(at, wanted())}>
      <View
        class="flex-1"
        style={panes.style(at)}
        accessibilityElementsHidden={panes.hidden(at) || undefined}
        testID={`pane.${at}${panes.hidden(at) ? ".out" : ""}`}
      >
        <Counted at={at}>{body()}</Counted>
      </View>
    </If>
  );
  return (
    <View class="flex-1">
      <View class="flex-row flex-wrap">
        {button("open", () =>
          batch(() => {
            item.set("Item 7");
            level.set(1);
          }),
        )}
        {button("deeper", () => level.set(2))}
        {button("up", () => level.set(1))}
        {button("back", () =>
          batch(() => {
            item.set("");
            level.set(0);
          }),
        )}
        {button("wide", () => level.set(null))}
        {button("finish", finish)}
        {button("wait", () => void panes.settled().then(() => settledCount.set(settledCount() + 1)))}
        {button("arrive", () =>
          batch(() => {
            level.set(0);
            arrival.set(PANE_ARRIVAL_MS);
          }),
        )}
      </View>
      <Text testID="plays">{`plays=${plays().join(" ")}`}</Text>
      <Text testID="settled">{`settled=${settledCount()}`}</Text>
      <Text testID="mounts">{`mounts=${mounts().join(",")}`}</Text>
      <View class="flex-1 flex-row">
        {pane(0, () => level() === 0 || level() === null, () => <Text>list</Text>)}
        {pane(1, () => level() === 1 || level() === null, () => <Text>{`item=${shownItem()}`}</Text>)}
        {pane(2, () => level() === 2, () => <Text>detail</Text>)}
      </View>
    </View>
  );
}

/** A new stack each time the arrival window changes (the page arriving again). */
function Fixture() {
  return (
    <Each of={[arrival()]} key={(value) => value}>
      {() => <Stack />}
    </Each>
  );
}

mount(() => <Fixture />);
