// The conversation: a virtualized, inverted list (the newest message at the bottom, where it
// starts and stays while new messages and streamed words arrive; scrolled up, the messages on
// screen keep their place). While another topic's history loads, a placeholder thread shows
// instead of the old messages. Ported from web/console/src/components/ChatHistoryList.js.
import type { ListRef } from "nsh";
import { createMotion, effect, List, Text, untracked, View, windowSize } from "nsh";
import { createArrivalTracker } from "../../lib/core/arrivals.js";
import { SCROLLBAR } from "../motion/ScrollEdges";
import { Button } from "../ui";
import { ChatHistoryItem, type ChatRowContext, type HistoryItem } from "./ChatHistoryItem";

const ARRIVAL_WINDOW_MS = 700;

/** The room under the newest message, in points. */
export const HISTORY_END_PADDING = 20;

/** The conversation's side gutter: the Vue console's clamp(12px, 2vw, 20px). */
export function chatGutter() {
  return Math.min(20, Math.max(12, windowSize().width * 0.02));
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
}) {
  // Newest first: the list is inverted.
  const rows = () => [...props.items].reverse();
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
  return (
    <If when={!props.loading} else={<Skeleton label={props.loadingText} />}>
      <List
        ref={(node: ListRef) => props.onListRef?.(node)}
        each={rows()}
        inverted
        keyExtractor={(item) => item.id}
        // Close to a typical turn (a sent message is ~110pt, a reply 150 to 600), so the scroll bar
        // and jumps are right before rows are measured.
        estimatedItemSize={180}
        keyboardDismissMode="on-drag"
        scrollbar={SCROLLBAR}
        scrollEventThrottle={100}
        onScroll={(event) =>
          props.onScrollFromEnd?.(Math.max(0, event.contentSize.height - event.offset.y - event.size.height), event.size.height)
        }
        // There are no newer pages to load: the listener makes the inverted list keep the messages
        // on screen in place while scrolled up, and follow the newest one while at the bottom.
        onLoadMoreAtStart={() => {}}
        class="flex-1"
        // The Vue history: 20pt around the conversation and between turns. The list is inverted,
        // and so is its padding: `paddingTop` is at its start, under the newest message, and
        // `paddingBottom` above the oldest one (room for the panel toggle there).
        contentStyle={{ paddingTop: HISTORY_END_PADDING, paddingBottom: props.topInset ?? 20, paddingLeft: chatGutter(), paddingRight: chatGutter(), gap: 20 }}
        testID="chat-history"
        footer={() => (
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
        {(item) => <ChatHistoryItem item={item()} ctx={props.ctx} arriving={arriving} />}
      </List>
    </If>
  );
}
