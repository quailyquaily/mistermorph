// A test entry for tests/chat-topics-older.test.tsx: the real TopicSidebar on a stand-in controller
// whose older page the test settles (FT173): a press asks for it (counted) and it stays on its way
// until a switch lands it (its topics above the last row, in the pinned group, or after it) or
// fails it. The topic list's frames (`onPartLayout`), its scroll offset (lib/scrollMemory.ts) and
// the asks are read out under the switches. The sidebar is a desktop one at desktop widths and the
// phone's page at phone widths, as in the console.
import { batch, mount, signal, Text, View } from "nsh";
import { TopicSidebar, type TopicPartFrame } from "../../pages/chat/TopicSidebar";
import type { ChatController, TopicRow } from "../../pages/chat/chatController";
import { watchScrollAreas } from "../../lib/scrollMemory";
import { isMobile } from "../../lib/shell";

type Topic = { id: string; title: string };
const pinned = signal<Topic[]>([{ id: "p1", title: "Pinned plans" }]);
const today = signal<Topic[]>(Array.from({ length: 16 }, (_, i) => ({ id: `t${i + 1}`, title: `Topic ${i + 1}` })));
const older = signal<Topic[]>([]);
const cursor = signal("c2");
const loading = signal(false);
const error = signal("");
const refreshing = signal(false);
const asks = signal(0);
const offset = signal(0);
const frames = signal<Record<string, TopicPartFrame>>({});
let settle: ((landed: boolean) => void) | null = null;
let page = 0;

const group = (key: string, label: string, topics: Topic[]): TopicRow[] =>
  topics.length === 0
    ? []
    : [
        { kind: "group", key: `group:${key}`, group: { key, label, topics }, collapsible: false, collapsed: false },
        ...topics.map((topic) => ({ kind: "topic" as const, key: `topic:${key}:${topic.id}`, topic, group: { key } })),
      ];
const rows = () => [...group("pinned", "Pinned", pinned()), ...group("today", "Today", today()), ...group("older", "Older", older())];

const c = {
  agentTopics: () => [],
  clickTopicSidebarTitle: () => {},
  cronRunning: () => 0,
  cronToggleLabel: () => "Job runs",
  cronToggleTitle: () => "Job runs",
  cronTopicModel: () => "",
  isCronTopicID: () => false,
  isSoloTopicID: (id: any) => String(id ?? "").trim() === "_solo",
  topicStartedFromSolo: (topic: any) => topic?.started_from === "_solo",
  loadOlderTopics: () => {
    asks.set(asks() + 1);
    loading.set(true);
    error.set("");
    return new Promise<boolean>((resolve) => {
      settle = resolve;
    });
  },
  mobileMode: () => isMobile(),
  mobileTopicSplitEnabled: () => false,
  selectTopic: () => {},
  setTopicSearch: () => {},
  setTopicSidebarView: () => {},
  startNewTopic: () => {},
  submitEndpointRef: () => "",
  toggleTopicGroup: () => {},
  topicActivityLabel: () => "",
  topicActivityState: () => "",
  topicAgentAvatar: () => "",
  topicAgentContact: () => null,
  topicIcon: () => "",
  topicIsActive: () => false,
  topicTagSaving: () => false,
  topicRows: () => rows(),
  topicSearch: () => "",
  topicSearchRevealed: signal(false),
  topicSidebarView: () => "date",
  topicsLoading: () => refreshing(),
  topicsFromLastTime: () => false,
  topicsLoadingOlder: () => loading(),
  topicsOlderError: () => error(),
  topicsLoadError: () => "",
  topicsLoadErrorInSidebar: () => false,
  chatLoadBusy: () => false,
  retryChatLoad: async () => undefined,
  topicsNextCursor: () => cursor(),
  topicTimeLabel: () => "",
  topicTitle: (topic: any) => String(topic?.title || ""),
} as unknown as ChatController;

/** Settles the page on its way: `where` its three topics go, `last` when no older page is left after it. */
function land(where: "top" | "end", last: boolean) {
  const done = settle;
  if (!done) return;
  settle = null;
  page += 1;
  const topics = [1, 2, 3].map((n) => ({ id: `o${page}-${n}`, title: `Older ${page}.${n}` }));
  batch(() => {
    if (where === "top") pinned.set([...pinned(), ...topics]);
    else older.set([...older(), ...topics]);
    cursor.set(last ? "" : `c${page + 2}`);
    loading.set(false);
  });
  done(true);
}

function fail() {
  const done = settle;
  if (!done) return;
  settle = null;
  batch(() => {
    error.set("topic store unavailable");
    loading.set(false);
  });
  done(false);
}

watchScrollAreas((key, y) => {
  if (key.endsWith("|topics")) offset.set(Math.round(y));
});

function Switch(props: { id: string; onPress: () => void }) {
  return (
    <View onPress={() => props.onPress()} testID={props.id} focusable={false} class="h-6 px-1">
      <Text class="text-[10px]">{props.id}</Text>
    </View>
  );
}

function App() {
  return (
    <View class="flex-1 flex-row">
      <TopicSidebar
        c={c}
        class={isMobile() ? "flex-1" : "w-[300px]"}
        onPartLayout={(name, frame) => {
          if (name === "sidebar" || name.startsWith("older") || name === "title-t16") frames.set({ ...frames(), [name]: frame });
        }}
      />
      <View class="w-[90px]">
        <Switch id="land-top" onPress={() => land("top", false)} />
        <Switch id="land-end" onPress={() => land("end", false)} />
        <Switch id="land-last" onPress={() => land("end", true)} />
        <Switch id="fail" onPress={fail} />
        <Switch id="refreshing" onPress={() => refreshing.set(!refreshing())} />
        <Text testID="report" class="text-[6px]">
          {JSON.stringify({ frames: frames(), offset: offset(), asks: asks(), loading: loading() })}
        </Text>
      </View>
    </View>
  );
}

mount(() => <App />);
