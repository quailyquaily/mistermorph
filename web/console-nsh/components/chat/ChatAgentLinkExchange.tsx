// The messages a task exchanged with other agents over Agent Link, shown before its reply. It opens
// unfolded; the header folds it (kept per message by the page, since rows recycle). Ported from
// web/console/src/components/ChatAgentLinkExchange.js.
import { Text, View } from "nsh";
import { Button as BaseButton } from "nsh/base";
import { Icon } from "../ui";
import type { ArtifactPreviews } from "./ArtifactPreviewCard";
import { ChatRichContent } from "./ChatRichContent";
import { t } from "./i18n";
import type { KeyedState } from "./rowState";

function timeText(raw: unknown) {
  const date = new Date(String(raw || "").trim());
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function dotClass(direction: string) {
  return direction === "pending" ? "border-status-pending" : direction === "reply" ? "bg-status-on border-status-on" : "border-status-on";
}

export function ChatAgentLinkExchange(props: {
  itemID: string;
  messages: any[];
  endpointRef: string;
  topicID: string;
  folded: KeyedState<boolean>;
  previews: ArtifactPreviews;
}) {
  const open = () => props.folded.get(props.itemID) !== true;
  const peers = () => {
    const names: string[] = [];
    for (const message of props.messages) {
      const name = message.peer || t("chat_agentlink_peer_unknown");
      if (!names.includes(name)) names.push(name);
    }
    return names.join(", ");
  };
  const count = () => props.messages.filter((message) => message.direction !== "pending").length;
  const label = (message: any) => {
    const peer = message.peer || t("chat_agentlink_peer_unknown");
    if (message.direction === "sent") return t("chat_agentlink_to", { peer });
    if (message.direction === "reply") return t("chat_agentlink_from", { peer });
    return t("chat_agentlink_pending", { peer });
  };

  return (
    <If when={props.messages.length > 0}>
      <View class="gap-2" testID="chat-agentlink">
        <BaseButton
          onPress={() => props.folded.set(props.itemID, open())}
          selected={open()}
          accessibilityLabel={t("chat_agentlink_title")}
          class="flex-row items-center gap-1.5 self-start rounded-(--radius) px-1.5 py-0.5 hover:bg-hover"
        >
          <Text class="font-mono text-xs uppercase text-muted-foreground">{t("chat_agentlink_title")}</Text>
          <Text class="text-xs text-foreground">{peers()}</Text>
          <If when={count() > 0}>
            <Text class="text-xs text-muted-foreground">{t("chat_agentlink_count", { count: count() })}</Text>
          </If>
          <Icon name={open() ? "PhCaretUp" : "PhCaretDown"} size={11} color="muted-foreground" />
        </BaseButton>
        <If when={open()}>
          <View class="gap-3 border-l border-line-faint pl-3">
            <Each of={props.messages} key={(message) => message.key}>
              {(message) => (
                <View class="flex-row gap-2">
                  <View class={`mt-1.5 size-2 border ${dotClass(message().direction)}`} />
                  <View class="flex-1 gap-1">
                    <View class="flex-row items-center gap-2">
                      <Text class="text-xs font-medium text-subtle">{label(message())}</Text>
                      <If when={timeText(message().at)}>
                        <Text class="font-mono text-xs text-muted-foreground">{timeText(message().at)}</Text>
                      </If>
                    </View>
                    <If when={message().text}>
                      <ChatRichContent
                        source={message().text}
                        ownerKey={`${props.itemID}:agentlink:${message().key}`}
                        endpointRef={props.endpointRef}
                        fallbackTopicID={props.topicID}
                        previews={props.previews}
                      />
                    </If>
                  </View>
                </View>
              )}
            </Each>
          </View>
        </If>
      </View>
    </If>
  );
}
