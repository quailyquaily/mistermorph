// The topic list beside the conversation (the whole screen on phones): its views (by date, by tag,
// the agents' topics, the TODO items' runs with their running count), a search on the loaded
// topics' titles, foldable groups, each topic with its icon, title and activity mark, and older
// topics on demand. Metrics from the Vue
// console's ChatView.css / common.css (`.chat-topic-*`, `.workspace-sidebar-*`): a 57pt head, rows
// 40pt tall 2pt apart (44 on phones) with a 20pt icon and a 14pt title (15 on mobile) that fades
// where it is cut, group labels in mono caps with a hairline running out to the right, one
// selection highlight that glides between rows, and calm hover fills.
//
// The rows are an `Each` in a scroll view rather than a virtualized List: a sidebar holds dozens of
// topics (older ones load on demand), and the sliding highlight must share the rows' parent to
// measure them and move with them. A topic in the tag view can be dragged onto a tag group to add
// that tag (./topicDrag.ts), the groups it can go to outlined meanwhile: with a mouse straight away,
// on a touch screen once a finger has rested on it (a swipe stays the list's scroll).
import { Image, Scroll, signal, Text, token, View, type ViewRef } from "nsh";
import { Button as BaseButton } from "nsh/base";
import { Button, Icon, Spinner, StatusMark, Tip, TipButton } from "../../components/ui";
import { ContactAvatar } from "../../components/shared/ContactAvatar";
import { gutterX, IndexSearch } from "../../components/knowledge/parts";
import { FadeText } from "../../components/motion/FadeText";
import { AdjustingClock, type ClockProbe } from "../../components/motion/AdjustingClock";
import { createScrollEdges, SCROLLBAR } from "../../components/motion/ScrollEdges";
import { createSlidingSelection } from "../../components/motion/SlidingSelection";
import { sagHalf, SagRule } from "../../components/motion/Sag";
import { t } from "../../components/chat/i18n";
import { ChatLoadError } from "../../components/chat/ChatLoadError";
import { normalizeTopicID } from "../../lib/core/chat-task-history.js";
import type { ChatController, SidebarView, TopicRow } from "./chatController";
import { MobileBarSpacer } from "../../components/frame/mobileBar";
import { listTitleSize } from "../../components/frame/metrics";
import { createPullSearch } from "../../components/shared/pullSearch";
import { createTopicDrag } from "./topicDrag";
import { boundsFrame, createPartProbe, type LayoutBounds, type PartFrame, type PartLayoutListener } from "../../components/shared/partProbe";

// A view toggle in the head: a 38pt square with a 14pt icon, the buttons flush; on, a blue icon on
// a blue tint. While TODO runs are running, the TODO toggle's alarm clock has its hands turning, as
// a clock's do while it is being set (components/motion/AdjustingClock.tsx), in place of a loading
// look: no busy beam or hairline (the plain button's, FT61) and no ring off the icon's corner, so
// the square keeps its size, fill and icon. It stays enabled: running is a status, not a pending
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
  /** Its frame in the head, and its icon's in it (the sidebar's `onPartLayout`). */
  onFrame?: (event: LayoutBounds) => void;
  onIconFrame?: (event: LayoutBounds) => void;
  /** Hears how to read the alarm clock's hands (tests). */
  clockProbe?: (read: ClockProbe) => void;
}) {
  const color = () => (props.active ? "blue" : "subtle");
  return (
    <TipButton
      selected={props.active}
      onPress={props.onPress}
      onLayout={(event) => {
        props.onCenter?.(event.bounds.origin.x + event.bounds.size.width / 2);
        props.onFrame?.(event);
      }}
      accessibilityLabel={props.label}
      testID={props.testID}
      tooltip={<Tip text={props.title} />}
      class="size-[38px] items-center justify-center rounded-(--radius) transition-colors duration-[180ms] hover:bg-hover-soft selected:bg-blue/12"
    >
      {props.icon === "PhAlarm" ? (
        <AdjustingClock
          adjusting={!!props.running}
          size={14}
          color={color()}
          testID="chat-cron-clock"
          adjustingTestID="chat-cron-running"
          probe={props.clockProbe}
        />
      ) : (
        <Icon name={props.icon} size={14} color={color()} onLayout={props.onIconFrame} />
      )}
    </TipButton>
  );
}

// The topic's status mark (7pt): filled blue once a task finished and until the topic is viewed,
// filled orange while a task waits for the person (an approval, or the answer to its question),
// the turning ring while one runs.
function StatusDot(props: {
  status: string;
  label: string;
  class?: string;
  testID?: string;
  ref?: (node: ViewRef) => void;
  onLayout?: () => void;
}) {
  return (
    <View
      // A callback, never `ref={props.ref}`: with no ref passed (no `onPartLayout`), the compiled
      // `ref={props.ref}` assigns the node to `props.ref`, which the web runtime refuses ("Cannot
      // redefine property: ref"): mounting a status mark threw and the list froze (the TODO view
      // opened while a run went on kept showing the date list). Headless tests (QuickJS) never threw.
      ref={(node: ViewRef) => props.ref?.(node)}
      onLayout={props.onLayout}
      role="image"
      accessibilityLabel={props.label}
      tooltip={<Tip text={props.label} />}
      class={`size-[7px] ${props.class ?? ""}`}
      testID={props.testID ?? `chat-topic-status-${props.status}`}
    >
      <StatusMark
        state={props.status === "running" ? "running" : props.status === "pending" || props.status === "waiting" ? "pending" : "on"}
        size={7}
      />
    </View>
  );
}

// A foldable group's heading, a toggle: its caret, icon, label, count and hairline sit in the
// middle of its hover fill, 7pt above and below (the static heading's 10 and 4 together, so the
// list keeps its rhythm). Exported for tests/topic-group-heading.test.tsx.
export const TOPIC_GROUP_TOGGLE_CLASS =
  "mt-1.5 flex-row items-center gap-2.5 rounded-(--radius) py-[7px] pl-3.5 pr-3.5 transition-colors duration-[180ms] hover:bg-hover-soft";

/** A topic row's title type: 14pt on a 20pt line, 15 on 22 on mobile. Exported for
 * tests/list-title-size.test.tsx. */
export const topicTitleClass = (mobile: boolean) =>
  `${listTitleSize(mobile)} ${mobile ? "leading-[22px]" : "leading-5"} tracking-[-0.025em] text-foreground`;

// The head's last button (New, or the tag toggle where a phone's New floats over the list) ends the
// right inset in from the sidebar's right edge: on a phone the pages' phone gutter (`gutterX`), the
// head's own padding; on a desktop the list's 16pt gutter, so the button ends where the rows do.
// Its 14pt icon sits in the middle
// of its 38pt square, and every row's 7pt status mark is centred under that icon: the marks' axis
// lies the inset and half a button in from the edge. A row's right padding is that axis less half
// a mark, the row's 1pt border and, on a desktop, the list's 16pt gutter (phone rows run edge to
// edge). Centres, not edges: with the mark's and the button's right edges flush the mark sat 15.5pt
// right of the icon. A title ends 10pt before its mark (the row's gap), or where the mark would end.
export const TOPIC_ROW_BORDER = 1;
export const TOPIC_LIST_GUTTER = 16;
/** The head's buttons: 38pt squares, their icon in the middle. */
export const TOPIC_HEAD_BUTTON = 38;
/** A row's status mark (StatusDot). */
export const TOPIC_STATUS_SIZE = 7;
const DESKTOP_RIGHT_INSET = TOPIC_LIST_GUTTER;

/** How far the head's last button ends in from the sidebar's right edge. */
export function topicRightInset(mobile: boolean): number {
  return mobile ? gutterX() : DESKTOP_RIGHT_INSET;
}

/** How far the axis the last button's icon and the rows' status marks are centred on lies in from the sidebar's right edge. */
export function topicStatusAxisInset(mobile: boolean): number {
  return topicRightInset(mobile) + TOPIC_HEAD_BUTTON / 2;
}

/** A topic row's right padding, so its status mark is centred on `topicStatusAxisInset`. */
export function topicRowPaddingRight(mobile: boolean): number {
  return topicStatusAxisInset(mobile) - TOPIC_STATUS_SIZE / 2 - (mobile ? 0 : TOPIC_LIST_GUTTER) - TOPIC_ROW_BORDER;
}

/** A part's frame on the page, for `onPartLayout`. */
export type TopicPartFrame = PartFrame;

export function TopicSidebar(props: {
  c: ChatController;
  class?: string;
  /** Its motion as a phone's pane (ChatPage), and whether it is going out (inert, hidden from assistive tech). */
  style?: Record<string, unknown>;
  hidden?: boolean;
  /** Hears where parts lie on the page (tests): `sidebar`, `head-action` (the head's last button),
   * `head-icon` (its icon), `status-<topic id>` and `title-<topic id>`. */
  onPartLayout?: PartLayoutListener;
}) {
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
  const rowsInset = signal(0);
  const drag = createTopicDrag({
    rows: () => c.topicRows(),
    contentInset: rowsInset,
    enabled: () => view() === "tags",
    canDrop: (topic, group) => c.topicCanDrop(topic, group),
    drop: (topic, group) => void c.dropTopicOnGroup(topic, group),
  });
  // Rows are 40pt (44 on phones, a touch target), 2pt apart.
  const rowHeight = () => (c.mobileMode() ? "min-h-11" : "min-h-10");
  // On a phone the topics are a page of their own and take the pages' phone gutter (Contacts, TODO):
  // the title at the page's 12pt, rows edge to edge with their content 12pt in, group labels at 14.
  // The desktop sidebar keeps its 16pt list gutter and 25.6pt title. The rows' right padding comes
  // from the shared axis (above), so their status marks are centred under the head's last icon.
  const rowPadding = () => (c.mobileMode() ? "pl-3" : "pl-3.5");
  const rightInset = () => topicRightInset(c.mobileMode());
  // The probe for `onPartLayout`: a view's frame on the page as it lays out. The head's buttons
  // take no ref: the last one's frame in the head row, and its icon's in it, are placed from the
  // row's.
  const parts = createPartProbe(() => props.onPartLayout);
  const probe = parts.probe;
  let headRow: ViewRef | undefined;
  let lastButton: PartFrame | undefined;
  let lastIcon: PartFrame | undefined;
  const headButtonLayout = (last: () => boolean) => (event: LayoutBounds) => {
    if (!last()) return;
    lastButton = boundsFrame(event);
    parts.report("head-action", headRow, () => lastButton);
    parts.report("head-icon", headRow, headIcon);
  };
  const headIconLayout = (last: () => boolean) => (event: LayoutBounds) => {
    if (!last()) return;
    lastIcon = boundsFrame(event);
    parts.report("head-icon", headRow, headIcon);
  };
  const headIcon = () =>
    lastButton && lastIcon ? { ...lastIcon, x: lastButton.x + lastIcon.x, y: lastButton.y + lastIcon.y } : undefined;
  // The search is the list's first view, scrolling with it, never the head's (the head keeps the
  // title and its buttons). On a touch phone it hides until the list is pulled down from its top;
  // on a desktop (and a desktop's window narrowed to the phone layout) it always shows.
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

  // A topic's row. The view around it takes the drag and reports the frame the sliding selection
  // and the drop zones are placed from; while dragged it follows the pointer on a card of its own,
  // and while a dropped tag saves it is dimmed. Letting go of a topic a finger lifted opens nothing.
  const topicRow = (row: () => Extract<TopicRow, { kind: "topic" }>) => {
    const key = row().key;
    const placeSelection = selection.track(key);
    const placeDrop = drag.track(key);
    return (
      <View
        {...drag.handlers(row)}
        onLayout={(event) => {
          placeSelection(event);
          placeDrop(event);
        }}
        class={`mt-0.5 rounded-(--radius) ${drag.lifted(key) ? "bg-card shadow-md" : ""} ${c.topicTagSaving(row().topic) ? "opacity-60" : ""}`}
        style={drag.liftStyle(key)}
        testID={`chat-topic-row-${normalizeTopicID(row().topic?.id)}`}
      >
        <TipButton
          selected={c.topicIsActive(row().topic)}
          onPress={() => {
            if (!drag.pressTaken(key)) c.selectTopic(row().topic?.id);
          }}
          accessibilityLabel={c.topicTitle(row().topic)}
          testID={`chat-topic-${normalizeTopicID(row().topic?.id)}`}
          tooltip={c.topicTimeLabel(row().topic) && !drag.hidesTip(key) ? <Tip text={c.topicTimeLabel(row().topic)} /> : undefined}
          class={`${rowHeight()} flex-row items-center gap-2.5 rounded-(--radius) border border-transparent py-2 ${rowPadding()} transition-colors duration-[180ms] hover:bg-hover-soft`}
          style={{ paddingRight: topicRowPaddingRight(c.mobileMode()) }}
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
          <View class="flex-1 gap-px" {...probe(() => `title-${normalizeTopicID(row().topic?.id)}`)}>
            <FadeText text={c.topicTitle(row().topic)} class={topicTitleClass(c.mobileMode())} noTooltip />
            <If when={c.isCronTopicID(row().topic?.id)}>
              <FadeText text={c.cronTopicModel(row().topic)} class="font-mono text-xs text-muted-foreground" noTooltip />
            </If>
          </View>
          <If when={c.topicActivityState(row().topic)}>
            <StatusDot
              status={c.topicActivityState(row().topic)}
              label={c.topicActivityLabel(row().topic)}
              {...probe(() => `status-${normalizeTopicID(row().topic?.id)}`)}
            />
          </If>
        </TipButton>
      </View>
    );
  };

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

  // While a topic is dragged, the outline round a group it can be dropped on (dashed), filled while
  // it is over it (the Vue console's .is-drop-target and .is-drop-over): from the heading down to
  // the next group's, 3pt in at the top and the foot so neighbours' outlines stay apart.
  const DROP_OUTLINE = {
    none: "border-transparent",
    target: "border-dashed border-blue/45",
    over: "border-blue/45 bg-blue/10",
  } as const;
  const dropOutline = (row: () => Extract<TopicRow, { kind: "group" }>) => (
    <View
      accessibilityElementsHidden
      class={`absolute left-0 right-0 top-[3px] rounded-(--radius) border ${DROP_OUTLINE[drag.zoneState(row().group.key)]}`}
      style={{ height: Math.max(0, drag.zoneHeight(row().group.key) - 6), pointerEvents: "none" }}
      testID={
        drag.zoneState(row().group.key) === "none" ? `chat-topic-drop-zone-${row().group.key}` : `chat-topic-drop-${drag.zoneState(row().group.key)}-${row().group.key}`
      }
    />
  );

  const groupRow = (row: () => Extract<TopicRow, { kind: "group" }>) => (
    <View onLayout={drag.track(row().key)}>
      {dropOutline(row)}
      {groupHeading(row)}
    </View>
  );

  const groupHeading = (row: () => Extract<TopicRow, { kind: "group" }>) => (
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
    <View
      class={`bg-sidebar ${props.class ?? ""}`}
      style={props.style}
      accessibilityElementsHidden={props.hidden || undefined}
      importantForAccessibility={props.hidden ? "no-hide-descendants" : undefined}
      testID="chat-topic-sidebar"
      {...probe(() => "sidebar")}
    >
      {/* The head: the title on the left, the view toggles and New at the right, the last button
          ending at the right inset, its icon centred over the rows' status marks. The search is
          the list's, on a phone and a desktop alike. The hairline under the head shows once topics
          have scrolled beneath, and sags softly under the view toggle that is on
          (design/ui-refresh.html §1). */}
      <View class="relative z-10">
        <View
          ref={(node: ViewRef) => {
            headRow = node;
          }}
          class={`h-[57px] flex-row items-center ${c.mobileMode() ? "" : "pl-[25.6px]"}`}
          style={c.mobileMode() ? { paddingLeft: gutterX(), paddingRight: rightInset() } : { paddingRight: rightInset() }}
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
            onFrame={headButtonLayout(() => c.mobileTopicSplitEnabled())}
            onIconFrame={headIconLayout(() => c.mobileTopicSplitEnabled())}
          />
          <If when={!c.mobileTopicSplitEnabled()}>
            <TipButton
              onPress={() => c.startNewTopic()}
              accessibilityLabel={t("chat_topic_new")}
              tooltip={<Tip text={t("chat_topic_new")} />}
              testID="chat-topic-new"
              onLayout={headButtonLayout(() => true)}
              class="size-[38px] items-center justify-center rounded-(--radius) transition-colors duration-[180ms] hover:bg-hover-soft"
            >
              <Icon name="PhPlus" size={14} color="subtle" onLayout={headIconLayout(() => true)} />
            </TipButton>
          </If>
        </View>
        <SagRule
          center={sagCenter}
          half={sagHalf(38)}
          color={edges.scrolled() ? String(token("line-faint")) : "rgba(0, 0, 0, 0)"}
          class="absolute -bottom-[6px] left-0 right-0 h-[7px]"
        />
      </View>
      <Scroll
        class={`flex-1 ${c.topicsLoading() ? "opacity-70" : ""}`}
        testID="chat-topic-list"
        onScroll={(event) => {
          edges.handlers.onScroll(event);
          drag.onScroll(event);
        }}
        onLayout={(event) => {
          edges.handlers.onLayout(event);
          drag.onViewportLayout(event);
        }}
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
        <View class="grow" onLayout={edges.onContentLayout}>
          {/* The search (on a touch phone once pulled down): the list's first view, scrolling with
              it, at the head's foot while the list is at its top. It has its own gutter, so it sits
              outside the rows' one below. It stays while the topics load, fail or are none. */}
          <If when={pull.shown()}>{search()}</If>
          <If when={c.topicsLoading() && c.topicRows().length === 0}>
            <View testID="chat-topics-loading">
              <Spinner class="items-center py-3" />
            </View>
          </If>
          {/* The list failed to load (or to refresh: the topics already listed stay below). */}
          <If when={c.topicsLoadErrorInSidebar()}>
            <ChatLoadError
              compact
              title={t("chat_topics_load_failed")}
              message={c.topicsLoadError()}
              refreshLabel={t("action_refresh")}
              busy={c.chatLoadBusy()}
              onRefresh={() => void c.retryChatLoad()}
              testID="chat-topics-load-error"
            />
          </If>
          {/* The list's gutter (16pt; none on a phone, where rows run edge to edge as Contacts' do) as
              views inside the content rather than its padding: the content is at least the viewport's
              height, and padding on top of that made a list that fits scroll by its padding. Phones
              keep room under the floating New button. */}
          <View class={`grow ${c.mobileMode() ? "" : "px-4"}`} ref={drag.contentRef} onLayout={(event) => rowsInset.set(event.bounds.origin.y)}>
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
        </View>
        <MobileBarSpacer />
      </Scroll>
    </View>
  );
}
