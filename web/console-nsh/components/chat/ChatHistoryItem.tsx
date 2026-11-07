// One message of the conversation (the Vue console's ChatHistoryItem): a person's message with its
// files, or the agent's reply with what it did on the way (status card, workers, reasoning, step
// messages, received files, questions, password requests, Agent Link messages), its reply text or
// the wait before it, an approval it asks for, and copy.
//
// It is a List row: it is made once per cell and shows whatever item the cell holds now, so every
// value is read from `props.item` in a binding and per-item state lives in ChatRowContext.
import type { JSX } from "nsh";
import { Text, View } from "nsh";
import { Button as BaseButton } from "nsh/base";
import { Button, Icon } from "../ui";
import { approvalParameterEntries, skillInstallApproval } from "../../lib/core/chat-approvals.js";
import { agentLinkMessages, insightMessages, planStepMessages, pollingActionWord } from "../../lib/core/chat-task-history.js";
import type { ArtifactPreviews } from "./ArtifactPreviewCard";
import { ChatAgentLinkExchange } from "./ChatAgentLinkExchange";
import { ChatElevationCard, type ElevationAnswer, type ElevationState } from "./ChatElevationCard";
import { ChatQuestionCard, type QuestionAnswer, type QuestionState } from "./ChatQuestionCard";
import { ChatRichContent } from "./ChatRichContent";
import { ChatSkillInstallPreview } from "./ChatSkillInstallPreview";
import { ChatStatusCard } from "./ChatStatusCard";
import { ChatSystemMessage } from "./ChatSystemMessage";
import { ChatWorkerRoster } from "./ChatWorkerRoster";
import { t } from "./i18n";
import { MosaicText } from "./MosaicText";
import { ReceivedFile, type ReceivedFiles } from "./ReceivedFile";
import type { KeyedState } from "./rowState";

export type HistoryItem = Record<string, any> & { id: string; role: string; text: string };

/** What every row of the conversation shares: the page's state by item, and its handlers. */
export interface ChatRowContext {
  endpointRef: () => string;
  topicID: () => string;
  copiedItemID: () => string;
  expandedPanel: (itemID: string) => string;
  autoPreviewItemID: () => string;
  previews: ArtifactPreviews;
  receivedFiles: ReceivedFiles;
  questions: KeyedState<QuestionState>;
  elevations: KeyedState<ElevationState>;
  workers: KeyedState<string>;
  folds: KeyedState<boolean>;
  onCopy: (item: HistoryItem) => void;
  onPreviewFile: (item: any) => void;
  onToggleStatus: (itemID: string, panel: string) => void;
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

function Surface(props: { agent: boolean; children?: JSX.Element; class?: string }) {
  return (
    <View
      class={`${props.agent ? "self-stretch" : "max-w-[85%] self-end rounded-(--radius) bg-selection px-3 py-2"} ${props.class ?? ""}`}
    >
      {props.children}
    </View>
  );
}

function CopyButton(props: { copied: boolean; label: string; onPress: () => void }) {
  return (
    <Button
      variant="plain"
      size="xxs"
      iconOnly
      icon={props.copied ? "PhCheck" : "PhCopy"}
      title={props.label}
      onPress={props.onPress}
      testID="chat-copy"
    />
  );
}

export function ChatHistoryItem(props: { item: HistoryItem; ctx: ChatRowContext }) {
  const item = () => props.item;
  const ctx = props.ctx;
  const role = () => roleOf(item());
  const isAgent = () => role() === "agent";
  const contextCompact = () => String(item()?.presentation || "").trim().toLowerCase() === "context-compact";
  const status = () => normalizeTaskStatus(item()?.status);

  const stepMessages = () => (isAgent() ? [...insightMessages(item()?.insights), ...planStepMessages(item()?.plan)] : []);
  const questions = (): any[] => (isAgent() && Array.isArray(item()?.questions) ? item().questions : []);
  const elevations = (): any[] => (isAgent() && Array.isArray(item()?.elevations) ? item().elevations : []);
  const questionOpen = () =>
    questions().some((question) => question.status === "open") || elevations().some((elevation) => elevation.status === "open");
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
  const expandedPanel = () => ctx.expandedPanel(item()?.id);
  const autoPreview = () => item()?.id !== "" && item()?.id === ctx.autoPreviewItemID();
  const copied = () => item()?.id !== "" && item()?.id === ctx.copiedItemID();

  const statusMark = () => (
    <If when={statusText()}>
      <View
        role={statusInteractive() ? "button" : "text"}
        accessibilityLabel={statusLabel()}
        onPress={statusInteractive() ? () => ctx.onTimeClick(item()) : undefined}
        tooltip={statusIsDuration() ? <Text class="text-xs">{statusLabel()}</Text> : undefined}
        testID="chat-history-status"
        class={`flex-row items-center gap-1 self-start rounded-(--radius) px-1 ${statusInteractive() ? "hover:bg-hover" : ""}`}
      >
        <If when={statusIsDuration()}>
          <Icon name="PhChatCircleDots" size={12} color="muted-foreground" />
        </If>
        <Text class="font-mono text-xs text-muted-foreground">{statusText()}</Text>
      </View>
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
    <View class="gap-3">
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
          expandedPanel={expandedPanel()}
          onToggle={(panel) => ctx.onToggleStatus(item()?.id, panel)}
          summaryPrefix={statusMark()}
        />
      </If>
      <If when={item()?.activity?.workers?.length}>
        <ChatWorkerRoster itemID={item()?.id} activity={item()?.activity} status={item()?.status} selected={ctx.workers} />
      </If>
      <If when={reasoningVisible() && expandedPanel() === "reasoning"}>
        <View class="rounded-(--radius) border border-line-faint bg-paper p-3" testID="chat-reasoning">
          <ChatRichContent
            source={String(item()?.reasoning ?? "")}
            ownerKey={`${item()?.id}:reasoning`}
            endpointRef={ctx.endpointRef()}
            fallbackTopicID={ctx.topicID()}
            streaming={streaming()}
            previews={ctx.previews}
          />
        </View>
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
        <MosaicText text={awaitingWord()} label={item()?.text} />
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
        <CopyButton copied={copied()} label={t("action_copy")} onPress={() => ctx.onCopy(item())} />
      </If>
    </View>
  );

  const messageBody = () => (
    <View class="gap-1.5">
      <If when={statusText()}>
        <View class="self-end">{statusMark()}</View>
      </If>
      <Surface agent={false} class={role() === "system" ? "self-stretch bg-paper" : ""}>
        <View selectable>
          <Text class="text-sm text-foreground">{String(item()?.text ?? "")}</Text>
        </View>
      </Surface>
      <If when={userFiles().length}>
        <View class="flex-row flex-wrap justify-end gap-1.5">
          <Each of={userFiles()} key={(file) => file.id}>
            {(file) => (
              <BaseButton
                onPress={() => previewUserFile(file())}
                accessibilityLabel={`${t("chat_composer_file_preview")}: ${file().name}`}
                tooltip={<Text class="text-xs">{`${t("chat_composer_file_preview")}: ${file().name}`}</Text>}
                class="flex-row items-center gap-1.5 rounded-(--radius) border border-line-faint bg-card px-2 py-1 hover:bg-hover"
              >
                <Icon name="PhPaperclip" size={13} color="subtle" />
                <Text class="text-xs text-foreground line-clamp-1">{file().name}</Text>
                <If when={fileKind(file())}>
                  <Text class="font-mono text-xs text-muted-foreground">{fileKind(file())}</Text>
                </If>
              </BaseButton>
            )}
          </Each>
        </View>
      </If>
      <If when={role() === "user" && item()?.reaction}>
        <Text class="self-end text-base" accessibilityLabel="Agent reaction">
          {String(item()?.reaction ?? "")}
        </Text>
      </If>
      <If when={copyAvailable()}>
        <View class="self-end">
          <CopyButton copied={copied()} label={t("action_copy")} onPress={() => ctx.onCopy(item())} />
        </View>
      </If>
    </View>
  );

  return (
    <View class="w-full max-w-3xl gap-2 self-center px-5 py-2" testID={`chat-item-${role() || "system"}`}>
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
          <View class={`size-2 border ${status() === "failed" ? "bg-status-error border-status-error" : isTerminalStatus(status()) ? "bg-status-on border-status-on" : "bg-status-pending border-status-pending"}`} />
          <Text class="font-mono text-xs text-subtle">{String(item()?.text ?? "")}</Text>
        </View>
      </If>
    </View>
  );
}
