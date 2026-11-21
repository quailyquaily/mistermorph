// The UI component gallery's inventory (/ui-components): every component of the console, by the
// file it is in, with how the gallery shows it. `scripts/ui-components-inventory.test.mjs` reads
// the sources and fails when a component is missing here, or when an entry names one that is gone.
//
// A component is one of:
//   demo      the production component, mounted on the page with synthetic props (./demos)
//   composed  shown inside another component's demo (`via`): a file-private part, or a host that
//             only ever appears through what opens it
//   listed    not mounted, with the reason; `via` names what to look at instead, where there is one
//
// The reasons (their texts are the `uig_reason_*` strings in lib/i18n):
//   live      mounting it reads live stores or calls the console or an agent by itself
//   page      a whole page, bound to its route and its data: open it at its own address
//   frame     part of the app's frame, bound to the router and the shell's state
//   part      a file-private part of `via`, which is not mounted here
//   nonvisual draws nothing of its own (a spacer, a measurer, a context, a host for the browser tab)
//   host      needs something only a device or a picked file gives

/**
 * @typedef {"demo" | "composed" | "listed"} GalleryMode
 * @typedef {"live" | "page" | "frame" | "part" | "nonvisual" | "host"} GalleryReason
 * @typedef {{ id: string, name: string, file: string, group: string, mode: GalleryMode, via?: string, reason?: GalleryReason }} GalleryEntry
 * @typedef {{ mode: GalleryMode, group?: string, via?: string, reason?: GalleryReason }} Spec
 */

/** The gallery's sections, in order; `titleKey` (and `titleKey + "_note"`) are in lib/i18n. */
export const GALLERY_GROUPS = [
  { id: "controls", titleKey: "uig_group_controls" },
  { id: "feedback", titleKey: "uig_group_feedback" },
  { id: "overlays", titleKey: "uig_group_overlays" },
  { id: "layout", titleKey: "uig_group_layout" },
  { id: "frame", titleKey: "uig_group_frame" },
  { id: "motion", titleKey: "uig_group_motion" },
  { id: "chat", titleKey: "uig_group_chat" },
  { id: "composer", titleKey: "uig_group_composer" },
  { id: "rich", titleKey: "uig_group_rich" },
  { id: "knowledge", titleKey: "uig_group_knowledge" },
  { id: "settings", titleKey: "uig_group_settings" },
  { id: "forms", titleKey: "uig_group_forms" },
  { id: "observe", titleKey: "uig_group_observe" },
  { id: "todo", titleKey: "uig_group_todo" },
  { id: "contacts", titleKey: "uig_group_contacts" },
  { id: "pages", titleKey: "uig_group_pages" },
];

/** @type {(group?: string) => Spec} */
const D = (group) => ({ mode: "demo", group });
/** @type {(via: string, group?: string) => Spec} */
const C = (via, group) => ({ mode: "composed", via, group });
/** @type {(reason: GalleryReason, via?: string, group?: string) => Spec} */
const L = (reason, via, group) => ({ mode: "listed", reason, via, group });

/** By file: the file's default section, and each component in it. @type {Record<string, { group: string, items: Record<string, Spec> }>} */
const FILES = {
  "components/ui.tsx": {
    group: "controls",
    items: {
      Icon: D(),
      StatusMark: D("feedback"),
      Spinner: D("feedback"),
      Kicker: D("layout"),
      Heading: D("layout"),
      Muted: D("layout"),
      Markdown: D("rich"),
      Tip: D("overlays"),
      TipButton: D(),
      BusyBeam: D("feedback"),
      CircleButton: D(),
      Button: D(),
      TextField: D(),
      Toggle: D(),
      CheckboxField: D(),
      SelectField: D(),
      DropdownMenu: D("overlays"),
      MenuIconTrigger: C("DropdownMenu", "overlays"),
      PopupTitle: D("overlays"),
      PopupSheet: D("overlays"),
      PopupList: C("PopupSheet", "overlays"),
      Badge: D("feedback"),
      Divider: D("layout"),
      Card: D("layout"),
      Section: D("layout"),
      LegacySection: C("Section", "layout"),
      SectionVue: C("Section", "layout"),
      Skeleton: D("feedback"),
      EmptyState: D("feedback"),
      LoadingLine: D("feedback"),
      ProgressBar: D("feedback"),
      Tabs: D(),
      DialogLayer: D("overlays"),
      DialogActions: C("DialogLayer", "overlays"),
      UnderContext: L("nonvisual", "DialogActions", "overlays"),
      Modal: D("overlays"),
      MessageDialog: D("overlays"),
      ConfirmHost: D("overlays"),
      NoticeHost: D("feedback"),
      Page: D("layout"),
      PageBar: D("layout"),
      PageTitle: D("layout"),
      BackButton: D(),
      SidePane: D("overlays"),
      SidePaneColumn: C("SidePane", "overlays"),
      Fab: D(),
      FabMark: C("Fab"),
    },
  },
  "components/LanguageSelector.tsx": { group: "controls", items: { LanguageSelector: D() } },
  "components/Shell.tsx": { group: "frame", items: { Shell: L("frame", "NavList") } },

  "components/frame/AgentFavicon.tsx": { group: "frame", items: { AgentFavicon: L("nonvisual") } },
  "components/frame/AgentSwitcher.tsx": {
    group: "frame",
    items: { AgentAvatar: D(), ConnectionMark: D(), AgentPicker: D(), AgentList: C("AgentPicker"), AgentSwitcher: D() },
  },
  "components/frame/InsecureBanner.tsx": { group: "frame", items: { InsecureBanner: L("live") } },
  "components/frame/MobileBottomNav.tsx": {
    group: "frame",
    items: {
      MobileBottomMenus: L("frame", "NavList"),
      MobileBottomNav: L("frame", "NavList"),
      BottomSheet: L("part", "MobileBottomMenus"),
      SheetLayer: L("part", "MobileBottomMenus"),
    },
  },
  "components/frame/PageStack.tsx": { group: "frame", items: { PageStack: L("frame"), PageLayer: L("part", "PageStack") } },
  "components/frame/Sidebar.tsx": {
    group: "frame",
    items: { NavLink: D(), NavList: D(), Sidebar: L("frame", "NavList"), SidebarEdge: L("part", "Sidebar") },
  },
  "components/frame/Workbench.tsx": { group: "frame", items: { Workbench: L("frame") } },
  "components/frame/glassBar.tsx": { group: "frame", items: { BarRoom: L("nonvisual") } },
  "components/frame/mobileBar.tsx": { group: "frame", items: { MobileBarSpacer: L("nonvisual"), GlassCapsule: C("TodoJobBar") } },

  "components/motion/AdjustingClock.tsx": { group: "motion", items: { AdjustingClock: D() } },
  "components/motion/BorderBeam.tsx": { group: "motion", items: { BorderBeam: D() } },
  "components/motion/Entrance.tsx": { group: "motion", items: { Entrance: D() } },
  "components/motion/FadeText.tsx": { group: "motion", items: { FadeText: D(), MaskFadeText: C("FadeText"), GlyphFadeText: C("FadeText") } },
  "components/motion/PixelResolve.tsx": { group: "motion", items: { PixelResolve: D() } },
  "components/motion/RunningMark.tsx": { group: "motion", items: { RunningMark: D() } },
  "components/motion/Sag.tsx": { group: "motion", items: { SagRule: D(), BandEdge: D() } },
  "components/motion/ScrollEdges.tsx": { group: "motion", items: { EdgeScroll: D() } },

  "components/shared/ContactAvatar.tsx": { group: "contacts", items: { ContactAvatar: D() } },
  "components/shared/CutoutAvatar.tsx": { group: "contacts", items: { CutoutAvatar: D() } },
  "components/shared/DateField.tsx": { group: "controls", items: { DateField: D() } },
  "components/shared/MarkdownEditor.tsx": {
    group: "rich",
    items: { MarkdownEditor: D(), AppMarkdownEditor: L("live", "MarkdownEditor"), PickerButton: L("part", "AppMarkdownEditor") },
  },
  "components/shared/PickerList.tsx": { group: "overlays", items: { PickerList: D() } },
  "components/shared/PopoverPicker.tsx": { group: "overlays", items: { PopoverPicker: D(), PickerTail: C("PopoverPicker") } },
  "components/shared/RawJsonDialog.tsx": { group: "overlays", items: { RawJsonDialogContent: C("RawJsonDialog"), RawJsonDialog: D() } },
  "components/shared/RollingNumber.tsx": { group: "observe", items: { RollingNumber: D() } },
  "components/shared/WorkspaceDirPickerDialog.tsx": { group: "overlays", items: { WorkspaceDirPickerDialog: L("live") } },

  "components/chat/ArtifactPreviewCard.tsx": { group: "rich", items: { ArtifactPreviewCard: L("live") } },
  "components/chat/AttachSourceSheet.tsx": { group: "composer", items: { AttachSourceSheet: C("WorkspaceSheet") } },
  "components/chat/ChatAgentLinkExchange.tsx": { group: "chat", items: { ChatAgentLinkExchange: D() } },
  "components/chat/ChatComposer.tsx": { group: "composer", items: { ChatComposer: D() } },
  "components/chat/ChatElevationCard.tsx": { group: "chat", items: { ChatElevationCard: D(), Key: C("ChatElevationCard") } },
  "components/chat/ChatHistoryItem.tsx": {
    group: "chat",
    items: { ChatHistoryItem: D(), Bubble: C("ChatHistoryItem"), CopyButton: C("ChatHistoryItem"), EditButton: C("ChatHistoryItem"), WaitingForAnswer: C("ChatHistoryItem") },
  },
  "components/chat/ChatHistoryList.tsx": { group: "chat", items: { ChatHistoryList: D(), OlderBoundary: C("ChatHistoryList"), Skeleton: C("ChatHistoryList") } },
  "components/chat/ChatLoadError.tsx": { group: "chat", items: { ChatLoadError: D() } },
  "components/chat/ChatNoticeLine.tsx": { group: "chat", items: { ChatNoticeLine: D() } },
  "components/chat/ChatQuietRuns.tsx": { group: "chat", items: { ChatQuietRuns: D() } },
  "components/chat/ChatMarkdown.tsx": { group: "rich", items: { ChatMarkdown: D(), CodeBlock: C("ChatMarkdown") } },
  "components/chat/ChatQuestionCard.tsx": { group: "chat", items: { ChatQuestionCard: D(), Key: C("ChatQuestionCard") } },
  "components/chat/ChatRichContent.tsx": { group: "rich", items: { ChatRichContent: D() } },
  "components/chat/ChatSkillInstallPreview.tsx": {
    group: "chat",
    items: {
      ChatSkillInstallPreview: D(),
      Fold: C("ChatSkillInstallPreview"),
      Param: C("ChatSkillInstallPreview"),
      ErrorLine: C("ChatSkillInstallPreview"),
    },
  },
  "components/chat/ChatStatusCard.tsx": {
    group: "chat",
    items: {
      ChatPlanSteps: D(),
      ParamRow: D(),
      ChatActivityEntries: D(),
      ShellResult: D("rich"),
      ActivityCallTree: D(),
      ChatStatusCard: D(),
      Column: C("ChatActivityEntries"),
      ShellStream: C("ShellResult", "rich"),
    },
  },
  "components/chat/ChatStatusMark.tsx": { group: "chat", items: { ChatStatusMark: D() } },
  "components/chat/ChatSystemMessage.tsx": { group: "chat", items: { ChatSystemMessage: D() } },
  "components/chat/ChatTerminal.tsx": { group: "rich", items: { ChatTerminal: D() } },
  "components/chat/TodoJobBar.tsx": { group: "chat", items: { TodoJobBar: D(), TodoJobButton: C("TodoJobBar") } },
  "components/chat/ChatProcessTree.tsx": {
    group: "chat",
    items: { ChatProcessTree: L("live"), ProcessRows: L("part", "ChatProcessTree") },
  },
  "components/chat/TreeBranch.tsx": { group: "chat", items: { TreeBranch: C("ActivityCallTree") } },
  "components/chat/ChatWorkerRoster.tsx": {
    group: "chat",
    items: { WorkerAvatar: D(), ChatWorkerRoster: D(), ChatWorkerOutput: D(), WorkerChip: C("ChatWorkerRoster"), Speaker: C("ChatWorkerOutput") },
  },
  "components/chat/ComposerFieldSlot.tsx": { group: "composer", items: { ComposerFieldSlot: C("ChatComposer") } },
  "components/chat/ComposerMeasure.tsx": { group: "composer", items: { ComposerMeasure: L("nonvisual", "ChatComposer") } },
  "components/chat/MosaicText.tsx": { group: "chat", items: { MosaicText: D() } },
  "components/chat/OverflowLine.tsx": { group: "rich", items: { OverflowLine: D() } },
  "components/chat/PinnedScroll.tsx": { group: "rich", items: { PinnedScroll: D() } },
  "components/chat/ReceivedFile.tsx": { group: "rich", items: { ReceivedFile: D() } },
  "components/chat/TerminalText.tsx": { group: "rich", items: { TerminalText: D(), StatusTag: D(), KindChip: D() } },
  "components/chat/TopicTagsEditor.tsx": { group: "chat", items: { TopicTagsEditor: D() } },
  "components/chat/WorkspacePathLine.tsx": { group: "rich", items: { WorkspacePathLine: D() } },

  "components/knowledge/SkillDocument.tsx": { group: "knowledge", items: { SkillDocument: D() } },
  "components/knowledge/SkillFileTree.tsx": { group: "knowledge", items: { SkillFileTree: L("live") } },
  "components/knowledge/parts.tsx": {
    group: "knowledge",
    items: {
      InlineNotice: D(),
      Note: D(),
      SearchField: D(),
      IndexSearch: D(),
      WorkspaceTitle: D(),
      HeadButton: D(),
      IndexColumn: D(),
      IndexDivider: D(),
      IndexRow: D(),
      RowCount: D(),
      Blocks: D(),
      DetailCard: D(),
      MoreTrigger: D(),
      PropertyList: D(),
      PropertyRow: C("PropertyList"),
      PropertyText: C("PropertyList"),
      LinkText: D(),
      MobileBar: D(),
      SubHeading: D(),
      MonoLabel: D(),
      SwitchOnly: D(),
      TurnCaret: D(),
    },
  },

  "components/observe/CoderQuotaButton.tsx": {
    group: "observe",
    items: { CoderQuotaButton: L("live"), WindowRow: L("part", "CoderQuotaButton"), PendingWindow: L("part", "CoderQuotaButton") },
  },
  "components/observe/DailyUsagePanel.tsx": { group: "observe", items: { DailyUsagePanel: L("live"), ReadoutItem: L("part", "DailyUsagePanel") } },
  "components/observe/ModelLedger.tsx": { group: "observe", items: { ModelLedger: D(), LedgerTable: C("ModelLedger"), HeadCell: C("ModelLedger") } },
  "components/observe/parts.tsx": { group: "observe", items: { Segmented: D(), ObserveSection: D(), AuditBadge: D() } },

  "components/settings-page/PokeDialog.tsx": { group: "forms", items: { PokeDialog: C("DialogShell") } },
  "components/settings-page/SaveBar.tsx": { group: "settings", items: { SettingsSaveBar: D(), SettingsRestartBanner: C("SettingsSaveBar") } },
  "components/settings-page/parts.tsx": {
    group: "settings",
    items: {
      RestartTag: C("SettingsCard"),
      SettingSwitch: C("SettingsCard"),
      SettingField: C("SettingsCard"),
      SettingToggleRow: C("SettingsCard"),
      SettingRow: C("SettingsCard"),
      Fold: C("SettingsCard"),
      BoxFold: C("SettingsCard"),
      DirtyDot: C("SettingsCard"),
      SettingsCard: D(),
      GroupTitle: C("SettingsCard"),
      PlaceholderButton: C("SettingsCard"),
      PaneHead: C("SettingsCard"),
    },
  },
  "components/settings/AuthDialogs.tsx": {
    group: "forms",
    items: { DeviceAuthDialogContent: D(), CodexAuthDialog: C("DialogShell"), XAIAuthDialog: C("DialogShell"), ProAuthDialog: C("DialogShell") },
  },
  "components/settings/AuthProfilesPanel.tsx": { group: "forms", items: { AuthProfilesPanel: D() } },
  "components/settings/ChannelLoginPanels.tsx": {
    group: "forms",
    items: {
      WeChatLoginPanel: L("live"),
      XLoginPanel: L("live"),
      QRCode: L("part", "WeChatLoginPanel"),
      BoundRow: L("part", "WeChatLoginPanel"),
      Messages: L("part", "WeChatLoginPanel"),
    },
  },
  "components/settings/ConfigSettingsPanel.tsx": { group: "forms", items: { ConfigSettingsPanel: D() } },
  "components/settings/ConsoleEndpointsPanel.tsx": { group: "forms", items: { ConsoleEndpointsPanel: L("live") } },
  "components/settings/ConsolePasswordPanel.tsx": { group: "forms", items: { ConsolePasswordPanel: D() } },
  "components/settings/DialogShell.tsx": { group: "overlays", items: { DialogShell: D(), InlineNotice: D("feedback") } },
  "components/settings/EnvManagedField.tsx": { group: "settings", items: { EnvManagedField: D() } },
  "components/settings/ImageUploadField.tsx": {
    group: "settings",
    items: { ImageUploadField: D(), ImageAdjustDialog: L("host", "ImageUploadField"), ImageFace: C("ImageUploadField") },
  },
  "components/settings/InferenceProviderPicker.tsx": { group: "settings", items: { ProviderLogo: D(), InferenceProviderPicker: D() } },
  "components/settings/LLMConfigForm.tsx": { group: "forms", items: { LLMConfigForm: L("live", "SecretInput"), AuthAction: L("part", "LLMConfigForm") } },
  "components/settings/MCPSettingsPanel.tsx": { group: "forms", items: { MCPSettingsPanel: D() } },
  "components/settings/ModelRoutesPanel.tsx": { group: "forms", items: { ModelRoutesPanel: D() } },
  "components/settings/PaneTarget.tsx": { group: "settings", items: { PaneOutlet: C("SettingsPane"), SettingsPane: D() } },
  "components/settings/SecretInput.tsx": {
    group: "settings",
    items: {
      SecretInput: L("live"),
      SecretKeyPicker: L("live"),
      ActionButton: L("part", "SecretInput"),
      KindTag: L("part", "SecretKeyPicker"),
      PasswordAsk: L("part", "SecretKeyPicker"),
    },
  },
  "components/settings/SettingDialog.tsx": { group: "overlays", items: { SettingDialog: C("DialogShell") } },
  "components/settings/SettingJson.tsx": { group: "settings", items: { SettingJson: C("SettingRows") } },
  "components/settings/SettingFields.tsx": {
    group: "settings",
    items: {
      SettingFieldGrid: D(),
      SettingField: C("SettingFieldGrid"),
      SettingMenu: D(),
      SettingSelect: C("SettingFieldGrid"),
      SettingQuantity: C("SettingFieldGrid"),
      SettingDuration: C("SettingFieldGrid"),
      SettingBytes: C("SettingFieldGrid"),
      SettingLimit: C("SettingFieldGrid"),
      SettingPath: C("SettingFieldGrid"),
      SettingPercent: C("SettingFieldGrid"),
      SettingChoices: C("SettingRows"),
      SettingRows: D(),
      Sep: C("SettingRows"),
      MenuCaret: C("SettingFieldGrid"),
      Part: C("SettingFieldGrid"),
    },
  },
  "components/settings/SettingsAppPanel.tsx": { group: "forms", items: { SettingsAppPanel: L("live"), SettingsUpdatePanel: L("live"), ReleaseBox: L("part", "SettingsUpdatePanel") } },
  "components/settings/SettingsCreditsPanel.tsx": { group: "forms", items: { SettingsCreditsPanel: L("live") } },
  "components/settings/SetupConnectionTestDialog.tsx": {
    group: "forms",
    items: { SetupConnectionTestDialogContent: D(), SetupConnectionTestDialog: C("DialogShell") },
  },
  "components/settings/SetupPickerDialog.tsx": {
    group: "forms",
    items: { SetupPickerDialogContent: C("DialogShell"), SetupPickerDialog: C("DialogShell") },
  },
  "components/settings/ShortcutsPanel.tsx": { group: "forms", items: { ShortcutsPanel: L("live"), ShortcutRow: L("part", "ShortcutsPanel") } },
  "components/settings/TopicNotificationSetting.tsx": { group: "forms", items: { TopicNotificationSetting: L("live") } },

  "components/todo/TodoCalendar.tsx": { group: "todo", items: { TodoCalendar: L("frame") } },
  "components/todo/TodoCard.tsx": { group: "todo", items: { TodoCard: D() } },
  "components/todo/TodoDayList.tsx": {
    group: "todo",
    items: { TodoDayList: L("live"), DayMark: L("part", "TodoDayList") },
  },
  "components/todo/TodoFields.tsx": { group: "todo", items: { Prepend: C("TodoInput"), FieldNote: D(), TodoInput: D() } },
  "components/todo/TodoFlow.tsx": {
    group: "todo",
    items: { TodoFlow: D(), FlowJobBox: C("TodoFlow"), FlowLinkLine: C("TodoFlow"), FlowLinkPicker: C("TodoFlow") },
  },
  "components/todo/TodoHeartbeatEditor.tsx": {
    group: "todo",
    items: { TodoHeartbeatEditor: L("live"), WorkflowCard: L("part", "TodoHeartbeatEditor") },
  },
  "components/todo/TodoIndex.tsx": {
    group: "todo",
    items: { RunMarker: D(), TodoIndex: L("live"), IndexItem: L("part", "TodoIndex"), Divider: L("part", "TodoIndex") },
  },
  "components/todo/TodoSelect.tsx": { group: "todo", items: { TodoSelect: C("TodoInput"), ItemMedia: C("TodoInput") } },
  "components/todo/TodoRuns.tsx": { group: "todo", items: { TodoRuns: L("live") } },
  "components/todo/TodoTaskEditor.tsx": {
    group: "todo",
    items: {
      TodoTaskEditor: L("live"),
      SheetBlock: L("part", "TodoTaskEditor"),
      NormalizedField: L("part", "TodoTaskEditor"),
      WeekdayChip: L("part", "TodoTaskEditor"),
      RunAtField: L("part", "TodoTaskEditor"),
      RepeatTimeField: L("part", "TodoTaskEditor"),
      EnabledSwitch: L("part", "TodoTaskEditor"),
    },
  },
  "components/todo/TodoViewToggle.tsx": { group: "todo", items: { TodoViewToggle: D() } },

  "pages/audit/AuditPage.tsx": { group: "pages", items: { AuditPage: L("page") } },
  "pages/chat/ActivityDetailPanel.tsx": { group: "chat", items: { ActivityDetailPanel: D(), CloseButton: C("ActivityDetailPanel") } },
  "pages/chat/ChatPage.tsx": {
    group: "pages",
    items: {
      ChatPage: L("page"),
      Composer: L("part", "ChatPage"),
      WorkspaceToggle: L("part", "ChatPage"),
      DetailPanel: L("part", "ChatPage"),
      History: L("part", "ChatPage"),
      LoadError: L("part", "ChatPage"),
      TodoJobToolbar: L("part", "ChatPage"),
      ChatMain: L("part", "ChatPage"),
    },
  },
  "pages/chat/FilePreviewDialog.tsx": { group: "pages", items: { FilePreviewDialog: L("live") } },
  "pages/chat/TopicRenameDialog.tsx": { group: "chat", items: { TopicRenameDialog: L("live") } },
  "pages/chat/TopicSidebar.tsx": {
    group: "chat",
    items: { ViewToggle: C("WorkspaceSheet"), TopicSidebar: L("live", undefined, "pages"), StatusDot: L("part", "TopicSidebar", "pages") },
  },
  "pages/chat/WorkspacePanel.tsx": {
    group: "chat",
    items: {
      WorkspacePanelTabs: C("WorkspaceSheet"),
      WorkspaceSheet: D(),
      WorkspacePanel: L("live", undefined, "pages"),
      ErrorNote: L("part", "WorkspacePanel", "pages"),
      PropertyRow: L("part", "WorkspacePanel", "pages"),
      Figure: L("part", "WorkspacePanel", "pages"),
      ContextMeter: L("part", "WorkspacePanel", "pages"),
      TopicTab: L("part", "WorkspacePanel", "pages"),
      WorkspaceTab: L("part", "WorkspacePanel", "pages"),
    },
  },
  "pages/contacts/ContactCard.tsx": { group: "contacts", items: { KindAvatar: D(), ChannelMark: D(), ContactCard: D() } },
  "pages/contacts/ContactKindTabs.tsx": { group: "contacts", items: { ContactKindTabs: D() } },
  "pages/contacts/ContactsPage.tsx": {
    group: "pages",
    items: {
      ContactsPage: L("page"),
      SectionHead: L("part", "ContactsPage"),
      CopyButton: L("part", "ContactsPage"),
      ActivityItem: L("part", "ContactsPage"),
      Rise: L("part", "ContactsPage"),
    },
  },
  "pages/context/ContextPage.tsx": {
    group: "pages",
    items: { ContextPage: L("page"), Swatch: L("part", "ContextPage"), CacheBadge: L("part", "ContextPage"), Ring: L("part", "ContextPage") },
  },
  "pages/login/LoginPage.tsx": { group: "pages", items: { LoginPage: L("page") } },
  "pages/login/QrScanner.tsx": { group: "pages", items: { QrScanner: L("live") } },
  "pages/login/ServerDialog.tsx": { group: "pages", items: { ServerDialog: L("live") } },
  "pages/logs/LogsPage.tsx": { group: "pages", items: { LogsPage: L("page") } },
  "pages/memories/MemoriesPage.tsx": {
    group: "pages",
    items: {
      MemoriesPage: L("page"),
      SectionCard: L("part", "MemoriesPage"),
      Banner: L("part", "MemoriesPage"),
      VisibilityMark: L("part", "MemoriesPage"),
      MemoryRow: L("part", "MemoriesPage"),
      SinceField: L("part", "MemoriesPage"),
      JournalAudience: L("part", "MemoriesPage"),
      EditField: L("part", "MemoriesPage"),
    },
  },
  "pages/overview/OverviewPage.tsx": { group: "pages", items: { OverviewPage: L("page") } },
  "pages/repair/RawTextEditorDialog.tsx": { group: "overlays", items: { RawTextEditorDialog: C("DialogShell") } },
  "pages/repair/RepairPage.tsx": { group: "pages", items: { RepairPage: L("page") } },
  "pages/routes.tsx": { group: "pages", items: { PageView: L("frame"), NotFound: L("part", "PageView") } },
  "pages/settings/RuntimePanel.tsx": {
    group: "settings",
    items: {
      RuntimeFold: C("SettingsCard"),
      RuntimePanel: L("live", undefined, "pages"),
      StatusLabel: L("part", "RuntimePanel", "pages"),
      Ledger: L("part", "RuntimePanel", "pages"),
      RuntimeEntry: L("part", "RuntimePanel", "pages"),
    },
  },
  "pages/settings/SettingsDialogs.tsx": {
    group: "pages",
    items: { SettingsDialogs: L("live"), AdvancedSettingsBody: L("part", "SettingsDialogs") },
  },
  "pages/settings/SettingsPage.tsx": { group: "pages", items: { SettingsPage: L("page"), SectionItem: L("part", "SettingsPage") } },
  "pages/settings/sections/AgentSection.tsx": {
    group: "pages",
    items: { AgentSection: L("live"), ProfilePane: L("live"), SubHeading: L("part", "AgentSection"), ProfileRow: L("part", "AgentSection") },
  },
  "pages/settings/sections/AutomationSection.tsx": { group: "pages", items: { AutomationSection: L("live") } },
  "pages/settings/sections/ChannelsSection.tsx": {
    group: "pages",
    items: {
      ChannelsSection: L("live"),
      ChannelPane: L("live"),
      ChannelTile: L("part", "ChannelsSection"),
      ChannelField: L("part", "ChannelsSection"),
      ChannelPaneBody: L("part", "ChannelPane"),
      ChannelPaneHeader: L("part", "ChannelPane"),
    },
  },
  "pages/settings/sections/ConsoleSection.tsx": { group: "pages", items: { ConsoleSection: L("live") } },
  "pages/settings/sections/GeneralSection.tsx": { group: "pages", items: { GeneralSection: L("live") } },
  "pages/settings/sections/McpSection.tsx": { group: "pages", items: { McpSection: L("live"), LoadSkillsSetting: L("part", "McpSection") } },
  "pages/settings/sections/PersonaSection.tsx": { group: "pages", items: { PersonaSection: L("live") } },
  "pages/settings/sections/SecuritySection.tsx": { group: "pages", items: { SecuritySection: L("live") } },
  "pages/settings/sections/SystemSection.tsx": { group: "pages", items: { SystemSection: L("live") } },
  "pages/settings/sections/ToolsSection.tsx": {
    group: "pages",
    items: {
      ToolsSection: L("live"),
      ChannelHeading: L("part", "ToolsSection"),
      MatrixFrame: L("part", "ToolsSection"),
      AgentNameSetSetting: L("part", "ToolsSection"),
    },
  },
  "pages/settings/sections/UnsupportedSection.tsx": { group: "pages", items: { UnsupportedSection: L("live") } },
  "pages/setup/InlineNotice.tsx": { group: "feedback", items: { InlineNotice: D() } },
  "pages/setup/SetupPage.tsx": {
    group: "pages",
    items: {
      SetupPage: L("page"),
      FieldLabel: L("part", "SetupPage"),
      Field: L("part", "SetupPage"),
      FieldPair: L("part", "SetupPage"),
      FieldControl: L("part", "SetupPage"),
      AuthActionButton: L("part", "SetupPage"),
      LLMStage: L("part", "SetupPage"),
      StageError: L("part", "SetupPage"),
      SubmitButton: L("part", "SetupPage"),
      PreviousButton: L("part", "SetupPage"),
      PersonaStage: L("part", "SetupPage"),
      SoulSprite: L("part", "SetupPage"),
      SoulStage: L("part", "SetupPage"),
      DoneStage: L("part", "SetupPage"),
    },
  },
  "pages/skills/SkillStorePage.tsx": { group: "pages", items: { SkillStorePage: L("page"), TagChip: L("part", "SkillStorePage"), SkillStoreSheet: L("part", "SkillStorePage") } },
  "pages/skills/SkillsPage.tsx": { group: "pages", items: { SkillsPage: L("page") } },
  "pages/skills/StoreSkillDetail.tsx": { group: "knowledge", items: { StoreSkillDetail: D() } },
  "pages/stats/StatsPage.tsx": {
    group: "pages",
    items: {
      StatsPage: L("page"),
      EmptyUsage: L("part", "StatsPage"),
      BandHead: L("part", "StatsPage"),
      SummaryGroup: L("part", "StatsPage"),
      MetricBand: L("part", "StatsPage"),
      HostBlock: L("part", "StatsPage"),
    },
  },
  "pages/todo/TodoPage.tsx": {
    group: "pages",
    items: {
      TodoPage: L("page"),
      CalendarDayDetail: L("part", "TodoPage"),
      Placeholder: L("part", "TodoPage"),
      EditorPane: L("part", "TodoPage"),
      Calendar: L("part", "TodoPage"),
    },
  },
  "pages/ui-components/UiComponentsPage.tsx": {
    group: "pages",
    items: { UiComponentsPage: L("page"), Chip: L("part", "UiComponentsPage"), SectionRow: L("part", "UiComponentsPage"), DemoCard: L("part", "UiComponentsPage"), NoteRow: L("part", "UiComponentsPage") },
  },
};

/** @returns {GalleryEntry[]} */
function build() {
  /** @type {Record<string, number>} */
  const seen = {};
  for (const file of Object.values(FILES)) for (const name of Object.keys(file.items)) seen[name] = (seen[name] || 0) + 1;
  /** @type {GalleryEntry[]} */
  const entries = [];
  for (const [path, file] of Object.entries(FILES)) {
    const stem = path.split("/").slice(-2).join("/").replace(/\.tsx$/, "");
    for (const [name, spec] of Object.entries(file.items)) {
      entries.push({
        // A name two files use is told apart by its file: `InlineNotice-knowledge-parts`.
        id: seen[name] > 1 ? `${name}-${stem.replace("/", "-")}` : name,
        name,
        file: path,
        group: spec.group || file.group,
        mode: spec.mode,
        via: spec.via,
        reason: spec.reason,
      });
    }
  }
  return entries;
}

/** Every component, in the order of the files above. */
export const GALLERY_ENTRIES = build();
