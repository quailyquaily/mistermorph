// The topic list beside the conversation (the whole screen on phones): its views (by date, by tag,
// the agents' topics, the TODO items' runs with their running count), a search on the loaded
// topics' titles, foldable groups, each topic with its icon, title and activity mark, and older
// topics on demand. Metrics from the Vue
// console's ChatView.css / common.css (`.chat-topic-*`, `.workspace-sidebar-*`): a 57pt head, rows
// 40pt tall 2pt apart (44 on phones) with a 20pt icon and a 14pt title that fades where it is cut,
// group labels in mono caps with a hairline running out to the right, one selection highlight that
// glides between rows, and calm hover fills.
//
// The rows are an `Each` in a scroll view rather than a virtualized List: a sidebar holds dozens of
// topics (older ones load on demand), and the sliding highlight must share the rows' parent to
// measure them and move with them.
import { Image, Scroll, signal, Text, token, View } from "nsh";
import { Button as BaseButton } from "nsh/base";
import { BusyBeam, Button, Icon, Spinner, StatusMark, Tip, TipButton } from "../../components/ui";
import { ContactAvatar } from "../../components/shared/ContactAvatar";
import { gutterX, IndexSearch } from "../../components/knowledge/parts";
import { FadeText } from "../../components/motion/FadeText";
import { createScrollEdges, SCROLLBAR } from "../../components/motion/ScrollEdges";
import { createSlidingSelection } from "../../components/motion/SlidingSelection";
import { sagHalf, SagRule } from "../../components/motion/Sag";
import { t } from "../../components/chat/i18n";
import { normalizeTopicID } from "../../lib/core/chat-task-history.js";
import type { ChatController, SidebarView, TopicRow } from "./chatController";
import { MobileBarSpacer } from "../../components/frame/mobileBar";
import { createPullSearch } from "../../components/shared/pullSearch";

// A view toggle in the head: a 38pt square with a 14pt icon, the buttons flush; on, a blue icon on
// a blue tint. While TODO runs are running, the TODO toggle's own square carries the border beam
// (design/ui-refresh.html §5, a plain button's: a faint hairline and the blue beam riding it), as
// the composer does while its task runs. The 12pt running ring that sat off the icon's corner was
// nearly the icon's size and stood out of the 38pt box. The beam lies on the box's outline,
// so the toggle keeps its size and icon, and it stays enabled: running is a status, not a busy
// press (a press only switches the list, nothing is sent). The count is in its name and tooltip.
// Exported for tests/fixtures/cron-toggle-app.tsx.
export function ViewToggle(props: {
  icon: "PhRobot" | "PhAlarm" | "PhTag";
  label: string;
  title: string;
  active: boolean;
  running?: boolean;
  onPress: () => void;
  testID: string;
  /** Its centre along the head, for the head's sag. */
  onCenter?: (x: number) => void;
}) {
  return (
    <TipButton
      selected={props.active}
      onPress={props.onPress}
      onLayout={({ bounds }) => props.onCenter?.(bounds.origin.x + bounds.size.width / 2)}
      accessibilityLabel={props.label}
      testID={props.testID}
      tooltip={<Tip text={props.title} />}
      class="relative size-[38px] items-center justify-center rounded-(--radius) transition-colors duration-[180ms] hover:bg-hover-soft selected:bg-blue/12"
    >
      <Icon name={props.icon} size={14} color={props.active ? "blue" : "subtle"} />
      <BusyBeam busy={!!props.running} variant="plain" testID="chat-cron-running" />
    </TipButton>
  );
}

// The topic's status mark (7pt): filled blue once a task finished and until the topic is viewed,
// filled orange while a task waits for the person, the turning ring while one runs.
function StatusDot(props: { status: string; label: string; class?: string; testID?: string }) {
  return (
    <View
      role="image"
      accessibilityLabel={props.label}
      tooltip={<Tip text={props.label} />}
      class={`size-[7px] ${props.class ?? ""}`}
      testID={props.testID ?? `chat-topic-status-${props.status}`}
    >
      <StatusMark state={props.status === "running" ? "running" : props.status === "pending" ? "pending" : "on"} size={7} />
    </View>
  );
}

// A foldable group's heading, a toggle: its caret, icon, label, count and hairline sit in the
// middle of its hover fill, 7pt above and below (the static heading's 10 and 4 together, so the
// list keeps its rhythm). Exported for tests/topic-group-heading.test.tsx.
export const TOPIC_GROUP_TOGGLE_CLASS =
  "mt-1.5 flex-row items-center gap-2.5 rounded-(--radius) py-[7px] pl-3.5 pr-3.5 transition-colors duration-[180ms] hover:bg-hover-soft";

export function TopicSidebar(props: { c: ChatController; class?: string }) {
  const c = props.c;
  const view = () => c.topicSidebarView();
  const toggle = (next: SidebarView) => c.setTopicSidebarView(view() === next ? "date" : next);
  const edges = createScrollEdges({ start: false });
  // Where each view toggle sits along the head, for the sag under the one that is on.
  const toggleCenters = signal<Partial<Record<SidebarView, number>>>({});
  const placeToggle = (key: SidebarView) => (x: number) => {
    if (toggleCenters()[key] !== x) toggleCenters.set({ ...toggleCenters(), [key]: x });
  };
  const sagCenter = () => (view() === "date" ? null : toggleCenters()[view()] ?? null);
  const activeKey = () => {
    const active = c.topicRows().find((row) => row.kind === "topic" && c.topicIsActive(row.topic));
    return active ? active.key : null;
  };
  const selection = createSlidingSelection(activeKey);
  // Rows are 40pt (44 on phones, a touch target), 2pt apart.
  const rowHeight = () => (c.mobileMode() ? "min-h-11" : "min-h-10");
  // On a phone the topics are a page of their own and take the pages' phone gutter (Contacts, TODO):
  // the title at the page's 12pt, rows edge to edge with their content 12pt in, group labels at 14.
  // The desktop sidebar keeps its 16pt list gutter and 25.6pt title.
  const rowPadding = () => (c.mobileMode() ? "px-3" : "pl-3.5 pr-[13px]");
  // On a touch phone the search hides until the list is pulled down from its top, and then sits
  // at the top of the list, scrolling with it; the desktop's stays under the head.
  const pull = createPullSearch({
    query: () => c.topicSearch(),
    revealed: c.topicSearchRevealed,
    mobile: () => c.mobileMode(),
    label: t("chat_topics_search"),
  });
  // The search: the loaded topics of this view whose title holds the text, as it is typed. The
  // index search Contacts has too (same field, gutters and room around it); it aligns with the
  // rows. Escape empties it.
  const search = () => (
    <IndexSearch
      value={c.topicSearch()}
      onChange={(value) => c.setTopicSearch(value)}
      placeholder={t("chat_topics_search")}
      mobile={c.mobileMode()}
      testID="chat-topics-search"
    />
  );

  const topicRow = (row: () => Extract<TopicRow, { kind: "topic" }>) => (
    <TipButton
      selected={c.topicIsActive(row().topic)}
      onPress={() => c.selectTopic(row().topic?.id)}
      onLayout={selection.track(row().key)}
      accessibilityLabel={c.topicTitle(row().topic)}
      testID={`chat-topic-${normalizeTopicID(row().topic?.id)}`}
      tooltip={c.topicTimeLabel(row().topic) ? <Tip text={c.topicTimeLabel(row().topic)} /> : undefined}
      class={`mt-0.5 ${rowHeight()} flex-row items-center gap-2.5 rounded-(--radius) border border-transparent py-2 ${rowPadding()} transition-colors duration-[180ms] hover:bg-hover-soft`}
    >
      <If
        when={view() === "agents"}
        else={
          <If
            when={c.isCronTopicID(row().topic?.id) && !row().topic?.icon}
            else={
              <Image
                src={c.topicIcon(row().topic)}
                accessibilityElementsHidden
                style={{ width: 20, height: 20, tintColor: token("subtle") as string }}
              />
            }
          >
            <Icon name="PhAlarm" size={20} color="subtle" />
          </If>
        }
      >
        <ContactAvatar
          item={c.topicAgentContact(row().topic)}
          imageURL={c.topicAgentAvatar(row().topic)}
          name={c.topicTitle(row().topic)}
          endpointRef={c.submitEndpointRef()}
          class="size-6"
        />
      </If>
      <View class="flex-1 gap-px">
        <FadeText text={c.topicTitle(row().topic)} class="text-sm leading-5 tracking-[-0.025em] text-foreground" noTooltip />
        <If when={c.isCronTopicID(row().topic?.id)}>
          <FadeText text={c.cronTopicModel(row().topic)} class="font-mono text-xs text-muted-foreground" noTooltip />
        </If>
      </View>
      <If when={c.topicActivityState(row().topic)}>
        <StatusDot status={c.topicActivityState(row().topic)} label={c.topicActivityLabel(row().topic)} />
      </If>
    </TipButton>
  );

  // A group's heading: a small mono label in caps, then a hairline that runs out to the list's
  // edge, fading (the Vue console's `.workspace-sidebar-divider`). A foldable group's is a toggle
  // with a caret, and its count while folded.
  const groupLabel = (row: () => Extract<TopicRow, { kind: "group" }>) => (
    <>
      <If when={row().collapsible}>
        <Icon name={row().collapsed ? "PhCaretRight" : "PhCaretDown"} size={11} color="muted-foreground" />
      </If>
      <If when={row().group.pinned} else={<If when={row().collapsible && !row().group.untagged}><Icon name="PhTag" size={12} color="muted-foreground" /></If>}>
        <Icon name="PhPushPin" size={12} color="muted-foreground" />
      </If>
      <Text
        class={`font-mono text-[11px] font-medium leading-[15.4px] text-muted-foreground line-clamp-1 ${
          view() === "tags" ? "tracking-[0.02em]" : "uppercase tracking-[0.12em]"
        }`}
      >
        {row().group.label}
      </Text>
      <If when={row().collapsible && row().collapsed}>
        <Text class="font-mono text-[11px] leading-[15.4px] text-muted-foreground">{String(row().group.topics.length)}</Text>
      </If>
      <View class="h-px flex-1 bg-linear-to-r from-line-soft to-transparent" />
    </>
  );

  const groupRow = (row: () => Extract<TopicRow, { kind: "group" }>) => (
    <If
      when={row().collapsible}
      else={<View class="flex-row items-center gap-2.5 pb-1 pl-3.5 pr-3.5 pt-2.5">{groupLabel(row)}</View>}
    >
      <TipButton
        onPress={() => c.toggleTopicGroup(row().group)}
        accessibilityLabel={row().group.label}
        tooltip={<Tip text={row().collapsed ? t("chat_topics_group_expand") : t("chat_topics_group_collapse")} />}
        testID={`chat-topic-group-${row().group.key}`}
        class={TOPIC_GROUP_TOGGLE_CLASS}
      >
        {groupLabel(row)}
      </TipButton>
    </If>
  );

  return (
    <View class={`bg-sidebar ${props.class ?? ""}`} testID="chat-topic-sidebar">
      {/* The head: the title on the left, the view toggles and New flush at the right, and on a
          desktop the search under them (on a phone it is the list's). The hairline under the head
          shows once topics have scrolled beneath, and sags softly under the view toggle that is on
          (design/ui-refresh.html §1). */}
      <View class="relative z-10">
        <View
          class={`h-[57px] flex-row items-center ${c.mobileMode() ? "" : "pl-[25.6px]"}`}
          style={c.mobileMode() ? { paddingLeft: gutterX(), paddingRight: gutterX() } : undefined}
        >
          <View class="mr-3 flex-1" onPress={() => c.clickTopicSidebarTitle()} testID="chat-topics-title">
            <Text class="text-xl leading-6 tracking-[-0.03em] text-foreground" role="header">
              {t("chat_topics_title")}
            </Text>
          </View>
          <If when={c.agentTopics().length > 0 || view() === "agents"}>
            <ViewToggle
              icon="PhRobot"
              label={t("chat_topics_view_agents")}
              title={view() === "agents" ? t("chat_topics_view_date") : t("chat_topics_view_agents")}
              active={view() === "agents"}
              onPress={() => toggle("agents")}
              testID="chat-topics-view-agents"
              onCenter={placeToggle("agents")}
            />
          </If>
          <ViewToggle
            icon="PhAlarm"
            label={c.cronToggleLabel()}
            title={c.cronToggleTitle()}
            active={view() === "cron"}
            running={c.cronRunning() > 0}
            onPress={() => toggle("cron")}
            testID="chat-topics-view-cron"
            onCenter={placeToggle("cron")}
          />
          <ViewToggle
            icon="PhTag"
            label={t("chat_topics_view_tags")}
            title={view() === "tags" ? t("chat_topics_view_date") : t("chat_topics_view_tags")}
            active={view() === "tags"}
            onPress={() => toggle("tags")}
            testID="chat-topics-view-tags"
            onCenter={placeToggle("tags")}
          />
          <If when={!c.mobileTopicSplitEnabled()}>
            <TipButton
              onPress={() => c.startNewTopic()}
              accessibilityLabel={t("chat_topic_new")}
              tooltip={<Tip text={t("chat_topic_new")} />}
              testID="chat-topic-new"
              class="size-[38px] items-center justify-center rounded-(--radius) transition-colors duration-[180ms] hover:bg-hover-soft"
            >
              <Icon name="PhPlus" size={14} color="subtle" />
            </TipButton>
          </If>
        </View>
        <If when={!c.mobileMode()}>{search()}</If>
        <SagRule
          center={sagCenter}
          half={sagHalf(38)}
          color={edges.scrolled() ? String(token("line-faint")) : "rgba(0, 0, 0, 0)"}
          class="absolute -bottom-[6px] left-0 right-0 h-[7px]"
        />
      </View>
      <If when={c.topicsLoading() && c.topicRows().length === 0}>
        <Spinner class="items-center py-3" />
      </If>
      <Scroll
        class={`flex-1 ${c.topicsLoading() ? "opacity-70" : ""}`}
        testID="chat-topic-list"
        onScroll={edges.handlers.onScroll}
        onLayout={edges.handlers.onLayout}
        scrollEventThrottle={edges.handlers.scrollEventThrottle}
        style={edges.style()}
        contentClass="grow"
        scrollbar={SCROLLBAR}
        refreshIndicator={pull.indicator}
        refreshing={pull.refreshing()}
        onRefresh={pull.onRefresh}
        onScrollDragStart={pull.onDragStart}
        accessibilityActions={pull.actions()}
        onAccessibilityAction={pull.onAction}
      >
        {/* The list's gutter (16pt; none on a phone, where rows run edge to edge as Contacts' do) as
            views inside the content rather than its padding: the content is at least the viewport's
            height, and padding on top of that made a list that fits scroll by its padding. Phones
            keep room under the floating New button. */}
        <View class={`grow ${c.mobileMode() ? "" : "px-4"}`} onLayout={edges.onContentLayout}>
          {/* On a phone the search, once pulled down: the list's first view, scrolling with it, at
              the head's foot as on a desktop while the list is at its top. */}
          <If when={c.mobileMode() && pull.shown()}>{search()}</If>
          {/* 8pt before the first row, as under Contacts' search. */}
          <View class="h-2" />
          <selection.Highlight class="rounded-(--radius) bg-selection" testID="chat-topic-selection" />
          <Each of={c.topicRows()} key={(row) => row.key}>
            {(row) => (
              <If
                when={row().kind === "topic"}
                else={
                  <If
                    when={row().kind === "group"}
                    else={
                      <View class="px-3.5 pb-2.5 pt-1.5">
                        <Text class="text-xs leading-[18px] text-muted-foreground">{(row() as Extract<TopicRow, { kind: "note" }>).text}</Text>
                      </View>
                    }
                  >
                    {groupRow(row as () => Extract<TopicRow, { kind: "group" }>)}
                  </If>
                }
              >
                {topicRow(row as () => Extract<TopicRow, { kind: "topic" }>)}
              </If>
            )}
          </Each>
          <If when={c.topicsNextCursor()}>
            <View class="items-center py-2">
              <Button
                variant="plain"
                size="sm"
                label={t("chat_topics_load_older")}
                loading={c.topicsLoadingOlder()}
                onPress={() => void c.loadOlderTopics()}
                testID="chat-topics-load-older"
              />
            </View>
          </If>
          <View class={c.mobileTopicSplitEnabled() ? "h-21" : "h-4"} />
        </View>
        <MobileBarSpacer />
      </Scroll>
    </View>
  );
}
