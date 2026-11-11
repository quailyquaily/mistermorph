// The chat page's state and behaviour: the port of web/console/src/views/ChatView.js's setup().
// Topics (the list, its views and groups, tags, pins, activity marks), the open topic's history
// (loading, refresh, older pages, streaming replies over the task WebSocket with polling as the
// fallback), the composer (drafts per topic, files, suggestions, models, voice), approvals,
// questions and password requests, the topic and workspace panel, and the mobile split.
//
// It runs in the ChatPage component's body: its effects, timers and sockets go with the page.
import { batch, cleanup, computed, effect, LayoutAnimation, signal, untracked } from "nsh";
import { MOTION_SLOW, motionMs } from "../../components/motion/tokens";
import type { ListRef } from "nsh";
import { approvalDetailsByID, taskApprovalState } from "../../lib/core/chat-approvals.js";
import { formatDate, formatNumber } from "../../lib/core/intl-format.js";
import { buildComposerSubmission, composerFileDraftKey, composerFileExtension } from "../../lib/core/chat-composer-files.js";
import { chatDraft, clearChatDraft, rememberChatDraft } from "../../lib/core/chat-draft-memory.js";
import { normalizeComposerCommandItems, normalizeComposerSkillItems } from "../../lib/core/chat-composer-suggestions.js";
import {
  lastUsedChatLLMProfile,
  normalizeChatLLMProfileMetadata,
  normalizeChatLLMProfiles,
  resolveAvailableChatLLMProfile,
} from "../../lib/core/chat-llm-profiles.js";
import { placeSteeredAgentsAfterUsers } from "../../lib/core/chat-history-steering.js";
import { rememberLastTopicID } from "../../lib/core/chat-topic-memory.js";
import {
  agentDisplayName,
  applyUserReaction,
  buildPollingHint,
  chatApprovalReasonText,
  historyPendingSeed,
  historyTimeLabel as formatChatHistoryTime,
  isContextCompactCommand,
  isTerminalStatus,
  keepHistoryItemIDs,
  keepLiveTaskState,
  mergeRefreshedHistoryItems,
  normalizeActivity,
  normalizeElevations,
  normalizeHistoryFileReferences,
  normalizeInsights,
  normalizePlan,
  normalizeQuestions,
  normalizeReasoning,
  normalizeTaskStatus,
  normalizeTopicID,
  taskActivity,
  taskAgentText,
  taskAwaitingReply,
  taskWaitingForAnswer,
  taskDurationLabel,
  taskElevations,
  taskInsights,
  taskListHistoryItems,
  taskPlan,
  taskQuestions,
  taskRawJSON,
  taskReasoning,
} from "../../lib/core/chat-task-history.js";
import { isDesktopRuntime } from "../../lib/core/desktop-runtime.js";
import { endpointChannelLabel } from "../../lib/core/endpoints.js";
import { endpointRoutePath } from "../../lib/core/endpoint-routes.js";
import { modelVendorMeta } from "../../lib/core/model-vendor.js";
import { SETUP_PROVIDER_OPTIONS } from "../../lib/core/setup-contract.js";
import { loadResource, resourceKey } from "../../lib/core/resources.js";
import { rememberRecentWorkspaceDir } from "../../lib/core/recent-workspace-dirs.js";
import { buildTreeRows, hasOwnTreePath, setTreeExpanded, setTreeItems } from "../../lib/core/workspace-tree.js";
import { topicIcon, useTopicMetadata } from "../../lib/core/topic-metadata.js";
import { cronSidebarGroups, cronTopicModels, cronTopicModelText, cronTopicsOf, isCronTopicID, topicSidebarViewFor } from "../../lib/core/chat-cron-topics.js";
import {
  activelyViewedTopic,
  createTopicActivityTracker,
  cronRunningCount,
  topicActivitySignature,
  TOPIC_ACTIVITY_DONE,
  TOPIC_ACTIVITY_PENDING,
  TOPIC_ACTIVITY_WAITING,
} from "../../lib/core/topic-activity.js";
import { contextMeter } from "../../lib/core/context-meter.js";
import {
  groupTopicsByTag,
  knownTopicTags,
  ordinaryTopicTags,
  sameTopicTags,
  splitPinnedTopics,
  tagsAfterDrop,
  topicPinned,
  topicTags,
  withPinned,
} from "../../lib/core/topic-tags.js";
import { arrangeTopicGroups, normalizeTopicLayout, orderGroupTopics } from "../../lib/core/topic-layout.js";
import {
  apiFetch,
  buildConsoleStreamURL,
  createConsoleStreamTicket,
  currentLocale,
  endpointState,
  formatShortTime,
  formatTime,
  runtimeApiFetchForEndpoint,
  runtimeEndpointByRef,
  safeJSON,
  supportsConsoleTaskStream,
} from "../../lib/core/context.js";
import { agentLinkAvatarURL, agentLinkInstanceID } from "../../lib/core/agent-link-avatar.js";
import { pushNotice } from "../../lib/core/notices.js";
import { createTopicRename, type TopicRenameSession } from "./topicRename";
import { copyText, hasFocus, isVisible, localStore, onVisibilityChange, pickFiles, releaseFile, type PickedFile } from "../../lib/platform";
import { currentRoute, router } from "../../lib/router";
import { isMobile } from "../../lib/shell";
import { dismissSoftKeyboard } from "../../lib/softKeyboard";
import { createArtifactPreviews } from "../../components/chat/ArtifactPreviewCard";
import type { ComposerFileItem, ComposerHandle, ComposerProfileItem } from "../../components/chat/ChatComposer";
import type { ChatRowContext, HistoryItem } from "../../components/chat/ChatHistoryItem";
import type { ElevationAnswer, ElevationState } from "../../components/chat/ChatElevationCard";
import type { QuestionAnswer, QuestionState } from "../../components/chat/ChatQuestionCard";
import { hasArtifactBlock } from "../../components/chat/ChatRichContent";
import { createReceivedFiles } from "../../components/chat/ReceivedFile";
import { keyedState } from "../../components/chat/rowState";
import { workspacePathDisplay } from "../../components/chat/workspacePath";
import {
  activityDetailKey,
  createFocusReturn,
  findActivityDetailItem,
  normalizeActivityDetail,
  type ActivityDetailRef,
} from "../../components/chat/activityDetail";
import { fetchEndpointBlob, saveEndpointFile, transcribeRecording, uploadPickedFile } from "../../components/chat/files";
import { t } from "../../components/chat/i18n";
import { createVoiceInput, voiceErrorKey } from "../../components/chat/voice";

const POLL_INTERVAL_MS = 1200;
const POLL_RETRY_MAX_MS = 15000;
const CHAT_HISTORY_LIMIT = 100;
const TOPIC_PAGE_LIMIT = 100;
export const DEFAULT_TOPIC_ID = "default";
export const AWARENESS_TOPIC_ID = "_awareness";
const AWARENESS_REFRESH_INTERVAL_MS = 5000;
const TOPIC_ACTIVITY_REFRESH_INTERVAL_MS = 5000;
// What another agent sends this one over Agent Link is kept in a topic per agent,
// "_agentlink_<instance_id>", listed apart from the person's own topics.
const AGENT_LINK_TOPIC_PREFIX = "_agentlink_";
const LOCAL_CONSOLE_ENDPOINT_REF = "ep_console_local";
// The trigger of a task sent from this chat. The runtime lets only such tasks ask questions.
const CONSOLE_CHAT_TRIGGER = Object.freeze({ source: "ui", event: "chat_submit", ref: "web/console/chat" });
const WORKSPACE_SIDEBAR_OPEN_STORAGE_KEY = "mistermorph_console_workspace_sidebar_open_v1";
const TOPIC_SIDEBAR_VIEW_STORAGE_KEY = "mistermorph.chat.topicSidebarView";
const TOPIC_GROUPS_COLLAPSED_STORAGE_KEY = "mistermorph.chat.topicGroupsCollapsed";
export const WORKSPACE_TAB_ID = "workspace";

/**
 * The one panel at the right of the conversation: none, the topic and workspace panel, or the
 * temporary detail panel with what it shows. One value, so the two can never show together:
 * opening either replaces the other.
 */
export type RightPanel = { kind: "none" } | { kind: "workspace" } | { kind: "detail"; detail: ActivityDetailRef };
const RIGHT_PANEL_NONE: RightPanel = { kind: "none" };
const RIGHT_PANEL_WORKSPACE: RightPanel = { kind: "workspace" };
export const TOPIC_TAB_ID = "topic";
const COMPOSER_FILE_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp", ".ico"]);

export type SidebarView = "date" | "tags" | "agents" | "cron";

export function agentLinkTopicContactID(topicID: unknown) {
  const id = String(topicID || "").trim();
  return id.startsWith(AGENT_LINK_TOPIC_PREFIX) ? `mm:${id.slice(AGENT_LINK_TOPIC_PREFIX.length)}` : "";
}

export function isAgentLinkTopicID(topicID: unknown) {
  return agentLinkTopicContactID(topicID) !== "";
}

function normalizeEndpointMode(raw: unknown) {
  return String(raw || "").trim().toLowerCase();
}

function rememberTopicSelection(endpointRef: string, topicID: string) {
  const id = normalizeTopicID(topicID);
  if (!id || id === AWARENESS_TOPIC_ID || isAgentLinkTopicID(id) || isCronTopicID(id)) return;
  rememberLastTopicID(endpointRef, id);
}

function composerDraftTopicID(enabled: boolean, creating: boolean, selected: string, routeTopic: string) {
  if (!enabled || creating) return "";
  return normalizeTopicID(selected) || normalizeTopicID(routeTopic);
}

function loadTopicSidebarView(): SidebarView {
  return localStore.getItem(TOPIC_SIDEBAR_VIEW_STORAGE_KEY) === "tags" ? "tags" : "date";
}

function loadCollapsedTopicGroups() {
  try {
    const raw = JSON.parse(localStore.getItem(TOPIC_GROUPS_COLLAPSED_STORAGE_KEY) || "[]");
    return new Set<string>(Array.isArray(raw) ? raw.map(String) : []);
  } catch {
    return new Set<string>();
  }
}

function workspaceDownloadFilename(entry: any) {
  return String(entry?.name || "").trim().replace(/[\\/]+/gu, "_") || "download";
}

function topicUpdatedAt(topic: any) {
  const value = Date.parse(String(topic?.updated_at || topic?.created_at || "").trim());
  return Number.isFinite(value) ? value : 0;
}

function compareTopicsNewestFirst(left: any, right: any) {
  const delta = topicUpdatedAt(right) - topicUpdatedAt(left);
  if (delta !== 0) return delta;
  const l = normalizeTopicID(left?.id);
  const r = normalizeTopicID(right?.id);
  if (l === r) return 0;
  return l < r ? 1 : -1;
}

function topicDate(topic: any) {
  const date = new Date(String(topic?.updated_at || topic?.created_at || "").trim());
  return Number.isNaN(date.getTime()) ? null : date;
}

function topicDayKey(topic: any) {
  const date = topicDate(topic);
  return date ? `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}` : "";
}

function topicDayLabel(topic: any) {
  const date = topicDate(topic);
  if (!date) return "";
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(date, today)) return t("chat_topics_today");
  if (sameDay(date, yesterday)) return t("chat_topics_yesterday");
  return formatDate(
    date,
    currentLocale(),
    date.getFullYear() === today.getFullYear() ? { month: "short", day: "numeric" } : { year: "numeric", month: "short", day: "numeric" },
  );
}

export function topicTimeLabel(topic: any) {
  const raw = String(topic?.updated_at || topic?.created_at || "").trim();
  if (!raw) return "";
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;
  const now = new Date();
  const sameDay = now.getFullYear() === date.getFullYear() && now.getMonth() === date.getMonth() && now.getDate() === date.getDate();
  return sameDay
    ? formatDate(date, currentLocale(), { hour: "2-digit", minute: "2-digit" })
    : formatDate(date, currentLocale(), { month: "short", day: "numeric" });
}

function formatTokenCount(value: unknown) {
  const n = Number(value);
  return !Number.isFinite(n) || n <= 0 ? "-" : formatNumber(Math.round(n), currentLocale());
}

function formatUsageRatio(value: unknown) {
  const n = Number(value);
  return !Number.isFinite(n) || n < 0 ? "-" : `${(n * 100).toFixed(1)}%`;
}

function topicContextUsageRatio(context: any) {
  const used = Number(context?.used_input_tokens);
  const window = Number(context?.context_window_tokens);
  if (Number.isFinite(used) && used >= 0 && Number.isFinite(window) && window > 0) return used / window;
  const ratio = Number(context?.usage_ratio);
  return Number.isFinite(ratio) && ratio >= 0 ? ratio : null;
}

function applyDefaultHistoryDurationVisibility(items: HistoryItem[]) {
  let lastAgentIndex = -1;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (String(items[i]?.role || "") === "agent" && String(items[i]?.durationText || "").trim()) {
      lastAgentIndex = i;
      break;
    }
  }
  return items.map((item, index) => {
    if (item?.durationVisibleManual === true) {
      if (item.durationVisible === (item?.durationVisible === true)) return item;
      return { ...item, durationVisibleManual: true, durationVisible: item?.durationVisible === true };
    }
    const visible = index === lastAgentIndex;
    if (item.durationVisibleManual === false && item.durationVisible === visible) return item;
    return { ...item, durationVisibleManual: false, durationVisible: visible };
  });
}

// Keeps acknowledgements while away from the chat, within this session.
const topicActivityTracker = createTopicActivityTracker();

function newHistoryID() {
  return `${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
}

export function kickerChannelLabel(mode: unknown) {
  switch (normalizeEndpointMode(mode)) {
    case "console":
      return "Console";
    case "serve":
      return "Serve";
    case "telegram":
      return "Telegram";
    case "slack":
      return "Slack";
    case "line":
      return "LINE";
    case "lark":
      return "Lark";
    case "mixin":
      return "Mixin";
    case "discord":
      return "Discord";
    case "wechat":
      return "WeChat";
    case "whatsapp":
      return "WhatsApp";
    case "bluesky":
      return "Bluesky";
    case "x":
      return "X";
    default:
      return "Endpoint";
  }
}

/** A `{ value }` view of a signal, for the tree helpers written for Vue refs. */
function refOf<T>(get: () => T, set: (value: T) => void) {
  return {
    get value() {
      return untracked(get);
    },
    set value(next: T) {
      set(next);
    },
  };
}

function errorMessage(error: unknown, fallback: string) {
  return (error as Error)?.message || fallback;
}

/** A row of the topic list: a group's heading, a topic, or a note. */
export type TopicRow =
  | { kind: "note"; key: string; text: string }
  | { kind: "group"; key: string; group: any; collapsible: boolean; collapsed: boolean }
  | { kind: "topic"; key: string; topic: any; group: any };

export interface FilePreviewState {
  open: boolean;
  loading: boolean;
  name: string;
  kind: "" | "image" | "pdf" | "text";
  url: string;
  text: string;
  error: string;
  items: any[];
  index: number;
}

const CLOSED_PREVIEW: FilePreviewState = { open: false, loading: false, name: "", kind: "", url: "", text: "", error: "", items: [], index: -1 };

export function createChatController() {
  let viewActive = true;

  /* ---------- the route, the endpoint ---------- */

  const mobileMode = () => isMobile();
  const routeTopicID = () => normalizeTopicID(currentRoute().params.topic_id);
  const selectedEndpoint = () => runtimeEndpointByRef(endpointState.selectedRef);
  const submitEndpointRef = computed(() => {
    const selected = selectedEndpoint();
    if (!selected) return "";
    const mapped = String(selected.submit_endpoint_ref || "").trim();
    if (mapped) return mapped;
    return selected.can_submit ? String(selected.endpoint_ref || "").trim() : "";
  });
  const submitEndpoint = () => runtimeEndpointByRef(submitEndpointRef());
  const consoleTopicsEnabled = computed(() => {
    if (!submitEndpointRef()) return false;
    const mode = submitEndpoint()?.mode || selectedEndpoint()?.mode;
    return normalizeEndpointMode(mode) === "console";
  });
  const activeAgentName = () => String(submitEndpoint()?.agent_name || "").trim() || String(selectedEndpoint()?.agent_name || "").trim();
  const displayAgentName = () => agentDisplayName(activeAgentName(), t);
  const submitBlockedMessage = () => {
    const selected = selectedEndpoint();
    if (!selected || !selected.connected || submitEndpointRef()) return "";
    return t("chat_submit_unsupported", { name: selected.name || selected.endpoint_ref || "-" });
  };
  const chatReadonly = () => Boolean(submitBlockedMessage());
  const readonlyKickerLeft = () => kickerChannelLabel(selectedEndpoint()?.mode);
  const readonlyReason = () => {
    const selected = selectedEndpoint();
    if (!selected) return "";
    return t("chat_readonly_reason", { name: selected.name || selected.endpoint_ref || "-", channel: endpointChannelLabel(selected.mode, t) });
  };

  /* ---------- state ---------- */

  const mobileTopicView = signal<"topics" | "chat">(untracked(mobileMode) && !untracked(routeTopicID) ? "topics" : "chat");
  const chatHistoryItems = signal<HistoryItem[]>([]);
  const copiedHistoryItemID = signal("");
  const copySeq = signal(0);
  const historyLoading = signal(false);
  const historyLoadingOlder = signal(false);
  const historyItemsScope = signal("");
  const historyNextCursor = signal("");
  const topics = signal<any[]>([]);
  const topicsLoading = signal(false);
  const topicsLoadingOlder = signal(false);
  const topicsNextCursor = signal("");
  // Why the conversation or the topic list could not be loaded, shown in the chat view with a
  // Refresh (ChatLoadError) rather than in the notice stack. A history failure belongs to the
  // conversation it was for (its history scope); a topic list failure to the agent.
  const historyLoadError = signal<{ scope: string; message: string } | null>(null);
  const topicsLoadError = signal("");
  // The conversation a Refresh is reloading (its history scope), while it does.
  const chatLoadRetryScope = signal<string | null>(null);
  let chatLoadRetrySeq = 0;
  // The topic the address names is selected at once, so returning to Chat shows it straight away;
  // loadTopics drops it if the agent has no such topic.
  const selectedTopicID = signal(untracked(routeTopicID));
  const creatingTopic = signal(false);
  const showSystemTopics = signal(false);
  const topicDeleteDialogOpen = signal(false);
  const topicDeleteTarget = signal<any>(null);
  const topicDeleting = signal(false);
  const topicDeleteError = signal("");
  const topicSidebarView = signal<SidebarView>(topicSidebarViewFor(untracked(() => currentRoute().params.topic_id), loadTopicSidebarView()));
  const topicActivity = signal<Map<string, any>>(new Map());
  let topicActivityKey = "";
  const topicTagSaves = signal<Set<string>>(new Set());
  const topicTagsError = signal("");
  const topicNameRequests = signal<Set<string>>(new Set());
  const topicNameFailure = signal<{ key: string; message: string } | null>(null);
  const taskInput = signal("");
  const sending = signal(false);
  const err = signal("");
  const workspaceDir = signal("");
  // The home directory of the host the workspaces are on (`home_dir`, from that runtime), and the
  // endpoint that reported it: a path shows `~` for it on that endpoint only.
  const workspaceHome = signal<{ endpointRef: string; dir: string } | null>(null);
  const workspaceSource = signal("none");
  const workspaceLoading = signal(false);
  const workspaceSaving = signal(false);
  const workspaceOpening = signal(false);
  const workspaceDownloading = signal(false);
  const workspaceError = signal("");
  const composerFiles = signal<ComposerFileItem[]>([]);
  const composerUploading = () => composerFiles().some((item) => item.status === "uploading");
  const composerFilesPending = () => composerFiles().some((item) => item.status !== "ready");
  const filePreview = signal<FilePreviewState>(CLOSED_PREVIEW);
  const topicContext = signal<any>(null);
  // The workspace panel's open state is remembered across visits (only the toggle changes what is
  // remembered); the detail panel is never restored.
  const rightPanel = signal<RightPanel>(localStore.getItem(WORKSPACE_SIDEBAR_OPEN_STORAGE_KEY) === "true" ? RIGHT_PANEL_WORKSPACE : RIGHT_PANEL_NONE);
  const workspaceSidebarOpen = () => rightPanel().kind === "workspace";
  const activityDetail = computed<ActivityDetailRef | null>(
    () => {
      const panel = rightPanel();
      return panel.kind === "detail" ? panel.detail : null;
    },
    { equals: (a, b) => activityDetailKey(a) === activityDetailKey(b) && a?.taskID === b?.taskID },
  );
  // The entry point that takes the keyboard focus back as the detail panel closes (activityDetail.ts).
  const detailFocusReturn = createFocusReturn();
  const workspaceSidebarTabID = signal(TOPIC_TAB_ID);
  const workspaceTreeItems = signal<Record<string, any[]>>({});
  const workspaceTreeExpanded = signal<Record<string, boolean>>({ "": true });
  const workspaceTreeLoading = signal(false);
  const workspaceTreeLoadingPath = signal("");
  const workspaceTreeError = signal("");
  const workspaceTreeSelectionPath = signal("");
  const workspaceBrowserOpen = signal(false);
  const workspaceBrowserPendingMode = signal(false);
  const pendingWorkspaceDir = signal("");
  const composerFileDrafts = new Map<string, ComposerFileItem[]>();
  // Running tasks being followed: taskID -> { historyID, endpointRef, timer, failures }.
  const trackedTasks = new Map<string, { historyID: string; endpointRef: string; timer?: ReturnType<typeof setTimeout>; failures: number }>();
  let pollGeneration = 0;
  const streamSockets = new Map<string, { socket: WebSocket; historyID: string; endpointRef: string; closing: boolean }>();
  const approvalDetailAttempts = new Set<string>();
  let composer: ComposerHandle | null = null;
  let historyList: ListRef | null = null;
  const composerCommands = signal<any[]>([]);
  const composerCommandsLoading = signal(false);
  const composerDefaultLLMProfile = signal<any>(null);
  const composerLLMProfiles = signal<any[]>([]);
  const composerTopicLLMProfile = signal("");
  const composerLLMProfile = signal("");
  const composerSkills = signal<any[]>([]);
  const composerSkillsLoading = signal(false);
  const composerSkillsError = signal("");
  let suppressDraftPersistence = false;
  const rawDialogOpen = signal(false);
  const rawDialogJSON = signal("");
  let rawRevealItemID = "";
  let rawRevealCount = 0;
  let heartbeatRevealCount = 0;
  let rawRevealTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeatRevealTimer: ReturnType<typeof setTimeout> | undefined;
  let copiedHistoryTimer: ReturnType<typeof setTimeout> | undefined;
  let historyLoadVersion = 0;
  let composerCommandsLoadSeq = 0;
  let composerLLMProfilesLoadSeq = 0;
  let composerSkillsLoadSeq = 0;
  let composerFileSequence = 0;
  let filePreviewSequence = 0;
  let filePreviewObjectURL = "";
  let workspaceRequestSeq = 0;

  /* ---------- derived ---------- */

  const composerDraftScope = computed(
    () => ({
      endpointRef: String(submitEndpointRef() || "").trim(),
      topicID: composerDraftTopicID(consoleTopicsEnabled(), creatingTopic(), selectedTopicID(), routeTopicID()),
    }),
    { equals: (a, b) => a?.endpointRef === b?.endpointRef && a?.topicID === b?.topicID },
  );

  const activeTaskItem = () => {
    const items = chatHistoryItems();
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index];
      if (
        String(item?.role || "").trim().toLowerCase() === "agent" &&
        String(item?.taskId || "").trim() !== "" &&
        !isTerminalStatus(normalizeTaskStatus(item?.status))
      ) {
        return item;
      }
    }
    return null;
  };
  const composerHasInput = () => String(taskInput() || "").trim() !== "";
  const composerStopMode = () => Boolean(activeTaskItem()) && !composerHasInput();
  const composerDisabled = () => Boolean(submitBlockedMessage()) || sending();
  const sendDisabled = () => composerDisabled() || (!composerStopMode() && (composerFilesPending() || !composerHasInput()));
  const composerActionLabel = () => {
    if (composerStopMode()) return t("chat_action_stop");
    return mobileMode() ? t("chat_action_send") : `${t("chat_action_send")} (Enter)`;
  };
  const composerPlaceholder = () => t("chat_input_placeholder", { name: displayAgentName() });
  const composerAttachActive = () => Boolean(pendingWorkspaceDir());
  const chatDisclaimer = () => `${displayAgentName()} can make mistakes. Check important info.`;
  const composerLLMProfileItems = (): ComposerProfileItem[] => {
    const defaults = composerDefaultLLMProfile() || {};
    const vendor = modelVendorMeta(defaults.modelName);
    return [
      {
        id: "chat-llm-profile-default-route",
        title: t("chat_llm_profile_default"),
        subtitle: defaults.modelName,
        value: "",
        image: vendor.icon || undefined,
        icon: vendor.icon ? undefined : "PhCpu",
      },
      ...composerLLMProfiles().map((profile: any) => {
        const meta = modelVendorMeta(profile.modelName);
        return {
          id: `chat-llm-profile-${profile.name}`,
          title: profile.name,
          subtitle: profile.modelName,
          value: profile.name,
          image: meta.icon || undefined,
          icon: meta.icon ? undefined : "PhCpu",
        };
      }),
    ];
  };
  const composerInputHistory = () => {
    const items = chatHistoryItems();
    const out: string[] = [];
    for (let i = items.length - 1; i >= 0; i -= 1) {
      if (String(items[i]?.role || "").trim().toLowerCase() !== "user") continue;
      const text = String(items[i]?.text || "").trim();
      if (text) out.push(text);
    }
    return out;
  };
  const mobileTopicSplitEnabled = () => consoleTopicsEnabled() && mobileMode();

  const visibleTopics = computed(() => {
    const selected = normalizeTopicID(selectedTopicID());
    const items: any[] = [];
    let awarenessTopic: any = null;
    const awarenessVisible = showSystemTopics() || selected === AWARENESS_TOPIC_ID;
    for (const topic of topics()) {
      const id = normalizeTopicID(topic?.id);
      if (!id) continue;
      if (id === AWARENESS_TOPIC_ID) {
        if (awarenessVisible) awarenessTopic = topic;
        continue;
      }
      if (isAgentLinkTopicID(id) || isCronTopicID(id)) continue;
      items.push(topic);
    }
    if (!awarenessTopic && awarenessVisible) {
      awarenessTopic = { id: AWARENESS_TOPIC_ID, title: t("chat_topic_awareness"), created_at: "", updated_at: "" };
    }
    return awarenessTopic ? [awarenessTopic, ...items] : items;
  });
  const hasVisibleTopics = () => visibleTopics().length > 0;
  const cronTopics = computed(() => cronTopicsOf(topics()));
  const cronModels = signal<any>(null);
  let cronModelsLoadSeq = 0;

  async function loadCronTopicModels() {
    const seq = ++cronModelsLoadSeq;
    const endpointRef = String(untracked(submitEndpointRef) || "").trim();
    if (!endpointRef) {
      cronModels.set(null);
      return;
    }
    try {
      const data = await runtimeApiFetchForEndpoint(endpointRef, "/todo/tasks");
      if (seq === cronModelsLoadSeq) cronModels.set(cronTopicModels(data));
    } catch (error) {
      // The rows keep what they showed; a blank second row is better than a wrong one.
      console.warn("chat: TODO models", errorMessage(error, ""));
    }
  }

  // Loaded while the TODO list is shown: on opening it, for another agent, and when an item's topic
  // appears (a first run) or goes.
  let cronModelsEndpoint: string | undefined;
  effect(() => {
    const shown = topicSidebarView() === "cron";
    const endpointRef = String(submitEndpointRef() || "").trim();
    void cronTopics()
      .map((topic: any) => normalizeTopicID(topic?.id))
      .join("|");
    untracked(() => {
      if (endpointRef !== cronModelsEndpoint) cronModels.set(null);
      cronModelsEndpoint = endpointRef;
      if (shown) void loadCronTopicModels();
    });
  });

  function cronTopicModel(topic: any) {
    return cronTopicModelText(cronModels(), topic, {
      providerTitle: (id: string) => SETUP_PROVIDER_OPTIONS.find((item: any) => item.value === id)?.title || id,
      unscheduled: t("chat_topics_cron_item_unscheduled"),
    });
  }

  const hasSidebarTopics = () => hasVisibleTopics() || cronTopics().length > 0;
  const cronRunning = () => cronRunningCount(topicActivity());
  const cronToggleLabel = () =>
    cronRunning() > 0 ? t("chat_topics_view_cron_running", { count: cronRunning() }) : t("chat_topics_view_cron");
  const cronToggleTitle = () => {
    if (topicSidebarView() !== "cron") return cronToggleLabel();
    return cronRunning() > 0 ? t("chat_topics_view_date_cron_running", { count: cronRunning() }) : t("chat_topics_view_date");
  };

  const selectedTopic = computed(() => {
    const id = normalizeTopicID(selectedTopicID());
    if (!id) return null;
    const matched = topics().find((topic) => normalizeTopicID(topic?.id) === id);
    if (matched) return matched;
    if (id === AWARENESS_TOPIC_ID) return { id: AWARENESS_TOPIC_ID, title: t("chat_topic_awareness"), created_at: "", updated_at: "" };
    return { id, title: "", created_at: "", updated_at: "" };
  });
  const hasSelectedTopic = () => normalizeTopicID(selectedTopicID()) !== "";
  const showChatPlaceholder = () => consoleTopicsEnabled() && !hasSelectedTopic() && chatHistoryItems().length === 0;
  const autoPreviewHistoryID = computed(() => {
    const items = chatHistoryItems();
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const item = items[i];
      if (String(item?.role || "").trim().toLowerCase() === "agent" && normalizeTaskStatus(item?.status) === "done" && hasArtifactBlock(item?.text)) {
        return String(item?.id || "").trim();
      }
    }
    return "";
  });

  function topicTitle(topic: any) {
    const title = String(topic?.title || "").trim();
    if (title) return title;
    const id = normalizeTopicID(topic?.id);
    if (id === DEFAULT_TOPIC_ID) return t("chat_topic_default");
    if (id === AWARENESS_TOPIC_ID) return t("chat_topic_awareness");
    if (isCronTopicID(id)) return t("chat_topic_cron_untitled");
    if (isAgentLinkTopicID(id)) {
      const instanceID = agentLinkInstanceID(agentLinkTopicContactID(id));
      const endpoint = endpointState.items.find((item: any) => String(item?.instance_id || "").trim() === instanceID);
      return String(endpoint?.agent_name || endpoint?.name || "").trim() || t("chat_topic_agent_untitled");
    }
    return t("chat_topic_untitled");
  }

  const mobileBarTitle = () => {
    if (!mobileTopicSplitEnabled()) return t("chat_title");
    if (!hasSidebarTopics()) return creatingTopic() ? t("chat_topic_new") : t("chat_title");
    if (mobileTopicView() === "topics") return t("chat_topics_title");
    if (creatingTopic()) return t("chat_topic_new");
    return selectedTopic() ? topicTitle(selectedTopic()) : t("chat_title");
  };
  const mobileShowBack = () => mobileTopicSplitEnabled() && hasSidebarTopics() && mobileTopicView() === "chat";
  const showTopicSidebar = () => {
    if (!consoleTopicsEnabled()) return false;
    if (!mobileTopicSplitEnabled()) return hasSidebarTopics();
    return mobileTopicView() === "topics";
  };
  const showChatPane = () => !mobileTopicSplitEnabled() || mobileTopicView() === "chat";

  const workspaceTopicID = computed(() => {
    if (!consoleTopicsEnabled() || creatingTopic()) return "";
    const id = normalizeTopicID(selectedTopicID());
    return !id || id === AWARENESS_TOPIC_ID ? "" : id;
  });
  const workspaceSidebarAvailable = () => Boolean(workspaceTopicID());
  const desktopWorkspaceSidebarVisible = () => workspaceSidebarAvailable() && !mobileMode() && showChatPane() && workspaceSidebarOpen();
  const mobileWorkspaceSidebarVisible = () => workspaceSidebarAvailable() && mobileMode() && showChatPane() && workspaceSidebarOpen();
  const desktopActivityDetailVisible = () => activityDetail() !== null && !mobileMode() && showChatPane();
  const mobileActivityDetailVisible = () => activityDetail() !== null && mobileMode() && showChatPane();
  /** Whether a column stands at the right of the conversation (wide windows). */
  const desktopRightPanelVisible = () => desktopWorkspaceSidebarVisible() || desktopActivityDetailVisible();
  /** What the right panel shows, as a key that changes when it shows something else. */
  const rightPanelKey = () => {
    const detail = activityDetail();
    if (detail) return `detail\u0000${activityDetailKey(detail)}`;
    return workspaceSidebarOpen() ? "workspace" : "";
  };
  /** Whether one of the page's dialogs is open (Escape is theirs then, not the detail panel's). */
  const pageDialogOpen = () =>
    rawDialogOpen() || filePreview().open || topicDeleteDialogOpen() || topicRename.open() || workspaceBrowserOpen();
  /** The reply the detail panel shows, read live from the history (null once it is gone). */
  const activityDetailItem = computed(() => findActivityDetailItem(chatHistoryItems(), activityDetail()));
  /** What a reply answers: the message before it, on one line. */
  const activityDetailContextOf = (item: HistoryItem | null) => {
    if (!item) return "";
    const items = chatHistoryItems();
    for (let index = items.indexOf(item) - 1; index >= 0; index -= 1) {
      if (String(items[index]?.role || "").trim().toLowerCase() === "user") return String(items[index]?.text || "").replace(/\s+/g, " ").trim();
    }
    return "";
  };
  /** What the detail panel's reply answers. */
  const activityDetailContext = () => activityDetailContextOf(activityDetailItem());
  // The phone's right sheet shows the details or the workspace panel. While it goes out (neither is
  // open any more) it keeps the details it showed, and their width: closing them must not put the
  // workspace panel in the sheet under its exit. Only opening it again changes what it shows.
  const mobileSheetDetail = signal<ActivityDetailRef | null>(null);
  effect(() => {
    const detail = mobileActivityDetailVisible() ? activityDetail() : null;
    const open = detail !== null || mobileWorkspaceSidebarVisible();
    if (open) untracked(() => mobileSheetDetail.set(detail));
  });
  /** The reply the phone's sheet shows, live (also while it goes out). */
  const mobileSheetDetailItem = computed(() => findActivityDetailItem(chatHistoryItems(), mobileSheetDetail()));
  // Consecutive topics of one local day share a date heading.
  const topicDayGroups = computed(() => {
    const groups: any[] = [];
    for (const topic of splitPinnedTopics(visibleTopics()).rest) {
      const dayKey = topicDayKey(topic);
      const last = groups[groups.length - 1];
      if (last && last.dayKey === dayKey) last.topics.push(topic);
      else groups.push({ key: `${dayKey}:${normalizeTopicID(topic?.id)}`, dayKey, label: topicDayLabel(topic), topics: [topic] });
    }
    return groups;
  });

  // How the tag view is arranged, kept by the runtime (GET/PUT /topics/layout). A runtime without it
  // shows the default order.
  const topicLayout = signal<any>(normalizeTopicLayout(null));
  const topicLayoutSupported = signal(false);
  let topicLayoutEndpoint: string | null = null;

  async function loadTopicLayout() {
    const endpointRef = untracked(submitEndpointRef);
    topicLayoutEndpoint = endpointRef;
    try {
      const data = await runtimeApiFetchForEndpoint(endpointRef, "/topics/layout");
      if (untracked(submitEndpointRef) !== endpointRef) return;
      batch(() => {
        topicLayout.set(normalizeTopicLayout(data));
        topicLayoutSupported.set(true);
      });
    } catch {
      if (untracked(submitEndpointRef) !== endpointRef) return;
      batch(() => {
        topicLayout.set(normalizeTopicLayout(null));
        topicLayoutSupported.set(false);
      });
    }
  }

  const topicTagGroups = computed(() =>
    arrangeTopicGroups(groupTopicsByTag(visibleTopics(), { pinned: t("chat_topics_pinned"), untagged: t("chat_topics_untagged") }), topicLayout()),
  );
  const pinnedTopicGroup = computed(() => {
    const { pinned } = splitPinnedTopics(visibleTopics());
    return pinned.length > 0
      ? { key: "pinned", label: t("chat_topics_pinned"), topics: orderGroupTopics(pinned, topicLayout().topic_order.pinned), pinned: true, drop: { kind: "pin" } }
      : null;
  });
  const agentTopics = computed(() =>
    topics()
      .filter((topic) => isAgentLinkTopicID(normalizeTopicID(topic?.id)))
      .sort((a, b) => String(b?.updated_at || "").localeCompare(String(a?.updated_at || ""))),
  );
  const topicSidebarGroups = computed((): any[] => {
    if (topicSidebarView() === "agents") return agentTopics().length > 0 ? [{ key: "agents", label: "", topics: agentTopics() }] : [];
    if (topicSidebarView() === "cron") return cronSidebarGroups(topics());
    return topicSidebarView() === "tags" ? topicTagGroups() : [...(pinnedTopicGroup() ? [pinnedTopicGroup()] : []), ...topicDayGroups()];
  });
  const knownTags = computed(() => knownTopicTags(topics()));
  const selectedTopicOrdinaryTags = () => ordinaryTopicTags(selectedTopic());
  const selectedTopicPinned = () => topicPinned(selectedTopic());
  const topicTagsAvailable = () =>
    Boolean(workspaceTopicID()) &&
    !isAgentLinkTopicID(workspaceTopicID()) &&
    !isCronTopicID(workspaceTopicID()) &&
    topics().some((topic) => normalizeTopicID(topic?.id) === normalizeTopicID(workspaceTopicID()));
  const topicTagsSaving = () => topicTagSaves().has(normalizeTopicID(workspaceTopicID()));
  /** A save of this topic's tags is under way. */
  const topicTagSaving = (topic: any) => topicTagSaves().has(normalizeTopicID(topic?.id));

  // The agents' and TODO items' lists are a look aside, so the next visit opens on the date or tag
  // list again.
  function setTopicSidebarView(view: SidebarView) {
    const next: SidebarView = view === "tags" || view === "agents" || view === "cron" ? view : "date";
    topicSidebarView.set(next);
    if (next !== "agents" && next !== "cron") localStore.setItem(TOPIC_SIDEBAR_VIEW_STORAGE_KEY, next);
  }

  const topicAgentContact = (topic: any) => ({ contact_id: agentLinkTopicContactID(normalizeTopicID(topic?.id)) });
  const topicAgentAvatar = (topic: any) => agentLinkAvatarURL(topicAgentContact(topic), endpointState.items);
  const findTopic = (id: string) => untracked(topics).find((topic) => normalizeTopicID(topic?.id) === id) || null;

  // Saves a topic's whole tag list: shown at once, back if the save fails; one save per topic. With
  // `confirmed` the list changes only once the runtime has saved it, and a failure is a notice
  // whichever topic is open (a drop in the topic list, whose topic's panel may be closed).
  async function saveTopicTags(rawTopicID: string, nextTags: string[], options: { confirmed?: boolean } = {}) {
    const topicID = normalizeTopicID(rawTopicID);
    const endpointRef = untracked(submitEndpointRef);
    const topic = findTopic(topicID);
    if (!topic || untracked(topicTagSaves).has(topicID) || sameTopicTags(topicTags(topic), nextTags)) return false;
    const previous = topicTags(topic);
    const applyTags = (tags: string[]) =>
      topics.update((list) => list.map((item) => (normalizeTopicID(item?.id) === topicID ? { ...item, tags: [...tags] } : item)));
    if (!options.confirmed) applyTags(nextTags);
    topicTagSaves.update((saves) => new Set([...saves, topicID]));
    if (topicID === normalizeTopicID(untracked(workspaceTopicID))) topicTagsError.set("");
    try {
      const updated = await runtimeApiFetchForEndpoint(endpointRef, `/topics/${encodeURIComponent(topicID)}/tags`, {
        method: "PUT",
        body: { tags: nextTags },
      });
      // The runtime answers with the topic as saved; one without its tags saved what was sent.
      if (untracked(submitEndpointRef) === endpointRef) applyTags(Array.isArray(updated?.tags) ? topicTags(updated) : nextTags);
      return true;
    } catch (error) {
      if (untracked(submitEndpointRef) !== endpointRef) return false;
      if (!options.confirmed) applyTags(previous);
      const message = errorMessage(error, t("chat_topic_tags_failed"));
      if (!options.confirmed && topicID === normalizeTopicID(untracked(workspaceTopicID))) topicTagsError.set(message);
      else pushNotice({ type: "error", text: message });
      return false;
    } finally {
      topicTagSaves.update((saves) => {
        const next = new Set(saves);
        next.delete(topicID);
        return next;
      });
    }
  }

  // Dragging a topic onto a tag group in the tag view adds that group's tag to the topic's own
  // (pages/chat/topicDrag.ts). Only tag groups take a drop: not the pinned or untagged group, nor a
  // group whose tag the topic has already, nor any while the topic has its most tags, is saving, or
  // is an agent's or a TODO item's.
  function topicDropTags(topic: any, group: any): string[] | null {
    const id = normalizeTopicID(topic?.id);
    if (topicSidebarView() !== "tags" || group?.drop?.kind !== "tag") return null;
    if (!id || isAgentLinkTopicID(id) || isCronTopicID(id) || topicTagSaves().has(id)) return null;
    const current = topics().find((item) => normalizeTopicID(item?.id) === id);
    return current ? tagsAfterDrop(current, group.drop) : null;
  }
  const topicCanDrop = (topic: any, group: any) => topicDropTags(topic, group) !== null;
  /** Drops the topic on the group: saves the tags it then has, and lists them once saved. */
  function dropTopicOnGroup(topic: any, group: any) {
    const next = untracked(() => topicDropTags(topic, group));
    if (!next) return Promise.resolve(false);
    return saveTopicTags(topic.id, next, { confirmed: true });
  }

  const saveSelectedTopicTags = (tags: string[]) => saveTopicTags(untracked(workspaceTopicID), withPinned(tags, untracked(selectedTopicPinned)));
  const setSelectedTopicPinned = (pinned: boolean) =>
    saveTopicTags(untracked(workspaceTopicID), withPinned(untracked(selectedTopicOrdinaryTags), Boolean(pinned)));

  // Tag groups, and the pinned group in either view, fold to their heading.
  const collapsedTopicGroups = signal(loadCollapsedTopicGroups());
  const topicGroupCollapsible = (group: any) => Boolean(group?.label) && (topicSidebarView() === "tags" || group.pinned);
  const topicGroupCollapsed = (group: any) => topicGroupCollapsible(group) && collapsedTopicGroups().has(group.key);

  function toggleTopicGroup(group: any) {
    // While a search lasts every matching group is open and its heading is no toggle.
    if (untracked(topicSearching) || !untracked(() => topicGroupCollapsible(group))) return;
    const keys = new Set(untracked(collapsedTopicGroups));
    if (keys.has(group.key)) keys.delete(group.key);
    else keys.add(group.key);
    collapsedTopicGroups.set(keys);
    localStore.setItem(TOPIC_GROUPS_COLLAPSED_STORAGE_KEY, JSON.stringify([...keys]));
  }

  // The sidebar's search: a filter on the titles (as the rows show them, fallbacks included) of
  // the loaded topics in the current view. It asks the runtime for nothing; older topics join it
  // once loaded. It lives as long as the page and is not saved.
  const topicSearch = signal("");
  const topicSearchQuery = computed(() => topicSearch().trim().toLowerCase());
  const topicSearching = () => topicSearchQuery() !== "";
  const setTopicSearch = (value: string) => topicSearch.set(String(value ?? ""));
  // On a touch phone the search hides until the topic list is pulled down from its top
  // (components/shared/pullSearch.ts); once shown it stays while the page lives, the sidebar
  // being rebuilt each time the phone comes back from a topic.
  const topicSearchRevealed = signal(false);
  const topicMatchesSearch = (topic: any, query: string) => !query || topicTitle(topic).toLowerCase().includes(query);

  // The current view's groups with only the matching topics, before they become rows: a group
  // without a match goes, and a folded group with one opens while the search lasts (its saved
  // fold stays as it was).
  const searchedTopicGroups = computed((): any[] => {
    const query = topicSearchQuery();
    const groups = topicSidebarGroups();
    if (!query) return groups;
    const out: any[] = [];
    for (const group of groups) {
      const matches = (group.topics || []).filter((topic: any) => topicMatchesSearch(topic, query));
      if (matches.length > 0) out.push({ ...group, topics: matches });
    }
    return out;
  });

  /** The topic list as rows for the virtualized list: notes, group headings, topics. */
  const topicRows = computed((): TopicRow[] => {
    const rows: TopicRow[] = [];
    const view = topicSidebarView();
    const searching = topicSearching();
    const groups = searchedTopicGroups();
    if (view === "tags" && !searching && knownTags().length === 0 && groups.length > 0) rows.push({ kind: "note", key: "note:tags", text: t("chat_topics_tags_hint") });
    if (view === "agents" && agentTopics().length === 0) rows.push({ kind: "note", key: "note:agents", text: t("chat_topics_agents_empty") });
    if (view === "cron" && cronTopics().length === 0) rows.push({ kind: "note", key: "note:cron", text: t("chat_topics_cron_empty") });
    if (searching && groups.length === 0 && topicSidebarGroups().some((group) => (group.topics || []).length > 0)) {
      rows.push({ kind: "note", key: "note:search-empty", text: t("chat_topics_search_empty", { query: topicSearch().trim() }) });
      if (topicsNextCursor()) rows.push({ kind: "note", key: "note:search-older", text: t("chat_topics_search_older") });
    }
    for (const group of groups) {
      const collapsible = !searching && topicGroupCollapsible(group);
      const collapsed = collapsible && topicGroupCollapsed(group);
      if (group.label) rows.push({ kind: "group", key: `group:${group.key}`, group, collapsible, collapsed });
      if (collapsed) continue;
      for (const topic of group.topics) rows.push({ kind: "topic", key: `topic:${group.key}:${normalizeTopicID(topic?.id)}`, topic, group });
    }
    return rows;
  });

  const deskTitle = () => (creatingTopic() || !hasSelectedTopic() || !selectedTopic() ? t("chat_topic_new") : topicTitle(selectedTopic()));
  const selectedTopicIsAgent = () => isAgentLinkTopicID(normalizeTopicID(selectedTopicID()));
  const selectedTopicIsCron = () => isCronTopicID(normalizeTopicID(selectedTopicID()));
  const selectedTopicIsReserved = () => {
    const id = normalizeTopicID(selectedTopicID());
    return id === DEFAULT_TOPIC_ID || id === AWARENESS_TOPIC_ID || selectedTopicIsAgent() || selectedTopicIsCron();
  };
  const topicDeleteAvailable = () => Boolean(workspaceTopicID()) && !selectedTopicIsReserved();
  const topicDeleteDisabled = () => !topicDeleteAvailable() || topicDeleting();
  // A person's own topic is renamed through the rename dialog, which also offers a generated name.
  // A TODO item's topic has no delete and no rename (its title is the item's), but its generated
  // icon can be redone.
  const topicRenameAvailable = () => topicDeleteAvailable();
  const topicRegenerateAvailable = () => Boolean(workspaceTopicID()) && selectedTopicIsCron();
  const topicRegenerateLabel = () => t("chat_topic_regenerate_icon_action");
  effect(() => {
    void workspaceTopicID();
    untracked(() => topicTagsError.set(""));
  });
  const topicNameRequestKey = () => JSON.stringify([submitEndpointRef(), selectedTopicID()]);
  const topicRegenerating = () => topicNameRequests().has(topicNameRequestKey());
  const topicRegenerateError = () => (topicNameFailure()?.key === topicNameRequestKey() ? topicNameFailure()!.message : "");
  /** Whether the open topic has something to name it from: a message that is not a command. */
  const selectedTopicHasConversation = () =>
    !historyLoading() &&
    (Boolean(historyNextCursor()) ||
      chatHistoryItems().some(
        (item) =>
          item.role === "user" &&
          item.topicID === selectedTopicID() &&
          String(item.text || "").trim() &&
          !String(item.text || "").trim().startsWith("/"),
      ));
  const topicRegenerateDisabled = () => !topicRegenerateAvailable() || topicDeleting() || topicRegenerating() || !selectedTopicHasConversation();
  const topicRename = createTopicRename({
    suggest: (endpointRef, topicID) =>
      runtimeApiFetchForEndpoint(endpointRef, `/topics/${encodeURIComponent(topicID)}/title-suggestion`, { method: "POST" }),
    save: (endpointRef, topicID, title) =>
      runtimeApiFetchForEndpoint(endpointRef, `/topics/${encodeURIComponent(topicID)}/title`, { method: "PUT", body: { title } }),
    onSaved: (session, updated) => applyRenamedTopic(session, updated),
    messages: () => ({ empty: t("chat_topic_rename_empty"), saveFailed: t("chat_topic_rename_failed"), suggestFailed: t("chat_topic_regenerate_failed") }),
  });
  const topicRenameDisabled = () => !topicRenameAvailable() || topicDeleting() || topicRename.open();
  const topicRenameRegenerateDisabled = () =>
    !topicRename.open() || topicRename.suggesting() || topicRename.saving() || !selectedTopicHasConversation();
  // The dialog belongs to the topic and runtime it was opened for: it goes when either changes.
  effect(() => {
    const current = topicRename.session();
    if (!current) return;
    const endpointRef = submitEndpointRef();
    const topicID = workspaceTopicID();
    if (endpointRef !== current.endpointRef || topicID !== current.topicID || !topicRenameAvailable()) {
      untracked(() => topicRename.close({ force: true }));
    }
  });
  const topicPropertyRows = () => {
    const topic = selectedTopic();
    if (!topic) return [];
    return [
      { key: "created", label: t("chat_topic_created_label"), value: formatShortTime(topic.created_at), title: formatTime(topic.created_at) },
      { key: "updated", label: t("chat_topic_updated_label"), value: formatShortTime(topic.updated_at), title: formatTime(topic.updated_at) },
    ];
  };
  const topicContextProgress = computed(() => {
    const context = topicContext() && typeof topicContext() === "object" ? topicContext() : null;
    if (!context?.available) return null;
    const ratio = topicContextUsageRatio(context);
    if (ratio === null) {
      // The window size is unknown: the tokens used, without a meter.
      const used = Number(context.used_input_tokens);
      if (!Number.isFinite(used) || used <= 0) return null;
      const label = formatTokenCount(used);
      return { label, title: `${label} · ${t("chat_topic_context_window_unknown")}`, meter: null as any, fill: 0, unknownWindow: true };
    }
    const label = formatUsageRatio(ratio);
    const meter = contextMeter(context);
    if (!meter) return { label, title: `${t("chat_topic_context_ratio_label")}: ${label}`, meter: null as any, fill: Math.min(ratio, 1), unknownWindow: false };
    const parts = [
      `${t("chat_topic_context_cached_label")}: ${formatTokenCount(meter.cached)}`,
      `${t("chat_topic_context_new_label")}: ${formatTokenCount(meter.fresh)}`,
      `${t("chat_topic_context_free_label")}: ${formatTokenCount(meter.free)}`,
    ];
    if (meter.trigger) parts.push(`${t("chat_topic_context_compacts_label")}: ${formatTokenCount(meter.trigger)}`);
    return {
      label,
      meter,
      fill: Math.min(meter.ratio, 1),
      unknownWindow: false,
      title: `${t("chat_topic_context_ratio_label")}: ${label} (${formatTokenCount(meter.used)} / ${formatTokenCount(meter.window)})\n${parts.join("\n")}`,
    };
  });

  function openContextInspector() {
    const id = normalizeTopicID(untracked(workspaceTopicID));
    if (id) void router.push(endpointRoutePath(endpointState.selectedRef, `/chat/${encodeURIComponent(id)}/context`));
  }

  const topicDeleteDialogText = () => t("chat_topic_delete_confirm", { title: topicTitle(topicDeleteTarget() || selectedTopic() || {}) });
  const workspaceReady = () => Boolean(submitEndpointRef() && workspaceTopicID());
  const workspaceBusy = () => workspaceLoading() || workspaceSaving();
  const workspaceHintText = () => {
    if (workspaceTopicID()) {
      if (!String(workspaceDir() || "").trim()) return t("chat_workspace_hint_empty");
      if (workspaceSource() === "default") return t("chat_workspace_hint_default");
      if (workspaceSource() === "todo") return t("chat_workspace_hint_todo");
      return "";
    }
    if (creatingTopic()) return t("chat_workspace_hint_needs_topic");
    if (normalizeTopicID(selectedTopicID()) === AWARENESS_TOPIC_ID) return t("chat_workspace_hint_system_topic");
    return t("chat_workspace_hint_no_topic");
  };
  const workspaceAttachDisabled = () => !workspaceReady() || workspaceBusy();
  const composerWorkspaceAttachDisabled = () => !String(submitEndpointRef() || "").trim() || workspaceBusy();
  const composerAddDisabled = () => composerDisabled() || !String(submitEndpointRef() || "").trim();
  const workspaceDetachDisabled = () =>
    !workspaceReady() || workspaceBusy() || workspaceSource() !== "attachment" || String(workspaceDir() || "").trim() === "";
  /** The home directory of the host the selected endpoint's workspaces are on; "" when it did not say. */
  const workspaceHomeDir = () => {
    const home = workspaceHome();
    return home && home.endpointRef === String(submitEndpointRef() || "").trim() ? home.dir : "";
  };
  /** The workspace path as the panel writes it: the host's home as `~`, and where its last part starts. */
  const workspaceDirDisplay = () => workspacePathDisplay(workspaceDir(), workspaceHomeDir());
  // A TODO item's topic shows the workspace its runs use, read-only, and only when there is one.
  const workspaceTabAvailable = () => !selectedTopicIsCron() || Boolean(String(workspaceDir() || "").trim());
  const workspacePanelTabs = () => [
    { id: TOPIC_TAB_ID, label: t("chat_topic_kicker"), icon: "PhChats" as const },
    ...(workspaceTabAvailable() ? [{ id: WORKSPACE_TAB_ID, label: t("chat_workspace_label"), icon: "PhCube" as const }] : []),
  ];
  effect(() => {
    const available = workspaceTabAvailable();
    const loading = workspaceLoading();
    untracked(() => {
      if (!available && !loading && workspaceSidebarTabID() === WORKSPACE_TAB_ID) workspaceSidebarTabID.set(TOPIC_TAB_ID);
    });
  });
  const workspaceTreeRows = computed(() => buildTreeRows(workspaceTreeItems(), workspaceTreeExpanded()));
  const workspaceSelectedTreeEntry = () => {
    const path = String(workspaceTreeSelectionPath() || "").trim();
    if (!path) return null;
    return workspaceTreeRows().find((row: any) => String(row?.entry?.path || "").trim() === path)?.entry || null;
  };
  const workspaceBrowserInitialDir = () => String(workspaceBrowserPendingMode() ? pendingWorkspaceDir() : workspaceDir() || "").trim();
  const workspaceBrowserConfirmDisabled = () => (workspaceBrowserPendingMode() ? !String(submitEndpointRef() || "").trim() : !workspaceReady());
  const workspaceSidebarToggleLabel = () => (workspaceSidebarOpen() ? t("chat_workspace_sidebar_close") : t("chat_workspace_sidebar_open"));
  const chatPlaceholderHint = () => (visibleTopics().length > 0 ? t("chat_placeholder_choose_topic") : t("chat_intro"));

  const treeItemsRef = refOf(workspaceTreeItems, (value) => workspaceTreeItems.set(value));
  const treeExpandedRef = refOf(workspaceTreeExpanded, (value) => workspaceTreeExpanded.set(value));

  /* ---------- the mobile split ---------- */

  function syncMobileTopicView(options: { preferTopics?: boolean; preferChat?: boolean } = {}) {
    untracked(() => {
      if (!mobileTopicSplitEnabled() || !hasSidebarTopics()) {
        mobileTopicView.set("chat");
        return;
      }
      if (options.preferTopics) mobileTopicView.set("topics");
      else if (options.preferChat) mobileTopicView.set("chat");
      else if (!creatingTopic() && !normalizeTopicID(selectedTopicID())) mobileTopicView.set("topics");
    });
  }

  function showTopicsView() {
    if (!untracked(hasSidebarTopics)) return;
    syncMobileTopicView({ preferTopics: true });
    void syncChatRoute("", { replace: true });
  }

  // The phone bar's back arrow: with the software keyboard up its first tap only lowers it, and the
  // view, the topic and the draft stay as they were; the next tap goes to the list. Android's
  // system Back needs none of this: the system lowers the keyboard before the app hears it.
  function mobileBack() {
    if (dismissSoftKeyboard(composer?.focused() ?? false)) return;
    showTopicsView();
  }

  let lastMobile: boolean | undefined;
  effect(() => {
    const mobile = mobileMode();
    untracked(() => {
      if (lastMobile === undefined || lastMobile === mobile) {
        lastMobile = mobile;
        return;
      }
      lastMobile = mobile;
      syncMobileTopicView({ preferChat: Boolean(creatingTopic() || normalizeTopicID(selectedTopicID())) });
      focusComposerOnDesktop();
    });
  });

  /* ---------- the composer's data ---------- */

  async function ensureComposerSkillsLoaded() {
    if (untracked(composerSkills).length > 0 || untracked(composerSkillsLoading)) return;
    const seq = ++composerSkillsLoadSeq;
    batch(() => {
      composerSkillsLoading.set(true);
      composerSkillsError.set("");
    });
    try {
      const endpointRef = String(untracked(submitEndpointRef) || endpointState.selectedRef || "").trim();
      const data =
        endpointRef && endpointRef !== LOCAL_CONSOLE_ENDPOINT_REF
          ? await runtimeApiFetchForEndpoint(endpointRef, "/settings/agent")
          : await apiFetch("/settings/agent");
      if (seq !== composerSkillsLoadSeq) return;
      const skills = data?.skills && typeof data.skills === "object" ? data.skills : {};
      composerSkills.set(
        normalizeComposerSkillItems([...(Array.isArray(skills.loaded) ? skills.loaded : []), ...(Array.isArray(skills.available) ? skills.available : [])]),
      );
    } catch (error) {
      if (seq === composerSkillsLoadSeq) {
        batch(() => {
          composerSkillsError.set(errorMessage(error, t("chat_composer_suggestions_load_error")));
          composerSkills.set([]);
        });
      }
    } finally {
      if (seq === composerSkillsLoadSeq) composerSkillsLoading.set(false);
    }
  }

  async function ensureComposerCommandsLoaded() {
    if (untracked(composerCommands).length > 0 || untracked(composerCommandsLoading)) return;
    const seq = ++composerCommandsLoadSeq;
    composerCommandsLoading.set(true);
    try {
      const endpointRef = String(untracked(submitEndpointRef) || endpointState.selectedRef || "").trim();
      const data =
        endpointRef && endpointRef !== LOCAL_CONSOLE_ENDPOINT_REF ? await runtimeApiFetchForEndpoint(endpointRef, "/commands") : await apiFetch("/commands");
      if (seq !== composerCommandsLoadSeq) return;
      const raw = Array.isArray(data?.items) ? data.items : Array.isArray(data?.commands) ? data.commands : [];
      composerCommands.set(normalizeComposerCommandItems(raw));
    } catch (error) {
      if (seq === composerCommandsLoadSeq) composerCommands.set([]);
      console.warn("chat: commands", errorMessage(error, ""));
    } finally {
      if (seq === composerCommandsLoadSeq) composerCommandsLoading.set(false);
    }
  }

  function syncComposerLLMProfile() {
    composerLLMProfile.set(resolveAvailableChatLLMProfile(untracked(composerTopicLLMProfile), untracked(composerLLMProfiles)));
  }

  function applyComposerTopicLLMProfile(raw: string) {
    composerTopicLLMProfile.set(String(raw || "").trim());
    syncComposerLLMProfile();
  }

  async function loadComposerLLMProfiles() {
    const seq = ++composerLLMProfilesLoadSeq;
    const endpointRef = String(untracked(submitEndpointRef) || endpointState.selectedRef || "").trim();
    if (!endpointRef) {
      batch(() => {
        composerDefaultLLMProfile.set(null);
        composerLLMProfiles.set([]);
        applyComposerTopicLLMProfile("");
      });
      return;
    }
    try {
      const data = await runtimeApiFetchForEndpoint(endpointRef, "/llm/profiles");
      if (seq !== composerLLMProfilesLoadSeq) return;
      batch(() => {
        composerDefaultLLMProfile.set(normalizeChatLLMProfileMetadata(data?.default));
        composerLLMProfiles.set(normalizeChatLLMProfiles(data?.items));
        syncComposerLLMProfile();
      });
    } catch {
      if (seq === composerLLMProfilesLoadSeq) {
        batch(() => {
          composerDefaultLLMProfile.set(null);
          composerLLMProfiles.set([]);
          syncComposerLLMProfile();
        });
      }
    }
  }

  /* ---------- drafts ---------- */

  function persistComposerDraft(scope = untracked(composerDraftScope), text = untracked(taskInput)) {
    const endpointRef = String(scope?.endpointRef || "").trim();
    if (endpointRef) rememberChatDraft(endpointRef, normalizeTopicID(scope?.topicID), text);
  }

  function restoreComposerDraft(scope = untracked(composerDraftScope)) {
    const endpointRef = String(scope?.endpointRef || "").trim();
    suppressDraftPersistence = true;
    taskInput.set(endpointRef ? chatDraft(endpointRef, normalizeTopicID(scope?.topicID)) : "");
    suppressDraftPersistence = false;
  }

  /** What the composer's field reports: the draft, remembered for its topic. */
  function setTaskInput(text: string) {
    taskInput.set(text);
    if (!suppressDraftPersistence) persistComposerDraft();
  }

  function setComposerFileDraft(scope: any, items: ComposerFileItem[]) {
    const key = composerFileDraftKey(scope);
    if (!key) return;
    const next = Array.isArray(items) ? [...items] : [];
    if (next.length > 0) composerFileDrafts.set(key, next);
    else composerFileDrafts.delete(key);
    if (key === composerFileDraftKey(untracked(composerDraftScope))) composerFiles.set(next);
  }

  function updateComposerFileDraft(scope: any, update: (items: ComposerFileItem[]) => ComposerFileItem[]) {
    const key = composerFileDraftKey(scope);
    if (!key) return;
    setComposerFileDraft(scope, update([...(composerFileDrafts.get(key) || [])]));
  }

  function restoreComposerFileDraft(scope = untracked(composerDraftScope)) {
    const key = composerFileDraftKey(scope);
    composerFiles.set(key ? [...(composerFileDrafts.get(key) || [])] : []);
  }

  const clearComposerFileDraft = (scope = untracked(composerDraftScope)) => setComposerFileDraft(scope, []);

  function focusComposer() {
    untracked(() => {
      if (chatReadonly() || (mobileTopicSplitEnabled() && !showChatPane())) return;
      composer?.focus();
    });
  }

  // Entering a conversation, sending or stopping focuses the composer on desktops only: on a phone
  // focus raises the keyboard over the reply the user is about to read.
  function focusComposerOnDesktop() {
    if (!untracked(mobileMode)) focusComposer();
  }

  function insertComposerText(text: string) {
    if (text) composer?.insertText(text);
  }

  /* ---------- attachments ---------- */

  function isBrowserFile(file: unknown): file is File {
    return typeof File !== "undefined" && file instanceof File;
  }

  async function openComposerFilePicker() {
    if (untracked(composerAddDisabled)) return;
    let picked: PickedFile[] = [];
    try {
      picked = await pickFiles({ multiple: true });
    } catch (error) {
      err.set(errorMessage(error, t("chat_composer_upload_failed")));
      return;
    }
    if (Array.isArray(picked) && picked.length) await uploadComposerFileList(picked);
  }

  async function uploadOne(endpointRef: string, file: PickedFile | File, fields: Record<string, string>) {
    if (isBrowserFile(file)) {
      const form = new FormData();
      form.append("files", file, file.name);
      for (const [name, value] of Object.entries(fields)) form.append(name, value);
      return runtimeApiFetchForEndpoint(endpointRef, "/files/upload", { method: "POST", body: form });
    }
    return uploadPickedFile(endpointRef, file, fields);
  }

  async function uploadComposerFileList(files: (PickedFile | File)[], retryID = "") {
    if (files.length === 0 || untracked(composerDisabled)) return;
    const endpointRef = String(untracked(submitEndpointRef) || "").trim();
    if (!endpointRef) {
      err.set(t("msg_select_endpoint"));
      return;
    }
    const scope = untracked(composerDraftScope);
    const uploadScope = { endpointRef: String(scope.endpointRef || "").trim(), topicID: normalizeTopicID(scope.topicID) };
    const retryItem = retryID ? untracked(composerFiles).find((item) => item.id === retryID && item.status === "failed" && item.sourceFile) : null;
    if (retryID && !retryItem) return;
    const sources = retryItem ? [retryItem.sourceFile as PickedFile | File] : files;
    const uploadItems: ComposerFileItem[] = sources.map((file) => ({
      id: retryItem?.id || `composer-file-${Date.now()}-${++composerFileSequence}`,
      name: String((file as { name?: string })?.name || "").trim() || "file",
      status: "uploading",
      dirName: "",
      path: "",
      error: "",
      sourceFile: file,
    }));
    updateComposerFileDraft(uploadScope, (current) =>
      retryItem ? current.map((item) => (item.id === retryID ? uploadItems[0] : item)) : [...current, ...uploadItems],
    );
    const fields: Record<string, string> = {};
    const pendingDir = String(untracked(pendingWorkspaceDir) || "").trim();
    const attachedDir = String(untracked(workspaceDir) || "").trim();
    const topicID = String(untracked(workspaceTopicID) || "").trim();
    if (pendingDir) fields.workspace_dir = pendingDir;
    else if (topicID) fields.topic_id = topicID;
    else if (attachedDir) fields.workspace_dir = attachedDir;
    err.set("");
    const retryHint = t("chat_composer_file_retry_hint");
    let workspaceChanged = false;
    await Promise.all(
      uploadItems.map(async (upload, index) => {
        try {
          const data = await uploadOne(endpointRef, sources[index], fields);
          const uploaded = Array.isArray(data?.files) ? data.files[0] : null;
          const dirName = String(uploaded?.dir_name || "").trim();
          const path = String(uploaded?.path || "").trim();
          if (!uploaded) throw new Error(t("chat_composer_upload_failed"));
          if (!path || (dirName !== "workspace_dir" && dirName !== "file_cache_dir")) {
            updateComposerFileDraft(uploadScope, (current) =>
              current.map((item) => (item.id === upload.id ? { ...item, status: "failed", error: `${t("chat_composer_upload_failed")} ${retryHint}` } : item)),
            );
            return;
          }
          if (dirName === "workspace_dir") workspaceChanged = true;
          if (!isBrowserFile(sources[index])) releaseFile(sources[index] as PickedFile);
          updateComposerFileDraft(uploadScope, (current) =>
            current.map((item) =>
              item.id === upload.id
                ? { ...item, name: String(uploaded?.name || "").trim() || item.name, status: "ready", dirName, path, error: "", sourceFile: undefined }
                : item,
            ),
          );
        } catch (error) {
          const message = `${errorMessage(error, t("chat_composer_upload_failed"))} ${retryHint}`;
          updateComposerFileDraft(uploadScope, (current) =>
            current.map((item) => (item.id === upload.id ? { ...item, status: "failed", error: message } : item)),
          );
        }
      }),
    );
    const same = composerFileDraftKey(uploadScope) === composerFileDraftKey(untracked(composerDraftScope));
    if (
      workspaceChanged &&
      untracked(workspaceSidebarOpen) &&
      untracked(workspaceSidebarTabID) === WORKSPACE_TAB_ID &&
      same &&
      attachedDir
    ) {
      await loadWorkspaceTree("", { force: true });
    }
    if (same) composer?.focus({ preserveSelection: true });
  }

  function retryComposerFile(item: ComposerFileItem) {
    if (item?.sourceFile) void uploadComposerFileList([item.sourceFile as PickedFile | File], item.id);
  }

  function releasePreviewURL() {
    if (filePreviewObjectURL) URL.revokeObjectURL(filePreviewObjectURL);
    filePreviewObjectURL = "";
  }

  async function resolveFilePreviewSource(item: any): Promise<Blob> {
    if (isBrowserFile(item?.sourceFile)) return item.sourceFile;
    const endpointRef = String(item?.endpointRef || untracked(submitEndpointRef) || "").trim();
    const dirName = String(item?.dirName || item?.dir_name || "").trim();
    const path = String(item?.path || "").trim();
    if (!endpointRef || !path || (dirName !== "workspace_dir" && dirName !== "file_cache_dir")) {
      throw new Error(t("chat_composer_file_preview_unavailable"));
    }
    const query = new URLSearchParams();
    query.set("dir_name", dirName);
    query.set("path", path);
    if (dirName === "workspace_dir") {
      const topicID = normalizeTopicID(item?.topicID || untracked(selectedTopicID));
      if (!topicID) throw new Error(t("chat_composer_file_preview_unavailable"));
      query.set("topic_id", topicID);
    }
    return fetchEndpointBlob(endpointRef, `/files/download?${query.toString()}`);
  }

  function closeComposerFilePreview() {
    filePreviewSequence += 1;
    releasePreviewURL();
    filePreview.set(CLOSED_PREVIEW);
  }

  async function loadComposerFilePreview(item: any) {
    if (String(item?.status || "").trim() !== "ready") return;
    releasePreviewURL();
    const sequence = ++filePreviewSequence;
    filePreview.update((state) => ({ ...state, open: true, loading: true, name: String(item?.name || "").trim(), kind: "", url: "", text: "", error: "" }));
    const extension = composerFileExtension(item?.name);
    try {
      const source = await resolveFilePreviewSource(item);
      if (sequence !== filePreviewSequence) return;
      const mime = String(source?.type || "").trim().toLowerCase();
      if (COMPOSER_FILE_IMAGE_EXTENSIONS.has(extension) || (mime.startsWith("image/") && mime !== "image/svg+xml")) {
        filePreviewObjectURL = URL.createObjectURL(source);
        filePreview.update((state) => ({ ...state, kind: "image", url: filePreviewObjectURL }));
      } else if (extension === ".pdf" || mime === "application/pdf") {
        filePreviewObjectURL = URL.createObjectURL(source);
        filePreview.update((state) => ({ ...state, kind: "pdf", url: filePreviewObjectURL }));
      } else {
        const buffer = await source.arrayBuffer();
        if (sequence !== filePreviewSequence) return;
        const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
        filePreview.update((state) => ({ ...state, kind: "text", text }));
      }
    } catch {
      if (sequence === filePreviewSequence) filePreview.update((state) => ({ ...state, error: t("chat_composer_file_preview_unavailable") }));
    } finally {
      if (sequence === filePreviewSequence) filePreview.update((state) => ({ ...state, loading: false }));
    }
  }

  function previewComposerFile(item: any) {
    const items = (Array.isArray(item?.previewItems) ? item.previewItems : [item]).filter(
      (candidate: any) => String(candidate?.status || "").trim() === "ready",
    );
    if (items.length === 0) return;
    const index = Math.max(0, items.findIndex((candidate: any) => String(candidate?.id || "").trim() === String(item?.id || "").trim()));
    filePreview.update((state) => ({ ...state, items, index }));
    void loadComposerFilePreview(items[index]);
  }

  function navigateComposerFilePreview(offset: number) {
    const state = untracked(filePreview);
    const next = state.index + offset;
    if (next < 0 || next >= state.items.length) return;
    filePreview.update((current) => ({ ...current, index: next }));
    void loadComposerFilePreview(state.items[next]);
  }

  function removeComposerFile(item: ComposerFileItem) {
    const id = String(item?.id || "").trim();
    if (!id || untracked(sending)) return;
    if (item.sourceFile && !isBrowserFile(item.sourceFile)) releaseFile(item.sourceFile as PickedFile);
    updateComposerFileDraft(untracked(composerDraftScope), (current) => current.filter((entry) => entry.id !== id));
    const preview = untracked(filePreview);
    if (preview.open && preview.items[preview.index]?.id === id) closeComposerFilePreview();
  }

  /* ---------- the workspace ---------- */

  function resetWorkspaceTreeState() {
    batch(() => {
      workspaceTreeItems.set({});
      workspaceTreeExpanded.set({ "": true });
      workspaceTreeLoading.set(false);
      workspaceTreeLoadingPath.set("");
      workspaceTreeError.set("");
      workspaceTreeSelectionPath.set("");
    });
  }

  function resetWorkspaceState() {
    workspaceRequestSeq += 1;
    batch(() => {
      workspaceDir.set("");
      workspaceSource.set("none");
      workspaceLoading.set(false);
      workspaceSaving.set(false);
      workspaceOpening.set(false);
      workspaceDownloading.set(false);
      workspaceError.set("");
      topicContext.set(null);
      workspaceBrowserOpen.set(false);
      workspaceBrowserPendingMode.set(false);
      pendingWorkspaceDir.set("");
      workspaceSidebarTabID.set(TOPIC_TAB_ID);
      resetWorkspaceTreeState();
    });
  }

  /**
   * A workspace as a runtime reports it. `endpointRef` names the runtime when the payload is its
   * own answer: its `home_dir` (the host's home, absent from runtimes that do not report it) is
   * kept for it. Without one (a payload made here) the home known for the endpoint stays.
   */
  function applyWorkspacePayload(data: any, endpointRef = "") {
    const dir = String(data?.workspace_dir || "").trim();
    const raw = String(data?.source || "").trim().toLowerCase();
    const source = ["attachment", "default", "none", "todo"].includes(raw) ? raw : dir ? "attachment" : "none";
    const ref = String(endpointRef || "").trim();
    batch(() => {
      if (ref) {
        const home = typeof data?.home_dir === "string" ? data.home_dir.trim() : "";
        const known = untracked(workspaceHome);
        if (home) workspaceHome.set({ endpointRef: ref, dir: home });
        else if (known?.endpointRef === ref) workspaceHome.set(null);
      }
      workspaceDir.set(dir);
      workspaceSource.set(source);
      workspaceError.set("");
      resetWorkspaceTreeState();
    });
  }

  function applyTopicMetadataPayload(data: any, endpointRef: string) {
    const workspace = data?.workspace && typeof data.workspace === "object" ? data.workspace : data;
    applyWorkspacePayload(workspace, endpointRef);
    const context = data?.context && typeof data.context === "object" ? data.context : null;
    topicContext.set(context && context.available ? context : null);
  }

  async function refreshWorkspaceState() {
    const endpointRef = String(untracked(submitEndpointRef) || "").trim();
    const topicID = String(untracked(workspaceTopicID) || "").trim();
    const request = ++workspaceRequestSeq;
    if (!endpointRef || !topicID) {
      resetWorkspaceState();
      return true;
    }
    batch(() => {
      workspaceLoading.set(true);
      workspaceError.set("");
    });
    try {
      const data = await runtimeApiFetchForEndpoint(endpointRef, `/topic/${encodeURIComponent(topicID)}/metadata`);
      if (request !== workspaceRequestSeq) return false;
      applyTopicMetadataPayload(data, endpointRef);
      if (untracked(workspaceSidebarOpen) && untracked(workspaceSidebarTabID) === WORKSPACE_TAB_ID && String(untracked(workspaceDir) || "").trim()) {
        await loadWorkspaceTree("", { force: true });
      }
      return true;
    } catch (error) {
      if (request !== workspaceRequestSeq) return false;
      batch(() => {
        workspaceDir.set("");
        workspaceSource.set("none");
        resetWorkspaceTreeState();
        workspaceError.set(errorMessage(error, t("msg_load_failed")));
      });
      return false;
    } finally {
      if (request === workspaceRequestSeq) workspaceLoading.set(false);
    }
  }

  /**
   * Shows `next` at the right. On wide windows a column that comes or goes does so in one motion
   * (the Vue console animates its grid column over the slow token): the conversation narrows or
   * widens and the column fades in or out with it. A column that stays (the workspace panel giving
   * way to the detail panel, or one entry to another) only changes what it shows (ChatPage plays
   * the content's entrance), so an outgoing and an incoming panel never show at once.
   */
  function setRightPanel(next: RightPanel) {
    const visible = (panel: RightPanel) =>
      !untracked(mobileMode) &&
      untracked(showChatPane) &&
      (panel.kind === "detail" || (panel.kind === "workspace" && untracked(workspaceSidebarAvailable)));
    if (visible(untracked(rightPanel)) !== visible(next)) {
      LayoutAnimation.configureNext({
        duration: motionMs(MOTION_SLOW),
        create: { type: "easeInEaseOut", property: "opacity" },
        update: { type: "easeInEaseOut" },
        delete: { type: "easeInEaseOut", property: "opacity" },
      });
    }
    rightPanel.set(next);
  }

  function rememberWorkspaceSidebarOpen(open: boolean) {
    localStore.setItem(WORKSPACE_SIDEBAR_OPEN_STORAGE_KEY, open ? "true" : "false");
  }

  function toggleWorkspaceSidebar() {
    if (!untracked(workspaceSidebarAvailable)) return;
    const open = !untracked(workspaceSidebarOpen);
    setRightPanel(open ? RIGHT_PANEL_WORKSPACE : RIGHT_PANEL_NONE);
    rememberWorkspaceSidebarOpen(open);
  }

  function closeMobileWorkspaceSidebar() {
    if (!untracked(workspaceSidebarOpen)) return;
    setRightPanel(RIGHT_PANEL_NONE);
    rememberWorkspaceSidebarOpen(false);
  }

  /**
   * Opens an entry of a reply (its plan, progress, reasoning or a worker) in the detail panel, in
   * place of whatever the right panel showed; the entry already shown closes it again.
   */
  function openActivityDetail(ref: ActivityDetailRef) {
    const next = normalizeActivityDetail(ref);
    if (!next) return;
    if (activityDetailKey(untracked(activityDetail)) === activityDetailKey(next)) {
      closeActivityDetail({ restoreFocus: false });
      return;
    }
    setRightPanel({ kind: "detail", detail: next });
  }

  /**
   * Closes the detail panel. The entry that opened it takes the keyboard focus back, unless the
   * composer has it: pressing an entry need not take the focus from the field (the desktops'
   * pointer), and typing then goes on where it was.
   */
  function closeActivityDetail(options: { restoreFocus?: boolean } = {}) {
    const current = untracked(activityDetail);
    if (!current) return;
    setRightPanel(RIGHT_PANEL_NONE);
    if (options.restoreFocus === false || composer?.focused()) return;
    detailFocusReturn.request(activityDetailKey(current));
  }

  function onWorkspaceTabChange(id: string) {
    workspaceSidebarTabID.set(String(id || "").trim() || TOPIC_TAB_ID);
    if (id === WORKSPACE_TAB_ID && String(untracked(workspaceDir) || "").trim() && !hasOwnTreePath(untracked(workspaceTreeItems), "")) {
      void loadWorkspaceTree("", { force: true });
    }
  }

  async function loadWorkspaceTree(treePath = "", options: { force?: boolean } = {}) {
    const endpointRef = String(untracked(submitEndpointRef) || "").trim();
    const topicID = String(untracked(workspaceTopicID) || "").trim();
    const currentDir = String(untracked(workspaceDir) || "").trim();
    const path = String(treePath || "").trim();
    if (!endpointRef || !topicID || !currentDir) {
      resetWorkspaceTreeState();
      return false;
    }
    if (!path && options.force === true) resetWorkspaceTreeState();
    batch(() => {
      workspaceTreeLoading.set(true);
      workspaceTreeLoadingPath.set(path);
    });
    try {
      const query = new URLSearchParams();
      query.set("topic_id", topicID);
      if (path) query.set("path", path);
      const data = await runtimeApiFetchForEndpoint(endpointRef, `/workspace/tree?${query.toString()}`);
      setTreeItems(treeItemsRef, path, data?.items);
      if (path) setTreeExpanded(treeExpandedRef, path, true);
      workspaceTreeError.set("");
      return true;
    } catch (error) {
      workspaceTreeError.set(errorMessage(error, t("msg_load_failed")));
      return false;
    } finally {
      if (untracked(workspaceTreeLoadingPath) === path) {
        batch(() => {
          workspaceTreeLoading.set(false);
          workspaceTreeLoadingPath.set("");
        });
      }
    }
  }

  async function toggleWorkspaceTreeNode(entry: any) {
    const path = String(entry?.path || "").trim();
    if (!entry?.is_dir || !path) return;
    if (untracked(workspaceTreeExpanded)[path]) {
      setTreeExpanded(treeExpandedRef, path, false);
      return;
    }
    if (!hasOwnTreePath(untracked(workspaceTreeItems), path)) {
      if (!(await loadWorkspaceTree(path))) return;
    }
    setTreeExpanded(treeExpandedRef, path, true);
  }

  async function selectWorkspaceTreeNode(row: any) {
    const entry = row?.entry || row;
    const path = String(entry?.path || "").trim();
    if (!path) return;
    workspaceTreeSelectionPath.set(path);
    if (row?.expandable) await toggleWorkspaceTreeNode(entry);
  }

  function addWorkspaceSelectionToComposer() {
    if (untracked(composerDisabled)) return;
    const path = String(untracked(workspaceSelectedTreeEntry)?.path || "").trim();
    if (path) insertComposerText(path);
  }

  async function openWorkspaceSelection() {
    const endpointRef = String(untracked(submitEndpointRef) || "").trim();
    const topicID = String(untracked(workspaceTopicID) || "").trim();
    const path = String(untracked(workspaceSelectedTreeEntry)?.path || "").trim();
    if (!endpointRef || !topicID || !path || untracked(workspaceOpening)) return;
    batch(() => {
      workspaceOpening.set(true);
      workspaceError.set("");
    });
    try {
      await runtimeApiFetchForEndpoint(endpointRef, "/workspace/open", { method: "POST", body: { topic_id: topicID, path } });
    } catch (error) {
      workspaceError.set(errorMessage(error, t("msg_load_failed")));
    } finally {
      workspaceOpening.set(false);
    }
  }

  async function downloadWorkspaceSelection() {
    const endpointRef = String(untracked(submitEndpointRef) || "").trim();
    const topicID = String(untracked(workspaceTopicID) || "").trim();
    const entry = untracked(workspaceSelectedTreeEntry);
    const path = String(entry?.path || "").trim();
    if (!endpointRef || !topicID || !path || entry?.is_dir || untracked(workspaceDownloading)) return;
    batch(() => {
      workspaceDownloading.set(true);
      workspaceError.set("");
    });
    try {
      const query = new URLSearchParams();
      query.set("dir_name", "workspace_dir");
      query.set("topic_id", topicID);
      query.set("path", path);
      await saveEndpointFile(endpointRef, `/files/download?${query.toString()}`, workspaceDownloadFilename(entry));
    } catch (error) {
      workspaceError.set(errorMessage(error, t("msg_load_failed")));
    } finally {
      workspaceDownloading.set(false);
    }
  }

  function openWorkspaceBrowser(options: { pending?: boolean } = {}) {
    const pending = Boolean(options.pending);
    if (pending ? untracked(composerWorkspaceAttachDisabled) : untracked(workspaceAttachDisabled)) return;
    batch(() => {
      workspaceBrowserPendingMode.set(pending);
      workspaceBrowserOpen.set(true);
    });
  }

  function closeWorkspaceBrowser() {
    batch(() => {
      workspaceBrowserOpen.set(false);
      workspaceBrowserPendingMode.set(false);
    });
  }

  async function attachWorkspace(dir: string) {
    const endpointRef = String(untracked(submitEndpointRef) || "").trim();
    const topicID = String(untracked(workspaceTopicID) || "").trim();
    const next = String(dir || "").trim();
    if (!endpointRef || !next || untracked(workspaceSaving)) return;
    if (untracked(workspaceBrowserPendingMode) || !topicID) {
      batch(() => {
        pendingWorkspaceDir.set(next);
        workspaceBrowserOpen.set(false);
        workspaceBrowserPendingMode.set(false);
      });
      rememberRecentWorkspaceDir(next);
      return;
    }
    batch(() => {
      workspaceSaving.set(true);
      workspaceError.set("");
    });
    try {
      const data = await runtimeApiFetchForEndpoint(endpointRef, "/workspace", { method: "PUT", body: { topic_id: topicID, workspace_dir: next } });
      rememberRecentWorkspaceDir(String(data?.workspace_dir || next || "").trim());
      applyWorkspacePayload(data, endpointRef);
      workspaceBrowserOpen.set(false);
      if (untracked(workspaceSidebarOpen)) await loadWorkspaceTree("", { force: true });
    } catch (error) {
      pushNotice({ type: "error", text: errorMessage(error, t("msg_save_failed")) });
    } finally {
      workspaceSaving.set(false);
    }
  }

  async function detachWorkspace() {
    const endpointRef = String(untracked(submitEndpointRef) || "").trim();
    const topicID = String(untracked(workspaceTopicID) || "").trim();
    if (!endpointRef || !topicID || untracked(workspaceDetachDisabled)) return;
    batch(() => {
      workspaceSaving.set(true);
      workspaceError.set("");
    });
    try {
      applyWorkspacePayload(await runtimeApiFetchForEndpoint(endpointRef, `/workspace?topic_id=${encodeURIComponent(topicID)}`, { method: "DELETE" }), endpointRef);
    } catch (error) {
      pushNotice({ type: "error", text: errorMessage(error, t("msg_save_failed")) });
    } finally {
      workspaceSaving.set(false);
    }
  }

  /* ---------- routes ---------- */

  function chatRoutePath(topicID = "") {
    const id = normalizeTopicID(topicID);
    return endpointRoutePath(endpointState.selectedRef, id ? `/chat/${encodeURIComponent(id)}` : "/chat");
  }

  function syncChatRoute(topicID: string, options: { replace?: boolean } = {}) {
    const next = chatRoutePath(topicID);
    const now = untracked(currentRoute);
    if (now.path === next) return Promise.resolve();
    const query = new URLSearchParams(now.query).toString();
    const target = query ? `${next}?${query}` : next;
    return options.replace ? router.replace(target) : router.push(target);
  }

  /* ---------- history ---------- */

  // The newest message is the last item, at the end of the list's content (its 20pt end padding
  // under it). Resolved natively, the scroll also follows the end while rows are measured.
  const stickToBottom = (animated = false) => historyList?.scrollToEnd({ animated });
  // How far the history is scrolled up from the newest message, in points (ChatHistoryList keeps it).
  let historyDistanceFromEnd = 0;
  let historyViewport = 0;

  function scrollHistoryToBottom(options: { force?: boolean; smooth?: boolean } = {}) {
    // The list follows the newest message while it is at it (ChatHistoryList); a send or a load
    // moves back to it. A send glides there when it is near (within 1.5 screens), and jumps from
    // farther, so the view never trails the conversation (the Vue console's scrollHistoryToBottom).
    if (!options.force && !options.smooth) return;
    const near = historyDistanceFromEnd <= Math.max(1, historyViewport) * 1.5;
    const animated = Boolean(options.smooth) && near;
    setTimeout(() => stickToBottom(animated), 0);
  }

  function replaceHistoryItems(items: HistoryItem[]) {
    chatHistoryItems.set(applyDefaultHistoryDurationVisibility(items));
  }

  async function copyHistoryItem(item: HistoryItem) {
    const text = String(item?.text || "");
    if (!text.trim()) return;
    try {
      await copyText(text);
      batch(() => {
        copiedHistoryItemID.set(String(item?.id || ""));
        copySeq.update((n) => n + 1);
      });
      clearTimeout(copiedHistoryTimer);
      copiedHistoryTimer = setTimeout(() => copiedHistoryItemID.set(""), 1200);
    } catch (error) {
      // Copy should not compete with task errors in the chat error surface.
      console.warn("chat: copy failed", errorMessage(error, ""));
    }
  }

  function clearPollTimers() {
    pollGeneration += 1;
    for (const tracked of trackedTasks.values()) clearTimeout(tracked.timer);
    trackedTasks.clear();
  }

  function closeTaskStream(taskID: string) {
    const key = String(taskID || "").trim();
    const active = key ? streamSockets.get(key) : undefined;
    if (!active) return;
    active.closing = true;
    try {
      active.socket.close();
    } catch {
      // Already closed.
    }
    streamSockets.delete(key);
  }

  function clearStreamSockets() {
    for (const taskID of [...streamSockets.keys()]) closeTaskStream(taskID);
  }

  function patchHistoryItem(id: string, patch: Record<string, unknown>) {
    const items = untracked(chatHistoryItems);
    const index = items.findIndex((item) => item.id === id);
    if (index < 0) return;
    const next = items.slice();
    next[index] = { ...next[index], ...patch };
    replaceHistoryItems(next);
  }

  function resolveAgentHistoryID(taskID: string, preferred = "") {
    const items = untracked(chatHistoryItems);
    if (preferred && items.some((item) => item.id === preferred)) return preferred;
    const key = String(taskID || "").trim();
    if (!key) return "";
    return String(items.find((item) => String(item?.role || "") === "agent" && String(item?.taskId || "").trim() === key)?.id || "").trim();
  }

  function patchAgentHistoryItem(taskID: string, historyID: string, patch: Record<string, unknown>) {
    const id = resolveAgentHistoryID(taskID, historyID);
    if (id) patchHistoryItem(id, patch);
    return id;
  }

  async function startTaskStream(taskID: string, historyID: string, endpointRef: string) {
    void refreshTopicActivity();
    const key = String(taskID || "").trim();
    if (!key || !supportsConsoleTaskStream(endpointRef)) return;
    const existing = streamSockets.get(key);
    // A socket dropped while the page was in the background is replaced.
    if (existing && existing.historyID === historyID && existing.endpointRef === endpointRef && existing.socket.readyState <= WebSocket.OPEN) return;
    closeTaskStream(key);
    let ticket = "";
    try {
      ticket = String((await createConsoleStreamTicket())?.ticket || "").trim();
    } catch {
      return;
    }
    if (!viewActive) return;
    const url = buildConsoleStreamURL(ticket, key, endpointRef);
    if (!url) return;
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch (error) {
      // Polling stays the fallback.
      console.warn("chat: task stream", errorMessage(error, ""));
      return;
    }
    const entry = { socket, historyID, endpointRef, closing: false };
    streamSockets.set(key, entry);
    socket.onmessage = (event) => {
      if (streamSockets.get(key) !== entry) return;
      const frame = safeJSON(typeof event.data === "string" ? event.data : "", null);
      if (!frame || typeof frame !== "object") return;
      replaceHistoryItems(applyUserReaction(untracked(chatHistoryItems), key, frame.user_reaction, endpointRef));
      const existingItem = untracked(chatHistoryItems).find((item) => item.id === historyID) || null;
      const nextPlan = normalizePlan(frame.plan || existingItem?.plan);
      const nextActivity = normalizeActivity(frame.activity || existingItem?.activity);
      const isPreview = frame.preview === true;
      const patch: Record<string, unknown> = {};
      if (Array.isArray(frame.attachments)) patch.attachments = frame.attachments;
      if (frame.plan && typeof frame.plan === "object") patch.plan = nextPlan;
      if (Array.isArray(frame.insights) && frame.insights.length > 0) patch.insights = normalizeInsights(frame.insights);
      if (Array.isArray(frame.questions) && frame.questions.length > 0) patch.questions = normalizeQuestions(frame.questions);
      if (Array.isArray(frame.elevations) && frame.elevations.length > 0) patch.elevations = normalizeElevations(frame.elevations);
      if (frame.activity && typeof frame.activity === "object") patch.activity = nextActivity;
      if (typeof frame.reasoning === "string" && frame.reasoning.trim() !== "") patch.reasoning = normalizeReasoning(frame.reasoning);
      if (frame.done && frame.user_reaction && !frame.text && !frame.error) {
        patch.text = "";
        patch.awaiting = false;
      } else if (frame.clear_text === true) {
        // The text shown so far came from a response that called tools, not the reply.
        patch.text = buildPollingHint(activeAgentName(), t, historyPendingSeed(existingItem, key));
        patch.awaiting = true;
      } else if (!isPreview && typeof frame.text === "string" && frame.text !== "") {
        patch.text = frame.text;
        patch.awaiting = false;
      } else if (!isPreview && typeof frame.error === "string" && frame.error !== "") {
        patch.text = frame.error;
        patch.awaiting = false;
      }
      if (typeof frame.status === "string" && frame.status !== "") patch.status = normalizeTaskStatus(frame.status);
      if (Object.keys(patch).length > 0) patchAgentHistoryItem(key, historyID, patch);
      // A question opened or closed: the topic list's mark follows now, not at its next poll.
      if (patch.questions && taskWaitingForAnswer(existingItem) !== taskWaitingForAnswer({ ...existingItem, ...patch })) void refreshTopicActivity();
      if (frame.done) closeTaskStream(key);
    };
    socket.onclose = () => {
      if (streamSockets.get(key) === entry) streamSockets.delete(key);
    };
    socket.onerror = () => {
      // Polling stays active as the fallback path.
    };
  }

  function staticHistoryItem(id: string, text: string): HistoryItem {
    return { id, role: "system", text, status: "", timeText: "", durationText: "", durationVisible: false, durationVisibleManual: false, taskId: "", rawJSON: "" };
  }

  function emptyHistoryItem() {
    if (untracked(consoleTopicsEnabled) && untracked(creatingTopic)) return staticHistoryItem("chat-new-topic", t("chat_new_topic_intro"));
    if (untracked(consoleTopicsEnabled) && normalizeTopicID(untracked(selectedTopicID))) return staticHistoryItem("chat-topic-empty", t("chat_topic_empty"));
    return staticHistoryItem("chat-intro", t("chat_intro"));
  }

  function topicActivityState(topic: any) {
    return topicActivity().get(normalizeTopicID(topic?.id))?.status || "";
  }

  function topicActivityLabel(topic: any) {
    const status = topicActivityState(topic);
    if (status === TOPIC_ACTIVITY_DONE) return t("chat_topic_status_done");
    if (status === TOPIC_ACTIVITY_WAITING) return t("chat_topic_status_waiting");
    return status === TOPIC_ACTIVITY_PENDING ? t("chat_topic_status_pending") : t("chat_topic_status_running");
  }

  function viewedTopicID() {
    return untracked(() =>
      activelyViewedTopic({
        topicID: normalizeTopicID(selectedTopicID()),
        viewActive,
        visibilityState: isVisible() ? "visible" : "hidden",
        focused: hasFocus(),
        showChatPane: showChatPane(),
        creatingTopic: creatingTopic(),
      }),
    );
  }

  function publishTopicActivity() {
    const next = topicActivityTracker.snapshot();
    const key = topicActivitySignature(next);
    if (key !== topicActivityKey) {
      topicActivityKey = key;
      topicActivity.set(next);
    }
  }

  function acknowledgeViewedTopic() {
    topicActivityTracker.acknowledge(viewedTopicID());
    publishTopicActivity();
  }

  async function refreshTopicActivity() {
    const endpointRef = String(untracked(submitEndpointRef) || "").trim();
    if (!viewActive || !untracked(consoleTopicsEnabled) || !endpointRef || !isVisible()) return;
    const request = topicActivityTracker.beginRequest();
    try {
      const data = await runtimeApiFetchForEndpoint(endpointRef, "/topics/activity");
      if (!viewActive || endpointRef !== String(untracked(submitEndpointRef) || "").trim()) return;
      topicActivityTracker.apply(request, data?.topics, viewedTopicID());
      publishTopicActivity();
    } catch {
      // Failed polls leave both the completion baseline and acknowledgements intact.
    }
  }

  const topicIsActive = (topic: any) =>
    !mobileMode() && normalizeTopicID(topic?.id) === normalizeTopicID(selectedTopicID()) && !creatingTopic();

  function pushHistoryItem(partial: Record<string, any>) {
    const item: HistoryItem = {
      id: newHistoryID(),
      role: String(partial?.role || "system"),
      text: String(partial?.text || ""),
      files: normalizeHistoryFileReferences(partial?.files),
      endpointRef: String(partial?.endpointRef || "").trim(),
      topicID: normalizeTopicID(partial?.topicID),
      plan: normalizePlan(partial?.plan),
      insights: normalizeInsights(partial?.insights),
      questions: normalizeQuestions(partial?.questions),
      elevations: normalizeElevations(partial?.elevations),
      activity: normalizeActivity(partial?.activity),
      reasoning: normalizeReasoning(partial?.reasoning),
      approval: partial?.approval || null,
      approvalBusy: partial?.approvalBusy === true,
      approvalError: String(partial?.approvalError || ""),
      status: String(partial?.status || ""),
      timeText: String(partial?.timeText || ""),
      durationText: String(partial?.durationText || ""),
      durationVisible: partial?.durationVisible === true,
      durationVisibleManual: partial?.durationVisibleManual === true,
      taskId: String(partial?.taskId || ""),
      rawJSON: String(partial?.rawJSON || ""),
      pendingSeed: String(partial?.pendingSeed || ""),
      presentation: String(partial?.presentation || ""),
      awaiting: partial?.awaiting === true,
    };
    replaceHistoryItems([...untracked(chatHistoryItems), item]);
    return item.id;
  }

  // A steered message's reply shows in replyHistoryID, below the message; the steered task's own
  // reply moves below it. When this device has no bubble for the task yet, one is added there.
  function placeSteeredAgentAfterReply(replyHistoryID: string, targetTaskID: string) {
    const targetID = String(targetTaskID || "").trim();
    const items = untracked(chatHistoryItems);
    const target = items.find((item) => item.id !== replyHistoryID && String(item?.role || "") === "agent" && String(item?.taskId || "").trim() === targetID);
    if (!target) {
      const seed = newHistoryID();
      const historyID = pushHistoryItem({
        role: "agent",
        text: buildPollingHint(untracked(activeAgentName), t, seed),
        awaiting: true,
        status: "running",
        timeText: "",
        pendingSeed: seed,
      });
      patchHistoryItem(historyID, { taskId: targetID, status: "running", rawJSON: "" });
      return { historyID, needsTracking: true };
    }
    const next = items.filter((item) => item.id !== target.id);
    const replyIndex = next.findIndex((item) => item.id === replyHistoryID);
    if (replyIndex < 0) next.push(target);
    else next.splice(replyIndex + 1, 0, target);
    replaceHistoryItems(next);
    return { historyID: target.id, needsTracking: false };
  }

  async function loadApprovalDetails(endpointRef: string, expectedVersion = historyLoadVersion) {
    const unrequested = untracked(chatHistoryItems)
      .map((item) => ({
        approvalRequestID: String(item?.approval?.approvalRequestID || "").trim(),
        status: String(item?.approval?.status || "pending").trim().toLowerCase(),
      }))
      .filter((item) => item.approvalRequestID !== "" && !approvalDetailAttempts.has(`${item.status}:${item.approvalRequestID}`));
    if (!endpointRef || unrequested.length === 0) return;
    for (const item of unrequested) approvalDetailAttempts.add(`${item.status}:${item.approvalRequestID}`);
    const requests: Promise<any[]>[] = [];
    if (unrequested.some((item) => item.status === "pending")) {
      requests.push(
        loadResource(resourceKey("chat", "approval-details", endpointRef, expectedVersion), () =>
          runtimeApiFetchForEndpoint(endpointRef, "/approvals?status=pending&limit=200"),
        )
          .then((payload: any) => (Array.isArray(payload?.items) ? payload.items : []))
          .catch(() => []),
      );
    }
    for (const item of unrequested) {
      if (item.status === "pending") continue;
      requests.push(
        runtimeApiFetchForEndpoint(endpointRef, `/approvals/${encodeURIComponent(item.approvalRequestID)}`)
          .then((payload: any) => [payload])
          .catch(() => []),
      );
    }
    const responseItems = (await Promise.all(requests)).flat();
    if (!viewActive || expectedVersion !== historyLoadVersion) return;
    const details = approvalDetailsByID({ items: responseItems });
    let changed = false;
    const next = untracked(chatHistoryItems).map((item) => {
      const detail: any = details.get(String(item?.approval?.approvalRequestID || "").trim());
      if (!detail) return item;
      changed = true;
      const existingStatus = String(item?.approval?.status || "").trim().toLowerCase();
      return {
        ...item,
        approval: {
          ...item.approval,
          ...detail,
          status: existingStatus === "denied" || existingStatus === "expired" ? existingStatus : detail.status || existingStatus || "pending",
          reasons: detail.reasons.map((reason: string) => chatApprovalReasonText(reason, t)),
        },
      };
    });
    if (changed) replaceHistoryItems(next);
  }

  // Polls a task again after `delay`, replacing any poll already waiting for it.
  function scheduleTaskPoll(taskID: string, historyID: string, endpointRef: string, delay = POLL_INTERVAL_MS) {
    const key = String(taskID || "").trim();
    if (!key) return;
    const tracked = trackedTasks.get(key) || { historyID, endpointRef, failures: 0 };
    clearTimeout(tracked.timer);
    const generation = pollGeneration;
    tracked.historyID = historyID;
    tracked.endpointRef = endpointRef;
    tracked.timer = setTimeout(() => {
      if (generation === pollGeneration) void pollTask(key, historyID, endpointRef);
    }, delay);
    trackedTasks.set(key, tracked);
  }

  // Worth trying again: the network, or the server briefly unavailable.
  function transientRequestError(error: unknown) {
    const status = Number((error as { status?: number })?.status) || 0;
    return status === 0 || status === 408 || status === 429 || status >= 500;
  }

  // When the page is shown again, follow the running tasks again at once, and reload the history
  // for what another device added meanwhile.
  function resumeTrackedTasks() {
    if (!viewActive || !isVisible()) return;
    for (const [taskID, tracked] of trackedTasks) {
      tracked.failures = 0;
      void startTaskStream(taskID, tracked.historyID, tracked.endpointRef);
      scheduleTaskPoll(taskID, tracked.historyID, tracked.endpointRef, 0);
    }
    void refreshHistory();
  }

  async function pollTask(taskID: string, historyID: string, endpointRef: string) {
    const generation = pollGeneration;
    const key = String(taskID || "").trim();
    if (key && !trackedTasks.has(key)) trackedTasks.set(key, { historyID, endpointRef, failures: 0 });
    try {
      const detail = await runtimeApiFetchForEndpoint(endpointRef, `/tasks/${encodeURIComponent(taskID)}`);
      if (!viewActive) return;
      replaceHistoryItems(applyUserReaction(untracked(chatHistoryItems), key, detail?.user_reaction, endpointRef));
      const status = normalizeTaskStatus(detail?.status);
      const resolvedID = resolveAgentHistoryID(taskID, historyID);
      const existing = untracked(chatHistoryItems).find((item) => item.id === resolvedID) || null;
      const pendingSeed = historyPendingSeed(existing, taskID);
      const preservePendingText = !isTerminalStatus(status) && String(existing?.approval?.approvalRequestID || "").trim() === "";
      const polledApproval = taskApprovalState(detail);
      const nextApproval =
        polledApproval && polledApproval.approvalRequestID === String(existing?.approval?.approvalRequestID || "").trim()
          ? { ...existing!.approval, ...polledApproval }
          : polledApproval;
      patchAgentHistoryItem(taskID, historyID, {
        plan: taskPlan(detail) || normalizePlan(existing?.plan),
        insights: taskInsights(detail) || normalizeInsights(existing?.insights),
        questions: taskQuestions(detail) || normalizeQuestions(existing?.questions),
        elevations: taskElevations(detail) || normalizeElevations(existing?.elevations),
        activity: taskActivity(detail) || normalizeActivity(existing?.activity),
        reasoning: taskReasoning(detail) || normalizeReasoning(existing?.reasoning),
        attachments: Array.isArray(detail?.attachments) ? detail.attachments : [],
        topicID: normalizeTopicID(detail?.topic_id),
        approval: nextApproval,
        approvalBusy: false,
        approvalError: "",
        status,
        text: taskAgentText(detail, t, { agentName: untracked(activeAgentName), pendingSeed, pendingText: preservePendingText ? existing?.text : "" }),
        // Still the polling hint, unless the stream has already shown words.
        awaiting: taskAwaitingReply(detail) && existing?.awaiting !== false,
        // The run waits on the answer to its question (while the stream's questions are unknown).
        awaitingAnswer: detail?.awaiting_answer === true,
        timeText: formatChatHistoryTime(detail?.finished_at || detail?.started_at || detail?.created_at, currentLocale()),
        durationText: taskDurationLabel(detail),
        rawJSON: taskRawJSON(detail),
        pendingSeed,
      });
      if (nextApproval) void loadApprovalDetails(endpointRef);
      const tracked = trackedTasks.get(key);
      if (tracked) tracked.failures = 0;
      if (isTerminalStatus(status)) {
        trackedTasks.delete(key);
        closeTaskStream(taskID);
        void refreshTopicActivity();
        if (untracked(consoleTopicsEnabled)) void refreshWorkspaceState();
        // Another device may have steered messages into this task while it ran.
        void refreshHistory();
      }
      if (!isTerminalStatus(status) && generation === pollGeneration) scheduleTaskPoll(key, historyID, endpointRef);
    } catch (error) {
      if (generation !== pollGeneration || !viewActive) return;
      if (transientRequestError(error)) {
        // Keep the reply as it is and try again, waiting longer each time.
        const tracked = trackedTasks.get(key) || { historyID, endpointRef, failures: 0 };
        tracked.failures = (tracked.failures || 0) + 1;
        trackedTasks.set(key, tracked);
        scheduleTaskPoll(key, historyID, endpointRef, Math.min(POLL_INTERVAL_MS * 2 ** tracked.failures, POLL_RETRY_MAX_MS));
        return;
      }
      trackedTasks.delete(key);
      patchAgentHistoryItem(taskID, historyID, {
        status: "failed",
        approvalBusy: false,
        approvalError: "",
        text: errorMessage(error, t("msg_load_failed")),
        rawJSON: "",
      });
    }
  }

  /* ---------- topics ---------- */

  function resetTopicState() {
    batch(() => {
      topics.set([]);
      topicsLoading.set(false);
      topicsLoadingOlder.set(false);
      topicsNextCursor.set("");
      selectedTopicID.set("");
      applyComposerTopicLLMProfile("");
      creatingTopic.set(false);
      showSystemTopics.set(false);
      topicDeleteDialogOpen.set(false);
      topicDeleteTarget.set(null);
      topicDeleting.set(false);
      topicDeleteError.set("");
      topicsLoadError.set("");
      resetWorkspaceState();
    });
    syncMobileTopicView({ preferTopics: true });
  }

  async function loadTopics(options: { preferredTopicID?: string; preserveDraft?: boolean; preserveSelection?: boolean } = {}) {
    if (!untracked(consoleTopicsEnabled)) {
      resetTopicState();
      return true;
    }
    if (topicLayoutEndpoint !== untracked(submitEndpointRef)) void loadTopicLayout();
    const preferredTopicID = normalizeTopicID(options.preferredTopicID);
    const preserveDraft = Boolean(options.preserveDraft);
    const preserveSelection = Boolean(options.preserveSelection);
    const currentID = normalizeTopicID(untracked(selectedTopicID));
    const endpointRef = untracked(submitEndpointRef);
    const draftKey = composerFileDraftKey(untracked(composerDraftScope));
    topicsLoading.set(true);
    try {
      const data = await runtimeApiFetchForEndpoint(endpointRef, `/topics?limit=${encodeURIComponent(TOPIC_PAGE_LIMIT)}`);
      if (draftKey !== composerFileDraftKey(untracked(composerDraftScope))) return false;
      const items = Array.isArray(data?.items) ? [...data.items] : [];
      const targetTopicID = preferredTopicID || currentID;
      if (targetTopicID && !items.some((topic) => normalizeTopicID(topic?.id) === targetTopicID)) {
        try {
          const target = await runtimeApiFetchForEndpoint(endpointRef, `/topics/${encodeURIComponent(targetTopicID)}`);
          if (normalizeTopicID(target?.id) === targetTopicID) items.push(target);
        } catch (error) {
          if ((error as { status?: number })?.status !== 404) throw error;
        }
      }
      if (draftKey !== composerFileDraftKey(untracked(composerDraftScope))) return false;
      items.sort(compareTopicsNewestFirst);
      batch(() => {
        topics.set(items);
        topicsNextCursor.set(String(data?.next_cursor || "").trim());
        topicsLoadError.set("");
      });
      if (preferredTopicID && items.some((topic) => normalizeTopicID(topic?.id) === preferredTopicID)) {
        batch(() => {
          selectedTopicID.set(preferredTopicID);
          creatingTopic.set(false);
        });
        rememberTopicSelection(endpointRef, preferredTopicID);
        syncMobileTopicView({ preferChat: true });
        return true;
      }
      if (preserveDraft && untracked(creatingTopic)) {
        syncMobileTopicView({ preferChat: true });
        return true;
      }
      if (currentID && items.some((topic) => normalizeTopicID(topic?.id) === currentID)) {
        rememberTopicSelection(endpointRef, currentID);
        creatingTopic.set(false);
        syncMobileTopicView({ preferChat: true });
        return true;
      }
      if (currentID === AWARENESS_TOPIC_ID && untracked(showSystemTopics)) {
        creatingTopic.set(false);
        syncMobileTopicView({ preferChat: true });
        return true;
      }
      // A topic selected from the address before the list came, which the agent does not have.
      if (preferredTopicID && currentID === preferredTopicID) {
        batch(() => {
          selectedTopicID.set("");
          creatingTopic.set(false);
        });
        syncMobileTopicView({ preferTopics: true });
        return true;
      }
      if (!preserveSelection) {
        batch(() => {
          selectedTopicID.set("");
          creatingTopic.set(false);
        });
        syncMobileTopicView({ preferTopics: true });
      }
      return true;
    } catch (error) {
      if (draftKey !== composerFileDraftKey(untracked(composerDraftScope))) return false;
      // The topics already listed stay; the chat view says the list failed and offers a Refresh.
      console.warn("chat: topics", errorMessage(error, ""));
      topicsLoadError.set(errorMessage(error, t("msg_load_failed")));
      if (!preserveSelection) {
        batch(() => {
          selectedTopicID.set("");
          creatingTopic.set(false);
        });
        syncMobileTopicView({ preferTopics: true });
      }
      return false;
    } finally {
      topicsLoading.set(false);
    }
  }

  async function loadOlderTopics() {
    const cursor = String(untracked(topicsNextCursor) || "").trim();
    if (!cursor || untracked(topicsLoading) || untracked(topicsLoadingOlder) || !untracked(consoleTopicsEnabled)) return;
    topicsLoadingOlder.set(true);
    try {
      const data = await runtimeApiFetchForEndpoint(
        untracked(submitEndpointRef),
        `/topics?limit=${encodeURIComponent(TOPIC_PAGE_LIMIT)}&cursor=${encodeURIComponent(cursor)}`,
      );
      const known = new Set(untracked(topics).map((topic) => normalizeTopicID(topic?.id)).filter(Boolean));
      const older = (Array.isArray(data?.items) ? data.items : []).filter((topic: any) => {
        const id = normalizeTopicID(topic?.id);
        if (!id || known.has(id)) return false;
        known.add(id);
        return true;
      });
      const items = [...untracked(topics), ...older];
      items.sort(compareTopicsNewestFirst);
      batch(() => {
        topics.set(items);
        topicsNextCursor.set(String(data?.next_cursor || "").trim());
      });
    } catch (error) {
      err.set(errorMessage(error, t("msg_load_failed")));
    } finally {
      topicsLoadingOlder.set(false);
    }
  }

  const currentHistoryScope = () => {
    if (!consoleTopicsEnabled()) return String(submitEndpointRef() || "");
    const topic = creatingTopic() ? "\u0001new" : normalizeTopicID(selectedTopicID());
    return `${submitEndpointRef() || ""}\u0000${topic}`;
  };
  const historyScope = () => untracked(currentHistoryScope);
  // While another topic's history loads, the list shows a placeholder thread instead of the old
  // messages; a reload of the same topic keeps them.
  const historySwitching = () => historyLoading() && historyItemsScope() !== currentHistoryScope();

  function historyPath(cursor = "") {
    let path = `/tasks?limit=${CHAT_HISTORY_LIMIT}`;
    if (cursor) path += `&cursor=${encodeURIComponent(cursor)}`;
    if (untracked(consoleTopicsEnabled)) {
      const topicID = normalizeTopicID(untracked(selectedTopicID));
      if (untracked(creatingTopic) || !topicID) return "";
      path = cursor
        ? `${path}&topic_id=${encodeURIComponent(topicID)}`
        : `/tasks?limit=${CHAT_HISTORY_LIMIT}&topic_id=${encodeURIComponent(topicID)}`;
    }
    return path;
  }

  function followRunningTasks(endpointRef: string, onlyNew: boolean) {
    for (const item of untracked(chatHistoryItems)) {
      const taskID = String(item?.taskId || "").trim();
      if (item.role !== "agent" || !taskID || isTerminalStatus(item.status)) continue;
      if (onlyNew && trackedTasks.has(taskID)) continue;
      void startTaskStream(taskID, item.id, endpointRef);
      scheduleTaskPoll(taskID, item.id, endpointRef, onlyNew ? 0 : POLL_INTERVAL_MS);
    }
  }

  async function loadHistory(options: { preserveCurrent?: boolean; keepError?: boolean } = {}) {
    const scope = historyScope();
    clearPollTimers();
    clearStreamSockets();
    if (!options.keepError) err.set("");
    const version = ++historyLoadVersion;
    approvalDetailAttempts.clear();
    batch(() => {
      historyLoadingOlder.set(false);
      historyNextCursor.set("");
    });
    const endpointRef = untracked(submitEndpointRef);
    if (!endpointRef) {
      applyComposerTopicLLMProfile("");
      batch(() => {
        replaceHistoryItems([]);
        historyItemsScope.set(scope);
        historyLoading.set(false);
        historyLoadError.set(null);
      });
      return true;
    }
    historyLoading.set(true);
    try {
      if (untracked(consoleTopicsEnabled) && (untracked(creatingTopic) || !normalizeTopicID(untracked(selectedTopicID)))) {
        applyComposerTopicLLMProfile("");
        batch(() => {
          replaceHistoryItems([]);
          historyLoadError.set(null);
        });
        return true;
      }
      const path = historyPath();
      const data = await loadResource(resourceKey("chat", "history", endpointRef, path), () => runtimeApiFetchForEndpoint(endpointRef, path));
      if (!viewActive || version !== historyLoadVersion) return true;
      const tasks = Array.isArray(data?.items) ? data.items : [];
      historyNextCursor.set(String(data?.next_cursor || "").trim());
      if (untracked(consoleTopicsEnabled)) applyComposerTopicLLMProfile(lastUsedChatLLMProfile(tasks));
      const current = untracked(chatHistoryItems);
      const next = keepHistoryItemIDs(
        current,
        keepLiveTaskState(current, taskListHistoryItems(tasks, t, { agentName: untracked(activeAgentName), endpointRef, locale: currentLocale() })),
      );
      batch(() => {
        replaceHistoryItems(next.length > 0 ? next : [emptyHistoryItem()]);
        historyLoadError.set(null);
      });
      scrollHistoryToBottom({ force: true });
      void loadApprovalDetails(endpointRef, version);
      followRunningTasks(endpointRef, false);
      return true;
    } catch (error) {
      if (viewActive && version === historyLoadVersion) {
        // Another conversation's messages go; this one's, already on screen, stay (a reload that
        // failed), and the chat view says it failed with a Refresh (ChatLoadError).
        console.warn("chat: history", errorMessage(error, ""));
        batch(() => {
          if (!options.preserveCurrent && untracked(historyItemsScope) !== scope) replaceHistoryItems([]);
          historyLoadError.set({ scope, message: errorMessage(error, t("msg_load_failed")) });
        });
      }
      return false;
    } finally {
      if (viewActive && version === historyLoadVersion) {
        batch(() => {
          historyItemsScope.set(scope);
          historyLoading.set(false);
        });
      }
    }
  }

  // Reloads the topic's latest tasks in place, for what another device added meanwhile. Nothing is
  // cleared while it loads, and older loaded pages stay.
  async function refreshHistory() {
    if (!viewActive || untracked(sending) || untracked(historyLoading) || untracked(historyLoadingOlder)) return;
    const endpointRef = untracked(submitEndpointRef);
    if (!endpointRef) return;
    const path = historyPath();
    if (!path) return;
    const scope = historyScope();
    const version = historyLoadVersion;
    let data: any;
    try {
      data = await loadResource(resourceKey("chat", "history", endpointRef, path), () => runtimeApiFetchForEndpoint(endpointRef, path));
    } catch {
      // The tasks being followed keep their own polling; the next refresh tries again.
      return;
    }
    if (!viewActive || untracked(sending) || untracked(historyLoadingOlder) || version !== historyLoadVersion || scope !== historyScope()) return;
    const tasks = Array.isArray(data?.items) ? data.items : [];
    if (tasks.length === 0) return;
    const current = untracked(chatHistoryItems);
    const fresh = keepHistoryItemIDs(
      current,
      keepLiveTaskState(current, taskListHistoryItems(tasks, t, { agentName: untracked(activeAgentName), endpointRef, locale: currentLocale() })),
    );
    const merged = mergeRefreshedHistoryItems(current, fresh);
    if (!merged.overlap) historyNextCursor.set(String(data?.next_cursor || "").trim());
    replaceHistoryItems(merged.items);
    void loadApprovalDetails(endpointRef, version);
    followRunningTasks(endpointRef, true);
  }

  async function loadOlderHistory() {
    const cursor = String(untracked(historyNextCursor) || "").trim();
    const endpointRef = String(untracked(submitEndpointRef) || "").trim();
    if (!cursor || !endpointRef || untracked(historyLoading) || untracked(historyLoadingOlder)) return;
    const version = historyLoadVersion;
    const path = historyPath(cursor);
    if (!path) return;
    batch(() => {
      historyLoadingOlder.set(true);
      err.set("");
    });
    try {
      const data = await runtimeApiFetchForEndpoint(endpointRef, path);
      if (!viewActive || version !== historyLoadVersion) return;
      const older = taskListHistoryItems(Array.isArray(data?.items) ? data.items : [], t, {
        agentName: untracked(activeAgentName),
        endpointRef,
        locale: currentLocale(),
      });
      // The list keeps the messages on screen in place as older ones arrive above them.
      batch(() => {
        historyNextCursor.set(String(data?.next_cursor || "").trim());
        replaceHistoryItems(placeSteeredAgentsAfterUsers([...older, ...untracked(chatHistoryItems)]));
      });
      void loadApprovalDetails(endpointRef, version);
    } catch (error) {
      if (viewActive && version === historyLoadVersion) err.set(errorMessage(error, t("msg_load_failed")));
    } finally {
      if (version === historyLoadVersion) historyLoadingOlder.set(false);
    }
  }

  async function refreshChatData(options: { preferredTopicID?: string; preserveSelection?: boolean; preserveDraft?: boolean } = {}) {
    let topicsLoaded = true;
    const preferred = normalizeTopicID(options.preferredTopicID);
    if (untracked(consoleTopicsEnabled) && preferred && normalizeTopicID(untracked(selectedTopicID)) === preferred) {
      // The address's topic is already selected: its conversation loads beside the topic list,
      // and again only if the list shows the topic is not there.
      const early = loadHistory();
      topicsLoaded = await loadTopics(options);
      await early;
      if (normalizeTopicID(untracked(selectedTopicID)) !== preferred) await loadHistory({ keepError: !topicsLoaded });
      return;
    }
    if (untracked(consoleTopicsEnabled)) topicsLoaded = await loadTopics(options);
    else resetTopicState();
    // The Vue page cleared a failed topic load's error here at once; it stays until the next load.
    await loadHistory({ keepError: !topicsLoaded });
  }

  /* ---------- a failed load, and its Refresh ---------- */

  // What could not be loaded for the conversation on screen: its history, else the topic list.
  const chatLoadErrorKind = (): "" | "history" | "topics" => {
    const history = historyLoadError();
    if (history && history.scope === currentHistoryScope()) return "history";
    return consoleTopicsEnabled() && topicsLoadError() ? "topics" : "";
  };
  const chatLoadErrorMessage = () => {
    const kind = chatLoadErrorKind();
    if (kind === "history") return historyLoadError()?.message || "";
    return kind === "topics" ? topicsLoadError() : "";
  };
  const chatLoadErrorTitle = () => (chatLoadErrorKind() === "topics" ? t("chat_topics_load_failed") : t("chat_history_load_failed"));
  // Nothing of the conversation to show: the error panel takes its place. With messages on screen
  // (a reload failed, or a message sent since), they stay and a strip above the composer says so.
  const chatLoadErrorFull = () => chatLoadErrorKind() !== "" && chatHistoryItems().length === 0;
  // The phone's topic list (or a desktop's, while the conversation shows another failure) says
  // the list failed itself; otherwise the conversation's panel or strip does.
  const topicsLoadErrorInSidebar = () => topicsLoadError() !== "" && (mobileTopicSplitEnabled() || chatLoadErrorKind() !== "topics");
  const chatLoadRetrying = () => chatLoadRetryScope() === currentHistoryScope();
  // A load is under way (a Refresh, a topic switch, the first load): the Refresh waits for it.
  const chatLoadBusy = () => chatLoadRetrying() || topicsLoading() || historyLoading();

  // Refresh: the conversation on screen again, and the topic list too when that failed. One at a
  // time; what a load answers for a conversation no longer on screen is dropped (loadHistory's
  // version, loadTopics' draft scope).
  async function retryChatLoad() {
    if (!viewActive || untracked(chatLoadBusy)) return;
    const topicsFailed = untracked(consoleTopicsEnabled) && untracked(topicsLoadError) !== "";
    if (!topicsFailed && untracked(chatLoadErrorKind) === "") return;
    const seq = ++chatLoadRetrySeq;
    chatLoadRetryScope.set(historyScope());
    try {
      if (topicsFailed) {
        // As the first load: the selected topic stays (and opens), a new chat being written stays,
        // and with neither a phone goes to the topic list once it comes.
        const topicID = normalizeTopicID(untracked(selectedTopicID));
        await refreshChatData({ preferredTopicID: topicID, preserveSelection: Boolean(topicID), preserveDraft: true });
      } else {
        await loadHistory();
      }
    } finally {
      if (seq === chatLoadRetrySeq) chatLoadRetryScope.set(null);
    }
  }

  async function syncTopicFromRoute(options: { force?: boolean } = {}) {
    if (!untracked(consoleTopicsEnabled)) return;
    const topicID = untracked(routeTopicID);
    if (!topicID) {
      if (!options.force && !normalizeTopicID(untracked(selectedTopicID)) && !untracked(creatingTopic)) return;
      batch(() => {
        creatingTopic.set(false);
        selectedTopicID.set("");
        applyComposerTopicLLMProfile("");
      });
      syncMobileTopicView({ preferTopics: true });
      await loadHistory();
      return;
    }
    if (topicID === AWARENESS_TOPIC_ID) {
      batch(() => {
        showSystemTopics.set(true);
        creatingTopic.set(false);
        selectedTopicID.set(topicID);
        applyComposerTopicLLMProfile("");
      });
      syncMobileTopicView({ preferChat: true });
      await loadHistory();
      return;
    }
    if (!options.force && normalizeTopicID(untracked(selectedTopicID)) === topicID && !untracked(creatingTopic)) return;
    batch(() => {
      creatingTopic.set(false);
      selectedTopicID.set("");
      applyComposerTopicLLMProfile("");
    });
    await loadTopics({ preferredTopicID: topicID, preserveSelection: true });
    syncMobileTopicView(normalizeTopicID(untracked(selectedTopicID)) ? { preferChat: true } : { preferTopics: true });
    await loadHistory();
  }

  /* ---------- the raw JSON and the hidden topics ---------- */

  function openRawDialog(item: HistoryItem) {
    resetRawReveal();
    const json = String(item?.rawJSON || "").trim();
    batch(() => {
      rawDialogJSON.set(json);
      rawDialogOpen.set(Boolean(json));
    });
  }

  const closeRawDialog = () => rawDialogOpen.set(false);

  function resetRawReveal() {
    clearTimeout(rawRevealTimer);
    rawRevealItemID = "";
    rawRevealCount = 0;
  }

  // Pressing an answer's time shows or hides its duration; five presses in a row show its JSON.
  function clickHistoryTime(item: HistoryItem) {
    if (String(item?.role || "") !== "agent") return;
    const id = String(item?.id || "").trim();
    if (!id) return;
    if (String(item?.durationText || "").trim()) patchHistoryItem(id, { durationVisible: item?.durationVisible !== true, durationVisibleManual: true });
    if (!String(item?.rawJSON || "").trim()) return;
    if (rawRevealItemID !== id) {
      rawRevealItemID = id;
      rawRevealCount = 0;
    }
    rawRevealCount += 1;
    if (rawRevealCount >= 5) {
      openRawDialog(item);
      return;
    }
    clearTimeout(rawRevealTimer);
    rawRevealTimer = setTimeout(resetRawReveal, 1200);
  }

  function resetHeartbeatReveal() {
    clearTimeout(heartbeatRevealTimer);
    heartbeatRevealCount = 0;
  }

  // Five presses on the topic list's title show or hide the system topics.
  function clickTopicSidebarTitle() {
    heartbeatRevealCount += 1;
    if (heartbeatRevealCount >= 5) {
      showSystemTopics.update((shown) => !shown);
      resetHeartbeatReveal();
      return;
    }
    clearTimeout(heartbeatRevealTimer);
    heartbeatRevealTimer = setTimeout(resetHeartbeatReveal, 2000);
  }

  /* ---------- topic actions ---------- */

  function closeTopicDeleteDialog() {
    batch(() => {
      topicDeleteDialogOpen.set(false);
      topicDeleteTarget.set(null);
    });
  }

  async function regenerateTopicName() {
    if (untracked(topicRegenerateDisabled)) return;
    const endpointRef = untracked(submitEndpointRef);
    const topicID = untracked(selectedTopicID);
    const key = untracked(topicNameRequestKey);
    batch(() => {
      topicNameRequests.update((set) => new Set([...set, key]));
      topicNameFailure.set(null);
    });
    try {
      const updated = await runtimeApiFetchForEndpoint(endpointRef, `/topics/${encodeURIComponent(topicID)}/regenerate-title`, { method: "POST" });
      if (untracked(submitEndpointRef) !== endpointRef) return;
      topics.update((list) =>
        list.map((topic) =>
          topic.id !== topicID || Number(topic.title_revision || 0) > Number(updated?.title_revision || 0) ? topic : { ...topic, ...updated },
        ),
      );
    } catch (error) {
      topicNameFailure.set({
        key,
        message: errorMessage(error, t(isCronTopicID(topicID) ? "chat_topic_regenerate_icon_failed" : "chat_topic_regenerate_failed")),
      });
    } finally {
      topicNameRequests.update((set) => {
        const next = new Set(set);
        next.delete(key);
        return next;
      });
    }
  }

  function openTopicRename() {
    const topic = untracked(selectedTopic);
    if (untracked(topicRenameDisabled) || !topic) return;
    topicRename.start({ endpointRef: untracked(submitEndpointRef), topicID: untracked(workspaceTopicID), title: String(topic.title || "") });
  }

  function applyRenamedTopic(session: TopicRenameSession, updated: any) {
    if (untracked(submitEndpointRef) !== session.endpointRef || !updated) return;
    topics.update((list) =>
      list.map((topic) =>
        normalizeTopicID(topic.id) !== session.topicID || Number(topic.title_revision || 0) > Number(updated?.title_revision || 0)
          ? topic
          : { ...topic, ...updated },
      ),
    );
  }

  function confirmDeleteTopic() {
    const topic = untracked(selectedTopic);
    if (!untracked(topicDeleteAvailable) || !topic) return;
    batch(() => {
      topicDeleteTarget.set({ id: normalizeTopicID(topic.id), title: topicTitle(topic), created_at: topic.created_at, updated_at: topic.updated_at });
      topicDeleteDialogOpen.set(true);
    });
  }

  async function deleteSelectedTopic() {
    if (untracked(topicDeleting)) return;
    const endpointRef = String(untracked(submitEndpointRef) || "").trim();
    const topicID = normalizeTopicID(untracked(topicDeleteTarget)?.id || untracked(selectedTopicID));
    if (!endpointRef || !topicID || topicID === DEFAULT_TOPIC_ID || topicID === AWARENESS_TOPIC_ID) {
      closeTopicDeleteDialog();
      return;
    }
    batch(() => {
      topicDeleting.set(true);
      topicDeleteDialogOpen.set(false);
      topicDeleteError.set("");
      err.set("");
    });
    try {
      await runtimeApiFetchForEndpoint(endpointRef, `/topics/${encodeURIComponent(topicID)}`, { method: "DELETE" });
      clearChatDraft(endpointRef, topicID);
      if (normalizeTopicID(untracked(selectedTopicID)) === topicID) {
        batch(() => {
          selectedTopicID.set("");
          creatingTopic.set(false);
        });
        resetWorkspaceState();
        await syncChatRoute("", { replace: true });
      }
      await loadTopics();
      await loadHistory();
    } catch (error) {
      topicDeleteError.set(errorMessage(error, t("msg_delete_failed")));
    } finally {
      batch(() => {
        topicDeleting.set(false);
        topicDeleteTarget.set(null);
      });
    }
  }

  /* ---------- answers to the agent ---------- */

  // Answers a question a running task asked, with a choice or typed text; `done` tells the card
  // whether the answer was taken.
  async function answerHistoryQuestion(item: HistoryItem, answer: QuestionAnswer) {
    const taskID = String(item?.taskId || "").trim();
    const questionID = String(answer?.questionID || "").trim();
    if (!taskID || !questionID) {
      answer.done(false);
      return;
    }
    const body: Record<string, unknown> = { question_id: questionID };
    if (typeof answer.text === "string" && answer.text.trim()) body.text = answer.text.trim();
    else body.option = Number(answer.option);
    try {
      const result = await runtimeApiFetchForEndpoint(item?.endpointRef || untracked(submitEndpointRef), `/tasks/${encodeURIComponent(taskID)}/answer`, {
        method: "POST",
        body,
      });
      answer.done(result?.answered === true);
    } catch (error) {
      answer.done(false, errorMessage(error, t("msg_load_failed")));
    }
  }

  // Answers an elevated command's request for the sudo password: a decline, or the password as typed.
  async function answerHistoryElevation(item: HistoryItem, answer: ElevationAnswer) {
    const taskID = String(item?.taskId || "").trim();
    const elevationID = String(answer?.elevationID || "").trim();
    if (!taskID || !elevationID || (answer.decline !== true && typeof answer.password !== "string")) {
      answer.done(false);
      return;
    }
    const body: Record<string, unknown> = { elevation_id: elevationID, client: isDesktopRuntime() ? "desktop" : "web" };
    if (answer.decline === true) body.decline = true;
    else body.password = answer.password;
    try {
      const result = await runtimeApiFetchForEndpoint(item?.endpointRef || untracked(submitEndpointRef), `/tasks/${encodeURIComponent(taskID)}/elevation`, {
        method: "POST",
        body,
      });
      answer.done(result?.accepted === true);
    } catch (error) {
      answer.done(false, errorMessage(error, t("msg_load_failed")));
    }
  }

  async function decideHistoryApproval(item: HistoryItem, decision: "approve" | "deny") {
    const approvalRequestID = String(item?.approval?.approvalRequestID || "").trim();
    const taskID = String(item?.taskId || "").trim();
    const itemID = String(item?.id || "").trim();
    if (!approvalRequestID || !taskID || !itemID) return;
    const endpointRef = untracked(submitEndpointRef);
    patchHistoryItem(itemID, { approvalBusy: true, approvalError: "" });
    try {
      const result = await runtimeApiFetchForEndpoint(endpointRef, `/approvals/${encodeURIComponent(approvalRequestID)}/${decision}`, {
        method: "POST",
        body: { actor: "console:user" },
      });
      const decisionError = String(result?.error || "").trim();
      if (decision === "approve") {
        if (result?.resumed === false && decisionError) {
          patchHistoryItem(itemID, { approval: null, approvalBusy: false, approvalError: "", status: "failed", text: decisionError });
          await pollTask(taskID, itemID, endpointRef);
          return;
        }
        patchHistoryItem(itemID, {
          approval: null,
          approvalBusy: false,
          approvalError: "",
          status: "queued",
          text: buildPollingHint(untracked(activeAgentName), t, historyPendingSeed(item, taskID)),
          awaiting: true,
        });
      } else {
        patchHistoryItem(itemID, {
          approval: { ...item.approval, message: t("chat_approval_denied"), status: "denied" },
          approvalBusy: false,
          approvalError: "",
          status: "canceled",
          text: t("chat_approval_denied"),
        });
      }
      await pollTask(taskID, itemID, endpointRef);
    } catch (error) {
      patchHistoryItem(itemID, { approvalBusy: false, approvalError: errorMessage(error, t("msg_load_failed")) });
    }
  }

  /* ---------- selection, send, stop ---------- */

  function selectTopic(topicID: string) {
    const id = normalizeTopicID(topicID);
    if (!id) return;
    batch(() => {
      topicDeleteError.set("");
      topicDeleteDialogOpen.set(false);
      topicDeleteTarget.set(null);
      creatingTopic.set(false);
      pendingWorkspaceDir.set("");
      workspaceBrowserPendingMode.set(false);
      selectedTopicID.set(id);
      applyComposerTopicLLMProfile("");
    });
    rememberTopicSelection(untracked(submitEndpointRef), id);
    syncMobileTopicView({ preferChat: true });
    void loadHistory().finally(focusComposerOnDesktop);
    void syncChatRoute(id);
  }

  function startNewTopic() {
    batch(() => {
      creatingTopic.set(true);
      selectedTopicID.set("");
      applyComposerTopicLLMProfile("");
      err.set("");
      topicDeleteError.set("");
      pendingWorkspaceDir.set("");
      workspaceBrowserPendingMode.set(false);
      topicDeleteDialogOpen.set(false);
      topicDeleteTarget.set(null);
    });
    resetHeartbeatReveal();
    syncMobileTopicView({ preferChat: true });
    void loadHistory();
    focusComposer();
    void syncChatRoute("", { replace: true });
  }

  async function stopActiveTask() {
    const taskID = String(untracked(activeTaskItem)?.taskId || "").trim();
    if (!taskID || untracked(sending)) return;
    const endpointRef = String(untracked(submitEndpointRef) || "").trim();
    if (!endpointRef) {
      err.set(untracked(submitBlockedMessage) || t("msg_select_endpoint"));
      return;
    }
    batch(() => {
      sending.set(true);
      err.set("");
    });
    try {
      await runtimeApiFetchForEndpoint(endpointRef, `/tasks/${encodeURIComponent(taskID)}/stop`, { method: "POST" });
    } catch (error) {
      err.set(errorMessage(error, t("msg_load_failed")));
    } finally {
      sending.set(false);
      focusComposerOnDesktop();
    }
  }

  // `keyboardDismissed`: Send lowered a touch keyboard, so the field is not focused again after the
  // send, even where the window is wide enough for the desktop layout.
  async function submitTask(options: { keyboardDismissed?: boolean } = {}) {
    const draftText = String(untracked(taskInput) || "");
    const task = draftText.trim();
    if (!task || untracked(sending) || untracked(composerFilesPending)) return;
    const submittedScope = untracked(composerDraftScope);
    const usesTopics = untracked(consoleTopicsEnabled);
    let accepted = false;
    let acceptedTopicID = "";
    const endpointRef = untracked(submitEndpointRef);
    if (!endpointRef) {
      err.set(untracked(submitBlockedMessage) || t("msg_select_endpoint"));
      return;
    }
    const llmProfile = String(untracked(composerLLMProfile) || "").trim();
    const pendingWorkspace = String(untracked(pendingWorkspaceDir) || "").trim();
    const { requestBody, submittedFiles, fileReferences } = buildComposerSubmission({
      task,
      llmProfile,
      files: untracked(composerFiles),
      topicID: usesTopics && !untracked(creatingTopic) ? normalizeTopicID(untracked(selectedTopicID)) : "",
      workspaceDir: usesTopics ? pendingWorkspace : "",
    }) as { requestBody: Record<string, any>; submittedFiles: any[]; fileReferences: any[] };
    // Marks a task the chat watches, so the agent may ask its questions here.
    requestBody.trigger = CONSOLE_CHAT_TRIGGER;

    batch(() => {
      sending.set(true);
      err.set("");
      suppressDraftPersistence = true;
      taskInput.set("");
      if (usesTopics && !normalizeTopicID(untracked(selectedTopicID))) creatingTopic.set(true);
    });

    const userHistoryID = pushHistoryItem({
      role: "user",
      text: task,
      files: submittedFiles,
      endpointRef,
      topicID: requestBody.topic_id,
      timeText: formatChatHistoryTime(new Date().toISOString(), currentLocale()),
    });
    const pendingSeed = newHistoryID();
    const agentHistoryID = pushHistoryItem({
      role: "agent",
      text: buildPollingHint(untracked(activeAgentName), t, pendingSeed),
      awaiting: true,
      status: "queued",
      timeText: "",
      pendingSeed,
      presentation: isContextCompactCommand(task) ? "context-compact" : "",
    });
    scrollHistoryToBottom({ smooth: true });

    try {
      const submitted = await runtimeApiFetchForEndpoint(endpointRef, "/tasks", { method: "POST", body: requestBody });
      const taskID = String(submitted?.id || "").trim();
      const status = normalizeTaskStatus(submitted?.status);
      const steerTargetTaskID = String(submitted?.steer_target_task_id || "").trim();
      if (!taskID) throw new Error(t("chat_missing_task_id"));
      const submittedTopicID = normalizeTopicID(submitted?.topic_id || requestBody.topic_id);
      if (usesTopics && !submittedTopicID) throw new Error(t("chat_missing_topic_id"));
      accepted = true;
      acceptedTopicID = submittedTopicID;
      clearChatDraft(submittedScope.endpointRef, submittedScope.topicID);
      clearComposerFileDraft(submittedScope);
      // A response belongs to the composer that submitted it, even after navigation.
      if (composerFileDraftKey(submittedScope) !== composerFileDraftKey(untracked(composerDraftScope))) return;
      if (!steerTargetTaskID) applyComposerTopicLLMProfile(llmProfile);
      patchHistoryItem(userHistoryID, { taskId: taskID, files: normalizeHistoryFileReferences(fileReferences), endpointRef, topicID: submittedTopicID });
      let targetHistoryID = "";
      let targetNeedsTracking = false;
      const existing = untracked(chatHistoryItems).find((item) => item.id === agentHistoryID) || null;
      // A steered message's own task holds the reply to it, written while the steered task runs.
      patchHistoryItem(agentHistoryID, { taskId: taskID, status, pendingSeed: historyPendingSeed(existing, pendingSeed), rawJSON: "" });
      if (steerTargetTaskID) {
        const placement = placeSteeredAgentAfterReply(agentHistoryID, steerTargetTaskID);
        targetHistoryID = placement.historyID;
        targetNeedsTracking = placement.needsTracking;
        if (targetNeedsTracking) void startTaskStream(steerTargetTaskID, targetHistoryID, endpointRef);
      } else {
        void startTaskStream(taskID, agentHistoryID, endpointRef);
      }
      if (usesTopics) {
        const topicID = submittedTopicID;
        batch(() => {
          creatingTopic.set(false);
          selectedTopicID.set(topicID);
          // The thread on screen is this topic's: its first exchange.
          historyItemsScope.set(historyScope());
        });
        if (String(requestBody.workspace_dir || "").trim()) {
          pendingWorkspaceDir.set("");
          applyWorkspacePayload({ topic_id: topicID, workspace_dir: requestBody.workspace_dir, source: "attachment" });
          rememberRecentWorkspaceDir(requestBody.workspace_dir);
        }
        rememberTopicSelection(endpointRef, topicID);
        await loadTopics({ preferredTopicID: topicID, preserveSelection: true });
        if (endpointRef !== untracked(submitEndpointRef) || normalizeTopicID(untracked(selectedTopicID)) !== topicID) return;
        await syncChatRoute(topicID, { replace: true });
      }
      if (steerTargetTaskID && targetNeedsTracking) void pollTask(steerTargetTaskID, targetHistoryID, endpointRef);
      await pollTask(taskID, agentHistoryID, endpointRef);
    } catch (error) {
      const message = errorMessage(error, t("msg_load_failed"));
      if (!accepted) {
        rememberChatDraft(submittedScope.endpointRef, submittedScope.topicID, draftText);
        if (composerFileDraftKey(submittedScope) !== composerFileDraftKey(untracked(composerDraftScope))) return;
        taskInput.set(draftText);
      } else if (endpointRef !== untracked(submitEndpointRef) || (usesTopics && normalizeTopicID(untracked(selectedTopicID)) !== acceptedTopicID)) {
        return;
      }
      err.set(message);
      patchHistoryItem(agentHistoryID, { status: "failed", text: message, rawJSON: "" });
    } finally {
      suppressDraftPersistence = false;
      sending.set(false);
      if (!options.keyboardDismissed) focusComposerOnDesktop();
    }
  }

  /* ---------- voice ---------- */

  const voice = createVoiceInput({
    // In a browser, the desktop app and the Android app the host records and the agent transcribes
    // (components/chat/voice.ts).
    endpointRef: () => submitEndpointRef(),
    canTranscribe: async (endpointRef) => (await runtimeApiFetchForEndpoint(endpointRef, "/voice/transcribe"))?.available === true,
    transcribe: (endpointRef, file) => transcribeRecording(endpointRef, file),
    release: (file) => releaseFile(file),
    // The draft the words go into: switching topic or agent swaps it, and drops what is under way.
    scope: () => {
      const scope = composerDraftScope();
      return `${scope.endpointRef}\n${scope.topicID}`;
    },
    onText(text) {
      if (composer) {
        composer.insertText(text);
        return;
      }
      const current = String(untracked(taskInput) || "").replace(/\s+$/, "");
      setTaskInput(current ? `${current} ${text}` : text);
    },
    onError(error) {
      pushNotice({ type: "error", text: t(voiceErrorKey(error), { message: String(error.message || "").trim() }) });
    },
  });

  /* ---------- the rows' shared state ---------- */

  const previews = createArtifactPreviews();
  const receivedFiles = createReceivedFiles();
  const rowContext: ChatRowContext = {
    endpointRef: () => submitEndpointRef(),
    topicID: () => selectedTopicID(),
    copiedItemID: () => copiedHistoryItemID(),
    copySeq: () => copySeq(),
    detail: () => activityDetail(),
    focusReturn: () => detailFocusReturn.key(),
    autoPreviewItemID: () => autoPreviewHistoryID(),
    previews,
    receivedFiles,
    questions: keyedState<QuestionState>(),
    elevations: keyedState<ElevationState>(),
    folds: keyedState<boolean>(),
    onCopy: (item) => void copyHistoryItem(item),
    onPreviewFile: previewComposerFile,
    onOpenDetail: openActivityDetail,
    onTimeClick: clickHistoryTime,
    onApprove: (item) => void decideHistoryApproval(item, "approve"),
    onDeny: (item) => void decideHistoryApproval(item, "deny"),
    onQuestionAnswer: (item, answer) => void answerHistoryQuestion(item, answer),
    onElevationAnswer: (item, answer) => void answerHistoryElevation(item, answer),
  };

  /* ---------- lifetimes ---------- */

  // A TODO item's topic gets its runs while nobody chats in it, so the poll also brings the time of
  // its latest run, which orders the TODO list.
  useTopicMetadata(topics, () => submitEndpointRef(), ((topic: any) => isCronTopicID(topic?.id)) as never);

  function onPageVisibilityChange() {
    acknowledgeViewedTopic();
    if (isVisible()) {
      resumeTrackedTasks();
      void refreshTopicActivity();
    }
  }
  cleanup(onVisibilityChange(onPageVisibilityChange));

  // Heartbeat and TODO runs start on their own, so the awareness topic and a TODO item's topic look
  // for new ones while open.
  effect(() => {
    const open = (normalizeTopicID(selectedTopicID()) === AWARENESS_TOPIC_ID || selectedTopicIsCron()) && !creatingTopic();
    if (!open) return;
    const timer = setInterval(() => {
      if (isVisible()) void refreshHistory();
    }, AWARENESS_REFRESH_INTERVAL_MS);
    cleanup(() => clearInterval(timer));
  });

  // The topic list's activity marks follow tasks in every topic, not only the open one.
  effect(() => {
    const enabled = consoleTopicsEnabled();
    const endpointRef = String(submitEndpointRef() || "").trim();
    untracked(() => {
      topicActivityTracker.setEndpoint(enabled ? endpointRef : "");
      publishTopicActivity();
    });
    if (!enabled) return;
    untracked(() => void refreshTopicActivity());
    const timer = setInterval(() => void refreshTopicActivity(), TOPIC_ACTIVITY_REFRESH_INTERVAL_MS);
    cleanup(() => clearInterval(timer));
  });

  effect(() => {
    void selectedTopicID();
    void showChatPane();
    void creatingTopic();
    untracked(acknowledgeViewedTopic);
  });

  // Loading starts once the agent is known, and starts again for another agent.
  let loadedEndpointKey: string | null = null;
  effect(() => {
    const key = `${endpointState.selectedRef}\u0000${submitEndpointRef()}`;
    untracked(() => {
      const first = loadedEndpointKey === null;
      if (key === loadedEndpointKey) return;
      loadedEndpointKey = key;
      if (!first) {
        composerCommandsLoadSeq += 1;
        composerLLMProfilesLoadSeq += 1;
        composerSkillsLoadSeq += 1;
        batch(() => {
          composerCommands.set([]);
          composerCommandsLoading.set(false);
          composerDefaultLLMProfile.set(null);
          composerLLMProfiles.set([]);
          applyComposerTopicLLMProfile("");
          composerSkills.set([]);
          composerSkillsLoading.set(false);
          composerSkillsError.set("");
        });
        resetTopicState();
      }
      const topicID = routeTopicID();
      void refreshChatData({ preferredTopicID: topicID, preserveSelection: Boolean(topicID) }).finally(focusComposerOnDesktop);
      void loadComposerLLMProfiles();
    });
  });

  effect(() => {
    void submitEndpointRef();
    void workspaceTopicID();
    void consoleTopicsEnabled();
    untracked(() => void refreshWorkspaceState());
  });

  effect(() => {
    const open = workspaceSidebarOpen();
    untracked(() => {
      if (open && String(workspaceDir() || "").trim() && !hasOwnTreePath(workspaceTreeItems(), "")) void loadWorkspaceTree("", { force: true });
    });
  });

  // The detail panel belongs to the conversation it was opened in: another topic, a new chat,
  // another agent, or the phone going back to the topic list closes it (without moving the focus).
  let detailScope: string | undefined;
  effect(() => {
    const scope = `${currentHistoryScope()}\u0000${showChatPane() ? "chat" : "topics"}`;
    untracked(() => {
      if (detailScope !== undefined && detailScope !== scope) closeActivityDetail({ restoreFocus: false });
      detailScope = scope;
    });
  });

  let lastRouteTopic: string | undefined;
  effect(() => {
    const topicID = routeTopicID();
    untracked(() => {
      if (lastRouteTopic === undefined) {
        lastRouteTopic = topicID;
        return;
      }
      if (lastRouteTopic === topicID) return;
      lastRouteTopic = topicID;
      topicSidebarView.set(topicSidebarViewFor(topicID, topicSidebarView()) as SidebarView);
      void syncTopicFromRoute().finally(focusComposerOnDesktop);
    });
  });

  effect(() => {
    if (showChatPane()) untracked(focusComposerOnDesktop);
  });

  let previousScope: { endpointRef: string; topicID: string } | null = null;
  effect(() => {
    const scope = composerDraftScope();
    untracked(() => {
      if (previousScope?.endpointRef) persistComposerDraft(previousScope);
      previousScope = scope;
      restoreComposerDraft(scope);
      restoreComposerFileDraft(scope);
    });
  });

  cleanup(() => {
    viewActive = false;
    topicActivityTracker.beginRequest();
    closeComposerFilePreview();
    historyLoadVersion += 1;
    persistComposerDraft();
    clearPollTimers();
    clearStreamSockets();
    resetRawReveal();
    resetHeartbeatReveal();
    clearTimeout(copiedHistoryTimer);
    detailFocusReturn.dispose();
    previews.dispose();
    receivedFiles.dispose();
  });

  return {
    // state
    mobileMode,
    chatHistoryItems,
    historyLoadingOlder,
    historyNextCursor,
    historySwitching,
    topics,
    topicsLoading,
    topicsLoadingOlder,
    topicsNextCursor,
    selectedTopicID,
    creatingTopic,
    taskInput,
    sending,
    err,
    workspaceDir,
    workspaceSource,
    workspaceLoading,
    workspaceSaving,
    workspaceOpening,
    workspaceDownloading,
    workspaceError,
    workspaceSidebarOpen,
    rightPanel,
    rightPanelKey,
    activityDetail,
    activityDetailItem,
    activityDetailContext,
    activityDetailContextOf,
    mobileSheetDetail,
    mobileSheetDetailItem,
    pageDialogOpen,
    workspaceSidebarTabID,
    workspaceTreeLoading,
    workspaceTreeError,
    workspaceBrowserOpen,
    pendingWorkspaceDir,
    composerFiles,
    composerCommands,
    composerLLMProfile,
    composerSkills,
    composerSkillsLoading,
    composerSkillsError,
    filePreview,
    rawDialogOpen,
    rawDialogJSON,
    topicSidebarView,
    topicDeleteDialogOpen,
    topicDeleting,
    topicDeleteError,
    topicTagsError,
    voice,
    rowContext,
    // derived
    submitEndpointRef,
    consoleTopicsEnabled,
    chatReadonly,
    readonlyKickerLeft,
    readonlyReason,
    displayAgentName,
    composerUploading,
    composerStopMode,
    composerDisabled,
    sendDisabled,
    composerActionLabel,
    composerPlaceholder,
    composerAttachActive,
    composerAddDisabled,
    chatDisclaimer,
    composerLLMProfileItems,
    composerInputHistory,
    mobileTopicSplitEnabled,
    mobileBarTitle,
    mobileShowBack,
    showTopicSidebar,
    showChatPane,
    showChatPlaceholder,
    chatLoadErrorKind,
    chatLoadErrorMessage,
    chatLoadErrorTitle,
    chatLoadErrorFull,
    chatLoadBusy,
    topicsLoadError,
    topicsLoadErrorInSidebar,
    retryChatLoad,
    chatPlaceholderHint,
    deskTitle,
    hasSidebarTopics,
    agentTopics,
    cronTopics,
    cronRunning,
    cronToggleLabel,
    cronToggleTitle,
    topicRows,
    topicSearch,
    topicSearching,
    setTopicSearch,
    topicSearchRevealed,
    selectedTopicIsAgent,
    selectedTopicIsCron,
    workspaceTopicID,
    workspaceSidebarAvailable,
    desktopWorkspaceSidebarVisible,
    desktopActivityDetailVisible,
    mobileActivityDetailVisible,
    desktopRightPanelVisible,
    mobileWorkspaceSidebarVisible,
    workspaceSidebarToggleLabel,
    workspacePanelTabs,
    workspaceReady,
    workspaceHintText,
    workspaceAttachDisabled,
    workspaceDetachDisabled,
    workspaceDirDisplay,
    workspaceTreeRows,
    workspaceSelectedTreeEntry,
    workspaceBrowserInitialDir,
    workspaceBrowserConfirmDisabled,
    topicDeleteAvailable,
    topicDeleteDisabled,
    topicDeleteDialogText,
    topicRenameAvailable,
    topicRenameDisabled,
    topicRenameRegenerateDisabled,
    topicRename,
    topicRegenerateAvailable,
    topicRegenerateLabel,
    topicRegenerating,
    topicRegenerateError,
    topicRegenerateDisabled,
    topicTagsAvailable,
    topicTagsSaving,
    topicTagSaving,
    selectedTopicOrdinaryTags,
    selectedTopicPinned,
    knownTags,
    topicPropertyRows,
    topicContextProgress,
    // helpers for rows
    topicTitle,
    topicIcon,
    topicTimeLabel,
    topicActivityState,
    topicActivityLabel,
    topicIsActive,
    topicAgentContact,
    topicAgentAvatar,
    cronTopicModel,
    isCronTopicID,
    toggleTopicGroup,
    // actions
    setTaskInput,
    setComposerHandle: (handle: ComposerHandle) => {
      composer = handle;
    },
    setHistoryList: (list: ListRef) => {
      historyList = list;
    },
    setHistoryScroll: (distanceFromEnd: number, viewport: number) => {
      historyDistanceFromEnd = distanceFromEnd;
      historyViewport = viewport;
    },
    stickToBottom,
    setLLMProfile: (value: string) => composerLLMProfile.set(value),
    ensureComposerCommandsLoaded,
    ensureComposerSkillsLoaded,
    submitTask,
    stopActiveTask,
    selectTopic,
    startNewTopic,
    showTopicsView,
    mobileBack,
    setTopicSidebarView,
    clickTopicSidebarTitle,
    loadOlderTopics,
    loadOlderHistory,
    openComposerFilePicker,
    uploadComposerFileList,
    retryComposerFile,
    removeComposerFile,
    previewComposerFile,
    navigateComposerFilePreview,
    closeComposerFilePreview,
    openWorkspaceBrowser,
    closeWorkspaceBrowser,
    attachWorkspace,
    detachWorkspace,
    toggleWorkspaceSidebar,
    closeMobileWorkspaceSidebar,
    openActivityDetail,
    closeActivityDetail,
    onWorkspaceTabChange,
    selectWorkspaceTreeNode,
    addWorkspaceSelectionToComposer,
    openWorkspaceSelection,
    downloadWorkspaceSelection,
    regenerateTopicName,
    openTopicRename,
    confirmDeleteTopic,
    closeTopicDeleteDialog,
    deleteSelectedTopic,
    saveSelectedTopicTags,
    topicCanDrop,
    dropTopicOnGroup,
    setSelectedTopicPinned,
    openContextInspector,
    closeRawDialog,
  };
}

export type ChatController = ReturnType<typeof createChatController>;
