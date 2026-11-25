// The chips under a Solo reply (FT186): what its run actually used, in order. The workspace it
// worked in, the threads it started and the topics it read (both open when pressed), and the
// memory and the journal when it searched or changed them. The workspace, memory and journal
// chips open their details in a dialog, in place (FT188, ChatSoloSourceDialog.tsx).
import { Text, View } from "nsh";
import { Icon, Tip, TipButton, type IconName } from "../ui";
import { CONTROL_CORNERS } from "../corners";
import { t } from "./i18n";

export interface SoloSource {
  kind: "workspace" | "thread" | "topic" | "memory" | "journal";
  id: string;
  label: string;
  /** What the run's successful tool calls did with it; none in a record from before FT188. */
  uses?: SoloSourceUse[];
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

export function ChatSoloSources(props: {
  sources: SoloSource[];
  onOpen: (topicID: string) => void;
  /** Opens a workspace, memory or journal chip's details; without it those chips are not pressed. */
  onDetails?: (source: SoloSource) => void;
}) {
  const pressed = (source: SoloSource) => soloSourceOpensTopic(source) || (soloSourceHasDetails(source) && Boolean(props.onDetails));
  const press = (source: SoloSource) => (soloSourceOpensTopic(source) ? props.onOpen(source.id) : props.onDetails?.(source));
  /** What a chip that opens details says it does; a topic chip keeps its name (it opens what it names). */
  const name = (source: SoloSource) =>
    soloSourceOpensTopic(source) ? soloSourceName(source) : t("chat_solo_source_details_open", { name: soloSourceName(source) });
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
            </TipButton>
          </If>
        )}
      </Each>
    </View>
  );
}
