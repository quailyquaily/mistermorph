// A test entry for tests/tab-strip.test.tsx: the shared Tabs (components/ui.tsx) in a page that
// scrolls up and down. The first strip (`strip`) has ten long options in a box 300pt wide (never
// wider than the page), and starts on its last option; the buttons above it choose its first,
// middle or last option from outside, make the box 200pt or as wide as the page, take its options
// down to two and back, and disable its fourth. The others are `equal` strips whose options fit
// equally (`equal-fit`), fit only unequally (`equal-uneven`) and do not fit (`equal-over`), and a
// strip of three short options (`short`) that fits. The page's scroll offset, the first strip's
// value and the presses that chose it are read out below them, and every strip's widths, offset
// and options' places (probeTabStrips) as JSON at the end.
import { batch, mount, Scroll, signal, Text, View } from "nsh";
import { Button } from "nsh/base";
import { probeTabStrips, Tabs, type TabStripFrame } from "../../components/ui";

const LONG = [
  "Recent places",
  "Home directory",
  "System root",
  "State directory of the agent",
  "Cache directory",
  "Projects and experiments",
  "Downloads",
  "Shared team workspace",
  "Archive from last year",
  "The very last place",
];
const ALL = LONG.map((label, index) => ({ id: `t${index}`, label, testID: `strip-t${index}` }));
const items = signal(ALL);
const value = signal("t9");
const width = signal(300);
const disabled = signal(false);
const presses = signal<string[]>([]);
const frames = signal<Record<string, TabStripFrame>>({});
const page = signal(0);
const values = signal<Record<string, string>>({ "equal-fit": "a", "equal-uneven": "a", "equal-over": "a", short: "a" });

probeTabStrips((frame) => {
  if (frame.testID) frames.update((all) => ({ ...all, [frame.testID]: frame }));
});

function choose(id: string) {
  batch(() => {
    presses.update((list) => [...list, id]);
    value.set(id);
  });
}

function Strip(props: { id: string; equal?: boolean; labels: string[]; width: number }) {
  return (
    <View style={{ width: props.width }} testID={`${props.id}-box`}>
      <Tabs
        testID={props.id}
        equal={props.equal}
        accessibilityLabel={props.id}
        items={props.labels.map((label, index) => ({ id: String.fromCharCode(97 + index), label, testID: `${props.id}-${String.fromCharCode(97 + index)}` }))}
        value={values()[props.id]}
        onChange={(id) => values.update((all) => ({ ...all, [props.id]: id }))}
      />
    </View>
  );
}

function Page() {
  return (
    <Scroll
      class="flex-1 bg-paper"
      contentClass="gap-4 p-4"
      testID="page"
      scrollEventThrottle={16}
      onScroll={(event) => page.set(event.offset.y)}
    >
      <View class="flex-row flex-wrap gap-2">
        <Button testID="before" accessibilityLabel="Before" class="h-6 px-2" onPress={() => undefined}>
          <Text>before</Text>
        </Button>
        <Button testID="pick-first" class="h-6 px-2" onPress={() => value.set("t0")}>
          <Text>first</Text>
        </Button>
        <Button testID="pick-last" class="h-6 px-2" onPress={() => value.set("t9")}>
          <Text>last</Text>
        </Button>
        <Button testID="pick-middle" class="h-6 px-2" onPress={() => value.set("t5")}>
          <Text>middle</Text>
        </Button>
        <Button testID="narrower" class="h-6 px-2" onPress={() => width.set(200)}>
          <Text>narrower</Text>
        </Button>
        <Button testID="wider" class="h-6 px-2" onPress={() => width.set(4000)}>
          <Text>wider</Text>
        </Button>
        <Button testID="fewer" class="h-6 px-2" onPress={() => items.update((list) => list.slice(0, 2))}>
          <Text>fewer</Text>
        </Button>
        <Button testID="more" class="h-6 px-2" onPress={() => items.set(ALL)}>
          <Text>more</Text>
        </Button>
        <Button testID="disable" class="h-6 px-2" onPress={() => disabled.set(true)}>
          <Text>disable</Text>
        </Button>
      </View>
      <View class="max-w-full" style={{ width: width() }} testID="strip-box">
        <Tabs
          testID="strip"
          accessibilityLabel="Places"
          items={items().map((item) => ({ ...item, disabled: disabled() && item.id === "t3" }))}
          value={value()}
          onChange={choose}
        />
      </View>
      <Strip id="equal-fit" equal labels={["One", "Two", "Six"]} width={300} />
      <Strip id="equal-uneven" equal labels={["A", "B", "A much longer label"]} width={300} />
      <Strip id="equal-over" equal labels={["A rather long label", "Another long label", "And a third one"]} width={300} />
      <Strip id="short" labels={["One", "Two", "Six"]} width={300} />
      <View style={{ height: 900 }} testID="filler" />
      <Text testID="out-page">page={String(page())}</Text>
      <Text testID="out-value">value={value()}</Text>
      <Text testID="out-presses">presses={presses().join(",")}</Text>
      <Text class="text-[6px]">{JSON.stringify(frames())}</Text>
    </Scroll>
  );
}

mount(() => <Page />);
