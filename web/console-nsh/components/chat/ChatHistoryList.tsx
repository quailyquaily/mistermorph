// The conversation: a virtualized, inverted list (the newest message at the bottom, where it
// starts and stays while new messages and streamed words arrive; scrolled up, the messages on
// screen keep their place). While another topic's history loads, a placeholder thread shows
// instead of the old messages. Ported from web/console/src/components/ChatHistoryList.js.
import type { ListRef } from "nsh";
import { List, Text, View } from "nsh";
import { Button } from "../ui";
import { ChatHistoryItem, type ChatRowContext, type HistoryItem } from "./ChatHistoryItem";

// A question and a reply of a few lines, three times; fixed widths, so it reads as a conversation.
const SKELETON_TURNS = [
  { ask: 34, reply: [92, 86, 58] },
  { ask: 52, reply: [88, 94, 76, 40] },
  { ask: 26, reply: [84, 62] },
];

function Skeleton(props: { label: string }) {
  return (
    <View class="w-full max-w-3xl flex-1 gap-8 self-center px-5 py-6" role="progressbar" accessibilityLabel={props.label} testID="chat-history-skeleton">
      <Each of={SKELETON_TURNS}>
        {(turn) => (
          <View class="gap-2.5">
            <View class="h-8 self-end rounded-(--radius) bg-muted" style={{ width: `${turn().ask}%` }} />
            <Each of={turn().reply}>{(width) => <View class="h-3 rounded-(--radius) bg-muted" style={{ width: `${width()}%` }} />}</Each>
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
}) {
  // Newest first: the list is inverted.
  const rows = () => [...props.items].reverse();
  return (
    <If when={!props.loading} else={<Skeleton label={props.loadingText} />}>
      <List
        ref={(node: ListRef) => props.onListRef?.(node)}
        each={rows()}
        inverted
        keyExtractor={(item) => item.id}
        estimatedItemSize={96}
        keyboardDismissMode="on-drag"
        // There are no newer pages to load: the listener makes the inverted list keep the messages
        // on screen in place while scrolled up, and follow the newest one while at the bottom.
        onLoadMoreAtStart={() => {}}
        class="flex-1"
        contentStyle={{ paddingTop: 12, paddingBottom: 12 }}
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
          <View class="w-full max-w-3xl self-center px-5 py-6">
            <Text class="text-sm text-muted-foreground">{props.emptyText}</Text>
          </View>
        )}
      >
        {(item) => <ChatHistoryItem item={item()} ctx={props.ctx} />}
      </List>
    </If>
  );
}
