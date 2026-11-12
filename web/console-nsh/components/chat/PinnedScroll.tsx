// A scroll area that follows its end as content arrives (a task's activity, a worker's output),
// unless the reader scrolled up. `resetKey` names what it shows: a new one pins it again (or, with
// `startPinned` false, starts it at the top until the reader scrolls to the end), since a recycled
// List row or a panel that switches entries reuses it for something else. Without `maxHeight` it
// takes the room its class gives it (`flex-1` in a panel).
//
// Only the reader lets go of the end: it stops following when the view moves up (a wheel, a drag,
// a scroll bar; arriving content and its own scrolls only ever move it down), unless the old offset
// no longer fits (the content shrank or the view grew, and the offset was clamped back), and
// follows again once the reader is back at the end. A scroll event that lands as content arrives
// (the view a moment short of the new end) keeps it following. A view that changes size while
// following goes to the end again.
import type { JSX, ScrollRef } from "nsh";
import { effect, Scroll, untracked, View } from "nsh";

export function PinnedScroll(props: {
  resetKey: string;
  class?: string;
  contentClass?: string;
  maxHeight?: number;
  startPinned?: boolean;
  testID?: string;
  /** Hears each scroll event's offset and sizes, and whether it follows the end now (tests). */
  onScrollState?: (state: { offset: number; view: number; content: number; pinned: boolean }) => void;
  children?: JSX.Element;
}) {
  let scroll: ScrollRef | undefined;
  let pinned = true;
  let contentHeight = 0;
  let viewHeight = 0;
  // The end exactly (not past it: an offset past the end is clamped back, which would read as the
  // reader scrolling up).
  const toEnd = () => scroll?.scrollTo({ y: Math.max(0, contentHeight - viewHeight), animated: false });
  // The last scroll event's offset and sizes, to tell the reader's moves from the content's.
  let last = { offset: 0, view: 0, content: 0 };
  effect(() => {
    void props.resetKey;
    pinned = untracked(() => props.startPinned !== false);
    if (pinned) toEnd();
    else scroll?.scrollTo({ y: 0, animated: false });
  });
  return (
    <Scroll
      ref={scroll}
      class={props.class}
      testID={props.testID}
      style={props.maxHeight === undefined ? undefined : { maxHeight: props.maxHeight }}
      scrollEventThrottle={50}
      onScroll={(e) => {
        const atEnd = e.offset.y + e.size.height >= e.contentSize.height - 2;
        const known = last.view > 0;
        const clamped = last.offset > e.contentSize.height - e.size.height + 0.5;
        if (atEnd) pinned = true;
        else if (known && !clamped && e.offset.y < last.offset - 0.5) pinned = false;
        last = { offset: e.offset.y, view: e.size.height, content: e.contentSize.height };
        props.onScrollState?.({ ...last, pinned });
      }}
      onLayout={(e) => {
        viewHeight = e.bounds.size.height;
        if (pinned) toEnd();
      }}
    >
      <View
        class={props.contentClass}
        onLayout={(e) => {
          contentHeight = e.bounds.size.height;
          if (pinned) toEnd();
        }}
      >
        {props.children}
      </View>
    </Scroll>
  );
}
