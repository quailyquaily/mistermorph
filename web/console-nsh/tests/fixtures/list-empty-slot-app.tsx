// A test entry for tests/list-empty-slot.test.tsx: two Lists over one loading flag, the first with a
// function `empty` slot, the second with an element its own component made (as Contacts' phone
// index does). Each slot's view reads the flag; a read after its list went away counts as stale.
// "report" puts the counts on screen as JSON.
import { cleanup, List, mount, signal, Text, View } from "nsh";
import { Button } from "nsh/base";

const ROWS = Array.from({ length: 12 }, (_, i) => ({ id: `r${i}` }));
const shown = signal(true);
const loading = signal(false);
const report = signal("{}");
const stale = { fn: 0, element: 0 };
let lists = 0;

function Slot(props: { name: "fn" | "element"; alive: () => boolean }) {
  const loadingNow = () => {
    const now = loading();
    if (!props.alive()) stale[props.name] += 1;
    return now;
  };
  return (
    <If when={loadingNow()} else={<Text testID={`${props.name}-empty`}>nothing</Text>}>
      <Text testID={`${props.name}-loading`}>loading</Text>
    </If>
  );
}

function SlotList(props: { name: "fn" | "element" }) {
  lists += 1;
  let alive = true;
  cleanup(() => {
    alive = false;
  });
  const element = props.name === "element" ? <Slot name="element" alive={() => alive} /> : null;
  return (
    <List
      empty={props.name === "element" ? element : () => <Slot name="fn" alive={() => alive} />}
      each={loading() ? [] : ROWS}
      keyExtractor={(row) => row.id}
      estimatedItemSize={24}
      class="flex-1"
      testID={`${props.name}-list`}
    >
      {(row) => <Text testID={`${props.name}-row-${row().id}`}>{row().id}</Text>}
    </List>
  );
}

function App() {
  return (
    <View class="flex-1">
      <View class="flex-row">
        <Button testID="mount" onPress={() => shown.set(true)}><Text>mount</Text></Button>
        <Button testID="unmount" onPress={() => shown.set(false)}><Text>unmount</Text></Button>
        <Button testID="load" onPress={() => loading.set(true)}><Text>load</Text></Button>
        <Button testID="loaded" onPress={() => loading.set(false)}><Text>loaded</Text></Button>
        <Button testID="report" onPress={() => report.set(JSON.stringify({ ...stale, lists }))}><Text>report</Text></Button>
      </View>
      <Text>{report()}</Text>
      <If when={shown()}>
        <View class="flex-1 flex-row">
          <SlotList name="fn" />
          <SlotList name="element" />
        </View>
      </If>
    </View>
  );
}

mount(App);
