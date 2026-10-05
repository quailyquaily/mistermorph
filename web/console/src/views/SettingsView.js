import { computed, nextTick, onMounted, onUnmounted, provide, reactive, ref, watch } from "vue";
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute, useRouter } from "vue-router";
import { useToast } from "quail-ui";
import { captureUnsavedScopes, mergeConfigUpdates, restoreUnsavedScopes } from "../core/settings-save.js";
import "./SettingsView.css";

import AppPage from "../components/AppPage";
import MarkdownContent from "../components/MarkdownContent";
import { inferenceProviderLogo } from "../core/inference-provider-logos";
import SettingSelect from "../components/SettingSelect";
import EnvManagedField from "../components/EnvManagedField";
import SecretInput from "../components/SecretInput";
import AuthProfilesPanel from "../components/AuthProfilesPanel";
import CodexAuthDialog from "../components/CodexAuthDialog";
import ConfigSettingsPanel from "../components/ConfigSettingsPanel";
import ModelRoutesPanel from "../components/ModelRoutesPanel";
import ConsolePasswordPanel from "../components/ConsolePasswordPanel";
import ConsoleEndpointsPanel from "../components/ConsoleEndpointsPanel";
import XAIAuthDialog from "../components/XAIAuthDialog";
import ProAuthDialog from "../components/ProAuthDialog";
import ImageUploadField from "../components/ImageUploadField";
import LLMConfigForm from "../components/LLMConfigForm";
import MCPSettingsPanel from "../components/MCPSettingsPanel";
import AppMarkdownEditor from "../components/AppMarkdownEditor";
import SettingsCreditsPanel from "../components/SettingsCreditsPanel";
import SettingDialog from "../components/SettingDialog";
import SetupConnectionTestDialog from "../components/SetupConnectionTestDialog";
import SetupPickerDialog from "../components/SetupPickerDialog";
import RuntimePanel from "./RuntimeView";
import WeChatLoginPanel from "../components/WeChatLoginPanel";
import channelDiscordLogoURL from "../assets/images/channels/discord.svg";
import channelLarkLogoURL from "../assets/images/channels/lark.svg";
import channelLineLogoURL from "../assets/images/channels/line.svg";
import channelMixinLogoURL from "../assets/images/channels/mixin.svg";
import channelSlackLogoURL from "../assets/images/channels/slack.svg";
import channelWeChatLogoURL from "../assets/images/channels/wechat.svg";
import channelWhatsAppLogoURL from "../assets/images/channels/whatsapp.svg";
import channelTelegramLogoURL from "../assets/images/channels/telegram.svg";
import defaultAvatarMarkup from "../assets/images/app_logo_current.svg?raw";
import {
  currentLocale,
  apiFetch,
  authState,
  endpointApiFetch,
  endpointState,
  formatTime,
  loadEndpoints,
  localeState,
  runtimeApiDownloadForEndpoint,
  runtimeApiFetchForEndpoint,
  runtimeEndpointByRef,
  translate,
} from "../core/context";
import {
  hasLLMFieldValue,
  isLLMFieldEnvManaged,
  llmFieldEnvRawValue,
  llmFieldValue,
} from "../core/llm-env-managed";
import {
  canOpenExternalURLInDesktop,
  openExternalPlaceholder,
  openExternalURL,
} from "../core/external-links";
import useProAuthFlow from "../composables/useProAuthFlow";
import useXAIAuthFlow from "../composables/useXAIAuthFlow";
import {
  canCheckDesktopUpdate,
  canPickDesktopDirectory,
  checkDesktopUpdate,
  desktopRuntimeVersion,
} from "../core/desktop-runtime";
import { recordSnapshotBuild } from "../core/performance";
import {
  OPENAI_COMPATIBLE_API_BASE_OPTIONS,
  normalizeSetupProviderChoice,
  SETUP_PROVIDER_BEDROCK,
  SETUP_PROVIDER_CLOUDFLARE,
  SETUP_PROVIDER_MISTERMORPH_PRO,
  SETUP_PROVIDER_OPENAI_CODEX,
  SETUP_PROVIDER_XAI_OAUTH,
  SETUP_PROVIDER_OPTIONS,
  setupProviderRequiresAPIKey,
  setupProviderSupportsCustomAPIBase,
  setupOpenAICodexUsesAPIKey,
} from "../core/setup-contract";
import { invalidateConsoleSetupReadiness } from "../core/setup";
import { endpointRoutePath } from "../core/endpoint-routes";
import { openReentrantDialog } from "../core/reentrant-dialog";
import {
  AUTOMATION_CONFIG_GROUPS,
  CHANNEL_CONFIG_GROUPS,
  CHANNEL_TRIGGER_CONFIG_GROUPS,
  CONSOLE_DEPLOYMENT_CONFIG_GROUPS,
  DEFAULT_MODEL_ADVANCED_CONFIG_GROUPS,
  LLM_CONTEXT_CONFIG_GROUPS,
  LLM_SYSTEM_CONFIG_GROUPS,
  REMOTE_CONTROL_CONFIG_GROUPS,
  SECURITY_CONFIG_GROUPS,
  SYSTEM_ADVANCED_CONFIG_GROUPS,
  SYSTEM_CONFIG_GROUPS,
  TOOL_ADVANCED_CONFIG_GROUPS,
} from "../core/config-field-groups";
import {
  buildEmptyPersonaIdentityState,
  buildIdentityYAML,
  buildPersonaIdentitySnapshot,
  dispatchPersonaAvatarUpdated,
  dispatchPersonaIdentityUpdated,
  normalizeSoulDocument,
  parseIdentityProfile,
  PERSONA_AVATAR_ENDPOINT,
  PERSONA_AVATAR_MAX_SOURCE_BYTES,
  PERSONA_AVATAR_SIZE,
  PERSONA_AVATAR_SOURCE_TYPES,
  PERSONA_IDENTITY_ENDPOINT,
  PERSONA_SOUL_ENDPOINT,
} from "../core/persona-profile";
import { modelPickerItemsFromPayload } from "../core/setup-picker";

const TOOL_ITEMS = [
  { id: "read_file", titleKey: "settings_tool_read_file", noteKey: "settings_tool_note_read_file", toggle: false },
  { id: "write_file", titleKey: "settings_tool_write_file", noteKey: "settings_tool_note_write_file" },
  { id: "spawn", titleKey: "settings_tool_spawn", noteKey: "settings_tool_note_spawn" },
  { id: "coder", titleKey: "settings_tool_coder", noteKey: "settings_tool_note_coder" },
  { id: "contacts_send", titleKey: "settings_tool_contacts_send", noteKey: "settings_tool_note_contacts_send" },
  { id: "todo_update", titleKey: "settings_tool_todo_update", noteKey: "settings_tool_note_todo_update" },
  { id: "plan_create", titleKey: "settings_tool_plan_create", noteKey: "settings_tool_note_plan_create" },
  { id: "url_fetch", titleKey: "settings_tool_url_fetch", noteKey: "settings_tool_note_url_fetch" },
  { id: "web_search", titleKey: "settings_tool_web_search", noteKey: "settings_tool_note_web_search" },
  { id: "bash", titleKey: "settings_tool_bash", noteKey: "settings_tool_note_bash" },
  { id: "powershell", titleKey: "settings_tool_powershell", noteKey: "settings_tool_note_powershell" },
  { id: "image_generate", titleKey: "settings_tool_image_generate", noteKey: "settings_tool_note_image_generate" },
  { id: "image_edit", titleKey: "settings_tool_image_edit", noteKey: "settings_tool_note_image_edit" },
  // Console only, off by default: Add skill on the Skills page names them with $, which turns them
  // on for that one task.
  { id: "skill_install_preview", titleKey: "settings_tool_skill_install_preview", noteKey: "settings_tool_note_skill_install_preview" },
  { id: "skill_install", titleKey: "settings_tool_skill_install", noteKey: "settings_tool_note_skill_install" },
];

const MANAGED_RUNTIME_ITEMS = [
  { id: "telegram", titleKey: "settings_console_runtime_telegram", noteKey: "settings_console_runtime_note_telegram" },
  { id: "slack", titleKey: "settings_console_runtime_slack", noteKey: "settings_console_runtime_note_slack" },
  { id: "lark", titleKey: "settings_console_runtime_lark", noteKey: "settings_console_runtime_note_lark" },
  { id: "mixin", titleKey: "settings_console_runtime_mixin", noteKey: "settings_console_runtime_note_mixin" },
  { id: "discord", titleKey: "settings_console_runtime_discord", noteKey: "settings_console_runtime_note_discord" },
  { id: "wechat", titleKey: "settings_console_runtime_wechat", noteKey: "settings_console_runtime_note_wechat" },
  { id: "whatsapp", titleKey: "settings_console_runtime_whatsapp", noteKey: "settings_console_runtime_note_whatsapp" },
];

// The channels on the Channels page. A channel counts as configured when every credential it needs
// is set, in config or by an environment variable.
const CHANNEL_ITEMS = [
  { id: "telegram", titleKey: "settings_console_telegram_title", logo: channelTelegramLogoURL, required: ["bot_token"] },
  { id: "slack", titleKey: "settings_console_slack_title", logo: channelSlackLogoURL, required: ["bot_token", "app_token"] },
  { id: "discord", titleKey: "settings_console_discord_title", logo: channelDiscordLogoURL, required: ["bot_token"] },
  { id: "wechat", titleKey: "settings_console_wechat_title", logo: channelWeChatLogoURL, required: ["bot_token"] },
  { id: "whatsapp", titleKey: "settings_console_whatsapp_title", logo: channelWhatsAppLogoURL, required: ["api_token"] },
  { id: "lark", titleKey: "settings_console_lark_title", logo: channelLarkLogoURL, required: ["app_id", "app_secret"] },
  { id: "line", titleKey: "settings_console_line_title", logo: channelLineLogoURL, required: ["channel_access_token", "channel_secret"] },
  { id: "mixin", titleKey: "settings_console_mixin_title", logo: channelMixinLogoURL, required: ["keystore_file"] },
];

const CHANNEL_GROUP_TRIGGER_VALUES = ["smart", "strict", "talkative"];
const LOCAL_CONSOLE_ENDPOINT_REF = "ep_console_local";
const SETTINGS_DEFAULT_SECTION_ID = "persona";
const SETTINGS_SECTION_IDS = new Set([
  "agent",
  "routes",
  "tools",
  "mcp",
  "persona",
  "channels",
  "automation",
  "system",
  "runtimes",
  "security",
  "console",
  "runtime",
  "credits",
]);
const UPDATE_RELEASES_URL = "https://mistermorph.com/releases/";
let llmProfileKeySeed = 0;
let mcpSettingsKeySeed = 0;

function settingsRouteSection(route) {
  const value = route?.params?.section;
  const text = Array.isArray(value) ? value[0] : value;
  return String(text || "").trim();
}

function normalizeSettingsSectionID(value) {
  // Running a channel inside Console moved from its own section into the channel's panel.
  const id = String(value || "").trim() === "runtimes" ? "channels" : String(value || "").trim();
  return SETTINGS_SECTION_IDS.has(id) ? id : SETTINGS_DEFAULT_SECTION_ID;
}

function settingsSectionPath(endpointRef, id) {
  const sectionID = normalizeSettingsSectionID(id);
  const pagePath =
    sectionID === SETTINGS_DEFAULT_SECTION_ID ? "/settings" : `/settings/${sectionID}`;
  return endpointRoutePath(endpointRef, pagePath);
}

function buildEmptyLLMForm() {
  return {
    inference_provider: "",
    provider: "",
    endpoint: "",
    model: "",
    context_window_tokens: "",
    supports_image_parts: "",
    headers_text: "{}",
    cache_ttl: "",
    cache_key_prefix: "",
    request_timeout: "",
    temperature: "",
    reasoning_budget_tokens: "",
    api_key: "",
    azure_deployment: "",
    bedrock_aws_key: "",
    bedrock_aws_secret: "",
    bedrock_aws_session_token: "",
    bedrock_aws_profile: "",
    bedrock_region: "",
    bedrock_model_arn: "",
    cloudflare_api_token: "",
    cloudflare_account_id: "",
    reasoning_effort: "",
    tools_emulation_mode: "",
  };
}

function buildEmptyTelegramConsoleState() {
  return {
    bot_token: "",
    allowed_chat_ids_text: "",
    group_trigger_mode: "talkative",
  };
}

function buildEmptySlackConsoleState() {
  return {
    bot_token: "",
    app_token: "",
    allowed_team_ids_text: "",
    allowed_channel_ids_text: "",
    group_trigger_mode: "talkative",
  };
}

function buildEmptyLineConsoleState() {
  return {
    channel_access_token: "",
    channel_secret: "",
    allowed_group_ids_text: "",
    group_trigger_mode: "talkative",
  };
}

function buildEmptyLarkConsoleState() {
  return {
    app_id: "",
    app_secret: "",
    allowed_chat_ids_text: "",
    group_trigger_mode: "talkative",
  };
}

function buildEmptyDiscordConsoleState() {
  return {
    bot_token: "",
    allowed_guild_ids_text: "",
    allowed_channel_ids_text: "",
    allowed_user_ids_text: "",
    group_trigger_mode: "strict",
  };
}

// WeChat has nothing to edit: the bot comes from QR login (its token never reaches the browser),
// and bot_id shows which bot is connected.
function buildEmptyWeChatConsoleState() {
  return {
    bot_id: "",
  };
}

function buildEmptyWhatsAppConsoleState() {
  return {
    api_token: "",
  };
}

function buildEmptyMixinConsoleState() {
  return {
    keystore_file: "",
    allowed_conversation_ids_text: "",
  };
}

function buildEmptyGuardConsoleState() {
  return {
    enabled: true,
    url_fetch_allowed_url_prefixes_text: "https://",
    deny_private_ips: true,
    follow_redirects: false,
    allow_proxy: false,
    redaction_enabled: true,
    approvals_enabled: false,
  };
}

function nextLLMProfileKey() {
  llmProfileKeySeed += 1;
  return `llm-profile-${Date.now()}-${llmProfileKeySeed}`;
}

function buildLLMProfileState(data = {}) {
  const profile = {
    _key: nextLLMProfileKey(),
    _envManaged: {},
    _secretFields: {},
    _secretDirty: new Set(),
    _savedName: "",
    _savedSnapshot: "",
    name: "",
    ...buildEmptyLLMForm(),
    ...(data && typeof data === "object" ? data : {}),
  };
  profile.headers_text = JSON.stringify(data?.headers && typeof data.headers === "object" ? data.headers : {}, null, 2);
  profile._savedName = trimText(profile.name);
  profile._savedSnapshot = JSON.stringify(serializeLLMProfile(profile));
  return profile;
}

function trimText(value) {
  return String(value || "").trim();
}

function normalizeText(value) {
  return String(value || "").replace(/\r\n/g, "\n");
}

function lineCount(value) {
  const text = String(value || "");
  if (!text) {
    return 0;
  }
  return text.split(/\r?\n/).length;
}

async function copyTextToClipboard(text) {
  const value = String(text || "");
  if (!value) {
    return false;
  }
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return true;
  }
  if (typeof document === "undefined") {
    return false;
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  try {
    return document.execCommand("copy");
  } finally {
    document.body.removeChild(textarea);
  }
}

function normalizeNamedList(values) {
  if (!Array.isArray(values)) {
    return [];
  }
  const out = [];
  const seen = new Set();
  for (const value of values) {
    const name = trimText(value);
    if (!name) {
      continue;
    }
    const key = name.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(name);
  }
  return out;
}

function normalizeConsoleGroupTriggerMode(value) {
  const next = String(value || "").trim().toLowerCase();
  return CHANNEL_GROUP_TRIGGER_VALUES.includes(next) ? next : "talkative";
}

// Discord defaults to strict: the one mode that works without the Message Content intent.
function normalizeDiscordGroupTriggerMode(value) {
  const next = String(value || "").trim().toLowerCase();
  return CHANNEL_GROUP_TRIGGER_VALUES.includes(next) ? next : "strict";
}

function parseConfigListText(value) {
  return normalizeNamedList(String(value || "").split(/\r?\n|,/));
}

function formatConfigList(values) {
  return normalizeNamedList(Array.isArray(values) ? values : []).join("\n");
}

function toolEnabledValue(entry) {
  return !!(entry && typeof entry === "object" && entry.enabled === true);
}

function serializeLLMProfile(profile) {
  return {
    name: trimText(profile?.name),
    inference_provider: trimText(profile?.inference_provider),
    provider: trimText(profile?.provider),
    endpoint: trimText(profile?.endpoint),
    model: trimText(profile?.model),
    context_window_tokens: trimText(profile?.context_window_tokens),
    supports_image_parts: trimText(profile?.supports_image_parts),
    headers_text: normalizeText(profile?.headers_text || "{}"),
    cache_ttl: trimText(profile?.cache_ttl),
    cache_key_prefix: trimText(profile?.cache_key_prefix),
    request_timeout: trimText(profile?.request_timeout),
    temperature: trimText(profile?.temperature),
    reasoning_budget_tokens: trimText(profile?.reasoning_budget_tokens),
    api_key: trimText(profile?.api_key),
    azure_deployment: trimText(profile?.azure_deployment),
    bedrock_aws_key: trimText(profile?.bedrock_aws_key),
    bedrock_aws_secret: trimText(profile?.bedrock_aws_secret),
    bedrock_aws_session_token: trimText(profile?.bedrock_aws_session_token),
    bedrock_aws_profile: trimText(profile?.bedrock_aws_profile),
    bedrock_region: trimText(profile?.bedrock_region),
    bedrock_model_arn: trimText(profile?.bedrock_model_arn),
    cloudflare_api_token: trimText(profile?.cloudflare_api_token),
    cloudflare_account_id: trimText(profile?.cloudflare_account_id),
    reasoning_effort: trimText(profile?.reasoning_effort),
    tools_emulation_mode: trimText(profile?.tools_emulation_mode),
  };
}

function buildLLMSnapshot(state) {
  recordSnapshotBuild("settings.llm");
  return JSON.stringify({
    llm: {
      inference_provider: trimText(state.llm.inference_provider),
      provider: trimText(state.llm.provider),
      endpoint: trimText(state.llm.endpoint),
      model: trimText(state.llm.model),
      api_key: trimText(state.llm.api_key),
      bedrock_aws_key: trimText(state.llm.bedrock_aws_key),
      bedrock_aws_secret: trimText(state.llm.bedrock_aws_secret),
      bedrock_region: trimText(state.llm.bedrock_region),
      bedrock_model_arn: trimText(state.llm.bedrock_model_arn),
      cloudflare_api_token: trimText(state.llm.cloudflare_api_token),
      cloudflare_account_id: trimText(state.llm.cloudflare_account_id),
      fallback_profiles: normalizeNamedList(state.llm.fallback_profiles),
    },
  });
}

function buildToolsSnapshot(state) {
  recordSnapshotBuild("settings.tools");
  return JSON.stringify({
    tools: {
      write_file: !!state.tools.write_file,
      spawn: !!state.tools.spawn,
      coder: !!state.tools.coder,
      contacts_send: !!state.tools.contacts_send,
      todo_update: !!state.tools.todo_update,
      plan_create: !!state.tools.plan_create,
      url_fetch: !!state.tools.url_fetch,
      web_search: !!state.tools.web_search,
      bash: !!state.tools.bash,
      powershell: !!state.tools.powershell,
      image_generate: !!state.tools.image_generate,
      image_edit: !!state.tools.image_edit,
      skill_install_preview: !!state.tools.skill_install_preview,
      skill_install: !!state.tools.skill_install,
    },
  });
}

function nextMCPSettingsKey(prefix) {
  mcpSettingsKeySeed += 1;
  return `mcp-${prefix}-${mcpSettingsKeySeed}`;
}

function buildMCPPairRows(values) {
  if (!values || typeof values !== "object" || Array.isArray(values)) {
    return [];
  }
  return Object.entries(values).map(([key, value]) => ({
    _key: nextMCPSettingsKey("pair"),
    key: String(key || ""),
    value: String(value ?? ""),
  }));
}

function buildMCPServerState(server) {
  const value = server && typeof server === "object" ? server : {};
  return {
    _key: nextMCPSettingsKey("server"),
    name: trimText(value.name),
    enable: value.enable !== false,
    type: trimText(value.type).toLowerCase() === "http" ? "http" : "stdio",
    command: typeof value.command === "string" ? value.command : "",
    args_text: Array.isArray(value.args) ? value.args.map((item) => String(item ?? "")).join("\n") : "",
    env_rows: buildMCPPairRows(value.env),
    url: typeof value.url === "string" ? value.url : "",
    header_rows: buildMCPPairRows(value.headers),
    allowed_tools_text: Array.isArray(value.allowed_tools)
      ? value.allowed_tools.map((item) => String(item ?? "")).join("\n")
      : "",
  };
}

function parseMCPLineList(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function serializeMCPPairs(rows) {
  const values = {};
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = trimText(row?.key);
    if (key) {
      values[key] = String(row?.value ?? "");
    }
  }
  return values;
}

function serializeMCPServer(server) {
  return {
    name: trimText(server?.name),
    enable: server?.enable !== false,
    type: server?.type === "http" ? "http" : "stdio",
    command: trimText(server?.command),
    args: parseMCPLineList(server?.args_text),
    env: serializeMCPPairs(server?.env_rows),
    url: trimText(server?.url),
    headers: serializeMCPPairs(server?.header_rows),
    allowed_tools: parseMCPLineList(server?.allowed_tools_text),
  };
}

function buildMCPSnapshot(state) {
  recordSnapshotBuild("settings.mcp");
  return JSON.stringify({
    servers: (Array.isArray(state.mcp.servers) ? state.mcp.servers : []).map(serializeMCPServer),
  });
}

function buildConsoleManagedRuntimeSnapshot(state) {
  recordSnapshotBuild("settings.console.managed_runtimes");
  return JSON.stringify({
    telegram: !!state.managedRuntimes.telegram,
    slack: !!state.managedRuntimes.slack,
    lark: !!state.managedRuntimes.lark,
    mixin: !!state.managedRuntimes.mixin,
    discord: !!state.managedRuntimes.discord,
    wechat: !!state.managedRuntimes.wechat,
    whatsapp: !!state.managedRuntimes.whatsapp,
  });
}

function buildConsoleTelegramSnapshot(state) {
  recordSnapshotBuild("settings.console.telegram");
  return JSON.stringify({
    bot_token: trimText(state.telegram.bot_token),
    allowed_chat_ids: parseConfigListText(state.telegram.allowed_chat_ids_text),
    group_trigger_mode: normalizeConsoleGroupTriggerMode(state.telegram.group_trigger_mode),
  });
}

function buildConsoleSlackSnapshot(state) {
  recordSnapshotBuild("settings.console.slack");
  return JSON.stringify({
    bot_token: trimText(state.slack.bot_token),
    app_token: trimText(state.slack.app_token),
    allowed_team_ids: parseConfigListText(state.slack.allowed_team_ids_text),
    allowed_channel_ids: parseConfigListText(state.slack.allowed_channel_ids_text),
    group_trigger_mode: normalizeConsoleGroupTriggerMode(state.slack.group_trigger_mode),
  });
}

function buildConsoleLineSnapshot(state) {
  recordSnapshotBuild("settings.console.line");
  return JSON.stringify({
    channel_access_token: trimText(state.line.channel_access_token),
    channel_secret: trimText(state.line.channel_secret),
    allowed_group_ids: parseConfigListText(state.line.allowed_group_ids_text),
    group_trigger_mode: normalizeConsoleGroupTriggerMode(state.line.group_trigger_mode),
  });
}

function buildConsoleLarkSnapshot(state) {
  recordSnapshotBuild("settings.console.lark");
  return JSON.stringify({
    app_id: trimText(state.lark.app_id),
    app_secret: trimText(state.lark.app_secret),
    allowed_chat_ids: parseConfigListText(state.lark.allowed_chat_ids_text),
    group_trigger_mode: normalizeConsoleGroupTriggerMode(state.lark.group_trigger_mode),
  });
}

function buildConsoleMixinSnapshot(state) {
  recordSnapshotBuild("settings.console.mixin");
  return JSON.stringify({
    keystore_file: trimText(state.mixin.keystore_file),
    allowed_conversation_ids: parseConfigListText(state.mixin.allowed_conversation_ids_text),
  });
}

function buildConsoleDiscordSnapshot(state) {
  recordSnapshotBuild("settings.console.discord");
  return JSON.stringify({
    bot_token: trimText(state.discord.bot_token),
    allowed_guild_ids: parseConfigListText(state.discord.allowed_guild_ids_text),
    allowed_channel_ids: parseConfigListText(state.discord.allowed_channel_ids_text),
    allowed_user_ids: parseConfigListText(state.discord.allowed_user_ids_text),
    group_trigger_mode: normalizeDiscordGroupTriggerMode(state.discord.group_trigger_mode),
  });
}

function buildConsoleWhatsAppSnapshot(state) {
  recordSnapshotBuild("settings.console.whatsapp");
  return JSON.stringify({
    api_token: trimText(state.whatsapp.api_token),
  });
}

function buildConsoleGuardSnapshot(state) {
  recordSnapshotBuild("settings.console.guard");
  return JSON.stringify({
    enabled: !!state.guard.enabled,
    network: {
      url_fetch: {
        allowed_url_prefixes: parseConfigListText(state.guard.url_fetch_allowed_url_prefixes_text),
        deny_private_ips: !!state.guard.deny_private_ips,
        follow_redirects: !!state.guard.follow_redirects,
        allow_proxy: !!state.guard.allow_proxy,
      },
    },
    redaction: {
      enabled: !!state.guard.redaction_enabled,
    },
    approvals: {
      enabled: !!state.guard.approvals_enabled,
    },
  });
}

const SettingsView = {
  components: {
    MarkdownContent,
    SettingSelect,
    SecretInput,
    AppPage,
    EnvManagedField,
    WeChatLoginPanel,
    AuthProfilesPanel,
    CodexAuthDialog,
    ConfigSettingsPanel,
    ModelRoutesPanel,
    ConsolePasswordPanel,
    ConsoleEndpointsPanel,
    XAIAuthDialog,
    ProAuthDialog,
    ImageUploadField,
    LLMConfigForm,
    MCPSettingsPanel,
    AppMarkdownEditor,
    SettingsCreditsPanel,
    SettingDialog,
    SetupConnectionTestDialog,
    SetupPickerDialog,
    RuntimePanel,
  },
  setup() {
    const t = translate;
    const toast = useToast();
    const router = useRouter();
    const route = useRoute();
    const lang = computed(() => localeState.lang);
    const loggingOut = ref(false);
    const agentLoading = ref(false);
    const agentSaving = ref(false);
    const agentSavingTarget = ref("");
    const agentSettingsReadOnly = ref(false);
    const agentSettingsReadOnlyReason = ref("");
    const agentSettingsReadOnlyMessage = computed(
      () => trimText(agentSettingsReadOnlyReason.value) || t("settings_agent_llm_hint_read_only")
    );
    const agentBusyReason = computed(() => {
      if (agentLoading.value) {
        return "agentLoading";
      }
      if (!agentSaving.value) {
        return "";
      }
      const target = trimText(agentSavingTarget.value);
      return target ? `agentSaving:${target}` : "agentSaving";
    });
    const agentFormDisabledReason = computed(() =>
      agentSettingsReadOnly.value ? agentSettingsReadOnlyMessage.value : agentBusyReason.value
    );
    const agentValidationVisible = ref(false);
    const deleteProfileDialogOpen = ref(false);
    const deleteProfileTargetKey = ref("");
    const advancedSettingsOpen = ref(false);
    const advancedSettingsTitle = ref("");
    const advancedSettingsScope = ref("agent");
    const advancedSettingsGroups = ref([]);
    const advancedSettingsDirty = ref(false);
    const advancedConfigPanel = ref(null);
    const llmConfigPath = ref("");
    const settingsConfigRevision = ref("");
    const agentConfigValues = ref({});
    const agentFieldStates = ref({});
    const loadedLLMSnapshot = ref("");
    const loadedToolsSnapshot = ref("");
    const loadedMCPSnapshot = ref("");
    const llmDirty = ref(false);
    const toolsDirty = ref(false);
    const mcpDirty = ref(false);
    const agentSettingsLoaded = ref(false);
    const llmEnvManaged = ref({});
    const llmSecretFields = ref({});
    const llmSecretDirty = new Set();
    const consoleLoading = ref(false);
    const consoleSaving = ref(false);
    const consoleSavingTarget = ref("");
    const consoleConfigPath = ref("");
    const consoleConfigValues = ref({});
    const consoleFieldStates = ref({});
    const consoleEndpoints = ref([]);
    const addConsoleEndpointRequested = computed(() => route.query.add === "agent");
    const consoleEndpointErrorOpen = ref(false);
    const consoleEndpointError = ref("");
    const consoleEndpointErrorTitle = ref("");
    const consoleEndpointErrorActions = computed(() => [{
      name: "close",
      label: t("action_close"),
      class: "primary",
      action: () => { consoleEndpointErrorOpen.value = false; },
    }]);
    const authProfiles = ref([]);
    // Allowed auth profiles are picked from the profiles defined above them.
    const securityConfigGroups = computed(() => {
      const names = authProfiles.value.map((profile) => trimText(profile?.name)).filter(Boolean);
      return SECURITY_CONFIG_GROUPS.map((group) => ({
        ...group,
        fields: group.fields.map((field) => (field.path === "secrets.allow_profiles" ? { ...field, options: names } : field)),
      }));
    });
    const loadedConsoleManagedSnapshot = ref("");
    const loadedConsoleTelegramSnapshot = ref("");
    const loadedConsoleSlackSnapshot = ref("");
    const loadedConsoleLineSnapshot = ref("");
    const loadedConsoleLarkSnapshot = ref("");
    const loadedConsoleMixinSnapshot = ref("");
    const loadedConsoleDiscordSnapshot = ref("");
    const loadedConsoleWhatsAppSnapshot = ref("");
    const loadedConsoleGuardSnapshot = ref("");
    const consoleManagedDirty = ref(false);
    const consoleTelegramDirty = ref(false);
    const consoleSlackDirty = ref(false);
    const consoleLineDirty = ref(false);
    const consoleLarkDirty = ref(false);
    const consoleMixinDirty = ref(false);
    const consoleDiscordDirty = ref(false);
    const consoleWhatsAppDirty = ref(false);
    const consoleGuardDirty = ref(false);
    const consoleSettingsLoaded = ref(false);
    const consoleEnvManaged = ref({});
    const consoleSecretFields = ref({});
    const consoleSecretDirty = new Set();
    const personaLoading = ref(false);
    const personaSaving = ref(false);
    const personaSavingTarget = ref("");
    const personaErr = ref("");
    const personaOk = ref("");
    const loadedIdentityRaw = ref("");
    const loadedIdentitySnapshot = ref("");
    const loadedSoulSnapshot = ref("");
    const personaSettingsLoaded = ref(false);
    const soulContent = ref("");
    const personaAvatarURL = ref("");
    const personaAvatarBusy = ref(false);
    let personaAvatarObjectURL = "";
    const personaAvatarSourceTypes = Array.from(PERSONA_AVATAR_SOURCE_TYPES);
    const desktopLoading = ref(false);
    const desktopChecking = ref(false);
    const desktopCurrentVersion = ref(desktopRuntimeVersion() || "dev");
    const desktopUpdateResult = ref(null);
    const desktopSettingsLoaded = ref(false);
    const desktopChecksumCopied = ref(false);
    const desktopBuildChannel = ref("");
    // The saved auto_update settings. Both apply as soon as they change, like Language.
    const autoUpdateEnabled = ref(false);
    const autoUpdateChannel = ref("");
    const autoUpdateRevision = ref("");
    const autoUpdateSaving = ref(false);
    const desktopUpdateError = ref("");
    const systemLoading = ref(false);
    const systemSaving = ref(false);
    const systemSettingsLoaded = ref(false);
    const systemConfigValues = ref({});
    const systemFieldStates = ref({});
    const selectedSectionID = ref(normalizeSettingsSectionID(settingsRouteSection(route)));
    const isMobile = ref(false);
    const mobilePanelVisible = ref(false);
    const apiBasePickerOpen = ref(false);
    const modelPickerOpen = ref(false);
    const modelPickerTargetProfileKey = ref("");
    const modelPickerLoading = ref(false);
    const modelPickerError = ref("");
    const modelPickerItems = ref([]);
    // The model in use by what the picker was opened for: a profile, or the default model.
    const modelPickerSelectedValue = computed(() => {
      const targetProfile = state.llm.profiles.find((profile) => profile._key === modelPickerTargetProfileKey.value) || null;
      return trimText(targetProfile ? targetProfile.model : state.llm.model);
    });

    const testConnectionOpen = ref(false);
    const testConnectionLoading = ref(false);
    const testConnectionError = ref("");
    const testConnectionBenchmarks = ref([]);
    const testConnectionMeta = reactive({
      provider: "",
      apiBase: "",
      model: "",
    });
    const testConnectionTargetProfileKey = ref("");
    const codexAuthLoading = ref(false);
    const codexAuthBusy = ref(false);
    const codexAuthError = ref("");
    const codexAuthDialogOpen = ref(false);
    const codexLoginSession = ref("");
    const codexLoginEndpointRef = ref("");
    const codexLoginVerificationURL = ref("");
    const codexLoginUserCode = ref("");
    const codexLoginExpiresAt = ref("");
    let codexLoginPollTimer = 0;
    let codexAuthStatusRequestSeq = 0;
    let codexAuthOperationSeq = 0;
    let desktopChecksumCopyTimer = 0;
    const codexAuthStatus = reactive({
      logged_in: false,
      access_token_present: false,
      refresh_token_present: false,
      access_token_expired: false,
      expires_at: "",
      account_id: "",
      file_mode_ok: true,
      file_mode_warning: "",
    });

    const state = reactive({
      persona: buildEmptyPersonaIdentityState(),
      llm: {
        ...buildEmptyLLMForm(),
        current_profile: "",
        profiles: [],
        fallback_profiles: [],
      },
      tools: {
        write_file: true,
        spawn: true,
        coder: false,
        contacts_send: true,
        todo_update: true,
        plan_create: true,
        url_fetch: true,
        web_search: true,
        bash: true,
        powershell: false,
        image_generate: true,
        image_edit: true,
        skill_install_preview: false,
        skill_install: false,
      },
      mcp: {
        servers: [],
      },
      managedRuntimes: {
        telegram: false,
        slack: false,
        lark: false,
        mixin: false,
        discord: false,
        wechat: false,
        whatsapp: false,
      },
      telegram: buildEmptyTelegramConsoleState(),
      slack: buildEmptySlackConsoleState(),
      line: buildEmptyLineConsoleState(),
      lark: buildEmptyLarkConsoleState(),
      mixin: buildEmptyMixinConsoleState(),
      discord: buildEmptyDiscordConsoleState(),
      wechat: buildEmptyWeChatConsoleState(),
      whatsapp: buildEmptyWhatsAppConsoleState(),
      guard: buildEmptyGuardConsoleState(),
    });

    // apply_mode of each successful save since the last reset, so a combined save can report the
    // strongest outcome (a restart beats a plain save) in one message.
    let savedApplyModes = [];

    function noteSavedApplyMode(payload) {
      savedApplyModes.push(trimText(payload?.apply_mode));
    }

    function takeSavedApplyMode() {
      const order = ["process_restart", "runtime_restart", "next_generation"];
      const strongest = order.find((mode) => savedApplyModes.includes(mode)) || "";
      savedApplyModes = [];
      return strongest;
    }

    function settingsSavedMessage(payload) {
      switch (trimText(payload?.apply_mode)) {
        case "process_restart":
          return t("msg_save_process_restart");
        case "runtime_restart":
          return t("msg_save_runtime_restart");
        case "next_generation":
          return t("msg_save_next_generation");
        default:
          return t("msg_save_success");
      }
    }

    function clearLoadedAgentSnapshots() {
      loadedLLMSnapshot.value = "";
      loadedToolsSnapshot.value = "";
      loadedMCPSnapshot.value = "";
      llmDirty.value = false;
      toolsDirty.value = false;
      mcpDirty.value = false;
      agentSettingsLoaded.value = false;
    }

    function currentAgentSnapshotScope(sectionID = selectedSectionID.value) {
      switch (sectionID) {
        case "agent":
          return "agent";
        case "tools":
          return "tools";
        case "mcp":
          return "mcp";
        default:
          return "";
      }
    }

    function setLoadedAgentSnapshots(scope = "all") {
      const normalizedScope = String(scope || "all");
      if (normalizedScope === "all" || normalizedScope === "agent" || normalizedScope === "llm") {
        loadedLLMSnapshot.value = buildLLMSnapshot(state);
        llmDirty.value = false;
      }
      if (normalizedScope === "all" || normalizedScope === "tools") {
        loadedToolsSnapshot.value = buildToolsSnapshot(state);
        toolsDirty.value = false;
      }
      if (normalizedScope === "all" || normalizedScope === "mcp") {
        loadedMCPSnapshot.value = buildMCPSnapshot(state);
        mcpDirty.value = false;
      }
    }

    function ensureLoadedAgentSnapshotsForSection(sectionID = selectedSectionID.value) {
      if (!agentSettingsLoaded.value) {
        return;
      }
      const scope = currentAgentSnapshotScope(sectionID);
      if (scope === "agent") {
        if (!loadedLLMSnapshot.value) {
          setLoadedAgentSnapshots("llm");
        }
      } else if (scope === "tools" && !loadedToolsSnapshot.value) {
        setLoadedAgentSnapshots("tools");
      } else if (scope === "mcp" && !loadedMCPSnapshot.value) {
        setLoadedAgentSnapshots("mcp");
      }
    }

    function updateLLMDirty() {
      llmDirty.value = llmSecretDirty.size > 0 || buildLLMSnapshot(state) !== loadedLLMSnapshot.value;
    }

    function updateLoadedFallbackProfile(originalName, nextName) {
      const original = trimText(originalName);
      if (!original || !loadedLLMSnapshot.value) {
        return;
      }
      try {
        const snapshot = JSON.parse(loadedLLMSnapshot.value);
        const values = Array.isArray(snapshot?.llm?.fallback_profiles)
          ? snapshot.llm.fallback_profiles
          : [];
        snapshot.llm.fallback_profiles = nextName
          ? values.map((value) => trimText(value).toLowerCase() === original.toLowerCase() ? trimText(nextName) : value)
          : values.filter((value) => trimText(value).toLowerCase() !== original.toLowerCase());
        loadedLLMSnapshot.value = JSON.stringify(snapshot);
        updateLLMDirty();
      } catch {
        // A missing snapshot only affects the disabled state of the page-level save button.
      }
    }

    function updateToolsDirty() {
      toolsDirty.value = buildToolsSnapshot(state) !== loadedToolsSnapshot.value;
    }

    function updateMCPDirty() {
      mcpDirty.value = buildMCPSnapshot(state) !== loadedMCPSnapshot.value;
    }

    function setLoadedConsoleSnapshots() {
      loadedConsoleManagedSnapshot.value = buildConsoleManagedRuntimeSnapshot(state);
      loadedConsoleTelegramSnapshot.value = buildConsoleTelegramSnapshot(state);
      loadedConsoleSlackSnapshot.value = buildConsoleSlackSnapshot(state);
      loadedConsoleLineSnapshot.value = buildConsoleLineSnapshot(state);
      loadedConsoleLarkSnapshot.value = buildConsoleLarkSnapshot(state);
      loadedConsoleMixinSnapshot.value = buildConsoleMixinSnapshot(state);
      loadedConsoleDiscordSnapshot.value = buildConsoleDiscordSnapshot(state);
      loadedConsoleWhatsAppSnapshot.value = buildConsoleWhatsAppSnapshot(state);
      loadedConsoleGuardSnapshot.value = buildConsoleGuardSnapshot(state);
      consoleManagedDirty.value = false;
      consoleTelegramDirty.value = false;
      consoleSlackDirty.value = false;
      consoleLineDirty.value = false;
      consoleLarkDirty.value = false;
      consoleMixinDirty.value = false;
      consoleDiscordDirty.value = false;
      consoleWhatsAppDirty.value = false;
      consoleGuardDirty.value = false;
    }

    function clearLoadedConsoleSnapshots() {
      loadedConsoleManagedSnapshot.value = "";
      loadedConsoleTelegramSnapshot.value = "";
      loadedConsoleSlackSnapshot.value = "";
      loadedConsoleLineSnapshot.value = "";
      loadedConsoleLarkSnapshot.value = "";
      loadedConsoleMixinSnapshot.value = "";
      loadedConsoleDiscordSnapshot.value = "";
      loadedConsoleWhatsAppSnapshot.value = "";
      loadedConsoleGuardSnapshot.value = "";
      consoleManagedDirty.value = false;
      consoleTelegramDirty.value = false;
      consoleSlackDirty.value = false;
      consoleLineDirty.value = false;
      consoleLarkDirty.value = false;
      consoleMixinDirty.value = false;
      consoleDiscordDirty.value = false;
      consoleWhatsAppDirty.value = false;
      consoleGuardDirty.value = false;
      consoleSettingsLoaded.value = false;
    }

    function updateConsoleManagedDirty() {
      consoleManagedDirty.value = buildConsoleManagedRuntimeSnapshot(state) !== loadedConsoleManagedSnapshot.value;
    }

    function updateConsoleTelegramDirty() {
      consoleTelegramDirty.value =
        consoleSecretDirty.has("telegram.bot_token") ||
        buildConsoleTelegramSnapshot(state) !== loadedConsoleTelegramSnapshot.value;
    }

    function updateConsoleSlackDirty() {
      consoleSlackDirty.value =
        consoleSecretDirty.has("slack.bot_token") ||
        consoleSecretDirty.has("slack.app_token") ||
        buildConsoleSlackSnapshot(state) !== loadedConsoleSlackSnapshot.value;
    }

    function updateConsoleLineDirty() {
      consoleLineDirty.value =
        consoleSecretDirty.has("line.channel_access_token") ||
        consoleSecretDirty.has("line.channel_secret") ||
        buildConsoleLineSnapshot(state) !== loadedConsoleLineSnapshot.value;
    }

    function updateConsoleLarkDirty() {
      consoleLarkDirty.value =
        consoleSecretDirty.has("lark.app_secret") ||
        buildConsoleLarkSnapshot(state) !== loadedConsoleLarkSnapshot.value;
    }

    function updateConsoleMixinDirty() {
      consoleMixinDirty.value = buildConsoleMixinSnapshot(state) !== loadedConsoleMixinSnapshot.value;
    }

    function updateConsoleDiscordDirty() {
      consoleDiscordDirty.value =
        consoleSecretDirty.has("discord.bot_token") ||
        buildConsoleDiscordSnapshot(state) !== loadedConsoleDiscordSnapshot.value;
    }

    function updateConsoleWhatsAppDirty() {
      consoleWhatsAppDirty.value =
        consoleSecretDirty.has("whatsapp.api_token") ||
        buildConsoleWhatsAppSnapshot(state) !== loadedConsoleWhatsAppSnapshot.value;
    }

    function updateConsoleGuardDirty() {
      consoleGuardDirty.value = buildConsoleGuardSnapshot(state) !== loadedConsoleGuardSnapshot.value;
    }

    const providerItems = SETUP_PROVIDER_OPTIONS;
    const apiBasePickerItems = computed(() =>
      OPENAI_COMPATIBLE_API_BASE_OPTIONS.map((item) => ({
        id: item.id,
        title: item.title,
        value: item.baseURL,
        note: "",
      }))
    );
    const reasoningEffortItems = computed(() => [
      { title: t("settings_llm_reasoning_none"), value: "" },
      { title: t("settings_llm_reasoning_minimal"), value: "minimal" },
      { title: t("settings_llm_reasoning_low"), value: "low" },
      { title: t("settings_llm_reasoning_medium"), value: "medium" },
      { title: t("settings_llm_reasoning_high"), value: "high" },
      { title: t("settings_llm_reasoning_max"), value: "max" },
      { title: t("settings_llm_reasoning_xhigh"), value: "xhigh" },
    ]);
    const toolsEmulationItems = computed(() => [
      { title: t("settings_llm_tools_emulation_off"), value: "off" },
      { title: t("settings_llm_tools_emulation_fallback"), value: "fallback" },
      { title: t("settings_llm_tools_emulation_force"), value: "force" },
    ]);
    const toolItems = computed(() => TOOL_ITEMS);
    const advancedSettingsValues = computed(() =>
      advancedSettingsScope.value === "console" ? consoleConfigValues.value : agentConfigValues.value
    );
    const advancedSettingsFieldStates = computed(() =>
      advancedSettingsScope.value === "console" ? consoleFieldStates.value : agentFieldStates.value
    );
    const advancedSettingsLoading = computed(() =>
      advancedSettingsScope.value === "console" ? consoleLoading.value : agentLoading.value
    );
    const advancedSettingsSaving = computed(() =>
      advancedSettingsScope.value === "console"
        ? consoleSaving.value && consoleSavingTarget.value === "config"
        : agentSaving.value && agentSavingTarget.value === "config"
    );
    const advancedSettingsSaveDisabled = computed(() =>
      advancedSettingsLoading.value || advancedSettingsSaving.value || !advancedSettingsDirty.value
    );
    const managedRuntimeItems = computed(() => MANAGED_RUNTIME_ITEMS);
    const groupTriggerItems = computed(() => [
      { title: t("settings_console_group_trigger_smart"), value: "smart" },
      { title: t("settings_console_group_trigger_strict"), value: "strict" },
      { title: t("settings_console_group_trigger_talkative"), value: "talkative" },
    ]);
    const settingsEndpointRef = computed(() => trimText(endpointState.selectedRef) || LOCAL_CONSOLE_ENDPOINT_REF);
    const consoleRuntimeEndpoints = computed(() => settingsEndpointRef.value === LOCAL_CONSOLE_ENDPOINT_REF ? endpointState.items : []);
    // Stored secrets can be revealed for this console's own config only: a remote runtime's
    // secrets are in its own config.
    const secretRevealLocal = computed(() => settingsEndpointRef.value === LOCAL_CONSOLE_ENDPOINT_REF);

    // The config path an LLM form's secrets sit under: llm, or a saved profile's llm.profiles.<name>.
    function llmRevealPrefix(profile) {
      if (!secretRevealLocal.value) return "";
      if (!profile || profile === state.llm) return "llm";
      const name = trimText(profile._savedName);
      return name ? `llm.profiles.${name}` : "";
    }

    function consoleSecretRevealPath(kind, field) {
      return secretRevealLocal.value ? `${kind}.${field}` : "";
    }
    const selectedEndpointIsConsole = computed(
      () =>
        settingsEndpointRef.value === LOCAL_CONSOLE_ENDPOINT_REF ||
        trimText(runtimeEndpointByRef(settingsEndpointRef.value)?.mode).toLowerCase() === "console"
    );
    const consoleEndpointRef = computed(() =>
      selectedEndpointIsConsole.value ? settingsEndpointRef.value : LOCAL_CONSOLE_ENDPOINT_REF
    );
    const {
      proAuthLoading,
      proAuthBusy,
      proAuthError,
      proAuthDialogOpen,
      proAuthStatus,
      proAuthSummary,
      proAuthButtonState,
      proAuthButtonTitle,
      proLoginSession,
      proLoginVerificationURL,
      proLoginUserCode,
      proLoginExpiresLabel,
      loadProAuthStatus,
      openProAuthDialog,
      pollProLogin,
      logoutProAuth,
      resetProAuthFlow,
      resetProAuthEndpointState,
    } = useProAuthFlow({
      getEndpointRef: () => settingsEndpointRef.value,
      request: endpointApiFetch,
      async onSettingsUpdated(_payload, endpointRef) {
        await loadAgentSettings(endpointRef);
      },
    });
    const {
      xaiAuthLoading,
      xaiAuthBusy,
      xaiAuthError,
      xaiAuthDialogOpen,
      xaiSetDefault,
      xaiAuthStatus,
      xaiAuthSummary,
      xaiAuthButtonState,
      xaiAuthReady,
      xaiAuthButtonTitle,
      xaiLoginSession,
      xaiLoginVerificationURL,
      xaiLoginUserCode,
      xaiLoginExpiresLabel,
      loadXAIAuthStatus,
      openXAIAuthDialog,
      reloginXAIAuth,
      pollXAILogin,
      logoutXAIAuth,
      resetXAIAuthFlow,
      resetXAIAuthEndpointState,
    } = useXAIAuthFlow({
      getEndpointRef: () => settingsEndpointRef.value,
      request: endpointApiFetch,
      async onSettingsUpdated(_payload, endpointRef) {
        await loadAgentSettings(endpointRef);
      },
    });

    const settingsSections = computed(() => {
      const items = [
        {
          id: "persona",
          icon: "PhUserCircle",
          title: t("settings_persona_title"),
          meta: t("settings_section_persona_meta"),
          saveKind: "persona",
        },
        {
          id: "agent",
          icon: "PhRobot",
          title: t("settings_agent_block_title"),
          meta: t("settings_section_agent_meta"),
          saveKind: "agent",
        },
        {
          id: "routes",
          icon: "PhArrowsSplit",
          title: t("settings_routes_title"),
          meta: t("settings_section_routes_meta"),
          saveKind: "agent",
        },
        {
          id: "tools",
          icon: "PhToolbox",
          title: t("settings_tools_title"),
          meta: t("settings_section_tools_meta"),
          saveKind: "agent",
        },
        {
          id: "mcp",
          icon: "PhPlugsConnected",
          title: t("settings_mcp_title"),
          meta: t("settings_section_mcp_meta"),
          saveKind: "agent",
        },
      ];
      if (selectedEndpointIsConsole.value) {
        items.push({
          id: "channels",
          icon: "PhChats",
          title: t("settings_console_channels_title"),
          saveKind: "console",
        });
        items.push({
          id: "security",
          icon: "PhShieldCheck",
          title: t("settings_console_guard_title"),
          meta: t("settings_section_guard_meta"),
          saveKind: "console",
        });
        items.push({
          id: "automation",
          icon: "PhCalendarCheck",
          title: t("settings_automation_title"),
          meta: t("settings_section_automation_meta"),
          saveKind: "console-config",
        });
        items.push({
          id: "system",
          icon: "PhGearSix",
          title: t("settings_system_title"),
          meta: t("settings_section_system_meta"),
          saveKind: "system-config",
        });
        items.push({
          id: "console",
          icon: "PhNetwork",
          title: t("settings_console_title"),
          meta: t("settings_section_console_meta"),
          saveKind: "",
        });
      }
      items.push({
        id: "runtime",
        icon: "PhPulse",
        title: t("runtime_title"),
        saveKind: "",
      });
      items.push({
        id: "credits",
        icon: "PhInfo",
        title: t("settings_credits_title"),
        saveKind: "",
      });
      return items;
    });

    const selectedSection = computed(
      () => settingsSections.value.find((item) => item.id === selectedSectionID.value) || settingsSections.value[0] || null
    );
    const consolePasswordConfigured = computed(
      () =>
        consoleFieldStates.value?.["console.password_hash"]?.configured === true ||
        consoleFieldStates.value?.["console.password"]?.configured === true,
    );
    const activeSaveKind = computed(() => String(selectedSection.value?.saveKind || ""));

    // Section save bar. Every section saves from one place: its own draft scopes (below) plus any
    // ConfigSettingsPanel that registered through this provider while the section is mounted.
    const saveRegistryEntries = reactive(new Map());
    // Browse only makes sense for this machine's settings: a picked folder is a local path.
    provide(
      "settingsCanBrowsePaths",
      computed(() => settingsEndpointRef.value === LOCAL_CONSOLE_ENDPOINT_REF && canPickDesktopDirectory())
    );
    provide("settingsSaveRegistry", {
      register(entry) {
        saveRegistryEntries.set(entry.key, entry);
      },
      unregister(key) {
        saveRegistryEntries.delete(key);
      },
    });

    const CONSOLE_SECTION_TARGETS = {
      channels: [
        ["telegram", consoleTelegramDirty, "settings_console_telegram_title"],
        ["slack", consoleSlackDirty, "settings_console_slack_title"],
        ["line", consoleLineDirty, "settings_console_line_title"],
        ["lark", consoleLarkDirty, "settings_console_lark_title"],
        ["mixin", consoleMixinDirty, "settings_console_mixin_title"],
        ["discord", consoleDiscordDirty, "settings_console_discord_title"],
        ["whatsapp", consoleWhatsAppDirty, "settings_console_whatsapp_title"],
        ["runtimes", consoleManagedDirty, "settings_channel_run_in_console"],
      ],
      security: [["guard", consoleGuardDirty, "settings_console_guard_title"]],
      runtimes: [["runtimes", consoleManagedDirty, ""]],
    };

    // Channels: a tile per channel, and the channel's settings in a panel from the right.
    const openChannel = ref("");
    const channelDirtyRefs = {
      telegram: consoleTelegramDirty,
      slack: consoleSlackDirty,
      line: consoleLineDirty,
      lark: consoleLarkDirty,
      mixin: consoleMixinDirty,
      discord: consoleDiscordDirty,
      whatsapp: consoleWhatsAppDirty,
    };
    function channelFieldSet(kind, field) {
      return (
        trimText(state[kind]?.[field]) !== "" ||
        consoleSecretField(kind, field)?.configured === true ||
        consoleFieldEnvManaged(kind, field)
      );
    }
    function channelManagedItem(id) {
      return MANAGED_RUNTIME_ITEMS.find((item) => item.id === id) || null;
    }
    const channelTiles = computed(() =>
      CHANNEL_ITEMS.map((item) => {
        const configured = item.required.every((field) => channelFieldSet(item.id, field));
        return {
          ...item,
          configured,
          running: configured && !!channelManagedItem(item.id) && !!state.managedRuntimes[item.id],
          dirty: !!channelDirtyRefs[item.id]?.value,
        };
      })
    );
    // Configured channels first, then the ones not set up; an empty group is not shown.
    const channelGroups = computed(() =>
      [
        { id: "configured", titleKey: "settings_channel_group_configured", items: channelTiles.value.filter((item) => item.configured) },
        { id: "unconfigured", titleKey: "settings_channel_group_unconfigured", items: channelTiles.value.filter((item) => !item.configured) },
      ].filter((group) => group.items.length > 0)
    );
    // Each threshold is read in one trigger mode only: confidence in smart, interject in talkative;
    // strict reads neither. "Record all group messages" applies in every mode.
    function channelTriggerHiddenPaths(id) {
      const mode = id === "discord"
        ? normalizeDiscordGroupTriggerMode(state.discord.group_trigger_mode)
        : normalizeConsoleGroupTriggerMode(state[id]?.group_trigger_mode);
      const confidence = `${id}.addressing_confidence_threshold`;
      const interject = `${id}.addressing_interject_threshold`;
      if (mode === "smart") return [interject];
      if (mode === "talkative") return [confidence];
      return [confidence, interject];
    }
    const openChannelTitleKey = computed(
      () => CHANNEL_ITEMS.find((item) => item.id === openChannel.value)?.titleKey || "settings_console_channels_title"
    );
    // Closing keeps the draft: it stays in the save bar, and the tile shows it is unsaved.
    function openChannelPane(id) {
      openChannel.value = openChannel.value === id ? "" : id;
    }
    function closeChannelPane() {
      openChannel.value = "";
    }
    function onChannelPaneKeydown(event) {
      // A field that used Escape itself (closing its list) keeps the pane open.
      if (event.key === "Escape" && !event.defaultPrevented && openChannel.value) {
        closeChannelPane();
      }
    }
    watch(() => selectedSection.value?.id, closeChannelPane);
    onMounted(() => window.addEventListener("keydown", onChannelPaneKeydown));
    onUnmounted(() => window.removeEventListener("keydown", onChannelPaneKeydown));

    // Models: profiles are listed as one-line rows; a profile's settings open in a panel from the
    // right, the same panel Channels uses. Closing keeps the draft in the save bar.
    const openProfileKey = ref("");
    const openedProfile = computed(
      () => state.llm.profiles.find((item) => item._key === openProfileKey.value && !item._draft) || null
    );
    function openProfilePane(key) {
      openProfileKey.value = openProfileKey.value === key ? "" : key;
    }
    function closeProfilePane() {
      openProfileKey.value = "";
    }
    // Provider and model in one line, for the list and the panel header.
    function profileSummary(profile) {
      const choice = profileProviderChoice(profile);
      const provider = providerItems.find((item) => item.value === choice)?.title || "";
      const model = trimText(profile?.model);
      return [provider, model].filter(Boolean).join(" · ");
    }
    // The provider's logo for a profile row, with initials when there is no logo.
    function profileLogo(profile) {
      const choice = profileProviderChoice(profile);
      const logo = inferenceProviderLogo(choice);
      const title = providerItems.find((item) => item.value === choice)?.title || "";
      const initials = title
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((word) => word[0].toUpperCase())
        .join("");
      return { src: logo.src, className: logo.className || "is-fallback", text: initials || "LLM" };
    }

    function onProfilePaneKeydown(event) {
      if (event.key === "Escape" && !event.defaultPrevented && openProfileKey.value) {
        closeProfilePane();
      }
    }
    watch(() => selectedSection.value?.id, closeProfilePane);
    onMounted(() => window.addEventListener("keydown", onProfilePaneKeydown));
    onUnmounted(() => window.removeEventListener("keydown", onProfilePaneKeydown));

    const sectionSaveUnits = computed(() => {
      const id = selectedSection.value?.id || "";
      const title = selectedSection.value?.title || "";
      const units = [];
      if (id === "persona" && personaDirty.value) {
        units.push({ key: "persona", label: t("settings_persona_title"), save: () => savePersona({ notify: false }) });
      }
      if (id === "agent") {
        if (llmDirty.value) {
          units.push({ key: "llm", label: title, save: () => saveAgentSettings("llm", { notify: false }) });
        }
        for (const profile of state.llm.profiles) {
          if (!profile._draft && profileDirty(profile)) {
            units.push({
              key: `profile:${profile._key}`,
              label: trimText(profile.name) || title,
              save: () => saveLLMProfile(profile._key, null, { notify: false }),
            });
          }
        }
      }
      if (id === "tools" && toolsDirty.value) {
        units.push({ key: "tools", label: title, save: () => saveAgentSettings("tools", { notify: false }) });
      }
      const dirtyTargets = (CONSOLE_SECTION_TARGETS[id] || []).filter(([, dirty]) => dirty.value);
      if (dirtyTargets.length) {
        units.push({
          key: `console:${dirtyTargets.map(([target]) => target).join(",")}`,
          label: dirtyTargets.map(([, , labelKey]) => (labelKey ? t(labelKey) : title)).join(", "),
          // One request for all of the section's console targets.
          save: () => saveConsoleSettings(dirtyTargets.map(([target]) => target), { notify: false }),
        });
      }
      for (const scope of ["console", "agent", "system"]) {
        const panels = [...saveRegistryEntries.values()].filter((entry) => entry.scope === scope && entry.dirty());
        if (panels.length) {
          units.push({ key: `config:${scope}`, label: panels.map((entry) => entry.label()).join(", "), scope, panels });
        }
      }
      return units;
    });

    const sectionSaving = ref(false);
    const sectionSaveFailed = ref("");
    const sectionSaveBusy = computed(
      () =>
        sectionSaving.value ||
        agentLoading.value ||
        agentSaving.value ||
        consoleLoading.value ||
        consoleSaving.value ||
        personaLoading.value ||
        personaSaving.value ||
        systemLoading.value ||
        systemSaving.value,
    );

    watch(() => selectedSection.value?.id, () => {
      sectionSaveFailed.value = "";
    });

    // Leaving a section discards its drafts (see discardSettingsDrafts), so ask first when the
    // section has unsaved changes.
    const leaveDialogOpen = ref(false);
    let pendingLeavePath = "";
    let leaveConfirmed = false;

    function guardUnsavedSection(to) {
      if (leaveConfirmed) {
        leaveConfirmed = false;
        return true;
      }
      if (sectionSaveUnits.value.length === 0 || sectionSaving.value || to.path === route.path) {
        return true;
      }
      pendingLeavePath = to.fullPath;
      leaveDialogOpen.value = true;
      return false;
    }

    onBeforeRouteUpdate(guardUnsavedSection);
    onBeforeRouteLeave(guardUnsavedSection);

    const leaveDialogText = computed(() =>
      t("settings_unsaved_text", { items: sectionSaveUnits.value.map((unit) => unit.label).join(", ") })
    );
    const leaveDialogActions = computed(() => [
      {
        name: "stay",
        label: t("settings_unsaved_stay"),
        class: "outlined",
        action: () => {
          leaveDialogOpen.value = false;
          pendingLeavePath = "";
        },
      },
      {
        name: "discard",
        label: t("settings_unsaved_discard"),
        class: "danger",
        action: () => {
          const target = pendingLeavePath;
          leaveDialogOpen.value = false;
          pendingLeavePath = "";
          if (target) {
            leaveConfirmed = true;
            void router.push(target);
          }
        },
      },
    ]);

    async function saveSection() {
      const units = sectionSaveUnits.value;
      if (sectionSaveBusy.value || units.length === 0) {
        return;
      }
      sectionSaving.value = true;
      sectionSaveFailed.value = "";
      takeSavedApplyMode();
      try {
        // Collect every panel's changes before anything is sent: a save response replaces the shared
        // config values, which would otherwise reset the drafts of panels not yet saved.
        const configSaves = [];
        for (const unit of units.filter((item) => item.panels)) {
          try {
            configSaves.push({ unit, update: mergeConfigUpdates(unit.panels.map((panel) => panel.collectUpdate())) });
          } catch {
            sectionSaveFailed.value = unit.label;
            return;
          }
        }
        for (const unit of units.filter((item) => !item.panels)) {
          if (!(await unit.save())) {
            sectionSaveFailed.value = unit.label;
            return;
          }
        }
        for (const { unit, update } of configSaves) {
          if (!(await saveConfigSettings(unit.scope, update, { notify: false }))) {
            sectionSaveFailed.value = unit.label;
            return;
          }
        }
        toast.success(settingsSavedMessage({ apply_mode: takeSavedApplyMode() }));
      } finally {
        sectionSaving.value = false;
      }
    }
    const showIndexPane = computed(() => !isMobile.value || !mobilePanelVisible.value);
    const showPanelPane = computed(() => !isMobile.value || mobilePanelVisible.value);
    const mobileShowBack = computed(() => isMobile.value && mobilePanelVisible.value);
    const mobileBarTitle = computed(() =>
      mobileShowBack.value ? selectedSection.value?.title || t("settings_title") : t("settings_title")
    );
    const pageClass = computed(() => (isMobile.value ? "settings-page settings-page-mobile-split" : "settings-page"));
    const defaultProviderChoice = computed(() =>
      normalizeSetupProviderChoice(
        llmFieldValue(state.llm, llmEnvManaged.value, "inference_provider") ||
          llmFieldValue(state.llm, llmEnvManaged.value, "provider"),
        { allowEmpty: true },
      )
    );
    const defaultIsCodexProvider = computed(() => defaultProviderChoice.value === SETUP_PROVIDER_OPENAI_CODEX);
    const defaultCodexUsesAPIKey = computed(() =>
      setupOpenAICodexUsesAPIKey(
        llmFieldValue(state.llm, llmEnvManaged.value, "endpoint"),
        hasLLMFieldOrSecretValue(state.llm, llmEnvManaged.value, llmSecretFields.value, "api_key"),
      )
    );
    const defaultCodexAuthDisabled = computed(
      () =>
        trimText(llmFieldValue(state.llm, llmEnvManaged.value, "endpoint")) !== "" &&
        hasLLMFieldOrSecretValue(state.llm, llmEnvManaged.value, llmSecretFields.value, "api_key"),
    );
    const defaultIsXAIProvider = computed(() => defaultProviderChoice.value === SETUP_PROVIDER_XAI_OAUTH);
    const defaultIsProProvider = computed(() => defaultProviderChoice.value === SETUP_PROVIDER_MISTERMORPH_PRO);
    const codexOAuthInUse = computed(
      () =>
        (defaultIsCodexProvider.value && !defaultCodexUsesAPIKey.value) ||
        state.llm.profiles.some(
          (profile) =>
            profileProviderChoice(profile) === SETUP_PROVIDER_OPENAI_CODEX &&
            !profileUsesCodexAPIKey(profile),
        ),
    );
    const showCodexAuthCard = computed(() => {
      if (defaultIsCodexProvider.value) {
        return true;
      }
      return state.llm.profiles.some((profile) => profileProviderChoice(profile) === SETUP_PROVIDER_OPENAI_CODEX);
    });
    const showProAuthCard = computed(() => {
      if (!selectedEndpointIsConsole.value) {
        return false;
      }
      if (defaultIsProProvider.value) {
        return true;
      }
      return state.llm.profiles.some((profile) => profileProviderChoice(profile) === SETUP_PROVIDER_MISTERMORPH_PRO);
    });
    const showXAIAuthCard = computed(() => {
      if (!selectedEndpointIsConsole.value) {
        return false;
      }
      if (defaultIsXAIProvider.value) {
        return true;
      }
      return state.llm.profiles.some((profile) => profileProviderChoice(profile) === SETUP_PROVIDER_XAI_OAUTH);
    });
    const codexAuthSummary = computed(() => {
      if (codexAuthLoading.value) {
        return t("settings_codex_auth_loading");
      }
      return codexAuthStatus.logged_in
        ? t("settings_codex_auth_signed_in")
        : t("settings_codex_auth_signed_out");
    });
    const codexAuthButtonState = computed(() => {
      if (codexAuthLoading.value) {
        return "loading";
      }
      return codexAuthStatus.logged_in ? "signed-in" : "signed-out";
    });
    const codexAuthNeedsLogin = computed(() => codexAuthButtonState.value === "signed-out");
    const codexAuthButtonTitle = computed(() => `${t("settings_codex_auth_title")}: ${codexAuthSummary.value}`);
    const codexLoginExpiresLabel = computed(() =>
      codexLoginExpiresAt.value ? formatTime(codexLoginExpiresAt.value) : t("ttl_unknown")
    );
    const defaultShowCloudflareAccountField = computed(() => defaultProviderChoice.value === SETUP_PROVIDER_CLOUDFLARE);
    const defaultShowBedrockFields = computed(() => defaultProviderChoice.value === SETUP_PROVIDER_BEDROCK);
    const defaultCredentialFieldName = computed(() =>
      defaultShowCloudflareAccountField.value ? "cloudflare_api_token" : "api_key"
    );
    const profileOptions = computed(() =>
      state.llm.profiles
        .filter((profile) => !profile._draft)
        .map((profile) => ({
          id: profile._key,
          title: trimText(profile.name) || t("settings_agent_profile_placeholder"),
          value: trimText(profile.name),
          note: trimText(profile.model),
        }))
        .filter((item) => item.value !== "")
    );
    // Routes can also name the top-level model, which is the "default" profile.
    const routeProfileOptions = computed(() => [
      { title: "default", value: "default", note: trimText(state.llm.model) },
      ...profileOptions.value.filter((item) => item.value !== "default"),
    ]);
    function profileValidationError(profile) {
      const name = trimText(profile?.name);
      if (!name) {
        return t("settings_agent_profile_name_required");
      }
      if (name.toLowerCase() === "default") {
        return t("settings_agent_profile_name_reserved");
      }
      const matches = state.llm.profiles.filter(
        (item) => item._key !== profile?._key && trimText(item?.name).toLowerCase() === name.toLowerCase(),
      );
      if (matches.length > 0) {
        return t("settings_agent_profile_name_duplicate", { name });
      }
      if (profileProviderChoice(profile) === "") {
        return t("settings_agent_profile_provider_required");
      }
      try {
        const headers = JSON.parse(profile.headers_text || "{}");
        if (!headers || Array.isArray(headers) || typeof headers !== "object") {
          return "HTTP headers must be a JSON object.";
        }
      } catch {
        return "HTTP headers must be valid JSON.";
      }
      return "";
    }
    function profileDirty(profile) {
      return (
        profile?._secretDirty?.size > 0 ||
        JSON.stringify(serializeLLMProfile(profile)) !== String(profile?._savedSnapshot || "")
      );
    }
    function profileIsInUse(profile) {
      const currentProfile = trimText(state.llm.current_profile);
      const savedProfileName = trimText(profile?._savedName);
      return currentProfile !== "" && savedProfileName !== "" && savedProfileName === currentProfile;
    }
    const agentValidationError = computed(() => {
      if (
        !hasLLMFieldValue(state.llm, llmEnvManaged.value, "inference_provider") &&
        !hasLLMFieldValue(state.llm, llmEnvManaged.value, "provider")
      ) {
        return "";
      }
      const seen = new Set();
      for (const profile of state.llm.profiles) {
        const savedName = trimText(profile?._savedName);
        if (savedName) {
          seen.add(savedName.toLowerCase());
        }
      }
      for (const fallback of state.llm.fallback_profiles) {
        const name = trimText(fallback);
        if (!name) {
          return t("settings_agent_fallback_required");
        }
        if (!seen.has(name.toLowerCase())) {
          return t("settings_agent_fallback_unknown", { name });
        }
      }
      return "";
    });
    const deleteProfileTarget = computed(() =>
      state.llm.profiles.find((item) => item._key === deleteProfileTargetKey.value) || null
    );
    const deleteProfileDialogText = computed(() =>
      t("settings_agent_profile_delete_confirm", {
        name: trimText(deleteProfileTarget.value?.name) || t("settings_agent_profile_placeholder"),
      })
    );
    const deleteProfileDialogActions = computed(() => [
      {
        name: "cancel",
        label: t("action_cancel"),
        class: "outlined",
        action: closeDeleteProfileDialog,
      },
      {
        name: "delete",
        label: t("action_delete"),
        class: "danger",
        action: deleteLLMProfile,
      },
    ]);
    const testConnectionDisabled = computed(
      () =>
        testConnectionLoading.value ||
        agentLoading.value ||
        agentSaving.value ||
        defaultProviderChoice.value === "" ||
        !hasLLMFieldValue(state.llm, llmEnvManaged.value, "model") ||
        (defaultIsCodexProvider.value && !defaultCodexUsesAPIKey.value && !codexAuthStatus.logged_in) ||
        (selectedEndpointIsConsole.value && defaultIsXAIProvider.value && !xaiAuthReady.value) ||
        (selectedEndpointIsConsole.value && defaultIsProProvider.value && !proAuthStatus.logged_in) ||
        (setupProviderRequiresAPIKey(defaultProviderChoice.value) &&
          !hasLLMFieldOrSecretValue(state.llm, llmEnvManaged.value, llmSecretFields.value, defaultCredentialFieldName.value)) ||
        (defaultShowBedrockFields.value &&
          !hasLLMFieldOrSecretValue(state.llm, llmEnvManaged.value, llmSecretFields.value, "bedrock_aws_key")) ||
        (defaultShowBedrockFields.value &&
          !hasLLMFieldOrSecretValue(state.llm, llmEnvManaged.value, llmSecretFields.value, "bedrock_aws_secret")) ||
        (defaultShowBedrockFields.value &&
          !hasLLMFieldValue(state.llm, llmEnvManaged.value, "bedrock_region")) ||
        (defaultShowCloudflareAccountField.value &&
          !hasLLMFieldOrSecretValue(state.llm, llmEnvManaged.value, llmSecretFields.value, "cloudflare_api_token")) ||
        (defaultShowCloudflareAccountField.value &&
          !hasLLMFieldValue(state.llm, llmEnvManaged.value, "cloudflare_account_id"))
    );
    const currentTestTargetProfile = computed(() =>
      state.llm.profiles.find((item) => item._key === testConnectionTargetProfileKey.value) || null
    );
    const llmSaveDisabled = computed(
      () =>
        agentLoading.value ||
        agentSaving.value ||
        agentSettingsReadOnly.value ||
        defaultProviderChoice.value === "" ||
        !llmDirty.value ||
        (defaultIsCodexProvider.value && !defaultCodexUsesAPIKey.value && !codexAuthStatus.logged_in) ||
        (selectedEndpointIsConsole.value && defaultIsXAIProvider.value && !xaiAuthReady.value) ||
        (selectedEndpointIsConsole.value && defaultIsProProvider.value && !proAuthStatus.logged_in) ||
        (setupProviderRequiresAPIKey(defaultProviderChoice.value) &&
          !hasLLMFieldOrSecretValue(state.llm, llmEnvManaged.value, llmSecretFields.value, defaultCredentialFieldName.value)) ||
        (defaultShowBedrockFields.value &&
          !hasLLMFieldOrSecretValue(state.llm, llmEnvManaged.value, llmSecretFields.value, "bedrock_aws_key")) ||
        (defaultShowBedrockFields.value &&
          !hasLLMFieldOrSecretValue(state.llm, llmEnvManaged.value, llmSecretFields.value, "bedrock_aws_secret")) ||
        (defaultShowBedrockFields.value &&
          !hasLLMFieldValue(state.llm, llmEnvManaged.value, "bedrock_region")) ||
        (defaultShowCloudflareAccountField.value &&
          !hasLLMFieldOrSecretValue(state.llm, llmEnvManaged.value, llmSecretFields.value, "cloudflare_api_token")) ||
        (defaultShowCloudflareAccountField.value &&
          !hasLLMFieldValue(state.llm, llmEnvManaged.value, "cloudflare_account_id"))
    );
    function profileSaveDisabled(profile) {
      const provider = profileProviderChoice(profile);
      return (
        agentLoading.value ||
        agentSaving.value ||
        agentSettingsReadOnly.value ||
        !profileDirty(profile) ||
        profileValidationError(profile) !== "" ||
        (provider === SETUP_PROVIDER_OPENAI_CODEX &&
          !profileUsesCodexAPIKey(profile) &&
          !codexAuthStatus.logged_in) ||
        (selectedEndpointIsConsole.value && provider === SETUP_PROVIDER_XAI_OAUTH && !xaiAuthReady.value) ||
        (selectedEndpointIsConsole.value && provider === SETUP_PROVIDER_MISTERMORPH_PRO && !proAuthStatus.logged_in)
      );
    }
    const toolsSaveDisabled = computed(
      () => agentLoading.value || agentSaving.value || agentSettingsReadOnly.value || !toolsDirty.value
    );
    const mcpValidationError = computed(() => {
      const names = new Set();
      for (const server of state.mcp.servers) {
        const name = trimText(server?.name);
        if (!name) {
          return t("settings_mcp_error_name_required");
        }
        const nameKey = name.toLowerCase();
        if (names.has(nameKey)) {
          return t("settings_mcp_error_name_duplicate", { name });
        }
        names.add(nameKey);
        if (server?.enable !== false && server?.type === "http" && !trimText(server?.url)) {
          return t("settings_mcp_error_url_required", { name });
        }
        if (server?.enable !== false && server?.type !== "http" && !trimText(server?.command)) {
          return t("settings_mcp_error_command_required", { name });
        }
        for (const rows of [server?.env_rows, server?.header_rows]) {
          const keys = new Set();
          for (const row of Array.isArray(rows) ? rows : []) {
            const key = trimText(row?.key);
            if (!key) {
              return t("settings_mcp_error_key_required", { name });
            }
            const normalized = key.toLowerCase();
            if (keys.has(normalized)) {
              return t("settings_mcp_error_key_duplicate", { name, key });
            }
            keys.add(normalized);
          }
        }
      }
      return "";
    });
    const mcpSaveDisabled = computed(
      () =>
        agentLoading.value ||
        agentSaving.value ||
        agentSettingsReadOnly.value ||
        !mcpDirty.value ||
        mcpValidationError.value !== ""
    );
    const consoleDirty = computed(
      () =>
        consoleManagedDirty.value ||
        consoleTelegramDirty.value ||
        consoleSlackDirty.value ||
        consoleLineDirty.value ||
        consoleLarkDirty.value ||
        consoleMixinDirty.value ||
        consoleDiscordDirty.value ||
        consoleWhatsAppDirty.value ||
        consoleGuardDirty.value
    );
    const consoleSaveDisabled = computed(
      () => consoleLoading.value || consoleSaving.value || !consoleManagedDirty.value
    );
    const telegramSaveDisabled = computed(
      () => consoleLoading.value || consoleSaving.value || !consoleTelegramDirty.value
    );
    const slackSaveDisabled = computed(
      () => consoleLoading.value || consoleSaving.value || !consoleSlackDirty.value
    );
    const lineSaveDisabled = computed(
      () => consoleLoading.value || consoleSaving.value || !consoleLineDirty.value
    );
    const larkSaveDisabled = computed(
      () => consoleLoading.value || consoleSaving.value || !consoleLarkDirty.value
    );
    const mixinSaveDisabled = computed(
      () => consoleLoading.value || consoleSaving.value || !consoleMixinDirty.value
    );
    const discordSaveDisabled = computed(
      () => consoleLoading.value || consoleSaving.value || !consoleDiscordDirty.value
    );
    const whatsappSaveDisabled = computed(
      () => consoleLoading.value || consoleSaving.value || !consoleWhatsAppDirty.value
    );
    const guardSaveDisabled = computed(
      () => consoleLoading.value || consoleSaving.value || !consoleGuardDirty.value
    );
    const personaIdentityDirty = computed(() => buildPersonaIdentitySnapshot(state.persona) !== loadedIdentitySnapshot.value);
    const personaSoulDirty = computed(() => normalizeSoulDocument(soulContent.value) !== loadedSoulSnapshot.value);
    const personaDirty = computed(() => personaIdentityDirty.value || personaSoulDirty.value);
    const personaSaveDisabled = computed(() => personaLoading.value || personaSaving.value || !personaDirty.value);
    const personaAvatarDisabled = computed(() => personaLoading.value || personaSaving.value || personaAvatarBusy.value);
    const personaEditorMeta = computed(() =>
      t("settings_persona_soul_editor_meta", {
        lines: lineCount(soulContent.value),
        chars: soulContent.value.length,
      })
    );
    const desktopCheckDisabled = computed(() => desktopLoading.value || desktopChecking.value);
    const desktopDisplayedCurrentVersion = computed(
      () => trimText(desktopUpdateResult.value?.current_version) || trimText(desktopCurrentVersion.value) || "dev"
    );
    function updateChannelLabel(channel) {
      const value = trimText(channel);
      if (value === "community" || value === "pro") {
        return t(`settings_update_channel_${value}`);
      }
      return value;
    }
    function displayVersion(version) {
      const value = trimText(version);
      if (!value || value.toLowerCase() === "dev") {
        return "dev";
      }
      return value.startsWith("v") ? value : `v${value}`;
    }
    const desktopInstalledText = computed(() => {
      const version = displayVersion(desktopDisplayedCurrentVersion.value);
      const channel = updateChannelLabel(desktopBuildChannel.value);
      return channel ? `${version} · ${channel}` : version;
    });
    // idle → not checked yet; current, available, unknown (dev build), or error after a check.
    const desktopUpdateState = computed(() => {
      if (desktopChecking.value) return "checking";
      if (desktopUpdateError.value) return "error";
      const result = desktopUpdateResult.value;
      if (!result) return "idle";
      if (result.update_available === true || result.channel_switch === true) return "available";
      if (result.status === "current_version_unknown") return "unknown";
      return "current";
    });
    const desktopUpdateStateText = computed(() => {
      const result = desktopUpdateResult.value;
      const version = displayVersion(result?.latest_version);
      const channel = updateChannelLabel(result?.channel);
      switch (desktopUpdateState.value) {
        case "checking":
          return t("settings_update_checking");
        case "error":
          return t("settings_update_failed", { error: desktopUpdateError.value });
        case "available":
          return result?.channel_switch === true
            ? t("settings_update_switch_available", { channel, version })
            : t("settings_update_available", { version });
        case "unknown":
          return t("settings_update_dev_build", { channel, version });
        case "current":
          return t("settings_update_up_to_date", { channel });
        default:
          return t("settings_update_not_checked");
      }
    });
    const desktopUpdateHasRelease = computed(() => {
      const state = desktopUpdateState.value;
      return (state === "available" || state === "unknown") && Boolean(trimText(desktopUpdateResult.value?.latest_version));
    });
    const desktopUpdateReleaseTitle = computed(() => {
      const result = desktopUpdateResult.value;
      return t("settings_update_release_title", {
        channel: updateChannelLabel(result?.channel),
        version: displayVersion(result?.latest_version),
      });
    });
    const desktopUpdateReleaseDate = computed(() => {
      const raw = trimText(desktopUpdateResult.value?.release_date);
      const date = raw ? new Date(raw) : null;
      if (!date || Number.isNaN(date.getTime())) return "";
      try {
        return new Intl.DateTimeFormat(lang.value || undefined, { dateStyle: "medium" }).format(date);
      } catch {
        return date.toISOString().slice(0, 10);
      }
    });
    // GoReleaser notes start with a "## Changelog" heading and full commit hashes; drop the
    // heading and shorten the hashes so the notes read as a plain list.
    const desktopUpdateNotesSource = computed(() =>
      String(desktopUpdateResult.value?.release_notes || "")
        .replace(/^\s*#{1,6}\s*changelog\s*$/im, "")
        .replace(/^(\s*[-*+]\s+)([0-9a-f]{40})\b/gim, (_, bullet, sha) => `${bullet}\`${sha.slice(0, 7)}\``)
        .trim()
    );
    const desktopUpdateChecksum = computed(() => trimText(desktopUpdateResult.value?.checksum));
    const desktopUpdateChecksumShort = computed(() => {
      const value = desktopUpdateChecksum.value.replace(/^sha256:/i, "");
      return value.length > 24 ? `${value.slice(0, 12)}…${value.slice(-8)}` : value;
    });
    const desktopUpdateAssetURL = computed(() => trimText(desktopUpdateResult.value?.asset_url));
    // The release card offers the build whenever there is one: an update, a channel switch, or the
    // latest release for a development build.
    const desktopUpdateDownloadDisabled = computed(() => !desktopUpdateAssetURL.value);
    let agentSettingsRequestSeq = 0;
    let personaSettingsRequestSeq = 0;
    let consoleSettingsRequestSeq = 0;
    let desktopSettingsRequestSeq = 0;

    function resetAgentSettingsState() {
      Object.assign(state.llm, buildEmptyLLMForm());
      state.llm.current_profile = "";
      state.llm.profiles = [];
      state.llm.fallback_profiles = [];
      state.tools.write_file = true;
      state.tools.spawn = true;
      state.tools.coder = false;
      state.tools.contacts_send = true;
      state.tools.todo_update = true;
      state.tools.plan_create = true;
      state.tools.url_fetch = true;
      state.tools.web_search = true;
      state.tools.bash = true;
      state.tools.powershell = false;
      state.tools.image_generate = true;
      state.tools.image_edit = true;
      state.tools.skill_install_preview = false;
      state.tools.skill_install = false;
      state.mcp.servers = [];
      llmEnvManaged.value = {};
      llmSecretFields.value = {};
      llmSecretDirty.clear();
      agentSettingsReadOnly.value = false;
      agentSettingsReadOnlyReason.value = "";
      llmConfigPath.value = "";
      settingsConfigRevision.value = "";
      agentConfigValues.value = {};
      agentFieldStates.value = {};
      agentValidationVisible.value = false;
      clearLoadedAgentSnapshots();
    }

    function agentSettingsErrorMessage(err, endpointRef, fallbackKey) {
      if (trimText(endpointRef) !== LOCAL_CONSOLE_ENDPOINT_REF && err?.status === 404) {
        return t("settings_agent_endpoint_unsupported");
      }
      return err?.message || t(fallbackKey);
    }

    function isCurrentAgentSettingsRequest(seq, endpointRef) {
      return seq === agentSettingsRequestSeq && trimText(endpointRef) === settingsEndpointRef.value;
    }

    function isCurrentPersonaSettingsRequest(seq, endpointRef) {
      return seq === personaSettingsRequestSeq && trimText(endpointRef) === settingsEndpointRef.value;
    }

    function isCurrentConsoleSettingsRequest(seq, endpointRef) {
      return seq === consoleSettingsRequestSeq && trimText(endpointRef) === settingsEndpointRef.value;
    }

    function isCurrentDesktopSettingsRequest(seq, endpointRef) {
      return seq === desktopSettingsRequestSeq && trimText(endpointRef) === consoleEndpointRef.value;
    }

    function applyPayload(data, options = {}) {
      const snapshotScope = String(options?.snapshotScope || currentAgentSnapshotScope());
      const llm = data?.llm && typeof data.llm === "object" ? data.llm : {};
      const envManagedPayload = data?.env_managed && typeof data.env_managed === "object" ? data.env_managed : {};
      const llmEnvManagedPayload =
        envManagedPayload?.llm && typeof envManagedPayload.llm === "object" ? envManagedPayload.llm : {};
      const llmProfileEnvManagedPayload =
        envManagedPayload?.llm_profiles && typeof envManagedPayload.llm_profiles === "object"
          ? envManagedPayload.llm_profiles
          : {};
      const secretFieldsPayload = data?.secret_fields && typeof data.secret_fields === "object" ? data.secret_fields : {};
      const llmSecretFieldsPayload =
        secretFieldsPayload?.llm && typeof secretFieldsPayload.llm === "object" ? secretFieldsPayload.llm : {};
      const llmProfileSecretFieldsPayload =
        secretFieldsPayload?.llm_profiles && typeof secretFieldsPayload.llm_profiles === "object"
          ? secretFieldsPayload.llm_profiles
          : {};
      const tools = data?.tools && typeof data.tools === "object" ? data.tools : {};
      const mcp = data?.mcp && typeof data.mcp === "object" ? data.mcp : {};
      const profiles = Array.isArray(llm.profiles) ? llm.profiles : [];
      agentSettingsReadOnly.value = data?.read_only === true;
      agentSettingsReadOnlyReason.value = agentSettingsReadOnly.value ? trimText(data?.read_only_reason) : "";
      if (typeof data?.config_revision === "string") {
        settingsConfigRevision.value = data.config_revision;
      }
      agentConfigValues.value = data?.config_values && typeof data.config_values === "object" ? data.config_values : {};
      agentFieldStates.value = data?.field_states && typeof data.field_states === "object" ? data.field_states : {};

      state.llm.inference_provider = normalizeSetupProviderChoice(llm.inference_provider || llm.provider, { allowEmpty: true });
      state.llm.provider = typeof llm.provider === "string" ? llm.provider : "";
      state.llm.endpoint = typeof llm.endpoint === "string" ? llm.endpoint : "";
      state.llm.model = typeof llm.model === "string" ? llm.model : "";
      state.llm.context_window_tokens = typeof llm.context_window_tokens === "string" ? llm.context_window_tokens : "";
      state.llm.supports_image_parts = typeof llm.supports_image_parts === "string" ? llm.supports_image_parts : "";
      agentConfigValues.value["llm.supports_image_parts"] = state.llm.supports_image_parts;
      state.llm.headers_text = JSON.stringify(llm.headers && typeof llm.headers === "object" ? llm.headers : {}, null, 2);
      state.llm.cache_ttl = typeof llm.cache_ttl === "string" ? llm.cache_ttl : "";
      state.llm.cache_key_prefix = typeof llm.cache_key_prefix === "string" ? llm.cache_key_prefix : "";
      state.llm.request_timeout = typeof llm.request_timeout === "string" ? llm.request_timeout : "";
      state.llm.temperature = typeof llm.temperature === "string" ? llm.temperature : "";
      state.llm.reasoning_budget_tokens = typeof llm.reasoning_budget_tokens === "string" ? llm.reasoning_budget_tokens : "";
      state.llm.api_key = typeof llm.api_key === "string" ? llm.api_key : "";
      state.llm.azure_deployment = typeof llm.azure_deployment === "string" ? llm.azure_deployment : "";
      state.llm.bedrock_aws_key = typeof llm.bedrock_aws_key === "string" ? llm.bedrock_aws_key : "";
      state.llm.bedrock_aws_secret = typeof llm.bedrock_aws_secret === "string" ? llm.bedrock_aws_secret : "";
      state.llm.bedrock_aws_session_token = typeof llm.bedrock_aws_session_token === "string" ? llm.bedrock_aws_session_token : "";
      state.llm.bedrock_aws_profile = typeof llm.bedrock_aws_profile === "string" ? llm.bedrock_aws_profile : "";
      state.llm.bedrock_region = typeof llm.bedrock_region === "string" ? llm.bedrock_region : "";
      state.llm.bedrock_model_arn = typeof llm.bedrock_model_arn === "string" ? llm.bedrock_model_arn : "";
      state.llm.cloudflare_api_token = typeof llm.cloudflare_api_token === "string" ? llm.cloudflare_api_token : "";
      state.llm.cloudflare_account_id = typeof llm.cloudflare_account_id === "string" ? llm.cloudflare_account_id : "";
      state.llm.reasoning_effort = typeof llm.reasoning_effort === "string" ? llm.reasoning_effort : "";
      state.llm.tools_emulation_mode = typeof llm.tools_emulation_mode === "string" ? llm.tools_emulation_mode : "off";
      state.llm.current_profile = typeof llm.current_profile === "string" ? llm.current_profile : "";
      state.llm.profiles = profiles.map((profile) =>
        buildLLMProfileState({
          name: trimText(profile?.name),
          _envManaged:
            llmProfileEnvManagedPayload?.[trimText(profile?.name)] &&
            typeof llmProfileEnvManagedPayload[trimText(profile?.name)] === "object"
              ? llmProfileEnvManagedPayload[trimText(profile?.name)]
              : {},
          _secretFields:
            llmProfileSecretFieldsPayload?.[trimText(profile?.name)] &&
            typeof llmProfileSecretFieldsPayload[trimText(profile?.name)] === "object"
              ? llmProfileSecretFieldsPayload[trimText(profile?.name)]
              : {},
          inference_provider: normalizeSetupProviderChoice(profile?.inference_provider || profile?.provider, { allowEmpty: true }),
          provider: typeof profile?.provider === "string" ? profile.provider : "",
          endpoint: typeof profile?.endpoint === "string" ? profile.endpoint : "",
          model: typeof profile?.model === "string" ? profile.model : "",
          context_window_tokens:
            typeof profile?.context_window_tokens === "string" ? profile.context_window_tokens : "",
          supports_image_parts:
            typeof profile?.supports_image_parts === "string" ? profile.supports_image_parts : "",
          headers: profile?.headers && typeof profile.headers === "object" ? profile.headers : {},
          cache_ttl: typeof profile?.cache_ttl === "string" ? profile.cache_ttl : "",
          cache_key_prefix: typeof profile?.cache_key_prefix === "string" ? profile.cache_key_prefix : "",
          request_timeout: typeof profile?.request_timeout === "string" ? profile.request_timeout : "",
          temperature: typeof profile?.temperature === "string" ? profile.temperature : "",
          reasoning_budget_tokens:
            typeof profile?.reasoning_budget_tokens === "string" ? profile.reasoning_budget_tokens : "",
          api_key: typeof profile?.api_key === "string" ? profile.api_key : "",
          azure_deployment: typeof profile?.azure_deployment === "string" ? profile.azure_deployment : "",
          bedrock_aws_key: typeof profile?.bedrock_aws_key === "string" ? profile.bedrock_aws_key : "",
          bedrock_aws_secret: typeof profile?.bedrock_aws_secret === "string" ? profile.bedrock_aws_secret : "",
          bedrock_aws_session_token:
            typeof profile?.bedrock_aws_session_token === "string" ? profile.bedrock_aws_session_token : "",
          bedrock_aws_profile:
            typeof profile?.bedrock_aws_profile === "string" ? profile.bedrock_aws_profile : "",
          bedrock_region: typeof profile?.bedrock_region === "string" ? profile.bedrock_region : "",
          bedrock_model_arn: typeof profile?.bedrock_model_arn === "string" ? profile.bedrock_model_arn : "",
          cloudflare_api_token:
            typeof profile?.cloudflare_api_token === "string" ? profile.cloudflare_api_token : "",
          cloudflare_account_id:
            typeof profile?.cloudflare_account_id === "string" ? profile.cloudflare_account_id : "",
          reasoning_effort: typeof profile?.reasoning_effort === "string" ? profile.reasoning_effort : "",
          tools_emulation_mode:
            typeof profile?.tools_emulation_mode === "string" ? profile.tools_emulation_mode : "",
        }),
      );
      state.llm.fallback_profiles = normalizeNamedList(llm.fallback_profiles);
      state.tools.write_file = toolEnabledValue(tools.write_file);
      state.tools.spawn = toolEnabledValue(tools.spawn);
      state.tools.coder = toolEnabledValue(tools.coder);
      state.tools.contacts_send = toolEnabledValue(tools.contacts_send);
      state.tools.todo_update = toolEnabledValue(tools.todo_update);
      state.tools.plan_create = toolEnabledValue(tools.plan_create);
      state.tools.url_fetch = toolEnabledValue(tools.url_fetch);
      state.tools.web_search = toolEnabledValue(tools.web_search);
      state.tools.bash = toolEnabledValue(tools.bash);
      state.tools.powershell = toolEnabledValue(tools.powershell);
      state.tools.image_generate = toolEnabledValue(tools.image_generate);
      state.tools.image_edit = toolEnabledValue(tools.image_edit);
      state.tools.skill_install_preview = toolEnabledValue(tools.skill_install_preview);
      state.tools.skill_install = toolEnabledValue(tools.skill_install);
      applyMCPPayload(mcp);
      llmEnvManaged.value = llmEnvManagedPayload;
      llmSecretFields.value = llmSecretFieldsPayload;
      llmSecretDirty.clear();

      agentValidationVisible.value = false;
      agentSettingsLoaded.value = true;
      setLoadedAgentSnapshots(snapshotScope);
    }

    function applyMCPPayload(mcp) {
      const payload = mcp && typeof mcp === "object" ? mcp : {};
      state.mcp.servers = (Array.isArray(payload.servers) ? payload.servers : []).map(buildMCPServerState);
    }

    async function saveMCPServers(servers) {
      if (agentSettingsReadOnly.value) {
        return;
      }
      state.mcp.servers = Array.isArray(servers) ? servers : [];
      updateMCPDirty();
      await saveAgentSettings("mcp");
    }

    function llmProfileEnvManaged(profile) {
      return profile?._envManaged && typeof profile._envManaged === "object" ? profile._envManaged : {};
    }

    function llmProfileSecretFields(profile) {
      return profile?._secretFields && typeof profile._secretFields === "object" ? profile._secretFields : {};
    }

    function secretConfigured(fields, field) {
      return fields?.[field]?.configured === true;
    }

    function hasLLMFieldOrSecretValue(config, envManaged, secretFields, field) {
      return hasLLMFieldValue(config, envManaged, field) || secretConfigured(secretFields, field);
    }

    function includeSecretValue(value, fields, dirty, field) {
      return dirty.has(field) || !secretConfigured(fields, field) ? trimText(value) : undefined;
    }

    function updateDefaultLLMField({ field, value }) {
      if (agentSettingsReadOnly.value) {
        return;
      }
      const key = String(field || "").trim();
      if (!key || !Object.prototype.hasOwnProperty.call(state.llm, key)) {
        return;
      }
      const nextValue = String(value || "");
      if (state.llm[key] === nextValue) {
        return;
      }
      state.llm[key] = nextValue;
      if (Object.prototype.hasOwnProperty.call(llmSecretFields.value, key)) {
        llmSecretDirty.add(key);
      }
      updateLLMDirty();
    }

    function updateProfileField(profileKey, { field, value }) {
      if (agentSettingsReadOnly.value) {
        return;
      }
      const profile = state.llm.profiles.find((item) => item._key === profileKey);
      const key = String(field || "").trim();
      if (!profile || !key || !Object.prototype.hasOwnProperty.call(profile, key)) {
        return;
      }
      const nextValue = String(value || "");
      if (profile[key] === nextValue) {
        return;
      }
      profile[key] = nextValue;
      if (Object.prototype.hasOwnProperty.call(llmProfileSecretFields(profile), key)) {
        profile._secretDirty.add(key);
      }
    }

    // The Add Profile dialog, shared by Models and Model Routes. The new profile lives in the list
    // as a draft (so the form, model picker and sign-in dialogs work by its key) but stays out of the
    // list, the save bar and route choices until Create saves it; Cancel removes it.
    const addProfileKey = ref("");
    const addProfileDraft = computed(
      () => state.llm.profiles.find((item) => item._key === addProfileKey.value && item._draft) || null
    );
    const addProfileOpen = computed({
      get: () => Boolean(addProfileDraft.value),
      set: (open) => {
        if (!open) cancelAddProfile();
      },
    });
    const addProfileError = computed(() => {
      const draft = addProfileDraft.value;
      return draft && trimText(draft.name) ? profileValidationError(draft) : "";
    });

    const addProfileSaving = computed(
      () => Boolean(addProfileDraft.value) && agentSavingTarget.value === `profile:${addProfileDraft.value._key}`
    );
    const addProfileSaveDisabled = computed(() => {
      const draft = addProfileDraft.value;
      return !draft || !trimText(draft.name) || profileSaveDisabled(draft);
    });

    function openAddProfileDialog() {
      if (agentSettingsReadOnly.value || agentLoading.value || addProfileDraft.value) {
        return;
      }
      const profile = buildLLMProfileState();
      profile._draft = true;
      state.llm.profiles.push(profile);
      addProfileKey.value = profile._key;
    }

    function cancelAddProfile() {
      const index = state.llm.profiles.findIndex((item) => item._key === addProfileKey.value && item._draft);
      if (index >= 0) {
        state.llm.profiles.splice(index, 1);
      }
      addProfileKey.value = "";
    }

    async function createProfile() {
      const draft = addProfileDraft.value;
      if (!draft) {
        return;
      }
      if (await saveLLMProfile(draft._key)) {
        delete draft._draft;
        addProfileKey.value = "";
      }
    }

    function addLLMProfile() {
      if (agentSettingsReadOnly.value) {
        return;
      }
      state.llm.profiles.push(buildLLMProfileState());
      updateLLMDirty();
    }

    function confirmRemoveLLMProfile(profileKey) {
      if (agentSettingsReadOnly.value) {
        return;
      }
      deleteProfileTargetKey.value = String(profileKey || "").trim();
      deleteProfileDialogOpen.value = deleteProfileTargetKey.value !== "";
    }

    function closeDeleteProfileDialog() {
      deleteProfileDialogOpen.value = false;
      deleteProfileTargetKey.value = "";
    }

    function removeLLMProfile(profileKey) {
      if (agentSettingsReadOnly.value) {
        return;
      }
      const index = state.llm.profiles.findIndex((item) => item._key === profileKey);
      if (index < 0) {
        return;
      }
      const [removed] = state.llm.profiles.splice(index, 1);
      const removedName = trimText(removed?.name);
      const savedName = trimText(removed?._savedName);
      const removedNames = new Set([removedName, savedName].filter(Boolean).map((name) => name.toLowerCase()));
      state.llm.fallback_profiles = state.llm.fallback_profiles.filter((item) => {
        const name = trimText(item);
        return name !== "" && !removedNames.has(name.toLowerCase());
      });
      updateLLMDirty();
    }

    async function deleteLLMProfile() {
      const profileKey = deleteProfileTargetKey.value;
      const profile = state.llm.profiles.find((item) => item._key === profileKey) || null;
      closeDeleteProfileDialog();
      if (!profile) {
        return;
      }
      const savedName = trimText(profile._savedName);
      if (!savedName) {
        removeLLMProfile(profileKey);
        return;
      }
      if (agentLoading.value || agentSaving.value || agentSettingsReadOnly.value) {
        return;
      }
      agentSaving.value = true;
      agentSavingTarget.value = `profile:${profileKey}`;
      const targetEndpointRef = settingsEndpointRef.value;
      try {
        const payload = await endpointApiFetch(targetEndpointRef, "/settings/agent", {
          method: "PUT",
          body: { config_revision: settingsConfigRevision.value, llm: { delete_profile: savedName } },
        });
        if (targetEndpointRef !== settingsEndpointRef.value) {
          return false;
        }
        llmConfigPath.value = typeof payload.config_path === "string" ? payload.config_path : llmConfigPath.value;
        settingsConfigRevision.value = trimText(payload?.config_revision) || settingsConfigRevision.value;
        removeLLMProfile(profileKey);
        updateLoadedFallbackProfile(savedName, "");
        if (targetEndpointRef === LOCAL_CONSOLE_ENDPOINT_REF) {
          invalidateConsoleSetupReadiness();
        }
        await loadEndpoints();
        toast.success(t("msg_delete_success"));
      } catch (e) {
        toast.error(agentSettingsErrorMessage(e, targetEndpointRef, "msg_delete_failed"));
      } finally {
        agentSaving.value = false;
        agentSavingTarget.value = "";
      }
    }

    function addFallbackProfile() {
      if (agentSettingsReadOnly.value) {
        return;
      }
      const firstProfile = profileOptions.value[0]?.value || "";
      if (!firstProfile) {
        return;
      }
      state.llm.fallback_profiles.push(firstProfile);
      updateLLMDirty();
    }

    function updateFallbackProfile(index, item) {
      if (agentSettingsReadOnly.value) {
        return;
      }
      if (index < 0 || index >= state.llm.fallback_profiles.length) {
        return;
      }
      state.llm.fallback_profiles[index] = trimText(item?.value);
      updateLLMDirty();
    }

    function removeFallbackProfile(index) {
      if (agentSettingsReadOnly.value) {
        return;
      }
      if (index < 0 || index >= state.llm.fallback_profiles.length) {
        return;
      }
      state.llm.fallback_profiles.splice(index, 1);
      updateLLMDirty();
    }

    function moveFallbackProfile(index, delta) {
      if (agentSettingsReadOnly.value) {
        return;
      }
      const nextIndex = index + delta;
      if (index < 0 || index >= state.llm.fallback_profiles.length || nextIndex < 0 || nextIndex >= state.llm.fallback_profiles.length) {
        return;
      }
      const items = [...state.llm.fallback_profiles];
      const [current] = items.splice(index, 1);
      items.splice(nextIndex, 0, current);
      state.llm.fallback_profiles = items;
      updateLLMDirty();
    }

    function buildProfilePayload(profile) {
      const envManaged = llmProfileEnvManaged(profile);
      const provider = normalizeSetupProviderChoice(
        llmFieldValue(profile, envManaged, "inference_provider") || llmFieldValue(profile, envManaged, "provider"),
        { allowEmpty: true },
      );
      const inferenceProviderRaw = llmFieldEnvRawValue(envManaged, "inference_provider");
      const providerRaw = llmFieldEnvRawValue(envManaged, "provider");
      const payload = {
        name: trimText(profile.name),
        inference_provider: providerRaw === "" ? inferenceProviderRaw || trimText(profile.inference_provider) : inferenceProviderRaw,
        provider: providerRaw,
        endpoint:
          setupProviderSupportsCustomAPIBase(provider)
            ? llmFieldEnvRawValue(envManaged, "endpoint") || trimText(profile.endpoint)
            : "",
        model: llmFieldEnvRawValue(envManaged, "model") || trimText(profile.model),
        context_window_tokens:
          llmFieldEnvRawValue(envManaged, "context_window_tokens") || trimText(profile.context_window_tokens),
        supports_image_parts: trimText(profile.supports_image_parts),
        headers: JSON.parse(profile.headers_text || "{}"),
        cache_ttl: trimText(profile.cache_ttl),
        cache_key_prefix: trimText(profile.cache_key_prefix),
        request_timeout: trimText(profile.request_timeout),
        temperature: trimText(profile.temperature),
        reasoning_budget_tokens: trimText(profile.reasoning_budget_tokens),
        azure_deployment: trimText(profile.azure_deployment),
        reasoning_effort:
          llmFieldEnvRawValue(envManaged, "reasoning_effort") || trimText(profile.reasoning_effort),
        tools_emulation_mode:
          llmFieldEnvRawValue(envManaged, "tools_emulation_mode") || trimText(profile.tools_emulation_mode),
      };
      if (provider === SETUP_PROVIDER_CLOUDFLARE) {
        const rawToken = llmFieldEnvRawValue(envManaged, "cloudflare_api_token");
        payload.cloudflare_api_token = rawToken || includeSecretValue(
          profile.cloudflare_api_token,
          llmProfileSecretFields(profile),
          profile._secretDirty,
          "cloudflare_api_token",
        );
        payload.cloudflare_account_id =
          llmFieldEnvRawValue(envManaged, "cloudflare_account_id") || trimText(profile.cloudflare_account_id);
        payload.api_key = "";
        payload.bedrock_aws_key = "";
        payload.bedrock_aws_secret = "";
        payload.bedrock_aws_session_token = "";
        payload.bedrock_aws_profile = "";
        payload.bedrock_region = "";
        payload.bedrock_model_arn = "";
      } else if (provider === SETUP_PROVIDER_BEDROCK) {
        const rawAWSKey = llmFieldEnvRawValue(envManaged, "bedrock_aws_key");
        const rawAWSSecret = llmFieldEnvRawValue(envManaged, "bedrock_aws_secret");
        const rawAWSSessionToken = llmFieldEnvRawValue(envManaged, "bedrock_aws_session_token");
        payload.bedrock_aws_key = rawAWSKey || includeSecretValue(
          profile.bedrock_aws_key,
          llmProfileSecretFields(profile),
          profile._secretDirty,
          "bedrock_aws_key",
        );
        payload.bedrock_aws_secret = rawAWSSecret || includeSecretValue(
          profile.bedrock_aws_secret,
          llmProfileSecretFields(profile),
          profile._secretDirty,
          "bedrock_aws_secret",
        );
        payload.bedrock_aws_session_token = rawAWSSessionToken || includeSecretValue(
          profile.bedrock_aws_session_token,
          llmProfileSecretFields(profile),
          profile._secretDirty,
          "bedrock_aws_session_token",
        );
        payload.bedrock_aws_profile = trimText(profile.bedrock_aws_profile);
        payload.bedrock_region =
          llmFieldEnvRawValue(envManaged, "bedrock_region") || trimText(profile.bedrock_region);
        payload.bedrock_model_arn =
          llmFieldEnvRawValue(envManaged, "bedrock_model_arn") || trimText(profile.bedrock_model_arn);
        payload.api_key = "";
        payload.cloudflare_api_token = "";
        payload.cloudflare_account_id = "";
      } else if (provider === SETUP_PROVIDER_OPENAI_CODEX) {
        const rawAPIKey = llmFieldEnvRawValue(envManaged, "api_key");
        payload.api_key = rawAPIKey || includeSecretValue(
          profile.api_key,
          llmProfileSecretFields(profile),
          profile._secretDirty,
          "api_key",
        );
        payload.cloudflare_api_token = "";
        payload.cloudflare_account_id = "";
        payload.bedrock_aws_key = "";
        payload.bedrock_aws_secret = "";
        payload.bedrock_aws_session_token = "";
        payload.bedrock_aws_profile = "";
        payload.bedrock_region = "";
        payload.bedrock_model_arn = "";
      } else if (
        provider === SETUP_PROVIDER_XAI_OAUTH ||
        provider === SETUP_PROVIDER_MISTERMORPH_PRO
      ) {
        payload.api_key = "";
        payload.cloudflare_api_token = "";
        payload.cloudflare_account_id = "";
        payload.bedrock_aws_key = "";
        payload.bedrock_aws_secret = "";
        payload.bedrock_aws_session_token = "";
        payload.bedrock_aws_profile = "";
        payload.bedrock_region = "";
        payload.bedrock_model_arn = "";
      } else {
        const rawAPIKey = llmFieldEnvRawValue(envManaged, "api_key");
        payload.api_key = rawAPIKey || includeSecretValue(
          profile.api_key,
          llmProfileSecretFields(profile),
          profile._secretDirty,
          "api_key",
        );
        payload.bedrock_aws_key = "";
        payload.bedrock_aws_secret = "";
        payload.bedrock_aws_session_token = "";
        payload.bedrock_aws_profile = "";
        payload.bedrock_region = "";
        payload.bedrock_model_arn = "";
        payload.cloudflare_api_token = "";
        payload.cloudflare_account_id = "";
      }
      return payload;
    }

    function buildDefaultLLMTestPayload() {
      const payload = {};
      const provider = normalizeSetupProviderChoice(
        llmFieldValue(state.llm, llmEnvManaged.value, "inference_provider") || llmFieldValue(state.llm, llmEnvManaged.value, "provider"),
        { allowEmpty: true },
      );
      const inferenceProviderRaw = llmFieldEnvRawValue(llmEnvManaged.value, "inference_provider");
      const providerRaw = llmFieldEnvRawValue(llmEnvManaged.value, "provider");
      if (inferenceProviderRaw !== "") {
        payload.inference_provider = inferenceProviderRaw;
      } else if (providerRaw !== "") {
        payload.provider = providerRaw;
      } else if (!isLLMFieldEnvManaged(llmEnvManaged.value, "inference_provider") && provider !== "") {
        payload.inference_provider = state.llm.inference_provider;
      }
      const endpointRaw = llmFieldEnvRawValue(llmEnvManaged.value, "endpoint");
      if (endpointRaw !== "") {
        payload.endpoint = endpointRaw;
      } else if (!setupProviderSupportsCustomAPIBase(provider)) {
        payload.endpoint = "";
      } else if (!isLLMFieldEnvManaged(llmEnvManaged.value, "endpoint")) {
        const endpoint = trimText(state.llm.endpoint);
        if (endpoint !== "") {
          payload.endpoint = endpoint;
        }
      }
      const modelRaw = llmFieldEnvRawValue(llmEnvManaged.value, "model");
      if (modelRaw !== "") {
        payload.model = modelRaw;
      } else if (!isLLMFieldEnvManaged(llmEnvManaged.value, "model")) {
        const model = trimText(state.llm.model);
        if (model !== "") {
          payload.model = model;
        }
      }
      const contextWindowRaw = llmFieldEnvRawValue(llmEnvManaged.value, "context_window_tokens");
      if (contextWindowRaw !== "") {
        payload.context_window_tokens = contextWindowRaw;
      } else if (!isLLMFieldEnvManaged(llmEnvManaged.value, "context_window_tokens")) {
        const contextWindowTokens = trimText(state.llm.context_window_tokens);
        if (contextWindowTokens !== "") {
          payload.context_window_tokens = contextWindowTokens;
        }
      }
      const reasoningEffortRaw = llmFieldEnvRawValue(llmEnvManaged.value, "reasoning_effort");
      if (reasoningEffortRaw !== "") {
        payload.reasoning_effort = reasoningEffortRaw;
      } else if (!isLLMFieldEnvManaged(llmEnvManaged.value, "reasoning_effort")) {
        const reasoningEffort = trimText(state.llm.reasoning_effort);
        if (reasoningEffort !== "") {
          payload.reasoning_effort = reasoningEffort;
        }
      }
      const toolsEmulationModeRaw = llmFieldEnvRawValue(llmEnvManaged.value, "tools_emulation_mode");
      if (toolsEmulationModeRaw !== "") {
        payload.tools_emulation_mode = toolsEmulationModeRaw;
      } else if (!isLLMFieldEnvManaged(llmEnvManaged.value, "tools_emulation_mode")) {
        const toolsEmulationMode = trimText(state.llm.tools_emulation_mode);
        if (toolsEmulationMode !== "") {
          payload.tools_emulation_mode = toolsEmulationMode;
        }
      }
      if (provider === SETUP_PROVIDER_BEDROCK) {
        const awsKeyRaw = llmFieldEnvRawValue(llmEnvManaged.value, "bedrock_aws_key");
        if (awsKeyRaw !== "") {
          payload.bedrock_aws_key = awsKeyRaw;
        } else if (!isLLMFieldEnvManaged(llmEnvManaged.value, "bedrock_aws_key")) {
          const value = trimText(state.llm.bedrock_aws_key);
          if (value !== "") {
            payload.bedrock_aws_key = value;
          }
        }
        const awsSecretRaw = llmFieldEnvRawValue(llmEnvManaged.value, "bedrock_aws_secret");
        if (awsSecretRaw !== "") {
          payload.bedrock_aws_secret = awsSecretRaw;
        } else if (!isLLMFieldEnvManaged(llmEnvManaged.value, "bedrock_aws_secret")) {
          const value = trimText(state.llm.bedrock_aws_secret);
          if (value !== "") {
            payload.bedrock_aws_secret = value;
          }
        }
        const regionRaw = llmFieldEnvRawValue(llmEnvManaged.value, "bedrock_region");
        if (regionRaw !== "") {
          payload.bedrock_region = regionRaw;
        } else if (!isLLMFieldEnvManaged(llmEnvManaged.value, "bedrock_region")) {
          const value = trimText(state.llm.bedrock_region);
          if (value !== "") {
            payload.bedrock_region = value;
          }
        }
        const modelARNRaw = llmFieldEnvRawValue(llmEnvManaged.value, "bedrock_model_arn");
        if (modelARNRaw !== "") {
          payload.bedrock_model_arn = modelARNRaw;
        } else if (!isLLMFieldEnvManaged(llmEnvManaged.value, "bedrock_model_arn")) {
          const value = trimText(state.llm.bedrock_model_arn);
          if (value !== "") {
            payload.bedrock_model_arn = value;
          }
        }
      } else if (provider === SETUP_PROVIDER_CLOUDFLARE) {
        const tokenRaw = llmFieldEnvRawValue(llmEnvManaged.value, "cloudflare_api_token");
        if (tokenRaw !== "") {
          payload.cloudflare_api_token = tokenRaw;
        } else if (!isLLMFieldEnvManaged(llmEnvManaged.value, "cloudflare_api_token")) {
          const token = trimText(state.llm.cloudflare_api_token);
          if (token !== "") {
            payload.cloudflare_api_token = token;
          }
        }
        const accountIDRaw = llmFieldEnvRawValue(llmEnvManaged.value, "cloudflare_account_id");
        if (accountIDRaw !== "") {
          payload.cloudflare_account_id = accountIDRaw;
        } else if (!isLLMFieldEnvManaged(llmEnvManaged.value, "cloudflare_account_id")) {
          const accountID = trimText(state.llm.cloudflare_account_id);
          if (accountID !== "") {
            payload.cloudflare_account_id = accountID;
          }
        }
      } else if (provider === SETUP_PROVIDER_OPENAI_CODEX) {
        const apiKeyRaw = llmFieldEnvRawValue(llmEnvManaged.value, "api_key");
        if (apiKeyRaw !== "") {
          payload.api_key = apiKeyRaw;
        } else if (!isLLMFieldEnvManaged(llmEnvManaged.value, "api_key")) {
          const apiKey = trimText(state.llm.api_key);
          if (apiKey !== "") {
            payload.api_key = apiKey;
          }
        }
        payload.cloudflare_api_token = "";
        payload.cloudflare_account_id = "";
        payload.bedrock_aws_key = "";
        payload.bedrock_aws_secret = "";
        payload.bedrock_region = "";
        payload.bedrock_model_arn = "";
      } else if (
        provider === SETUP_PROVIDER_XAI_OAUTH ||
        provider === SETUP_PROVIDER_MISTERMORPH_PRO
      ) {
        payload.api_key = "";
        payload.cloudflare_api_token = "";
        payload.cloudflare_account_id = "";
        payload.bedrock_aws_key = "";
        payload.bedrock_aws_secret = "";
        payload.bedrock_region = "";
        payload.bedrock_model_arn = "";
      } else {
        const apiKeyRaw = llmFieldEnvRawValue(llmEnvManaged.value, "api_key");
        if (apiKeyRaw !== "") {
          payload.api_key = apiKeyRaw;
        } else if (!isLLMFieldEnvManaged(llmEnvManaged.value, "api_key")) {
          const apiKey = trimText(state.llm.api_key);
          if (apiKey !== "") {
            payload.api_key = apiKey;
          }
        }
      }
      return payload;
    }

    async function loadAgentSettings(endpointRef = settingsEndpointRef.value) {
      const requestSeq = ++agentSettingsRequestSeq;
      const targetEndpointRef = trimText(endpointRef) || LOCAL_CONSOLE_ENDPOINT_REF;
      agentLoading.value = true;
      agentSettingsReadOnly.value = false;
      agentSettingsReadOnlyReason.value = "";
      try {
        const data = await endpointApiFetch(targetEndpointRef, "/settings/agent");
        if (!isCurrentAgentSettingsRequest(requestSeq, targetEndpointRef)) {
          return;
        }
        llmConfigPath.value = typeof data.config_path === "string" ? data.config_path : "";
        applyPayload(data);
      } catch (e) {
        if (!isCurrentAgentSettingsRequest(requestSeq, targetEndpointRef)) {
          return;
        }
        toast.error(agentSettingsErrorMessage(e, targetEndpointRef, "msg_load_failed"));
      } finally {
        if (isCurrentAgentSettingsRequest(requestSeq, targetEndpointRef)) {
          agentLoading.value = false;
        }
      }
    }

    function applyCodexAuthStatus(payload) {
      const status = payload && typeof payload.status === "object" ? payload.status : payload;
      codexAuthStatus.logged_in = status?.logged_in === true;
      codexAuthStatus.access_token_present = status?.access_token_present === true;
      codexAuthStatus.refresh_token_present = status?.refresh_token_present === true;
      codexAuthStatus.access_token_expired = status?.access_token_expired === true;
      codexAuthStatus.expires_at = typeof status?.expires_at === "string" ? status.expires_at : "";
      codexAuthStatus.account_id = typeof status?.account_id === "string" ? status.account_id : "";
      codexAuthStatus.file_mode_ok = status?.file_mode_ok !== false;
      codexAuthStatus.file_mode_warning = typeof status?.file_mode_warning === "string" ? status.file_mode_warning : "";
    }

    function resetCodexAuthStatus() {
      Object.assign(codexAuthStatus, {
        logged_in: false,
        access_token_present: false,
        refresh_token_present: false,
        access_token_expired: false,
        expires_at: "",
        account_id: "",
        file_mode_ok: true,
        file_mode_warning: "",
      });
    }

    function isCurrentCodexAuthStatusRequest(requestSeq, endpointRef) {
      return requestSeq === codexAuthStatusRequestSeq && endpointRef === settingsEndpointRef.value;
    }

    async function loadCodexAuthStatus(endpointRef = settingsEndpointRef.value) {
      const targetEndpointRef = trimText(endpointRef) || LOCAL_CONSOLE_ENDPOINT_REF;
      const requestSeq = ++codexAuthStatusRequestSeq;
      codexAuthLoading.value = true;
      codexAuthError.value = "";
      try {
        let payload = await endpointApiFetch(targetEndpointRef, "/auth/codex/status");
        if (!isCurrentCodexAuthStatusRequest(requestSeq, targetEndpointRef)) {
          return;
        }
        applyCodexAuthStatus(payload);
        const status = payload && typeof payload.status === "object" ? payload.status : payload;
        if (
          codexOAuthInUse.value &&
          status?.refresh_token_present === true &&
          (status?.access_token_present !== true || status?.access_token_expired === true)
        ) {
          payload = await endpointApiFetch(targetEndpointRef, "/auth/codex/refresh", { method: "POST" });
          if (!isCurrentCodexAuthStatusRequest(requestSeq, targetEndpointRef)) {
            return;
          }
          applyCodexAuthStatus(payload);
        }
      } catch (e) {
        if (isCurrentCodexAuthStatusRequest(requestSeq, targetEndpointRef)) {
          codexAuthError.value = e?.message || t("msg_load_failed");
        }
      } finally {
        if (isCurrentCodexAuthStatusRequest(requestSeq, targetEndpointRef)) {
          codexAuthLoading.value = false;
        }
      }
    }

    async function openCodexAuthDialog() {
      const targetEndpointRef = settingsEndpointRef.value;
      const shouldStartLogin = codexAuthNeedsLogin.value && !codexLoginSession.value && !codexAuthBusy.value;
      let authWindow = null;
      if (shouldStartLogin && !canOpenExternalURLInDesktop()) {
        // Open synchronously from the click event so popup blockers allow the auth tab.
        authWindow = openExternalPlaceholder();
      }
      await openReentrantDialog(codexAuthDialogOpen);
      void loadCodexAuthStatus(targetEndpointRef);
      if (shouldStartLogin) {
        void startCodexLogin(authWindow, targetEndpointRef);
      }
    }

    function clearCodexLoginTimer() {
      if (codexLoginPollTimer) {
        clearTimeout(codexLoginPollTimer);
        codexLoginPollTimer = 0;
      }
    }

    function resetCodexLoginSession() {
      clearCodexLoginTimer();
      codexLoginSession.value = "";
      codexLoginEndpointRef.value = "";
      codexLoginVerificationURL.value = "";
      codexLoginUserCode.value = "";
      codexLoginExpiresAt.value = "";
    }

    function cancelCodexAuthFlow() {
      codexAuthOperationSeq += 1;
      codexAuthBusy.value = false;
      resetCodexLoginSession();
    }

    function resetCodexAuthEndpointState() {
      codexAuthStatusRequestSeq += 1;
      codexAuthLoading.value = false;
      codexAuthError.value = "";
      codexAuthDialogOpen.value = false;
      cancelCodexAuthFlow();
      resetCodexAuthStatus();
    }

    function scheduleCodexLoginPoll(intervalSeconds = 5) {
      clearCodexLoginTimer();
      const delay = Math.max(2, Number(intervalSeconds) || 5) * 1000;
      codexLoginPollTimer = window.setTimeout(() => {
        void pollCodexLogin();
      }, delay);
    }

    async function startCodexLogin(authWindow = null, endpointRef = settingsEndpointRef.value) {
      if (codexAuthBusy.value) {
        if (authWindow && !authWindow.closed) {
          authWindow.close();
        }
        return;
      }
      const targetEndpointRef = trimText(endpointRef) || LOCAL_CONSOLE_ENDPOINT_REF;
      const operationSeq = ++codexAuthOperationSeq;
      codexAuthBusy.value = true;
      codexAuthError.value = "";
      resetCodexLoginSession();
      codexLoginEndpointRef.value = targetEndpointRef;
      let authWindowUsed = false;
      try {
        const payload = await endpointApiFetch(targetEndpointRef, "/auth/codex/login/start", { method: "POST" });
        if (
          operationSeq !== codexAuthOperationSeq ||
          targetEndpointRef !== settingsEndpointRef.value ||
          targetEndpointRef !== codexLoginEndpointRef.value
        ) {
          return;
        }
        codexLoginSession.value = String(payload?.session_id || "").trim();
        codexLoginVerificationURL.value = String(payload?.verification_url || "").trim();
        codexLoginUserCode.value = String(payload?.user_code || "").trim();
        codexLoginExpiresAt.value = String(payload?.expires_at || "").trim();
        if (codexLoginVerificationURL.value) {
          if (authWindow && !authWindow.closed) {
            authWindow.location.href = codexLoginVerificationURL.value;
            authWindowUsed = true;
          } else {
            openExternalURL(codexLoginVerificationURL.value);
          }
        }
        scheduleCodexLoginPoll(payload?.interval_seconds);
      } catch (e) {
        if (operationSeq === codexAuthOperationSeq && targetEndpointRef === settingsEndpointRef.value) {
          codexAuthError.value = e?.message || t("msg_load_failed");
        }
      } finally {
        if (!authWindowUsed && authWindow && !authWindow.closed) {
          authWindow.close();
        }
        if (operationSeq === codexAuthOperationSeq) {
          codexAuthBusy.value = false;
        }
      }
    }

    async function pollCodexLogin() {
      const sessionID = codexLoginSession.value;
      const targetEndpointRef = codexLoginEndpointRef.value;
      if (!sessionID || !targetEndpointRef || codexAuthBusy.value) {
        return;
      }
      if (targetEndpointRef !== settingsEndpointRef.value) {
        cancelCodexAuthFlow();
        return;
      }
      const operationSeq = ++codexAuthOperationSeq;
      codexAuthBusy.value = true;
      codexAuthError.value = "";
      try {
        const payload = await endpointApiFetch(targetEndpointRef, "/auth/codex/login/poll", {
          method: "POST",
          body: { session_id: sessionID, set_default: false },
        });
        if (
          operationSeq !== codexAuthOperationSeq ||
          targetEndpointRef !== settingsEndpointRef.value ||
          targetEndpointRef !== codexLoginEndpointRef.value
        ) {
          return;
        }
        if (payload?.pending === true) {
          scheduleCodexLoginPoll(5);
          return;
        }
        applyCodexAuthStatus(payload);
        resetCodexLoginSession();
        if (payload?.settings_updated === true) {
          invalidateConsoleSetupReadiness();
          await loadAgentSettings(targetEndpointRef);
        }
      } catch (e) {
        if (operationSeq === codexAuthOperationSeq && targetEndpointRef === settingsEndpointRef.value) {
          codexAuthError.value = e?.message || t("msg_load_failed");
        }
      } finally {
        if (operationSeq === codexAuthOperationSeq) {
          codexAuthBusy.value = false;
        }
      }
    }

    async function logoutCodexAuth() {
      if (codexAuthBusy.value) {
        return;
      }
      const targetEndpointRef = settingsEndpointRef.value;
      const operationSeq = ++codexAuthOperationSeq;
      codexAuthBusy.value = true;
      codexAuthError.value = "";
      try {
        const payload = await endpointApiFetch(targetEndpointRef, "/auth/codex/logout", { method: "POST" });
        if (operationSeq !== codexAuthOperationSeq || targetEndpointRef !== settingsEndpointRef.value) {
          return;
        }
        applyCodexAuthStatus(payload);
        resetCodexLoginSession();
      } catch (e) {
        if (operationSeq === codexAuthOperationSeq && targetEndpointRef === settingsEndpointRef.value) {
          codexAuthError.value = e?.message || t("msg_delete_failed");
        }
      } finally {
        if (operationSeq === codexAuthOperationSeq) {
          codexAuthBusy.value = false;
        }
      }
    }

    // Console scopes that keep their own draft in `state`. A save response rewrites all of them, so
    // edits in scopes that were not part of the save are captured first and put back afterwards.
    const CONSOLE_DRAFT_SCOPES = [
      { id: "runtimes", dirty: () => consoleManagedDirty.value, slice: () => state.managedRuntimes, sync: updateConsoleManagedDirty },
      { id: "telegram", dirty: () => consoleTelegramDirty.value, slice: () => state.telegram, sync: updateConsoleTelegramDirty },
      { id: "slack", dirty: () => consoleSlackDirty.value, slice: () => state.slack, sync: updateConsoleSlackDirty },
      { id: "line", dirty: () => consoleLineDirty.value, slice: () => state.line, sync: updateConsoleLineDirty },
      { id: "lark", dirty: () => consoleLarkDirty.value, slice: () => state.lark, sync: updateConsoleLarkDirty },
      { id: "mixin", dirty: () => consoleMixinDirty.value, slice: () => state.mixin, sync: updateConsoleMixinDirty },
      { id: "discord", dirty: () => consoleDiscordDirty.value, slice: () => state.discord, sync: updateConsoleDiscordDirty },
      { id: "whatsapp", dirty: () => consoleWhatsAppDirty.value, slice: () => state.whatsapp, sync: updateConsoleWhatsAppDirty },
      { id: "guard", dirty: () => consoleGuardDirty.value, slice: () => state.guard, sync: updateConsoleGuardDirty },
    ];

    // savedScopes: omit for a fresh load (everything is replaced); pass the scopes a save covered to
    // keep unsaved edits in every other scope.
    function applyConsolePayload(data, { savedScopes = null } = {}) {
      const unsaved = Array.isArray(savedScopes)
        ? captureUnsavedScopes(CONSOLE_DRAFT_SCOPES, savedScopes, consoleSecretDirty)
        : [];
      const values = Array.isArray(data?.managed_runtimes) ? data.managed_runtimes : [];
      const telegram = data?.telegram && typeof data.telegram === "object" ? data.telegram : {};
      const slack = data?.slack && typeof data.slack === "object" ? data.slack : {};
      const line = data?.line && typeof data.line === "object" ? data.line : {};
      const lark = data?.lark && typeof data.lark === "object" ? data.lark : {};
      const mixin = data?.mixin && typeof data.mixin === "object" ? data.mixin : {};
      const discord = data?.discord && typeof data.discord === "object" ? data.discord : {};
      const wechat = data?.wechat && typeof data.wechat === "object" ? data.wechat : {};
      const whatsapp = data?.whatsapp && typeof data.whatsapp === "object" ? data.whatsapp : {};
      const guard = data?.guard && typeof data.guard === "object" ? data.guard : {};
      const guardNetwork = guard?.network && typeof guard.network === "object" ? guard.network : {};
      const guardURLFetch =
        guardNetwork?.url_fetch && typeof guardNetwork.url_fetch === "object" ? guardNetwork.url_fetch : {};
      const guardRedaction = guard?.redaction && typeof guard.redaction === "object" ? guard.redaction : {};
      const guardApprovals = guard?.approvals && typeof guard.approvals === "object" ? guard.approvals : {};
      consoleEnvManaged.value = data?.env_managed && typeof data.env_managed === "object" ? data.env_managed : {};
      consoleSecretFields.value = data?.secret_fields && typeof data.secret_fields === "object" ? data.secret_fields : {};
      consoleSecretDirty.clear();
      if (typeof data?.config_revision === "string") {
        settingsConfigRevision.value = data.config_revision;
      }
      consoleConfigValues.value = data?.config_values && typeof data.config_values === "object" ? data.config_values : {};
      consoleFieldStates.value = data?.field_states && typeof data.field_states === "object" ? data.field_states : {};
      consoleEndpoints.value = Array.isArray(data?.endpoints) ? data.endpoints : [];
      authProfiles.value = Array.isArray(data?.auth_profiles) ? data.auth_profiles : [];
      for (const item of MANAGED_RUNTIME_ITEMS) {
        state.managedRuntimes[item.id] = values.includes(item.id);
      }
      state.telegram.bot_token = typeof telegram.bot_token === "string" ? telegram.bot_token : "";
      state.telegram.allowed_chat_ids_text = formatConfigList(telegram.allowed_chat_ids);
      state.telegram.group_trigger_mode = normalizeConsoleGroupTriggerMode(telegram.group_trigger_mode);
      state.slack.bot_token = typeof slack.bot_token === "string" ? slack.bot_token : "";
      state.slack.app_token = typeof slack.app_token === "string" ? slack.app_token : "";
      state.slack.allowed_team_ids_text = formatConfigList(slack.allowed_team_ids);
      state.slack.allowed_channel_ids_text = formatConfigList(slack.allowed_channel_ids);
      state.slack.group_trigger_mode = normalizeConsoleGroupTriggerMode(slack.group_trigger_mode);
      state.line.channel_access_token = typeof line.channel_access_token === "string" ? line.channel_access_token : "";
      state.line.channel_secret = typeof line.channel_secret === "string" ? line.channel_secret : "";
      state.line.allowed_group_ids_text = formatConfigList(line.allowed_group_ids);
      state.line.group_trigger_mode = normalizeConsoleGroupTriggerMode(line.group_trigger_mode);
      state.lark.app_id = typeof lark.app_id === "string" ? lark.app_id : "";
      state.lark.app_secret = typeof lark.app_secret === "string" ? lark.app_secret : "";
      state.lark.allowed_chat_ids_text = formatConfigList(lark.allowed_chat_ids);
      state.lark.group_trigger_mode = normalizeConsoleGroupTriggerMode(lark.group_trigger_mode);
      state.mixin.keystore_file = typeof mixin.keystore_file === "string" ? mixin.keystore_file : "";
      state.mixin.allowed_conversation_ids_text = formatConfigList(mixin.allowed_conversation_ids);
      state.discord.bot_token = typeof discord.bot_token === "string" ? discord.bot_token : "";
      state.discord.allowed_guild_ids_text = formatConfigList(discord.allowed_guild_ids);
      state.discord.allowed_channel_ids_text = formatConfigList(discord.allowed_channel_ids);
      state.discord.allowed_user_ids_text = formatConfigList(discord.allowed_user_ids);
      state.discord.group_trigger_mode = normalizeDiscordGroupTriggerMode(discord.group_trigger_mode);
      state.wechat.bot_id = typeof wechat.bot_id === "string" ? wechat.bot_id : "";
      state.whatsapp.api_token = typeof whatsapp.api_token === "string" ? whatsapp.api_token : "";
      state.guard.enabled = typeof guard.enabled === "boolean" ? guard.enabled : true;
      state.guard.url_fetch_allowed_url_prefixes_text = formatConfigList(guardURLFetch.allowed_url_prefixes);
      state.guard.deny_private_ips =
        typeof guardURLFetch.deny_private_ips === "boolean" ? guardURLFetch.deny_private_ips : true;
      state.guard.follow_redirects =
        typeof guardURLFetch.follow_redirects === "boolean" ? guardURLFetch.follow_redirects : false;
      state.guard.allow_proxy = typeof guardURLFetch.allow_proxy === "boolean" ? guardURLFetch.allow_proxy : false;
      state.guard.redaction_enabled = typeof guardRedaction.enabled === "boolean" ? guardRedaction.enabled : true;
      state.guard.approvals_enabled =
        typeof guardApprovals.enabled === "boolean" ? guardApprovals.enabled : false;
      consoleSettingsLoaded.value = true;
      setLoadedConsoleSnapshots();
      restoreUnsavedScopes(unsaved, consoleSecretDirty);
    }

    function resetConsoleSettingsState() {
      consoleSettingsRequestSeq += 1;
      consoleLoading.value = false;
      consoleSaving.value = false;
      consoleSavingTarget.value = "";
      state.managedRuntimes.telegram = false;
      state.managedRuntimes.slack = false;
      state.managedRuntimes.lark = false;
      state.managedRuntimes.mixin = false;
      state.managedRuntimes.discord = false;
      state.managedRuntimes.wechat = false;
      state.managedRuntimes.whatsapp = false;
      Object.assign(state.telegram, buildEmptyTelegramConsoleState());
      Object.assign(state.slack, buildEmptySlackConsoleState());
      Object.assign(state.line, buildEmptyLineConsoleState());
      Object.assign(state.lark, buildEmptyLarkConsoleState());
      Object.assign(state.mixin, buildEmptyMixinConsoleState());
      Object.assign(state.discord, buildEmptyDiscordConsoleState());
      Object.assign(state.wechat, buildEmptyWeChatConsoleState());
      Object.assign(state.whatsapp, buildEmptyWhatsAppConsoleState());
      Object.assign(state.guard, buildEmptyGuardConsoleState());
      consoleEnvManaged.value = {};
      consoleSecretFields.value = {};
      consoleSecretDirty.clear();
      consoleConfigPath.value = "";
      consoleConfigValues.value = {};
      consoleFieldStates.value = {};
      consoleEndpoints.value = [];
      authProfiles.value = [];
      clearLoadedConsoleSnapshots();
    }

    function resetDesktopSettingsState() {
      desktopSettingsRequestSeq += 1;
      desktopLoading.value = false;
      desktopChecking.value = false;
      desktopSettingsLoaded.value = false;
      desktopCurrentVersion.value = "";
      desktopUpdateResult.value = null;
    }

    function resetSystemSettingsState() {
      systemLoading.value = false;
      systemSaving.value = false;
      systemSettingsLoaded.value = false;
      systemConfigValues.value = {};
      systemFieldStates.value = {};
    }

    async function loadConsoleSettings() {
      if (!selectedEndpointIsConsole.value) {
        return;
      }
      const requestSeq = ++consoleSettingsRequestSeq;
      const targetEndpointRef = settingsEndpointRef.value;
      consoleLoading.value = true;
      try {
        const data = await endpointApiFetch(targetEndpointRef, "/settings/console");
        if (!isCurrentConsoleSettingsRequest(requestSeq, targetEndpointRef)) {
          return;
        }
        consoleConfigPath.value = typeof data.config_path === "string" ? data.config_path : "";
        applyConsolePayload(data);
      } catch (e) {
        if (isCurrentConsoleSettingsRequest(requestSeq, targetEndpointRef)) {
          toast.error(e.message || t("msg_load_failed"));
        }
      } finally {
        if (isCurrentConsoleSettingsRequest(requestSeq, targetEndpointRef)) {
          consoleLoading.value = false;
        }
      }
    }

    async function loadDesktopSettings() {
      const requestSeq = ++desktopSettingsRequestSeq;
      const targetEndpointRef = consoleEndpointRef.value;
      desktopLoading.value = true;
      try {
        const data = await endpointApiFetch(targetEndpointRef, "/settings/auto-update");
        if (!isCurrentDesktopSettingsRequest(requestSeq, targetEndpointRef)) {
          return;
        }
        const nativeVersion = targetEndpointRef === LOCAL_CONSOLE_ENDPOINT_REF ? desktopRuntimeVersion() : "";
        desktopCurrentVersion.value = nativeVersion || trimText(data?.current_version) || "dev";
        desktopBuildChannel.value = trimText(data?.build_channel);
        applyAutoUpdateSettings(data);
        desktopSettingsLoaded.value = true;
      } catch (e) {
        if (isCurrentDesktopSettingsRequest(requestSeq, targetEndpointRef)) {
          toast.error(e.message || t("msg_load_failed"));
        }
      } finally {
        if (isCurrentDesktopSettingsRequest(requestSeq, targetEndpointRef)) {
          desktopLoading.value = false;
        }
      }
    }

    async function loadSystemSettings() {
      const targetEndpointRef = settingsEndpointRef.value;
      systemLoading.value = true;
      try {
        const data = await endpointApiFetch(targetEndpointRef, "/settings/system");
        if (targetEndpointRef !== settingsEndpointRef.value) {
          return;
        }
        settingsConfigRevision.value = trimText(data?.config_revision) || settingsConfigRevision.value;
        systemConfigValues.value = data?.config_values && typeof data.config_values === "object" ? data.config_values : {};
        systemFieldStates.value = data?.field_states && typeof data.field_states === "object" ? data.field_states : {};
        systemSettingsLoaded.value = true;
      } catch (e) {
        if (targetEndpointRef === settingsEndpointRef.value) {
          toast.error(e?.message || t("msg_load_failed"));
        }
      } finally {
        if (targetEndpointRef === settingsEndpointRef.value) {
          systemLoading.value = false;
        }
      }
    }

    function applyPersonaIdentityContent(raw) {
      loadedIdentityRaw.value = normalizeText(raw);
      Object.assign(state.persona, parseIdentityProfile(loadedIdentityRaw.value));
      loadedIdentitySnapshot.value = buildPersonaIdentitySnapshot(state.persona);
    }

    function applyPersonaSoulContent(raw) {
      const next = normalizeSoulDocument(raw);
      soulContent.value = next;
      loadedSoulSnapshot.value = next;
    }

    function updatePersonaSoulContent(value) {
      soulContent.value = String(value || "");
      personaOk.value = "";
    }

    function setPersonaAvatarObjectURL(nextURL) {
      if (personaAvatarObjectURL) {
        URL.revokeObjectURL(personaAvatarObjectURL);
      }
      personaAvatarObjectURL = nextURL || "";
      personaAvatarURL.value = personaAvatarObjectURL;
    }

    function resetPersonaSettingsState() {
      Object.assign(state.persona, buildEmptyPersonaIdentityState());
      soulContent.value = "";
      loadedIdentityRaw.value = "";
      loadedIdentitySnapshot.value = buildPersonaIdentitySnapshot(state.persona);
      loadedSoulSnapshot.value = "";
      personaSettingsLoaded.value = false;
      setPersonaAvatarObjectURL("");
    }

    async function loadPersonaFile(endpointRef, endpoint) {
      try {
        const payload = await runtimeApiFetchForEndpoint(endpointRef, endpoint);
        return String(payload?.content || "");
      } catch (e) {
        if (e?.status === 404) {
          return "";
        }
        throw e;
      }
    }

    async function loadPersonaAvatar(endpointRef, requestSeq = personaSettingsRequestSeq) {
      try {
        const blob = await runtimeApiDownloadForEndpoint(endpointRef, PERSONA_AVATAR_ENDPOINT);
        const nextURL = URL.createObjectURL(blob);
        if (!isCurrentPersonaSettingsRequest(requestSeq, endpointRef)) {
          URL.revokeObjectURL(nextURL);
          return;
        }
        setPersonaAvatarObjectURL(nextURL);
      } catch (e) {
        if (!isCurrentPersonaSettingsRequest(requestSeq, endpointRef)) {
          return;
        }
        if (e?.status === 404) {
          setPersonaAvatarObjectURL("");
          return;
        }
        throw e;
      }
    }

    async function loadPersonaSettings(endpointRef = settingsEndpointRef.value) {
      const requestSeq = ++personaSettingsRequestSeq;
      const targetEndpointRef = trimText(endpointRef) || LOCAL_CONSOLE_ENDPOINT_REF;
      personaLoading.value = true;
      personaErr.value = "";
      personaOk.value = "";
      try {
        const identityContent = await loadPersonaFile(targetEndpointRef, PERSONA_IDENTITY_ENDPOINT);
        if (!isCurrentPersonaSettingsRequest(requestSeq, targetEndpointRef)) {
          return;
        }
        applyPersonaIdentityContent(identityContent);

        const soul = await loadPersonaFile(targetEndpointRef, PERSONA_SOUL_ENDPOINT);
        if (!isCurrentPersonaSettingsRequest(requestSeq, targetEndpointRef)) {
          return;
        }
        applyPersonaSoulContent(soul);
        await loadPersonaAvatar(targetEndpointRef, requestSeq);
        if (!isCurrentPersonaSettingsRequest(requestSeq, targetEndpointRef)) {
          return;
        }
        personaSettingsLoaded.value = true;
      } catch (e) {
        if (!isCurrentPersonaSettingsRequest(requestSeq, targetEndpointRef)) {
          return;
        }
        personaErr.value = e.message || t("msg_load_failed");
        toast.error(personaErr.value);
      } finally {
        if (isCurrentPersonaSettingsRequest(requestSeq, targetEndpointRef)) {
          personaLoading.value = false;
        }
      }
    }

    async function savePersona({ notify = true } = {}) {
      if (personaSaveDisabled.value) {
        return false;
      }
      personaSaving.value = true;
      personaSavingTarget.value = "persona";
      personaErr.value = "";
      personaOk.value = "";
      const targetEndpointRef = settingsEndpointRef.value;
      let setupReadinessDirty = false;
      try {
        if (personaIdentityDirty.value) {
          const content = buildIdentityYAML(state.persona, loadedIdentityRaw.value);
          await runtimeApiFetchForEndpoint(targetEndpointRef, PERSONA_IDENTITY_ENDPOINT, {
            method: "PUT",
            body: { content },
          });
          if (targetEndpointRef !== settingsEndpointRef.value) {
            return false;
          }
          loadedIdentityRaw.value = content;
          loadedIdentitySnapshot.value = buildPersonaIdentitySnapshot(state.persona);
          dispatchPersonaIdentityUpdated();
          setupReadinessDirty = true;
        }
        if (personaSoulDirty.value) {
          const content = normalizeSoulDocument(soulContent.value);
          await runtimeApiFetchForEndpoint(targetEndpointRef, PERSONA_SOUL_ENDPOINT, {
            method: "PUT",
            body: { content },
          });
          if (targetEndpointRef !== settingsEndpointRef.value) {
            return false;
          }
          soulContent.value = content;
          loadedSoulSnapshot.value = content;
          setupReadinessDirty = true;
        }
        if (setupReadinessDirty) {
          invalidateConsoleSetupReadiness();
        }
        personaOk.value = t("msg_save_success");
        noteSavedApplyMode(null);
        if (notify) toast.success(personaOk.value);
        return true;
      } catch (e) {
        personaErr.value = e.message || t("msg_save_failed");
        toast.error(personaErr.value);
        return false;
      } finally {
        personaSaving.value = false;
        personaSavingTarget.value = "";
      }
    }

    async function savePersonaAvatar(blob) {
      personaAvatarBusy.value = true;
      personaErr.value = "";
      personaOk.value = "";
      const targetEndpointRef = settingsEndpointRef.value;
      try {
        await runtimeApiFetchForEndpoint(targetEndpointRef, PERSONA_AVATAR_ENDPOINT, {
          method: "PUT",
          headers: { "Content-Type": "image/webp" },
          body: blob,
        });
        if (targetEndpointRef !== settingsEndpointRef.value) {
          return;
        }
        await loadPersonaAvatar(targetEndpointRef);
        dispatchPersonaAvatarUpdated();
        personaOk.value = t("msg_save_success");
        toast.success(personaOk.value);
      } catch (e) {
        personaErr.value = e.message || t("msg_save_failed");
        toast.error(personaErr.value);
      } finally {
        personaAvatarBusy.value = false;
      }
    }

    async function deletePersonaAvatar() {
      personaAvatarBusy.value = true;
      personaErr.value = "";
      personaOk.value = "";
      const targetEndpointRef = settingsEndpointRef.value;
      try {
        await runtimeApiFetchForEndpoint(targetEndpointRef, PERSONA_AVATAR_ENDPOINT, {
          method: "DELETE",
        });
        if (targetEndpointRef !== settingsEndpointRef.value) {
          return;
        }
        setPersonaAvatarObjectURL("");
        dispatchPersonaAvatarUpdated();
        personaOk.value = t("msg_delete_success");
        toast.success(personaOk.value);
      } catch (e) {
        personaErr.value = e.message || t("msg_delete_failed");
        toast.error(personaErr.value);
      } finally {
        personaAvatarBusy.value = false;
      }
    }

    function buildSavePayload(target = "all") {
      const tools = {
        write_file: { enabled: state.tools.write_file },
        spawn: { enabled: state.tools.spawn },
        coder: { enabled: state.tools.coder },
        contacts_send: { enabled: state.tools.contacts_send },
        todo_update: { enabled: state.tools.todo_update },
        plan_create: { enabled: state.tools.plan_create },
        url_fetch: { enabled: state.tools.url_fetch },
        web_search: { enabled: state.tools.web_search },
        bash: { enabled: state.tools.bash },
        powershell: { enabled: state.tools.powershell },
        image_generate: { enabled: state.tools.image_generate },
        image_edit: { enabled: state.tools.image_edit },
        skill_install_preview: { enabled: state.tools.skill_install_preview },
        skill_install: { enabled: state.tools.skill_install },
      };
      if (target === "llm") {
        return { llm: buildLLMSettingsPayload() };
      }
      if (target === "tools") {
        return { tools };
      }
      const mcp = { servers: state.mcp.servers.map(serializeMCPServer) };
      if (target === "mcp") {
        return { mcp };
      }
      return {
        llm: buildLLMSettingsPayload(),
        tools,
        mcp,
      };
    }

    function buildLLMSettingsPayload() {
      const payload = {};
      const provider = normalizeSetupProviderChoice(
        llmFieldValue(state.llm, llmEnvManaged.value, "inference_provider") || llmFieldValue(state.llm, llmEnvManaged.value, "provider"),
        { allowEmpty: true },
      );
      const inferenceProviderRaw = llmFieldEnvRawValue(llmEnvManaged.value, "inference_provider");
      const providerRaw = llmFieldEnvRawValue(llmEnvManaged.value, "provider");
      if (inferenceProviderRaw !== "") {
        payload.inference_provider = inferenceProviderRaw;
      } else if (providerRaw !== "") {
        payload.provider = providerRaw;
      } else if (!isLLMFieldEnvManaged(llmEnvManaged.value, "inference_provider")) {
        payload.inference_provider = state.llm.inference_provider;
      }
      if (!isLLMFieldEnvManaged(llmEnvManaged.value, "endpoint")) {
        payload.endpoint = setupProviderSupportsCustomAPIBase(provider) ? trimText(state.llm.endpoint) : "";
      }
      if (!isLLMFieldEnvManaged(llmEnvManaged.value, "model")) {
        payload.model = trimText(state.llm.model);
      }
      if (provider === SETUP_PROVIDER_BEDROCK) {
        if (!isLLMFieldEnvManaged(llmEnvManaged.value, "bedrock_aws_key")) {
          payload.bedrock_aws_key = includeSecretValue(
            state.llm.bedrock_aws_key,
            llmSecretFields.value,
            llmSecretDirty,
            "bedrock_aws_key",
          );
        }
        if (!isLLMFieldEnvManaged(llmEnvManaged.value, "bedrock_aws_secret")) {
          payload.bedrock_aws_secret = includeSecretValue(
            state.llm.bedrock_aws_secret,
            llmSecretFields.value,
            llmSecretDirty,
            "bedrock_aws_secret",
          );
        }
        if (!isLLMFieldEnvManaged(llmEnvManaged.value, "bedrock_region")) {
          payload.bedrock_region = trimText(state.llm.bedrock_region);
        }
        if (!isLLMFieldEnvManaged(llmEnvManaged.value, "bedrock_model_arn")) {
          payload.bedrock_model_arn = trimText(state.llm.bedrock_model_arn);
        }
      } else if (provider === SETUP_PROVIDER_CLOUDFLARE) {
        if (!isLLMFieldEnvManaged(llmEnvManaged.value, "cloudflare_api_token")) {
          payload.cloudflare_api_token = includeSecretValue(
            state.llm.cloudflare_api_token,
            llmSecretFields.value,
            llmSecretDirty,
            "cloudflare_api_token",
          );
        }
        if (!isLLMFieldEnvManaged(llmEnvManaged.value, "cloudflare_account_id")) {
          payload.cloudflare_account_id = trimText(state.llm.cloudflare_account_id);
        }
      } else if (provider === SETUP_PROVIDER_OPENAI_CODEX) {
        if (!isLLMFieldEnvManaged(llmEnvManaged.value, "api_key")) {
          payload.api_key = includeSecretValue(state.llm.api_key, llmSecretFields.value, llmSecretDirty, "api_key");
        }
        payload.cloudflare_api_token = "";
        payload.cloudflare_account_id = "";
        payload.bedrock_aws_key = "";
        payload.bedrock_aws_secret = "";
        payload.bedrock_region = "";
        payload.bedrock_model_arn = "";
      } else if (
        provider === SETUP_PROVIDER_XAI_OAUTH ||
        provider === SETUP_PROVIDER_MISTERMORPH_PRO
      ) {
        payload.api_key = "";
        payload.cloudflare_api_token = "";
        payload.cloudflare_account_id = "";
        payload.bedrock_aws_key = "";
        payload.bedrock_aws_secret = "";
        payload.bedrock_region = "";
        payload.bedrock_model_arn = "";
      } else if (!isLLMFieldEnvManaged(llmEnvManaged.value, "api_key")) {
        payload.api_key = includeSecretValue(state.llm.api_key, llmSecretFields.value, llmSecretDirty, "api_key");
      }
      payload.fallback_profiles = normalizeNamedList(state.llm.fallback_profiles);
      return payload;
    }

    function buildProfileTestPayload(profile) {
      return {
        profiles: [{ ...buildProfilePayload(profile), name: trimText(profile._savedName) || trimText(profile.name) }],
      };
    }

    function profileProviderChoice(profile) {
      const envManaged = llmProfileEnvManaged(profile);
      return normalizeSetupProviderChoice(
        llmFieldValue(profile, envManaged, "inference_provider") || llmFieldValue(profile, envManaged, "provider"),
        { allowEmpty: true },
      );
    }

    function profileUsesCodexProvider(profile) {
      return profileProviderChoice(profile) === SETUP_PROVIDER_OPENAI_CODEX;
    }

    function profileCodexAuthDisabled(profile) {
      const envManaged = llmProfileEnvManaged(profile);
      return (
        trimText(llmFieldValue(profile, envManaged, "endpoint")) !== "" &&
        hasLLMFieldOrSecretValue(profile, envManaged, llmProfileSecretFields(profile), "api_key")
      );
    }

    function profileUsesCodexAPIKey(profile) {
      const envManaged = llmProfileEnvManaged(profile);
      return (
        profileProviderChoice(profile) === SETUP_PROVIDER_OPENAI_CODEX &&
        setupOpenAICodexUsesAPIKey(
          llmFieldValue(profile, envManaged, "endpoint"),
          hasLLMFieldOrSecretValue(profile, envManaged, llmProfileSecretFields(profile), "api_key"),
        )
      );
    }

    function profileUsesXAIProvider(profile) {
      return selectedEndpointIsConsole.value && profileProviderChoice(profile) === SETUP_PROVIDER_XAI_OAUTH;
    }

    function profileUsesProProvider(profile) {
      return selectedEndpointIsConsole.value && profileProviderChoice(profile) === SETUP_PROVIDER_MISTERMORPH_PRO;
    }

    function hasResolvableProfileTestTarget(profile) {
      const name = trimText(profile?.name);
      if (name === "" || name.toLowerCase() === "default") {
        return false;
      }
      const matches = state.llm.profiles.filter((item) => trimText(item?.name).toLowerCase() === name.toLowerCase()).length;
      return matches === 1;
    }

    function profileModelLookupCredentialsReady(profile) {
      const provider = profileProviderChoice(profile);
      const envManaged = llmProfileEnvManaged(profile);
      if (provider === SETUP_PROVIDER_MISTERMORPH_PRO) {
        return !selectedEndpointIsConsole.value || proAuthStatus.logged_in;
      }
      if (provider === SETUP_PROVIDER_OPENAI_CODEX) {
        return profileUsesCodexAPIKey(profile) || codexAuthStatus.logged_in;
      }
      if (provider === SETUP_PROVIDER_XAI_OAUTH) {
        return !selectedEndpointIsConsole.value || xaiAuthReady.value;
      }
      if (provider === SETUP_PROVIDER_CLOUDFLARE) {
        return hasLLMFieldOrSecretValue(profile, envManaged, llmProfileSecretFields(profile), "cloudflare_api_token") &&
          hasLLMFieldValue(profile, envManaged, "cloudflare_account_id");
      }
      if (!setupProviderRequiresAPIKey(provider)) {
        return true;
      }
      return hasLLMFieldOrSecretValue(profile, envManaged, llmProfileSecretFields(profile), "api_key");
    }

    function testConnectionDisabledForProfile(profile) {
      const provider = profileProviderChoice(profile);
      const envManaged = llmProfileEnvManaged(profile);
      if (testConnectionLoading.value || agentLoading.value || agentSaving.value) {
        return true;
      }
      if (!hasResolvableProfileTestTarget(profile) || provider === "") {
        return true;
      }
      if (!hasLLMFieldValue(profile, envManaged, "model")) {
        return true;
      }
      if (provider === SETUP_PROVIDER_OPENAI_CODEX) {
        return !profileUsesCodexAPIKey(profile) && !codexAuthStatus.logged_in;
      }
      if (provider === SETUP_PROVIDER_XAI_OAUTH) {
        return selectedEndpointIsConsole.value && !xaiAuthReady.value;
      }
      if (provider === SETUP_PROVIDER_MISTERMORPH_PRO) {
        return selectedEndpointIsConsole.value && !proAuthStatus.logged_in;
      }
      if (provider === SETUP_PROVIDER_BEDROCK) {
        return (
          !hasLLMFieldOrSecretValue(profile, envManaged, llmProfileSecretFields(profile), "bedrock_aws_key") ||
          !hasLLMFieldOrSecretValue(profile, envManaged, llmProfileSecretFields(profile), "bedrock_aws_secret") ||
          !hasLLMFieldValue(profile, envManaged, "bedrock_region")
        );
      }
      if (provider === SETUP_PROVIDER_CLOUDFLARE) {
        return (
          !hasLLMFieldOrSecretValue(profile, envManaged, llmProfileSecretFields(profile), "cloudflare_api_token") ||
          !hasLLMFieldValue(profile, envManaged, "cloudflare_account_id")
        );
      }
      return setupProviderRequiresAPIKey(provider) &&
        !hasLLMFieldOrSecretValue(profile, envManaged, llmProfileSecretFields(profile), "api_key");
    }

    function advancedSettingsDialogTitle(name) {
      return `${name} · ${t("settings_advanced_action")}`;
    }

    function openConfigAdvancedSettings(name, scope, groups) {
      advancedSettingsTitle.value = advancedSettingsDialogTitle(name);
      advancedSettingsScope.value = scope;
      advancedSettingsGroups.value = groups;
      advancedSettingsDirty.value = false;
      advancedSettingsOpen.value = true;
    }

    function openDefaultLLMAdvancedSettings() {
      openConfigAdvancedSettings(
        t("settings_agent_default_profile_label"),
        "agent",
        DEFAULT_MODEL_ADVANCED_CONFIG_GROUPS,
      );
    }

    function openToolAdvancedSettings(item) {
      const groups = TOOL_ADVANCED_CONFIG_GROUPS[item?.id];
      if (!groups) return;
      openConfigAdvancedSettings(t(item.titleKey), "agent", groups);
    }

    function openChannelAdvancedSettings(channel) {
      const group = CHANNEL_CONFIG_GROUPS.find((item) => item.id === channel);
      if (!group) return;
      openConfigAdvancedSettings(group.title.replace(/ behavior$/, ""), "console", [group]);
    }

    function channelActionMenuItems(channel) {
      return [{
        id: "advanced",
        title: t("settings_advanced_action"),
        disabled: consoleLoading.value || consoleSaving.value,
        action: () => openChannelAdvancedSettings(channel),
      }];
    }

    function closeAdvancedSettings() {
      advancedSettingsGroups.value = [];
      advancedSettingsDirty.value = false;
    }

    async function saveAdvancedConfigSettings(update) {
      // This tri-state field belongs to the LLM API, not the generic config schema.
      const imagePartsPath = "llm.supports_image_parts";
      if (advancedSettingsScope.value === "agent" &&
          (Object.hasOwn(update.config_changes, imagePartsPath) || update.reset.includes(imagePartsPath))) {
        const { [imagePartsPath]: imageParts, ...changes } = update.config_changes;
        update = {
          ...update,
          config_changes: changes,
          reset: update.reset.filter(path => path !== imagePartsPath),
          llm: { supports_image_parts: update.reset.includes(imagePartsPath) ? "" : imageParts },
        };
      }
      if (await saveConfigSettings(advancedSettingsScope.value, update)) {
        advancedSettingsOpen.value = false;
        closeAdvancedSettings();
      }
    }

    function saveAdvancedSettings() {
      advancedConfigPanel.value?.save();
    }

    // The default model's "···" menu. A profile's actions are in its panel.
    function llmActionMenuItems() {
      return [
        {
          id: "advanced",
          title: t("settings_advanced_action"),
          disabled: agentLoading.value || agentSaving.value,
          action: () => openDefaultLLMAdvancedSettings(),
        },
        {
          id: "context",
          title: "Context compaction",
          disabled: agentLoading.value || agentSaving.value,
          action: () => openConfigAdvancedSettings("Context compaction", "agent", LLM_CONTEXT_CONFIG_GROUPS),
        },
        {
          id: "benchmark",
          title: t("setup_llm_test_button"),
          disabled: testConnectionDisabled.value,
          action: () => openTestConnection(),
        },
      ];
    }

    function primeConnectionTestState(targetProfile, nextPayload = null) {
      const payload = nextPayload || (targetProfile ? buildProfileTestPayload(targetProfile) : buildDefaultLLMTestPayload());
      const profileEnvManaged = targetProfile ? llmProfileEnvManaged(targetProfile) : null;
      const targetProviderChoice = targetProfile
        ? profileProviderChoice(targetProfile)
        : normalizeSetupProviderChoice(
            llmFieldValue(state.llm, llmEnvManaged.value, "inference_provider") ||
              llmFieldValue(state.llm, llmEnvManaged.value, "provider"),
            { allowEmpty: true },
          );
      const targetEndpoint = targetProfile
        ? llmFieldValue(targetProfile, profileEnvManaged, "endpoint")
        : llmFieldValue(state.llm, llmEnvManaged.value, "endpoint");
      const targetModel = targetProfile
        ? llmFieldValue(targetProfile, profileEnvManaged, "model")
        : llmFieldValue(state.llm, llmEnvManaged.value, "model");
      testConnectionError.value = "";
      testConnectionBenchmarks.value = [];
      testConnectionMeta.provider = targetProviderChoice;
      testConnectionMeta.apiBase = trimText(targetEndpoint);
      testConnectionMeta.model = trimText(targetModel) || String(payload.model || "").trim();
      return payload;
    }

    function buildConsoleSavePayload(target = "all") {
      const telegramEnv =
        consoleEnvManaged.value?.telegram && typeof consoleEnvManaged.value.telegram === "object"
          ? consoleEnvManaged.value.telegram
          : {};
      const slackEnv =
        consoleEnvManaged.value?.slack && typeof consoleEnvManaged.value.slack === "object"
          ? consoleEnvManaged.value.slack
          : {};
      const lineEnv =
        consoleEnvManaged.value?.line && typeof consoleEnvManaged.value.line === "object"
          ? consoleEnvManaged.value.line
          : {};
      const larkEnv =
        consoleEnvManaged.value?.lark && typeof consoleEnvManaged.value.lark === "object"
          ? consoleEnvManaged.value.lark
          : {};
      const mixinEnv =
        consoleEnvManaged.value?.mixin && typeof consoleEnvManaged.value.mixin === "object"
          ? consoleEnvManaged.value.mixin
          : {};
      const discordEnv =
        consoleEnvManaged.value?.discord && typeof consoleEnvManaged.value.discord === "object"
          ? consoleEnvManaged.value.discord
          : {};
      const whatsappEnv =
        consoleEnvManaged.value?.whatsapp && typeof consoleEnvManaged.value.whatsapp === "object"
          ? consoleEnvManaged.value.whatsapp
          : {};
      const managed_runtimes = MANAGED_RUNTIME_ITEMS.filter((item) => state.managedRuntimes[item.id]).map((item) => item.id);
      const telegram = {
        allowed_chat_ids: parseConfigListText(state.telegram.allowed_chat_ids_text),
        group_trigger_mode: normalizeConsoleGroupTriggerMode(state.telegram.group_trigger_mode),
      };
      telegram.bot_token = consoleFieldRawValue(telegramEnv, "bot_token") || includeConsoleSecretValue(
        "telegram",
        "bot_token",
        state.telegram.bot_token,
      );
      const slack = {
        allowed_team_ids: parseConfigListText(state.slack.allowed_team_ids_text),
        allowed_channel_ids: parseConfigListText(state.slack.allowed_channel_ids_text),
        group_trigger_mode: normalizeConsoleGroupTriggerMode(state.slack.group_trigger_mode),
      };
      slack.bot_token = consoleFieldRawValue(slackEnv, "bot_token") || includeConsoleSecretValue(
        "slack",
        "bot_token",
        state.slack.bot_token,
      );
      slack.app_token = consoleFieldRawValue(slackEnv, "app_token") || includeConsoleSecretValue(
        "slack",
        "app_token",
        state.slack.app_token,
      );
      const line = {
        allowed_group_ids: parseConfigListText(state.line.allowed_group_ids_text),
        group_trigger_mode: normalizeConsoleGroupTriggerMode(state.line.group_trigger_mode),
      };
      line.channel_access_token = consoleFieldRawValue(lineEnv, "channel_access_token") || includeConsoleSecretValue(
        "line",
        "channel_access_token",
        state.line.channel_access_token,
      );
      line.channel_secret = consoleFieldRawValue(lineEnv, "channel_secret") || includeConsoleSecretValue(
        "line",
        "channel_secret",
        state.line.channel_secret,
      );
      const lark = {
        app_id: consoleFieldRawValue(larkEnv, "app_id") || trimText(state.lark.app_id),
        allowed_chat_ids: parseConfigListText(state.lark.allowed_chat_ids_text),
        group_trigger_mode: normalizeConsoleGroupTriggerMode(state.lark.group_trigger_mode),
      };
      lark.app_secret = consoleFieldRawValue(larkEnv, "app_secret") || includeConsoleSecretValue(
        "lark",
        "app_secret",
        state.lark.app_secret,
      );
      const mixin = {
        keystore_file: consoleFieldRawValue(mixinEnv, "keystore_file") || trimText(state.mixin.keystore_file),
        allowed_conversation_ids: parseConfigListText(state.mixin.allowed_conversation_ids_text),
      };
      const discord = {
        allowed_guild_ids: parseConfigListText(state.discord.allowed_guild_ids_text),
        allowed_channel_ids: parseConfigListText(state.discord.allowed_channel_ids_text),
        allowed_user_ids: parseConfigListText(state.discord.allowed_user_ids_text),
        group_trigger_mode: normalizeDiscordGroupTriggerMode(state.discord.group_trigger_mode),
      };
      discord.bot_token = consoleFieldRawValue(discordEnv, "bot_token") || includeConsoleSecretValue(
        "discord",
        "bot_token",
        state.discord.bot_token,
      );
      const whatsapp = {};
      whatsapp.api_token = consoleFieldRawValue(whatsappEnv, "api_token") || includeConsoleSecretValue(
        "whatsapp",
        "api_token",
        state.whatsapp.api_token,
      );
      const guard = {
        enabled: !!state.guard.enabled,
        network: {
          url_fetch: {
            allowed_url_prefixes: parseConfigListText(state.guard.url_fetch_allowed_url_prefixes_text),
            deny_private_ips: !!state.guard.deny_private_ips,
            follow_redirects: !!state.guard.follow_redirects,
            allow_proxy: !!state.guard.allow_proxy,
          },
        },
        redaction: {
          enabled: !!state.guard.redaction_enabled,
        },
        approvals: {
          enabled: !!state.guard.approvals_enabled,
        },
      };
      if (target === "runtimes") {
        return { managed_runtimes };
      }
      if (target === "telegram") {
        return { telegram };
      }
      if (target === "slack") {
        return { slack };
      }
      if (target === "line") {
        return { line };
      }
      if (target === "lark") {
        return { lark };
      }
      if (target === "mixin") {
        return { mixin };
      }
      if (target === "discord") {
        return { discord };
      }
      if (target === "whatsapp") {
        return { whatsapp };
      }
      if (target === "guard") {
        return { guard };
      }
      return { managed_runtimes, telegram, slack, line, lark, mixin, discord, whatsapp, guard };
    }

    function consoleFieldEntry(kind, field) {
      const key = String(field || "").trim();
      const channel = String(kind || "").trim();
      const group = consoleEnvManaged.value?.[channel];
      if (!key || !group || typeof group !== "object") {
        return null;
      }
      const entry = group[key];
      return entry && typeof entry === "object" ? entry : null;
    }

    function consoleFieldRawValue(group, field) {
      const key = String(field || "").trim();
      if (!key || !group || typeof group !== "object") {
        return "";
      }
      const entry = group[key];
      return typeof entry?.raw_value === "string" ? entry.raw_value.trim() : "";
    }

    function consoleFieldEnvManaged(kind, field) {
      const envName = consoleFieldEntry(kind, field)?.env_name;
      return typeof envName === "string" && envName.trim() !== "";
    }

    function consoleSecretField(kind, field) {
      const group = consoleSecretFields.value?.[kind];
      const entry = group && typeof group === "object" ? group[field] : null;
      return entry && typeof entry === "object" ? entry : null;
    }

    function includeConsoleSecretValue(kind, field, value) {
      const key = `${kind}.${field}`;
      return consoleSecretDirty.has(key) || !secretConfigured(consoleSecretFields.value?.[kind] || {}, field)
        ? trimText(value)
        : undefined;
    }

    function markConsoleSecretDirty(kind, field) {
      if (consoleSecretField(kind, field)) {
        consoleSecretDirty.add(`${kind}.${field}`);
      }
    }

    function consoleSecretEditable(kind, field) {
      return consoleSecretField(kind, field)?.editable !== false;
    }

    function consoleFieldManagedHeadline(kind, field) {
      const entry = consoleFieldEntry(kind, field);
      const envName = typeof entry?.env_name === "string" ? entry.env_name.trim() : "";
      if (!envName) {
        return "";
      }
      const value = typeof entry?.value === "string" ? entry.value.trim() : "";
      return value === "" ? envName : `${envName}=${value}`;
    }

    function updateTelegramField(field, value) {
      const key = String(field || "").trim();
      if (!key || !Object.prototype.hasOwnProperty.call(state.telegram, key)) {
        return;
      }
      state.telegram[key] = String(value || "");
      markConsoleSecretDirty("telegram", key);
      updateConsoleTelegramDirty();
    }

    function updateSlackField(field, value) {
      const key = String(field || "").trim();
      if (!key || !Object.prototype.hasOwnProperty.call(state.slack, key)) {
        return;
      }
      state.slack[key] = String(value || "");
      markConsoleSecretDirty("slack", key);
      updateConsoleSlackDirty();
    }

    function updateTelegramGroupTrigger(item) {
      updateTelegramField("group_trigger_mode", item?.value || "talkative");
    }

    function updateSlackGroupTrigger(item) {
      updateSlackField("group_trigger_mode", item?.value || "talkative");
    }

    function updateLineField(field, value) {
      const key = String(field || "").trim();
      if (!key || !Object.prototype.hasOwnProperty.call(state.line, key)) {
        return;
      }
      state.line[key] = String(value || "");
      markConsoleSecretDirty("line", key);
      updateConsoleLineDirty();
    }

    function updateLarkField(field, value) {
      const key = String(field || "").trim();
      if (!key || !Object.prototype.hasOwnProperty.call(state.lark, key)) {
        return;
      }
      state.lark[key] = String(value || "");
      markConsoleSecretDirty("lark", key);
      updateConsoleLarkDirty();
    }

    function updateLineGroupTrigger(item) {
      updateLineField("group_trigger_mode", item?.value || "talkative");
    }

    function updateLarkGroupTrigger(item) {
      updateLarkField("group_trigger_mode", item?.value || "talkative");
    }

    function updateMixinField(field, value) {
      const key = String(field || "").trim();
      if (!key || !Object.prototype.hasOwnProperty.call(state.mixin, key)) {
        return;
      }
      state.mixin[key] = String(value || "");
      updateConsoleMixinDirty();
    }

    function updateDiscordField(field, value) {
      const key = String(field || "").trim();
      if (!key || !Object.prototype.hasOwnProperty.call(state.discord, key)) {
        return;
      }
      state.discord[key] = String(value || "");
      markConsoleSecretDirty("discord", key);
      updateConsoleDiscordDirty();
    }

    function updateDiscordGroupTrigger(item) {
      updateDiscordField("group_trigger_mode", item?.value || "strict");
    }

    function updateWhatsAppField(field, value) {
      const key = String(field || "").trim();
      if (!key || !Object.prototype.hasOwnProperty.call(state.whatsapp, key)) {
        return;
      }
      state.whatsapp[key] = String(value || "");
      markConsoleSecretDirty("whatsapp", key);
      updateConsoleWhatsAppDirty();
    }

    // WeChat login and unbind write config on the server. Reload it, keeping unsaved drafts.
    async function reloadConsoleSettingsAfterWeChatLogin() {
      const targetEndpointRef = settingsEndpointRef.value;
      try {
        const data = await endpointApiFetch(targetEndpointRef, "/settings/console");
        if (settingsEndpointRef.value !== targetEndpointRef) {
          return;
        }
        applyConsolePayload(data, { savedScopes: [] });
      } catch (e) {
        toast.error(e.message || t("msg_load_failed"));
      }
    }

    function updateGuardField(field, value) {
      const key = String(field || "").trim();
      if (!key || !Object.prototype.hasOwnProperty.call(state.guard, key)) {
        return;
      }
      state.guard[key] = typeof state.guard[key] === "boolean" ? !!value : String(value || "");
      updateConsoleGuardDirty();
    }

    async function saveLLMProfile(profileKey, draft = null, { notify = true } = {}) {
      const storedProfile = state.llm.profiles.find((item) => item._key === profileKey) || null;
      const profile = draft || storedProfile;
      if (!storedProfile || !profile || agentLoading.value || agentSaving.value || agentSettingsReadOnly.value) {
        return false;
      }
      const validationError = profileValidationError(profile);
      if (validationError) {
        toast.error(validationError);
        return false;
      }
      if (profileSaveDisabled(profile)) {
        return false;
      }

      const originalName = trimText(profile._savedName);
      const nextName = trimText(profile.name);
      agentSaving.value = true;
      agentSavingTarget.value = `profile:${profileKey}`;
      const targetEndpointRef = settingsEndpointRef.value;
      try {
        const payload = await endpointApiFetch(targetEndpointRef, "/settings/agent", {
          method: "PUT",
          body: {
            config_revision: settingsConfigRevision.value,
            llm: {
              profile: {
                original_name: originalName,
                ...buildProfilePayload(profile),
              },
            },
          },
        });
        if (targetEndpointRef !== settingsEndpointRef.value) {
          return false;
        }
        if (profile !== storedProfile) {
          Object.assign(storedProfile, profile);
          storedProfile._secretDirty = new Set(profile._secretDirty || []);
        }
        llmConfigPath.value = typeof payload.config_path === "string" ? payload.config_path : llmConfigPath.value;
        settingsConfigRevision.value = trimText(payload?.config_revision) || settingsConfigRevision.value;
        const profileEnvManaged = payload?.env_managed?.llm_profiles?.[nextName];
        storedProfile._envManaged =
          profileEnvManaged && typeof profileEnvManaged === "object" ? profileEnvManaged : {};
        const profileSecretFields = payload?.secret_fields?.llm_profiles?.[nextName];
        storedProfile._secretFields =
          profileSecretFields && typeof profileSecretFields === "object" ? profileSecretFields : {};
        storedProfile.api_key = "";
        storedProfile.bedrock_aws_key = "";
        storedProfile.bedrock_aws_secret = "";
        storedProfile.bedrock_aws_session_token = "";
        storedProfile.cloudflare_api_token = "";
        storedProfile._secretDirty.clear();
        storedProfile._savedName = nextName;
        storedProfile._savedSnapshot = JSON.stringify(serializeLLMProfile(storedProfile));
        if (originalName && originalName !== nextName) {
          state.llm.fallback_profiles = state.llm.fallback_profiles.map((item) =>
            trimText(item).toLowerCase() === originalName.toLowerCase() ? nextName : item,
          );
          updateLoadedFallbackProfile(originalName, nextName);
        }
        if (targetEndpointRef === LOCAL_CONSOLE_ENDPOINT_REF) {
          invalidateConsoleSetupReadiness();
        }
        await loadEndpoints();
        noteSavedApplyMode(payload);
        if (notify) toast.success(settingsSavedMessage(payload));
        return true;
      } catch (e) {
        toast.error(agentSettingsErrorMessage(e, targetEndpointRef, "msg_save_failed"));
        return false;
      } finally {
        agentSaving.value = false;
        agentSavingTarget.value = "";
      }
    }

    async function saveAgentSettings(target = "all", { notify = true } = {}) {
      const normalizedTarget = ["all", "llm", "tools", "mcp"].includes(String(target))
        ? String(target)
        : "all";
      if (agentSettingsReadOnly.value) {
        return false;
      }
      if (normalizedTarget === "llm" && llmSaveDisabled.value) {
        return false;
      }
      if (normalizedTarget === "tools" && toolsSaveDisabled.value) {
        return false;
      }
      if (normalizedTarget === "mcp" && mcpSaveDisabled.value) {
        return false;
      }
      if (normalizedTarget === "all" && agentLoading.value) {
        return false;
      }
      if ((normalizedTarget === "llm" || normalizedTarget === "all") && agentValidationError.value !== "") {
        agentValidationVisible.value = true;
        return false;
      }
      agentSaving.value = true;
      agentSavingTarget.value = normalizedTarget;
      agentValidationVisible.value = false;
      const targetEndpointRef = settingsEndpointRef.value;
      try {
        const payload = await endpointApiFetch(targetEndpointRef, "/settings/agent", {
          method: "PUT",
          body: { config_revision: settingsConfigRevision.value, ...buildSavePayload(normalizedTarget) },
        });
        if (targetEndpointRef !== settingsEndpointRef.value) {
          return false;
        }
        llmConfigPath.value = typeof payload.config_path === "string" ? payload.config_path : llmConfigPath.value;
        settingsConfigRevision.value = trimText(payload?.config_revision) || settingsConfigRevision.value;
        if (normalizedTarget === "llm" || normalizedTarget === "all") {
          if (targetEndpointRef === LOCAL_CONSOLE_ENDPOINT_REF) {
            invalidateConsoleSetupReadiness();
          }
          const preservedProfiles = state.llm.profiles;
          const preservedTools = JSON.parse(JSON.stringify(state.tools));
          const previousToolsSnapshot = loadedToolsSnapshot.value;
          const previousToolsDirty = toolsDirty.value;
          applyPayload(payload, { snapshotScope: normalizedTarget === "llm" ? "llm" : "all" });
          state.llm.profiles = preservedProfiles;
          if (normalizedTarget === "llm") {
            Object.assign(state.tools, preservedTools);
            loadedToolsSnapshot.value = previousToolsSnapshot;
            toolsDirty.value = previousToolsDirty;
          }
          await loadEndpoints();
        } else if (normalizedTarget === "tools") {
          loadedToolsSnapshot.value = buildToolsSnapshot(state);
          toolsDirty.value = false;
        } else if (normalizedTarget === "mcp") {
          applyMCPPayload(payload?.mcp);
          loadedMCPSnapshot.value = buildMCPSnapshot(state);
          mcpDirty.value = false;
        }
        noteSavedApplyMode(payload);
        if (notify) toast.success(t("msg_save_success"));
        return true;
      } catch (e) {
        toast.error(agentSettingsErrorMessage(e, targetEndpointRef, "msg_save_failed"));
        return false;
      } finally {
        agentSaving.value = false;
        agentSavingTarget.value = "";
      }
    }

    async function saveConsoleSettings(target = "all", { notify = true } = {}) {
      const known = ["runtimes", "telegram", "slack", "line", "lark", "mixin", "discord", "whatsapp", "guard"];
      const requested = Array.isArray(target) ? target.map(String) : [String(target)];
      const targets = requested.includes("all") ? ["all"] : requested.filter((item) => known.includes(item));
      if (!selectedEndpointIsConsole.value || targets.length === 0) {
        return false;
      }
      const targetDisabled = {
        runtimes: consoleSaveDisabled,
        telegram: telegramSaveDisabled,
        slack: slackSaveDisabled,
        line: lineSaveDisabled,
        lark: larkSaveDisabled,
        mixin: mixinSaveDisabled,
        discord: discordSaveDisabled,
        whatsapp: whatsappSaveDisabled,
        guard: guardSaveDisabled,
      };
      if (targets[0] === "all" && (consoleLoading.value || consoleSaving.value || !consoleDirty.value)) {
        return false;
      }
      if (targets[0] !== "all" && targets.some((item) => targetDisabled[item].value)) {
        return false;
      }
      consoleSaving.value = true;
      consoleSavingTarget.value = targets.length === 1 ? targets[0] : "multiple";
      const requestSeq = ++consoleSettingsRequestSeq;
      const targetEndpointRef = settingsEndpointRef.value;
      try {
        // The endpoint takes one key per target, so several targets go out in a single request.
        const body = { config_revision: settingsConfigRevision.value };
        for (const item of targets) {
          Object.assign(body, buildConsoleSavePayload(item));
        }
        const payload = await endpointApiFetch(targetEndpointRef, "/settings/console", {
          method: "PUT",
          body,
        });
        if (!isCurrentConsoleSettingsRequest(requestSeq, targetEndpointRef)) {
          return false;
        }
        consoleConfigPath.value =
          typeof payload.config_path === "string" ? payload.config_path : consoleConfigPath.value;
        applyConsolePayload(payload, { savedScopes: targets[0] === "all" ? known : targets });
        noteSavedApplyMode(payload);
        if (notify) toast.success(settingsSavedMessage(payload));
        return true;
      } catch (e) {
        if (isCurrentConsoleSettingsRequest(requestSeq, targetEndpointRef)) {
          toast.error(e.message || t("msg_save_failed"));
        }
        return false;
      } finally {
        if (isCurrentConsoleSettingsRequest(requestSeq, targetEndpointRef)) {
          consoleSaving.value = false;
          consoleSavingTarget.value = "";
        }
      }
    }

    function syncDefaultLLMAdvancedState(values) {
      const text = (path) => values[path] === undefined || values[path] === null ? "" : String(values[path]);
      state.llm.context_window_tokens = text("llm.context_window_tokens");
      state.llm.supports_image_parts = text("llm.supports_image_parts");
      state.llm.cache_ttl = text("llm.cache_ttl");
      state.llm.cache_key_prefix = text("llm.cache_key_prefix");
      state.llm.request_timeout = text("llm.request_timeout");
      state.llm.temperature = text("llm.temperature");
      state.llm.reasoning_effort = text("llm.reasoning_effort");
      state.llm.reasoning_budget_tokens = text("llm.reasoning_budget_tokens");
      state.llm.tools_emulation_mode = text("llm.tools_emulation_mode") || "off";
      state.llm.headers_text = JSON.stringify(
        values["llm.headers"] && typeof values["llm.headers"] === "object" ? values["llm.headers"] : {},
        null,
        2,
      );
    }

    async function saveConfigSettings(scope, update, { notify = true } = {}) {
      const endpoint = scope === "agent" ? "/settings/agent" : scope === "console" ? "/settings/console" : "/settings/system";
      const targetEndpointRef = settingsEndpointRef.value;
      if (scope === "agent") {
        agentSaving.value = true;
        agentSavingTarget.value = "config";
      } else if (scope === "console") {
        consoleSaving.value = true;
        consoleSavingTarget.value = "config";
      } else {
        systemSaving.value = true;
      }
      try {
        const payload = await endpointApiFetch(targetEndpointRef, endpoint, {
          method: "PUT",
          body: { config_revision: settingsConfigRevision.value, ...update },
        });
        if (targetEndpointRef !== settingsEndpointRef.value) {
          return false;
        }
        settingsConfigRevision.value = trimText(payload?.config_revision) || settingsConfigRevision.value;
        const values = payload?.config_values && typeof payload.config_values === "object" ? payload.config_values : {};
        const fieldStates = payload?.field_states && typeof payload.field_states === "object" ? payload.field_states : {};
        if (scope === "agent") {
          values["llm.supports_image_parts"] = payload?.llm?.supports_image_parts ?? "";
          agentConfigValues.value = values;
          agentFieldStates.value = fieldStates;
          syncDefaultLLMAdvancedState(values);
        } else if (scope === "console") {
          consoleConfigValues.value = values;
          consoleFieldStates.value = fieldStates;
        } else {
          systemConfigValues.value = values;
          systemFieldStates.value = fieldStates;
        }
        noteSavedApplyMode(payload);
        if (notify) toast.success(settingsSavedMessage(payload));
        return true;
      } catch (e) {
        if (e?.status === 409 && targetEndpointRef === settingsEndpointRef.value) {
          if (scope === "agent") {
            await loadAgentSettings(targetEndpointRef);
          } else if (scope === "console") {
            await loadConsoleSettings();
          } else {
            await loadSystemSettings();
          }
        }
        toast.error(e?.message || t("msg_save_failed"));
        return false;
      } finally {
        if (scope === "agent") {
          agentSaving.value = false;
          agentSavingTarget.value = "";
        } else if (scope === "console") {
          consoleSaving.value = false;
          consoleSavingTarget.value = "";
        } else {
          systemSaving.value = false;
        }
      }
    }

    function consumeConsoleEndpointAddRequest() {
      const { add, ...query } = route.query;
      void router.replace({ path: route.path, query, hash: route.hash });
    }

    async function saveConsoleCollection(target, values, onComplete) {
      if (consoleSaving.value) return;
      const targetEndpointRef = settingsEndpointRef.value;
      consoleSaving.value = true;
      consoleSavingTarget.value = target;
      try {
        const payload = await endpointApiFetch(targetEndpointRef, "/settings/console", {
          method: "PUT",
          body: { config_revision: settingsConfigRevision.value, [target]: values },
        });
        if (targetEndpointRef !== settingsEndpointRef.value) return;
        applyConsolePayload(payload, { savedScopes: [] });
        onComplete?.();
        if (target === "endpoints") await loadEndpoints().catch(() => {});
        toast.success(settingsSavedMessage(payload));
      } catch (e) {
        if (targetEndpointRef !== settingsEndpointRef.value) return;
        if (target === "endpoints") {
          if (onComplete) {
            onComplete(e?.message || t("msg_save_failed"));
            return;
          }
          consoleEndpointErrorTitle.value = t(e?.status === 502 ? "settings_endpoint_test_failed" : "msg_save_failed");
          consoleEndpointError.value = `${t("settings_endpoints_not_saved")}\n\n${e?.message || t("msg_save_failed")}`;
          await openReentrantDialog(consoleEndpointErrorOpen);
          return;
        }
        if (e?.status === 409) {
          await loadConsoleSettings();
        }
        toast.error(e?.message || t("msg_save_failed"));
      } finally {
        consoleSaving.value = false;
        consoleSavingTarget.value = "";
      }
    }

    const updateChannelOptions = computed(() => [
      { title: t("settings_update_channel_community"), value: "community" },
      { title: t("settings_update_channel_pro"), value: "pro" },
    ]);

    function applyAutoUpdateSettings(payload) {
      const settings = payload?.auto_update || {};
      autoUpdateEnabled.value = settings.enabled === true;
      autoUpdateChannel.value = trimText(settings.channel) || trimText(payload?.build_channel) || desktopBuildChannel.value;
      const revision = trimText(payload?.config_revision);
      if (revision) {
        autoUpdateRevision.value = revision;
      }
    }

    async function saveAutoUpdateSettings(change) {
      const targetEndpointRef = consoleEndpointRef.value;
      autoUpdateSaving.value = true;
      try {
        const payload = await endpointApiFetch(targetEndpointRef, "/settings/auto-update", {
          method: "PUT",
          body: {
            config_revision: settingsConfigRevision.value || autoUpdateRevision.value,
            auto_update: change,
          },
        });
        if (targetEndpointRef !== consoleEndpointRef.value) {
          return;
        }
        applyAutoUpdateSettings({ ...payload, build_channel: desktopBuildChannel.value });
        // Keep the other System saves on the new revision of the same config file.
        if (trimText(payload?.config_revision)) {
          settingsConfigRevision.value = payload.config_revision;
        }
      } catch (e) {
        toast.error(e.message || t("msg_save_failed"));
        await loadDesktopSettings();
      } finally {
        autoUpdateSaving.value = false;
      }
    }

    function setAutoUpdateChannel(value) {
      const channel = trimText(value);
      if (!channel || channel === autoUpdateChannel.value) {
        return;
      }
      autoUpdateChannel.value = channel;
      // A result belongs to the channel it checked.
      desktopUpdateResult.value = null;
      desktopUpdateError.value = "";
      void saveAutoUpdateSettings({ channel });
    }

    function setAutoUpdateEnabled(value) {
      const enabled = value === true;
      if (enabled === autoUpdateEnabled.value) {
        return;
      }
      autoUpdateEnabled.value = enabled;
      void saveAutoUpdateSettings({ enabled });
    }

    async function runDesktopUpdateCheck() {
      if (desktopCheckDisabled.value) {
        return;
      }
      desktopChecking.value = true;
      desktopUpdateError.value = "";
      desktopChecksumCopied.value = false;
      const requestSeq = desktopSettingsRequestSeq;
      const targetEndpointRef = consoleEndpointRef.value;
      const channel = trimText(autoUpdateChannel.value) || null;
      const checkPath = channel === null
        ? "/settings/auto-update/check"
        : `/settings/auto-update/check?channel=${encodeURIComponent(channel)}`;
      try {
        const result = canCheckDesktopUpdate() && targetEndpointRef === LOCAL_CONSOLE_ENDPOINT_REF
          ? await checkDesktopUpdate(channel)
          : await endpointApiFetch(targetEndpointRef, checkPath, { method: "POST" });
        if (!isCurrentDesktopSettingsRequest(requestSeq, targetEndpointRef)) {
          return;
        }
        desktopUpdateResult.value = result;
        desktopCurrentVersion.value = trimText(desktopUpdateResult.value?.current_version) || desktopCurrentVersion.value;
      } catch (e) {
        if (isCurrentDesktopSettingsRequest(requestSeq, targetEndpointRef)) {
          desktopUpdateResult.value = null;
          desktopUpdateError.value = e.message || t("msg_load_failed");
        }
      } finally {
        if (isCurrentDesktopSettingsRequest(requestSeq, targetEndpointRef)) {
          desktopChecking.value = false;
        }
      }
    }

    async function copyDesktopUpdateChecksum() {
      const checksum = desktopUpdateChecksum.value;
      if (!checksum) {
        return;
      }
      try {
        const copied = await copyTextToClipboard(checksum);
        if (copied) {
          desktopChecksumCopied.value = true;
          toast.success(t("settings_desktop_update_checksum_copied"));
          if (desktopChecksumCopyTimer) {
            window.clearTimeout(desktopChecksumCopyTimer);
          }
          desktopChecksumCopyTimer = window.setTimeout(() => {
            desktopChecksumCopied.value = false;
            desktopChecksumCopyTimer = 0;
          }, 1200);
        }
      } catch (e) {
        toast.error(e.message || t("msg_save_failed"));
      }
    }

    function openDesktopUpdateDownload() {
      if (desktopUpdateDownloadDisabled.value) {
        return;
      }
      openExternalURL(desktopUpdateAssetURL.value);
    }

    function openDesktopUpdateReleases() {
      const channel = trimText(desktopUpdateResult.value?.channel);
      openExternalURL(channel ? `${UPDATE_RELEASES_URL}?channel=${encodeURIComponent(channel)}` : UPDATE_RELEASES_URL);
    }

    async function logout() {
      loggingOut.value = true;
      try {
        await apiFetch("/auth/logout", { method: "POST" });
      } catch {
        // ignore logout failure
      } finally {
        authState.clear();
        router.replace("/login");
        loggingOut.value = false;
      }
    }

    function openAPIBasePicker() {
      if (agentLoading.value || agentSaving.value || agentSettingsReadOnly.value) {
        return;
      }
      apiBasePickerOpen.value = true;
    }

    function applyAPIBaseOption(item) {
      if (agentSettingsReadOnly.value) {
        return;
      }
      const nextEndpoint = String(item?.value || "").trim();
      if (state.llm.endpoint === nextEndpoint) {
        return;
      }
      state.llm.endpoint = nextEndpoint;
      updateLLMDirty();
    }

    async function openModelPicker(profileKey = "") {
      if (agentLoading.value || agentSaving.value || agentSettingsReadOnly.value) {
        return;
      }
      const normalizedProfileKey = String(profileKey || "").trim();
      const targetProfile = normalizedProfileKey
        ? state.llm.profiles.find((profile) => profile._key === normalizedProfileKey) || null
        : null;
      if (normalizedProfileKey && !targetProfile) {
        return;
      }
      if (targetProfile && !profileModelLookupCredentialsReady(targetProfile)) {
        return;
      }
      modelPickerTargetProfileKey.value = targetProfile?._key || "";
      modelPickerOpen.value = true;
      modelPickerLoading.value = true;
      modelPickerError.value = "";
      modelPickerItems.value = [];
      const targetEndpointRef = settingsEndpointRef.value;
      const targetProfileEnvManaged = targetProfile ? llmProfileEnvManaged(targetProfile) : null;
      const provider = targetProfile
        ? profileProviderChoice(targetProfile)
        : llmFieldValue(state.llm, llmEnvManaged.value, "inference_provider") ||
          llmFieldValue(state.llm, llmEnvManaged.value, "provider");
      const providerChoice = normalizeSetupProviderChoice(provider, { allowEmpty: true });
      const endpoint = targetProfile
        ? llmFieldValue(targetProfile, targetProfileEnvManaged, "endpoint")
        : llmFieldValue(state.llm, llmEnvManaged.value, "endpoint");
      const credentialField = providerChoice === SETUP_PROVIDER_CLOUDFLARE ? "cloudflare_api_token" : "api_key";
      const apiKey = targetProfile
        ? llmFieldValue(targetProfile, targetProfileEnvManaged, credentialField)
        : llmFieldValue(state.llm, llmEnvManaged.value, credentialField);
      const apiKeyRaw = targetProfile
        ? llmFieldEnvRawValue(targetProfileEnvManaged, credentialField)
        : llmFieldEnvRawValue(llmEnvManaged.value, credentialField);
      try {
        const payload = await endpointApiFetch(targetEndpointRef, "/settings/agent/models", {
          method: "POST",
          body: {
            target_profile: targetProfile ? trimText(targetProfile._savedName) || trimText(targetProfile.name) : "",
            inference_provider: providerChoice,
            cloudflare_account_id: providerChoice === SETUP_PROVIDER_CLOUDFLARE
              ? llmFieldValue(targetProfile || state.llm, targetProfileEnvManaged || llmEnvManaged.value, "cloudflare_account_id")
              : "",
            endpoint: setupProviderSupportsCustomAPIBase(providerChoice) ? endpoint : "",
            api_key:
              providerChoice === SETUP_PROVIDER_MISTERMORPH_PRO
                ? ""
                : apiKeyRaw || apiKey,
          },
        });
        modelPickerItems.value = modelPickerItemsFromPayload(payload, currentLocale());
      } catch (e) {
        modelPickerError.value = agentSettingsErrorMessage(e, targetEndpointRef, "msg_load_failed");
      } finally {
        modelPickerLoading.value = false;
      }
    }

    function applyModelOption(item) {
      if (agentSettingsReadOnly.value) {
        return;
      }
      const nextModel = String(item?.value || "").trim();
      const targetProfile = state.llm.profiles.find((profile) => profile._key === modelPickerTargetProfileKey.value) || null;
      if (targetProfile) {
        updateProfileField(targetProfile._key, { field: "model", value: nextModel });
        return;
      }
      if (state.llm.model === nextModel) {
        return;
      }
      state.llm.model = nextModel;
      updateLLMDirty();
    }

    async function openTestConnection(profileKey = "") {
      const targetProfile = state.llm.profiles.find((item) => item._key === profileKey) || null;
      if (!targetProfile && testConnectionDisabled.value) {
        return;
      }
      if (targetProfile && testConnectionDisabledForProfile(targetProfile)) {
        return;
      }
      testConnectionTargetProfileKey.value = targetProfile?._key || "";
      primeConnectionTestState(targetProfile);
      await openReentrantDialog(testConnectionOpen);
      await runConnectionTest();
    }

    async function runConnectionTest() {
      if (testConnectionLoading.value) {
        return;
      }
      const targetProfile = currentTestTargetProfile.value;
      const targetProfileName = trimText(targetProfile?.name);
      if (testConnectionTargetProfileKey.value !== "" && targetProfileName === "") {
        testConnectionError.value = t("settings_agent_profile_name_required");
        return;
      }
      const nextPayload = primeConnectionTestState(
        targetProfile,
        targetProfile ? buildProfileTestPayload(targetProfile) : buildDefaultLLMTestPayload(),
      );
      const shouldReloadCodexAuthStatus = targetProfile
        ? profileUsesCodexProvider(targetProfile) && !profileUsesCodexAPIKey(targetProfile)
        : defaultIsCodexProvider.value && !defaultCodexUsesAPIKey.value;
      const targetEndpointRef = settingsEndpointRef.value;
      testConnectionLoading.value = true;
      try {
        const body = {
          llm: nextPayload,
        };
        if (targetProfileName !== "") {
          body.target_profile = trimText(targetProfile._savedName) || targetProfileName;
        }
        const payload = await endpointApiFetch(targetEndpointRef, "/settings/agent/test", {
          method: "POST",
          body,
        });
        testConnectionMeta.provider = String(payload?.provider || "").trim();
        const resolvedAPIBase = String(payload?.api_base || "").trim();
        if (resolvedAPIBase !== "") {
          testConnectionMeta.apiBase = resolvedAPIBase;
        }
        testConnectionMeta.model = String(payload?.model || "").trim();
        const items = Array.isArray(payload?.benchmarks) ? payload.benchmarks : [];
        testConnectionBenchmarks.value = items.map((item) => ({
          id: String(item?.id || "").trim(),
          ok: item?.ok === true,
          duration_ms: Number(item?.duration_ms || 0),
          detail: String(item?.detail || "").trim(),
          error: String(item?.error || "").trim(),
          raw_response: String(item?.raw_response || ""),
        }));
      } catch (e) {
        testConnectionError.value = agentSettingsErrorMessage(e, targetEndpointRef, "msg_load_failed");
      } finally {
        testConnectionLoading.value = false;
        if (shouldReloadCodexAuthStatus) {
          void loadCodexAuthStatus(targetEndpointRef);
        }
      }
    }

    function setToolEnabled(id, value) {
      if (agentSettingsReadOnly.value) {
        return;
      }
      if (!Object.prototype.hasOwnProperty.call(state.tools, id)) {
        return;
      }
      state.tools[id] = !!value;
      updateToolsDirty();
    }

    function setManagedRuntimeEnabled(id, value) {
      if (!Object.prototype.hasOwnProperty.call(state.managedRuntimes, id)) {
        return;
      }
      state.managedRuntimes[id] = !!value;
      updateConsoleManagedDirty();
    }

    function refreshMobileMode() {
      isMobile.value = typeof window !== "undefined" && window.innerWidth <= 920;
    }

    function showIndexView() {
      mobilePanelVisible.value = false;
    }

    function openLogsPage() {
      router.push(endpointRoutePath(endpointState.selectedRef, "/logs"));
    }

    function selectSection(id) {
      const sectionID = normalizeSettingsSectionID(id);
      const nextPath = settingsSectionPath(endpointState.selectedRef, sectionID);
      if (route.path === nextPath) {
        selectedSectionID.value = sectionID;
        if (isMobile.value) {
          mobilePanelVisible.value = true;
        }
        return;
      }
      // The route watcher selects the section once navigation succeeds; the unsaved-changes guard
      // may cancel it, in which case the current section stays on screen.
      void router.push(nextPath).then((failure) => {
        if (!failure && isMobile.value) {
          mobilePanelVisible.value = true;
        }
      });
    }

    function isSelectedSection(item) {
      return !isMobile.value && String(item?.id || "") === selectedSectionID.value;
    }

    function sectionClass(item) {
      const classes = ["settings-index-item", "workspace-sidebar-item"];
      if (isSelectedSection(item)) {
        classes.push("is-active");
      }
      return classes.join(" ");
    }

    function ensureSettingsSectionData(sectionID = selectedSectionID.value) {
      const normalizedSectionID = normalizeSettingsSectionID(sectionID);
      if (["agent", "routes", "tools", "mcp"].includes(normalizedSectionID)) {
        if (!agentSettingsLoaded.value && !agentLoading.value) {
          void loadAgentSettings(settingsEndpointRef.value);
          return;
        }
        ensureLoadedAgentSnapshotsForSection(normalizedSectionID);
        return;
      }
      if (normalizedSectionID === "persona") {
        if (!personaSettingsLoaded.value && !personaLoading.value) {
          void loadPersonaSettings(settingsEndpointRef.value);
        }
        return;
      }
      if (["channels", "runtimes", "security", "automation"].includes(normalizedSectionID)) {
        if (selectedEndpointIsConsole.value && !consoleSettingsLoaded.value && !consoleLoading.value) {
          void loadConsoleSettings();
        }
        return;
      }
      if (normalizedSectionID === "system") {
        if (selectedEndpointIsConsole.value && !systemSettingsLoaded.value && !systemLoading.value) {
          void loadSystemSettings();
        }
        if (!desktopSettingsLoaded.value && !desktopLoading.value) {
          void loadDesktopSettings();
        }
        return;
      }
      if (normalizedSectionID === "console") {
        if (selectedEndpointIsConsole.value && !consoleSettingsLoaded.value && !consoleLoading.value) {
          void loadConsoleSettings();
        }
      }
    }

    function discardSettingsDrafts() {
      agentSettingsRequestSeq += 1;
      agentLoading.value = false;
      resetAgentSettingsState();

      personaSettingsRequestSeq += 1;
      personaLoading.value = false;
      resetPersonaSettingsState();
      personaErr.value = "";
      personaOk.value = "";

      resetConsoleSettingsState();
      consoleEndpointErrorOpen.value = false;
      resetSystemSettingsState();

      apiBasePickerOpen.value = false;
      modelPickerOpen.value = false;
      modelPickerTargetProfileKey.value = "";
      modelPickerError.value = "";
      modelPickerItems.value = [];
      testConnectionOpen.value = false;
      testConnectionError.value = "";
      testConnectionBenchmarks.value = [];
      testConnectionTargetProfileKey.value = "";
      testConnectionMeta.provider = "";
      testConnectionMeta.apiBase = "";
      testConnectionMeta.model = "";
      closeDeleteProfileDialog();
      codexAuthDialogOpen.value = false;
      xaiAuthDialogOpen.value = false;
      proAuthDialogOpen.value = false;
    }

    onMounted(() => {
      window.addEventListener("resize", refreshMobileMode);
      refreshMobileMode();
      if (isMobile.value && settingsRouteSection(route)) {
        mobilePanelVisible.value = true;
      }
      ensureSettingsSectionData(selectedSectionID.value);
    });

    onUnmounted(() => {
      window.removeEventListener("resize", refreshMobileMode);
      clearCodexLoginTimer();
      if (desktopChecksumCopyTimer) {
        window.clearTimeout(desktopChecksumCopyTimer);
        desktopChecksumCopyTimer = 0;
      }
      discardSettingsDrafts();
    });

    watch(
      () => settingsRouteSection(route),
      (routeSection, previousRouteSection) => {
        const sectionID = normalizeSettingsSectionID(routeSection);
        if (previousRouteSection !== undefined && normalizeSettingsSectionID(previousRouteSection) !== sectionID) {
          discardSettingsDrafts();
        }
        selectedSectionID.value = sectionID;
        ensureSettingsSectionData(sectionID);
        if (routeSection && routeSection !== sectionID) {
          router.replace(settingsSectionPath(endpointState.selectedRef, sectionID));
        }
        if (isMobile.value && routeSection) {
          mobilePanelVisible.value = true;
        }
      },
      { immediate: true }
    );

    watch(
      settingsSections,
      (items) => {
        if (!items.some((item) => item.id === selectedSectionID.value)) {
          const sectionID = items[0]?.id || SETTINGS_DEFAULT_SECTION_ID;
          selectedSectionID.value = sectionID;
          const nextPath = settingsSectionPath(endpointState.selectedRef, sectionID);
          if (route.path !== nextPath) {
            router.replace(nextPath);
          }
          ensureSettingsSectionData(sectionID);
        }
      },
      { immediate: true }
    );

    watch(
      () => endpointState.selectedRef,
      (next, previous) => {
        if (trimText(next) === trimText(previous)) {
          return;
        }
        resetCodexAuthEndpointState();
        resetXAIAuthEndpointState();
        resetProAuthEndpointState();
        discardSettingsDrafts();
        ensureSettingsSectionData(selectedSectionID.value);
      }
    );

    watch(consoleEndpointRef, () => {
      resetDesktopSettingsState();
      if (selectedSectionID.value === "system") {
        ensureSettingsSectionData("system");
      }
    });

    watch(
      selectedEndpointIsConsole,
      (enabled) => {
        if (enabled) {
          ensureSettingsSectionData(selectedSectionID.value);
          return;
        }
        if (["runtimes", "channels", "security", "automation", "system"].includes(selectedSectionID.value)) {
          selectedSectionID.value = "console";
          ensureSettingsSectionData("console");
        }
      },
      { immediate: true }
    );

    watch(deleteProfileDialogOpen, (open) => {
      if (!open) {
        deleteProfileTargetKey.value = "";
      }
    });

    watch(codexAuthDialogOpen, (open) => {
      if (!open) {
        cancelCodexAuthFlow();
        codexAuthError.value = "";
      }
    });


    watch(
      showCodexAuthCard,
      (visible) => {
        if (visible) {
          void loadCodexAuthStatus();
        } else {
          resetCodexAuthEndpointState();
        }
      },
      { immediate: false }
    );

    watch(
      showXAIAuthCard,
      (visible) => {
        if (visible) {
          void loadXAIAuthStatus();
        } else {
          resetXAIAuthFlow();
        }
      },
      { immediate: false }
    );

    watch(
      showProAuthCard,
      (visible) => {
        if (visible) {
          void loadProAuthStatus();
        } else {
          resetProAuthFlow();
        }
      },
      { immediate: false }
    );

    return {
      addProfileDraft,
      addProfileOpen,
      addProfileError,
      addProfileSaving,
      addProfileSaveDisabled,
      openAddProfileDialog,
      createProfile,
      t,
      lang,
      loggingOut,
      agentLoading,
      agentSaving,
      agentSavingTarget,
      agentFormDisabledReason,
      agentSettingsReadOnly,
      agentSettingsReadOnlyMessage,
      agentValidationVisible,
      deleteProfileDialogOpen,
      consoleLoading,
      consoleSaving,
      consoleSavingTarget,
      systemLoading,
      systemSaving,
      personaLoading,
      personaSaving,
      personaSavingTarget,
      personaErr,
      personaOk,
      soulContent,
      personaAvatarURL,
      personaAvatarBusy,
      personaAvatarDisabled,
      personaAvatarSourceTypes,
      defaultAvatarMarkup,
      PERSONA_AVATAR_MAX_SOURCE_BYTES,
      PERSONA_AVATAR_SIZE,
      desktopLoading,
      desktopChecking,
      desktopChecksumCopied,
      desktopBuildChannel,
      autoUpdateEnabled,
      autoUpdateChannel,
      autoUpdateSaving,
      updateChannelOptions,
      setAutoUpdateChannel,
      setAutoUpdateEnabled,
      llmConfigPath,
      consoleConfigPath,
      agentConfigValues,
      agentFieldStates,
      consoleConfigValues,
      consoleFieldStates,
      consoleEndpoints,
      settingsEndpointRef,
      consoleRuntimeEndpoints,
      consoleSettingsLoaded,
      addConsoleEndpointRequested,
      consumeConsoleEndpointAddRequest,
      consoleEndpointErrorOpen,
      consoleEndpointError,
      consoleEndpointErrorTitle,
      consoleEndpointErrorActions,
      authProfiles,
      securityConfigGroups,
      consolePasswordConfigured,
      systemConfigValues,
      systemFieldStates,
      TOOL_ADVANCED_CONFIG_GROUPS,
      LLM_SYSTEM_CONFIG_GROUPS,
      CONSOLE_DEPLOYMENT_CONFIG_GROUPS,
      REMOTE_CONTROL_CONFIG_GROUPS,
      AUTOMATION_CONFIG_GROUPS,
      SYSTEM_ADVANCED_CONFIG_GROUPS,
      SYSTEM_CONFIG_GROUPS,
      desktopUpdateResult,
      state,
      llmEnvManaged,
      llmSecretFields,
      providerItems,
      reasoningEffortItems,
      toolsEmulationItems,
      profileOptions,
      routeProfileOptions,
      agentValidationError,
      profileSaveDisabled,
      llmProfileSecretFields,
      deleteProfileDialogText,
      deleteProfileDialogActions,
      apiBasePickerItems,
      toolItems,
      managedRuntimeItems,
      groupTriggerItems,
      settingsSections,
      selectedSection,
      sectionSaveUnits,
      sectionSaving,
      sectionSaveFailed,
      sectionSaveBusy,
      saveSection,
      modelPickerSelectedValue,
      openChannel,
      openProfileKey,
      openedProfile,
      openProfilePane,
      closeProfilePane,
      profileSummary,
      profileLogo,
      channelTiles,
      channelGroups,
      channelTriggerHiddenPaths,
      CHANNEL_TRIGGER_CONFIG_GROUPS,
      openChannelTitleKey,
      openChannelPane,
      closeChannelPane,
      channelManagedItem,
      leaveDialogOpen,
      leaveDialogText,
      leaveDialogActions,
      selectedEndpointIsConsole,
      activeSaveKind,
      isMobile,
      showIndexPane,
      showPanelPane,
      mobileShowBack,
      mobileBarTitle,
      pageClass,
      llmSaveDisabled,
      toolsSaveDisabled,
      mcpSaveDisabled,
      mcpValidationError,
      consoleSaveDisabled,
      telegramSaveDisabled,
      slackSaveDisabled,
      lineSaveDisabled,
      larkSaveDisabled,
      mixinSaveDisabled,
      discordSaveDisabled,
      whatsappSaveDisabled,
      guardSaveDisabled,
      personaDirty,
      personaSaveDisabled,
      personaEditorMeta,
      desktopCheckDisabled,
      updateChannelLabel,
      desktopInstalledText,
      desktopUpdateState,
      desktopUpdateStateText,
      desktopUpdateHasRelease,
      desktopUpdateReleaseTitle,
      desktopUpdateReleaseDate,
      desktopUpdateNotesSource,
      desktopUpdateChecksumShort,
      desktopUpdateChecksum,
      desktopUpdateDownloadDisabled,
      desktopUpdateAssetURL,
      testConnectionDisabled,
      profileIsInUse,
      profileDirty,
      llmActionMenuItems,
      advancedSettingsOpen,
      advancedSettingsTitle,
      advancedSettingsGroups,
      advancedSettingsValues,
      advancedSettingsFieldStates,
      advancedSettingsLoading,
      advancedSettingsSaving,
      advancedSettingsSaveDisabled,
      advancedSettingsDirty,
      advancedConfigPanel,
      openToolAdvancedSettings,
      channelActionMenuItems,
      closeAdvancedSettings,
      saveAdvancedConfigSettings,
      saveAdvancedSettings,
      showCodexAuthCard,
      defaultCodexAuthDisabled,
      showXAIAuthCard,
      showProAuthCard,
      codexAuthLoading,
      codexAuthBusy,
      codexAuthError,
      codexAuthDialogOpen,
      codexAuthStatus,
      codexAuthSummary,
      codexAuthButtonState,
      codexAuthButtonTitle,
      codexLoginSession,
      codexLoginVerificationURL,
      codexLoginUserCode,
      codexLoginExpiresLabel,
      pollCodexLogin,
      logoutCodexAuth,
      loadCodexAuthStatus,
      openCodexAuthDialog,
      xaiAuthLoading,
      xaiAuthBusy,
      xaiAuthError,
      xaiAuthDialogOpen,
      xaiSetDefault,
      xaiAuthStatus,
      xaiAuthSummary,
      xaiAuthButtonState,
      xaiAuthReady,
      xaiAuthButtonTitle,
      xaiLoginSession,
      xaiLoginVerificationURL,
      xaiLoginUserCode,
      xaiLoginExpiresLabel,
      pollXAILogin,
      logoutXAIAuth,
      loadXAIAuthStatus,
      openXAIAuthDialog,
      reloginXAIAuth,
      proAuthLoading,
      proAuthBusy,
      proAuthError,
      proAuthDialogOpen,
      proAuthStatus,
      proAuthSummary,
      proAuthButtonState,
      proAuthButtonTitle,
      proLoginSession,
      proLoginVerificationURL,
      proLoginUserCode,
      proLoginExpiresLabel,
      pollProLogin,
      logoutProAuth,
      loadProAuthStatus,
      openProAuthDialog,
      logout,
      saveAgentSettings,
      saveMCPServers,
      saveConsoleSettings,
      saveConfigSettings,
      saveConsoleCollection,
      savePersona,
      savePersonaAvatar,
      deletePersonaAvatar,
      updatePersonaSoulContent,
      runDesktopUpdateCheck,
      copyDesktopUpdateChecksum,
      openDesktopUpdateDownload,
      openDesktopUpdateReleases,
      updateDefaultLLMField,
      updateProfileField,
      llmProfileEnvManaged,
      profileModelLookupCredentialsReady,
      profileUsesCodexProvider,
      profileCodexAuthDisabled,
      profileUsesXAIProvider,
      profileUsesProProvider,
      addLLMProfile,
      saveLLMProfile,
      confirmRemoveLLMProfile,
      removeLLMProfile,
      addFallbackProfile,
      updateFallbackProfile,
      removeFallbackProfile,
      moveFallbackProfile,
      openAPIBasePicker,
      applyAPIBaseOption,
      openModelPicker,
      applyModelOption,
      openTestConnection,
      testConnectionDisabledForProfile,
      runConnectionTest,
      setToolEnabled,
      setManagedRuntimeEnabled,
      consoleFieldEnvManaged,
      consoleFieldManagedHeadline,
      consoleSecretEditable,
      updateTelegramField,
      updateSlackField,
      updateLineField,
      updateLarkField,
      updateMixinField,
      updateDiscordField,
      updateWhatsAppField,
      reloadConsoleSettingsAfterWeChatLogin,
      consoleSecretField,
      consoleSecretRevealPath,
      llmRevealPrefix,
      endpointApiFetch,
      updateDiscordGroupTrigger,
      updateTelegramGroupTrigger,
      updateSlackGroupTrigger,
      updateLineGroupTrigger,
      updateLarkGroupTrigger,
      updateGuardField,
      selectSection,
      isSelectedSection,
      sectionClass,
      showIndexView,
      openLogsPage,
      apiBasePickerOpen,
      modelPickerOpen,
      modelPickerLoading,
      modelPickerError,
      modelPickerItems,
      testConnectionOpen,
      testConnectionLoading,
      testConnectionError,
      testConnectionBenchmarks,
      testConnectionMeta,
      onLanguageChange: localeState.applyLanguageChange,
    };
  },
  template: `
    <AppPage :title="t('settings_title')" :class="pageClass" :overlayBar="true">
      <template #leading>
        <div class="settings-page-bar">
          <QButton
            v-if="mobileShowBack"
            class="plain xs icon settings-page-bar-back"
            :title="t('settings_title')"
            :aria-label="t('settings_title')"
            @click="showIndexView"
          >
            <PhArrowLeft class="icon" />
          </QButton>
          <h2 class="page-title page-bar-title workspace-section-title">{{ mobileBarTitle }}</h2>
        </div>
      </template>
      <div class="settings-workbench">
        <aside v-if="showIndexPane" class="settings-index workspace-sidebar-section">
          <div class="settings-index-items workspace-sidebar-list">
            <button
              v-for="item in settingsSections"
              :key="item.id"
              type="button"
              :class="sectionClass(item)"
              :aria-current="isSelectedSection(item) ? 'page' : undefined"
              @click="selectSection(item.id)"
            >
              <span class="workspace-sidebar-item-copy settings-index-item-copy">
                <component :is="item.icon" class="settings-index-item-icon icon" aria-hidden="true" />
                <span class="workspace-sidebar-item-title">{{ item.title }}</span>
              </span>
              <span class="workspace-sidebar-item-marker">
                <QBadge v-if="isSelectedSection(item)" dot type="primary" size="sm" />
              </span>
            </button>
          </div>
        </aside>

        <div v-if="showPanelPane && selectedSection" class="settings-panel-scroll">
          <div v-if="selectedSection.id === 'agent'" class="settings-panel-body settings-panel-body-plain">
            <div class="settings-channels settings-profiles-layout" :class="{ 'has-pane': openedProfile && !isMobile }">
            <div class="settings-profiles-main">
            <QCard variant="default">
              <div class="settings-panel-shell">
                <header class="settings-panel-head settings-llm-panel-head">
                  <div class="settings-panel-copy">
                    <h3 class="settings-panel-title workspace-document-title">{{ t("settings_agent_block_title") }}</h3>
                    <p class="settings-panel-meta">{{ selectedSection.meta }}</p>
                  </div>
                  <div class="settings-profile-actions settings-default-llm-actions">
                    <QDropdownMenu
                      class="settings-llm-actions-menu"
                      :items="llmActionMenuItems()"
                      hideSelected
                      hideActionLabel
                      :disabled="agentLoading || agentSaving"
                    >
                      <PhDotsThree class="settings-llm-actions-menu-icon" />
                      <span class="settings-llm-actions-menu-accessible">{{ t("todo_action_more") }}</span>
                    </QDropdownMenu>
                  </div>
                </header>

                <QFence
                  v-if="agentValidationVisible && agentValidationError"
                  type="danger"
                  icon="PhXCircle"
                  :text="agentValidationError"
                />

                <QFence
                  v-if="agentSettingsReadOnly"
                  type="warning"
                  :text="agentSettingsReadOnlyMessage"
                />

                <div class="settings-panel-body">
                  <div class="settings-agent-stack">
                    <section class="settings-agent-section">
                      <LLMConfigForm
                        :config="state.llm"
                        :busy="agentLoading || agentSaving"
                        :disabledReason="agentFormDisabledReason"
                        :readOnly="agentSettingsReadOnly"
                        :envManaged="llmEnvManaged"
                        :secretFields="llmSecretFields"
                        :revealPrefix="llmRevealPrefix()"
                        :providerItems="providerItems"
                        :reasoningEffortItems="reasoningEffortItems"
                        :toolsEmulationItems="toolsEmulationItems"
                        :enableAPIBasePicker="true"
                        :enableModelPicker="true"
                        :showCodexAuthAction="true"
                        :codexAuthDisabled="defaultCodexAuthDisabled"
                        :codexAuthState="codexAuthButtonState"
                        :codexAuthTitle="codexAuthButtonTitle"
                        :showXAIAuthAction="selectedEndpointIsConsole"
                        :xaiAuthState="xaiAuthButtonState"
                        :xaiAuthTitle="xaiAuthButtonTitle"
                        :showProAuthAction="selectedEndpointIsConsole"
                        :proAuthState="proAuthButtonState"
                        :proAuthTitle="proAuthButtonTitle"
                        @update-field="updateDefaultLLMField"
                        @open-api-base-picker="openAPIBasePicker"
                        @open-model-picker="openModelPicker"
                        @open-codex-auth="openCodexAuthDialog"
                        @open-xai-auth="openXAIAuthDialog"
                        @open-pro-auth="openProAuthDialog"
                      />
                    </section>

                    <section class="settings-agent-section">
                      <header class="settings-agent-section-head">
                        <div class="settings-agent-section-copy">
                          <strong class="settings-toggle-title">{{ t("settings_agent_profiles_title") }}</strong>
                          <p class="settings-toggle-note">{{ t("settings_agent_profiles_note") }}</p>
                        </div>
                      </header>

                      <div class="settings-profile-list">
                        <div
                          v-for="profile in state.llm.profiles.filter((item) => !item._draft)"
                          :key="profile._key"
                          class="settings-profile-row"
                          :class="{ 'is-active': openProfileKey === profile._key }"
                        >
                          <button
                            type="button"
                            class="settings-profile-row-main"
                            :aria-pressed="openProfileKey === profile._key ? 'true' : 'false'"
                            @click="openProfilePane(profile._key)"
                          >
                            <span
                              class="settings-profile-row-icon"
                              :title="t(profileIsInUse(profile) ? 'settings_agent_profile_status_in_use' : 'settings_agent_profile_status_available')"
                            >
                              <span class="inference-provider-logo" :class="profileLogo(profile).className" aria-hidden="true">
                                <img v-if="profileLogo(profile).src" class="inference-provider-logo-image" :src="profileLogo(profile).src" alt="" />
                                <span v-else class="inference-provider-logo-fallback">{{ profileLogo(profile).text }}</span>
                              </span>
                              <span v-if="profileIsInUse(profile)" class="settings-profile-row-badge" aria-hidden="true"></span>
                            </span>
                            <span class="settings-profile-row-text">
                              <span class="settings-profile-row-name">{{ profile.name || t("settings_agent_profile_placeholder") }}</span>
                              <span class="settings-profile-row-meta">{{ profileSummary(profile) || t("settings_agent_profile_not_set") }}</span>
                            </span>
                            <span v-if="profileDirty(profile)" class="settings-channel-tile-dirty settings-profile-row-dirty" :title="t('settings_channel_unsaved')" :aria-label="t('settings_channel_unsaved')"></span>
                            <PhCaretRight class="icon settings-profile-row-caret" aria-hidden="true" />
                          </button>
                        </div>

                        <QButton
                          type="button"
                          class="placeholder settings-profile-placeholder"
                          :disabled="agentLoading || agentSaving || agentSettingsReadOnly"
                          @click="openAddProfileDialog"
                        >
                          <PhPlus class="icon" />
                          {{ t("settings_agent_profile_add") }}
                        </QButton>
                      </div>
                    </section>

                    <section class="settings-agent-section">
                      <header class="settings-agent-section-head">
                        <div class="settings-agent-section-copy">
                          <strong class="settings-toggle-title">{{ t("settings_agent_fallback_title") }}</strong>
                          <p class="settings-toggle-note">{{ t("settings_agent_fallback_note") }}</p>
                        </div>
                      </header>

                      <p v-if="!profileOptions.length" class="settings-agent-empty">{{ t("settings_agent_fallback_empty") }}</p>

                      <div v-else class="settings-fallback-list">
                        <div v-for="(fallbackName, index) in state.llm.fallback_profiles" :key="index" class="settings-fallback-row">
                          <span class="settings-fallback-index">{{ index + 1 }}</span>
                          <QDropdownMenu
                            :key="fallbackName + '-' + index"
                            class="settings-fallback-picker"
                            :items="profileOptions"
                            :initialItem="profileOptions.find((item) => item.value === fallbackName) || null"
                            :placeholder="t('settings_agent_fallback_placeholder')"
                            :disabled="agentLoading || agentSaving || agentSettingsReadOnly"
                            @change="updateFallbackProfile(index, $event)"
                          />
                          <div class="settings-fallback-actions">
                            <QButton
                              type="button"
                              class="outlined icon settings-fallback-action"
                              :title="t('settings_agent_order_up')"
                              :aria-label="t('settings_agent_order_up')"
                              :disabled="agentLoading || agentSaving || agentSettingsReadOnly || index === 0"
                              @click="moveFallbackProfile(index, -1)"
                            >
                              <PhCaretUp class="icon" />
                            </QButton>
                            <QButton
                              type="button"
                              class="outlined icon settings-fallback-action"
                              :title="t('settings_agent_order_down')"
                              :aria-label="t('settings_agent_order_down')"
                              :disabled="agentLoading || agentSaving || agentSettingsReadOnly || index === state.llm.fallback_profiles.length - 1"
                              @click="moveFallbackProfile(index, 1)"
                            >
                              <PhCaretDown class="icon" />
                            </QButton>
                            <QButton
                              type="button"
                              class="danger plain icon settings-fallback-action"
                              :title="t('action_delete')"
                              :aria-label="t('action_delete')"
                              :disabled="agentLoading || agentSaving || agentSettingsReadOnly"
                              @click="removeFallbackProfile(index)"
                            >
                              <PhTrash class="icon" />
                            </QButton>
                          </div>
                        </div>

                        <QButton
                          type="button"
                          class="placeholder settings-profile-placeholder"
                          :disabled="agentLoading || agentSaving || agentSettingsReadOnly || !profileOptions.length"
                          @click="addFallbackProfile"
                        >
                          <PhPlus class="icon" />
                          {{ t("settings_agent_fallback_add") }}
                        </QButton>
                      </div>
                    </section>
                  </div>
                </div>
              </div>
            </QCard>

            <ConfigSettingsPanel
              v-for="group in LLM_SYSTEM_CONFIG_GROUPS"
              :key="group.id"
              :groups="[group]"
              :values="agentConfigValues"
              :fieldStates="agentFieldStates"
              :loading="agentLoading"
              :saving="agentSaving && agentSavingTarget === 'config'"
              saveScope="agent"
              @save="saveConfigSettings('agent', $event)"
            />
            </div>

            <div v-if="openedProfile && isMobile" class="settings-channel-pane-mask" aria-hidden="true" @click="closeProfilePane"></div>
            <Transition :name="isMobile ? 'settings-channel-sheet' : 'settings-channel-pane'">
              <aside
                v-if="openedProfile"
                :key="openedProfile._key"
                class="settings-channel-pane settings-profile-pane"
                :class="{ 'is-sheet': isMobile }"
                :role="isMobile ? 'dialog' : null"
                :aria-modal="isMobile ? 'true' : null"
                :aria-label="openedProfile.name || t('settings_agent_profile_placeholder')"
              >
                <div class="settings-channel-pane-shell">
                  <div class="settings-channel-pane-scroll">
                    <div class="settings-panel-shell">
                      <header class="settings-panel-head settings-channel-panel-head">
                        <div class="settings-panel-copy">
                          <h3 class="settings-panel-title workspace-document-title">{{ openedProfile.name || t("settings_agent_profile_placeholder") }}</h3>
                          <p class="settings-panel-meta">
                            {{ t(profileIsInUse(openedProfile) ? "settings_agent_profile_status_in_use" : "settings_agent_profile_status_available") }}<template v-if="profileSummary(openedProfile)"> · {{ profileSummary(openedProfile) }}</template>
                          </p>
                        </div>
                        <div class="settings-profile-actions settings-default-llm-actions">
                          <QButton class="plain xs icon" :title="t('settings_channel_close')" :aria-label="t('settings_channel_close')" @click="closeProfilePane">
                            <PhX class="icon" />
                          </QButton>
                        </div>
                      </header>

                      <div class="settings-panel-body settings-profile-pane-body">
                        <div class="settings-field settings-profile-name">
                          <span class="settings-field-label">{{ t("settings_agent_profile_name_label") }}</span>
                          <QInput
                            :modelValue="openedProfile.name"
                            :placeholder="t('settings_agent_profile_name_placeholder')"
                            :disabled="agentLoading || agentSaving || agentSettingsReadOnly"
                            @update:modelValue="updateProfileField(openedProfile._key, { field: 'name', value: $event })"
                          />
                        </div>
                        <LLMConfigForm
                          :config="openedProfile"
                          :busy="agentLoading || agentSaving"
                          :disabledReason="agentFormDisabledReason"
                          :readOnly="agentSettingsReadOnly"
                          :envManaged="llmProfileEnvManaged(openedProfile)"
                          :secretFields="llmProfileSecretFields(openedProfile)"
                          :revealPrefix="llmRevealPrefix(openedProfile)"
                          :providerItems="providerItems"
                          :reasoningEffortItems="reasoningEffortItems"
                          :toolsEmulationItems="toolsEmulationItems"
                          :enableModelPicker="true"
                          :modelLookupCredentialsReady="profileModelLookupCredentialsReady(openedProfile)"
                          :showCodexAuthAction="profileUsesCodexProvider(openedProfile)"
                          :codexAuthDisabled="profileCodexAuthDisabled(openedProfile)"
                          :codexAuthState="codexAuthButtonState"
                          :codexAuthTitle="codexAuthButtonTitle"
                          :showXAIAuthAction="profileUsesXAIProvider(openedProfile)"
                          :xaiAuthState="xaiAuthButtonState"
                          :xaiAuthTitle="xaiAuthButtonTitle"
                          :showProAuthAction="profileUsesProProvider(openedProfile)"
                          :proAuthState="proAuthButtonState"
                          :proAuthTitle="proAuthButtonTitle"
                          @update-field="updateProfileField(openedProfile._key, $event)"
                          @open-model-picker="openModelPicker(openedProfile._key)"
                          @open-codex-auth="openCodexAuthDialog"
                          @open-xai-auth="openXAIAuthDialog"
                          @open-pro-auth="openProAuthDialog"
                        />

                        <!-- Less common settings stay folded; edits join the same draft and save bar. -->
                        <details class="settings-profile-advanced">
                          <summary>
                            <PhCaretRight class="icon" aria-hidden="true" />
                            <span>{{ t("settings_advanced_action") }}</span>
                          </summary>
                          <div class="settings-profile-advanced-body">
                            <LLMConfigForm
                              :config="openedProfile"
                              :busy="agentLoading || agentSaving"
                              :disabledReason="agentFormDisabledReason"
                              :readOnly="agentSettingsReadOnly"
                              :envManaged="llmProfileEnvManaged(openedProfile)"
                              :secretFields="llmProfileSecretFields(openedProfile)"
                              :revealPrefix="llmRevealPrefix(openedProfile)"
                              :providerItems="providerItems"
                              :reasoningEffortItems="reasoningEffortItems"
                              :toolsEmulationItems="toolsEmulationItems"
                              :showAdvanced="true"
                              :advancedOnly="true"
                              @update-field="updateProfileField(openedProfile._key, $event)"
                            />
                          </div>
                        </details>

                        <div class="settings-profile-pane-actions">
                          <QButton
                            class="outlined"
                            :disabled="testConnectionDisabledForProfile(openedProfile)"
                            @click="openTestConnection(openedProfile._key)"
                          >
                            <PhGauge class="icon" />
                            {{ t("setup_llm_test_button") }}
                          </QButton>
                          <QButton
                            class="outlined danger"
                            :disabled="agentLoading || agentSaving || agentSettingsReadOnly"
                            @click="confirmRemoveLLMProfile(openedProfile._key)"
                          >
                            <PhTrash class="icon" />
                            {{ t("settings_agent_profile_delete") }}
                          </QButton>
                        </div>
                      </div>
                    </div>
                  </div>
                  <footer v-if="sectionSaveUnits.length || sectionSaveFailed" class="settings-channel-pane-foot">
                    <p class="settings-channel-pane-foot-text" :class="{ 'is-error': sectionSaveFailed }" role="status">
                      {{ sectionSaveFailed ? t('settings_save_bar_failed', { items: sectionSaveFailed }) : t('settings_channel_unsaved_note') }}
                    </p>
                    <QButton class="primary" :loading="sectionSaving" :disabled="sectionSaveBusy || !sectionSaveUnits.length" @click="saveSection">
                      {{ t('action_save') }}
                    </QButton>
                  </footer>
                </div>
              </aside>
            </Transition>
            </div>
          </div>

          <div v-else-if="selectedSection.id === 'routes'" class="settings-panel-body settings-panel-body-plain">
            <ModelRoutesPanel
              :values="agentConfigValues"
              :fieldStates="agentFieldStates"
              :profiles="routeProfileOptions"
              :loading="agentLoading"
              :saving="agentSaving && agentSavingTarget === 'config'"
              saveScope="agent"
              @save="saveConfigSettings('agent', $event)"
              @add-profile="openAddProfileDialog"
            />
          </div>

          <div v-else-if="selectedSection.id === 'channels'" class="settings-panel-body settings-panel-body-plain">
            <div class="settings-channels" :class="{ 'has-pane': openChannel && !isMobile }">
              <div class="settings-channel-groups">
                <section v-for="group in channelGroups" :key="group.id" class="settings-channel-group">
                  <h3 class="ui-kicker settings-channel-group-title">{{ t(group.titleKey) }}</h3>
                  <div class="settings-channel-grid">
                    <button
                      v-for="item in group.items"
                      :key="item.id"
                      type="button"
                      class="settings-channel-tile"
                      :class="{ 'is-configured': item.configured, 'is-active': openChannel === item.id }"
                      :aria-pressed="openChannel === item.id ? 'true' : 'false'"
                      @click="openChannelPane(item.id)"
                    >
                      <img class="settings-channel-tile-logo" :src="item.logo" alt="" />
                      <span class="settings-channel-tile-name">{{ t(item.titleKey) }}</span>
                      <span v-if="item.running" class="settings-channel-tile-running" :title="t('settings_channel_state_running')" :aria-label="t('settings_channel_state_running')"></span>
                      <span v-if="item.dirty" class="settings-channel-tile-dirty" :title="t('settings_channel_unsaved')" :aria-label="t('settings_channel_unsaved')"></span>
                    </button>
                  </div>
                </section>
              </div>
              <div v-if="openChannel && isMobile" class="settings-channel-pane-mask" aria-hidden="true" @click="closeChannelPane"></div>
              <Transition :name="isMobile ? 'settings-channel-sheet' : 'settings-channel-pane'">
                <aside
                  v-show="openChannel"
                  class="settings-channel-pane"
                  :class="{ 'is-sheet': isMobile }"
                  :role="isMobile ? 'dialog' : null"
                  :aria-modal="isMobile ? 'true' : null"
                  :aria-label="t(openChannelTitleKey)"
                >
                  <div class="settings-channel-pane-shell">
                      <div class="settings-channel-pane-scroll">
            <template v-if="openChannel === 'telegram'">
              <div class="settings-panel-shell">
                <header class="settings-panel-head settings-channel-panel-head">
                  <div class="settings-panel-copy">
                    <h3 class="settings-panel-title workspace-document-title">{{ t("settings_console_telegram_title") }}</h3>
                    <p class="settings-panel-meta">{{ t("settings_console_telegram_token_note") }}</p>
                  </div>
                  <div class="settings-profile-actions settings-default-llm-actions">
                    <QDropdownMenu
                      class="settings-llm-actions-menu"
                      :items="channelActionMenuItems('telegram')"
                      hideSelected
                      hideActionLabel
                      :disabled="consoleLoading || consoleSaving"
                    >
                      <PhDotsThree class="settings-llm-actions-menu-icon" />
                      <span class="settings-llm-actions-menu-accessible">{{ t("todo_action_more") }}</span>
                    </QDropdownMenu>
                    <QButton class="plain xs icon" :title="t('settings_channel_close')" :aria-label="t('settings_channel_close')" @click="closeChannelPane">
                      <PhX class="icon" />
                    </QButton>
                  </div>
                </header>

                <div class="settings-panel-body">
                  <div class="settings-form-grid">
                    <div class="settings-field is-wide">
                      <span class="settings-field-label">{{ t("settings_console_telegram_bot_token_label") }}</span>
                      <EnvManagedField v-if="consoleFieldEnvManaged('telegram', 'bot_token')" :name="consoleFieldManagedHeadline('telegram', 'bot_token')" />
                      <SecretInput
                        v-else
                        :modelValue="state.telegram.bot_token"
                        :status="consoleSecretField('telegram', 'bot_token')"
                        :revealPath="consoleSecretRevealPath('telegram', 'bot_token')"
                        :placeholder="t('settings_console_telegram_bot_token_placeholder')"
                        :disabled="consoleLoading || consoleSaving || !consoleSecretEditable('telegram', 'bot_token')"
                        @update:modelValue="updateTelegramField('bot_token', $event)"
                      />
                    </div>

                    <div class="settings-field is-wide">
                      <span class="settings-field-label">{{ t("settings_console_telegram_allowed_chat_ids_label") }}</span>
                      <QTextarea
                        :modelValue="state.telegram.allowed_chat_ids_text"
                        :rows="4"
                        :placeholder="t('settings_console_telegram_allowed_chat_ids_placeholder')"
                        :disabled="consoleLoading || consoleSaving"
                        @update:modelValue="updateTelegramField('allowed_chat_ids_text', $event)"
                      />
                      <p class="settings-field-note">{{ t("settings_console_telegram_allowed_chat_ids_note") }}</p>
                    </div>

                    <div class="settings-field is-wide">
                      <span class="settings-field-label">{{ t("settings_console_group_trigger_label") }}</span>
                      <QDropdownMenu
                        :key="state.telegram.group_trigger_mode || 'telegram-group-trigger'"
                        :items="groupTriggerItems"
                        :initialItem="groupTriggerItems.find((item) => item.value === state.telegram.group_trigger_mode) || groupTriggerItems[2]"
                        @change="updateTelegramGroupTrigger"
                      />
                      <p class="settings-field-note">{{ t("settings_console_telegram_group_trigger_note") }}</p>
                    </div>
                  </div>
                </div>
              </div>
            </template>

                        <template v-if="openChannel === 'slack'">
              <div class="settings-panel-shell">
                <header class="settings-panel-head settings-channel-panel-head">
                  <div class="settings-panel-copy">
                    <h3 class="settings-panel-title workspace-document-title">{{ t("settings_console_slack_title") }}</h3>
                    <p class="settings-panel-meta">{{ t("settings_console_slack_token_note") }}</p>
                  </div>
                  <div class="settings-profile-actions settings-default-llm-actions">
                    <QDropdownMenu
                      class="settings-llm-actions-menu"
                      :items="channelActionMenuItems('slack')"
                      hideSelected
                      hideActionLabel
                      :disabled="consoleLoading || consoleSaving"
                    >
                      <PhDotsThree class="settings-llm-actions-menu-icon" />
                      <span class="settings-llm-actions-menu-accessible">{{ t("todo_action_more") }}</span>
                    </QDropdownMenu>
                    <QButton class="plain xs icon" :title="t('settings_channel_close')" :aria-label="t('settings_channel_close')" @click="closeChannelPane">
                      <PhX class="icon" />
                    </QButton>
                  </div>
                </header>

                <div class="settings-panel-body">
                  <div class="settings-form-grid">
                    <div class="settings-field is-wide">
                      <span class="settings-field-label">{{ t("settings_console_slack_bot_token_label") }}</span>
                      <EnvManagedField v-if="consoleFieldEnvManaged('slack', 'bot_token')" :name="consoleFieldManagedHeadline('slack', 'bot_token')" />
                      <SecretInput
                        v-else
                        :modelValue="state.slack.bot_token"
                        :status="consoleSecretField('slack', 'bot_token')"
                        :revealPath="consoleSecretRevealPath('slack', 'bot_token')"
                        :placeholder="t('settings_console_slack_bot_token_placeholder')"
                        :disabled="consoleLoading || consoleSaving || !consoleSecretEditable('slack', 'bot_token')"
                        @update:modelValue="updateSlackField('bot_token', $event)"
                      />
                    </div>

                    <div class="settings-field is-wide">
                      <span class="settings-field-label">{{ t("settings_console_slack_app_token_label") }}</span>
                      <EnvManagedField v-if="consoleFieldEnvManaged('slack', 'app_token')" :name="consoleFieldManagedHeadline('slack', 'app_token')" />
                      <SecretInput
                        v-else
                        :modelValue="state.slack.app_token"
                        :status="consoleSecretField('slack', 'app_token')"
                        :revealPath="consoleSecretRevealPath('slack', 'app_token')"
                        :placeholder="t('settings_console_slack_app_token_placeholder')"
                        :disabled="consoleLoading || consoleSaving || !consoleSecretEditable('slack', 'app_token')"
                        @update:modelValue="updateSlackField('app_token', $event)"
                      />
                    </div>

                    <div class="settings-field is-wide">
                      <span class="settings-field-label">{{ t("settings_console_slack_allowed_team_ids_label") }}</span>
                      <QTextarea
                        :modelValue="state.slack.allowed_team_ids_text"
                        :rows="3"
                        :placeholder="t('settings_console_slack_allowed_team_ids_placeholder')"
                        :disabled="consoleLoading || consoleSaving"
                        @update:modelValue="updateSlackField('allowed_team_ids_text', $event)"
                      />
                      <p class="settings-field-note">{{ t("settings_console_slack_allowed_team_ids_note") }}</p>
                    </div>

                    <div class="settings-field is-wide">
                      <span class="settings-field-label">{{ t("settings_console_slack_allowed_channel_ids_label") }}</span>
                      <QTextarea
                        :modelValue="state.slack.allowed_channel_ids_text"
                        :rows="4"
                        :placeholder="t('settings_console_slack_allowed_channel_ids_placeholder')"
                        :disabled="consoleLoading || consoleSaving"
                        @update:modelValue="updateSlackField('allowed_channel_ids_text', $event)"
                      />
                      <p class="settings-field-note">{{ t("settings_console_slack_allowed_channel_ids_note") }}</p>
                    </div>

                    <div class="settings-field is-wide">
                      <span class="settings-field-label">{{ t("settings_console_group_trigger_label") }}</span>
                      <QDropdownMenu
                        :key="state.slack.group_trigger_mode || 'slack-group-trigger'"
                        :items="groupTriggerItems"
                        :initialItem="groupTriggerItems.find((item) => item.value === state.slack.group_trigger_mode) || groupTriggerItems[2]"
                        @change="updateSlackGroupTrigger"
                      />
                      <p class="settings-field-note">{{ t("settings_console_slack_group_trigger_note") }}</p>
                    </div>
                  </div>
                </div>
              </div>
            </template>

                        <template v-if="openChannel === 'line'">
              <div class="settings-panel-shell">
                <header class="settings-panel-head settings-channel-panel-head">
                  <div class="settings-panel-copy">
                    <h3 class="settings-panel-title workspace-document-title">{{ t("settings_console_line_title") }}</h3>
                    <p class="settings-panel-meta">{{ t("settings_console_line_token_note") }}</p>
                  </div>
                  <div class="settings-profile-actions settings-default-llm-actions">
                    <QDropdownMenu
                      class="settings-llm-actions-menu"
                      :items="channelActionMenuItems('line')"
                      hideSelected
                      hideActionLabel
                      :disabled="consoleLoading || consoleSaving"
                    >
                      <PhDotsThree class="settings-llm-actions-menu-icon" />
                      <span class="settings-llm-actions-menu-accessible">{{ t("todo_action_more") }}</span>
                    </QDropdownMenu>
                    <QButton class="plain xs icon" :title="t('settings_channel_close')" :aria-label="t('settings_channel_close')" @click="closeChannelPane">
                      <PhX class="icon" />
                    </QButton>
                  </div>
                </header>

                <div class="settings-panel-body">
                  <div class="settings-form-grid">
                    <div class="settings-field is-wide">
                      <span class="settings-field-label">{{ t("settings_console_line_channel_access_token_label") }}</span>
                      <EnvManagedField v-if="consoleFieldEnvManaged('line', 'channel_access_token')" :name="consoleFieldManagedHeadline('line', 'channel_access_token')" />
                      <SecretInput
                        v-else
                        :modelValue="state.line.channel_access_token"
                        :status="consoleSecretField('line', 'channel_access_token')"
                        :revealPath="consoleSecretRevealPath('line', 'channel_access_token')"
                        :placeholder="t('settings_console_line_channel_access_token_placeholder')"
                        :disabled="consoleLoading || consoleSaving || !consoleSecretEditable('line', 'channel_access_token')"
                        @update:modelValue="updateLineField('channel_access_token', $event)"
                      />
                    </div>

                    <div class="settings-field is-wide">
                      <span class="settings-field-label">{{ t("settings_console_line_channel_secret_label") }}</span>
                      <EnvManagedField v-if="consoleFieldEnvManaged('line', 'channel_secret')" :name="consoleFieldManagedHeadline('line', 'channel_secret')" />
                      <SecretInput
                        v-else
                        :modelValue="state.line.channel_secret"
                        :status="consoleSecretField('line', 'channel_secret')"
                        :revealPath="consoleSecretRevealPath('line', 'channel_secret')"
                        :placeholder="t('settings_console_line_channel_secret_placeholder')"
                        :disabled="consoleLoading || consoleSaving || !consoleSecretEditable('line', 'channel_secret')"
                        @update:modelValue="updateLineField('channel_secret', $event)"
                      />
                    </div>

                    <div class="settings-field is-wide">
                      <span class="settings-field-label">{{ t("settings_console_line_allowed_group_ids_label") }}</span>
                      <QTextarea
                        :modelValue="state.line.allowed_group_ids_text"
                        :rows="4"
                        :placeholder="t('settings_console_line_allowed_group_ids_placeholder')"
                        :disabled="consoleLoading || consoleSaving"
                        @update:modelValue="updateLineField('allowed_group_ids_text', $event)"
                      />
                      <p class="settings-field-note">{{ t("settings_console_line_allowed_group_ids_note") }}</p>
                    </div>

                    <div class="settings-field is-wide">
                      <span class="settings-field-label">{{ t("settings_console_group_trigger_label") }}</span>
                      <QDropdownMenu
                        :key="state.line.group_trigger_mode || 'line-group-trigger'"
                        :items="groupTriggerItems"
                        :initialItem="groupTriggerItems.find((item) => item.value === state.line.group_trigger_mode) || groupTriggerItems[2]"
                        @change="updateLineGroupTrigger"
                      />
                      <p class="settings-field-note">{{ t("settings_console_line_group_trigger_note") }}</p>
                    </div>
                  </div>
                </div>
              </div>
            </template>

                        <template v-if="openChannel === 'lark'">
              <div class="settings-panel-shell">
                <header class="settings-panel-head settings-channel-panel-head">
                  <div class="settings-panel-copy">
                    <h3 class="settings-panel-title workspace-document-title">{{ t("settings_console_lark_title") }}</h3>
                    <p class="settings-panel-meta">{{ t("settings_console_lark_token_note") }}</p>
                  </div>
                  <div class="settings-profile-actions settings-default-llm-actions">
                    <QDropdownMenu
                      class="settings-llm-actions-menu"
                      :items="channelActionMenuItems('lark')"
                      hideSelected
                      hideActionLabel
                      :disabled="consoleLoading || consoleSaving"
                    >
                      <PhDotsThree class="settings-llm-actions-menu-icon" />
                      <span class="settings-llm-actions-menu-accessible">{{ t("todo_action_more") }}</span>
                    </QDropdownMenu>
                    <QButton class="plain xs icon" :title="t('settings_channel_close')" :aria-label="t('settings_channel_close')" @click="closeChannelPane">
                      <PhX class="icon" />
                    </QButton>
                  </div>
                </header>

                <div class="settings-panel-body">
                  <div class="settings-form-grid">
                    <div class="settings-field is-wide">
                      <span class="settings-field-label">{{ t("settings_console_lark_app_id_label") }}</span>
                      <EnvManagedField v-if="consoleFieldEnvManaged('lark', 'app_id')" :name="consoleFieldManagedHeadline('lark', 'app_id')" />
                      <QInput
                        v-else
                        :modelValue="state.lark.app_id"
                        :placeholder="t('settings_console_lark_app_id_placeholder')"
                        :disabled="consoleLoading || consoleSaving"
                        @update:modelValue="updateLarkField('app_id', $event)"
                      />
                    </div>

                    <div class="settings-field is-wide">
                      <span class="settings-field-label">{{ t("settings_console_lark_app_secret_label") }}</span>
                      <EnvManagedField v-if="consoleFieldEnvManaged('lark', 'app_secret')" :name="consoleFieldManagedHeadline('lark', 'app_secret')" />
                      <SecretInput
                        v-else
                        :modelValue="state.lark.app_secret"
                        :status="consoleSecretField('lark', 'app_secret')"
                        :revealPath="consoleSecretRevealPath('lark', 'app_secret')"
                        :placeholder="t('settings_console_lark_app_secret_placeholder')"
                        :disabled="consoleLoading || consoleSaving || !consoleSecretEditable('lark', 'app_secret')"
                        @update:modelValue="updateLarkField('app_secret', $event)"
                      />
                    </div>

                    <div class="settings-field is-wide">
                      <span class="settings-field-label">{{ t("settings_console_lark_allowed_chat_ids_label") }}</span>
                      <QTextarea
                        :modelValue="state.lark.allowed_chat_ids_text"
                        :rows="4"
                        :placeholder="t('settings_console_lark_allowed_chat_ids_placeholder')"
                        :disabled="consoleLoading || consoleSaving"
                        @update:modelValue="updateLarkField('allowed_chat_ids_text', $event)"
                      />
                      <p class="settings-field-note">{{ t("settings_console_lark_allowed_chat_ids_note") }}</p>
                    </div>

                    <div class="settings-field is-wide">
                      <span class="settings-field-label">{{ t("settings_console_group_trigger_label") }}</span>
                      <QDropdownMenu
                        :key="state.lark.group_trigger_mode || 'lark-group-trigger'"
                        :items="groupTriggerItems"
                        :initialItem="groupTriggerItems.find((item) => item.value === state.lark.group_trigger_mode) || groupTriggerItems[2]"
                        @change="updateLarkGroupTrigger"
                      />
                      <p class="settings-field-note">{{ t("settings_console_lark_group_trigger_note") }}</p>
                    </div>
                  </div>
                </div>
              </div>
            </template>

                        <template v-if="openChannel === 'mixin'">
              <div class="settings-panel-shell">
                <header class="settings-panel-head settings-channel-panel-head">
                  <div class="settings-panel-copy">
                    <h3 class="settings-panel-title workspace-document-title">{{ t("settings_console_mixin_title") }}</h3>
                    <p class="settings-panel-meta">{{ t("settings_console_mixin_note") }}</p>
                  </div>
                  <div class="settings-profile-actions settings-default-llm-actions">
                    <QDropdownMenu
                      class="settings-llm-actions-menu"
                      :items="channelActionMenuItems('mixin')"
                      hideSelected
                      hideActionLabel
                      :disabled="consoleLoading || consoleSaving"
                    >
                      <PhDotsThree class="settings-llm-actions-menu-icon" />
                      <span class="settings-llm-actions-menu-accessible">{{ t("todo_action_more") }}</span>
                    </QDropdownMenu>
                    <QButton class="plain xs icon" :title="t('settings_channel_close')" :aria-label="t('settings_channel_close')" @click="closeChannelPane">
                      <PhX class="icon" />
                    </QButton>
                  </div>
                </header>

                <div class="settings-panel-body">
                  <div class="settings-form-grid">
                    <div class="settings-field is-wide">
                      <span class="settings-field-label">{{ t("settings_console_mixin_keystore_file_label") }}</span>
                      <EnvManagedField v-if="consoleFieldEnvManaged('mixin', 'keystore_file')" :name="consoleFieldManagedHeadline('mixin', 'keystore_file')" />
                      <QInput
                        v-else
                        :modelValue="state.mixin.keystore_file"
                        :placeholder="t('settings_console_mixin_keystore_file_placeholder')"
                        :disabled="consoleLoading || consoleSaving"
                        @update:modelValue="updateMixinField('keystore_file', $event)"
                      />
                      <p class="settings-field-note">{{ t("settings_console_mixin_keystore_file_note") }}</p>
                    </div>

                    <div class="settings-field is-wide">
                      <span class="settings-field-label">{{ t("settings_console_mixin_allowed_conversation_ids_label") }}</span>
                      <QTextarea
                        :modelValue="state.mixin.allowed_conversation_ids_text"
                        :rows="4"
                        :placeholder="t('settings_console_mixin_allowed_conversation_ids_placeholder')"
                        :disabled="consoleLoading || consoleSaving"
                        @update:modelValue="updateMixinField('allowed_conversation_ids_text', $event)"
                      />
                      <p class="settings-field-note">{{ t("settings_console_mixin_allowed_conversation_ids_note") }}</p>
                    </div>

                  </div>
                </div>
              </div>
            </template>

                        <template v-if="openChannel === 'discord'">
              <div class="settings-panel-shell">
                <header class="settings-panel-head settings-channel-panel-head">
                  <div class="settings-panel-copy">
                    <h3 class="settings-panel-title workspace-document-title">{{ t("settings_console_discord_title") }}</h3>
                    <p class="settings-panel-meta">{{ t("settings_console_discord_token_note") }}</p>
                  </div>
                  <div class="settings-profile-actions settings-default-llm-actions">
                    <QDropdownMenu
                      class="settings-llm-actions-menu"
                      :items="channelActionMenuItems('discord')"
                      hideSelected
                      hideActionLabel
                      :disabled="consoleLoading || consoleSaving"
                    >
                      <PhDotsThree class="settings-llm-actions-menu-icon" />
                      <span class="settings-llm-actions-menu-accessible">{{ t("todo_action_more") }}</span>
                    </QDropdownMenu>
                    <QButton class="plain xs icon" :title="t('settings_channel_close')" :aria-label="t('settings_channel_close')" @click="closeChannelPane">
                      <PhX class="icon" />
                    </QButton>
                  </div>
                </header>

                <div class="settings-panel-body">
                  <div class="settings-form-grid">
                    <div class="settings-field is-wide">
                      <span class="settings-field-label">{{ t("settings_console_discord_bot_token_label") }}</span>
                      <EnvManagedField v-if="consoleFieldEnvManaged('discord', 'bot_token')" :name="consoleFieldManagedHeadline('discord', 'bot_token')" />
                      <SecretInput
                        v-else
                        :modelValue="state.discord.bot_token"
                        :status="consoleSecretField('discord', 'bot_token')"
                        :revealPath="consoleSecretRevealPath('discord', 'bot_token')"
                        :placeholder="t('settings_console_discord_bot_token_placeholder')"
                        :disabled="consoleLoading || consoleSaving || !consoleSecretEditable('discord', 'bot_token')"
                        @update:modelValue="updateDiscordField('bot_token', $event)"
                      />
                    </div>

                    <div class="settings-field is-wide">
                      <span class="settings-field-label">{{ t("settings_console_discord_allowed_guild_ids_label") }}</span>
                      <QTextarea
                        :modelValue="state.discord.allowed_guild_ids_text"
                        :rows="3"
                        :placeholder="t('settings_console_discord_allowed_ids_placeholder')"
                        :disabled="consoleLoading || consoleSaving"
                        @update:modelValue="updateDiscordField('allowed_guild_ids_text', $event)"
                      />
                      <p class="settings-field-note">{{ t("settings_console_discord_allowed_guild_ids_note") }}</p>
                    </div>

                    <div class="settings-field is-wide">
                      <span class="settings-field-label">{{ t("settings_console_discord_allowed_channel_ids_label") }}</span>
                      <QTextarea
                        :modelValue="state.discord.allowed_channel_ids_text"
                        :rows="3"
                        :placeholder="t('settings_console_discord_allowed_ids_placeholder')"
                        :disabled="consoleLoading || consoleSaving"
                        @update:modelValue="updateDiscordField('allowed_channel_ids_text', $event)"
                      />
                      <p class="settings-field-note">{{ t("settings_console_discord_allowed_channel_ids_note") }}</p>
                    </div>

                    <div class="settings-field is-wide">
                      <span class="settings-field-label">{{ t("settings_console_discord_allowed_user_ids_label") }}</span>
                      <QTextarea
                        :modelValue="state.discord.allowed_user_ids_text"
                        :rows="3"
                        :placeholder="t('settings_console_discord_allowed_ids_placeholder')"
                        :disabled="consoleLoading || consoleSaving"
                        @update:modelValue="updateDiscordField('allowed_user_ids_text', $event)"
                      />
                      <p class="settings-field-note">{{ t("settings_console_discord_allowed_user_ids_note") }}</p>
                    </div>

                    <div class="settings-field is-wide">
                      <span class="settings-field-label">{{ t("settings_console_group_trigger_label") }}</span>
                      <QDropdownMenu
                        :key="state.discord.group_trigger_mode || 'discord-group-trigger'"
                        :items="groupTriggerItems"
                        :initialItem="groupTriggerItems.find((item) => item.value === state.discord.group_trigger_mode) || groupTriggerItems[1]"
                        @change="updateDiscordGroupTrigger"
                      />
                      <p class="settings-field-note">{{ t("settings_console_discord_group_trigger_note") }}</p>
                    </div>
                  </div>
                </div>
              </div>
            </template>
                        <template v-if="openChannel === 'wechat'">
              <div class="settings-panel-shell">
                <header class="settings-panel-head settings-channel-panel-head">
                  <div class="settings-panel-copy">
                    <h3 class="settings-panel-title workspace-document-title">{{ t("settings_console_wechat_title") }}</h3>
                    <p class="settings-panel-meta">{{ t("settings_console_wechat_note") }}</p>
                  </div>
                  <div class="settings-profile-actions settings-default-llm-actions">
                    <QDropdownMenu
                      class="settings-llm-actions-menu"
                      :items="channelActionMenuItems('wechat')"
                      hideSelected
                      hideActionLabel
                      :disabled="consoleLoading || consoleSaving"
                    >
                      <PhDotsThree class="settings-llm-actions-menu-icon" />
                      <span class="settings-llm-actions-menu-accessible">{{ t("todo_action_more") }}</span>
                    </QDropdownMenu>
                    <QButton class="plain xs icon" :title="t('settings_channel_close')" :aria-label="t('settings_channel_close')" @click="closeChannelPane">
                      <PhX class="icon" />
                    </QButton>
                  </div>
                </header>

                <div class="settings-panel-body">
                  <div class="settings-form-grid">
                    <div class="settings-field is-wide">
                      <span class="settings-field-label">{{ t("settings_console_wechat_account_label") }}</span>
                      <EnvManagedField v-if="consoleFieldEnvManaged('wechat', 'bot_token')" :name="consoleFieldManagedHeadline('wechat', 'bot_token')" />
                      <WeChatLoginPanel
                        v-else
                        :request="endpointApiFetch"
                        :endpointRef="settingsEndpointRef"
                        :configured="consoleSecretField('wechat', 'bot_token')?.configured === true"
                        :botId="state.wechat.bot_id"
                        :disabled="consoleLoading || consoleSaving"
                        @changed="reloadConsoleSettingsAfterWeChatLogin"
                      />
                    </div>
                  </div>
                </div>
              </div>
            </template>

                        <template v-if="openChannel === 'whatsapp'">
              <div class="settings-panel-shell">
                <header class="settings-panel-head settings-channel-panel-head">
                  <div class="settings-panel-copy">
                    <h3 class="settings-panel-title workspace-document-title">{{ t("settings_console_whatsapp_title") }}</h3>
                    <p class="settings-panel-meta">{{ t("settings_console_whatsapp_note") }}</p>
                  </div>
                  <div class="settings-profile-actions settings-default-llm-actions">
                    <QDropdownMenu
                      class="settings-llm-actions-menu"
                      :items="channelActionMenuItems('whatsapp')"
                      hideSelected
                      hideActionLabel
                      :disabled="consoleLoading || consoleSaving"
                    >
                      <PhDotsThree class="settings-llm-actions-menu-icon" />
                      <span class="settings-llm-actions-menu-accessible">{{ t("todo_action_more") }}</span>
                    </QDropdownMenu>
                    <QButton class="plain xs icon" :title="t('settings_channel_close')" :aria-label="t('settings_channel_close')" @click="closeChannelPane">
                      <PhX class="icon" />
                    </QButton>
                  </div>
                </header>

                <div class="settings-panel-body">
                  <div class="settings-form-grid">
                    <div class="settings-field is-wide">
                      <span class="settings-field-label">{{ t("settings_console_whatsapp_api_token_label") }}</span>
                      <EnvManagedField v-if="consoleFieldEnvManaged('whatsapp', 'api_token')" :name="consoleFieldManagedHeadline('whatsapp', 'api_token')" />
                      <SecretInput
                        v-else
                        :modelValue="state.whatsapp.api_token"
                        :status="consoleSecretField('whatsapp', 'api_token')"
                        :revealPath="consoleSecretRevealPath('whatsapp', 'api_token')"
                        :placeholder="t('settings_console_whatsapp_api_token_placeholder')"
                        :disabled="consoleLoading || consoleSaving || !consoleSecretEditable('whatsapp', 'api_token')"
                        @update:modelValue="updateWhatsAppField('api_token', $event)"
                      />
                      <p class="settings-field-note">{{ t("settings_console_whatsapp_api_token_note") }}</p>
                    </div>
                  </div>
                </div>
              </div>
            </template>
                    <!-- Kept mounted while the pane is closed, so a draft here is not lost. -->
                    <div
                      v-for="group in CHANNEL_TRIGGER_CONFIG_GROUPS"
                      v-show="openChannel === group.id"
                      :key="group.id"
                      class="settings-channel-trigger-config"
                    >
                      <ConfigSettingsPanel
                        :groups="[group]"
                        :values="consoleConfigValues"
                        :fieldStates="consoleFieldStates"
                        :loading="consoleLoading"
                        :saving="consoleSaving && consoleSavingTarget === 'config'"
                        :hiddenPaths="channelTriggerHiddenPaths(group.id)"
                        embedded
                        hideSingleGroupHeading
                        saveScope="console"
                        @save="saveConfigSettings('console', $event)"
                      />
                    </div>
                    <div v-if="channelManagedItem(openChannel)" class="settings-channel-console">
                      <div class="settings-toggle-row settings-channel-runtime-row">
                        <div class="settings-toggle-copy">
                          <strong class="settings-toggle-title">{{ t("settings_channel_run_in_console") }}</strong>
                          <span class="settings-toggle-note">{{ t(channelManagedItem(openChannel).noteKey) }}</span>
                        </div>
                        <QSwitch
                          :modelValue="state.managedRuntimes[openChannel]"
                          :disabled="consoleLoading || consoleSaving"
                          @update:modelValue="setManagedRuntimeEnabled(openChannel, $event)"
                        />
                      </div>
                    </div>
                  </div>
                      <footer v-if="sectionSaveUnits.length || sectionSaveFailed" class="settings-channel-pane-foot">
                        <p class="settings-channel-pane-foot-text" :class="{ 'is-error': sectionSaveFailed }" role="status">
                          {{ sectionSaveFailed ? t('settings_save_bar_failed', { items: sectionSaveFailed }) : t('settings_channel_unsaved_note') }}
                        </p>
                        <QButton class="primary" :loading="sectionSaving" :disabled="sectionSaveBusy || !sectionSaveUnits.length" @click="saveSection">
                          {{ t('action_save') }}
                        </QButton>
                      </footer>
                    </div>
                </aside>
              </Transition>
            </div>
          </div>

          <div v-else-if="selectedSection.id === 'security'" class="settings-panel-body settings-panel-body-plain">
            <QCard variant="default">
              <div class="settings-panel-shell">
                <header class="settings-panel-head">
                  <div class="settings-panel-copy">
                    <h3 class="settings-panel-title workspace-document-title">{{ t("settings_console_guard_title") }}</h3>
                    <p class="settings-panel-meta">{{ selectedSection.meta }}</p>
                  </div>
                </header>

                <div class="settings-panel-body">
                  <div class="settings-form-grid">
                    <div class="settings-field is-wide">
                      <span class="settings-field-label">{{ t("settings_console_guard_allowed_url_prefixes_label") }}</span>
                      <QTextarea
                        :modelValue="state.guard.url_fetch_allowed_url_prefixes_text"
                        :rows="4"
                        :placeholder="t('settings_console_guard_allowed_url_prefixes_placeholder')"
                        :disabled="consoleLoading || consoleSaving"
                        @update:modelValue="updateGuardField('url_fetch_allowed_url_prefixes_text', $event)"
                      />
                      <p class="settings-field-note">{{ t("settings_console_guard_allowed_url_prefixes_note") }}</p>
                    </div>
                  </div>

                  <div class="settings-toggle-list">
                    <div class="settings-toggle-row">
                      <div class="settings-toggle-copy">
                        <strong class="settings-toggle-title">{{ t("settings_console_guard_enabled_title") }}</strong>
                        <span class="settings-toggle-note">{{ t("settings_console_guard_enabled_note") }}</span>
                      </div>
                      <QSwitch
                        :modelValue="state.guard.enabled"
                        :disabled="consoleLoading || consoleSaving"
                        @update:modelValue="updateGuardField('enabled', $event)"
                      />
                    </div>

                    <div class="settings-toggle-row">
                      <div class="settings-toggle-copy">
                        <strong class="settings-toggle-title">{{ t("settings_console_guard_deny_private_ips_title") }}</strong>
                        <span class="settings-toggle-note">{{ t("settings_console_guard_deny_private_ips_note") }}</span>
                      </div>
                      <QSwitch
                        :modelValue="state.guard.deny_private_ips"
                        :disabled="consoleLoading || consoleSaving"
                        @update:modelValue="updateGuardField('deny_private_ips', $event)"
                      />
                    </div>

                    <div class="settings-toggle-row">
                      <div class="settings-toggle-copy">
                        <strong class="settings-toggle-title">{{ t("settings_console_guard_follow_redirects_title") }}</strong>
                        <span class="settings-toggle-note">{{ t("settings_console_guard_follow_redirects_note") }}</span>
                      </div>
                      <QSwitch
                        :modelValue="state.guard.follow_redirects"
                        :disabled="consoleLoading || consoleSaving"
                        @update:modelValue="updateGuardField('follow_redirects', $event)"
                      />
                    </div>

                    <div class="settings-toggle-row">
                      <div class="settings-toggle-copy">
                        <strong class="settings-toggle-title">{{ t("settings_console_guard_allow_proxy_title") }}</strong>
                        <span class="settings-toggle-note">{{ t("settings_console_guard_allow_proxy_note") }}</span>
                      </div>
                      <QSwitch
                        :modelValue="state.guard.allow_proxy"
                        :disabled="consoleLoading || consoleSaving"
                        @update:modelValue="updateGuardField('allow_proxy', $event)"
                      />
                    </div>

                    <div class="settings-toggle-row">
                      <div class="settings-toggle-copy">
                        <strong class="settings-toggle-title">{{ t("settings_console_guard_redaction_title") }}</strong>
                        <span class="settings-toggle-note">{{ t("settings_console_guard_redaction_note") }}</span>
                      </div>
                      <QSwitch
                        :modelValue="state.guard.redaction_enabled"
                        :disabled="consoleLoading || consoleSaving"
                        @update:modelValue="updateGuardField('redaction_enabled', $event)"
                      />
                    </div>

                    <div class="settings-toggle-row">
                      <div class="settings-toggle-copy">
                        <strong class="settings-toggle-title">{{ t("settings_console_guard_approvals_title") }}</strong>
                        <span class="settings-toggle-note">{{ t("settings_console_guard_approvals_note") }}</span>
                      </div>
                      <QSwitch
                        :modelValue="state.guard.approvals_enabled"
                        :disabled="consoleLoading || consoleSaving"
                        @update:modelValue="updateGuardField('approvals_enabled', $event)"
                      />
                    </div>
                  </div>
                </div>
              </div>
            </QCard>

            <ConfigSettingsPanel
              :groups="securityConfigGroups"
              :values="consoleConfigValues"
              :fieldStates="consoleFieldStates"
              :inactiveGroups="state.guard.enabled ? {} : { 'guard-storage': t('settings_guard_details_inactive') }"
              :loading="consoleLoading"
              :saving="consoleSaving && consoleSavingTarget === 'config'"
              saveScope="console"
              @save="saveConfigSettings('console', $event)"
            />
            <AuthProfilesPanel
              :profiles="authProfiles"
              :loading="consoleLoading"
              :saving="consoleSaving && consoleSavingTarget === 'auth_profiles'"
              @save="saveConsoleCollection('auth_profiles', $event)"
            />
          </div>

          <MCPSettingsPanel
            v-else-if="selectedSection.id === 'mcp'"
            :modelValue="state.mcp.servers"
            :loading="agentLoading"
            :saving="agentSaving && agentSavingTarget === 'mcp'"
            :readOnly="agentSettingsReadOnly"
            :readOnlyMessage="agentSettingsReadOnlyMessage"
            :validationError="mcpValidationError"
            @save="saveMCPServers"
          />

          <div v-else-if="selectedSection.id === 'automation'" class="settings-panel-body settings-panel-body-plain">
            <ConfigSettingsPanel
              :groups="AUTOMATION_CONFIG_GROUPS"
              hideSingleGroupHeading
              :values="consoleConfigValues"
              :fieldStates="consoleFieldStates"
              :loading="consoleLoading"
              :saving="consoleSaving && consoleSavingTarget === 'config'"
              saveScope="console"
              @save="saveConfigSettings('console', $event)"
            />
          </div>

          <div v-else-if="selectedSection.id === 'console'" class="settings-panel-body settings-panel-body-plain">
            <ConsoleEndpointsPanel
              :key="settingsEndpointRef"
              :endpoints="consoleEndpoints"
              :runtimeEndpoints="consoleRuntimeEndpoints"
              :loading="consoleLoading || !consoleSettingsLoaded"
              :saving="consoleSaving"
              :addRequested="addConsoleEndpointRequested"
              @add-opened="consumeConsoleEndpointAddRequest"
              @save="(values, onComplete) => saveConsoleCollection('endpoints', values, onComplete)"
            />
            <ConfigSettingsPanel
              :groups="REMOTE_CONTROL_CONFIG_GROUPS"
              :values="consoleConfigValues"
              :fieldStates="consoleFieldStates"
              :loading="consoleLoading"
              :saving="consoleSaving && consoleSavingTarget === 'config'"
              saveScope="console"
              @save="saveConfigSettings('console', $event)"
            />
            <ConsolePasswordPanel
              :configured="consolePasswordConfigured"
              :saving="consoleSaving && consoleSavingTarget === 'config'"
              saveScope="console"
              @save="saveConfigSettings('console', $event)"
            />
            <details class="settings-remote-advanced">
              <summary>
                <PhCaretRight class="icon" />
                <span><strong>{{ t('remote_advanced_title') }}</strong><span>{{ t('remote_advanced_note') }}</span></span>
              </summary>
              <ConfigSettingsPanel
                :groups="CONSOLE_DEPLOYMENT_CONFIG_GROUPS"
                :values="consoleConfigValues"
                :fieldStates="consoleFieldStates"
                :loading="consoleLoading"
                :saving="consoleSaving && consoleSavingTarget === 'config'"
                saveScope="console"
                @save="saveConfigSettings('console', $event)"
              />
            </details>
          </div>

          <div v-else-if="selectedSection.id === 'persona'" class="settings-panel-body settings-panel-body-plain">
            <QProgress v-if="personaLoading" :infinite="true" />

            <QCard variant="default">
              <div class="settings-panel-shell settings-persona-card">
                <header class="settings-panel-head">
                  <div class="settings-panel-copy">
                    <h3 class="settings-panel-title workspace-document-title">{{ t("settings_persona_title") }}</h3>
                    <p class="settings-panel-meta">{{ selectedSection.meta }}</p>
                  </div>
                </header>

                <div class="settings-panel-body">
                  <div class="settings-form-grid settings-persona-form">
                    <div class="settings-field is-wide settings-persona-avatar-field">
                      <span class="settings-field-label">{{ t("settings_persona_avatar_title") }}</span>
                      <ImageUploadField
                        :previewUrl="personaAvatarURL"
                        :defaultMarkup="defaultAvatarMarkup"
                        :disabled="personaAvatarDisabled"
                        :busy="personaAvatarBusy"
                        :crop="true"
                        :outputSize="PERSONA_AVATAR_SIZE"
                        outputType="image/webp"
                        :outputQuality="0.9"
                        :accept="'image/png,image/jpeg,image/webp'"
                        :allowedTypes="personaAvatarSourceTypes"
                        :maxBytes="PERSONA_AVATAR_MAX_SOURCE_BYTES"
                        :dialogTitle="t('settings_persona_avatar_title')"
                        @save="savePersonaAvatar"
                        @delete="deletePersonaAvatar"
                      />
                    </div>

                    <div class="settings-field is-wide">
                      <span class="settings-field-label">{{ t("settings_persona_identity_name_label") }}</span>
                      <QInput
                        v-model="state.persona.name"
                        :placeholder="t('settings_persona_identity_name_placeholder')"
                        :disabled="personaLoading || personaSaving"
                      />
                    </div>

                    <div class="settings-field">
                      <span class="settings-field-label">{{ t("settings_persona_identity_emoji_label") }}</span>
                      <QInput
                        v-model="state.persona.emoji"
                        :placeholder="t('settings_persona_identity_emoji_placeholder')"
                        :disabled="personaLoading || personaSaving"
                      />
                    </div>

                    <div class="settings-field">
                      <span class="settings-field-label">{{ t("settings_persona_identity_creature_label") }}</span>
                      <QInput
                        v-model="state.persona.creature"
                        :placeholder="t('settings_persona_identity_creature_placeholder')"
                        :disabled="personaLoading || personaSaving"
                      />
                    </div>

                    <div class="settings-field is-wide">
                      <span class="settings-field-label">{{ t("settings_persona_identity_vibe_label") }}</span>
                      <QTextarea
                        v-model="state.persona.vibe"
                        :rows="4"
                        :placeholder="t('settings_persona_identity_vibe_placeholder')"
                        :disabled="personaLoading || personaSaving"
                      />
                    </div>

                    <div class="settings-field is-wide settings-persona-soul-field">
                      <div class="settings-persona-soul-label">
                        <span class="settings-field-label">{{ t("settings_persona_soul_title") }}</span>
                        <span class="settings-panel-meta">{{ personaEditorMeta }}</span>
                      </div>
                      <div class="settings-persona-soul-editor">
                        <AppMarkdownEditor
                          :modelValue="soulContent"
                          height="460px"
                          :disabled="personaLoading || personaSaving"
                          :placeholder="t('settings_persona_soul_placeholder')"
                          :aria-label="t('settings_persona_soul_title')"
                          @update:modelValue="updatePersonaSoulContent"
                        />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </QCard>
          </div>

          <RuntimePanel v-else-if="selectedSection.id === 'runtime'" class="settings-runtime-panel" />

          <SettingsCreditsPanel v-else-if="selectedSection.id === 'credits'" />

          <div v-else-if="selectedSection.id === 'system'" class="settings-panel-body settings-panel-body-plain">
            <QCard variant="default">
              <div class="settings-panel-shell">
                <header class="settings-panel-head">
                  <div class="settings-panel-copy">
                    <h3 class="settings-panel-title workspace-document-title">{{ selectedSection.title }}</h3>
                    <p class="settings-panel-meta">{{ selectedSection.meta }}</p>
                  </div>
                </header>

                <div class="settings-panel-body">
                  <div class="settings-console-list">
                    <div class="settings-console-row">
                      <div class="settings-card-copy">
                        <h4 class="settings-card-title">{{ t("settings_language_title") }}</h4>
                        <p class="settings-card-note">{{ t("settings_language_hint") }}</p>
                      </div>
                      <QLanguageSelector class="settings-console-control" :lang="lang" :presist="true" @change="onLanguageChange" />
                    </div>
                    <div class="settings-console-row">
                      <div class="settings-card-copy">
                        <h4 class="settings-card-title">{{ t("settings_logs_title") }}</h4>
                        <p class="settings-card-note">{{ t("settings_logs_hint") }}</p>
                      </div>
                      <QButton class="outlined settings-console-control settings-console-action" @click="openLogsPage">
                        <PhCode class="icon settings-console-action-icon" />
                        {{ t("settings_logs_open") }}
                      </QButton>
                    </div>
                    <div class="settings-console-row settings-console-row-end">
                      <div class="settings-card-copy">
                        <h4 class="settings-card-title">{{ t("settings_session_title") }}</h4>
                        <p class="settings-card-note">{{ t("settings_session_hint") }}</p>
                      </div>
                      <QButton class="outlined danger settings-console-control" :loading="loggingOut" @click="logout">
                        {{ t("action_logout") }}
                      </QButton>
                    </div>
                  </div>
                </div>
              </div>
            </QCard>

            <QCard variant="default">
              <div class="settings-panel-shell">
                <header class="settings-panel-head">
                  <div class="settings-panel-copy">
                    <h3 class="settings-panel-title workspace-document-title">{{ t("settings_auto_update_card_title") }}</h3>
                    <p class="settings-panel-meta">{{ t("settings_auto_update_card_hint") }}</p>
                  </div>
                </header>

                <div class="settings-panel-body">
                  <div class="settings-console-list">
                    <div class="settings-console-row">
                      <div class="settings-card-copy">
                        <h4 class="settings-card-title">{{ t("settings_update_channel_title") }}</h4>
                        <p class="settings-card-note">{{ t("settings_update_channel_hint") }}</p>
                      </div>
                      <SettingSelect
                        class="settings-console-control settings-update-channel-select"
                        :modelValue="autoUpdateChannel"
                        :options="updateChannelOptions"
                        :label="t('settings_update_channel_title')"
                        :disabled="desktopLoading || autoUpdateSaving"
                        @update:modelValue="setAutoUpdateChannel"
                      />
                    </div>
                    <div class="settings-console-row">
                      <div class="settings-card-copy">
                        <h4 class="settings-card-title">{{ t("settings_update_auto_title") }}</h4>
                        <p class="settings-card-note">{{ t("settings_update_auto_hint") }}</p>
                      </div>
                      <QSwitch
                        :modelValue="autoUpdateEnabled"
                        :disabled="desktopLoading || autoUpdateSaving"
                        @update:modelValue="setAutoUpdateEnabled"
                      />
                    </div>
                    <div class="settings-console-row" :class="{ 'settings-console-row-end': !desktopUpdateHasRelease }">
                      <div class="settings-card-copy">
                        <h4 class="settings-card-title">{{ t("settings_update_version_title") }}</h4>
                        <p class="settings-card-note">{{ desktopInstalledText }}</p>
                        <p class="settings-card-note settings-update-state" :class="'is-' + desktopUpdateState" role="status" aria-live="polite">
                          {{ desktopUpdateStateText }}
                        </p>
                      </div>
                      <QButton
                        class="outlined settings-console-control settings-console-action"
                        :loading="desktopChecking"
                        :disabled="desktopCheckDisabled"
                        @click="runDesktopUpdateCheck"
                      >
                        <PhArrowClockwise class="icon settings-console-action-icon" />
                        {{ t("settings_update_check_action") }}
                      </QButton>
                    </div>

                    <div v-if="desktopUpdateHasRelease" class="settings-console-row settings-console-row-end settings-update-release">
                      <div class="settings-card-copy settings-update-release-copy">
                        <h4 class="settings-card-title">{{ desktopUpdateReleaseTitle }}</h4>
                        <p class="settings-card-note settings-update-release-meta">
                          <span v-if="desktopUpdateReleaseDate">{{ desktopUpdateReleaseDate }}</span>
                          <button type="button" class="settings-field-link settings-update-link" @click="openDesktopUpdateReleases">
                            {{ t("settings_update_all_releases") }}
                            <PhArrowUpRight class="icon settings-field-link-icon" />
                          </button>
                        </p>
                        <MarkdownContent v-if="desktopUpdateNotesSource" class="settings-update-notes" :source="desktopUpdateNotesSource" />
                        <p v-else class="settings-card-note">{{ t("settings_desktop_update_changelog_empty") }}</p>
                        <button
                          v-if="desktopUpdateChecksum"
                          type="button"
                          class="settings-field-link settings-update-link"
                          :title="desktopUpdateChecksum"
                          :aria-label="t('settings_desktop_update_checksum_copy_title')"
                          @click="copyDesktopUpdateChecksum"
                        >
                          SHA256 <code class="settings-update-checksum">{{ desktopUpdateChecksumShort }}</code>
                          <PhCheckCircle v-if="desktopChecksumCopied" class="icon settings-field-link-icon" />
                          <PhCopy v-else class="icon settings-field-link-icon" />
                        </button>
                      </div>
                      <QButton
                        class="outlined settings-console-control settings-console-action"
                        :disabled="desktopUpdateDownloadDisabled"
                        @click="openDesktopUpdateDownload"
                      >
                        <PhCloudArrowDown class="icon settings-console-action-icon" />
                        {{ t("settings_desktop_update_download_action") }}
                      </QButton>
                    </div>
                  </div>
                </div>
              </div>
            </QCard>

            <ConfigSettingsPanel
              v-for="group in SYSTEM_CONFIG_GROUPS"
              :key="group.id"
              :groups="[group]"
              :values="systemConfigValues"
              :fieldStates="systemFieldStates"
              :loading="systemLoading"
              :saving="systemSaving"
              saveScope="system"
              @save="saveConfigSettings('system', $event)"
            />

            <details class="settings-system-advanced">
              <summary>
                <span>{{ t("settings_advanced_action") }}</span>
                <PhCaretDown class="icon" />
              </summary>
              <div class="settings-system-advanced-content">
                <ConfigSettingsPanel
                  v-for="group in SYSTEM_ADVANCED_CONFIG_GROUPS"
                  :key="group.id"
                  :groups="[group]"
                  :values="systemConfigValues"
                  :fieldStates="systemFieldStates"
                  :loading="systemLoading"
                  :saving="systemSaving"
                  saveScope="system"
                  @save="saveConfigSettings('system', $event)"
                />
              </div>
            </details>
          </div>

          <div v-else class="settings-panel-body settings-panel-body-plain">
            <QCard variant="default">
              <div class="settings-panel-shell">
              <header class="settings-panel-head">
                <div class="settings-panel-copy">
                  <h3 class="settings-panel-title workspace-document-title">{{ selectedSection.title }}</h3>
                  <p class="settings-panel-meta">{{ selectedSection.meta }}</p>
                </div>
              </header>

              <QFence
                v-if="activeSaveKind === 'agent' && agentValidationVisible && agentValidationError"
                type="danger"
                icon="PhXCircle"
                :text="agentValidationError"
              />

              <QFence
                v-if="activeSaveKind === 'agent' && agentSettingsReadOnly"
                type="warning"
                :text="agentSettingsReadOnlyMessage"
              />

              <div class="settings-panel-body">
                <div v-if="selectedSection.id === 'tools'" class="settings-toggle-list">
                  <div v-for="item in toolItems" :key="item.id" class="settings-toggle-row">
                    <div class="settings-toggle-copy">
                      <strong class="settings-toggle-title">{{ t(item.titleKey) }}</strong>
                      <span class="settings-toggle-note">{{ t(item.noteKey) }}</span>
                    </div>
                    <div class="settings-toggle-actions">
                      <QButton
                        v-if="TOOL_ADVANCED_CONFIG_GROUPS[item.id]"
                        type="button"
                        class="plain xs icon"
                        :title="t('settings_advanced_action')"
                        :aria-label="t('settings_advanced_action')"
                        :disabled="agentLoading || agentSaving"
                        @click="openToolAdvancedSettings(item)"
                      >
                        <PhGearSix class="icon" />
                      </QButton>
                      <QSwitch
                        :modelValue="item.toggle === false ? true : state.tools[item.id]"
                        :disabled="item.toggle === false || agentLoading || agentSaving || agentSettingsReadOnly"
                        @update:modelValue="setToolEnabled(item.id, $event)"
                      />
                    </div>
                  </div>
                </div>

              </div>
              </div>
            </QCard>
          </div>
          <Transition name="settings-save-bar">
          <div v-if="sectionSaveUnits.length || sectionSaveFailed" class="settings-save-bar" role="region" :aria-label="t('settings_save_bar_label')">
            <span class="settings-save-bar-mark" :class="{ 'is-error': sectionSaveFailed }" aria-hidden="true"></span>
            <p class="settings-save-bar-text" role="status">
              <template v-if="sectionSaveFailed">{{ t('settings_save_bar_failed', { items: sectionSaveFailed }) }}</template>
              <template v-else>
                <strong>{{ t('settings_save_bar_count', { count: sectionSaveUnits.length }) }}</strong>
                <span class="settings-save-bar-items">{{ sectionSaveUnits.map((unit) => unit.label).join(' · ') }}</span>
              </template>
            </p>
            <QButton class="primary settings-save-bar-button" :loading="sectionSaving" :disabled="sectionSaveBusy || !sectionSaveUnits.length" @click="saveSection">
              {{ t('action_save') }}
            </QButton>
          </div>
          </Transition>
        </div>
      </div>

      <SettingDialog
        v-model="addProfileOpen"
        :title="t('settings_agent_profile_add')"
        width="720px"
        :saving="addProfileSaving"
        :saveDisabled="addProfileSaveDisabled"
        @save="createProfile"
      >
        <template v-if="addProfileDraft">
          <div class="settings-field settings-profile-name">
            <span class="settings-field-label">{{ t("settings_agent_profile_name_label") }}</span>
            <QInput
              :modelValue="addProfileDraft.name"
              :placeholder="t('settings_agent_profile_name_placeholder')"
              :disabled="agentSaving || agentSettingsReadOnly"
              @update:modelValue="updateProfileField(addProfileDraft._key, { field: 'name', value: $event })"
            />
            <p v-if="addProfileError" class="settings-field-note settings-add-profile-error" role="alert">{{ addProfileError }}</p>
          </div>
          <LLMConfigForm
            :config="addProfileDraft"
            :busy="agentLoading || agentSaving"
            :disabledReason="agentFormDisabledReason"
            :readOnly="agentSettingsReadOnly"
            :envManaged="llmProfileEnvManaged(addProfileDraft)"
            :secretFields="llmProfileSecretFields(addProfileDraft)"
            :providerItems="providerItems"
            :reasoningEffortItems="reasoningEffortItems"
            :toolsEmulationItems="toolsEmulationItems"
            :enableModelPicker="true"
            :modelLookupCredentialsReady="profileModelLookupCredentialsReady(addProfileDraft)"
            :showCodexAuthAction="profileUsesCodexProvider(addProfileDraft)"
            :codexAuthDisabled="profileCodexAuthDisabled(addProfileDraft)"
            :codexAuthState="codexAuthButtonState"
            :codexAuthTitle="codexAuthButtonTitle"
            :showXAIAuthAction="profileUsesXAIProvider(addProfileDraft)"
            :xaiAuthState="xaiAuthButtonState"
            :xaiAuthTitle="xaiAuthButtonTitle"
            :showProAuthAction="profileUsesProProvider(addProfileDraft)"
            :proAuthState="proAuthButtonState"
            :proAuthTitle="proAuthButtonTitle"
            @update-field="updateProfileField(addProfileDraft._key, $event)"
            @open-model-picker="openModelPicker(addProfileDraft._key)"
            @open-codex-auth="openCodexAuthDialog"
            @open-xai-auth="openXAIAuthDialog"
            @open-pro-auth="openProAuthDialog"
          />
        </template>
      </SettingDialog>

      <SettingDialog
        v-model="advancedSettingsOpen"
        :title="advancedSettingsTitle"
        width="760px"
        :saving="advancedSettingsSaving"
        :saveDisabled="advancedSettingsSaveDisabled"
        @cancel="closeAdvancedSettings"
        @save="saveAdvancedSettings"
      >
        <ConfigSettingsPanel
          ref="advancedConfigPanel"
          :groups="advancedSettingsGroups"
          :values="advancedSettingsValues"
          :fieldStates="advancedSettingsFieldStates"
          :loading="advancedSettingsLoading"
          :saving="advancedSettingsSaving"
          :embedded="true"
          :hideSingleGroupHeading="true"
          savePlacement="none"
          @update:dirty="advancedSettingsDirty = $event"
          @save="saveAdvancedConfigSettings"
        />
      </SettingDialog>

      <SetupPickerDialog
        v-model="apiBasePickerOpen"
        :items="apiBasePickerItems"
        :loading="false"
        :error="''"
        :title="t('setup_llm_api_base_picker_title')"
        :filterPlaceholder="t('setup_llm_api_base_picker_filter_placeholder')"
        :emptyText="t('setup_llm_api_base_picker_empty')"
        @select="applyAPIBaseOption"
      />

      <SetupPickerDialog
        v-model="modelPickerOpen"
        :items="modelPickerItems"
        :loading="modelPickerLoading"
        :error="modelPickerError"
        :title="t('setup_llm_model_picker_title')"
        :filterPlaceholder="t('setup_llm_model_picker_filter_placeholder')"
        :emptyText="t('setup_llm_model_picker_empty')"
        :showValue="false"
        :selectedValue="modelPickerSelectedValue"
        groupByPrefix
        allowCustom
        :customLabel="t('setup_llm_model_picker_custom')"
        @select="applyModelOption"
      />

      <SetupConnectionTestDialog
        v-model="testConnectionOpen"
        :loading="testConnectionLoading"
        :error="testConnectionError"
        :benchmarks="testConnectionBenchmarks"
        :provider="testConnectionMeta.provider"
        :apiBase="testConnectionMeta.apiBase"
        :model="testConnectionMeta.model"
        :showIntro="false"
        @retry="runConnectionTest"
      />
      <CodexAuthDialog
        v-model="codexAuthDialogOpen"
        :loading="codexAuthLoading"
        :busy="codexAuthBusy"
        :error="codexAuthError"
        :status="codexAuthStatus"
        :summary="codexAuthSummary"
        :loginSession="codexLoginSession"
        :verificationURL="codexLoginVerificationURL"
        :userCode="codexLoginUserCode"
        :loginExpiresLabel="codexLoginExpiresLabel"
        @logout="logoutCodexAuth"
      />
      <XAIAuthDialog
        v-model="xaiAuthDialogOpen"
        v-model:setDefault="xaiSetDefault"
        :loading="xaiAuthLoading"
        :busy="xaiAuthBusy"
        :error="xaiAuthError"
        :status="xaiAuthStatus"
        :summary="xaiAuthSummary"
        :loginSession="xaiLoginSession"
        :verificationURL="xaiLoginVerificationURL"
        :userCode="xaiLoginUserCode"
        :loginExpiresLabel="xaiLoginExpiresLabel"
        @login="reloginXAIAuth"
        @logout="logoutXAIAuth"
      />
      <ProAuthDialog
        v-model="proAuthDialogOpen"
        :loading="proAuthLoading"
        :busy="proAuthBusy"
        :error="proAuthError"
        :status="proAuthStatus"
        :summary="proAuthSummary"
        :loginSession="proLoginSession"
        :verificationURL="proLoginVerificationURL"
        :userCode="proLoginUserCode"
        :loginExpiresLabel="proLoginExpiresLabel"
        @logout="logoutProAuth"
      />
      <QMessageDialog
        v-model="consoleEndpointErrorOpen"
        icon="PhXCircle"
        iconColor="red"
        :title="consoleEndpointErrorTitle"
        :text="consoleEndpointError"
        :actions="consoleEndpointErrorActions"
      />
      <QMessageDialog
        v-model="leaveDialogOpen"
        icon="PhInfo"
        :title="t('settings_unsaved_title')"
        :text="leaveDialogText"
        :actions="leaveDialogActions"
      />
      <QMessageDialog
        v-model="deleteProfileDialogOpen"
        icon="PhTrash"
        iconColor="red"
        :title="t('action_delete')"
        :text="deleteProfileDialogText"
        :actions="deleteProfileDialogActions"
      />
    </AppPage>
  `,
};

export default SettingsView;
