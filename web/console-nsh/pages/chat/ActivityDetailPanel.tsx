// The temporary detail panel: a reply's plan, progress or reasoning, or one of its workers' output,
// opened from the reply's compact entry points (ChatStatusCard's columns, ChatWorkerRoster's chips)
// instead of unfolding inside the conversation. On wide windows it is in the frame's workbench,
// docked under the window (components/frame/Workbench.tsx), and the topic and workspace panel stays;
// on phones the right sheet, in the workspace panel's place.
//
// A plan, progress, reasoning and a worker's output are drawn on one dark terminal (ChatTerminal);
// reasoning as plain mono text, as written (no markdown).
//
// It reads the reply from the live history by id (activityDetail.ts), so a plan, progress,
// reasoning or output still streaming keeps growing here; its scroller follows the end of what
// grows at the end (progress, output, reasoning being written) unless the reader scrolled up.
//
// Its head is its title (the panel's name, or the worker's), what it belongs to (the message the
// reply answers; not for progress or a coder's output, see `showContext`) and close; Escape closes
// it beside the conversation, and on phones the sheet's own Escape, Back and scrim do.
import { cleanup, effect, Image, keymap, Text, View } from "nsh";
import { Icon, popupOpen, StatusMark, Tip, TipButton } from "../../components/ui";
import { CHROME_BAR_HEIGHT } from "../../components/frame/metrics";
import { ICONS } from "../../components/icons";
import { activityDetailKey, type ActivityDetailRef } from "../../components/chat/activityDetail";
import type { ArtifactPreviews } from "../../components/chat/ArtifactPreviewCard";
import type { HistoryItem } from "../../components/chat/ChatHistoryItem";
import { activityEntries, ChatActivityEntries, ChatPlanSteps, planProgress } from "../../components/chat/ChatStatusCard";
import { ChatTerminal, TERMINAL_BG, TERMINAL_FG, TERMINAL_MUTED, TERMINAL_NOTE } from "../../components/chat/ChatTerminal";
import { ChatWorkerOutput, replyWorkers, WorkerAvatar } from "../../components/chat/ChatWorkerRoster";
import { OverflowWraps } from "../../components/chat/OverflowLine";
import { t } from "../../components/chat/i18n";
import { PinnedScroll } from "../../components/chat/PinnedScroll";
import { taskWaitingForAnswer } from "../../lib/core/chat-task-history.js";
import { workerAsk } from "../../lib/core/chat-workers.js";

function taskStatus(item: HistoryItem | null) {
  const value = String(item?.status || "").trim().toLowerCase();
  return ["queued", "running", "pending", "done", "failed", "canceled"].includes(value) ? value : "queued";
}

function terminal(status: string) {
  return status === "done" || status === "failed" || status === "canceled";
}

/**
 * The panel's close: a 38pt square at the head's end (32pt on phones); in the workbench a 30pt
 * square (32pt on phones) in its top right corner, as far from the top as from the right.
 */
const CORNER = 8;
const cornerClose = (phone?: boolean) => (phone ? 32 : 30);
function CloseButton(props: { phone?: boolean; dark?: boolean; onPress: () => void }) {
  return (
    <TipButton
      accessibilityLabel={t("action_close")}
      tooltip={<Tip text={t("action_close")} />}
      onPress={props.onPress}
      testID="chat-detail-close"
      class={`${props.phone ? "size-8" : props.dark ? "size-[30px]" : "size-[38px]"} items-center justify-center rounded-(--radius) transition-colors duration-[180ms] ${props.dark ? "hover:bg-white/10" : "hover:bg-hover-soft"}`}
    >
      {/* On the dark panel the terminal's light ink (no theme token is light on it). */}
      <If when={props.dark} else={<Icon name="PhX" size={props.phone ? 16 : 14} color="subtle" />}>
        <Image
          src={ICONS.PhX}
          accessibilityElementsHidden
          style={{ width: props.phone ? 16 : 14, height: props.phone ? 16 : 14, tintColor: "#e8eef5d1" }}
        />
      </If>
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
  /** The agent's name, for a worker's conversation ("Agent" when unknown). */
  agentName?: string;
  /**
   * Drawn on the terminal's dark ink with no frame padding (the workbench): the plan, progress,
   * reasoning and output run edge to edge on the panel itself.
   */
  dark?: boolean;
  /** Whether Escape closes it (false while a dialog is over the page). */
  escape?: boolean;
  class?: string;
  onClose: () => void;
}) {
  // Beside the conversation, Escape closes it, also from the composer (where Escape types nothing).
  // A dialog of the page (`escape` false) or any popup over it (a dialog, a menu, a select, the
  // composer's suggestions: `popupOpen`, whether it opened before the panel or after) gets Escape
  // instead: the binding is dropped meanwhile, since a binding that fires takes the key. The phone's
  // sheet takes Escape and Back itself.
  effect(() => {
    if (props.phone || props.escape === false || popupOpen()) return;
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
    if (item() && taskWaitingForAnswer(item())) return "pending";
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
  // Progress and output grow at their end, and reasoning and a plan while their task runs: the
  // scroller starts there and follows until the reader scrolls up (PinnedScroll). A finished plan
  // reads from its first step.
  const startPinned = () => kind() === "activity" || kind() === "worker" || ((kind() === "reasoning" || kind() === "plan") && streaming());
  // Progress and a coder's output are the run itself, read beside the conversation that already
  // shows the message they answer: their head is only the title, the mark and close. A plan, the
  // reasoning and a subagent still name what they answer.
  const showContext = () => {
    if (!props.context) return false;
    if (kind() === "activity") return false;
    if (kind() === "worker" && worker()?.kind === "coder") return false;
    return true;
  };

  return (
    <View class={`relative ${props.dark ? TERMINAL_BG : ""} ${props.class ?? ""}`} accessibilityLabel={title()} testID="chat-detail-panel">
      <View
        class={props.dark || props.phone ? "flex-row items-center gap-2 pl-4 pr-3" : "min-h-[46px] flex-row items-center gap-2 pl-4 pr-3 pt-2"}
        style={
          // In the workbench the head's middle is the close button's (it sits CORNER from the top
          // and the right), and the head keeps the button's room at its end.
          props.dark
            ? { height: CORNER * 2 + cornerClose(props.phone), paddingRight: CORNER * 2 + cornerClose(props.phone) }
            : props.phone
              ? { height: CHROME_BAR_HEIGHT }
              : undefined
        }
      >
        <If when={item() && has()}>
          <If when={kind() === "worker" && worker()} else={<StatusMark state={markState()} testID={`chat-detail-mark-${markState()}`} />}>
            <WorkerAvatar avatarStyle={worker()?.avatarStyle ?? ""} />
          </If>
        </If>
        <Text class={`min-w-0 flex-1 text-[15px] font-semibold leading-[22px] line-clamp-1 ${props.dark ? TERMINAL_FG : "text-foreground"}`} role="header" testID="chat-detail-title">
          {title()}
        </Text>
        <If when={figure()}>
          <Text class={`font-mono text-xs ${props.dark ? TERMINAL_MUTED : "text-muted-foreground"}`} testID="chat-detail-figure">
            {figure()}
          </Text>
        </If>
        <If when={!props.dark}>
          <CloseButton phone={props.phone} onPress={() => props.onClose()} />
        </If>
      </View>
      <If when={showContext()}>
        <Text class={`px-4 pb-2 text-xs leading-[18px] line-clamp-2 ${props.dark ? TERMINAL_MUTED : "text-muted-foreground"}`} testID="chat-detail-context">
          {props.context}
        </Text>
      </If>
      <If
        when={item() && has()}
        else={
          <View class="px-4 py-3" testID="chat-detail-empty">
            <Text class={`text-sm ${props.dark ? TERMINAL_MUTED : "text-muted-foreground"}`}>
              {kind() === "worker" && item() ? t("chat_worker_no_output") : t("chat_detail_empty")}
            </Text>
          </View>
        }
      >
        {/* In the workbench its scroller is the only one: long runs and code wrap (OverflowWraps). */}
        <OverflowWraps.Provider value={Boolean(props.dark)}>
          <PinnedScroll
            resetKey={activityDetailKey(props.detail)}
            startPinned={startPinned()}
            class="flex-1"
            contentClass={props.dark ? "" : "px-3 pb-4 pt-1"}
            testID={`chat-detail-${kind()}`}
          >
            <If when={kind() === "plan"}>
              <ChatTerminal flush={props.dark}>
                <ChatPlanSteps itemID={props.detail.itemID} plan={item()?.plan} />
              </ChatTerminal>
            </If>
            <If when={kind() === "activity"}>
              <ChatTerminal flush={props.dark}>
                <ChatActivityEntries itemID={props.detail.itemID} activity={{ ...(item()?.activity ?? {}), history: entries(), current: null }} />
              </ChatTerminal>
            </If>
            <If when={kind() === "reasoning"}>
              {/* As written, in the terminal's mono note style (no markdown), as progress is. */}
              <ChatTerminal flush={props.dark}>
                <View selectable>
                  <Text class={`font-mono text-xs leading-[19px] ${TERMINAL_NOTE}`} testID="chat-detail-reasoning-text">
                    {reasoning()}
                  </Text>
                </View>
              </ChatTerminal>
            </If>
            <If when={kind() === "worker" && worker()}>
              {(entry) => (
                <ChatTerminal flush={props.dark}>
                  <ChatWorkerOutput
                    worker={entry()}
                    ask={workerAsk(item()?.activity, entry())}
                    agentName={props.agentName}
                    itemID={props.detail.itemID}
                  />
                </ChatTerminal>
              )}
            </If>
          </PinnedScroll>
        </OverflowWraps.Provider>
      </If>
      <If when={props.dark}>
        <View class="absolute" style={{ top: CORNER, right: CORNER }}>
          <CloseButton phone={props.phone} dark onPress={() => props.onClose()} />
        </View>
      </If>
    </View>
  );
}

