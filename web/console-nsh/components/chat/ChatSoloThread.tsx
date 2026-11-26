// A work thread in Solo (FT186): the card Solo shows when it starts a thread, following the
// thread's state (running, waiting for the person, done, failed, stopped), and the summary it gets
// when the thread ends. Both name the thread and its workspace and open the thread when pressed;
// the summary's text (the thread's own reply, or why it failed) comes as children.
// Both also show who worked on the thread's task (FT189): its newest subagents and coders, each
// with its avatar, name and state, and how many more there were. They are the task's workers, not
// the agent that runs the thread, and they only show: the thread itself opens from the card.
import type { JSX } from "nsh";
import { Text, View } from "nsh";
import { Button, Icon, StatusMark, type StatusState } from "../ui";
import { CARD_CORNERS } from "../corners";
import { localeState } from "../../lib/core/context.js";
import { soloParticipantRoster } from "../../lib/core/solo.js";
import { WorkerAvatar, WorkerStateDot, workerKindLabel, workerStateLabel } from "./ChatWorkerRoster";
import { t } from "./i18n";

/** A subagent or coder of a thread's task, as its record lists it. */
export interface SoloParticipant {
  id: string;
  name: string;
  nameSet?: string;
  nameIndex?: number;
  avatarIndex?: number;
  kind: "subagent" | "coder";
  status: string;
}

/** A participant as a card or a chip shows it (lib/core/solo.js `soloParticipantRoster`). */
export interface SoloParticipantShown extends SoloParticipant {
  displayName: string;
  avatarStyle: string;
  state: string;
}

export interface SoloRoster {
  shown: SoloParticipantShown[];
  /** The workers there are beyond the ones shown. */
  more: number;
}

/** Who a thread record shows, named in the Console's language. */
export function soloThreadRoster(thread: SoloThreadView | null | undefined): SoloRoster {
  return soloParticipantRoster(thread, localeState.lang) as SoloRoster;
}

/** A participant in words: its name, what it is and how it is doing. */
export function soloParticipantLabel(worker: SoloParticipantShown) {
  return t("chat_solo_participant_label", { name: worker.displayName, kind: workerKindLabel(worker), state: workerStateLabel(worker.state) });
}

/** The task's workers on its card: avatar, name and state for the newest few, then how many more. */
function SoloParticipants(props: { roster: SoloRoster }) {
  return (
    <View class="flex-row flex-wrap items-center gap-1.5" accessibilityLabel={t("chat_solo_participants_label")} testID="chat-solo-participants">
      <Each of={props.roster.shown} key={(worker) => worker.id}>
        {(worker) => (
          <View
            class="max-w-full flex-row items-center gap-1.5 rounded-full border border-line-faint py-0.5 pl-0.5 pr-2"
            accessibilityLabel={soloParticipantLabel(worker())}
            testID={`chat-solo-participant.${worker().kind}.${worker().state}`}
          >
            <WorkerAvatar avatarStyle={worker().avatarStyle} testID={`chat-solo-participant-avatar.${worker().avatarStyle}`} />
            <Text class="min-w-0 shrink text-xs text-foreground line-clamp-1" testID="chat-solo-participant-name">
              {worker().displayName}
            </Text>
            <WorkerStateDot state={worker().state} />
          </View>
        )}
      </Each>
      <If when={props.roster.more > 0}>
        <Text
          class="text-xs text-muted-foreground"
          accessibilityLabel={t("chat_solo_participants_more_label", { count: props.roster.more })}
          testID="chat-solo-participants-more"
        >
          {t("chat_solo_participants_more", { count: props.roster.more })}
        </Text>
      </If>
    </View>
  );
}

export interface SoloThreadView {
  kind: "card" | "summary";
  topicID: string;
  taskID: string;
  title: string;
  workspace: string;
  state: "running" | "waiting" | "done" | "failed" | "canceled";
  summary: string;
  continued: boolean;
  /** The subagents and coders of the thread's task, in the order they started; none in an older record. */
  participants?: SoloParticipant[];
  /** How many earlier ones the record no longer lists. */
  participantsOmitted?: number;
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
  const roster = () => soloThreadRoster(thread());
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
      <If when={roster().shown.length > 0}>
        <SoloParticipants roster={roster()} />
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
