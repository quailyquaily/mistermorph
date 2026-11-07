// The topic list beside the conversation (the whole screen on phones): its views (by date, by tag,
// the agents' topics, the TODO items' runs with their running count), foldable groups, each topic
// with its icon, title and activity mark, and older topics on demand. A virtualized list: rows
// read their item in bindings and keep nothing of their own.
import { Image, List, Text, token, View } from "nsh";
import { Button as BaseButton } from "nsh/base";
import { Button, Icon, Spinner } from "../../components/ui";
import { ContactAvatar } from "../../components/shared/ContactAvatar";
import { t } from "../../components/chat/i18n";
import { normalizeTopicID } from "../../lib/core/chat-task-history.js";
import type { ChatController, SidebarView, TopicRow } from "./chatController";

function ViewToggle(props: {
  icon: "PhRobot" | "PhAlarm" | "PhTag";
  label: string;
  title: string;
  active: boolean;
  running?: boolean;
  onPress: () => void;
  testID: string;
}) {
  return (
    <BaseButton
      selected={props.active}
      onPress={props.onPress}
      accessibilityLabel={props.label}
      testID={props.testID}
      tooltip={
        <View class="bg-foreground px-2 py-1">
          <Text class="text-xs text-background">{props.title}</Text>
        </View>
      }
      class="size-8 items-center justify-center rounded-(--radius) hover:bg-hover selected:bg-selection"
    >
      <View>
        <Icon name={props.icon} size={16} color={props.active ? "blue" : "subtle"} />
        <If when={props.running}>
          <View class="absolute -right-2 -top-1 size-2 border border-status-on bg-status-on" testID="chat-cron-running" />
        </If>
      </View>
    </BaseButton>
  );
}

function StatusDot(props: { status: string; label: string }) {
  const cls = () =>
    props.status === "pending"
      ? "bg-status-pending border-status-pending"
      : props.status === "running"
        ? "border-status-on"
        : "bg-status-on border-status-on";
  return (
    <View
      role="image"
      accessibilityLabel={props.label}
      tooltip={<Text class="text-xs">{props.label}</Text>}
      class={`size-2 border ${cls()}`}
      testID={`chat-topic-status-${props.status}`}
    />
  );
}

export function TopicSidebar(props: { c: ChatController; class?: string }) {
  const c = props.c;
  const view = () => c.topicSidebarView();
  const toggle = (next: SidebarView) => c.setTopicSidebarView(view() === next ? "date" : next);

  const topicRow = (row: () => Extract<TopicRow, { kind: "topic" }>) => (
    <BaseButton
      selected={c.topicIsActive(row().topic)}
      onPress={() => c.selectTopic(row().topic?.id)}
      accessibilityLabel={c.topicTitle(row().topic)}
      testID={`chat-topic-${normalizeTopicID(row().topic?.id)}`}
      tooltip={
        c.topicTimeLabel(row().topic) ? (
          <View class="bg-foreground px-2 py-1">
            <Text class="text-xs text-background">{c.topicTimeLabel(row().topic)}</Text>
          </View>
        ) : undefined
      }
      class="mx-2 flex-row items-center gap-2 rounded-(--radius) px-2 py-1.5 hover:bg-hover selected:bg-selection"
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
                style={{ width: 16, height: 16, tintColor: token("subtle") as string }}
              />
            }
          >
            <Icon name="PhAlarm" size={16} color="subtle" />
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
        <Text class="text-sm text-foreground line-clamp-1">{c.topicTitle(row().topic)}</Text>
        <If when={c.isCronTopicID(row().topic?.id)}>
          <Text class="font-mono text-xs text-muted-foreground line-clamp-1">{c.cronTopicModel(row().topic)}</Text>
        </If>
      </View>
      <If when={c.topicActivityState(row().topic)}>
        <StatusDot status={c.topicActivityState(row().topic)} label={c.topicActivityLabel(row().topic)} />
      </If>
    </BaseButton>
  );

  const groupRow = (row: () => Extract<TopicRow, { kind: "group" }>) => (
    <If
      when={row().collapsible}
      else={
        <View class="px-4 pb-1 pt-3">
          <Text class="font-mono text-xs uppercase text-muted-foreground">{row().group.label}</Text>
        </View>
      }
    >
      <BaseButton
        onPress={() => c.toggleTopicGroup(row().group)}
        accessibilityLabel={row().group.label}
        tooltip={
          <View class="bg-foreground px-2 py-1">
            <Text class="text-xs text-background">{row().collapsed ? t("chat_topics_group_expand") : t("chat_topics_group_collapse")}</Text>
          </View>
        }
        testID={`chat-topic-group-${row().group.key}`}
        class="mx-2 mt-2 flex-row items-center gap-1.5 rounded-(--radius) px-2 py-1 hover:bg-hover"
      >
        <Icon name={row().collapsed ? "PhCaretRight" : "PhCaretDown"} size={11} color="muted-foreground" />
        <If when={row().group.pinned} else={<If when={!row().group.untagged}><Icon name="PhTag" size={12} color="muted-foreground" /></If>}>
          <Icon name="PhPushPin" size={12} color="muted-foreground" />
        </If>
        <Text class="flex-1 font-mono text-xs uppercase text-muted-foreground line-clamp-1">{row().group.label}</Text>
        <If when={row().collapsed}>
          <Text class="font-mono text-xs text-muted-foreground">{String(row().group.topics.length)}</Text>
        </If>
      </BaseButton>
    </If>
  );

  return (
    <View class={`bg-sidebar ${props.class ?? ""}`} testID="chat-topic-sidebar">
      <View class="min-h-12 flex-row items-center gap-1 border-b border-line-faint px-3">
        <View class="flex-1" onPress={() => c.clickTopicSidebarTitle()} testID="chat-topics-title">
          <Text class="text-base font-semibold text-foreground" role="header">
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
        />
        <ViewToggle
          icon="PhTag"
          label={t("chat_topics_view_tags")}
          title={view() === "tags" ? t("chat_topics_view_date") : t("chat_topics_view_tags")}
          active={view() === "tags"}
          onPress={() => toggle("tags")}
          testID="chat-topics-view-tags"
        />
        <If when={!c.mobileTopicSplitEnabled()}>
          <Button variant="plain" size="sm" iconOnly icon="PhPlus" title={t("chat_topic_new")} onPress={() => c.startNewTopic()} testID="chat-topic-new" />
        </If>
      </View>
      <If when={c.topicsLoading() && c.topicRows().length === 0}>
        <Spinner class="items-center py-3" />
      </If>
      <List
        each={c.topicRows()}
        keyExtractor={(row) => row.key}
        estimatedItemSize={34}
        class={`flex-1 ${c.topicsLoading() ? "opacity-70" : ""}`}
        contentStyle={{ paddingTop: 6, paddingBottom: 12 }}
        testID="chat-topic-list"
        footer={() => (
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
        )}
      >
        {(row) => (
          <If
            when={row().kind === "topic"}
            else={
              <If
                when={row().kind === "group"}
                else={
                  <View class="px-4 py-2">
                    <Text class="text-xs text-muted-foreground">{(row() as Extract<TopicRow, { kind: "note" }>).text}</Text>
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
      </List>
    </View>
  );
}
