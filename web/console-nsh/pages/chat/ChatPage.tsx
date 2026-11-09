// Chat: the agent's topics, the open conversation and its composer, and the topic and workspace
// panel (web/console/src/views/ChatView.js). On phones (≤ 980 points) the topic list and the
// conversation are separate views, and the panel is a sheet. The behaviour is in chatController.
import { Text, View } from "nsh";
import { Button, Fab, Icon, Kicker, MessageDialog, Page, Tip, TipButton } from "../../components/ui";
import { ChatComposer } from "../../components/chat/ChatComposer";
import { ChatHistoryList, chatGutter } from "../../components/chat/ChatHistoryList";
import { t } from "../../components/chat/i18n";
import { RawJsonDialog } from "../../components/shared/RawJsonDialog";
import { WorkspaceDirPickerDialog } from "../../components/shared/WorkspaceDirPickerDialog";
import { onSystemBack } from "../../lib/systemBack";
import { createChatController, type ChatController } from "./chatController";
import { FilePreviewDialog } from "./FilePreviewDialog";
import { TopicSidebar } from "./TopicSidebar";
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
      voicePreviewEnabled={c.voice.previewEnabled()}
      voiceLabels={{
        recording: t("chat_composer_voice_recording"),
        transcribing: t("chat_composer_voice_transcribing"),
        discard: t("chat_composer_voice_discard"),
        previewOn: t("chat_composer_voice_preview_on"),
        previewOff: t("chat_composer_voice_preview_off"),
      }}
      onSubmit={() => void c.submitTask()}
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

// The panel toggle (the Vue console's `.chat-workspace-dock`): a one-segment version of the
// panel's tabs, a 38pt outlined box with a 32pt square button inset in it, on the header line at
// the top right. Open, it takes the tabs' selected fill. The drawn sidebar is mirrored: the panel
// opens on the right.
function WorkspaceToggle(props: { c: ChatController; bare?: boolean }) {
  return (
    <View class={props.bare ? "" : "size-[38px] border border-line-soft bg-background p-0.5"}>
      <TipButton
        selected={props.c.workspaceSidebarOpen()}
        accessibilityLabel={props.c.workspaceSidebarToggleLabel()}
        tooltip={<Tip text={props.c.workspaceSidebarToggleLabel()} />}
        onPress={() => props.c.toggleWorkspaceSidebar()}
        testID="chat-workspace-toggle"
        class="size-8 items-center justify-center transition-colors duration-[180ms] hover:bg-hover-soft selected:bg-selection-strong"
      >
        <View style={{ scale: [-1, 1] }}>
          <Icon name="PhSidebarSimple" size={16} color={props.c.workspaceSidebarOpen() ? "blue-dark" : "muted-foreground"} />
        </View>
      </TipButton>
    </View>
  );
}

function ChatMain(props: { c: ChatController }) {
  const c = props.c;
  const dockVisible = () =>
    c.consoleTopicsEnabled() && !c.showChatPlaceholder() && c.workspaceSidebarAvailable() && !c.mobileMode() && c.showChatPane();
  return (
    <View class="flex-1" testID="chat-main">
      <If
        when={c.showChatPlaceholder()}
        else={
          <View class="flex-1">
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
              topInset={dockVisible() && !c.desktopWorkspaceSidebarVisible() ? 64 : 20}
            />
            <View class="w-full max-w-[832px] self-center" style={{ paddingLeft: chatGutter(), paddingRight: chatGutter() }}>
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
        <View class="absolute right-4 top-[9.5px]">
          <WorkspaceToggle c={c} />
        </View>
      </If>
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
        <Button variant="plain" size="xs" iconOnly icon="PhArrowLeft" title={t("chat_topics_title")} onPress={() => c.showTopicsView()} testID="chat-back" />
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
          <If when={c.desktopWorkspaceSidebarVisible()}>
            <WorkspacePanel c={c} class="w-[314px] pl-1" trailing={<WorkspaceToggle c={c} />} />
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
        <RawJsonDialog open={c.rawDialogOpen()} json={c.rawDialogJSON()} onClose={() => c.closeRawDialog()} />
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
