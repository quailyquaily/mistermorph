// A test entry for tests/list-title-size.test.tsx: the second column's rows as the pages draw them
// (IndexRow with and without a meta line, a topic's fading title), each with a short and a long
// title, in a column as wide as the window (a phone) or the desktop's 310pt index, and the frames
// they lay out at read out beside them.
import { mount, signal, Text, View } from "nsh";
import { IndexRow } from "../../components/knowledge/parts";
import { FadeText } from "../../components/motion/FadeText";
import { topicTitleClass } from "../../pages/chat/TopicSidebar";
import { isMobile } from "../../lib/shell";

type Frame = { x: number; y: number; w: number; h: number };
type LayoutEvent = { bounds: { origin: { x: number; y: number }; size: { width: number; height: number } } };

const frames = signal<Record<string, Frame>>({});

function track(name: string) {
  return (event: LayoutEvent) => {
    const { origin, size } = event.bounds;
    frames.update((all) => ({ ...all, [name]: { x: origin.x, y: origin.y, w: size.width, h: size.height } }));
  };
}

const SHORT = "Alice";
const LONG = "A contact with a very long display name that will not fit on two lines of a phone's list at all";
const META = "Telegram · @alice_with_a_rather_long_handle_that_runs_past_the_edge";

function Gallery() {
  return (
    <View class={isMobile() ? "flex-1" : "w-[310px]"} onLayout={track("column")}>
      <IndexRow title={SHORT} meta={META} metaFade onPress={() => {}} onLayout={track("meta-short")} />
      <IndexRow title={LONG} meta={META} metaFade onPress={() => {}} onLayout={track("meta-long")} />
      <IndexRow title={SHORT} icon="PhClockCounterClockwise" onPress={() => {}} onLayout={track("plain-short")} />
      <IndexRow title={LONG} icon="PhClockCounterClockwise" onPress={() => {}} onLayout={track("plain-long")} />
      <View class="flex-row px-3" onLayout={track("topic-short-row")}>
        <View class="flex-1" onLayout={track("topic-short")}>
          <FadeText text={SHORT} class={topicTitleClass(isMobile())} noTooltip />
        </View>
      </View>
      <View class="flex-row px-3" onLayout={track("topic-long-row")}>
        <View class="flex-1" onLayout={track("topic-long")}>
          <FadeText text={LONG} class={topicTitleClass(isMobile())} noTooltip />
        </View>
      </View>
      <Text>{JSON.stringify(frames())}</Text>
    </View>
  );
}

mount(() => <Gallery />);
