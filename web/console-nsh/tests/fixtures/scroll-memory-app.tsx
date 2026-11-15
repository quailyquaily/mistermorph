// A test entry for tests/scroll-memory.test.tsx: the page host over a route of its own, with pages
// that remember their scrollers (lib/scrollMemory.ts) as the console's pages do. A page has a
// column 2 list (a `Scroll`), a second column 2 area (a `List`), and a column 3 whose content is
// the selected item's. "rows-…" sets how long the contents are, "late" makes a page's content
// arrive 400 ms after the page, "unready" holds the page's `ready` back until "ready" is pressed.
// The readout is every area's live offset and what is remembered ("read" refreshes the latter).
import { List, mount, Scroll, signal, Text, untracked, View } from "nsh";
import { PageStack } from "../../components/frame/PageStack";
import type { PageKey, Route } from "../../lib/router";
import { currentRoute } from "../../lib/router";
import { savedScrollAreas, useScrollMemory, watchScrollAreas } from "../../lib/scrollMemory";

function routeOf(page: string, endpoint = ""): Route {
  const path = endpoint ? `/e/${endpoint}/${page}` : `/${page}`;
  return {
    path,
    fullPath: path,
    query: {},
    hash: "",
    params: endpoint ? { endpoint_ref: endpoint } : {},
    meta: endpoint ? { endpointScoped: true } : {},
    page: page as PageKey,
  };
}

const route = signal<Route>(routeOf("chat"));
const rows = signal(60);
const late = signal(false);
const gate = signal(true);
const hasDetail = signal(true);
// The selection outlives the page, as a page that reopens its last item has it.
const selected = signal("one");
const live = signal<Record<string, number>>({});
const saved = signal<Record<string, unknown>>({});

watchScrollAreas((key, y) => live.update((all) => ({ ...all, [key]: Math.round(y) })));

/** Opens a page; the live offsets start over, so what shows after is the new page's own. */
function go(next: Route) {
  live.set({});
  route.set(next);
}

const ROW = 40;

function Rows(props: { name: string; count: number }) {
  return (
    <Each of={Array.from({ length: props.count }, (_, i) => i)}>
      {(i) => (
        <Text class="text-sm text-foreground" style={{ height: ROW }}>
          {`${props.name} ${i() + 1}`}
        </Text>
      )}
    </Each>
  );
}

function FixturePage() {
  const name = untracked(() => currentRoute().page);
  // The content: there with the page, or 400 ms after it.
  const count = signal(untracked(late) ? 0 : untracked(rows));
  if (untracked(late)) setTimeout(() => count.set(untracked(rows)), 400);
  const length = () => Math.min(count(), rows());
  const list = useScrollMemory({ column: 2, area: "list", ready: () => gate() });
  const tree = useScrollMemory({ column: 2, area: "tree" });
  const detail = useScrollMemory({ column: 3, area: "detail", selection: () => selected() });
  return (
    <View class="flex-1 flex-row" testID={`fixture-page.${name}`}>
      <Scroll class="flex-1" ref={list.ref} onScroll={list.onScroll} testID="list">
        <Rows name="row" count={length()} />
      </Scroll>
      <List
        class="flex-1"
        ref={tree.ref}
        onScroll={tree.onScroll}
        each={Array.from({ length: length() }, (_, i) => i)}
        estimatedItemSize={ROW}
        testID="tree"
      >
        {(i) => (
          <Text class="text-sm text-foreground" style={{ height: ROW }}>
            {`leaf ${i() + 1}`}
          </Text>
        )}
      </List>
      <If when={hasDetail()}>
        <Scroll class="flex-1" ref={detail.ref} onScroll={detail.onScroll} testID="detail">
          <Rows name={selected()} count={length()} />
        </Scroll>
      </If>
    </View>
  );
}

const button = (id: string, onPress: () => void) => (
  <Text testID={id} class="p-1 text-xs" onPress={onPress}>
    {id}
  </Text>
);

function Fixture() {
  return (
    <View class="flex-1">
      <View class="flex-row flex-wrap">
        {button("go-chat", () => go(routeOf("chat")))}
        {button("go-todo", () => go(routeOf("todo")))}
        {button("go-agent-a", () => go(routeOf("chat", "ep_a")))}
        {button("go-agent-b", () => go(routeOf("chat", "ep_b")))}
        {button("select-one", () => selected.set("one"))}
        {button("select-two", () => selected.set("two"))}
        {button("select-none", () => selected.set(""))}
        {button("rows-60", () => rows.set(60))}
        {button("rows-20", () => rows.set(20))}
        {button("rows-5", () => rows.set(5))}
        {button("late", () => late.set(true))}
        {button("prompt", () => late.set(false))}
        {button("unready", () => gate.set(false))}
        {button("ready", () => gate.set(true))}
        {button("detail-off", () => hasDetail.set(false))}
        {button("detail-on", () => hasDetail.set(true))}
        {button("read", () => saved.set(savedScrollAreas()))}
      </View>
      <Text class="text-[6px]" testID="live">{`live=${JSON.stringify(live())}`}</Text>
      <Text class="text-[6px]" testID="saved">{`saved=${JSON.stringify(saved())}`}</Text>
      <PageStack
        keyOf={(r) => `${r.page}:${r.params.endpoint_ref ?? ""}`}
        render={() => <FixturePage />}
        stacked={() => false}
        route={() => route()}
        motionOf={() => "none"}
      />
    </View>
  );
}

mount(() => <Fixture />);
