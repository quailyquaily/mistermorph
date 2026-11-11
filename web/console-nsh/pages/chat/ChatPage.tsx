// Chat: the agent's topics, the open conversation and its composer, and the panel at its right
// (web/console/src/views/ChatView.js): the topic and workspace panel, or the temporary detail panel
// of a reply's plan, progress, reasoning or worker, never both. On phones (≤ 980 points) the topic
// list and the conversation are separate views, and the panel is a sheet. The behaviour is in
// chatController.
import { Text, View } from "nsh";
import { BackButton, Fab, Icon, Kicker, MessageDialog, Page, Tip, TipButton } from "../../components/ui";
import { ChatComposer } from "../../components/chat/ChatComposer";
import { ChatHistoryList, chatGutter } from "../../components/chat/ChatHistoryList";
import { MobileBarSpacer } from "../../components/frame/mobileBar";
import { ChatLoadError } from "../../components/chat/ChatLoadError";
import { t } from "../../components/chat/i18n";
import { RawJsonDialog } from "../../components/shared/RawJsonDialog";
import { WorkspaceDirPickerDialog } from "../../components/shared/WorkspaceDirPickerDialog";
import { onSystemBack } from "../../lib/systemBack";
import { createChatController, type ChatController } from "./chatController";
import { FilePreviewDialog } from "./FilePreviewDialog";
import { TopicRenameDialog } from "./TopicRenameDialog";
import { TopicSidebar } from "./TopicSidebar";
import { Entrance } from "../../components/motion";
import { ActivityDetailPanel } from "./ActivityDetailPanel";
import { WorkspacePanel, WorkspaceSheet } from "./WorkspacePanel";

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

// The panel toggle: a 38pt square with a 14pt icon, as the Topics head's view toggles, on the
// header line at the top right, in the same place whether the panel is shut (over the
// conversation) or open (at the end of the panel's tab row). Open, a blue icon on a blue tint. The
// drawn sidebar is mirrored: the panel opens on the right.
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

/** The detail panel of the reply entry the page has open, if any; on phones, the sheet's (kept while it goes out). */
function DetailPanel(props: { c: ChatController; phone?: boolean; class?: string }) {
  const c = props.c;
  const shown = () => (props.phone ? c.mobileSheetDetail() : c.activityDetail());
  const item = () => (props.phone ? c.mobileSheetDetailItem() : c.activityDetailItem());
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
          escape={!c.pageDialogOpen()}
          class={props.class}
          onClose={() => c.closeActivityDetail()}
        />
      )}
    </If>
  );
}

function History(props: { c: ChatController; topInset: number }) {
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
  return (
    <View class="flex-1" testID="chat-main">
      <If
        when={placeholder()}
        else={
          <View class="flex-1">
            <If when={c.chatLoadErrorFull()} else={<History c={c} topInset={dockVisible() ? 64 : 20} />}>
              <LoadError c={c} testID="chat-load-error" />
            </If>
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
  // Android's Back from an open topic goes to the topic list, as the bar's back arrow does.
  onSystemBack(
    () => c.mobileShowBack(),
    () => c.showTopicsView(),
  );

  const mobileLeading = () => (
    <View class="flex-1 flex-row items-center gap-2">
      <If when={c.mobileShowBack()}>
        <BackButton title={t("chat_topics_title")} onPress={() => c.mobileBack()} testID="chat-back" />
      </If>
      <Text class="flex-1 text-xl leading-6 tracking-[-0.03em] text-foreground line-clamp-1" role="header">
        {c.mobileTopicSplitEnabled() ? c.mobileBarTitle() : t("chat_title")}
      </Text>
      <If when={c.mobileTopicSplitEnabled() && c.showChatPane() && c.workspaceSidebarAvailable()}>
        <WorkspaceToggle c={c} bare />
      </If>
    </View>
  );

  return (
    <Page
      title={t("chat_title")}
      error={c.err()}
      scroll={false}
      hideBar={!c.mobileMode() || c.showTopicSidebar()}
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
          <If when={c.showTopicSidebar()}>
            <TopicSidebar c={c} class={c.mobileTopicSplitEnabled() ? "flex-1" : "w-[314px] pr-1"} />
          </If>
          <If when={c.showChatPane()}>
            <ChatMain c={c} />
          </If>
          {/* One column for either panel: switching between them (or between entries) keeps the
              column and plays the new content's entrance, with no outgoing panel beside it. */}
          <If when={c.desktopRightPanelVisible()}>
            <Entrance watch={c.rightPanelKey()} class="w-[314px] pl-1" testID="chat-right-panel">
              <If
                when={c.desktopActivityDetailVisible()}
                else={<WorkspacePanel c={c} class="flex-1" trailing={<WorkspaceToggle c={c} />} />}
              >
                <DetailPanel c={c} class="flex-1" />
              </If>
            </Entrance>
          </If>
        </View>
        <If when={c.showTopicSidebar() && c.mobileTopicSplitEnabled()}>
          <Fab label={t("chat_topic_new")} onPress={() => c.startNewTopic()} testID="chat-topic-new-fab" />
        </If>
        <WorkspaceSheet
          open={c.mobileWorkspaceSidebarVisible() || c.mobileActivityDetailVisible()}
          wide={c.mobileSheetDetail() !== null}
          onClose={() => (c.mobileActivityDetailVisible() ? c.closeActivityDetail() : c.closeMobileWorkspaceSidebar())}
        >
          {/* What the sheet showed stays while it goes out (chatController's mobileSheetDetail). */}
          <If when={c.mobileSheetDetail() !== null} else={<WorkspacePanel c={c} class="flex-1" phone />}>
            <DetailPanel c={c} class="flex-1" phone />
          </If>
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
