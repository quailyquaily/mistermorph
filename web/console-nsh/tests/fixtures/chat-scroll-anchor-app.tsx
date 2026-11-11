// A test entry for tests/chat-scroll-anchor.test.tsx: the real conversation list (ChatHistoryList)
// with a running reply, changed the way the chat controller changes it. Every update gives the
// changed messages new objects (a streamed word, a tool step, a finished task), and a reload gives
// every message a new object under the same id (refreshHistory). The buttons stage those updates;
// `probe` writes where each row on screen is, and where the list is, into the report text.
import type { ListRef, ViewRef } from "nsh";
import { batch, mount, signal, Text, View } from "nsh";
import { createArtifactPreviews } from "../../components/chat/ArtifactPreviewCard";
import { ChatHistoryList } from "../../components/chat/ChatHistoryList";
import type { ChatRowContext, HistoryItem } from "../../components/chat/ChatHistoryItem";
import { createReceivedFiles } from "../../components/chat/ReceivedFile";
import { keyedState } from "../../components/chat/rowState";

const LINE = "The quick brown fox jumps over the lazy dog while the reply keeps arriving in pieces.";

function paragraphs(tag: string, from: number, count: number) {
  return Array.from({ length: count }, (_, i) => `${tag} paragraph ${from + i}. ${LINE} ${LINE}`).join("\n\n");
}

function turn(topic: string, n: number, replyParagraphs: number): HistoryItem[] {
  return [
    { id: `${topic}-u${n}`, role: "user", text: `${topic} question ${n}`, status: "", timeText: "10:00", taskId: `${topic}-t${n}` },
    {
      id: `${topic}-a${n}`,
      role: "agent",
      text: paragraphs(`${topic} reply ${n}`, 1, replyParagraphs),
      status: "done",
      timeText: "10:01",
      durationText: "4s",
      taskId: `${topic}-t${n}`,
    },
  ];
}

function conversation(topic: string, turns: number, running: boolean): HistoryItem[] {
  const items = Array.from({ length: turns }, (_, i) => turn(topic, i + 1, 2 + ((i * 3) % 5))).flat();
  if (!running) return items;
  const last = items[items.length - 1];
  items[items.length - 1] = { ...last, status: "running", durationText: "", text: paragraphs(`${topic} running`, 1, 14) };
  return items;
}

const topic = signal("a");
const items = signal<HistoryItem[]>(conversation("a", 8, true));
const loading = signal(false);
const hasOlder = signal(true);
const report = signal("");
let streamed = 14;
let olderPages = 0;
let seq = 0;
let list: ListRef | null = null;
const rows: { ref: ViewRef; id: () => string }[] = [];

// The controller's `patchHistoryItem`: a new object for the changed message, the others kept.
function patchLast(patch: Partial<HistoryItem>) {
  items.update((all) => all.map((item, i) => (i === all.length - 1 ? { ...item, ...patch } : item)));
}

// The controller's `scrollHistoryToBottom`: after a send or a load, the newest message at the bottom.
const stickToBottom = () => setTimeout(() => list?.scrollToEnd({ animated: false }), 0);

const actions: Record<string, () => void> = {
  // A streamed snapshot: the running reply's text, grown by two paragraphs.
  stream: () => {
    streamed += 2;
    patchLast({ text: paragraphs(`${topic()} running`, 1, streamed), awaiting: false });
  },
  // A tool step and a plan: the reply's status line and activity change.
  status: () =>
    patchLast({
      plan: { steps: [{ step: "Read the files", status: "completed" }, { step: "Write the answer", status: "in_progress" }] },
      activity: { history: [{ id: "tool-1", kind: "tool", name: "bash", status: "running", summary: "ls -la" }] },
    }),
  // The task finished: its status and time, then the reload `refreshHistory` does, which gives every
  // message a new object under the same id.
  complete: () =>
    batch(() => {
      patchLast({ status: "done", durationText: "1m2s", timeText: "10:05" });
      items.update((all) => all.map((item) => ({ ...item })));
    }),
  // An earlier reply changes height (a preview or an image laid out, a section unfolded).
  expand: () =>
    items.update((all) => all.map((item) => (item.id === `${topic()}-a2` ? { ...item, text: `${item.text}\n\n${paragraphs("expanded", 1, 6)}` } : item))),
  // A reload alone (the page shown again, another device's messages): same ids, new objects.
  refresh: () => items.update((all) => all.map((item) => ({ ...item }))),
  // A send: the question and its pending reply join the end, and the list goes to the newest.
  send: () => {
    const n = items().length;
    items.update((all) => [
      ...all,
      { id: `${topic()}-sent${n}`, role: "user", text: "One more question", status: "", timeText: "10:06", taskId: "" },
      { id: `${topic()}-pending${n}`, role: "agent", text: "Thinking...", status: "queued", awaiting: true, timeText: "", taskId: "" },
    ]);
    stickToBottom();
  },
  // An older page of the history arrives above the oldest message (`loadOlderHistory`).
  older: () => {
    olderPages += 1;
    const page = conversation(`old${olderPages}`, 3, false);
    batch(() => {
      items.update((all) => [...page, ...all]);
      hasOlder.set(olderPages < 2);
    });
  },
  // Another topic opens: its history loads (`loadHistory`) and the list starts at its newest message.
  topic: () => {
    batch(() => {
      topic.set("b");
      loading.set(true);
    });
    setTimeout(() => {
      batch(() => {
        items.set(conversation("b", 6, false));
        loading.set(false);
      });
      stickToBottom();
    }, 50);
  },
  probe: () => void probe(),
};

async function probe() {
  const listFrame = list ? await list.measure() : null;
  const top = listFrame?.pagePosition.y ?? 0;
  const height = listFrame?.bounds.size.height ?? 0;
  const out: Record<string, { y: number; h: number }> = {};
  for (const row of rows) {
    const m = await row.ref.measure();
    if (!m) continue;
    const y = m.pagePosition.y;
    const h = m.bounds.size.height;
    // Rows on screen only: recycled cells that wait out of sight are not.
    if (y + h <= top || y >= top + height) continue;
    out[row.id()] = { y: Math.round(y * 10) / 10, h: Math.round(h * 10) / 10 };
  }
  seq += 1;
  report.set(JSON.stringify({ seq, list: { y: top, h: height }, rows: out }));
}

const ctx: ChatRowContext = {
  endpointRef: () => "ep_console_local",
  topicID: () => topic(),
  copiedItemID: () => "",
  copySeq: () => 0,
  detail: () => null,
  focusReturn: () => "",
  autoPreviewItemID: () => "",
  previews: createArtifactPreviews(),
  receivedFiles: createReceivedFiles(),
  questions: keyedState(),
  elevations: keyedState(),
  folds: keyedState(),
  onCopy: () => {},
  onPreviewFile: () => {},
  onOpenDetail: () => {},
  onTimeClick: () => {},
  onApprove: () => {},
  onDeny: () => {},
  onQuestionAnswer: () => {},
  onElevationAnswer: () => {},
};

function App() {
  return (
    <View class="flex-1 bg-background">
      <View class="h-8 flex-row gap-1">
        {Object.keys(actions).map((name) => (
          <View testID={`do-${name}`} onPress={actions[name]} class="h-8 w-10 bg-muted">
            <Text class="text-[10px]">{name}</Text>
          </View>
        ))}
      </View>
      {/* A fixed height, so the report never moves the list. */}
      <View class="h-4 overflow-hidden">
        <Text testID="report" class="text-xs">
          {report()}
        </Text>
      </View>
      <View class="flex-1">
        <ChatHistoryList
          items={items()}
          loading={loading()}
          loadingText="Loading"
          emptyText="Nothing yet"
          hasOlder={hasOlder()}
          loadingOlder={false}
          olderLabel="Load older"
          onLoadOlder={() => actions.older()}
          ctx={ctx}
          onListRef={(ref) => {
            list = ref;
          }}
          onRowRef={(ref, id) => rows.push({ ref, id })}
        />
      </View>
    </View>
  );
}

mount(() => <App />);
