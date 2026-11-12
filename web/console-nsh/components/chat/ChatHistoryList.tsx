// The conversation: a virtualized list that opens at the newest message, at the bottom, and stays
// there while new messages and streamed words arrive; scrolled up, the messages on screen keep their
// place whatever changes above or below them. While another topic's history loads, a placeholder
// thread shows instead of the old messages. Ported from web/console/src/components/ChatHistoryList.js.
import type { ListRef, ViewRef } from "nsh";
import { computed, createMotion, effect, List, signal, Text, untracked, View, windowSize } from "nsh";
import { createArrivalTracker } from "../../lib/core/arrivals.js";
import { SCROLLBAR } from "../motion/ScrollEdges";
import { Button } from "../ui";
import { ChatHistoryItem, type ChatRowContext, type HistoryItem } from "./ChatHistoryItem";

const ARRIVAL_WINDOW_MS = 700;

/** The room under the newest message, in points. */
export const HISTORY_END_PADDING = 20;

/** Within this many points of the newest message's end the list follows it as it grows. */
export const HISTORY_FOLLOW_THRESHOLD = 32;

/** The conversation's side gutter: the Vue console's clamp(12px, 2vw, 20px). */
export function chatGutter() {
  // Vue --chat-history-gutter-x: clamp(12px, 2vw, 20px), and the usual 16px phone gutter at
  // 620px and under (the composer and the empty state share it, so they stay aligned).
  const width = windowSize().width;
  if (width <= 620) return 16;
  return Math.min(20, Math.max(12, width * 0.02));
}

// A question and a reply of a few lines, three times; fixed widths, so it reads as a conversation
// (the Vue console's `.chat-history-skeleton`: bubbles 38pt tall at the right, lines 10pt tall).
const SKELETON_TURNS = [
  { ask: 34, reply: [92, 86, 58] },
  { ask: 52, reply: [88, 94, 76, 40] },
  { ask: 26, reply: [84, 62] },
];

// It fades in after a beat, so a quick load shows nothing at all, and breathes while it waits.
function Skeleton(props: { label: string }) {
  const motion = createMotion({ enter: { duration: 240, keyframes: { opacity: [0, 1] } }, delay: 160 });
  return (
    <View
      class="w-full max-w-[832px] flex-1 gap-7 self-center px-5 py-5"
      style={motion.style}
      role="progressbar"
      accessibilityLabel={props.label}
      testID="chat-history-skeleton"
    >
      <Each of={SKELETON_TURNS}>
        {(turn) => (
          <View class="gap-2.5">
            <View class="mb-2 h-[38px] min-w-24 self-end rounded-lg bg-segment animate-pulse" style={{ width: `${turn().ask}%` }} />
            <Each of={turn().reply}>
              {(width) => <View class="h-2.5 rounded-[3px] bg-muted animate-pulse" style={{ width: `${width()}%` }} />}
            </Each>
          </View>
        )}
      </Each>
    </View>
  );
}

function historyID(item: HistoryItem) {
  return String(item?.id ?? "");
}

function sameIDs(a: string[], b: string[]) {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

export function ChatHistoryList(props: {
  items: HistoryItem[];
  loading: boolean;
  loadingText: string;
  emptyText: string;
  hasOlder: boolean;
  loadingOlder: boolean;
  olderLabel: string;
  onLoadOlder: () => void;
  ctx: ChatRowContext;
  onListRef?: (ref: ListRef) => void;
  /** How far the list is scrolled up from the newest message, and its height (throttled). */
  onScrollFromEnd?: (distance: number, viewport: number) => void;
  /** Room above the oldest message, for a control floating over the top corner (default 20). */
  topInset?: number;
  /** Each row's view as its cell is made, and the id it shows now (cells are recycled). For tests. */
  onRowRef?: (ref: ViewRef, id: () => string) => void;
}) {
  // nsh's List (0.4.0) tells its items apart by identity (`===`), not by `keyExtractor`. Every
  // update gives a message a new object (a streamed word, a status, a finished task's reload gives
  // them all new ones), and an item the List sees replaced loses its measured height for the
  // estimate, and with it the place the list keeps on screen: scrolled up, the view jumped. So the
  // List gets the ids (equal strings while a message only changes) and each row looks its message
  // up: a message changes in place and its row is measured again. Only new, removed or reordered
  // messages change the ids.
  const rows = computed(() => props.items.map(historyID), { equals: sameIDs });
  const byID = computed(() => new Map(props.items.map((item) => [historyID(item), item])));
  // Messages that just joined the thread animate in; history loads and topic switches do not (the
  // Vue console's arrival tracker). An id stays "arriving" for a moment longer than its motion, so
  // a row bound again by streaming text in that time does not start over.
  const arrivals = createArrivalTracker({ edge: "end" });
  let arrivingUntil = new Map<string, number>();
  effect(() => {
    if (props.loading) return;
    const ids = props.items.map((item) => String(item?.id ?? ""));
    const scope = props.ctx.topicID();
    untracked(() => {
      const now = Date.now();
      const next = new Map([...arrivingUntil].filter(([, until]) => until > now));
      for (const id of arrivals.update(ids, scope)) next.set(id, now + ARRIVAL_WINDOW_MS);
      arrivingUntil = next;
    });
  });
  const arriving = (id: string) => (arrivingUntil.get(id) ?? 0) > Date.now();
  // Whether the list follows the newest message. The list follows the end only then: nsh 0.4's
  // `maintainVisibleContentPosition` compares its old end with an offset already moved for rows
  // that changed above the viewport, so with it on, a reader scrolled up by less than an older
  // page's height (or a row above that grew) was sent to the bottom. Off, the list keeps what is on
  // screen in place; turned on again, it starts over.
  //
  // Only the reader lets go of the end: following stops when the view moves up (a wheel, a drag, a
  // scroll bar; growing content and the list's own scrolls only ever move it down), unless the old
  // offset no longer fits (the content shrank or the view grew, and the offset was clamped). It
  // starts again within the threshold of the end. A scroll report that lands as a reply grows by
  // more than the threshold (the view a moment short of the new end), or the view changing size
  // (the composer growing, a panel docking under the page), is not the reader: the list stays on
  // and goes to the end again.
  const following = signal(true);
  let list: ListRef | undefined;
  let last = { offset: 0, view: 0, content: 0 };
  return (
    <If when={!props.loading} else={<Skeleton label={props.loadingText} />}>
      <List
        ref={(node: ListRef) => {
          // Before the first frame: the conversation opens at its newest message, its end shown.
          node.scrollToEnd({ animated: false });
          following.set(true);
          list = node;
          last = { offset: 0, view: 0, content: 0 };
          props.onListRef?.(node);
        }}
        each={rows()}
        keyExtractor={(id) => id}
        // Not `inverted`: an inverted list keeps its distance from the bottom, so a reply growing
        // below the viewport (the running one, read from its start) pushed what was on screen up.
        // This list follows the end only while it is at it (or within the threshold, where a
        // return to the newest message resumes following); scrolled further up, what is on screen
        // stays where it is, whether rows above it, below it or across its bottom edge change.
        // `following` turns the following off while scrolled up (see above).
        maintainVisibleContentPosition={following() ? { autoscrollToBottomThreshold: HISTORY_FOLLOW_THRESHOLD } : undefined}
        // Close to a typical turn (a sent message is ~110pt, a reply 150 to 600), so the scroll bar
        // and jumps are right before rows are measured.
        estimatedItemSize={180}
        keyboardDismissMode="on-drag"
        scrollbar={SCROLLBAR}
        scrollEventThrottle={100}
        onScroll={(event) => {
          const distance = Math.max(0, event.contentSize.height - event.offset.y - event.size.height);
          const known = last.view > 0;
          const resized = Math.abs(event.size.height - last.view) > 0.5 || Math.abs(event.contentSize.height - last.content) > 0.5;
          const clamped = last.offset > event.contentSize.height - event.size.height + 0.5;
          const movedUp = known && !clamped && event.offset.y < last.offset - 0.5;
          if (distance <= HISTORY_FOLLOW_THRESHOLD) following.set(true);
          else if (movedUp) following.set(false);
          else if (known && resized && untracked(following)) list?.scrollToEnd({ animated: false });
          last = { offset: event.offset.y, view: event.size.height, content: event.contentSize.height };
          props.onScrollFromEnd?.(distance, event.size.height);
        }}
        class="flex-1"
        // The Vue history: 20pt around the conversation and between turns; above the oldest
        // message, room for the panel toggle.
        contentStyle={{ paddingTop: props.topInset ?? 20, paddingBottom: HISTORY_END_PADDING, paddingLeft: chatGutter(), paddingRight: chatGutter(), gap: 20 }}
        testID="chat-history"
        header={() => (
          <If when={props.hasOlder}>
            <View class="items-center py-2">
              <Button
                variant="plain"
                size="sm"
                label={props.olderLabel}
                loading={props.loadingOlder}
                onPress={props.onLoadOlder}
                testID="chat-history-load-older"
              />
            </View>
          </If>
        )}
        empty={() => (
          <View class="w-full max-w-[832px] self-center py-6">
            <Text class="text-base text-muted-foreground">{props.emptyText}</Text>
          </View>
        )}
      >
        {(id) => {
          // A cell still bound to a message just removed keeps showing it until it is bound again.
          const item = computed<HistoryItem | undefined>((previous) => byID().get(id()) ?? previous);
          return (
            <ChatHistoryItem
              item={item() as HistoryItem}
              ctx={props.ctx}
              arriving={arriving}
              rowRef={props.onRowRef ? (ref) => props.onRowRef?.(ref, id) : undefined}
            />
          );
        }}
      </List>
    </If>
  );
}
