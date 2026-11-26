// The chips under a Solo reply (FT186): what its run actually used, in order. The workspace it
// worked in, the threads it started and the topics it read (both open when pressed), and the
// memory and the journal when it searched or changed them. The workspace, memory and journal
// chips open their details in a dialog, in place (FT188, ChatSoloSourceDialog.tsx).
// The chip of a thread the reply started also shows who worked on that start's task (FT189): the
// avatars of its newest subagents and coders and how many more there were, with their names, kinds
// and states in the chip's name and tooltip. Only that chip, and only while the task's card is in
// the loaded history; any other chip, and that one otherwise, is as it was.
import { Text, View } from "nsh";
import { Icon, Tip, TipButton, type IconName } from "../ui";
import { CONTROL_CORNERS } from "../corners";
import { workerKindLabel, workerStateLabel, WorkerAvatar } from "./ChatWorkerRoster";
import type { SoloRoster } from "./ChatSoloThread";
import { t } from "./i18n";

export interface SoloSource {
  kind: "workspace" | "thread" | "topic" | "memory" | "journal";
  id: string;
  label: string;
  /** What the run's successful tool calls did with it; none in a record from before FT188. */
  uses?: SoloSourceUse[];
  /** On a thread the reply started: the task that start made, when it made exactly one (FT189). */
  taskID?: string;
}

export interface SoloSourceUse {
  action: string;
  count: number;
}

/** Whether pressing the source's chip opens a topic (the thread, the topic read); else it opens its details. */
export function soloSourceOpensTopic(source: SoloSource) {
  return (source.kind === "thread" || source.kind === "topic") && Boolean(source.id);
}

/** Whether the source's chip has details to open: the workspace, the memory and the journal. */
export function soloSourceHasDetails(source: SoloSource) {
  return source.kind === "workspace" || source.kind === "memory" || source.kind === "journal";
}

const ICON: Record<SoloSource["kind"], IconName> = {
  workspace: "PhFolder",
  thread: "PhArrowsSplit",
  topic: "PhChats",
  memory: "PhBrain",
  journal: "PhFileText",
};

const CHIP = `max-w-full flex-row items-center gap-1 ${CONTROL_CORNERS} border border-line-faint px-2 py-0.5`;

/** The chip's words: the workspace's path, the thread's or topic's title, or the source's name. */
export function soloSourceText(source: SoloSource) {
  switch (source.kind) {
    case "memory":
      return t("chat_solo_source_memory");
    case "journal":
      return t("chat_solo_source_journal");
    default:
      return source.label || (source.kind === "workspace" ? source.id : t("chat_topic_untitled"));
  }
}

/** The chip's name for assistive tech and its tooltip: what kind of source, and which. */
export function soloSourceName(source: SoloSource) {
  switch (source.kind) {
    case "memory":
    case "journal":
      return soloSourceText(source);
    default:
      return t(`chat_solo_source_${source.kind}`, { name: soloSourceText(source) });
  }
}

/** A chip's name with the workers its roster shows: who they are, what they are and how they are doing. */
export function soloSourceNameWithRoster(name: string, roster: SoloRoster | null | undefined) {
  if (!roster?.shown.length) return name;
  const list = roster.shown.map((worker) =>
    t("chat_solo_source_participant", { name: worker.displayName, kind: workerKindLabel(worker), state: workerStateLabel(worker.state) }),
  );
  if (roster.more > 0) list.push(t("chat_solo_source_participants_more", { count: roster.more }));
  return t("chat_solo_source_participants", { name, list: list.join(t("chat_solo_source_participants_separator")) });
}

/** The avatars at the end of a thread chip: small, without names (the chip is narrow), then how many more. */
function SourceParticipants(props: { roster: SoloRoster }) {
  return (
    <View class="shrink-0 flex-row items-center gap-0.5" accessibilityElementsHidden testID="chat-solo-source-participants">
      <Each of={props.roster.shown} key={(worker) => worker.id}>
        {(worker) => <WorkerAvatar avatarStyle={worker().avatarStyle} size={14} testID={`chat-solo-source-participant.${worker().kind}.${worker().avatarStyle}`} />}
      </Each>
      <If when={props.roster.more > 0}>
        <Text class="text-xs text-muted-foreground" testID="chat-solo-source-participants-more">
          {t("chat_solo_participants_more", { count: props.roster.more })}
        </Text>
      </If>
    </View>
  );
}

export function ChatSoloSources(props: {
  sources: SoloSource[];
  onOpen: (topicID: string) => void;
  /** Opens a workspace, memory or journal chip's details; without it those chips are not pressed. */
  onDetails?: (source: SoloSource) => void;
  /** Who worked on the task a thread chip stands for, or null when the chip stands for no loaded task. */
  participants?: (source: SoloSource) => SoloRoster | null;
}) {
  const pressed = (source: SoloSource) => soloSourceOpensTopic(source) || (soloSourceHasDetails(source) && Boolean(props.onDetails));
  const press = (source: SoloSource) => (soloSourceOpensTopic(source) ? props.onOpen(source.id) : props.onDetails?.(source));
  /** What a chip that opens details says it does; a topic chip keeps its name (it opens what it names). */
  const roster = (source: SoloSource): SoloRoster | null => {
    const found = source.kind === "thread" ? props.participants?.(source) : null;
    return found && found.shown.length > 0 ? found : null;
  };
  const name = (source: SoloSource) =>
    soloSourceOpensTopic(source)
      ? soloSourceNameWithRoster(soloSourceName(source), roster(source))
      : t("chat_solo_source_details_open", { name: soloSourceName(source) });
  return (
    <View class="flex-row flex-wrap gap-1.5" accessibilityLabel={t("chat_solo_sources_label")} testID="chat-solo-sources">
      <Each of={props.sources} key={(source) => `${source.kind}:${source.id}`}>
        {(source) => (
          <If
            when={pressed(source())}
            else={
              <View class={CHIP} accessibilityLabel={soloSourceName(source())} testID={`chat-solo-source-${source().kind}`}>
                <Icon name={ICON[source().kind]} size={12} color="muted-foreground" />
                <Text class="min-w-0 shrink text-xs text-subtle line-clamp-1">{soloSourceText(source())}</Text>
              </View>
            }
          >
            <TipButton
              onPress={() => press(source())}
              accessibilityLabel={name(source())}
              tooltip={<Tip text={name(source())} />}
              class={`${CHIP} transition-colors duration-150 hover:bg-hover-soft focus:bg-hover-soft`}
              testID={`chat-solo-source-${source().kind}`}
            >
              <Icon name={ICON[source().kind]} size={12} color="muted-foreground" />
              <Text class="min-w-0 shrink text-xs text-subtle line-clamp-1">{soloSourceText(source())}</Text>
              <If when={roster(source())}>{(found) => <SourceParticipants roster={found()} />}</If>
            </TipButton>
          </If>
        )}
      </Each>
    </View>
  );
}
