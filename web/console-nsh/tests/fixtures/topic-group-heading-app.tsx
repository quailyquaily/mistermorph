// A test entry for tests/topic-group-heading.test.tsx: a foldable topic group's heading as the
// topic list draws it (TOPIC_GROUP_TOGGLE_CLASS), open and folded, with its caret, tag icon, label,
// count and hairline, and the frames they lay out at, read out beside them.
import { mount, signal, Text, View } from "nsh";
import { Icon } from "../../components/ui";
import { TOPIC_GROUP_TOGGLE_CLASS } from "../../pages/chat/TopicSidebar";

type Frame = { x: number; y: number; w: number; h: number };
type LayoutEvent = { bounds: { origin: { x: number; y: number }; size: { width: number; height: number } } };

const frames = signal<Record<string, Frame>>({});

function track(name: string) {
  return (event: LayoutEvent) => {
    const { origin, size } = event.bounds;
    frames.update((all) => ({ ...all, [name]: { x: origin.x, y: origin.y, w: size.width, h: size.height } }));
  };
}

const LABEL = "font-mono text-[11px] font-medium leading-[15.4px] text-muted-foreground line-clamp-1 tracking-[0.02em]";
const COUNT = "font-mono text-[11px] leading-[15.4px] text-muted-foreground";

function Heading(props: { name: string; collapsed: boolean }) {
  return (
    <View class={TOPIC_GROUP_TOGGLE_CLASS} onLayout={track(`${props.name}-toggle`)} testID={`heading-${props.name}`}>
      <View onLayout={track(`${props.name}-caret`)}>
        <Icon name={props.collapsed ? "PhCaretRight" : "PhCaretDown"} size={11} color="muted-foreground" />
      </View>
      <View onLayout={track(`${props.name}-tag`)}>
        <Icon name="PhTag" size={12} color="muted-foreground" />
      </View>
      <View onLayout={track(`${props.name}-label`)}>
        <Text class={LABEL}>food</Text>
      </View>
      {props.collapsed ? (
        <View onLayout={track(`${props.name}-count`)}>
          <Text class={COUNT}>3</Text>
        </View>
      ) : null}
      <View class="h-px flex-1 bg-linear-to-r from-line-soft to-transparent" onLayout={track(`${props.name}-hairline`)} />
    </View>
  );
}

function Gallery() {
  return (
    <View class="w-[314px] bg-sidebar px-4">
      <Heading name="open" collapsed={false} />
      <Heading name="folded" collapsed={true} />
      <Text>{JSON.stringify(frames())}</Text>
    </View>
  );
}

mount(() => <Gallery />);
