// Chat: the agent's topics, the open conversation and its composer, the topic and workspace panel at
// its right (web/console/src/views/ChatView.js); a reply's plan, progress, reasoning or worker opens
// in the frame's workbench, docked under the window (components/frame/Workbench.tsx). On phones (≤ 980 points) the topic list and the
// conversation are separate views, and the workspace panel is the right sheet. The behaviour is in
// chatController.
import { signal, Text, untracked, View } from "nsh";
import { BackButton, Fab, Icon, Kicker, MessageDialog, Page, PageBar, Tip, TipButton } from "../../components/ui";
import { ChatComposer } from "../../components/chat/ChatComposer";
import { ChatHistoryList, chatGutter } from "../../components/chat/ChatHistoryList";
import { MobileBarSpacer } from "../../components/frame/mobileBar";
import { ChatLoadError } from "../../components/chat/ChatLoadError";
import { t } from "../../components/chat/i18n";
import { RawJsonDialog } from "../../components/shared/RawJsonDialog";
import { WorkspaceDirPickerDialog } from "../../components/shared/WorkspaceDirPickerDialog";
import { onSystemBack } from "../../lib/systemBack";
import { markMobileDetail } from "../../lib/shell";
import { provideShortcut } from "../../lib/shortcuts";
import { createChatController, type ChatController } from "./chatController";
import { FilePreviewDialog } from "./FilePreviewDialog";
import { TopicRenameDialog } from "./TopicRenameDialog";
import { TopicSidebar } from "./TopicSidebar";
import { createPaneStack } from "../../components/motion/PaneStack";
import { ActivityDetailPanel } from "./ActivityDetailPanel";
import { WorkspacePanel, WorkspaceSheet } from "./WorkspacePanel";
import { useWorkbench } from "../../components/frame/Workbench";

function Composer(props: { c: ChatController; landing?: boolean }) {
  const c = props.c;
  return (
    <ChatComposer
      testID="chat-composer"
      value={c.taskInput()}
      onChange={(value) => c.setTaskInput(value)}
      landing={props.landing}
      disabled={c.composerDisabled()}
      placeholder={c.composerPlaceholder()}
      sendDisabled={c.sendDisabled()}
      sending={c.sending()}
      stopMode={c.composerStopMode()}
      attachActive={c.composerAttachActive()}
      attachDisabled={c.composerAddDisabled()}
      addLabel={t("chat_composer_add")}
      attachLabel={t("chat_composer_add_workspace")}
      uploadLabel={t("chat_composer_upload_files")}
      uploading={c.composerUploading()}
      fileItems={c.composerFiles()}
      fileLabels={{
        files: t("chat_composer_files"),
        preview: t("chat_composer_file_preview"),
        remove: t("chat_composer_file_remove"),
        uploading: t("chat_composer_file_uploading"),
        failed: t("chat_composer_upload_failed"),
        retry: t("chat_composer_file_retry"),
      }}
      sendLabel={c.composerActionLabel()}
      submitOnEnter={!c.mobileMode()}
      inputHistory={c.composerInputHistory()}
      commands={c.composerCommands()}
      skills={c.composerSkills()}
      skillsLoading={c.composerSkillsLoading()}
      skillsError={c.composerSkillsError()}
      suggestionLabels={{
        commands: t("chat_composer_suggestions_commands"),
        skills: t("chat_composer_suggestions_skills"),
        loading: t("chat_composer_suggestions_loading"),
        empty: t("chat_composer_suggestions_empty"),
      }}
      llmProfileItems={c.composerLLMProfileItems()}
      llmProfileValue={c.composerLLMProfile()}
      llmProfileLabel={t("chat_llm_profile_label")}
      onLLMProfileChange={(value) => c.setLLMProfile(value)}
      footerText={props.landing ? "" : c.chatDisclaimer()}
      voiceAvailable={c.voice.available()}
      voiceState={c.voice.state()}
      voiceLabel={
        c.voice.unsupported()
          ? t(`chat_composer_voice_${c.voice.unsupported()}_label`)
          : c.voice.state() === "recording"
            ? t("chat_composer_voice_stop")
            : t("chat_composer_voice")
      }
      voiceElapsed={c.voice.elapsed()}
      voicePreview={c.voice.preview()}
      voicePreviewEnabled={c.voice.previewable ? c.voice.previewEnabled() : null}
      voiceLabels={{
        recording: t("chat_composer_voice_recording"),
        transcribing: t("chat_composer_voice_transcribing"),
        discard: t("chat_composer_voice_discard"),
        previewOn: t("chat_composer_voice_preview_on"),
        previewOff: t("chat_composer_voice_preview_off"),
      }}
      onSubmit={(options) => void c.submitTask(options)}
      onStop={() => void c.stopActiveTask()}
      onAttach={() => c.openWorkspaceBrowser({ pending: true })}
      onUpload={() => void c.openComposerFilePicker()}
      onAttachFiles={(files) => void c.uploadComposerFileList(files)}
      onRetryFile={(item) => c.retryComposerFile(item)}
      onVoice={() => c.voice.toggle()}
      onVoiceCancel={() => c.voice.cancel()}
      onVoicePreviewToggle={() => c.voice.togglePreview()}
      onPreviewFile={(item) => c.previewComposerFile(item)}
      onRemoveFile={(item) => c.removeComposerFile(item)}
      onRequestCommands={() => void c.ensureComposerCommandsLoaded()}
      onRequestSkills={() => void c.ensureComposerSkillsLoaded()}
      onReady={(handle) => c.setComposerHandle(handle)}
    />
  );
}

// The panel toggle: a 38pt square with a 14pt icon, on the header line at the top right, in the
// same place whether the panel is shut (over the conversation) or open (at the end of the panel's
// tab row). Open, a blue icon on a blue tint. The drawn sidebar is mirrored: the panel opens on the
// right.
function WorkspaceToggle(props: { c: ChatController; bare?: boolean }) {
  const open = () => props.c.workspaceSidebarOpen();
  return (
    <TipButton
      selected={open()}
      accessibilityLabel={props.c.workspaceSidebarToggleLabel()}
      tooltip={<Tip text={props.c.workspaceSidebarToggleLabel()} />}
      onPress={() => props.c.toggleWorkspaceSidebar()}
      testID="chat-workspace-toggle"
      class={`${props.bare ? "size-8" : "size-[38px]"} items-center justify-center rounded-(--radius) transition-colors duration-[180ms] hover:bg-hover-soft selected:bg-blue/12`}
    >
      <View style={{ scale: [-1, 1] }}>
        <Icon name="PhSidebarSimple" size={props.bare ? 16 : 14} color={open() ? "blue" : "subtle"} />
      </View>
    </TipButton>
  );
}

/** The detail panel of the reply entry the page has open, in the workbench (kept while it goes out). */
function DetailPanel(props: { c: ChatController; phone?: boolean; class?: string }) {
  const c = props.c;
  const shown = () => c.workbenchDetail();
  const item = () => c.workbenchDetailItem();
  return (
    <If when={shown()}>
      {(detail) => (
        <ActivityDetailPanel
          detail={detail()}
          item={item()}
          context={c.activityDetailContextOf(item())}
          endpointRef={c.submitEndpointRef()}
          topicID={c.selectedTopicID()}
          previews={c.rowContext.previews}
          phone={props.phone}
          dark
          agentName={c.activeAgentName()}
          // Not while it slides out (nothing is open to close).
          escape={!c.pageDialogOpen() && c.activityDetail() !== null}
          class={props.class}
          onClose={() => c.closeActivityDetail()}
        />
      )}
    </If>
  );
}

function History(props: { c: ChatController; topInset: number; endInset: number }) {
  const c = props.c;
  return (
    <ChatHistoryList
      items={c.chatHistoryItems()}
      loading={c.historySwitching()}
      loadingText={t("chat_history_loading")}
      emptyText={t("chat_empty")}
      hasOlder={Boolean(c.historyNextCursor())}
      loadingOlder={c.historyLoadingOlder()}
      olderLabel={t("chat_history_load_older")}
      onLoadOlder={() => void c.loadOlderHistory()}
      ctx={c.rowContext}
      onListRef={(list) => c.setHistoryList(list)}
      onScrollFromEnd={(distance, viewport) => c.setHistoryScroll(distance, viewport)}
      // The same room at the top whether the panel is open or not, so opening it never moves the
      // conversation down or up.
      topInset={props.topInset}
      endInset={props.endInset}
    />
  );
}

/** The conversation (or the topic list) failed to load: the panel in its place, or the strip over the composer. */
function LoadError(props: { c: ChatController; compact?: boolean; testID: string }) {
  const c = props.c;
  return (
    <ChatLoadError
      compact={props.compact}
      title={c.chatLoadErrorTitle()}
      message={c.chatLoadErrorMessage()}
      refreshLabel={t("action_refresh")}
      busy={c.chatLoadBusy()}
      onRefresh={() => void c.retryChatLoad()}
      testID={props.testID}
    />
  );
}

function ChatMain(props: { c: ChatController }) {
  const c = props.c;
  // A failed load with nothing to show takes the place of the landing (no topic) and the history.
  const placeholder = () => c.showChatPlaceholder() && !c.chatLoadErrorFull();
  const dockVisible = () =>
    c.consoleTopicsEnabled() && !placeholder() && c.workspaceSidebarAvailable() && !c.mobileMode() && c.showChatPane();
  // The composer floats over the conversation's foot: the history keeps its height (with the fade
  // over it) as room under the newest message, so that message scrolls clear of both, and the room
  // follows the composer as it grows.
  const composerRoom = signal(0);
  return (
    <View class="flex-1" testID="chat-main">
      <If
        when={placeholder()}
        else={
          <View class="relative flex-1">
            <If when={c.chatLoadErrorFull()} else={<History c={c} topInset={dockVisible() ? 64 : 20} endInset={composerRoom()} />}>
              <LoadError c={c} testID="chat-load-error" />
            </If>
            {/* Over the history's foot, fading from it to the page (what scrolls behind the footer
                line stays readable); presses on the fade reach the history. */}
            <View
              class="absolute bottom-0 left-0 right-0 bg-linear-to-b from-transparent to-background pt-6"
              style={{ pointerEvents: "box-none" }}
              onLayout={({ bounds }) => composerRoom.set(bounds.size.height)}
              testID="chat-composer-float"
            >
              <View class="w-full max-w-[832px] self-center" style={{ paddingLeft: chatGutter(), paddingRight: chatGutter() }}>
                <If when={c.chatLoadErrorKind() !== "" && !c.chatLoadErrorFull()}>
                  <LoadError c={c} compact testID="chat-load-error-strip" />
                </If>
                <If
                  when={c.selectedTopicIsAgent()}
                  else={
                    <If when={c.selectedTopicIsCron()} else={<Composer c={c} />}>
                      <Text class="border-t border-line-soft px-3.5 py-3 text-center text-sm text-muted-foreground" testID="chat-readonly-topic">
                        {t("chat_topic_cron_readonly", { name: c.deskTitle() })}
                      </Text>
                    </If>
                  }
                >
                  <Text class="border-t border-line-soft px-3.5 py-3 text-center text-sm text-muted-foreground" testID="chat-readonly-topic">
                    {t("chat_topic_agent_readonly", { name: c.deskTitle() })}
                  </Text>
                </If>
              </View>
            </View>
          </View>
        }
      >
        <View class="w-full max-w-3xl flex-1 justify-center gap-5 self-center px-5" testID="chat-placeholder">
          <View class="gap-1.5">
            <Text class="text-xl font-semibold text-foreground" role="header">
              {c.deskTitle()}
            </Text>
            <Text class="text-sm text-muted-foreground">{c.chatPlaceholderHint()}</Text>
          </View>
          <Composer c={c} landing />
        </View>
      </If>
      <If when={dockVisible() && !c.desktopWorkspaceSidebarVisible()}>
        <View class="absolute right-3 top-2">
          <WorkspaceToggle c={c} />
        </View>
      </If>
      {/* On a phone the bottom navigation floats over the foot of a new topic (and of a chat without
          topics; an open topic hides it): the new-topic form, centred above it, and the composer of a
          first send in flight or failed end clear of the bar, the keyboard and the safe area. */}
      <MobileBarSpacer testID="chat-main-bar-room" />
    </View>
  );
}

export function ChatPage() {
  const c = createChatController();
  // On phones the topic list (0) and a conversation (1) are levels of the page: opening a topic
  // slides it in, going back slides it out over the list. The conversation keeps its bar and its
  // topic until it has gone.
  const panes = createPaneStack(() => (c.mobileTopicSplitEnabled() ? (c.showChatPane() ? 1 : 0) : null));
  // Asked as the route lets the topic go: the slide has started by then (or starts as the effects
  // of this change run), so look a microtask later.
  c.setConversationExit(() => Promise.resolve().then(() => (untracked(panes.exiting) === 1 ? panes.settled() : undefined)));
  // Asked a microtask after a new topic opens (the slide has started by then): while the
  // conversation slides in over the list, once it is in place; null when nothing slides.
  c.setConversationEntry(() => (untracked(panes.sliding) === "push" ? panes.settled() : null));
  // A reply's details open in the frame's workbench, under every column, on every screen.
  useWorkbench(
    () => c.activityDetailVisible(),
    () => c.detailSheetKey(),
    () => <DetailPanel c={c} phone={c.mobileMode()} class="flex-1" />,
  );
  const barShowsBack = panes.held(1, () => c.mobileShowBack());
  const barTitle = panes.held(1, () => (c.mobileTopicSplitEnabled() ? c.mobileBarTitle() : t("chat_title")));
  const barShowsWorkspace = panes.held(1, () => c.mobileTopicSplitEnabled() && c.showChatPane() && c.workspaceSidebarAvailable());
  // A conversation over the topic list (an open topic, a new one) is not the navigation's page:
  // the bottom navigation steps aside. Without topics the conversation is the page itself.
  markMobileDetail(() => c.mobileShowBack());
  // Android's Back from an open topic goes to the topic list, as the bar's back arrow does.
  onSystemBack(
    () => c.mobileShowBack(),
    () => c.showTopicsView(),
  );
  // Keyboard shortcuts (lib/shortcuts.ts): a new topic, and back to the message field.
  provideShortcut(
    "chat.newTopic",
    () => c.startNewTopic(),
    () => c.consoleTopicsEnabled() && !c.chatReadonly(),
  );
  provideShortcut(
    "chat.focusComposer",
    () => c.focusComposer(),
    () => c.showChatPane() && !c.chatReadonly(),
  );
  // With the details open, Back closes them first (a newer registration goes first).
  onSystemBack(
    () => c.activityDetailVisible(),
    () => c.closeActivityDetail(),
  );

  const mobileLeading = () => (
    <View class="flex-1 flex-row items-center gap-2">
      <If when={barShowsBack()}>
        <BackButton title={t("chat_topics_title")} onPress={() => c.mobileBack()} testID="chat-back" />
      </If>
      <Text class="flex-1 text-xl leading-6 tracking-[-0.03em] text-foreground line-clamp-1" role="header">
        {barTitle()}
      </Text>
      <If when={barShowsWorkspace()}>
        <WorkspaceToggle c={c} bare />
      </If>
    </View>
  );

  return (
    <Page
      title={t("chat_title")}
      error={c.err()}
      scroll={false}
      // With topics, the phone's bar belongs to the conversation (it slides with it), below.
      hideBar={!c.mobileMode() || (c.chatReadonly() ? c.showTopicSidebar() : c.mobileTopicSplitEnabled())}
      leading={c.consoleTopicsEnabled() ? mobileLeading() : undefined}
      testID="chat-page"
    >
      <If
        when={!c.chatReadonly()}
        else={
          <View class="flex-1 items-center justify-center p-6" testID="chat-readonly">
            <View class="w-full max-w-md gap-2 rounded-(--radius) border border-line-faint bg-card p-5">
              <Kicker right={<Text class="font-mono text-xs uppercase text-muted-foreground">Read Only</Text>}>{c.readonlyKickerLeft()}</Kicker>
              <Text class="text-sm text-subtle">{c.readonlyReason()}</Text>
            </View>
          </View>
        }
      >
        <View class="flex-1 flex-row">
          <If when={panes.shown(0, c.showTopicSidebar())}>
            <TopicSidebar
              c={c}
              class={c.mobileTopicSplitEnabled() ? "flex-1" : "w-[314px] pr-1"}
              style={panes.style(0)}
              hidden={panes.hidden(0)}
            />
          </If>
          <If when={panes.shown(1, c.showChatPane())}>
            <View
              class="flex-1"
              style={panes.style(1)}
              accessibilityElementsHidden={panes.hidden(1) || undefined}
              importantForAccessibility={panes.hidden(1) ? "no-hide-descendants" : undefined}
              testID="chat-conversation-pane"
            >
              <If when={c.mobileMode() && c.mobileTopicSplitEnabled()}>
                <PageBar leading={mobileLeading()} />
              </If>
              <ChatMain c={c} />
            </View>
          </If>
          <If when={c.desktopRightPanelVisible()}>
            <View class="w-[314px] pl-1" testID="chat-right-panel">
              <WorkspacePanel c={c} class="flex-1" trailing={<WorkspaceToggle c={c} />} />
            </View>
          </If>
        </View>
        <If when={c.showTopicSidebar() && c.mobileTopicSplitEnabled()}>
          <Fab label={t("chat_topic_new")} onPress={() => c.startNewTopic()} testID="chat-topic-new-fab" />
        </If>
        <WorkspaceSheet open={c.mobileWorkspaceSidebarVisible()} onClose={() => c.closeMobileWorkspaceSidebar()}>
          <WorkspacePanel c={c} class="flex-1" phone />
        </WorkspaceSheet>
        <WorkspaceDirPickerDialog
          open={c.workspaceBrowserOpen()}
          endpointRef={c.submitEndpointRef()}
          initialDir={c.workspaceBrowserInitialDir()}
          confirming={c.workspaceSaving()}
          confirmDisabled={c.workspaceBrowserConfirmDisabled()}
          onClose={() => c.closeWorkspaceBrowser()}
          onConfirm={(dir) => void c.attachWorkspace(dir)}
        />
        <FilePreviewDialog c={c} />
        <RawJsonDialog open={c.rawDialogOpen()} json={c.rawDialogJSON()} onClose={() => c.closeRawDialog()} testID="chat-raw-json" />
        <TopicRenameDialog rename={c.topicRename} regenerateDisabled={c.topicRenameRegenerateDisabled()} />
        <MessageDialog
          open={c.topicDeleteDialogOpen()}
          onClose={() => c.closeTopicDeleteDialog()}
          icon="PhTrash"
          tone="danger"
          title={t("chat_topic_delete_action")}
          text={c.topicDeleteDialogText()}
          testID="chat-topic-delete-dialog"
          actions={[
            { id: "cancel", label: t("action_cancel"), variant: "outlined", onPress: () => c.closeTopicDeleteDialog() },
            { id: "delete", label: t("action_delete"), variant: "danger", onPress: () => void c.deleteSelectedTopic() },
          ]}
        />
      </If>
    </Page>
  );
}
