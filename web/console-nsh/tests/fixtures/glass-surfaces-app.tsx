// A test entry for tests/glass-surfaces.test.tsx: the glass policy as the window answers it
// (lib/glass.ts), the classes and style of each surface, and bars over scrollers laid out as the
// pages lay them out (components/frame/glassBar.tsx): a bare bar over a Scroll, a Page that
// scrolls as one, an index column with a search under its head, and a phone's MobileBar over its
// own scroller. Buttons switch the glass on, off, or back to the window's own answer; the frames
// of the bars, the scrollers and the first rows are read out as JSON.
import { mount, Scroll, signal, Text, View, type JSX, type ViewRef } from "nsh";
import { IndexColumn, IndexSearch, MobileBar } from "../../components/knowledge/parts";
import { BarRoom, barRoom, glassBarClass, glassBarStyle, underBar } from "../../components/frame/glassBar";
import { Page } from "../../components/ui";
import { composerFrameClass } from "../../components/chat/composerField";
import { forceGlass, glassClass, glassEnabled, glassStyle } from "../../lib/glass";

type Frame = { x: number; y: number; w: number; h: number };
const frames = signal<Record<string, Frame>>({});
const report = (name: string, frame: Frame) => frames.update((all) => ({ ...all, [name]: frame }));
const query = signal("");

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

const ROWS = Array.from({ length: 30 }, (_, index) => index);
function Rows(props: { name: string }) {
  return (
    <Each of={ROWS}>
      {(row) => (
        <If when={row() === 0} else={<View class="h-10" />}>
          <Probe name={`${props.name}-row`} class="h-10" />
        </If>
      )}
    </Each>
  );
}

function App() {
  const layout = (name: string) => (event: { bounds: { origin: { x: number; y: number }; size: { width: number; height: number } } }) =>
    report(name, { x: event.bounds.origin.x, y: event.bounds.origin.y, w: event.bounds.size.width, h: event.bounds.size.height });
  return (
    <View class="flex-1 bg-paper">
      <View class="flex-row gap-2">
        <Text testID="glass-on" onPress={() => forceGlass(true)}>on</Text>
        <Text testID="glass-off" onPress={() => forceGlass(false)}>off</Text>
        <Text testID="glass-auto" onPress={() => forceGlass(null)}>auto</Text>
      </View>
      <View class="flex-row">
        {/* The primitives: a 57pt bar and the scroller under it, in a column 400pt tall. */}
        <View class="w-50" style={{ height: 400 }}>
          <View class={`h-[57px] ${glassBarClass()}`} style={glassBarStyle()} onLayout={layout("bare-bar")} />
          <Scroll class="flex-1" style={underBar()} onLayout={layout("bare-scroll")}>
            <BarRoom />
            <View onLayout={layout("bare-first")} class="h-10" />
            <Rows name="bare" />
          </Scroll>
        </View>
        <Probe name="page" class="w-50">
          <View style={{ height: 400 }}>
            <Page title="Page">
              <Rows name="page" />
            </Page>
          </View>
        </Probe>
        <Probe name="index" class="w-80">
          <View style={{ height: 400 }}>
            <IndexColumn
              title="Index"
              fill
              search={<IndexSearch value={query()} onChange={(value) => query.set(value)} placeholder="Search" testID="glass-search" />}
            >
              <Rows name="index" />
            </IndexColumn>
          </View>
        </Probe>
        <Probe name="detail" class="w-50">
          <View style={{ height: 400 }}>
            <MobileBar title="Detail" backLabel="Back" onBack={() => undefined} glass />
            <Scroll class="flex-1" style={underBar()}>
              <BarRoom />
              <Rows name="detail" />
            </Scroll>
          </View>
        </Probe>
      </View>
      {/* Last, so its length never moves what is measured above it. */}
      <Text testID="glass-report">
        {JSON.stringify({
          enabled: glassEnabled(),
          bar: glassClass("bar"),
          nav: glassClass("nav"),
          composer: glassClass("composer"),
          composerFrame: composerFrameClass(true, glassEnabled()),
          style: glassStyle(),
          barClass: glassBarClass(),
          room: barRoom(),
          frames: frames(),
        })}
      </Text>
    </View>
  );
}

mount(() => <App />);
