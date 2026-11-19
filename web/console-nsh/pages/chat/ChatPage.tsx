// Chat: the agent's topics, the open conversation and its composer, the topic and workspace panel at
// its right (web/console/src/views/ChatView.js); a reply's plan, progress, reasoning or worker opens
// in the frame's workbench, docked under the window (components/frame/Workbench.tsx). On phones (≤ 980 points) the topic list and the
// conversation are separate views, and the workspace panel is the right sheet. The behaviour is in
// chatController.
import { signal, Text, token, untracked, View } from "nsh";
import { BackButton, Fab, Icon, Kicker, MessageDialog, Page, PageBar, Tip, TipButton } from "../../components/ui";
import { ChatComposer } from "../../components/chat/ChatComposer";
import { editQuoteLine } from "../../lib/core/chat-message-edit.js";
import { ChatHistoryList, chatGutter } from "../../components/chat/ChatHistoryList";
import { COMPOSER_RADIUS } from "../../components/chat/composerField";
import { barRoom, underBar } from "../../components/frame/glassBar";
import { MobileBarSpacer } from "../../components/frame/mobileBar";
import { glassEnabled } from "../../lib/glass";
import { ChatLoadError } from "../../components/chat/ChatLoadError";
import { TodoJobBar } from "../../components/chat/TodoJobBar";
import { t } from "../../components/chat/i18n";
import { RawJsonDialog } from "../../components/shared/RawJsonDialog";
import { WorkspaceDirPickerDialog } from "../../components/shared/WorkspaceDirPickerDialog";
import { onSystemBack } from "../../lib/systemBack";
import { scrollAreaKey } from "../../lib/scrollMemory";
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

function Composer(props: { c: ChatController; landing?: boolean; onFootRoom?: (height: number) => void }) {
  const c = props.c;
  return (
    <ChatComposer
      testID="chat-composer"
      value={c.taskInput()}
      onChange={(value) => c.setTaskInput(value)}
      landing={props.landing}
      onFootRoom={(height) => props.onFootRoom?.(height)}
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
      // An edit sends text alone: the draft's files wait with the draft (chatController's MessageEdit).
      uploading={!c.messageEdit() && c.composerUploading()}
      fileItems={c.messageEdit() ? [] : c.composerFiles()}
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
      editQuote={c.messageEdit()?.text}
      editLabels={{
        title: t("chat_message_edit_title"),
        cancel: t("chat_message_edit_cancel"),
        quote: t("chat_message_edit_quote", { text: editQuoteLine(c.messageEdit()?.text) }),
      }}
      onEditCancel={() => c.cancelMessageEdit()}
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
      onUploadFrom={(source) => void c.openComposerFilePicker(source)}
      uploadSourceLabels={{
        title: t("chat_composer_upload_files"),
        gallery: t("chat_composer_upload_gallery"),
        galleryHint: t("chat_composer_upload_gallery_hint"),
        files: t("chat_composer_upload_file"),
        filesHint: t("chat_composer_upload_file_hint"),
      }}
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
          onProcessesEnded={(byStop) => c.closeEndedProcesses(detail(), byStop)}
        />
      )}
    </If>
  );
}

function History(props: { c: ChatController; topInset: number; endInset: number }) {
  const c = props.c;
  // Where the conversation was left scrolled up, across visits of the page.
  const memoryKey = scrollAreaKey(3, "history");
  return (
    <ChatHistoryList
      items={c.chatHistoryItems()}
      loading={c.historySwitching()}
      loadingText={t("chat_history_loading")}
      emptyText={t("chat_empty")}
      hasOlder={Boolean(c.historyNextCursor())}
      loadingOlder={c.historyLoadingOlder()}
      olderLabel={t("chat_history_load_older")}
      olderLoadingLabel={t("chat_history_loading_older")}
      onLoadOlder={() => void c.loadOlderHistory()}
      ctx={c.rowContext}
      onListRef={(list) => c.setHistoryList(list)}
      memoryKey={memoryKey}
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

/** `underBar`: the phone's bar lies directly over it; where the bar is glass the history runs on under it. */
/** A TODO item's topic's foot: the item's toolbar (Start or Stop, View Job) on the chat's job state. */
function TodoJobToolbar(props: { c: ChatController }) {
  const job = props.c.todoJob;
  const error = () => {
    const failure = job.error();
    if (!failure) return "";
    const detail = failure.message || t("msg_load_failed");
    if (failure.kind === "stop") return t("todo_stop_failed", { error: detail });
    if (failure.kind === "start") return t("chat_todo_job_start_failed", { error: detail });
    return t("chat_todo_job_load_failed", { error: detail });
  };
  return (
    <TodoJobBar
      running={job.running()}
      busy={job.pending() === "start" || job.stopping()}
      toggleEnabled={job.running() ? job.canStop() : job.canStart()}
      viewEnabled={job.canView()}
      note={job.status() === "missing" ? t("chat_todo_job_missing", { name: props.c.deskTitle() }) : ""}
      error={error()}
      onStart={() => void job.start()}
      onStop={() => void job.stop()}
      onView={props.c.viewTodoJob}
    />
  );
}

function ChatMain(props: { c: ChatController; underBar?: boolean }) {
  const c = props.c;
  // Not a failed load's panel, which is centred in the room under the bar.
  const underGlassBar = () => Boolean(props.underBar) && !c.chatLoadErrorFull();
  const barInset = () => (underGlassBar() ? barRoom() : 0);
  // A failed load with nothing to show takes the place of the landing (no topic) and the history.
  const placeholder = () => c.showChatPlaceholder() && !c.chatLoadErrorFull();
  const dockVisible = () =>
    c.consoleTopicsEnabled() && !placeholder() && c.workspaceSidebarAvailable() && !c.mobileMode() && c.showChatPane();
  // The composer floats over the conversation's foot: the history keeps its height (with the fade
  // over it) as room under the newest message, so that message scrolls clear of both, and the room
  // follows the composer as it grows.
  const composerRoom = signal(0);
  // Where the window draws glass the composer's frame is glass, and the conversation shows through
  // it: the fade to the page is then solid only under the frame (the footer line stays readable
  // over the paper) and ends behind the frame's lower corners, not across all of it.
  const footRoom = signal(0);
  const readonlyTopic = () => c.selectedTopicIsAgent() || c.selectedTopicIsCron();
  const glassFloat = () => glassEnabled() && !readonlyTopic() && footRoom() > 0;
  // A TODO item's toolbar floats on the conversation as the bottom navigation floats on a page: where
  // the window draws glass the conversation runs on behind it, with no fade to the paper.
  const glassJobBar = () => glassEnabled() && c.selectedTopicIsCron() && !c.selectedTopicIsAgent();
  const floatFade = () => {
    const paper = String(token("background"));
    const solid = Math.round(footRoom());
    return `linear-gradient(to top, ${paper} 0px, ${paper} ${solid}px, ${paper.slice(0, 7)}00 ${solid + COMPOSER_RADIUS}px)`;
  };
  return (
    <View class="flex-1" testID="chat-main">
      <If
        when={placeholder()}
        else={
          <View class="relative flex-1" style={underGlassBar() ? underBar() : undefined}>
            <If when={c.chatLoadErrorFull()} else={<History c={c} topInset={(dockVisible() ? 64 : 20) + barInset()} endInset={composerRoom()} />}>
              <LoadError c={c} testID="chat-load-error" />
            </If>
            {/* Over the history's foot, fading from it to the page (what scrolls behind the footer
                line stays readable); presses on the fade reach the history. */}
            <View
              class={`absolute bottom-0 left-0 right-0 pt-6 ${glassFloat() || glassJobBar() ? "" : "bg-linear-to-b from-transparent to-background"}`}
              style={glassFloat() ? { pointerEvents: "box-none", backgroundImage: floatFade() } : { pointerEvents: "box-none" }}
              onLayout={({ bounds }) => composerRoom.set(bounds.size.height)}
              testID={glassFloat() || glassJobBar() ? "chat-composer-float.glass" : "chat-composer-float"}
            >
              <View class="w-full max-w-[832px] self-center" style={{ paddingLeft: chatGutter(), paddingRight: chatGutter() }}>
                <If when={c.chatLoadErrorKind() !== "" && !c.chatLoadErrorFull()}>
                  <LoadError c={c} compact testID="chat-load-error-strip" />
                </If>
                <If
                  when={c.selectedTopicIsAgent()}
                  else={
                    <If when={c.selectedTopicIsCron()} else={<Composer c={c} onFootRoom={(height) => footRoom.set(height)} />}>
                      <TodoJobToolbar c={c} />
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

/** The conversation pane's test id: `.paper` where it draws the page's paper (the phone's pane over the topic list). */
export function conversationPaneTestID(paper: string) {
  return paper ? "chat-conversation-pane.paper" : "chat-conversation-pane";
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
      // The conversation runs on under the phone's bar (ChatMain).
      glassBar
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
            {/* The phone's conversation is a page over the topic list: on the page's paper, so the
                list does not show through it as it slides in or out (a new topic is mostly empty).
                The test id says so (`chat-conversation-pane.paper`). */}
            <View
              class={`flex-1 ${panes.paper(1)}`}
              style={panes.style(1)}
              accessibilityElementsHidden={panes.hidden(1) || undefined}
              importantForAccessibility={panes.hidden(1) ? "no-hide-descendants" : undefined}
              testID={conversationPaneTestID(panes.paper(1))}
            >
              <If when={c.mobileMode() && c.mobileTopicSplitEnabled()}>
                <PageBar leading={mobileLeading()} glass />
              </If>
              <ChatMain c={c} underBar={c.mobileMode()} />
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
