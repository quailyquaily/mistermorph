// A short scroll area that follows its end as content arrives (a task's activity, a worker's
// output), unless the reader scrolled up. `resetKey` names what it shows: a new one pins it again,
// since a recycled List row reuses it for another item.
import type { JSX, ScrollRef } from "nsh";
import { effect, Scroll, View } from "nsh";

export function PinnedScroll(props: { resetKey: string; class?: string; contentClass?: string; maxHeight: number; children?: JSX.Element }) {
  let scroll: ScrollRef | undefined;
  let pinned = true;
  effect(() => {
    void props.resetKey;
    pinned = true;
  });
  return (
    <Scroll
      ref={scroll}
      class={props.class}
      style={{ maxHeight: props.maxHeight }}
      scrollEventThrottle={50}
      onScroll={(e) => {
        pinned = e.offset.y + e.size.height >= e.contentSize.height - 2;
      }}
    >
      <View
        class={props.contentClass}
        onLayout={(e) => {
          if (pinned) scroll?.scrollTo({ y: e.bounds.size.height, animated: false });
        }}
      >
        {props.children}
      </View>
    </Scroll>
  );
}
