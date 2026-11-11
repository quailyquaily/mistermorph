// A test entry for tests/topic-status-alignment.test.tsx: the real topic sidebar on a stand-in
// controller, as wide as the chat page makes it (314pt with its 4pt right padding where New is in
// the head, the whole width in a phone's split mode), with topics in every activity state (running,
// pending, unread, none), long titles, a TODO run with its model line and a foldable group. The
// frames its head's last button, status marks and titles lie at are read out beside it. The modes
// along the top: `plus` (New in the head), `split` (a phone's split mode: New floats over the list,
// the tag toggle ends the head) and `empty` (split, loading, no topics).
import { batch, mount, signal, Text, View } from "nsh";
import { isMobile } from "../../lib/shell";
import { topicIcon } from "../../lib/core/topic-metadata.js";
import { TopicSidebar, type TopicPartFrame } from "../../pages/chat/TopicSidebar";
import type { ChatController, SidebarView, TopicRow } from "../../pages/chat/chatController";

type Mode = "plus" | "split" | "empty";

const mode = signal<Mode>("plus");
const frames = signal<Record<string, TopicPartFrame>>({});

const LONG = "A very long topic title that runs well past the width of the sidebar so it has to fade out";
const topics = [
  { id: "running", title: LONG, status: "running" },
  { id: "pending", title: "Waiting for an answer from you about the release notes", status: "pending" },
  { id: "unread", title: "Done", status: "done" },
  { id: "plain", title: LONG, status: "" },
  { id: "_cron_daily", title: "Daily digest of everything that happened in the workspace", status: "running" },
  { id: "tagged", title: "Tagged and finished while away", status: "done" },
];
const today = { key: "today", label: "Today", topics: topics.slice(0, 5) };
const tagged = { key: "tag-food", label: "food", topics: topics.slice(5) };
const rows: TopicRow[] = [
  { kind: "group", key: "group-today", group: today, collapsible: false, collapsed: false },
  ...today.topics.map((topic) => ({ kind: "topic" as const, key: `topic-${topic.id}`, topic, group: today })),
  { kind: "group", key: "group-tag-food", group: tagged, collapsible: true, collapsed: false },
  ...tagged.topics.map((topic) => ({ kind: "topic" as const, key: `topic-${topic.id}`, topic, group: tagged })),
];

const view = signal<SidebarView>("date");
const search = signal("");
const revealed = signal(false);
const split = () => mode() !== "plus";
const empty = () => mode() === "empty";

const c = {
  topicSidebarView: () => view(),
  setTopicSidebarView: (next: SidebarView) => view.set(next),
  topicRows: () => (empty() ? [] : rows),
  topicIsActive: (topic: any) => topic?.id === "pending",
  topicTagSaving: () => false,
  mobileMode: () => isMobile(),
  mobileTopicSplitEnabled: () => split() && isMobile(),
  topicSearch: () => search(),
  setTopicSearch: (value: string) => search.set(value),
  topicSearchRevealed: revealed,
  selectTopic: () => undefined,
  topicTitle: (topic: any) => String(topic?.title ?? ""),
  topicTimeLabel: () => "",
  isCronTopicID: (id: any) => String(id ?? "").startsWith("_cron_"),
  cronTopicModel: () => "gpt-5.2",
  topicIcon: (topic: any) => topicIcon(topic),
  topicAgentContact: () => null,
  topicAgentAvatar: () => "",
  submitEndpointRef: () => "",
  topicActivityState: (topic: any) => String(topic?.status ?? ""),
  topicActivityLabel: (topic: any) => String(topic?.status ?? ""),
  toggleTopicGroup: () => undefined,
  clickTopicSidebarTitle: () => undefined,
  agentTopics: () => [],
  cronToggleLabel: () => "TODO",
  cronToggleTitle: () => "TODO",
  cronRunning: () => 1,
  startNewTopic: () => undefined,
  topicsLoading: () => empty(),
  topicsNextCursor: () => "",
  topicsLoadingOlder: () => false,
  loadOlderTopics: async () => undefined,
} as unknown as ChatController;

function ModeButton(props: { mode: Mode }) {
  return (
    <View
      class="px-2 py-1"
      testID={`mode-${props.mode}`}
      onPress={() =>
        batch(() => {
          frames.set({});
          mode.set(props.mode);
        })
      }
    >
      <Text class="text-xs">{props.mode}</Text>
    </View>
  );
}

function Sidebar() {
  return (
    <TopicSidebar
      c={c}
      class={c.mobileTopicSplitEnabled() ? "flex-1" : "w-[314px] pr-1"}
      onPartLayout={(name, frame) => frames.update((all) => ({ ...all, [name]: frame }))}
    />
  );
}

function Page() {
  return (
    <View class="flex-1 bg-background">
      <View class="flex-row items-center">
        <ModeButton mode="plus" />
        <ModeButton mode="split" />
        <ModeButton mode="empty" />
        <Text class="text-xs">{mode()}</Text>
      </View>
      <Text class="text-[6px]">{JSON.stringify(frames())}</Text>
      <View class="flex-1 flex-row">
        {/* A fresh sidebar for each mode, so every part reports its frame anew. */}
        <If when={mode() === "plus"} else={<If when={mode() === "split"} else={<Sidebar />}><Sidebar /></If>}>
          <Sidebar />
        </If>
      </View>
    </View>
  );
}

mount(() => <Page />);
