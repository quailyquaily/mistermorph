// The temporary detail panel: a reply's plan, progress or reasoning, or one of its workers' output,
// opened from the reply's compact entry points (ChatStatusCard's columns, ChatWorkerRoster's chips)
// instead of unfolding inside the conversation. It takes the place of the topic and workspace
// panel (the page has one right panel: opening either closes the other), in the same shell: a
// 314pt column beside the conversation on wide windows, the right sheet on phones.
//
// It reads the reply from the live history by id (activityDetail.ts), so a plan, progress,
// reasoning or output still streaming keeps growing here; its scroller follows the end of what
// grows at the end (progress, output, reasoning being written) unless the reader scrolled up.
//
// Its head is its title (the panel's name, or the worker's), what it belongs to (the message the
// reply answers) and close; Escape closes it beside the conversation, and on phones the sheet's
// own Escape, Back and scrim do.
import { cleanup, effect, keymap, Text, View } from "nsh";
import { Icon, StatusMark, Tip, TipButton } from "../../components/ui";
import { CHROME_BAR_HEIGHT } from "../../components/frame/metrics";
import { activityDetailKey, type ActivityDetailRef } from "../../components/chat/activityDetail";
import type { ArtifactPreviews } from "../../components/chat/ArtifactPreviewCard";
import type { HistoryItem } from "../../components/chat/ChatHistoryItem";
import { ChatRichContent } from "../../components/chat/ChatRichContent";
import { activityEntries, ChatActivityEntries, ChatPlanSteps, planProgress, TERMINAL_BG } from "../../components/chat/ChatStatusCard";
import { ChatWorkerOutput, replyWorkers, WorkerAvatar } from "../../components/chat/ChatWorkerRoster";
import { t } from "../../components/chat/i18n";
import { PinnedScroll } from "../../components/chat/PinnedScroll";

function taskStatus(item: HistoryItem | null) {
  const value = String(item?.status || "").trim().toLowerCase();
  return ["queued", "running", "pending", "done", "failed", "canceled"].includes(value) ? value : "queued";
}

function terminal(status: string) {
  return status === "done" || status === "failed" || status === "canceled";
}

/** The panel's close: a 38pt square where the workspace panel's toggle sits (32pt on phones). */
function CloseButton(props: { phone?: boolean; onPress: () => void }) {
  return (
    <TipButton
      accessibilityLabel={t("action_close")}
      tooltip={<Tip text={t("action_close")} />}
      onPress={props.onPress}
      testID="chat-detail-close"
      class={`${props.phone ? "size-8" : "size-[38px]"} items-center justify-center rounded-(--radius) transition-colors duration-[180ms] hover:bg-hover-soft`}
    >
      <Icon name="PhX" size={props.phone ? 16 : 14} color="subtle" />
    </TipButton>
  );
}

export function ActivityDetailPanel(props: {
  detail: ActivityDetailRef;
  /** The reply, looked up live; null once it is gone. */
  item: HistoryItem | null;
  /** What the reply answers (the message before it), "" if unknown. */
  context: string;
  endpointRef: string;
  topicID: string;
  previews: ArtifactPreviews;
  phone?: boolean;
  /** Whether Escape closes it (false while a dialog is over the page). */
  escape?: boolean;
  class?: string;
  onClose: () => void;
}) {
  // Beside the conversation, Escape closes it, also from the composer (where Escape types nothing;
  // the composer's own Escape, closing its suggestions, is bound later and goes first). A dialog
  // over the page (`escape` false) gets Escape instead: the binding is dropped meanwhile, since a
  // binding that fires takes the key. The phone's sheet takes Escape and Back itself.
  effect(() => {
    if (props.phone || props.escape === false) return;
    cleanup(keymap.bind("escape", () => props.onClose(), { when: "always" }));
  });

  const kind = () => props.detail.kind;
  const item = () => props.item;
  const status = () => taskStatus(item());
  const streaming = () => Boolean(item()) && String(item()?.taskId || "").trim() !== "" && !terminal(status());
  const worker = () => (kind() === "worker" ? (replyWorkers(item()?.activity, item()?.status ?? "").find((entry) => entry.id === props.detail.workerID) ?? null) : null);
  const steps = (): any[] => (Array.isArray(item()?.plan?.steps) ? item()!.plan.steps : []);
  const entries = () => activityEntries(item()?.activity).filter((entry: any) => entry?.kind !== "retry");
  const reasoning = () => String(item()?.reasoning ?? "").trim();

  const title = () => {
    switch (kind()) {
      case "plan":
        return t("chat_plan_title");
      case "activity":
        return t("chat_activity_title");
      case "reasoning":
        return t("chat_reasoning_title");
      default:
        return worker()?.displayName || t("chat_workers_title");
    }
  };
  const figure = () => (kind() === "plan" && steps().length > 0 ? planProgress(item()?.plan) : "");
  const markState = () => {
    if (kind() === "worker") {
      const state = String(worker()?.state || "");
      return state === "failed" || state === "canceled" ? "error" : state === "done" ? "on" : "running";
    }
    return status() === "failed" || status() === "canceled" ? "error" : terminal(status()) ? "on" : "running";
  };
  const has = () => {
    switch (kind()) {
      case "plan":
        return steps().length > 0;
      case "activity":
        return entries().length > 0;
      case "reasoning":
        return reasoning() !== "";
      default:
        return worker() !== null;
    }
  };
  // Progress and output grow at their end, and reasoning while it is written: the scroller starts
  // there and follows. A plan reads from its first step.
  const startPinned = () => kind() === "activity" || kind() === "worker" || (kind() === "reasoning" && streaming());

  return (
    <View class={`${props.class ?? ""}`} accessibilityLabel={title()} testID="chat-detail-panel">
      <View
        class={props.phone ? "flex-row items-center gap-2 pl-4 pr-3" : "min-h-[46px] flex-row items-center gap-2 pl-4 pr-3 pt-2"}
        style={props.phone ? { height: CHROME_BAR_HEIGHT } : undefined}
      >
        <If when={item() && has()}>
          <If when={kind() === "worker" && worker()} else={<StatusMark state={markState()} />}>
            <WorkerAvatar avatarStyle={worker()?.avatarStyle ?? ""} />
          </If>
        </If>
        <Text class="min-w-0 flex-1 text-[15px] font-semibold leading-[22px] text-foreground line-clamp-1" role="header" testID="chat-detail-title">
          {title()}
        </Text>
        <If when={figure()}>
          <Text class="font-mono text-xs text-muted-foreground" testID="chat-detail-figure">
            {figure()}
          </Text>
        </If>
        <CloseButton phone={props.phone} onPress={() => props.onClose()} />
      </View>
      <If when={props.context}>
        <Text class="px-4 pb-2 text-xs leading-[18px] text-muted-foreground line-clamp-2" testID="chat-detail-context">
          {props.context}
        </Text>
      </If>
      <If
        when={item() && has()}
        else={
          <View class="px-4 py-3" testID="chat-detail-empty">
            <Text class="text-sm text-muted-foreground">{kind() === "worker" && item() ? t("chat_worker_no_output") : t("chat_detail_empty")}</Text>
          </View>
        }
      >
        <PinnedScroll
          resetKey={activityDetailKey(props.detail)}
          startPinned={startPinned()}
          class="flex-1"
          contentClass="px-3 pb-4 pt-1"
          testID={`chat-detail-${kind()}`}
        >
          <If when={kind() === "plan"}>
            <View class={`gap-2 rounded-(--radius) p-3 ${TERMINAL_BG}`}>
              <ChatPlanSteps itemID={props.detail.itemID} plan={item()?.plan} />
            </View>
          </If>
          <If when={kind() === "activity"}>
            <View class={`gap-2 rounded-(--radius) p-3 ${TERMINAL_BG}`}>
              <ChatActivityEntries itemID={props.detail.itemID} activity={{ ...(item()?.activity ?? {}), history: entries(), current: null }} />
            </View>
          </If>
          <If when={kind() === "reasoning"}>
            <View class="px-1">
              <ChatRichContent
                source={reasoning()}
                ownerKey={`${props.detail.itemID}:reasoning`}
                endpointRef={props.endpointRef}
                fallbackTopicID={props.topicID}
                streaming={streaming()}
                previews={props.previews}
              />
            </View>
          </If>
          <If when={kind() === "worker" && worker()}>
            {(entry) => (
              <View class="px-1">
                <ChatWorkerOutput worker={entry()} />
              </View>
            )}
          </If>
        </PinnedScroll>
      </If>
    </View>
  );
}

