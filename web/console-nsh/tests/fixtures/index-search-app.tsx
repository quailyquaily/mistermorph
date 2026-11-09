// A test entry for tests/index-search.test.tsx: an index column with the shared index search under
// its head, as Contacts draws it (a phone's full width below the mobile breakpoint), with the frames
// the search box and the list below it lay out at and the search's metrics read out beside them.
import { mount, signal, Text, View } from "nsh";
import { IndexColumn, IndexSearch, indexSearchMetrics } from "../../components/knowledge/parts";
import { isMobile } from "../../lib/shell";

type Frame = { x: number; y: number; w: number; h: number };
type LayoutEvent = { bounds: { origin: { x: number; y: number }; size: { width: number; height: number } } };

const frames = signal<Record<string, Frame>>({});
const query = signal("");

function track(name: string) {
  return (event: LayoutEvent) => {
    const { origin, size } = event.bounds;
    frames.update((all) => ({ ...all, [name]: { x: origin.x, y: origin.y, w: size.width, h: size.height } }));
  };
}

function Gallery() {
  return (
    <View class="flex-1 flex-row">
      <View onLayout={track("column")} class={isMobile() ? "flex-1" : ""}>
        <IndexColumn
          title="Contacts"
          fill={isMobile()}
          scroll={false}
          search={
            <View onLayout={track("search")}>
              <IndexSearch value={query()} onChange={(value) => query.set(value)} placeholder="Quick filter" testID="fixture-search" />
            </View>
          }
        >
          <View class="flex-1" />
        </IndexColumn>
      </View>
      <View class="absolute bottom-0 left-0">
        <Text>{JSON.stringify({ frames: frames(), metrics: indexSearchMetrics(isMobile()) })}</Text>
      </View>
    </View>
  );
}

mount(() => <Gallery />);
