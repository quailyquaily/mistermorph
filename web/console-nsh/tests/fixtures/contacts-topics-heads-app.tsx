// A test entry for tests/contacts-topics-heads.test.tsx: the Contacts column's head as the page
// draws it (the real IndexColumn with ContactKindTabs and its sag) over the real topic sidebar on a
// stand-in controller, each across the window, so the two heads can be compared whole. Their parts'
// frames are read out beside them, the Contacts ones as `contacts:<part>` (IndexColumn's and the
// tabs' `onPartLayout`), the Topics ones as `topics:<part>` (the sidebar's), with the Contacts tab
// and the Topics view that are on.
import { mount, signal, Text, View } from "nsh";
import { isMobile } from "../../lib/shell";
import { topicIcon } from "../../lib/core/topic-metadata.js";
import { IndexColumn } from "../../components/knowledge/parts";
import type { PartFrame } from "../../components/shared/partProbe";
import { ContactKindTabs, contactKindSagCenter } from "../../pages/contacts/ContactKindTabs";
import type { ContactKind } from "../../pages/contacts/contact-format";
import { TopicSidebar } from "../../pages/chat/TopicSidebar";
import type { ChatController, SidebarView, TopicRow } from "../../pages/chat/chatController";

const frames = signal<Record<string, PartFrame>>({});
const record = (prefix: string) => (name: string, frame: PartFrame) => frames.update((all) => ({ ...all, [`${prefix}:${name}`]: frame }));
const kind = signal<ContactKind>("human");
const view = signal<SidebarView>("date");

const topics = [
  { id: "plain", title: "A topic", status: "" },
  { id: "agent", title: "From an agent", status: "" },
];
const today = { key: "today", label: "Today", topics };
const rows: TopicRow[] = [
  { kind: "group", key: "group-today", group: today, collapsible: false, collapsed: false },
  ...topics.map((topic) => ({ kind: "topic" as const, key: `topic-${topic.id}`, topic, group: today })),
];

const c = {
  topicSidebarView: () => view(),
  setTopicSidebarView: (next: SidebarView) => view.set(next),
  topicRows: () => rows,
  topicIsActive: () => false,
  topicTagSaving: () => false,
  mobileMode: () => isMobile(),
  mobileTopicSplitEnabled: () => false,
  topicSearch: () => "",
  setTopicSearch: () => undefined,
  topicSearchRevealed: signal(false),
  selectTopic: () => undefined,
  topicTitle: (topic: any) => String(topic?.title ?? ""),
  topicTimeLabel: () => "",
  isCronTopicID: () => false,
  cronTopicModel: () => "",
  topicIcon: (topic: any) => topicIcon(topic),
  topicAgentContact: () => null,
  topicAgentAvatar: () => "",
  submitEndpointRef: () => "",
  topicActivityState: () => "",
  topicActivityLabel: () => "",
  toggleTopicGroup: () => undefined,
  clickTopicSidebarTitle: () => undefined,
  agentTopics: () => topics.slice(1),
  cronToggleLabel: () => "TODO runs",
  cronToggleTitle: () => "TODO runs",
  cronRunning: () => 0,
  startNewTopic: () => undefined,
  topicsLoading: () => false,
  topicsNextCursor: () => "",
  topicsLoadingOlder: () => false,
  topicsLoadError: () => "",
  topicsLoadErrorInSidebar: () => false,
  chatLoadBusy: () => false,
  retryChatLoad: async () => undefined,
  loadOlderTopics: async () => undefined,
} as unknown as ChatController;

function Page() {
  return (
    <View class="flex-1 bg-background">
      <View class="h-[200px] flex-row" testID="contacts-column">
        <IndexColumn
          title="Contacts"
          actions={<ContactKindTabs value={kind()} mobile={isMobile()} onChange={(next) => kind.set(next)} onPartLayout={record("contacts")} />}
          sag={() => contactKindSagCenter(kind(), isMobile())}
          fill
          scroll={false}
          onPartLayout={record("contacts")}
        >
          <View class="flex-1" />
        </IndexColumn>
      </View>
      <View class="h-[260px] flex-row" testID="topics-column">
        <TopicSidebar c={c} class="flex-1" onPartLayout={record("topics")} />
      </View>
      <Text testID="out-kind">kind={kind()}</Text>
      <Text testID="out-view">view={view()}</Text>
      <Text class="text-[6px]">{JSON.stringify(frames())}</Text>
    </View>
  );
}

mount(() => <Page />);
