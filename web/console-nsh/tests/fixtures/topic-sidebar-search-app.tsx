// A test entry for tests/desktop-index-search.test.tsx: the real TopicSidebar on a stand-in
// controller, so the states the console's harness cannot hold (a topic list still loading: a
// pending request stops every test step) can be looked at. Buttons switch them: loading (with no
// rows yet), loaded (two topics), and the phone layout.
import { mount, signal, Text, View } from "nsh";
import { TopicSidebar } from "../../pages/chat/TopicSidebar";
import type { ChatController, SidebarView, TopicRow } from "../../pages/chat/chatController";

const loading = signal(true);
const mobile = signal(false);
const search = signal("");
const view = signal<SidebarView>("date");
const TOPICS = [
  { id: "topic-1", title: "Trip plans" },
  { id: "topic-2", title: "Recipes" },
];
const rows = signal<TopicRow[]>([]);
const loaded: TopicRow[] = [
  { kind: "group", key: "group:today", group: { key: "today", label: "Today", topics: TOPICS }, collapsible: false, collapsed: false },
  ...TOPICS.map((topic) => ({ kind: "topic" as const, key: `topic:${topic.id}`, topic, group: { key: "today" } })),
];
const shownRows = () => {
  const query = search().trim().toLowerCase();
  return query ? rows().filter((row) => row.kind !== "topic" || String(row.topic.title).toLowerCase().includes(query)) : rows();
};

const c = {
  agentTopics: () => [],
  clickTopicSidebarTitle: () => {},
  cronRunning: () => 0,
  cronToggleLabel: () => "TODO runs",
  cronToggleTitle: () => "TODO runs",
  cronTopicModel: () => "",
  isCronTopicID: () => false,
  loadOlderTopics: async () => {},
  mobileMode: () => mobile(),
  mobileTopicSplitEnabled: () => false,
  selectTopic: () => {},
  setTopicSearch: (value: string) => search.set(value),
  setTopicSidebarView: (next: SidebarView) => view.set(next),
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
  topicRows: () => shownRows(),
  topicSearch: () => search(),
  topicSearchRevealed: signal(false),
  topicSidebarView: () => view(),
  topicsLoading: () => loading(),
  topicsLoadingOlder: () => false,
  topicsLoadError: () => "",
  topicsLoadErrorInSidebar: () => false,
  chatLoadBusy: () => false,
  retryChatLoad: async () => undefined,
  topicsNextCursor: () => "",
  topicTimeLabel: () => "",
  topicTitle: (topic: any) => String(topic?.title || ""),
} as unknown as ChatController;

function Control(props: { id: string; label: string; onPress: () => void }) {
  return (
    <View onPress={() => props.onPress()} testID={props.id} class="px-2 py-1">
      <Text>{props.label}</Text>
    </View>
  );
}

function Gallery() {
  return (
    <View class="flex-1 flex-row">
      <TopicSidebar c={c} class={mobile() ? "flex-1" : "w-[300px]"} />
      <View class="flex-1">
        <Control id="fixture-loaded" label="loaded" onPress={() => {
          rows.set(loaded);
          loading.set(false);
        }} />
        <Control id="fixture-reload" label="reload" onPress={() => {
          rows.set([]);
          loading.set(true);
        }} />
        <Control id="fixture-mobile" label="mobile" onPress={() => mobile.set(!mobile())} />
      </View>
    </View>
  );
}

mount(() => <Gallery />);
