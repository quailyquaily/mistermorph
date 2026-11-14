// One message of the conversation (the Vue console's ChatHistoryItem): a person's message with its
// files, or the agent's reply with what it did on the way (status card, workers, step messages,
// received files, questions, password requests, Agent Link messages), its reply text or the wait
// before it, an approval it asks for, and copy. The plan, progress, reasoning and workers are
// compact entry points only: their details open in the temporary panel beside the conversation.
//
// It is a List row: it is made once per cell and shows whatever item the cell holds now, so every
// value is read from `props.item` in a binding and per-item state lives in ChatRowContext.
import type { JSX, ViewRef } from "nsh";
import {
  Canvas,
  cleanup,
  createAnimatedValue,
  createMotion,
  Easing,
  effect,
  Image,
  platform,
  Text,
  token,
  untracked,
  View,
  windowSize,
} from "nsh";
import { MOTION_EASE, MOTION_SLOW, motionMs } from "../motion/tokens";
import { Button as BaseButton } from "nsh/base";
import { ICONS } from "../icons";
import { Button, Icon, StatusMark, Tip, TipButton } from "../ui";
import { approvalParameterEntries, skillInstallApproval } from "../../lib/core/chat-approvals.js";
import { agentLinkMessages, insightMessages, planStepMessages, pollingActionWord, taskWaitingForAnswer } from "../../lib/core/chat-task-history.js";
import { activityDetailKey, activityDetailWorkerID, type ActivityDetailRef } from "./activityDetail";
import type { ArtifactPreviews } from "./ArtifactPreviewCard";
import { ChatAgentLinkExchange } from "./ChatAgentLinkExchange";
import { ChatElevationCard, type ElevationAnswer, type ElevationState } from "./ChatElevationCard";
import { ChatQuestionCard, type QuestionAnswer, type QuestionState } from "./ChatQuestionCard";
import { ChatRichContent } from "./ChatRichContent";
import { ChatSkillInstallPreview } from "./ChatSkillInstallPreview";
import { ChatStatusCard } from "./ChatStatusCard";
import { ChatStatusMark } from "./ChatStatusMark";
import { ChatSystemMessage } from "./ChatSystemMessage";
import { ChatWorkerRoster } from "./ChatWorkerRoster";
import { t } from "./i18n";
import { MosaicText } from "./MosaicText";
import { ReceivedFile, type ReceivedFiles } from "./ReceivedFile";
import type { KeyedState } from "./rowState";
import { BUBBLE_CLASS, FILES_CLASS, fileRowCornerClass } from "./userBubble";
import { boundsFrame, createPartProbe, type LayoutBounds, type PartFrame, type PartLayoutListener } from "../shared/partProbe";
import { CHECK_CORNER_AT, CHECK_DRAW_MS, CHECK_SIZE, checkAction, checkDash, checkDashOffset, checkStroke } from "./copyCheck";

export type HistoryItem = Record<string, any> & { id: string; role: string; text: string };

/** What every row of the conversation shares: the page's state by item, and its handlers. */
export interface ChatRowContext {
  endpointRef: () => string;
  topicID: () => string;
  copiedItemID: () => string;
  /** Counts successful copies, so a copy repeated while the check still shows plays again. */
  copySeq: () => number;
  /** What the temporary detail panel shows (activityDetail.ts), or null. */
  detail: () => ActivityDetailRef | null;
  /** The entry point (`activityDetailKey`) that takes the keyboard focus back now, "" otherwise. */
  focusReturn: () => string;
  autoPreviewItemID: () => string;
  previews: ArtifactPreviews;
  receivedFiles: ReceivedFiles;
  questions: KeyedState<QuestionState>;
  elevations: KeyedState<ElevationState>;
  folds: KeyedState<boolean>;
  onCopy: (item: HistoryItem) => void;
  onPreviewFile: (item: any) => void;
  /** Opens an entry in the detail panel, or closes it when it already shows that entry. */
  onOpenDetail: (detail: ActivityDetailRef) => void;
  onTimeClick: (item: HistoryItem) => void;
  onApprove: (item: HistoryItem) => void;
  onDeny: (item: HistoryItem) => void;
  onQuestionAnswer: (item: HistoryItem, answer: QuestionAnswer) => void;
  onElevationAnswer: (item: HistoryItem, answer: ElevationAnswer) => void;
}

function roleOf(item: HistoryItem | undefined) {
  return String(item?.role || "").trim().toLowerCase();
}

function normalizeTaskStatus(raw: unknown) {
  const value = String(raw || "").trim().toLowerCase();
  return ["queued", "running", "pending", "done", "failed", "canceled"].includes(value) ? value : "queued";
}

function isTerminalStatus(status: string) {
  return status === "done" || status === "failed" || status === "canceled";
}

function fileKind(file: any) {
  const match = /\.([a-z0-9]{1,6})$/i.exec(String(file?.name || ""));
  return match ? match[1].toUpperCase() : "";
}

// Arrivals already played (by id): a row bound again later does not replay its entrance.
const playedArrivals = new Set<string>();

// Where a pointer hovers (desktops, desktop browsers), a message's copy button shows while the
// pointer is over the message; touch screens have no hover, so there it always shows.
const HOVER = platform.desktop;

/** A sent message's bubble: white paper and a hairline edge, its corners 14pt round but the top
 * right, which stays 2pt where the tail was (design/ui-refresh.html §3). It is one frame around the
 * text and the files the message carried (userBubble.ts), so its edge and corners stay whole. A system
 * message's: a dashed box. */
function Bubble(props: { system?: boolean; probe?: Record<string, unknown>; children?: JSX.Element }) {
  return (
    <If
      when={!props.system}
      else={
        <View class="w-full max-w-[612px] self-center rounded-(--radius) border border-dashed border-line-faint px-3.5 pb-[11px] pt-2.5">
          {props.children}
        </View>
      }
    >
      <View class={BUBBLE_CLASS} testID="chat-user-bubble" {...props.probe}>
        {props.children}
      </View>
    </If>
  );
}

/**
 * Copy, under a message: a quiet 24pt square that shows on hover, and a check once copied. Each
 * successful copy draws the check as a pen would (copyCheck.ts): the short stroke down, then the
 * long one up, every time, including a copy repeated while the check still shows. The check keeps
 * the copy icon's 14pt box and nothing scales, so the bubble never shifts; with reduced motion the
 * whole check shows at once.
 */
function CopyButton(props: { copied: boolean; copySeq: number; label: string; onPress: () => void }) {
  const stroke = checkStroke(CHECK_SIZE);
  const dash = checkDash(stroke);
  const drawn = createAnimatedValue(0);
  cleanup(() => void drawn.stop());
  let seen = untracked(() => props.copySeq);
  effect(() => {
    const seq = props.copySeq;
    const copied = props.copied;
    untracked(() => {
      const action = checkAction(seen, seq, copied, motionMs(1) === 0);
      seen = seq;
      if (action === "show") drawn.set(1);
      if (action !== "draw") return;
      drawn.set(0);
      void drawn.keyframes(
        [
          { offset: 0, value: 0, easing: Easing.bezier(0.45, 0, 0.55, 1) },
          { offset: CHECK_CORNER_AT, value: stroke.corner, easing: Easing.bezier(0.3, 0, 0.2, 1) },
          { offset: 1, value: 1 },
        ],
        { duration: CHECK_DRAW_MS },
      );
    });
  });
  return (
    <TipButton
      onPress={props.onPress}
      accessibilityLabel={props.label}
      tooltip={<Tip text={props.label} />}
      testID="chat-copy"
      class={`-mt-0.5 size-6 items-center justify-center rounded-(--radius) transition duration-150 hover:bg-press hover:opacity-100 focus:opacity-100 ${
        props.copied ? "opacity-70" : HOVER ? "opacity-0 group-hover:opacity-70" : "opacity-70"
      }`}
    >
      <Image
        src={ICONS.PhCopy}
        accessibilityElementsHidden
        class="absolute transition duration-150"
        style={{ width: CHECK_SIZE, height: CHECK_SIZE, tintColor: token("muted-foreground") as string, opacity: props.copied ? 0 : 1 }}
      />
      {/* The check appears at once (its stroke is what moves) and fades when it expires; its test id
          marks it only while it holds. */}
      <Canvas
        accessibilityElementsHidden
        testID={props.copied ? "chat-copy-check" : undefined}
        class="absolute"
        style={{
          width: CHECK_SIZE,
          height: CHECK_SIZE,
          opacity: props.copied ? 1 : 0,
          transitionProperty: "opacity",
          transitionDuration: props.copied ? 0 : motionMs(150),
          pointerEvents: "none",
        }}
        draw={(cx) => {
          const [a, b, c] = stroke.points;
          cx.strokeStyle = String(token("blue"));
          cx.lineWidth = stroke.width;
          cx.lineCap = "round";
          cx.lineJoin = "round";
          cx.setLineDash(dash.segments);
          cx.lineDashOffset = drawn.interpolate({ inputRange: [0, 1], outputRange: [checkDashOffset(stroke, 0), checkDashOffset(stroke, 1)] });
          cx.beginPath();
          cx.moveTo(a[0], a[1]);
          cx.lineTo(b[0], b[1]);
          cx.lineTo(c[0], c[1]);
          cx.stroke();
        }}
      />
    </TipButton>
  );
}

/** Under the open question, while the run waits for its answer: the orange mark of a task waiting
 *  for the person and the words, mono 11 caps like the card's labels, in the place of the word the
 *  reply shows while it works. */
function WaitingForAnswer() {
  return (
    <View class="h-5 flex-row items-center gap-2" role="text" accessibilityLabel={t("chat_question_waiting")} testID="chat-waiting-answer">
      <StatusMark state="pending" size={7} />
      <Text class="font-mono text-[11px] leading-4 uppercase tracking-[0.04em] text-muted-foreground">{t("chat_question_waiting")}</Text>
    </View>
  );
}

export function ChatHistoryItem(props: {
  item: HistoryItem;
  ctx: ChatRowContext;
  arriving?: (id: string) => boolean;
  /** The row's view, once (ChatHistoryList's `onRowRef`). */
  rowRef?: (ref: ViewRef) => void;
  /** Tests: where a sent message's parts lie (`bubble`, `text`, `files`, `file-<n>`). */
  onPartLayout?: PartLayoutListener;
}) {
  const item = () => props.item;
  const ctx = props.ctx;
  // A message that just joined the thread: a sent one rises from the composer (14pt), a reply
  // settles in place (4pt), fading in over the slow motion token. The cell is recycled, so the
  // motion plays once per arriving item and is put back at rest when the cell shows another one.
  const arrival = createMotion();
  let shownID = "";
  effect(() => {
    const id = String(item()?.id ?? "");
    const user = roleOf(item()) === "user";
    untracked(() => {
      if (id === shownID) return;
      shownID = id;
      if (props.arriving?.(id) && !playedArrivals.has(id)) {
        playedArrivals.add(id);
        void arrival.play({ duration: MOTION_SLOW, easing: MOTION_EASE, keyframes: { opacity: [0, 1], translateY: [user ? 14 : 4, 0] } });
      } else {
        arrival.reset();
      }
    });
  });
  const parts = createPartProbe(() => props.onPartLayout);
  let filesNode: ViewRef | undefined;
  const fileFrames = new Map<number, PartFrame>();
  const role = () => roleOf(item());
  const isAgent = () => role() === "agent";
  const contextCompact = () => String(item()?.presentation || "").trim().toLowerCase() === "context-compact";
  const status = () => normalizeTaskStatus(item()?.status);

  const stepMessages = () => (isAgent() ? [...insightMessages(item()?.insights), ...planStepMessages(item()?.plan)] : []);
  const questions = (): any[] => (isAgent() && Array.isArray(item()?.questions) ? item().questions : []);
  const elevations = (): any[] => (isAgent() && Array.isArray(item()?.elevations) ? item().elevations : []);
  // The run waits for the person's answer to its question (ask_user): it says so, not that it works.
  const waitingForAnswer = () => isAgent() && taskWaitingForAnswer(item());
  const questionOpen = () =>
    waitingForAnswer() ||
    questions().some((question) => question.status === "open") ||
    elevations().some((elevation) => elevation.status === "open");
  const reasoningVisible = () => String(item()?.reasoning || "").trim() !== "";
  const activityEntries = (): any[] => {
    const activity = item()?.activity;
    const entries = Array.isArray(activity?.history) ? activity.history.filter(Boolean) : [];
    if (activity?.current && !entries.some((entry: any) => entry.id === activity.current.id)) return [...entries, activity.current];
    return entries;
  };
  const agentLink = () => (isAgent() ? agentLinkMessages({ history: activityEntries() }) : []);
  const retryNotices = () => (isAgent() ? activityEntries().filter((entry) => entry.kind === "retry") : []);
  const taskActivity = () => {
    const history = activityEntries().filter((entry) => entry.kind !== "retry");
    const current = item()?.activity?.current;
    return history.length > 0 ? { history, current: current && current.kind !== "retry" ? current : history[history.length - 1] } : null;
  };
  const userFiles = (): any[] => (role() === "user" && Array.isArray(item()?.files) ? item().files : []);
  // The bubble's text block: always, but for a message of files alone.
  const textBlockVisible = () => String(item()?.text ?? "") !== "" || userFiles().length === 0;

  const approvalStatus = () => {
    const value = String(item()?.approval?.status || "").trim().toLowerCase();
    return value === "denied" || value === "expired" ? value : "pending";
  };
  const approvalVisible = () => isAgent() && String(item()?.approval?.approvalRequestID || "").trim() !== "";
  const approvalPending = () => approvalStatus() === "pending";
  const approvalMessage = () => String(item()?.approval?.message || item()?.text || "").trim();
  const approvalToolName = () => String(item()?.approval?.toolName || "").trim();
  const approvalReasons = (): string[] => (Array.isArray(item()?.approval?.reasons) ? item().approval.reasons : []);
  const skillInstall = () => skillInstallApproval(item()?.approval);
  const approvalParams = () => (skillInstall() ? [] : approvalParameterEntries(item()?.approval?.toolParams));
  const approveDisabled = () => Boolean(item()?.approvalBusy) || Boolean(skillInstall() && !skillInstall()?.canApprove);
  const approvalMessageVisible = () =>
    approvalPending() && approvalMessage() !== "" && approvalReasons().length === 0 && approvalParams().length === 0;
  const approvalHeading = () => (approvalPending() ? t("chat_approval_title") : String(item()?.text || approvalMessage()).trim());

  const bubbleVisible = () => !approvalVisible() && String(item()?.text || "") !== "";
  const awaitingWord = () =>
    isAgent() && item()?.awaiting === true && !questionOpen() && !isTerminalStatus(status())
      ? pollingActionWord(item()?.pendingSeed || item()?.taskId || item()?.id)
      : "";
  const copyAvailable = () =>
    !contextCompact() &&
    !approvalVisible() &&
    (isAgent() || role() === "user") &&
    String(item()?.text || "").trim() !== "" &&
    !awaitingWord() &&
    !(questionOpen() && item()?.awaiting === true);
  const streaming = () => isAgent() && String(item()?.taskId || "").trim() !== "" && !isTerminalStatus(status());
  const statusIsDuration = () => item()?.durationVisible === true && String(item()?.durationText || "").trim() !== "";
  const statusText = () => String(statusIsDuration() ? item()?.durationText : item()?.timeText || "").trim();
  const statusLabel = () => (statusIsDuration() ? t("chat_task_duration_thought", { duration: statusText() }) : statusText());
  const statusInteractive = () => isAgent() && String(item()?.durationText || item()?.rawJSON || "").trim() !== "";
  // This reply's entry the detail panel shows, and the one that takes the focus back as it closes.
  const shownDetail = () => {
    const detail = ctx.detail();
    return detail && detail.itemID === item()?.id ? detail : null;
  };
  const selectedPanel = () => (shownDetail()?.kind === "worker" ? "" : (shownDetail()?.kind ?? ""));
  const selectedWorker = () => (shownDetail()?.kind === "worker" ? String(shownDetail()?.workerID || "") : "");
  const focusEntry = (kind: string, workerID = "") => {
    const key = ctx.focusReturn();
    return key !== "" && key === activityDetailKey({ itemID: item()?.id, kind: kind as ActivityDetailRef["kind"], workerID });
  };
  const focusPanel = () => (["plan", "activity", "reasoning"].find((kind) => focusEntry(kind)) ?? "");
  const focusWorker = () => activityDetailWorkerID(ctx.focusReturn(), item()?.id);
  const openDetail = (kind: ActivityDetailRef["kind"], workerID?: string) =>
    ctx.onOpenDetail({ itemID: item()?.id, taskID: String(item()?.taskId || "").trim() || undefined, kind, workerID });
  const autoPreview = () => item()?.id !== "" && item()?.id === ctx.autoPreviewItemID();
  const copied = () => item()?.id !== "" && item()?.id === ctx.copiedItemID();

  // The message's time, or for a reply the time it took (ChatStatusMark), alone or first on the
  // reply's summary line.
  const statusMark = (onSummaryLine = false) => (
    <If when={statusText()}>
      <ChatStatusMark
        text={statusText()}
        label={statusLabel()}
        duration={statusIsDuration()}
        onPress={statusInteractive() ? () => ctx.onTimeClick(item()) : undefined}
        placement={onSummaryLine ? "summary" : isAgent() ? "reply" : "sent"}
      />
    </If>
  );

  function previewUserFile(file: any) {
    const endpointRef = String(item()?.endpointRef || "").trim();
    const topicID = String(item()?.topicID || "").trim();
    const previewItems = userFiles().map((entry) => ({ ...entry, endpointRef, topicID, status: "ready" }));
    const index = Math.max(0, previewItems.findIndex((entry) => String(entry?.id || "") === String(file?.id || "")));
    ctx.onPreviewFile({ ...previewItems[index], previewItems });
  }

  const agentBody = () => (
    <View class="max-w-[736px] gap-[7px]">
      <If
        when={item()?.plan || taskActivity() || reasoningVisible()}
        else={statusMark()}
      >
        <ChatStatusCard
          itemID={item()?.id}
          plan={item()?.plan}
          activity={taskActivity()}
          hasReasoning={reasoningVisible()}
          status={item()?.status}
          selectedPanel={selectedPanel()}
          focusPanel={focusPanel()}
          onOpen={(panel) => openDetail(panel as ActivityDetailRef["kind"])}
          summaryPrefix={statusMark(true)}
        />
      </If>
      <If when={item()?.activity?.workers?.length}>
        <ChatWorkerRoster
          itemID={item()?.id}
          activity={item()?.activity}
          status={item()?.status}
          selectedID={selectedWorker()}
          focusID={focusWorker()}
          onSelect={(workerID) => openDetail("worker", workerID)}
        />
      </If>
      <Each of={stepMessages()} key={(message) => message.key}>
        {(message) => (
          <ChatRichContent
            source={message().text}
            ownerKey={`${item()?.id}:${message().key}`}
            endpointRef={ctx.endpointRef()}
            fallbackTopicID={ctx.topicID()}
            previews={ctx.previews}
          />
        )}
      </Each>
      <Each of={(Array.isArray(item()?.attachments) ? item().attachments : []) as any[]} key={(file) => file.id}>
        {(file) => (
          <ReceivedFile
            file={file()}
            taskID={item()?.taskId}
            topicID={item()?.topicID || ctx.topicID()}
            files={ctx.receivedFiles}
            downloadLabel={t("chat_workspace_action_download")}
            errorLabel={t("artifact_preview_error")}
          />
        )}
      </Each>
      <Each of={questions()} key={(question) => question.id}>
        {(question) => (
          <ChatQuestionCard
            question={question()}
            live={streaming()}
            states={ctx.questions}
            onAnswer={(answer) => ctx.onQuestionAnswer(item(), answer)}
          />
        )}
      </Each>
      <If when={waitingForAnswer()}>
        <WaitingForAnswer />
      </If>
      <Each of={elevations()} key={(elevation) => elevation.id}>
        {(elevation) => (
          <ChatElevationCard
            elevation={elevation()}
            taskID={item()?.taskId}
            live={streaming()}
            states={ctx.elevations}
            onAnswer={(answer) => ctx.onElevationAnswer(item(), answer)}
          />
        )}
      </Each>
      <ChatAgentLinkExchange
        itemID={item()?.id}
        messages={agentLink()}
        endpointRef={ctx.endpointRef()}
        topicID={ctx.topicID()}
        folded={ctx.folds}
        previews={ctx.previews}
      />
      <If when={bubbleVisible() && awaitingWord()}>
        <View class="h-[27.2px] justify-center">
          <MosaicText text={awaitingWord()} label={item()?.text} />
        </View>
      </If>
      <If when={bubbleVisible() && !awaitingWord() && !(questionOpen() && item()?.awaiting)}>
        <ChatRichContent
          source={String(item()?.text ?? "")}
          ownerKey={`${item()?.id}:reply`}
          endpointRef={ctx.endpointRef()}
          fallbackTopicID={ctx.topicID()}
          autoPreview={autoPreview()}
          streaming={streaming()}
          previews={ctx.previews}
          class={status() === "failed" ? "opacity-90" : ""}
        />
      </If>
      <If when={approvalVisible()}>
        <View
          class={`gap-2 rounded-(--radius) border bg-card p-3 ${approvalPending() ? "border-warn" : "border-line-faint"}`}
          accessibilityLabel={approvalHeading()}
          testID="chat-approval"
        >
          <View class="flex-row items-center gap-2">
            <Icon name="PhShieldCheck" size={16} color={approvalPending() ? "warn-dark" : "muted-foreground"} />
            <Text class="flex-1 text-sm font-medium text-foreground">{approvalHeading()}</Text>
            <If when={approvalToolName()}>
              <Text class="rounded-(--radius) bg-muted px-1.5 font-mono text-xs text-subtle">{approvalToolName()}</Text>
            </If>
          </View>
          <If when={approvalMessageVisible()}>
            <Text class="text-sm text-subtle">{approvalMessage()}</Text>
          </If>
          <If when={skillInstall()}>
            {(preview) => <ChatSkillInstallPreview preview={preview()} foldKey={`${item()?.id}:skill`} folds={ctx.folds} />}
          </If>
          <If when={approvalReasons().length && !skillInstall()}>
            <View class="gap-1">
              <Each of={approvalReasons()} key={(reason, index) => `${reason}:${index}`}>
                {(reason) => <Text class="text-sm text-foreground">• {reason()}</Text>}
              </Each>
            </View>
          </If>
          <If when={approvalParams().length}>
            <View class="gap-1.5">
              <Each of={approvalParams()} key={(param) => param.name}>
                {(param) => (
                  <View class={param().command || param().multiline ? "gap-1" : "flex-row gap-2"}>
                    <Text class="font-mono text-xs text-muted-foreground">{param().name}</Text>
                    <View selectable class={param().command || param().multiline ? "rounded-(--radius) bg-paper p-2" : "flex-1"}>
                      <Text class="font-mono text-xs text-foreground">{param().value}</Text>
                    </View>
                  </View>
                )}
              </Each>
            </View>
          </If>
          <If when={item()?.approvalError}>
            <View role="alert" class="flex-row items-center gap-1.5">
              <Icon name="PhInfo" size={14} color="danger" />
              <Text class="flex-1 text-xs text-danger">{String(item()?.approvalError ?? "")}</Text>
            </View>
          </If>
          <If when={approvalPending()}>
            <View class="flex-row justify-end gap-2">
              <Button variant="plain" size="xs" label={t("chat_approval_deny")} disabled={item()?.approvalBusy} onPress={() => ctx.onDeny(item())} />
              <Button variant="primary" size="xs" label={t("chat_approval_approve")} disabled={approveDisabled()} onPress={() => ctx.onApprove(item())} />
            </View>
          </If>
        </View>
      </If>
      <If when={copyAvailable()}>
        <CopyButton copied={copied()} copySeq={ctx.copySeq()} label={t("action_copy")} onPress={() => ctx.onCopy(item())} />
      </If>
    </View>
  );

  // A sent message (the Vue console's `.chat-history-user`): its time above the bubble at the
  // right, the bubble with its tail around its text and the files it carried, and copy.
  const messageBody = () => (
    <View class={`gap-[7px] ${role() === "system" ? "items-center" : "items-end"}`}>
      <If when={statusText()}>{statusMark()}</If>
      <View class={role() === "system" ? "w-full" : "mr-2"}>
        <Bubble system={role() === "system"} probe={parts.probe(() => "bubble")}>
          {/* A message of files alone has no text block: no blank slab above them. */}
          <If when={textBlockVisible()}>
            <View selectable class={role() === "system" ? "" : "px-3.5 pb-[11px] pt-2.5"} testID="chat-message-text" {...parts.probe(() => "text")}>
              <Text class="text-base leading-[28.5px] text-foreground">{String(item()?.text ?? "")}</Text>
            </View>
          </If>
          <If when={userFiles().length}>
            <View
              class={FILES_CLASS}
              testID="chat-user-files"
              ref={(node: ViewRef) => {
                // A new block (the cell shows another message): the old rows' frames go.
                filesNode = node;
                fileFrames.clear();
              }}
              onLayout={() => {
                parts.report("files", filesNode);
                for (const [index, frame] of fileFrames) parts.report(`file-${index}`, filesNode, () => frame);
              }}
            >
              <Each of={userFiles()} key={(file) => file.id}>
                {(file) => (
                  <TipButton
                    onPress={() => previewUserFile(file())}
                    accessibilityLabel={`${t("chat_composer_file_preview")}: ${file().name}`}
                    tooltip={<Tip text={`${t("chat_composer_file_preview")}: ${file().name}`} />}
                    testID="chat-user-file"
                    onLayout={(event: LayoutBounds) => {
                      if (!props.onPartLayout) return;
                      const index = userFiles().indexOf(file());
                      fileFrames.set(index, boundsFrame(event));
                      parts.report(`file-${index}`, filesNode, () => fileFrames.get(index));
                    }}
                    class={`group/file flex-row items-center gap-2 py-[5px] pl-[9px] pr-2 hover:bg-hover-soft ${fileRowCornerClass(
                      userFiles().indexOf(file()),
                      userFiles().length,
                      textBlockVisible(),
                    )}`}
                  >
                    <Icon name="PhPaperclip" size={13} color="muted-foreground" />
                    <Text class="flex-1 font-mono text-xs text-subtle line-clamp-1 group-hover/file:text-blue">{file().name}</Text>
                    <If when={fileKind(file())}>
                      <Text class="font-mono text-[11px] font-medium tracking-[0.1em] text-muted-foreground">{fileKind(file())}</Text>
                    </If>
                  </TipButton>
                )}
              </Each>
            </View>
          </If>
        </Bubble>
      </View>
      <If when={role() === "user" && item()?.reaction}>
        <Text class="mr-2 text-base" accessibilityLabel="Agent reaction">
          {String(item()?.reaction ?? "")}
        </Text>
      </If>
      <If when={copyAvailable()}>
        <View class="mr-2">
          <CopyButton copied={copied()} copySeq={ctx.copySeq()} label={t("action_copy")} onPress={() => ctx.onCopy(item())} />
        </View>
      </If>
    </View>
  );

  // The room a sent message leaves on its left, and a reply on its right (the Vue console's
  // clamp(48px, 10vw, 144px) and clamp(10px, 2vw, 36px)).
  const sideRoom = () => {
    const width = windowSize().width;
    return isAgent() ? Math.min(36, Math.max(10, width * 0.02)) : Math.min(144, Math.max(48, width * 0.1));
  };

  return (
    <View
      class="group w-full max-w-[832px] gap-[7px] self-center"
      style={{ ...arrival.style, paddingLeft: role() === "user" ? sideRoom() : 0, paddingRight: isAgent() ? sideRoom() : 0 }}
      testID={`chat-item-${role() || "system"}`}
      ref={(ref: ViewRef) => props.rowRef?.(ref)}
    >
      <If when={retryNotices().length}>
        <View class="gap-1.5" accessibilityLabel="Retry updates">
          <Each of={retryNotices()} key={(notice) => notice.id}>
            {(notice) => <ChatSystemMessage text={notice().summary} at={notice().at} />}
          </Each>
        </View>
      </If>
      <If
        when={contextCompact()}
        else={<If when={isAgent()} else={messageBody()}>{agentBody()}</If>}
      >
        <View class="flex-row items-center gap-2 self-center" role="text" testID="chat-context-notice">
          <StatusMark state={status() === "failed" ? "error" : isTerminalStatus(status()) ? "on" : "running"} />
          <Text class="font-mono text-xs text-subtle">{String(item()?.text ?? "")}</Text>
        </View>
      </If>
    </View>
  );
}
