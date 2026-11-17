// Gallery demos: the chat's rows, cards, terminal output and composer (components/chat, and the
// reusable parts of pages/chat). The history is fixed and synthetic; it is shaped by the same pure
// normalizers the chat uses (lib/core/chat-task-history.js), and every answer, approval, send and
// upload ends in the gallery's local action log.
import { signal, Text, View } from "nsh";
import { approvalDetailsByID, skillInstallApproval } from "../../../lib/core/chat-approvals.js";
import { foldQuietRuns, quietGroupFoldKey, quietRunFoldKey } from "../../../lib/core/chat-quiet-runs.js";
import { normalizeActivity, normalizeElevations, normalizePlan, normalizeQuestions, taskListHistoryItems } from "../../../lib/core/chat-task-history.js";
import { createArtifactPreviews } from "../../../components/chat/ArtifactPreviewCard";
import { AttachSourceSheet } from "../../../components/chat/AttachSourceSheet";
import { ChatAgentLinkExchange } from "../../../components/chat/ChatAgentLinkExchange";
import { ChatComposer, type ComposerFileItem } from "../../../components/chat/ChatComposer";
import { ChatElevationCard, type ElevationState } from "../../../components/chat/ChatElevationCard";
import { ChatHistoryItem, type ChatRowContext, type HistoryItem } from "../../../components/chat/ChatHistoryItem";
import { ChatHistoryList } from "../../../components/chat/ChatHistoryList";
import { ChatLoadError } from "../../../components/chat/ChatLoadError";
import { ChatMarkdown } from "../../../components/chat/ChatMarkdown";
import { ChatNoticeLine } from "../../../components/chat/ChatNoticeLine";
import { ChatQuietRuns } from "../../../components/chat/ChatQuietRuns";
import { ChatQuestionCard, type QuestionState } from "../../../components/chat/ChatQuestionCard";
import { ChatRichContent } from "../../../components/chat/ChatRichContent";
import { ChatSkillInstallPreview } from "../../../components/chat/ChatSkillInstallPreview";
import { ActivityCallTree, ChatActivityEntries, ChatPlanSteps, ChatStatusCard, ParamRow, ShellResult } from "../../../components/chat/ChatStatusCard";
import { ChatStatusMark } from "../../../components/chat/ChatStatusMark";
import { ChatSystemMessage } from "../../../components/chat/ChatSystemMessage";
import { ChatTerminal } from "../../../components/chat/ChatTerminal";
import { ChatWorkerOutput, ChatWorkerRoster, replyWorkers, WorkerAvatar } from "../../../components/chat/ChatWorkerRoster";
import { MosaicText } from "../../../components/chat/MosaicText";
import { OverflowLine } from "../../../components/chat/OverflowLine";
import { PinnedScroll } from "../../../components/chat/PinnedScroll";
import { ReceivedFile, type ReceivedFiles } from "../../../components/chat/ReceivedFile";
import { keyedState } from "../../../components/chat/rowState";
import { KindChip, StatusTag, TerminalText } from "../../../components/chat/TerminalText";
import { TopicTagsEditor } from "../../../components/chat/TopicTagsEditor";
import { WorkspacePathLine } from "../../../components/chat/WorkspacePathLine";
import { workspacePathDisplay } from "../../../components/chat/workspacePath";
import { Button, Muted } from "../../../components/ui";
import { ActivityDetailPanel } from "../../chat/ActivityDetailPanel";
import { ViewToggle } from "../../chat/TopicSidebar";
import { WorkspacePanelTabs, WorkspaceSheet } from "../../chat/WorkspacePanel";
import { act, Col, type DemoMap, FIXED_ISO, FIXED_MS, LONG_TEXT, LONG_WORD, Row, t, useFlag, useText, V, Wide } from "../demo";

const REPLY = [
  "Here is what I found in the **synthetic** workspace:",
  "",
  "1. `notes/plan.md` lists three open items.",
  "2. The build log ends with a warning.",
  "",
  "```ts",
  "export function greet(name: string): string {",
  "  return `Hello, ${name}!`;",
  "}",
  "```",
  "",
  "| File | Lines |",
  "| --- | --- |",
  "| plan.md | 42 |",
  "| build.log | 1280 |",
  "",
  LONG_TEXT,
].join("\n");

const TERMINAL = [
  "$ go test ./...",
  "ok  \texample.com/app/agent\t0.412s",
  "ok  \texample.com/app/tools\t1.038s",
  "--- FAIL: TestSynthetic (0.00s)",
  "    demo_test.go:12: expected 3, got 4",
  "FAIL\texample.com/app/demo\t0.019s",
  `warning: ${LONG_WORD}`,
].join("\n");

const RAW_ACTIVITY = {
  history: [
    { id: "a1", kind: "tool", name: "read_file", status: "done", at: FIXED_ISO, args: { path: "notes/plan.md", limit: 200 }, summary: "42 lines" },
    {
      id: "a2",
      kind: "tool",
      name: "bash",
      status: "failed",
      at: FIXED_ISO,
      args: { cmd: "go test ./...", cwd: "/synthetic/workspace", timeout_seconds: 180 },
      error: "exit status 1",
      shell: { exit_code: 1, stdout: TERMINAL, stderr: "FAIL", stdout_truncated: true, stdout_omitted: 2048 },
    },
    {
      id: "a3",
      kind: "subtask",
      name: "spawn",
      status: "running",
      at: FIXED_ISO,
      worker: { id: "w1", name: "Curie", name_index: 4, avatar_index: 1 },
      args: { task: "Summarize the build log" },
      children: [
        { id: "a3-1", kind: "tool", name: "url_fetch", status: "done", at: FIXED_ISO, args: { url: "https://example.com/build.log" } },
        { id: "a3-2", kind: "tool", name: "web_search", status: "running", at: FIXED_ISO, args: { q: LONG_TEXT } },
      ],
      children_omitted: 3,
    },
    {
      id: "a4",
      kind: "tool",
      name: "agent_send",
      status: "done",
      at: FIXED_ISO,
      messages: [
        { direction: "sent", peer: "Atlas", text: "Do you have the release checklist?", at: FIXED_ISO },
        { direction: "reply", peer: "Atlas", text: `Yes. ${LONG_TEXT}`, at: FIXED_ISO },
        { direction: "pending", peer: "Borealis", text: "Waiting for an answer…", at: FIXED_ISO },
      ],
    },
  ],
  workers: [
    { id: "w1", name: "Curie", name_index: 4, avatar_index: 1, kind: "subagent", status: "running", output: "Reading the log…" },
    { id: "w2", name: "Noether", name_index: 1, avatar_index: 2, kind: "coder", status: "done", output: TERMINAL },
    { id: "w3", name: "Hazel", name_index: 13, avatar_index: 5, kind: "subagent", status: "failed", output: "", error: "timed out" },
  ],
  workers_omitted: 2,
};
const ACTIVITY = normalizeActivity(RAW_ACTIVITY) as any;
const PLAN = normalizePlan({
  steps: [
    { step: "Read the plan", status: "completed" },
    { step: "Run the tests", status: "in_progress" },
    { step: LONG_TEXT, status: "pending" },
  ],
}) as any;

const previews = createArtifactPreviews();
/** A stand-in for the chat's received-file store: it keeps no state and downloads nothing. */
const receivedFiles: ReceivedFiles = {
  state: () => ({ requested: false, previewURL: "", error: "", busy: false, saved: false }) as never,
  // The row asks for a preview as soon as it shows: the stand-in answers nothing and fetches nothing.
  preview: async () => {},
  failPreview: () => {},
  download: async (_key: string, file: { name: string }) => act("ReceivedFile download", file.name),
} as unknown as ReceivedFiles;

function rowContext(): ChatRowContext {
  const copied = signal("");
  const seq = signal(0);
  const editing = signal("");
  return {
    endpointRef: () => "",
    topicID: () => "uig-topic",
    copiedItemID: () => copied(),
    copySeq: () => seq(),
    detail: () => null,
    focusReturn: () => "",
    autoPreviewItemID: () => "",
    previews,
    receivedFiles,
    questions: keyedState(),
    elevations: keyedState(),
    folds: keyedState(),
    onCopy: (item) => {
      copied.set(item.id);
      seq.update((n) => n + 1);
      act("chat copy", item.id);
    },
    // A sent message can be edited here; pressing Edit again on the same one ends the edit.
    canEdit: (item) => item.role === "user",
    editingItemID: () => editing(),
    replacedByEdit: () => false,
    onEdit: (item) => {
      editing.set(editing() === item.id ? "" : item.id);
      act("chat edit", item.id);
    },
    onPreviewFile: (item) => act("chat preview file", item?.name),
    onOpenDetail: (detail) => act("chat open detail", detail.kind),
    onTimeClick: (item) => act("chat time", item.id),
    onApprove: (item) => act("chat approve", item.id),
    onDeny: (item) => act("chat deny", item.id),
    onQuestionAnswer: (item, answer) => {
      act("chat answer", item.id);
      answer.done(true);
    },
    onElevationAnswer: (item, answer) => {
      act("chat elevation", item.id);
      answer.done(true);
    },
  };
}

const file = (id: string, name: string) => ({ id, name, mime: "image/png", size: 1234 });
const HISTORY: HistoryItem[] = [
  { id: "h1", role: "user", text: "Can you check the plan and run the tests?", timeText: "10:00" },
  { id: "h2", role: "user", text: LONG_TEXT, timeText: "10:01", files: [file("f1", "screenshot.png"), file("f2", `${LONG_WORD}.pdf`)] },
  { id: "h3", role: "system", text: "Context compacted. Earlier messages were summarized.", timeText: "" },
  { id: "h4", role: "agent", text: REPLY, timeText: "10:02", durationText: "2m5s", status: "done", taskId: "task-1", plan: PLAN, activity: ACTIVITY, reasoning: "The plan names three items; the tests come second." },
  { id: "h5", role: "agent", text: "", timeText: "10:05", status: "running", taskId: "task-2", plan: PLAN, activity: ACTIVITY, awaiting: true },
  { id: "h6", role: "agent", text: "The run failed: exit status 1.", timeText: "10:06", durationText: "4s", status: "failed", taskId: "task-3" },
] as HistoryItem[];

function HistoryDemo() {
  const ctx = rowContext();
  return (
    <Col>
      <Each of={HISTORY} key={(item) => item.id}>
        {(item) => (
          <V l={`${item().role}${item().status ? ` · ${item().status}` : ""}`}>
            <ChatHistoryItem item={item()} ctx={ctx} />
          </V>
        )}
      </Each>
    </Col>
  );
}

// A TODO item's topic as the runtime lists it: a run that built something, then scheduled runs
// that found nothing to do (result.outcome "nothing"). The chat's own grouping folds them.
const QUIET_TASK = "Run a factory build for this repository.";
const QUIET_REPLIES = [
  "No build performed: .factory/new/ is empty. Lock released; no notification sent.",
  "No review candidate: review/ is empty. No changes made and no notification sent.",
  `${LONG_TEXT} ${LONG_WORD}`,
];
function quietTasks(count: number, prefix: string) {
  return Array.from({ length: count }, (_, index) => {
    const time = new Date(FIXED_MS + index * 30 * 60_000).toISOString();
    return {
      id: `${prefix}-${index + 1}`,
      task: QUIET_TASK,
      topic_id: "_cron_uig",
      status: "done",
      created_at: time,
      started_at: time,
      finished_at: time,
      result: { final: { output: QUIET_REPLIES[index % QUIET_REPLIES.length] }, outcome: "nothing" },
    };
  });
}
const quietGroup = (count: number, prefix: string) =>
  (foldQuietRuns(taskListHistoryItems(quietTasks(count, prefix), t, { locale: "en-US", now: new Date(FIXED_MS) })) as HistoryItem[])[0];

function QuietRunsDemo() {
  const ctx = rowContext();
  const many = quietGroup(8, "uig-quiet");
  const one = quietGroup(1, "uig-quiet-one");
  const open = quietGroup(3, "uig-quiet-open");
  // The third example starts open, its second run shown in full.
  ctx.folds.set(quietGroupFoldKey(open.id), true);
  ctx.folds.set(quietRunFoldKey("uig-quiet-open-2"), true);
  const group = (item: HistoryItem) => (
    <ChatQuietRuns group={item} folds={ctx.folds} renderMessage={(message) => <ChatHistoryItem item={message() as HistoryItem} ctx={ctx} />} />
  );
  return (
    <Col>
      <V s="closed" l="8 runs"><View testID="uig-quiet-many">{group(many)}</View></V>
      <V s="closed" l="1 run"><View testID="uig-quiet-one">{group(one)}</View></V>
      <V s="open" l="a run in full"><View testID="uig-quiet-open">{group(open)}</View></V>
    </Col>
  );
}

function HistoryListDemo() {
  const ctx = rowContext();
  const state = signal<"filled" | "empty" | "loading">("filled");
  const older = useFlag(false);
  return (
    <Col>
      <View class="flex-row flex-wrap gap-2">
        <Each of={["filled", "empty", "loading"] as const} key={(id) => id}>
          {(id) => <Button variant="outlined" size="xs" selected={state() === id()} label={t(`uig_state_${id()}`)} onPress={() => state.set(id())} testID={`uig-history-${id()}`} />}
        </Each>
      </View>
      <View class="h-[420px] overflow-hidden rounded-(--radius) border border-line-faint">
        <ChatHistoryList
          items={state() === "filled" ? HISTORY : []}
          loading={state() === "loading"}
          loadingText={t("msg_loading")}
          emptyText={t("uig_fixture_empty_title")}
          hasOlder={state() === "filled"}
          loadingOlder={older.on()}
          olderLabel={t("uig_fixture_open")}
          onLoadOlder={() => {
            older.toggle();
            act("ChatHistoryList", "load older");
          }}
          ctx={ctx}
        />
      </View>
    </Col>
  );
}

function StatusCardDemo() {
  const panel = signal("");
  const lines = [
    { name: "running", status: "running", plan: PLAN, activity: ACTIVITY, reasoning: false, mark: { text: "10:02", duration: false } },
    { name: "done", status: "done", plan: PLAN, activity: ACTIVITY, reasoning: true, mark: { text: "2m5s", duration: true } },
    { name: "failed", status: "failed", plan: null, activity: ACTIVITY, reasoning: false, mark: { text: "4s", duration: true } },
    { name: "reasoning only", status: "done", plan: null, activity: null, reasoning: true, mark: null },
  ];
  return (
    <Col>
      <Each of={lines} key={(line) => line.name}>
        {(line) => (
          <V l={line().name}>
            <ChatStatusCard
              itemID={`uig-${line().name}`}
              plan={line().plan}
              activity={line().activity}
              hasReasoning={line().reasoning}
              status={line().status}
              selectedPanel={panel().startsWith(`${line().name}:`) ? panel().slice(line().name.length + 1) : ""}
              onOpen={(next) => {
                panel.set(`${line().name}:${next}`);
                act("ChatStatusCard open", next);
              }}
              summaryPrefix={
                line().mark ? (
                  <ChatStatusMark text={line().mark!.text} label={line().mark!.text} duration={line().mark!.duration} onPress={() => act("ChatStatusMark")} placement="summary" />
                ) : undefined
              }
            />
          </V>
        )}
      </Each>
    </Col>
  );
}

function QuestionDemo() {
  const states = keyedState<QuestionState>();
  const questions = signal(
    normalizeQuestions([
      { id: "q1", text: "Which **city** should the report cover?", options: [{ label: "Lisbon", description: "Coast" }, { label: "Porto" }, { label: LONG_TEXT }], status: "open" },
      { id: "q2", text: "Anything else to add?", options: [], status: "open" },
      { id: "q3", text: "Pick one.", options: [{ label: "A" }, { label: "B" }], choices_only: true, status: "answered", answer: "B", option: 1 },
      { id: "q4", text: "This one was not answered in time.", options: [{ label: "A" }], status: "expired" },
    ]) as any[],
  );
  return (
    <Col>
      <Each of={questions()} key={(question) => question.id}>
        {(question) => (
          <V l={question().status}>
            <ChatQuestionCard
              question={question()}
              live
              states={states}
              onAnswer={(answer) => {
                act("ChatQuestionCard", answer.text ?? `option ${answer.option}`);
                answer.done(true);
                questions.update((all) =>
                  all.map((item) =>
                    item.id === answer.questionID
                      ? { ...item, status: "answered", answer: answer.text ?? item.options[answer.option ?? 0]?.label ?? "", option: answer.option ?? null }
                      : item,
                  ),
                );
              }}
            />
          </V>
        )}
      </Each>
    </Col>
  );
}

function ElevationDemo() {
  const states = keyedState<ElevationState>();
  // The open card counts down to its deadline, so the deadline is an hour from when the demo mounts.
  const soon = Math.floor(Date.now() / 1000) + 3600;
  const elevations = signal(
    normalizeElevations([
      { id: "e1", command: "apt-get install jq", cwd: "/synthetic/workspace", host: "demo-host", deadline: soon, status: "open" },
      { id: "e2", command: `systemctl restart ${LONG_WORD}`, cwd: "/", deadline: soon, attempt: 2, status: "rejected" },
      { id: "e3", command: "apt-get update", cwd: "/", deadline: 0, status: "allowed" },
      { id: "e4", command: "rm -rf /tmp/demo", cwd: "/", deadline: 0, status: "declined" },
      { id: "e5", command: "reboot", cwd: "/", deadline: 0, status: "expired" },
    ]) as any[],
  );
  return (
    <Col>
      <Each of={elevations()} key={(elevation) => elevation.id}>
        {(elevation) => (
          <V l={elevation().status}>
            <ChatElevationCard
              elevation={elevation()}
              taskID="uig-task"
              live
              states={states}
              onAnswer={(answer) => {
                act("ChatElevationCard", answer.decline ? "decline" : "allow");
                answer.done(true);
                elevations.update((all) => all.map((item) => (item.id === answer.elevationID ? { ...item, status: answer.decline ? "declined" : "allowed" } : item)));
              }}
            />
          </V>
        )}
      </Each>
    </Col>
  );
}

const SKILL_PREVIEW = {
  preview_id: "p1",
  name: "example-deck-skill",
  description: "Builds single-file HTML decks. (Synthetic preview.)",
  source: { kind: "github", url: "https://github.com/example/example-deck-skill/tree/0123456789ab/", commit: "0123456789abcdef0123456789abcdef01234567" },
  files: [{ path: "SKILL.md", size: 100 }, { path: "a.png", size: 900, kind: "image" }, { path: "ref.md", size: 10 }],
  total_bytes: 1010,
  review: { summary: "Makes decks from an outline.", capabilities: ["runs node scripts", "writes files in the workspace"] },
  findings: [
    { severity: "info", title: "Ships a script the agent may run", file: "run.mjs", source: "check" },
    { severity: "medium", title: "Pulls code from a remote repository", file: "SKILL.md", line: 12, evidence: "git pull", rationale: "Later code was not reviewed.", source: "check" },
    { severity: "high", title: "Sends the API key to a remote host", file: "run.mjs", evidence: "fetch(url, {body: key})", source: "review", evidence_verified: false },
  ],
  audit: [
    { path: "SKILL.md", kind: "instructions", status: "reviewed" },
    { path: "a.png", kind: "image", status: "inspected", note: "PNG 4x4" },
    { path: "ref.md", kind: "text", status: "not_reviewed" },
  ],
  assessment: { complete: false, incomplete_reasons: ["1 text file was not read by the model review"], level: "high", score: 35, rubric: "synthetic rubric" },
};

function skillCard() {
  const params = { preview_id: "p1", name: SKILL_PREVIEW.name, source: SKILL_PREVIEW.source.url, commit: SKILL_PREVIEW.source.commit };
  const [detail] = (approvalDetailsByID as any)({ items: [{ approval_request_id: "a", tool_name: "skill_install", tool_params: params, skill_preview: SKILL_PREVIEW }] }).values();
  return (skillInstallApproval as any)(detail);
}

const COMMANDS = [
  { name: "/new", title: "/new", description: "Start a new topic", value: "/new" },
  { name: "/compact", title: "/compact", description: "Summarize the conversation so far", value: "/compact" },
];
const SKILLS = [
  { name: "release-notes", title: "release-notes", description: "Draft release notes", value: "release-notes" },
  { name: "deck", title: "deck", description: LONG_TEXT, value: "deck" },
];
const PROFILES = [
  { id: "default", title: "Default", subtitle: "example-large-1", value: "default", icon: "PhCube" },
  { id: "cheap", title: "Cheap", subtitle: "example-small-2", value: "cheap", icon: "PhCpu" },
];
const FILES: ComposerFileItem[] = [
  { id: "c1", name: "screenshot.png", status: "ready" },
  { id: "c2", name: `${LONG_WORD}.pdf`, status: "uploading" },
  { id: "c3", name: "broken.zip", status: "failed", error: "Upload failed" },
];

function ComposerDemo(props: { mode: "default" | "files" | "sending" | "disabled" | "voice" | "landing" }) {
  const text = useText(props.mode === "files" ? "Three files attached." : props.mode === "sending" ? "A message on its way" : "");
  const profile = signal("default");
  const files = signal(FILES);
  const labels = {
    files: t("uig_fixture_count_many", { count: files().length }),
    preview: t("uig_fixture_open"),
    remove: t("action_delete"),
    uploading: t("uig_state_loading"),
    failed: t("uig_state_error"),
    retry: t("uig_fixture_replay"),
  };
  return (
    <ChatComposer
      value={text.get()}
      onChange={text.set}
      placeholder={t("uig_fixture_placeholder")}
      disabled={props.mode === "disabled"}
      sending={props.mode === "sending"}
      stopMode={props.mode === "sending"}
      landing={props.mode === "landing"}
      fileItems={props.mode === "files" ? files() : []}
      fileLabels={labels}
      addLabel={t("uig_fixture_add")}
      attachLabel={t("uig_fixture_add")}
      uploadLabel={t("uig_fixture_add")}
      sendLabel={t("uig_fixture_start")}
      submitOnEnter
      inputHistory={["an earlier message", "another earlier message"]}
      commands={COMMANDS}
      skills={SKILLS}
      suggestionLabels={{ commands: "Commands", skills: "Skills", loading: t("msg_loading"), empty: t("uig_fixture_empty_title") }}
      llmProfileItems={PROFILES}
      llmProfileValue={profile()}
      llmProfileLabel={t("uig_fixture_choice")}
      onLLMProfileChange={(value) => profile.set(value)}
      footerText={props.mode === "landing" ? t("uig_fixture_hint") : undefined}
      voiceAvailable={props.mode === "voice" || props.mode === "default"}
      voiceState={props.mode === "voice" ? "recording" : "idle"}
      voiceLabel={t("uig_fixture_toggle")}
      voiceElapsed={props.mode === "voice" ? 12 : 0}
      voicePreview={props.mode === "voice" ? "a transcript that is still being heard" : ""}
      voicePreviewEnabled={props.mode === "voice" ? true : null}
      voiceLabels={{ recording: "Recording", transcribing: "Transcribing", discard: t("action_cancel"), previewOn: t("uig_state_on"), previewOff: t("uig_state_off") }}
      onSubmit={() => {
        act("ChatComposer send", text.get());
        text.set("");
      }}
      onStop={() => act("ChatComposer", "stop")}
      onAttach={() => act("ChatComposer", "attach")}
      onUpload={() => act("ChatComposer", "upload")}
      onUploadFrom={(source) => act("ChatComposer upload from", source)}
      onAttachFiles={(picked) => act("ChatComposer files", picked.length)}
      onRetryFile={(item) => act("ChatComposer retry", item.name)}
      onVoice={() => act("ChatComposer", "voice")}
      onVoiceCancel={() => act("ChatComposer", "voice cancel")}
      onVoicePreviewToggle={() => act("ChatComposer", "voice preview")}
      onPreviewFile={(item) => act("ChatComposer preview", item.name)}
      onRemoveFile={(item) => files.update((all) => all.filter((entry) => entry.id !== item.id))}
      onRequestCommands={() => {}}
      onRequestSkills={() => {}}
    />
  );
}

function PinnedDemo() {
  const lines = signal(12);
  return (
    <Col>
      <PinnedScroll resetKey="uig" maxHeight={140} class="rounded-(--radius) border border-line-faint" contentClass="p-2">
        <Each of={Array.from({ length: lines() }, (_, i) => i + 1)} key={(n) => String(n)}>
          {(n) => <Text class="font-mono text-xs text-foreground">{`line ${n()}  ${LONG_WORD}`}</Text>}
        </Each>
      </PinnedScroll>
      <View class="flex-row gap-2">
        <Button variant="outlined" size="xs" label={t("uig_fixture_add")} onPress={() => lines.update((n) => n + 3)} testID="uig-pinned-add" />
        <Button variant="plain" size="xs" label={t("uig_fixture_reset")} onPress={() => lines.set(12)} />
      </View>
    </Col>
  );
}

function DetailPanelDemo() {
  const kind = signal<"plan" | "activity" | "reasoning" | "worker">("activity");
  const item = { ...HISTORY[3], id: "uig-detail" } as HistoryItem;
  return (
    <Col>
      <View class="flex-row flex-wrap gap-2">
        <Each of={["plan", "activity", "reasoning", "worker"] as const} key={(id) => id}>
          {(id) => <Button variant="outlined" size="xs" selected={kind() === id()} label={id()} onPress={() => kind.set(id())} testID={`uig-detail-${id()}`} />}
        </Each>
      </View>
      <View class="h-[420px] flex-row overflow-hidden rounded-(--radius) border border-line-faint">
        <ActivityDetailPanel
          detail={kind() === "worker" ? { itemID: "uig-detail", kind: "worker", workerID: "w2" } : { itemID: "uig-detail", kind: kind() as "plan" }}
          item={item}
          context="Check the plan and run the tests"
          endpointRef=""
          topicID=""
          previews={previews}
          agentName="Morph"
          class="flex-1"
          onClose={() => act("ActivityDetailPanel", "close")}
        />
      </View>
    </Col>
  );
}

function TagsDemo() {
  const tags = signal(["release", "synthetic"]);
  return (
    <Row>
      <V s="default" class="w-80">
        <TopicTagsEditor tags={tags()} known={["release", "synthetic", "planning", "review", LONG_WORD]} onChange={(next) => tags.set(next)} />
        <Text class="text-xs text-muted-foreground" testID="uig-tags-echo">{t("uig_fixture_echo", { value: tags().join(", ") })}</Text>
      </V>
      <V s="empty" class="w-80"><TopicTagsEditor tags={[]} known={[]} onChange={() => {}} /></V>
      <V s="busy" l="saving" class="w-80"><TopicTagsEditor tags={["release"]} known={[]} saving onChange={() => {}} /></V>
      <V s="disabled" class="w-80"><TopicTagsEditor tags={["release", "synthetic"]} known={[]} disabled onChange={() => {}} /></V>
    </Row>
  );
}

function PathDemo() {
  const paths = ["/home/demo/projects/console", `/home/demo/${LONG_WORD}/deeply/nested/工作区/プロジェクト/console-nsh`, "~"];
  return (
    <Col>
      <Each of={paths} key={(path) => path}>
        {(path) => {
          const shown = workspacePathDisplay(path(), "/home/demo");
          return (
            <V l={shown.text.length > 40 ? "long" : shown.text}>
              <View class="w-72"><WorkspacePathLine path={shown.text} leafStart={shown.leafStart} textClass="font-mono text-xs text-foreground" accessibilityLabel={shown.text} /></View>
            </V>
          );
        }}
      </Each>
    </Col>
  );
}

function SheetsDemo() {
  const attach = useFlag(false);
  const sheet = useFlag(false);
  const tab = signal("topic");
  const mode = signal("agents");
  return (
    <Col>
      <V l="AttachSourceSheet" row>
        <Button variant="outlined" label={t("uig_fixture_open")} onPress={() => attach.set(true)} testID="uig-attach-open" />
        <AttachSourceSheet
          open={attach.on()}
          onClose={() => attach.set(false)}
          onChoose={(source) => {
            act("AttachSourceSheet", source);
            attach.set(false);
          }}
          testID="uig-attach"
        />
      </V>
      <V l="WorkspacePanelTabs">
        <WorkspacePanelTabs
          tabs={[
            { id: "topic", label: "Topic", icon: "PhChat" },
            { id: "workspace", label: "Workspace", icon: "PhFolder" },
          ]}
          value={tab()}
          onChange={(id) => tab.set(id)}
        />
        <WorkspacePanelTabs phone tabs={[{ id: "topic", label: "Topic", icon: "PhChat" }, { id: "workspace", label: LONG_TEXT, icon: "PhFolder" }]} value={tab()} onChange={(id) => tab.set(id)} />
      </V>
      <V l="WorkspaceSheet" row>
        <Button variant="outlined" label={t("uig_fixture_open")} onPress={() => sheet.set(true)} testID="uig-workspace-sheet-open" />
        <WorkspaceSheet open={sheet.on()} onClose={() => sheet.set(false)}>
          <View class="gap-3 p-4">
            <Muted>{t("uig_fixture_dialog_text")}</Muted>
            <Button variant="outlined" label={t("action_close")} onPress={() => sheet.set(false)} />
          </View>
        </WorkspaceSheet>
      </V>
      <V l="ViewToggle" row>
        <ViewToggle icon="PhRobot" label="Agents" title="Agents" active={mode() === "agents"} onPress={() => mode.set("agents")} testID="uig-view-agents" />
        <ViewToggle icon="PhAlarm" label="Scheduled" title="Scheduled" active={mode() === "cron"} running onPress={() => mode.set("cron")} testID="uig-view-cron" />
        <ViewToggle icon="PhTag" label="Tags" title="Tags" active={mode() === "tags"} onPress={() => mode.set("tags")} testID="uig-view-tags" />
      </V>
    </Col>
  );
}

export const CHAT_DEMOS: DemoMap = {
  ChatHistoryItem: { render: () => <HistoryDemo />, wide: true },
  ChatHistoryList: { render: () => <HistoryListDemo />, wide: true },
  ChatStatusCard: { render: () => <StatusCardDemo /> },
  ChatStatusMark: {
    render: () => (
      <Row>
        <Each of={["summary", "reply", "sent"] as const} key={(placement) => placement}>
          {(placement) => (
            <V l={placement()} row>
              <ChatStatusMark text="10:02" label="10:02" placement={placement()} onPress={() => act("ChatStatusMark", placement())} />
              <ChatStatusMark text="2m5s" label="2m5s" duration placement={placement()} onPress={() => act("ChatStatusMark", placement())} />
            </V>
          )}
        </Each>
      </Row>
    ),
  },
  ChatPlanSteps: { render: () => <ChatPlanSteps itemID="uig-plan" plan={PLAN} /> },
  ChatActivityEntries: { render: () => <ChatActivityEntries itemID="uig-activity" activity={ACTIVITY} />, wide: true },
  ActivityCallTree: { render: () => <ActivityCallTree itemID="uig-calls" calls={ACTIVITY.history[2].children} omitted={3} /> },
  ParamRow: {
    render: () => (
      <Col>
        <V s="default"><ParamRow name="path" value="notes/plan.md" /></V>
        <V s="long" l="limit 80"><ParamRow name="query" value={`${LONG_TEXT} ${LONG_WORD}`} limit={80} /></V>
      </Col>
    ),
  },
  ShellResult: {
    render: () => (
      <Col>
        <V s="error" l="exit 1"><ShellResult shell={ACTIVITY.history[1].shell} command="go test ./..." /></V>
        <V s="default" l="exit 0"><ShellResult shell={{ exitCode: 0, stdout: "ok", stderr: "", stdoutTruncated: false, stderrTruncated: false, stdoutOmitted: 0, stderrOmitted: 0, reason: "" }} command="true" /></V>
      </Col>
    ),
    wide: true,
  },
  ChatQuestionCard: { render: () => <QuestionDemo /> },
  ChatElevationCard: { render: () => <ElevationDemo /> },
  ChatSkillInstallPreview: { render: () => <ChatSkillInstallPreview preview={skillCard()} foldKey="uig-skill" folds={keyedState()} />, wide: true },
  ChatAgentLinkExchange: {
    render: () => (
      <ChatAgentLinkExchange
        itemID="uig-link"
        messages={ACTIVITY.history[3].messages.map((message: object, index: number) => ({ ...message, key: `uig-link:${index}` }))}
        endpointRef=""
        topicID=""
        folded={keyedState()}
        previews={previews}
      />
    ),
  },
  ChatWorkerRoster: {
    render: () => {
      const selected = signal("");
      return (
        <Col>
          <V s="default">
            <ChatWorkerRoster itemID="uig-roster" activity={ACTIVITY} status="running" selectedID={selected()} onSelect={(id) => selected.set(selected() === id ? "" : id)} />
            <Text class="text-xs text-muted-foreground" testID="uig-roster-echo">{t("uig_fixture_echo", { value: selected() })}</Text>
          </V>
        </Col>
      );
    },
  },
  ChatWorkerOutput: {
    render: () => (
      <Col>
        <Each of={replyWorkers(ACTIVITY, "running")} key={(worker) => worker.id}>
          {(worker) => (
            <V l={`${worker().kind} · ${worker().state ?? ""}`}>
              <ChatTerminal>
                <ChatWorkerOutput worker={worker()} ask={{ task: "Summarize the build log", settings: [{ key: "profile", value: "cheap" }], at: FIXED_ISO, calls: [], callsOmitted: 0 }} agentName="Morph" itemID="uig-worker" />
              </ChatTerminal>
            </V>
          )}
        </Each>
      </Col>
    ),
    wide: true,
  },
  WorkerAvatar: {
    render: () => (
      <V s="default" row>
        <Each of={replyWorkers(ACTIVITY, "running")} key={(worker) => worker.id}>{(worker) => <WorkerAvatar avatarStyle={worker().avatarStyle} />}</Each>
      </V>
    ),
  },
  ChatQuietRuns: { render: () => <QuietRunsDemo />, wide: true },
  ChatNoticeLine: {
    render: () => {
      const open = useFlag(false);
      return (
        <Col>
          <V s="default" l="notice"><ChatNoticeLine state="on" text="Context compacted. Earlier messages were summarized." /></V>
          <V s="busy" l="notice"><ChatNoticeLine state="running" text="Compacting context" /></V>
          <V s="error" l="notice"><ChatNoticeLine state="error" text="Context compaction failed." /></V>
          <V s={open.on() ? "open" : "closed"} l="fold head">
            <ChatNoticeLine
              state="off"
              text="8 runs, nothing to do"
              detail="09:00 – 12:30"
              open={open.on()}
              onPress={() => {
                open.toggle();
                act("ChatNoticeLine", open.on() ? "open" : "closed");
              }}
              testID="uig-notice-fold"
            />
          </V>
          <V s="long" l="fold head"><ChatNoticeLine state="off" text={LONG_TEXT} detail={LONG_WORD} onPress={() => act("ChatNoticeLine", "long")} /></V>
        </Col>
      );
    },
  },
  ChatSystemMessage: {
    render: () => (
      <Col>
        <V s="default"><ChatSystemMessage text="Context compacted." at="10:04" /></V>
        <V s="long"><ChatSystemMessage text={LONG_TEXT} /></V>
      </Col>
    ),
  },
  ChatLoadError: {
    render: () => {
      const busy = useFlag(false);
      return (
        <Col>
          <V s="error">
            <ChatLoadError title={t("uig_fixture_empty_title")} message={t("uig_fixture_error")} refreshLabel={t("action_refresh")} busy={busy.on()} onRefresh={() => { busy.toggle(); act("ChatLoadError", "refresh"); }} testID="uig-load-error" />
          </V>
          <V s="error" l="compact · long">
            <ChatLoadError compact title={LONG_TEXT} message={`${LONG_TEXT} ${LONG_WORD}`} refreshLabel={t("action_refresh")} busy={false} onRefresh={() => act("ChatLoadError", "refresh")} />
          </V>
        </Col>
      );
    },
  },
  MosaicText: {
    render: () => (
      <Row>
        <V s="default"><MosaicText text="hunter2-secret" label="Hidden" /></V>
        <V l="pitch 6"><MosaicText text="correct horse" pitch={6} /></V>
      </Row>
    ),
  },
  TopicTagsEditor: { render: () => <TagsDemo />, wide: true },
  ActivityDetailPanel: { render: () => <DetailPanelDemo />, wide: true },
  WorkspaceSheet: { render: () => <SheetsDemo /> },
  ChatComposer: {
    render: () => (
      <Col>
        <Each of={["default", "files", "sending", "voice", "disabled", "landing"] as const} key={(mode) => mode}>
          {(mode) => (
            <V l={mode()}>
              <View testID={`uig-composer-${mode()}`}>
                <ComposerDemo mode={mode()} />
              </View>
            </V>
          )}
        </Each>
      </Col>
    ),
    wide: true,
  },
  ChatMarkdown: {
    render: () => (
      <Col>
        <V s="default"><ChatMarkdown source={REPLY} copyLabel={t("action_copy")} /></V>
        <V s="loading" l="streaming"><ChatMarkdown source={"A reply that is still being wri"} streaming /></V>
      </Col>
    ),
    wide: true,
  },
  ChatRichContent: {
    render: () => <ChatRichContent source={REPLY} ownerKey="uig-rich" endpointRef="" previews={previews} />,
    wide: true,
  },
  ChatTerminal: {
    render: () => (
      <Col>
        <V s="default"><ChatTerminal><TerminalText text={TERMINAL} /></ChatTerminal></V>
        <V l="flush"><ChatTerminal flush><TerminalText text="flush: no padding of its own" /></ChatTerminal></V>
      </Col>
    ),
    wide: true,
  },
  TerminalText: {
    render: () => (
      <Col>
        <V s="default"><ChatTerminal><TerminalText text={TERMINAL} /></ChatTerminal></V>
        <V s="long" l="limit 120"><ChatTerminal><TerminalText text={`${TERMINAL}\n${TERMINAL}`} limit={120} /></ChatTerminal></V>
        <V s="empty"><ChatTerminal><TerminalText text="" /></ChatTerminal></V>
      </Col>
    ),
    wide: true,
  },
  StatusTag: {
    render: () => (
      <ChatTerminal>
        <View class="flex-row flex-wrap gap-2">
          <Each of={["queued", "running", "pending", "done", "failed", "canceled"]} key={(status) => status}>{(status) => <StatusTag status={status()} />}</Each>
        </View>
      </ChatTerminal>
    ),
  },
  KindChip: {
    render: () => (
      <ChatTerminal>
        <View class="flex-row flex-wrap gap-2">
          <KindChip label="coder" tone="cyan" />
          <KindChip label="subagent" tone="violet" />
          <KindChip label="idle" tone="idle" />
        </View>
        <Wide><KindChip label={LONG_WORD} /></Wide>
      </ChatTerminal>
    ),
  },
  OverflowLine: {
    render: () => (
      <Col>
        <V s="default"><ChatTerminal><OverflowLine><Text class="font-mono text-xs text-white">short line</Text></OverflowLine></ChatTerminal></V>
        <V s="long"><ChatTerminal><OverflowLine><Text class="font-mono text-xs text-white">{`${LONG_WORD} ${LONG_WORD} ${LONG_WORD}`}</Text></OverflowLine></ChatTerminal></V>
      </Col>
    ),
  },
  PinnedScroll: { render: () => <PinnedDemo /> },
  ReceivedFile: {
    render: () => (
      <Col>
        <V s="default"><ReceivedFile file={{ id: "rf1", name: "report.pdf", content_type: "application/pdf" }} taskID="uig-task" topicID="uig-topic" files={receivedFiles} downloadLabel={t("uig_fixture_open")} errorLabel={t("uig_fixture_error")} /></V>
        <V s="long"><ReceivedFile file={{ id: "rf2", name: `${LONG_WORD}.tar.gz`, content_type: "application/gzip" }} taskID="uig-task" topicID="uig-topic" files={receivedFiles} downloadLabel={t("uig_fixture_open")} errorLabel={t("uig_fixture_error")} /></V>
      </Col>
    ),
  },
  WorkspacePathLine: { render: () => <PathDemo /> },
};
