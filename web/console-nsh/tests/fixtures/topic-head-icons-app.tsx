// A test entry for tests/topic-head-icons.test.tsx: the real topic sidebar on a stand-in
// controller, beside a regular icon-only Button at the bar size (BAR_BUTTON_SIZE, as the TODO
// head's calendar toggle and the phone bars' back arrows), the reference for the head's icons. The
// frames of every head button and its icon (the sidebar's `onPartLayout`), and the reference
// button's and its icon's, are read out beside it, with the presses the head's buttons made. The
// modes along the top: `plus` (topics, an agent topic so the agents toggle shows, TODO runs
// running, New in the head), `split` (the same in a phone's split mode: New floats over the list)
// and `empty` (split, loading, no topics yet, nothing running).
import { batch, mount, signal, Text, View } from "nsh";
import { isMobile } from "../../lib/shell";
import { topicIcon } from "../../lib/core/topic-metadata.js";
import { BAR_BUTTON_SIZE, Button } from "../../components/ui";
import { boundsFrame, type LayoutBounds } from "../../components/shared/partProbe";
import { TopicSidebar, type TopicPartFrame } from "../../pages/chat/TopicSidebar";
import type { ChatController, SidebarView, TopicRow } from "../../pages/chat/chatController";

type Mode = "plus" | "split" | "empty";

const mode = signal<Mode>("plus");
const frames = signal<Record<string, TopicPartFrame>>({});
const presses = signal<string[]>([]);
const record = (name: string) => (frame: TopicPartFrame) => frames.update((all) => ({ ...all, [name]: frame }));
const press = (name: string) => presses.update((all) => [...all, name]);

const topics = [
  { id: "running", title: "Running", status: "running" },
  { id: "agent", title: "From an agent", status: "" },
];
const today = { key: "today", label: "Today", topics };
const rows: TopicRow[] = [
  { kind: "group", key: "group-today", group: today, collapsible: false, collapsed: false },
  ...topics.map((topic) => ({ kind: "topic" as const, key: `topic-${topic.id}`, topic, group: today })),
];

const view = signal<SidebarView>("date");
const empty = () => mode() === "empty";

const c = {
  topicSidebarView: () => view(),
  setTopicSidebarView: (next: SidebarView) => {
    press(`view:${next}`);
    view.set(next);
  },
  topicRows: () => (empty() ? [] : rows),
  topicIsActive: () => false,
  topicTagSaving: () => false,
  mobileMode: () => isMobile(),
  mobileTopicSplitEnabled: () => mode() !== "plus" && isMobile(),
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
  topicActivityState: (topic: any) => String(topic?.status ?? ""),
  topicActivityLabel: (topic: any) => String(topic?.status ?? ""),
  toggleTopicGroup: () => undefined,
  clickTopicSidebarTitle: () => undefined,
  agentTopics: () => (empty() ? [] : topics.slice(1)),
  cronToggleLabel: () => (empty() ? "TODO runs" : "TODO runs — 1 running"),
  cronToggleTitle: () => "TODO runs",
  cronRunning: () => (empty() ? 0 : 1),
  startNewTopic: () => press("new"),
  topicsLoading: () => empty(),
  topicsNextCursor: () => "",
  topicsLoadingOlder: () => false,
  topicsLoadError: () => "",
  topicsLoadErrorInSidebar: () => false,
  chatLoadBusy: () => false,
  retryChatLoad: async () => undefined,
  loadOlderTopics: async () => undefined,
} as unknown as ChatController;

function ModeButton(props: { mode: Mode }) {
  return (
    <View
      class="px-2 py-1"
      testID={`mode-${props.mode}`}
      onPress={() =>
        batch(() => {
          // The sidebar's parts report anew; the reference button stays put.
          frames.set({ reference: frames().reference, "reference-icon": frames()["reference-icon"] });
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
      onPartLayout={(name, frame) => record(name)(frame)}
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
        <Button
          variant="plain"
          size={BAR_BUTTON_SIZE}
          iconOnly
          icon="PhPlus"
          title="Reference"
          testID="reference"
          onLayout={(event: LayoutBounds) => record("reference")(boundsFrame(event))}
          onIconLayout={(event) => record("reference-icon")(boundsFrame(event))}
        />
      </View>
      <Text class="text-[6px]">{JSON.stringify(frames())}</Text>
      <Text class="text-[6px]">{`presses:${presses().join(",")}`}</Text>
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
