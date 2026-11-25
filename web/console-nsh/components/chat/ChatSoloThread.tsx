// A work thread in Solo (FT186): the card Solo shows when it starts a thread, following the
// thread's state (running, waiting for the person, done, failed, stopped), and the summary it gets
// when the thread ends. Both name the thread and its workspace and open the thread when pressed;
// the summary's text (the thread's own reply, or why it failed) comes as children.
import type { JSX } from "nsh";
import { Text, View } from "nsh";
import { Button, Icon, StatusMark, type StatusState } from "../ui";
import { CARD_CORNERS } from "../corners";
import { t } from "./i18n";

export interface SoloThreadView {
  kind: "card" | "summary";
  topicID: string;
  taskID: string;
  title: string;
  workspace: string;
  state: "running" | "waiting" | "done" | "failed" | "canceled";
  summary: string;
  continued: boolean;
}

function markState(state: SoloThreadView["state"]): StatusState {
  switch (state) {
    case "waiting":
      return "pending";
    case "done":
      return "done";
    case "failed":
      return "error";
    case "canceled":
      return "off";
    default:
      return "running";
  }
}

/** What the card's heading says: a thread started (or given more work), or how it ended. */
export function soloThreadKicker(thread: SoloThreadView) {
  if (thread.kind === "summary") return t(`chat_solo_thread_ended_${thread.state === "done" || thread.state === "canceled" ? thread.state : "failed"}`);
  return t(thread.continued ? "chat_solo_thread_continued" : "chat_solo_thread_started");
}

export function ChatSoloThread(props: { thread: SoloThreadView; onOpen: () => void; children?: JSX.Element }) {
  const thread = () => props.thread;
  const stateLabel = () => t(`chat_solo_thread_state_${thread().state}`);
  const title = () => thread().title || t("chat_topic_untitled");
  return (
    <View
      class={`gap-2 ${CARD_CORNERS} border bg-card p-3 ${thread().state === "waiting" ? "border-warn" : "border-line-faint"}`}
      accessibilityLabel={`${soloThreadKicker(thread())}: ${title()}, ${stateLabel()}`}
      testID={`chat-solo-thread.${thread().kind}.${thread().state}`}
    >
      <View class="flex-row items-center gap-2">
        <Icon name="PhArrowsSplit" size={15} color="muted-foreground" />
        <Text class="min-w-0 shrink text-xs text-muted-foreground line-clamp-1">{soloThreadKicker(thread())}</Text>
        <View class="flex-1" />
        <View class="flex-row items-center gap-1.5" testID={`chat-solo-thread-state.${thread().state}`}>
          <StatusMark state={markState(thread().state)} size={7} />
          <Text class="text-xs text-subtle">{stateLabel()}</Text>
        </View>
      </View>
      <Text class="text-sm font-medium text-foreground" testID="chat-solo-thread-title">
        {title()}
      </Text>
      <If when={thread().workspace}>
        <View class="flex-row items-center gap-1.5" accessibilityLabel={t("chat_solo_source_workspace", { name: thread().workspace })}>
          <Icon name="PhFolder" size={13} color="muted-foreground" />
          <Text class="min-w-0 shrink font-mono text-xs text-subtle line-clamp-1" testID="chat-solo-thread-workspace">
            {thread().workspace}
          </Text>
        </View>
      </If>
      {props.children}
      <View class="flex-row justify-end">
        <Button
          variant="plain"
          size="xs"
          label={t("chat_solo_thread_open")}
          accessibilityLabel={`${t("chat_solo_thread_open")}: ${title()}`}
          onPress={props.onOpen}
          testID="chat-solo-thread-open"
        />
      </View>
    </View>
  );
}
