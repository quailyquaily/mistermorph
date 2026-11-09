// A scroll area that follows its end as content arrives (a task's activity, a worker's output),
// unless the reader scrolled up. `resetKey` names what it shows: a new one pins it again (or, with
// `startPinned` false, starts it at the top until the reader scrolls to the end), since a recycled
// List row or a panel that switches entries reuses it for something else. Without `maxHeight` it
// takes the room its class gives it (`flex-1` in a panel).
import type { JSX, ScrollRef } from "nsh";
import { effect, Scroll, untracked, View } from "nsh";

export function PinnedScroll(props: {
  resetKey: string;
  class?: string;
  contentClass?: string;
  maxHeight?: number;
  startPinned?: boolean;
  testID?: string;
  children?: JSX.Element;
}) {
  let scroll: ScrollRef | undefined;
  let pinned = true;
  let contentHeight = 0;
  effect(() => {
    void props.resetKey;
    pinned = untracked(() => props.startPinned !== false);
    scroll?.scrollTo({ y: pinned ? contentHeight : 0, animated: false });
  });
  return (
    <Scroll
      ref={scroll}
      class={props.class}
      testID={props.testID}
      style={props.maxHeight === undefined ? undefined : { maxHeight: props.maxHeight }}
      scrollEventThrottle={50}
      onScroll={(e) => {
        pinned = e.offset.y + e.size.height >= e.contentSize.height - 2;
      }}
    >
      <View
        class={props.contentClass}
        onLayout={(e) => {
          contentHeight = e.bounds.size.height;
          if (pinned) scroll?.scrollTo({ y: e.bounds.size.height, animated: false });
        }}
      >
        {props.children}
      </View>
    </Scroll>
  );
}
