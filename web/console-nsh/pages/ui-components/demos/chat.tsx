// Gallery demos: the chat's rows, cards, terminal output and composer (components/chat, and the
// reusable parts of pages/chat). The history is fixed and synthetic; it is shaped by the same pure
// normalizers the chat uses (lib/core/chat-task-history.js), and every answer, approval, send and
// upload ends in the gallery's local action log.
import { signal, View } from "nsh";
import { AttachSourceSheet } from "../../../components/chat/AttachSourceSheet";
import { ChatComposer, type ComposerFileItem } from "../../../components/chat/ChatComposer";
import { ChatTerminal } from "../../../components/chat/ChatTerminal";
import { TerminalText } from "../../../components/chat/TerminalText";
import { TodoJobBar } from "../../../components/chat/TodoJobBar";
import { Button, Muted } from "../../../components/ui";
import { ViewToggle } from "../../chat/TopicSidebar";
import { WorkspacePanelTabs, WorkspaceSheet } from "../../chat/WorkspacePanel";
import { act, Col, type DemoMap, LONG_TEXT, LONG_WORD, t, useFlag, useText, V } from "../demo";

const TERMINAL = [
  "$ go test ./...",
  "ok  \texample.com/app/agent\t0.412s",
  "ok  \texample.com/app/tools\t1.038s",
  "--- FAIL: TestSynthetic (0.00s)",
  "    demo_test.go:12: expected 3, got 4",
  "FAIL\texample.com/app/demo\t0.019s",
  `warning: ${LONG_WORD}`,
].join("\n");

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
  TodoJobBar: {
    render: () => {
      const running = useFlag(false);
      return (
        <Col>
          <V s={running.on() ? "on" : "off"} l="idle / running">
            <TodoJobBar
              running={running.on()}
              toggleEnabled
              viewEnabled
              onStart={() => {
                running.toggle();
                act("TodoJobBar", "start");
              }}
              onStop={() => {
                running.toggle();
                act("TodoJobBar", "stop");
              }}
              onView={() => act("TodoJobBar", "view")}
            />
          </V>
          <V s="on" l="running"><TodoJobBar running toggleEnabled viewEnabled /></V>
          <V s="loading" l="start"><TodoJobBar running={false} busy toggleEnabled={false} viewEnabled /></V>
          <V s="busy" l="stopping"><TodoJobBar running busy toggleEnabled={false} viewEnabled /></V>
          <V s="error"><TodoJobBar running={false} toggleEnabled viewEnabled error="Could not start the run: runtime unavailable" /></V>
          <V s="disabled" l="loading item"><TodoJobBar running={false} toggleEnabled={false} viewEnabled /></V>
          <V s="disabled" l="gone"><TodoJobBar running={false} toggleEnabled={false} viewEnabled={false} note="The TODO item “Daily digest” no longer exists." /></V>
        </Col>
      );
    },
    wide: true,
  },
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
  ChatTerminal: {
    render: () => (
      <Col>
        <V s="default"><ChatTerminal><TerminalText text={TERMINAL} /></ChatTerminal></V>
        <V l="flush"><ChatTerminal flush><TerminalText text="flush: no padding of its own" /></ChatTerminal></V>
      </Col>
    ),
    wide: true,
  },
};
