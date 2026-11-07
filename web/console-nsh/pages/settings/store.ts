// The Settings page's state and requests (the setup() of the Vue console's SettingsView.js): the
// drafts of every section, what was loaded (to tell what changed), loading and saving, and the
// section save bar. One store per page; the page hands it to its sections.
//
// Drafts are reactive records (lib/stores/reactive-record.js): `state.telegram.bot_token = "x"`
// writes a signal, so the copied logic reads as it did. Arrays are replaced, never mutated.
import { batch, computed, effect, signal, untracked } from "nsh";
import {
  apiFetch,
  authState,
  currentLocale,
  endpointApiFetch,
  endpointState,
  loadEndpoints,
  runtimeApiDownloadForEndpoint,
  runtimeApiFetchForEndpoint,
  runtimeEndpointByRef,
} from "../../lib/core/context.js";
import { useNotice } from "../../lib/core/notices.js";
import { captureUnsavedScopes, mergeConfigUpdates, restoreUnsavedScopes } from "../../lib/core/settings-save.js";
import { inferenceProviderLogo } from "../../lib/core/inference-provider-logos.js";
import { hasLLMFieldValue, isLLMFieldEnvManaged, llmFieldEnvRawValue, llmFieldValue } from "../../lib/core/llm-env-managed.js";
import { isSecretReference, pickedReference } from "../../lib/core/secret-keys.js";
import {
  OPENAI_COMPATIBLE_API_BASE_OPTIONS,
  normalizeSetupProviderChoice,
  SETUP_PROVIDER_BEDROCK,
  SETUP_PROVIDER_CLOUDFLARE,
  SETUP_PROVIDER_MISTERMORPH_PRO,
  SETUP_PROVIDER_OPENAI_CODEX,
  SETUP_PROVIDER_OPTIONS,
  SETUP_PROVIDER_XAI_OAUTH,
  setupOpenAICodexUsesAPIKey,
  setupProfileBenchmarkIds,
  setupProfileDecisionOnly,
  setupProviderEvaluateOnly,
  setupProviderRequiresAPIKey,
  setupProviderSupportsCustomAPIBase,
} from "../../lib/core/setup-contract.js";
import { invalidateConsoleSetupReadiness } from "../../lib/core/setup.js";
import { openReentrantDialog } from "../../lib/core/reentrant-dialog.js";
import {
  CHANNEL_CONFIG_GROUPS,
  DEFAULT_MODEL_ADVANCED_CONFIG_GROUPS,
  LLM_CONTEXT_CONFIG_GROUPS,
  SECURITY_CONFIG_GROUPS,
  TOOL_ADVANCED_CONFIG_GROUPS,
} from "../../lib/core/config-field-groups.js";
import {
  buildEmptyPersonaIdentityState,
  buildIdentityYAML,
  buildPersonaIdentitySnapshot,
  dispatchPersonaAvatarUpdated,
  dispatchPersonaIdentityUpdated,
  normalizeSoulDocument,
  parseIdentityProfile,
  PERSONA_AVATAR_ENDPOINT,
  PERSONA_IDENTITY_ENDPOINT,
  PERSONA_SOUL_ENDPOINT,
} from "../../lib/core/persona-profile.js";
import { modelPickerItemsFromPayload } from "../../lib/core/setup-picker.js";
import { reactiveRecord } from "../../lib/stores/reactive-record.js";
import { hasFeature, isDesktop, restartDesktopApp } from "../../lib/platform";
import { navigate } from "../../lib/router";
import { createDeviceAuthFlow } from "./device-auth";
import { t } from "./i18n";
import {
  CHANNEL_GROUP_TRIGGER_VALUES,
  CHANNEL_ITEMS,
  LOCAL_CONSOLE_ENDPOINT_REF,
  MANAGED_RUNTIME_ITEMS,
  type SettingsSection,
  TOOL_ITEMS,
  type ToolItem,
} from "./constants";

/* ---------- plain helpers (as in SettingsView.js) ---------- */

export function trimText(value: unknown) {
  return String(value || "").trim();
}

function splitAbilities(value: unknown) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeText(value: unknown) {
  return String(value || "").replace(/\r\n/g, "\n");
}

export function lineCount(value: unknown) {
  const text = String(value || "");
  if (!text) return 0;
  return text.split(/\r?\n/).length;
}

function normalizeNamedList(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const name = trimText(value);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

export function normalizeConsoleGroupTriggerMode(value: unknown) {
  const next = String(value || "").trim().toLowerCase();
  return CHANNEL_GROUP_TRIGGER_VALUES.includes(next) ? next : "talkative";
}

// Discord defaults to strict: the one mode that works without the Message Content intent.
export function normalizeDiscordGroupTriggerMode(value: unknown) {
  const next = String(value || "").trim().toLowerCase();
  return CHANNEL_GROUP_TRIGGER_VALUES.includes(next) ? next : "strict";
}

function parseConfigListText(value: unknown) {
  return normalizeNamedList(String(value || "").split(/\r?\n|,/));
}

function formatConfigList(values: unknown) {
  return normalizeNamedList(Array.isArray(values) ? values : []).join("\n");
}

function toolEnabledValue(entry: any) {
  return !!(entry && typeof entry === "object" && entry.enabled === true);
}

function str(value: unknown) {
  return typeof value === "string" ? value : "";
}

function obj(value: unknown): Record<string, any> {
  return value && typeof value === "object" ? (value as Record<string, any>) : {};
}

function buildEmptyLLMForm() {
  return {
    description: "",
    abilities: "",
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

const EMPTY_CHANNELS = {
  telegram: () => ({ bot_token: "", allowed_chat_ids_text: "", group_trigger_mode: "talkative" }),
  slack: () => ({ bot_token: "", app_token: "", allowed_team_ids_text: "", allowed_channel_ids_text: "", group_trigger_mode: "talkative" }),
  line: () => ({ channel_access_token: "", channel_secret: "", allowed_group_ids_text: "", group_trigger_mode: "talkative" }),
  lark: () => ({ app_id: "", app_secret: "", allowed_chat_ids_text: "", group_trigger_mode: "talkative" }),
  discord: () => ({
    bot_token: "",
    allowed_guild_ids_text: "",
    allowed_channel_ids_text: "",
    allowed_user_ids_text: "",
    group_trigger_mode: "strict",
  }),
  // WeChat has nothing to edit: the bot comes from QR login (its token never reaches the browser),
  // and bot_id shows which bot is connected.
  wechat: () => ({ bot_id: "" }),
  whatsapp: () => ({ api_token: "" }),
  bluesky: () => ({ service_url: "", identifier: "", app_password: "" }),
  // The saved login is read-only here, changed by the X login panel.
  x: () => ({ client_id: "", client_secret: "", refresh_token: "", login: { logged_in: false, username: "" } }),
  mixin: () => ({ keystore_file: "", allowed_conversation_ids_text: "" }),
  guard: () => ({
    enabled: true,
    url_fetch_allowed_url_prefixes_text: "https://",
    deny_private_ips: true,
    follow_redirects: false,
    allow_proxy: false,
    redaction_enabled: true,
    approvals_enabled: false,
  }),
};

const DEFAULT_TOOLS = {
  write_file: true,
  spawn: true,
  coder: false,
  contacts_send: true,
  todo_update: true,
  plan_create: false,
  codemode: true,
  tool_search: true,
  url_fetch: true,
  web_search: true,
  bash: true,
  powershell: false,
  image_generate: true,
  image_edit: true,
};

const MANAGED_RUNTIME_DEFAULTS = Object.fromEntries(MANAGED_RUNTIME_ITEMS.map((item) => [item.id, false])) as Record<string, boolean>;

let llmProfileKeySeed = 0;
let mcpSettingsKeySeed = 0;

function nextLLMProfileKey() {
  llmProfileKeySeed += 1;
  return `llm-profile-${Date.now()}-${llmProfileKeySeed}`;
}

export function serializeLLMProfile(profile: any) {
  return {
    name: trimText(profile?.name),
    description: trimText(profile?.description),
    abilities: trimText(profile?.abilities),
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

/** A profile's draft: a reactive record, each field a signal. `_secretDirty` is replaced, not mutated. */
export type LLMProfile = ReturnType<typeof buildEmptyLLMForm> & {
  _key: string;
  _envManaged: Record<string, any>;
  _secretFields: Record<string, any>;
  _secretDirty: Set<string>;
  _savedName: string;
  _savedSnapshot: string;
  _draft: boolean;
  name: string;
  headers?: unknown;
};

function buildLLMProfileState(data: Record<string, any> = {}): LLMProfile {
  const initial: any = {
    _key: nextLLMProfileKey(),
    _envManaged: {},
    _secretFields: {},
    _secretDirty: new Set<string>(),
    _savedName: "",
    _savedSnapshot: "",
    _draft: false,
    name: "",
    ...buildEmptyLLMForm(),
    ...(data && typeof data === "object" ? data : {}),
  };
  initial.headers_text = JSON.stringify(data?.headers && typeof data.headers === "object" ? data.headers : {}, null, 2);
  initial._savedName = trimText(initial.name);
  initial._savedSnapshot = JSON.stringify(serializeLLMProfile(initial));
  return reactiveRecord(initial) as LLMProfile;
}

function nextMCPSettingsKey(prefix: string) {
  mcpSettingsKeySeed += 1;
  return `mcp-${prefix}-${mcpSettingsKeySeed}`;
}

function buildMCPPairRows(values: unknown) {
  if (!values || typeof values !== "object" || Array.isArray(values)) return [];
  return Object.entries(values).map(([key, value]) => ({
    _key: nextMCPSettingsKey("pair"),
    key: String(key || ""),
    value: String(value ?? ""),
  }));
}

export function buildMCPServerState(server: any) {
  const value = server && typeof server === "object" ? server : {};
  return {
    _key: nextMCPSettingsKey("server"),
    name: trimText(value.name),
    enable: value.enable !== false,
    on_demand: value.on_demand === true,
    description: typeof value.description === "string" ? value.description : "",
    type: trimText(value.type).toLowerCase() === "http" ? "http" : "stdio",
    command: typeof value.command === "string" ? value.command : "",
    args_text: Array.isArray(value.args) ? value.args.map((item: unknown) => String(item ?? "")).join("\n") : "",
    env_rows: buildMCPPairRows(value.env),
    url: typeof value.url === "string" ? value.url : "",
    header_rows: buildMCPPairRows(value.headers),
    allowed_tools_text: Array.isArray(value.allowed_tools)
      ? value.allowed_tools.map((item: unknown) => String(item ?? "")).join("\n")
      : "",
  };
}

function parseMCPLineList(value: unknown) {
  return String(value || "")
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function serializeMCPPairs(rows: unknown) {
  const values: Record<string, string> = {};
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = trimText(row?.key);
    if (key) values[key] = String(row?.value ?? "");
  }
  return values;
}

export function serializeMCPServer(server: any) {
  return {
    name: trimText(server?.name),
    enable: server?.enable !== false,
    on_demand: server?.on_demand === true,
    description: trimText(server?.description),
    type: server?.type === "http" ? "http" : "stdio",
    command: trimText(server?.command),
    args: parseMCPLineList(server?.args_text),
    env: serializeMCPPairs(server?.env_rows),
    url: trimText(server?.url),
    headers: serializeMCPPairs(server?.header_rows),
    allowed_tools: parseMCPLineList(server?.allowed_tools_text),
  };
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** A unit of the section save bar: one request (or one combined config save) with its label. */
export interface SaveUnit {
  key: string;
  label: string;
  save?: () => Promise<boolean>;
  scope?: string;
  panels?: SaveRegistryEntry[];
}

/** What a config panel registers so the section save bar saves it (ConfigSettingsPanel's saveScope). */
export interface SaveRegistryEntry {
  key: string;
  scope: string;
  label: () => string;
  dirty: () => boolean;
  collectUpdate: () => { config_changes: Record<string, unknown>; reset: string[]; [key: string]: unknown } | null;
  /** Puts the panel's fields back to what was loaded (the save bar's Discard). */
  discard?: () => void;
}

type ConfigUpdate = { config_changes: Record<string, unknown>; reset: string[]; [key: string]: unknown };

/* ---------- the store ---------- */

export function createSettingsStore() {
  const notice = useNotice();

  const loggingOut = signal(false);

  /* --- endpoint --- */
  const settingsEndpointRef = computed(() => trimText(endpointState.selectedRef) || LOCAL_CONSOLE_ENDPOINT_REF);
  const consoleRuntimeEndpoints = computed(() =>
    settingsEndpointRef() === LOCAL_CONSOLE_ENDPOINT_REF ? (endpointState.items as any[]) : [],
  );
  // Stored secrets can be revealed for this console's own config only: a remote runtime's secrets
  // are in its own config. The secret picker is offered on the same terms.
  const secretRevealLocal = computed(() => settingsEndpointRef() === LOCAL_CONSOLE_ENDPOINT_REF);
  const selectedEndpointIsConsole = computed(
    () =>
      settingsEndpointRef() === LOCAL_CONSOLE_ENDPOINT_REF ||
      trimText((runtimeEndpointByRef(settingsEndpointRef()) as any)?.mode).toLowerCase() === "console",
  );
  const consoleEndpointRef = computed(() => (selectedEndpointIsConsole() ? settingsEndpointRef() : LOCAL_CONSOLE_ENDPOINT_REF));
  const currentRef = () => untracked(settingsEndpointRef);

  /* --- drafts --- */
  const state = {
    persona: reactiveRecord(buildEmptyPersonaIdentityState()) as unknown as Record<string, string>,
    llm: reactiveRecord({
      ...buildEmptyLLMForm(),
      current_profile: "",
      profiles: [] as LLMProfile[],
      fallback_profiles: [] as string[],
    }) as ReturnType<typeof buildEmptyLLMForm> & { current_profile: string; profiles: LLMProfile[]; fallback_profiles: string[] },
    tools: reactiveRecord({ ...DEFAULT_TOOLS }) as unknown as Record<string, boolean>,
    mcp: reactiveRecord({ servers: [] as any[] }),
    managedRuntimes: reactiveRecord({ ...MANAGED_RUNTIME_DEFAULTS }) as unknown as Record<string, boolean>,
    telegram: reactiveRecord(EMPTY_CHANNELS.telegram()) as Record<string, any>,
    slack: reactiveRecord(EMPTY_CHANNELS.slack()) as Record<string, any>,
    line: reactiveRecord(EMPTY_CHANNELS.line()) as Record<string, any>,
    lark: reactiveRecord(EMPTY_CHANNELS.lark()) as Record<string, any>,
    mixin: reactiveRecord(EMPTY_CHANNELS.mixin()) as Record<string, any>,
    discord: reactiveRecord(EMPTY_CHANNELS.discord()) as Record<string, any>,
    wechat: reactiveRecord(EMPTY_CHANNELS.wechat()) as Record<string, any>,
    whatsapp: reactiveRecord(EMPTY_CHANNELS.whatsapp()) as Record<string, any>,
    bluesky: reactiveRecord(EMPTY_CHANNELS.bluesky()) as Record<string, any>,
    x: reactiveRecord(EMPTY_CHANNELS.x()) as Record<string, any>,
    guard: reactiveRecord(EMPTY_CHANNELS.guard()) as Record<string, any>,
  };
  type ChannelKind = "telegram" | "slack" | "line" | "lark" | "mixin" | "discord" | "wechat" | "whatsapp" | "bluesky" | "x" | "guard";
  const channelState = (kind: string) => (state as any)[kind] as Record<string, any> | undefined;

  /* --- agent --- */
  const agentLoading = signal(false);
  const agentSaving = signal(false);
  const agentSavingTarget = signal("");
  const agentSettingsReadOnly = signal(false);
  // Set when a remote endpoint has no /settings/agent routes (HTTP 404): the agent, routes, tools
  // and MCP sections then show a hint instead of an editable form.
  const agentSettingsUnsupported = signal(false);
  const agentSettingsReadOnlyReason = signal("");
  const agentSettingsReadOnlyMessage = computed(
    () => trimText(agentSettingsReadOnlyReason()) || t("settings_agent_llm_hint_read_only"),
  );
  const agentBusyReason = computed(() => {
    if (agentLoading()) return "agentLoading";
    if (!agentSaving()) return "";
    const target = trimText(agentSavingTarget());
    return target ? `agentSaving:${target}` : "agentSaving";
  });
  const agentFormDisabledReason = computed(() => (agentSettingsReadOnly() ? agentSettingsReadOnlyMessage() : agentBusyReason()));
  const agentValidationVisible = signal(false);
  const llmConfigPath = signal("");
  const settingsConfigRevision = signal("");
  const agentConfigValues = signal<Record<string, any>>({});
  const agentFieldStates = signal<Record<string, any>>({});
  const loadedLLMSnapshot = signal("");
  const loadedToolsSnapshot = signal("");
  const loadedMCPSnapshot = signal("");
  const agentSettingsLoaded = signal(false);
  const llmEnvManaged = signal<Record<string, any>>({});
  const llmSecretFields = signal<Record<string, any>>({});
  const llmSecretDirty = signal<Set<string>>(new Set());

  /* --- console --- */
  const consoleLoading = signal(false);
  const consoleSaving = signal(false);
  const consoleSavingTarget = signal("");
  const consoleConfigPath = signal("");
  const consoleConfigValues = signal<Record<string, any>>({});
  const consoleFieldStates = signal<Record<string, any>>({});
  const consoleEndpoints = signal<any[]>([]);
  const consoleEndpointErrorOpen = signal(false);
  const consoleEndpointError = signal("");
  const consoleEndpointErrorTitle = signal("");
  const authProfiles = signal<any[]>([]);
  // Allowed auth profiles are picked from the profiles defined above them.
  const securityConfigGroups = computed(() => {
    const names = authProfiles()
      .map((profile) => trimText(profile?.name))
      .filter(Boolean);
    return (SECURITY_CONFIG_GROUPS as any[]).map((group) => ({
      ...group,
      fields: group.fields.map((field: any) => (field.path === "secrets.allow_profiles" ? { ...field, options: names } : field)),
    }));
  });
  const consoleSettingsLoaded = signal(false);
  const consoleEnvManaged = signal<Record<string, any>>({});
  const consoleSecretFields = signal<Record<string, any>>({});
  const consoleSecretDirty = signal<Set<string>>(new Set());
  const loadedConsole: Record<string, ReturnType<typeof signal<string>>> = {};
  for (const scope of ["runtimes", "telegram", "slack", "line", "lark", "mixin", "discord", "whatsapp", "bluesky", "x", "guard"]) {
    loadedConsole[scope] = signal("");
  }

  /* --- persona --- */
  const personaLoading = signal(false);
  const personaSaving = signal(false);
  const personaSavingTarget = signal("");
  const personaErr = signal("");
  const personaOk = signal("");
  const loadedIdentityRaw = signal("");
  const loadedIdentitySnapshot = signal("");
  const loadedSoulSnapshot = signal("");
  const personaSettingsLoaded = signal(false);
  const soulContent = signal("");
  const personaAvatarURL = signal("");
  const personaAvatarBusy = signal(false);
  let personaAvatarObjectURL = "";

  /* --- system and updates --- */
  const systemLoading = signal(false);
  const systemSaving = signal(false);
  const systemSettingsLoaded = signal(false);
  const systemConfigValues = signal<Record<string, any>>({});
  const systemFieldStates = signal<Record<string, any>>({});

  /* --- pickers, dialogs --- */
  const apiBasePickerOpen = signal(false);
  const modelPickerOpen = signal(false);
  const modelPickerTargetProfileKey = signal("");
  const modelPickerLoading = signal(false);
  const modelPickerError = signal("");
  const modelPickerItems = signal<any[]>([]);
  // The model in use by what the picker was opened for: a profile, or the default model.
  const modelPickerSelectedValue = computed(() => {
    const target = state.llm.profiles.find((profile) => profile._key === modelPickerTargetProfileKey()) || null;
    return trimText(target ? target.model : state.llm.model);
  });
  const testConnectionOpen = signal(false);
  const testConnectionLoading = signal(false);
  const testConnectionError = signal("");
  const testConnectionBenchmarks = signal<any[]>([]);
  const testConnectionMeta = reactiveRecord({
    provider: "",
    evaluateOnly: false,
    benchmarkIds: [] as string[],
    apiBase: "",
    model: "",
  });
  const testConnectionTargetProfileKey = signal("");
  const deleteProfileDialogOpen = signal(false);
  const deleteProfileTargetKey = signal("");
  const advancedSettingsOpen = signal(false);
  const advancedSettingsTitle = signal("");
  const advancedSettingsScope = signal("agent");
  const advancedSettingsGroups = signal<any[]>([]);
  const advancedSettingsDirty = signal(false);
  /** The Advanced dialog's panel registers its save function here (the Vue page's ref). */
  let advancedPanelSave: (() => void) | null = null;

  /* --- saved apply modes and the restart banner --- */
  // apply_mode of each successful save since the last reset, so a combined save can report the
  // strongest outcome (a restart beats a plain save) in one message.
  let savedApplyModes: string[] = [];
  function noteSavedApplyMode(payload: any) {
    savedApplyModes.push(trimText(payload?.apply_mode));
  }
  function takeSavedApplyMode() {
    const order = ["process_restart", "runtime_restart", "next_generation"];
    const strongest = order.find((mode) => savedApplyModes.includes(mode)) || "";
    savedApplyModes = [];
    return strongest;
  }

  // A saved change that needs a restart shows the restart banner until the process restarts.
  const restartState = reactiveRecord({ pending: false, busy: false, restarting: false, tasksRunning: false, error: "" });
  let disposed = false;

  async function restartProcess(force = false) {
    batch(() => {
      restartState.busy = true;
      restartState.error = "";
    });
    try {
      if (isDesktop() && hasFeature("restart")) {
        // The desktop app restarts the backend it runs; it does not ask about running tasks.
        await restartDesktopApp();
      } else {
        await apiFetch("/system/restart", { method: "POST", body: { force } });
      }
    } catch (err: any) {
      batch(() => {
        restartState.busy = false;
        if (err?.status === 409) {
          restartState.tasksRunning = true;
        } else {
          restartState.error = String(err?.message || err || "");
        }
      });
      return;
    }
    batch(() => {
      restartState.tasksRunning = false;
      restartState.restarting = true;
    });
    // The old server answers for a moment before it stops; then wait until the new one answers.
    await sleep(1500);
    for (let attempt = 0; attempt < 90 && !disposed; attempt += 1) {
      try {
        await apiFetch("/auth/config", { noAuth: true, perfSource: "bootstrap" });
        // The Vue page reloaded the browser page here; this app reloads what Settings shows.
        reloadAfterRestart();
        return;
      } catch {
        await sleep(1000);
      }
    }
    batch(() => {
      restartState.restarting = false;
      restartState.busy = false;
      restartState.error = t("settings_restart_timeout");
    });
  }

  function reloadAfterRestart() {
    batch(() => {
      restartState.pending = false;
      restartState.busy = false;
      restartState.restarting = false;
      restartState.tasksRunning = false;
      restartState.error = "";
    });
    discardSettingsDrafts();
    void loadEndpoints().catch((error: Error) => console.warn("settings: endpoints after restart", error?.message));
    ensureSettingsSectionData(untracked(selectedSectionID));
  }

  function settingsSavedMessage(payload: any) {
    if (["process_restart", "runtime_restart"].includes(trimText(payload?.apply_mode))) {
      restartState.pending = true;
    }
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

  /* --- snapshots and dirty state --- */

  function buildLLMSnapshot() {
    const llm = state.llm;
    return JSON.stringify({
      llm: {
        inference_provider: trimText(llm.inference_provider),
        provider: trimText(llm.provider),
        endpoint: trimText(llm.endpoint),
        model: trimText(llm.model),
        description: trimText(llm.description),
        abilities: trimText(llm.abilities),
        api_key: trimText(llm.api_key),
        bedrock_aws_key: trimText(llm.bedrock_aws_key),
        bedrock_aws_secret: trimText(llm.bedrock_aws_secret),
        bedrock_region: trimText(llm.bedrock_region),
        bedrock_model_arn: trimText(llm.bedrock_model_arn),
        cloudflare_api_token: trimText(llm.cloudflare_api_token),
        cloudflare_account_id: trimText(llm.cloudflare_account_id),
        fallback_profiles: normalizeNamedList(llm.fallback_profiles),
      },
    });
  }

  function buildToolsSnapshot() {
    return JSON.stringify({ tools: Object.fromEntries(Object.keys(DEFAULT_TOOLS).map((id) => [id, !!state.tools[id]])) });
  }

  function buildMCPSnapshot() {
    return JSON.stringify({ servers: (Array.isArray(state.mcp.servers) ? state.mcp.servers : []).map(serializeMCPServer) });
  }

  const CONSOLE_SNAPSHOTS: Record<string, () => string> = {
    runtimes: () =>
      JSON.stringify(
        Object.fromEntries(["telegram", "slack", "lark", "mixin", "discord", "wechat", "whatsapp"].map((id) => [id, !!state.managedRuntimes[id]])),
      ),
    telegram: () =>
      JSON.stringify({
        bot_token: trimText(state.telegram.bot_token),
        allowed_chat_ids: parseConfigListText(state.telegram.allowed_chat_ids_text),
        group_trigger_mode: normalizeConsoleGroupTriggerMode(state.telegram.group_trigger_mode),
      }),
    slack: () =>
      JSON.stringify({
        bot_token: trimText(state.slack.bot_token),
        app_token: trimText(state.slack.app_token),
        allowed_team_ids: parseConfigListText(state.slack.allowed_team_ids_text),
        allowed_channel_ids: parseConfigListText(state.slack.allowed_channel_ids_text),
        group_trigger_mode: normalizeConsoleGroupTriggerMode(state.slack.group_trigger_mode),
      }),
    line: () =>
      JSON.stringify({
        channel_access_token: trimText(state.line.channel_access_token),
        channel_secret: trimText(state.line.channel_secret),
        allowed_group_ids: parseConfigListText(state.line.allowed_group_ids_text),
        group_trigger_mode: normalizeConsoleGroupTriggerMode(state.line.group_trigger_mode),
      }),
    lark: () =>
      JSON.stringify({
        app_id: trimText(state.lark.app_id),
        app_secret: trimText(state.lark.app_secret),
        allowed_chat_ids: parseConfigListText(state.lark.allowed_chat_ids_text),
        group_trigger_mode: normalizeConsoleGroupTriggerMode(state.lark.group_trigger_mode),
      }),
    mixin: () =>
      JSON.stringify({
        keystore_file: trimText(state.mixin.keystore_file),
        allowed_conversation_ids: parseConfigListText(state.mixin.allowed_conversation_ids_text),
      }),
    discord: () =>
      JSON.stringify({
        bot_token: trimText(state.discord.bot_token),
        allowed_guild_ids: parseConfigListText(state.discord.allowed_guild_ids_text),
        allowed_channel_ids: parseConfigListText(state.discord.allowed_channel_ids_text),
        allowed_user_ids: parseConfigListText(state.discord.allowed_user_ids_text),
        group_trigger_mode: normalizeDiscordGroupTriggerMode(state.discord.group_trigger_mode),
      }),
    whatsapp: () => JSON.stringify({ api_token: trimText(state.whatsapp.api_token) }),
    bluesky: () =>
      JSON.stringify({
        service_url: trimText(state.bluesky.service_url),
        identifier: trimText(state.bluesky.identifier),
        app_password: trimText(state.bluesky.app_password),
      }),
    x: () =>
      JSON.stringify({
        client_id: trimText(state.x.client_id),
        client_secret: trimText(state.x.client_secret),
        refresh_token: trimText(state.x.refresh_token),
      }),
    guard: () =>
      JSON.stringify({
        enabled: !!state.guard.enabled,
        network: {
          url_fetch: {
            allowed_url_prefixes: parseConfigListText(state.guard.url_fetch_allowed_url_prefixes_text),
            deny_private_ips: !!state.guard.deny_private_ips,
            follow_redirects: !!state.guard.follow_redirects,
            allow_proxy: !!state.guard.allow_proxy,
          },
        },
        redaction: { enabled: !!state.guard.redaction_enabled },
        approvals: { enabled: !!state.guard.approvals_enabled },
      }),
  };
  // Secret fields whose edit alone makes a scope dirty (a stored secret shows no value to compare).
  const CONSOLE_SECRET_KEYS: Record<string, string[]> = {
    telegram: ["telegram.bot_token"],
    slack: ["slack.bot_token", "slack.app_token"],
    line: ["line.channel_access_token", "line.channel_secret"],
    lark: ["lark.app_secret"],
    discord: ["discord.bot_token"],
    whatsapp: ["whatsapp.api_token"],
    bluesky: ["bluesky.app_password"],
    x: ["x.client_secret", "x.refresh_token"],
  };
  const consoleDirtyOf: Record<string, () => boolean> = {};
  for (const scope of Object.keys(CONSOLE_SNAPSHOTS)) {
    consoleDirtyOf[scope] = computed(() => {
      const loaded = loadedConsole[scope]();
      if (!loaded) return false;
      const secrets = consoleSecretDirty();
      return (CONSOLE_SECRET_KEYS[scope] || []).some((key) => secrets.has(key)) || CONSOLE_SNAPSHOTS[scope]() !== loaded;
    });
  }
  const consoleDirty = computed(() => Object.values(consoleDirtyOf).some((dirty) => dirty()));

  function setLoadedConsoleSnapshots() {
    batch(() => {
      for (const scope of Object.keys(CONSOLE_SNAPSHOTS)) {
        loadedConsole[scope].set(untracked(CONSOLE_SNAPSHOTS[scope]));
      }
    });
  }

  function clearLoadedConsoleSnapshots() {
    batch(() => {
      for (const scope of Object.keys(CONSOLE_SNAPSHOTS)) loadedConsole[scope].set("");
      consoleSettingsLoaded.set(false);
    });
  }

  const llmDirty = computed(() => {
    const loaded = loadedLLMSnapshot();
    if (!loaded) return false;
    return llmSecretDirty().size > 0 || buildLLMSnapshot() !== loaded;
  });
  const toolsDirty = computed(() => {
    const loaded = loadedToolsSnapshot();
    return !!loaded && buildToolsSnapshot() !== loaded;
  });
  const mcpDirty = computed(() => {
    const loaded = loadedMCPSnapshot();
    return !!loaded && buildMCPSnapshot() !== loaded;
  });

  function clearLoadedAgentSnapshots() {
    batch(() => {
      loadedLLMSnapshot.set("");
      loadedToolsSnapshot.set("");
      loadedMCPSnapshot.set("");
      agentSettingsLoaded.set(false);
    });
  }

  function currentAgentSnapshotScope(sectionID = untracked(selectedSectionID)) {
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
    untracked(() =>
      batch(() => {
        if (normalizedScope === "all" || normalizedScope === "agent" || normalizedScope === "llm") {
          loadedLLMSnapshot.set(buildLLMSnapshot());
        }
        if (normalizedScope === "all" || normalizedScope === "tools") {
          loadedToolsSnapshot.set(buildToolsSnapshot());
        }
        if (normalizedScope === "all" || normalizedScope === "mcp") {
          loadedMCPSnapshot.set(buildMCPSnapshot());
        }
      }),
    );
  }

  function ensureLoadedAgentSnapshotsForSection(sectionID: string) {
    if (!untracked(agentSettingsLoaded)) return;
    const scope = currentAgentSnapshotScope(sectionID);
    if (scope === "agent") {
      if (!untracked(loadedLLMSnapshot)) setLoadedAgentSnapshots("llm");
    } else if (scope === "tools" && !untracked(loadedToolsSnapshot)) {
      setLoadedAgentSnapshots("tools");
    } else if (scope === "mcp" && !untracked(loadedMCPSnapshot)) {
      setLoadedAgentSnapshots("mcp");
    }
  }

  function updateLoadedFallbackProfile(originalName: string, nextName: string) {
    const original = trimText(originalName);
    const loaded = untracked(loadedLLMSnapshot);
    if (!original || !loaded) return;
    try {
      const snapshot = JSON.parse(loaded);
      const values = Array.isArray(snapshot?.llm?.fallback_profiles) ? snapshot.llm.fallback_profiles : [];
      snapshot.llm.fallback_profiles = nextName
        ? values.map((value: string) => (trimText(value).toLowerCase() === original.toLowerCase() ? trimText(nextName) : value))
        : values.filter((value: string) => trimText(value).toLowerCase() !== original.toLowerCase());
      loadedLLMSnapshot.set(JSON.stringify(snapshot));
    } catch {
      // A missing snapshot only affects the disabled state of the page-level save button.
    }
  }

  /* --- persona dirty --- */
  const personaIdentityDirty = computed(() => buildPersonaIdentitySnapshot(state.persona) !== loadedIdentitySnapshot());
  const personaSoulDirty = computed(() => normalizeSoulDocument(soulContent()) !== loadedSoulSnapshot());
  const personaDirty = computed(() => personaIdentityDirty() || personaSoulDirty());
  const personaSaveDisabled = computed(() => personaLoading() || personaSaving() || !personaDirty());
  const personaAvatarDisabled = computed(() => personaLoading() || personaSaving() || personaAvatarBusy());
  const personaEditorMeta = computed(() =>
    t("settings_persona_soul_editor_meta", { lines: lineCount(soulContent()), chars: soulContent().length }),
  );

  /* --- providers --- */
  const providerItems = SETUP_PROVIDER_OPTIONS as { title: string; value: string; group?: string }[];
  // The default LLM runs the main loop, so it cannot be an Evaluate-only provider.
  const defaultLLMProviderItems = providerItems.filter((item) => !setupProviderEvaluateOnly(item.value));
  const apiBasePickerItems = (OPENAI_COMPATIBLE_API_BASE_OPTIONS as any[]).map((item) => ({
    id: item.id,
    title: item.title,
    value: item.baseURL,
    note: "",
  }));
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
  const groupTriggerItems = computed(() => [
    { title: t("settings_console_group_trigger_smart"), value: "smart" },
    { title: t("settings_console_group_trigger_strict"), value: "strict" },
    { title: t("settings_console_group_trigger_talkative"), value: "talkative" },
  ]);

  /* --- the auth flows --- */
  const codexAuth = createDeviceAuthFlow({
    kind: "codex",
    getEndpointRef: () => untracked(settingsEndpointRef),
    onSettingsUpdated: async (_payload, endpointRef) => {
      await loadAgentSettings(endpointRef);
    },
    refreshWhen: () => untracked(codexOAuthInUse),
  });
  const xaiAuth = createDeviceAuthFlow({
    kind: "xai",
    getEndpointRef: () => untracked(settingsEndpointRef),
    onSettingsUpdated: async (_payload, endpointRef) => {
      await loadAgentSettings(endpointRef);
    },
  });
  const proAuth = createDeviceAuthFlow({
    kind: "pro",
    getEndpointRef: () => untracked(settingsEndpointRef),
    onSettingsUpdated: async (_payload, endpointRef) => {
      await loadAgentSettings(endpointRef);
    },
  });

  /* --- sections --- */
  const selectedSectionID = signal("persona");
  const settingsSections = computed<SettingsSection[]>(() => {
    const items: SettingsSection[] = [
      { id: "persona", icon: "PhUserCircle", title: t("settings_persona_title"), meta: t("settings_section_persona_meta"), saveKind: "persona" },
      { id: "agent", icon: "PhRobot", title: t("settings_agent_block_title"), meta: t("settings_section_agent_meta"), saveKind: "agent" },
      { id: "routes", icon: "PhArrowsSplit", title: t("settings_routes_title"), meta: t("settings_section_routes_meta"), saveKind: "agent" },
      { id: "tools", icon: "PhToolbox", title: t("settings_tools_title"), meta: t("settings_section_tools_meta"), saveKind: "agent" },
      { id: "mcp", icon: "PhPlugsConnected", title: t("settings_mcp_title"), meta: t("settings_section_mcp_meta"), saveKind: "agent" },
    ];
    if (selectedEndpointIsConsole()) {
      items.push({ id: "channels", icon: "PhChats", title: t("settings_console_channels_title"), saveKind: "console" });
      items.push({ id: "security", icon: "PhShieldCheck", title: t("settings_console_guard_title"), meta: t("settings_section_guard_meta"), saveKind: "console" });
      items.push({
        id: "automation",
        icon: "PhCalendarCheck",
        title: t("settings_automation_title"),
        meta: t("settings_section_automation_meta"),
        saveKind: "console-config",
      });
      items.push({ id: "system", icon: "PhGearSix", title: t("settings_system_title"), meta: t("settings_section_system_meta"), saveKind: "system-config" });
      items.push({ id: "console", icon: "PhNetwork", title: t("settings_console_title"), meta: t("settings_section_console_meta"), saveKind: "" });
    }
    items.push({ id: "app", icon: "PhAppWindow", title: t("settings_app_title"), meta: t("settings_section_app_meta"), saveKind: "" });
    items.push({ id: "runtime", icon: "PhPulse", title: t("runtime_title"), saveKind: "" });
    items.push({ id: "credits", icon: "PhInfo", title: t("settings_credits_title"), saveKind: "" });
    return items;
  });
  const selectedSection = computed(
    () => settingsSections().find((item) => item.id === selectedSectionID()) || settingsSections()[0] || null,
  );
  const activeSaveKind = computed(() => String(selectedSection()?.saveKind || ""));
  const consolePasswordConfigured = computed(
    () =>
      consoleFieldStates()?.["console.password_hash"]?.configured === true ||
      consoleFieldStates()?.["console.password"]?.configured === true,
  );
  // Browse only makes sense for this machine's settings: a picked folder is a local path.
  const canBrowsePaths = computed(() => settingsEndpointRef() === LOCAL_CONSOLE_ENDPOINT_REF && isDesktop() && hasFeature("pickDirectory"));

  /* --- the save registry (ConfigSettingsPanel with a saveScope) --- */
  const saveRegistryEntries = signal<Map<string, SaveRegistryEntry>>(new Map());
  const saveRegistry = {
    register(entry: SaveRegistryEntry) {
      saveRegistryEntries.update((map) => new Map(map).set(entry.key, entry));
    },
    unregister(key: string) {
      saveRegistryEntries.update((map) => {
        if (!map.has(key)) return map;
        const next = new Map(map);
        next.delete(key);
        return next;
      });
    },
  };

  /* --- channels --- */
  const CONSOLE_SECTION_TARGETS: Record<string, [string, string][]> = {
    channels: [
      ["telegram", "settings_console_telegram_title"],
      ["slack", "settings_console_slack_title"],
      ["line", "settings_console_line_title"],
      ["lark", "settings_console_lark_title"],
      ["mixin", "settings_console_mixin_title"],
      ["discord", "settings_console_discord_title"],
      ["whatsapp", "settings_console_whatsapp_title"],
      ["bluesky", "settings_console_bluesky_title"],
      ["x", "settings_console_x_title"],
      ["runtimes", "settings_channel_run_in_console"],
    ],
    security: [["guard", "settings_console_guard_title"]],
    runtimes: [["runtimes", ""]],
  };

  // Channels: a tile per channel, and the channel's settings in a panel from the right.
  const openChannel = signal("");

  function consoleFieldEntry(kind: string, field: string) {
    const key = String(field || "").trim();
    const group = consoleEnvManaged()?.[String(kind || "").trim()];
    if (!key || !group || typeof group !== "object") return null;
    const entry = group[key];
    return entry && typeof entry === "object" ? entry : null;
  }
  function consoleFieldRawValue(group: any, field: string) {
    const key = String(field || "").trim();
    if (!key || !group || typeof group !== "object") return "";
    const entry = group[key];
    return typeof entry?.raw_value === "string" ? entry.raw_value.trim() : "";
  }
  function consoleFieldEnvManaged(kind: string, field: string) {
    const envName = consoleFieldEntry(kind, field)?.env_name;
    return typeof envName === "string" && envName.trim() !== "";
  }
  function consoleSecretField(kind: string, field: string) {
    const group = consoleSecretFields()?.[kind];
    const entry = group && typeof group === "object" ? group[field] : null;
    return entry && typeof entry === "object" ? entry : null;
  }
  function secretConfigured(fields: any, field: string) {
    return fields?.[field]?.configured === true;
  }
  function includeConsoleSecretValue(kind: string, field: string, value: unknown) {
    const key = `${kind}.${field}`;
    return untracked(consoleSecretDirty).has(key) || !secretConfigured(untracked(consoleSecretFields)?.[kind] || {}, field)
      ? trimText(value)
      : undefined;
  }
  function markConsoleSecretDirty(kind: string, field: string) {
    if (untracked(() => consoleSecretField(kind, field))) {
      consoleSecretDirty.update((set) => new Set(set).add(`${kind}.${field}`));
    }
  }
  function consoleSecretEditable(kind: string, field: string) {
    return consoleSecretField(kind, field)?.editable !== false;
  }
  function consoleFieldManagedHeadline(kind: string, field: string) {
    const entry = consoleFieldEntry(kind, field);
    const envName = typeof entry?.env_name === "string" ? entry.env_name.trim() : "";
    if (!envName) return "";
    const value = typeof entry?.value === "string" ? entry.value.trim() : "";
    return value === "" ? envName : `${envName}=${value}`;
  }
  function consoleSecretRevealPath(kind: string, field: string) {
    return secretRevealLocal() ? `${kind}.${field}` : "";
  }

  function channelFieldSet(kind: string, field: string): boolean {
    if (kind === "x" && field === "login") {
      return state.x.login?.logged_in === true || channelFieldSet("x", "refresh_token");
    }
    return (
      trimText(channelState(kind)?.[field]) !== "" || consoleSecretField(kind, field)?.configured === true || consoleFieldEnvManaged(kind, field)
    );
  }
  function channelManagedItem(id: string) {
    return MANAGED_RUNTIME_ITEMS.find((item) => item.id === id) || null;
  }
  const channelTiles = computed(() =>
    CHANNEL_ITEMS.map((item) => {
      const configured = item.required.every((field) => channelFieldSet(item.id, field));
      return {
        ...item,
        configured,
        running: configured && !!channelManagedItem(item.id) && !!state.managedRuntimes[item.id],
        dirty: !!consoleDirtyOf[item.id]?.(),
      };
    }),
  );
  // Configured channels first, then the ones not set up; an empty group is not shown.
  const channelGroups = computed(() =>
    [
      { id: "configured", titleKey: "settings_channel_group_configured", items: channelTiles().filter((item) => item.configured) },
      { id: "unconfigured", titleKey: "settings_channel_group_unconfigured", items: channelTiles().filter((item) => !item.configured) },
    ].filter((group) => group.items.length > 0),
  );
  // Each threshold is read in one trigger mode only: confidence in smart, interject in talkative;
  // strict reads neither. "Record all group messages" applies in every mode.
  function channelTriggerHiddenPaths(id: string) {
    const mode =
      id === "discord"
        ? normalizeDiscordGroupTriggerMode(state.discord.group_trigger_mode)
        : normalizeConsoleGroupTriggerMode(channelState(id)?.group_trigger_mode);
    const confidence = `${id}.addressing_confidence_threshold`;
    const interject = `${id}.addressing_interject_threshold`;
    if (mode === "smart") return [interject];
    if (mode === "talkative") return [confidence];
    return [confidence, interject];
  }
  const openChannelTitleKey = computed(
    () => CHANNEL_ITEMS.find((item) => item.id === openChannel())?.titleKey || "settings_console_channels_title",
  );
  // Closing keeps the draft: it stays in the save bar, and the tile shows it is unsaved.
  function openChannelPane(id: string) {
    openChannel.update((current) => (current === id ? "" : id));
  }
  function closeChannelPane() {
    openChannel.set("");
  }
  // A login uses the saved client ID, so it waits until the pane is saved.
  const xLoginReady = computed(() => trimText(state.x.client_id) !== "" && !consoleDirtyOf.x());

  /* --- models (profiles) --- */
  const openProfileKey = signal("");
  const openedProfile = computed(() => state.llm.profiles.find((item) => item._key === openProfileKey() && !item._draft) || null);
  function openProfilePane(key: string) {
    openProfileKey.update((current) => (current === key ? "" : key));
  }
  function closeProfilePane() {
    openProfileKey.set("");
  }

  function llmProfileEnvManaged(profile: any) {
    return profile?._envManaged && typeof profile._envManaged === "object" ? profile._envManaged : {};
  }
  function llmProfileSecretFields(profile: any) {
    return profile?._secretFields && typeof profile._secretFields === "object" ? profile._secretFields : {};
  }
  function hasLLMFieldOrSecretValue(config: any, envManaged: any, secretFields: any, field: string) {
    return hasLLMFieldValue(config, envManaged, field) || secretConfigured(secretFields, field);
  }
  function includeSecretValue(value: unknown, fields: any, dirty: Set<string>, field: string) {
    return dirty.has(field) || !secretConfigured(fields, field) ? trimText(value) : undefined;
  }
  function profileProviderChoice(profile: any): string {
    const envManaged = llmProfileEnvManaged(profile);
    return normalizeSetupProviderChoice(
      llmFieldValue(profile, envManaged, "inference_provider") || llmFieldValue(profile, envManaged, "provider"),
      { allowEmpty: true },
    );
  }
  // Provider and model in one line, for the list and the panel header.
  function profileSummary(profile: any) {
    const choice = profileProviderChoice(profile);
    const provider = providerItems.find((item) => item.value === choice)?.title || "";
    const model = trimText(profile?.model);
    return [provider, model].filter(Boolean).join(" · ");
  }
  // The provider's logo for a profile row, with initials when there is no logo.
  function profileLogo(profile: any) {
    const choice = profileProviderChoice(profile);
    const logo = inferenceProviderLogo(choice) as { src?: any; className?: string };
    const title = providerItems.find((item) => item.value === choice)?.title || "";
    const initials = title
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((word) => word[0].toUpperCase())
      .join("");
    return { src: logo?.src || null, className: logo?.className || "is-fallback", text: initials || "LLM" };
  }

  const defaultProviderChoice = computed<string>(() =>
    normalizeSetupProviderChoice(
      llmFieldValue(state.llm, llmEnvManaged(), "inference_provider") || llmFieldValue(state.llm, llmEnvManaged(), "provider"),
      { allowEmpty: true },
    ),
  );
  const defaultIsCodexProvider = computed(() => defaultProviderChoice() === SETUP_PROVIDER_OPENAI_CODEX);
  const defaultCodexUsesAPIKey = computed(() =>
    setupOpenAICodexUsesAPIKey(
      llmFieldValue(state.llm, llmEnvManaged(), "endpoint"),
      hasLLMFieldOrSecretValue(state.llm, llmEnvManaged(), llmSecretFields(), "api_key"),
    ),
  );
  const defaultCodexAuthDisabled = computed(
    () =>
      trimText(llmFieldValue(state.llm, llmEnvManaged(), "endpoint")) !== "" &&
      hasLLMFieldOrSecretValue(state.llm, llmEnvManaged(), llmSecretFields(), "api_key"),
  );
  const defaultIsXAIProvider = computed(() => defaultProviderChoice() === SETUP_PROVIDER_XAI_OAUTH);
  const defaultIsProProvider = computed(() => defaultProviderChoice() === SETUP_PROVIDER_MISTERMORPH_PRO);

  function profileUsesCodexAPIKey(profile: any) {
    const envManaged = llmProfileEnvManaged(profile);
    return (
      profileProviderChoice(profile) === SETUP_PROVIDER_OPENAI_CODEX &&
      setupOpenAICodexUsesAPIKey(
        llmFieldValue(profile, envManaged, "endpoint"),
        hasLLMFieldOrSecretValue(profile, envManaged, llmProfileSecretFields(profile), "api_key"),
      )
    );
  }
  const codexOAuthInUse = computed(
    () =>
      (defaultIsCodexProvider() && !defaultCodexUsesAPIKey()) ||
      state.llm.profiles.some(
        (profile) => profileProviderChoice(profile) === SETUP_PROVIDER_OPENAI_CODEX && !profileUsesCodexAPIKey(profile),
      ),
  );
  const showCodexAuthCard = computed(
    () => defaultIsCodexProvider() || state.llm.profiles.some((profile) => profileProviderChoice(profile) === SETUP_PROVIDER_OPENAI_CODEX),
  );
  const showProAuthCard = computed(() => {
    if (!selectedEndpointIsConsole()) return false;
    if (defaultIsProProvider()) return true;
    return state.llm.profiles.some((profile) => profileProviderChoice(profile) === SETUP_PROVIDER_MISTERMORPH_PRO);
  });
  const showXAIAuthCard = computed(() => {
    if (!selectedEndpointIsConsole()) return false;
    if (defaultIsXAIProvider()) return true;
    return state.llm.profiles.some((profile) => profileProviderChoice(profile) === SETUP_PROVIDER_XAI_OAUTH);
  });
  const defaultShowCloudflareAccountField = computed(() => defaultProviderChoice() === SETUP_PROVIDER_CLOUDFLARE);
  const defaultShowBedrockFields = computed(() => defaultProviderChoice() === SETUP_PROVIDER_BEDROCK);
  const defaultCredentialFieldName = computed(() => (defaultShowCloudflareAccountField() ? "cloudflare_api_token" : "api_key"));

  const profileOptions = computed(() =>
    state.llm.profiles
      .filter((profile) => !profile._draft)
      .map((profile) => ({
        id: profile._key,
        title: trimText(profile.name) || t("settings_agent_profile_placeholder"),
        value: trimText(profile.name),
        note: trimText(profile.model),
      }))
      .filter((item) => item.value !== ""),
  );
  // Routes can also name the top-level model, which is the "default" profile.
  const routeProfileOptions = computed(() => [
    { title: "default", value: "default", note: trimText(state.llm.model) },
    ...profileOptions().filter((item) => item.value !== "default"),
  ]);

  function profileValidationError(profile: any) {
    const name = trimText(profile?.name);
    if (!name) return t("settings_agent_profile_name_required");
    if (name.toLowerCase() === "default") return t("settings_agent_profile_name_reserved");
    const matches = state.llm.profiles.filter(
      (item) => item._key !== profile?._key && trimText(item?.name).toLowerCase() === name.toLowerCase(),
    );
    if (matches.length > 0) return t("settings_agent_profile_name_duplicate", { name });
    if (profileProviderChoice(profile) === "") return t("settings_agent_profile_provider_required");
    try {
      const headers = JSON.parse(profile.headers_text || "{}");
      if (!headers || Array.isArray(headers) || typeof headers !== "object") return "HTTP headers must be a JSON object.";
    } catch {
      return "HTTP headers must be valid JSON.";
    }
    return "";
  }
  function profileDirty(profile: any) {
    return profile?._secretDirty?.size > 0 || JSON.stringify(serializeLLMProfile(profile)) !== String(profile?._savedSnapshot || "");
  }
  function profileIsInUse(profile: any) {
    const currentProfile = trimText(state.llm.current_profile);
    const savedProfileName = trimText(profile?._savedName);
    return currentProfile !== "" && savedProfileName !== "" && savedProfileName === currentProfile;
  }
  const agentValidationError = computed(() => {
    if (!hasLLMFieldValue(state.llm, llmEnvManaged(), "inference_provider") && !hasLLMFieldValue(state.llm, llmEnvManaged(), "provider")) {
      return "";
    }
    const seen = new Set<string>();
    for (const profile of state.llm.profiles) {
      const savedName = trimText(profile?._savedName);
      if (savedName) seen.add(savedName.toLowerCase());
    }
    for (const fallback of state.llm.fallback_profiles) {
      const name = trimText(fallback);
      if (!name) return t("settings_agent_fallback_required");
      if (!seen.has(name.toLowerCase())) return t("settings_agent_fallback_unknown", { name });
    }
    return "";
  });
  const deleteProfileTarget = computed(() => state.llm.profiles.find((item) => item._key === deleteProfileTargetKey()) || null);
  const deleteProfileDialogText = computed(() =>
    t("settings_agent_profile_delete_confirm", {
      name: trimText(deleteProfileTarget()?.name) || t("settings_agent_profile_placeholder"),
    }),
  );

  const xaiReady = () => xaiAuth.ready();
  const proLoggedIn = () => proAuth.status().logged_in;
  const codexLoggedIn = () => codexAuth.status().logged_in;

  const testConnectionDisabled = computed(
    () =>
      testConnectionLoading() ||
      agentLoading() ||
      agentSaving() ||
      defaultProviderChoice() === "" ||
      !hasLLMFieldValue(state.llm, llmEnvManaged(), "model") ||
      (defaultIsCodexProvider() && !defaultCodexUsesAPIKey() && !codexLoggedIn()) ||
      (selectedEndpointIsConsole() && defaultIsXAIProvider() && !xaiReady()) ||
      (selectedEndpointIsConsole() && defaultIsProProvider() && !proLoggedIn()) ||
      (setupProviderRequiresAPIKey(defaultProviderChoice()) &&
        !hasLLMFieldOrSecretValue(state.llm, llmEnvManaged(), llmSecretFields(), defaultCredentialFieldName())) ||
      (defaultShowBedrockFields() && !hasLLMFieldOrSecretValue(state.llm, llmEnvManaged(), llmSecretFields(), "bedrock_aws_key")) ||
      (defaultShowBedrockFields() && !hasLLMFieldOrSecretValue(state.llm, llmEnvManaged(), llmSecretFields(), "bedrock_aws_secret")) ||
      (defaultShowBedrockFields() && !hasLLMFieldValue(state.llm, llmEnvManaged(), "bedrock_region")) ||
      (defaultShowCloudflareAccountField() &&
        !hasLLMFieldOrSecretValue(state.llm, llmEnvManaged(), llmSecretFields(), "cloudflare_api_token")) ||
      (defaultShowCloudflareAccountField() && !hasLLMFieldValue(state.llm, llmEnvManaged(), "cloudflare_account_id")),
  );
  const currentTestTargetProfile = computed(
    () => state.llm.profiles.find((item) => item._key === testConnectionTargetProfileKey()) || null,
  );
  const llmSaveDisabled = computed(
    () =>
      agentLoading() ||
      agentSaving() ||
      agentSettingsReadOnly() ||
      defaultProviderChoice() === "" ||
      !llmDirty() ||
      (defaultIsCodexProvider() && !defaultCodexUsesAPIKey() && !codexLoggedIn()) ||
      (selectedEndpointIsConsole() && defaultIsXAIProvider() && !xaiReady()) ||
      (selectedEndpointIsConsole() && defaultIsProProvider() && !proLoggedIn()) ||
      (setupProviderRequiresAPIKey(defaultProviderChoice()) &&
        !hasLLMFieldOrSecretValue(state.llm, llmEnvManaged(), llmSecretFields(), defaultCredentialFieldName())) ||
      (defaultShowBedrockFields() && !hasLLMFieldOrSecretValue(state.llm, llmEnvManaged(), llmSecretFields(), "bedrock_aws_key")) ||
      (defaultShowBedrockFields() && !hasLLMFieldOrSecretValue(state.llm, llmEnvManaged(), llmSecretFields(), "bedrock_aws_secret")) ||
      (defaultShowBedrockFields() && !hasLLMFieldValue(state.llm, llmEnvManaged(), "bedrock_region")) ||
      (defaultShowCloudflareAccountField() &&
        !hasLLMFieldOrSecretValue(state.llm, llmEnvManaged(), llmSecretFields(), "cloudflare_api_token")) ||
      (defaultShowCloudflareAccountField() && !hasLLMFieldValue(state.llm, llmEnvManaged(), "cloudflare_account_id")),
  );
  function profileSaveDisabled(profile: any) {
    const provider = profileProviderChoice(profile);
    return (
      agentLoading() ||
      agentSaving() ||
      agentSettingsReadOnly() ||
      !profileDirty(profile) ||
      profileValidationError(profile) !== "" ||
      (provider === SETUP_PROVIDER_OPENAI_CODEX && !profileUsesCodexAPIKey(profile) && !codexLoggedIn()) ||
      (selectedEndpointIsConsole() && provider === SETUP_PROVIDER_XAI_OAUTH && !xaiReady()) ||
      (selectedEndpointIsConsole() && provider === SETUP_PROVIDER_MISTERMORPH_PRO && !proLoggedIn())
    );
  }
  const toolsSaveDisabled = computed(() => agentLoading() || agentSaving() || agentSettingsReadOnly() || !toolsDirty());
  const mcpValidationError = computed(() => {
    const names = new Set<string>();
    for (const server of state.mcp.servers) {
      const name = trimText(server?.name);
      if (!name) return t("settings_mcp_error_name_required");
      const nameKey = name.toLowerCase();
      if (names.has(nameKey)) return t("settings_mcp_error_name_duplicate", { name });
      names.add(nameKey);
      if (server?.enable !== false && server?.type === "http" && !trimText(server?.url)) {
        return t("settings_mcp_error_url_required", { name });
      }
      if (server?.enable !== false && server?.type !== "http" && !trimText(server?.command)) {
        return t("settings_mcp_error_command_required", { name });
      }
      for (const rows of [server?.env_rows, server?.header_rows]) {
        const keys = new Set<string>();
        for (const row of Array.isArray(rows) ? rows : []) {
          const key = trimText(row?.key);
          if (!key) return t("settings_mcp_error_key_required", { name });
          const normalized = key.toLowerCase();
          if (keys.has(normalized)) return t("settings_mcp_error_key_duplicate", { name, key });
          keys.add(normalized);
        }
      }
    }
    return "";
  });
  const mcpSaveDisabled = computed(
    () => agentLoading() || agentSaving() || agentSettingsReadOnly() || !mcpDirty() || mcpValidationError() !== "",
  );
  const consoleTargetSaveDisabled = (target: string) => consoleLoading() || consoleSaving() || !consoleDirtyOf[target]?.();

  /* --- the section save bar --- */
  const sectionSaveUnits = computed<SaveUnit[]>(() => {
    const id = selectedSection()?.id || "";
    const title = selectedSection()?.title || "";
    const units: SaveUnit[] = [];
    if (id === "persona" && personaDirty()) {
      units.push({ key: "persona", label: t("settings_persona_title"), save: () => savePersona({ notify: false }) });
    }
    if (id === "agent") {
      if (llmDirty()) {
        units.push({ key: "llm", label: title, save: () => saveAgentSettings("llm", { notify: false }) });
      }
      for (const profile of state.llm.profiles) {
        if (!profile._draft && profileDirty(profile)) {
          const key = profile._key;
          units.push({
            key: `profile:${key}`,
            label: trimText(profile.name) || title,
            save: () => saveLLMProfile(key, null, { notify: false }),
          });
        }
      }
    }
    if (id === "tools" && toolsDirty()) {
      units.push({ key: "tools", label: title, save: () => saveAgentSettings("tools", { notify: false }) });
    }
    const dirtyTargets = (CONSOLE_SECTION_TARGETS[id] || []).filter(([target]) => consoleDirtyOf[target]());
    if (dirtyTargets.length) {
      const targets = dirtyTargets.map(([target]) => target);
      units.push({
        key: `console:${targets.join(",")}`,
        label: dirtyTargets.map(([, labelKey]) => (labelKey ? t(labelKey) : title)).join(", "),
        // One request for all of the section's console targets.
        save: () => saveConsoleSettings(targets, { notify: false }),
      });
    }
    for (const scope of ["console", "agent", "system"]) {
      const panels = [...saveRegistryEntries().values()].filter((entry) => entry.scope === scope && entry.dirty());
      if (panels.length) {
        units.push({ key: `config:${scope}`, label: panels.map((entry) => entry.label()).join(", "), scope, panels });
      }
    }
    return units;
  });

  const sectionSaving = signal(false);
  const sectionSaveFailed = signal("");
  const sectionSaveBusy = computed(
    () =>
      sectionSaving() ||
      agentLoading() ||
      agentSaving() ||
      consoleLoading() ||
      consoleSaving() ||
      personaLoading() ||
      personaSaving() ||
      systemLoading() ||
      systemSaving(),
  );
  const saveBarVisible = computed(() => sectionSaveUnits().length > 0 || Boolean(sectionSaveFailed()));

  async function saveSection() {
    const units = untracked(sectionSaveUnits);
    if (untracked(sectionSaveBusy) || units.length === 0) return;
    batch(() => {
      sectionSaving.set(true);
      sectionSaveFailed.set("");
    });
    takeSavedApplyMode();
    try {
      // Collect every panel's changes before anything is sent: a save response replaces the shared
      // config values, which would otherwise reset the drafts of panels not yet saved.
      const configSaves: { unit: SaveUnit; update: ConfigUpdate }[] = [];
      for (const unit of units.filter((item) => item.panels)) {
        try {
          configSaves.push({ unit, update: mergeConfigUpdates(unit.panels!.map((panel) => panel.collectUpdate())) as ConfigUpdate });
        } catch (error) {
          console.warn("settings: a panel's changes are invalid", (error as Error)?.message || error);
          sectionSaveFailed.set(unit.label);
          return;
        }
      }
      for (const unit of units.filter((item) => !item.panels)) {
        if (!(await unit.save!())) {
          sectionSaveFailed.set(unit.label);
          return;
        }
      }
      for (const { unit, update } of configSaves) {
        if (!(await saveConfigSettings(unit.scope!, update, { notify: false }))) {
          sectionSaveFailed.set(unit.label);
          return;
        }
      }
      notice.success(settingsSavedMessage({ apply_mode: takeSavedApplyMode() }));
    } finally {
      sectionSaving.set(false);
    }
  }

  /** Throws away the section's unsaved changes and loads it again (the save bar's Discard). */
  function discardSection() {
    if (untracked(sectionSaving)) return;
    for (const entry of untracked(saveRegistryEntries).values()) {
      try {
        entry.discard?.();
      } catch (error) {
        console.warn("settings: discard", entry.key, (error as Error)?.message || error);
      }
    }
    sectionSaveFailed.set("");
    discardSettingsDrafts();
    ensureSettingsSectionData(untracked(selectedSectionID));
  }

  /* --- request bookkeeping --- */
  let agentSettingsRequestSeq = 0;
  let personaSettingsRequestSeq = 0;
  let consoleSettingsRequestSeq = 0;
  const isCurrentAgent = (seq: number, ref: string) => seq === agentSettingsRequestSeq && trimText(ref) === currentRef();
  const isCurrentPersona = (seq: number, ref: string) => seq === personaSettingsRequestSeq && trimText(ref) === currentRef();
  const isCurrentConsole = (seq: number, ref: string) => seq === consoleSettingsRequestSeq && trimText(ref) === currentRef();

  function isAgentSettingsUnsupportedError(err: any, endpointRef: string) {
    return trimText(endpointRef) !== LOCAL_CONSOLE_ENDPOINT_REF && err?.status === 404;
  }
  function agentSettingsErrorMessage(err: any, endpointRef: string, fallbackKey: string) {
    if (isAgentSettingsUnsupportedError(err, endpointRef)) return t("settings_agent_endpoint_unsupported");
    return err?.message || t(fallbackKey);
  }

  /* --- agent: load, apply, reset --- */

  function resetAgentSettingsState() {
    batch(() => {
      Object.assign(state.llm, buildEmptyLLMForm());
      state.llm.current_profile = "";
      state.llm.profiles = [];
      state.llm.fallback_profiles = [];
      Object.assign(state.tools, DEFAULT_TOOLS);
      state.mcp.servers = [];
      llmEnvManaged.set({});
      llmSecretFields.set({});
      llmSecretDirty.set(new Set());
      agentSettingsReadOnly.set(false);
      agentSettingsReadOnlyReason.set("");
      agentSettingsUnsupported.set(false);
      llmConfigPath.set("");
      settingsConfigRevision.set("");
      agentConfigValues.set({});
      agentFieldStates.set({});
      agentValidationVisible.set(false);
      clearLoadedAgentSnapshots();
    });
  }

  function applyMCPPayload(mcp: any) {
    const payload = obj(mcp);
    state.mcp.servers = (Array.isArray(payload.servers) ? payload.servers : []).map(buildMCPServerState);
  }

  function applyPayload(data: any, options: { snapshotScope?: string } = {}) {
    const snapshotScope = String(options?.snapshotScope || currentAgentSnapshotScope());
    const llm = obj(data?.llm);
    const envManagedPayload = obj(data?.env_managed);
    const llmProfileEnvManagedPayload = obj(envManagedPayload.llm_profiles);
    const secretFieldsPayload = obj(data?.secret_fields);
    const llmProfileSecretFieldsPayload = obj(secretFieldsPayload.llm_profiles);
    const tools = obj(data?.tools);
    const profiles = Array.isArray(llm.profiles) ? llm.profiles : [];
    batch(() => {
      agentSettingsReadOnly.set(data?.read_only === true);
      agentSettingsReadOnlyReason.set(data?.read_only === true ? trimText(data?.read_only_reason) : "");
      if (typeof data?.config_revision === "string") settingsConfigRevision.set(data.config_revision);
      const configValues = { ...obj(data?.config_values) };
      agentFieldStates.set(obj(data?.field_states));

      state.llm.inference_provider = normalizeSetupProviderChoice(llm.inference_provider || llm.provider, { allowEmpty: true });
      state.llm.provider = str(llm.provider);
      state.llm.endpoint = str(llm.endpoint);
      state.llm.model = str(llm.model);
      state.llm.description = str(llm.description);
      state.llm.abilities = Array.isArray(llm.abilities) ? llm.abilities.join(",") : "";
      state.llm.context_window_tokens = str(llm.context_window_tokens);
      state.llm.supports_image_parts = str(llm.supports_image_parts);
      configValues["llm.supports_image_parts"] = state.llm.supports_image_parts;
      agentConfigValues.set(configValues);
      state.llm.headers_text = JSON.stringify(llm.headers && typeof llm.headers === "object" ? llm.headers : {}, null, 2);
      state.llm.cache_ttl = str(llm.cache_ttl);
      state.llm.cache_key_prefix = str(llm.cache_key_prefix);
      state.llm.request_timeout = str(llm.request_timeout);
      state.llm.temperature = str(llm.temperature);
      state.llm.reasoning_budget_tokens = str(llm.reasoning_budget_tokens);
      state.llm.api_key = str(llm.api_key);
      state.llm.azure_deployment = str(llm.azure_deployment);
      state.llm.bedrock_aws_key = str(llm.bedrock_aws_key);
      state.llm.bedrock_aws_secret = str(llm.bedrock_aws_secret);
      state.llm.bedrock_aws_session_token = str(llm.bedrock_aws_session_token);
      state.llm.bedrock_aws_profile = str(llm.bedrock_aws_profile);
      state.llm.bedrock_region = str(llm.bedrock_region);
      state.llm.bedrock_model_arn = str(llm.bedrock_model_arn);
      state.llm.cloudflare_api_token = str(llm.cloudflare_api_token);
      state.llm.cloudflare_account_id = str(llm.cloudflare_account_id);
      state.llm.reasoning_effort = str(llm.reasoning_effort);
      state.llm.tools_emulation_mode = typeof llm.tools_emulation_mode === "string" ? llm.tools_emulation_mode : "off";
      state.llm.current_profile = str(llm.current_profile);
      state.llm.profiles = profiles.map((profile: any) => {
        const name = trimText(profile?.name);
        return buildLLMProfileState({
          name,
          _envManaged: obj(llmProfileEnvManagedPayload[name]),
          _secretFields: obj(llmProfileSecretFieldsPayload[name]),
          description: str(profile?.description),
          abilities: Array.isArray(profile?.abilities) ? profile.abilities.join(",") : "",
          inference_provider: normalizeSetupProviderChoice(profile?.inference_provider || profile?.provider, { allowEmpty: true }),
          provider: str(profile?.provider),
          endpoint: str(profile?.endpoint),
          model: str(profile?.model),
          context_window_tokens: str(profile?.context_window_tokens),
          supports_image_parts: str(profile?.supports_image_parts),
          headers: profile?.headers && typeof profile.headers === "object" ? profile.headers : {},
          cache_ttl: str(profile?.cache_ttl),
          cache_key_prefix: str(profile?.cache_key_prefix),
          request_timeout: str(profile?.request_timeout),
          temperature: str(profile?.temperature),
          reasoning_budget_tokens: str(profile?.reasoning_budget_tokens),
          api_key: str(profile?.api_key),
          azure_deployment: str(profile?.azure_deployment),
          bedrock_aws_key: str(profile?.bedrock_aws_key),
          bedrock_aws_secret: str(profile?.bedrock_aws_secret),
          bedrock_aws_session_token: str(profile?.bedrock_aws_session_token),
          bedrock_aws_profile: str(profile?.bedrock_aws_profile),
          bedrock_region: str(profile?.bedrock_region),
          bedrock_model_arn: str(profile?.bedrock_model_arn),
          cloudflare_api_token: str(profile?.cloudflare_api_token),
          cloudflare_account_id: str(profile?.cloudflare_account_id),
          reasoning_effort: str(profile?.reasoning_effort),
          tools_emulation_mode: str(profile?.tools_emulation_mode),
        });
      });
      state.llm.fallback_profiles = normalizeNamedList(llm.fallback_profiles);
      for (const id of Object.keys(DEFAULT_TOOLS)) state.tools[id] = toolEnabledValue(tools[id]);
      applyMCPPayload(data?.mcp);
      llmEnvManaged.set(obj(envManagedPayload.llm));
      llmSecretFields.set(obj(secretFieldsPayload.llm));
      llmSecretDirty.set(new Set());
      agentValidationVisible.set(false);
      agentSettingsLoaded.set(true);
      setLoadedAgentSnapshots(snapshotScope);
    });
  }

  async function loadAgentSettings(endpointRef = currentRef()) {
    const requestSeq = ++agentSettingsRequestSeq;
    const target = trimText(endpointRef) || LOCAL_CONSOLE_ENDPOINT_REF;
    batch(() => {
      agentLoading.set(true);
      agentSettingsReadOnly.set(false);
      agentSettingsReadOnlyReason.set("");
    });
    try {
      const data: any = await endpointApiFetch(target, "/settings/agent");
      if (!isCurrentAgent(requestSeq, target)) return;
      batch(() => {
        agentSettingsUnsupported.set(false);
        llmConfigPath.set(str(data?.config_path));
        applyPayload(data);
      });
    } catch (e: any) {
      if (!isCurrentAgent(requestSeq, target)) return;
      if (isAgentSettingsUnsupportedError(e, target)) {
        agentSettingsUnsupported.set(true);
        return;
      }
      notice.error(agentSettingsErrorMessage(e, target, "msg_load_failed"));
    } finally {
      if (isCurrentAgent(requestSeq, target)) agentLoading.set(false);
    }
  }

  /* --- agent: field edits --- */

  function updateDefaultLLMField({ field, value }: { field: string; value: unknown }) {
    if (untracked(agentSettingsReadOnly)) return;
    const key = String(field || "").trim();
    if (!key || !Object.prototype.hasOwnProperty.call(state.llm, key)) return;
    const nextValue = String(value || "");
    if (untracked(() => (state.llm as any)[key]) === nextValue) return;
    batch(() => {
      (state.llm as any)[key] = nextValue;
      if (Object.prototype.hasOwnProperty.call(untracked(llmSecretFields), key)) {
        llmSecretDirty.update((set) => new Set(set).add(key));
      }
    });
  }

  function updateProfileField(profileKey: string, { field, value }: { field: string; value: unknown }) {
    if (untracked(agentSettingsReadOnly)) return;
    const profile = untracked(() => state.llm.profiles.find((item) => item._key === profileKey));
    const key = String(field || "").trim();
    if (!profile || !key || !Object.prototype.hasOwnProperty.call(profile, key)) return;
    const nextValue = String(value || "");
    if (untracked(() => (profile as any)[key]) === nextValue) return;
    batch(() => {
      (profile as any)[key] = nextValue;
      if (Object.prototype.hasOwnProperty.call(untracked(() => llmProfileSecretFields(profile)), key)) {
        profile._secretDirty = new Set(untracked(() => profile._secretDirty)).add(key);
      }
    });
  }

  // The Add Profile dialog, shared by Models and Model Routes. The new profile lives in the list as
  // a draft (so the form, model picker and sign-in dialogs work by its key) but stays out of the
  // list, the save bar and route choices until Create saves it; Cancel removes it.
  const addProfileKey = signal("");
  const addProfileDraft = computed(() => state.llm.profiles.find((item) => item._key === addProfileKey() && item._draft) || null);
  const addProfileOpen = computed(() => Boolean(addProfileDraft()));
  const addProfileError = computed(() => {
    const draft = addProfileDraft();
    return draft && trimText(draft.name) ? profileValidationError(draft) : "";
  });
  const addProfileSaving = computed(() => Boolean(addProfileDraft()) && agentSavingTarget() === `profile:${addProfileDraft()!._key}`);
  const addProfileSaveDisabled = computed(() => {
    const draft = addProfileDraft();
    return !draft || !trimText(draft.name) || profileSaveDisabled(draft);
  });

  function openAddProfileDialog() {
    if (untracked(agentSettingsReadOnly) || untracked(agentLoading) || untracked(addProfileDraft)) return;
    const profile = buildLLMProfileState();
    profile._draft = true;
    batch(() => {
      state.llm.profiles = [...untracked(() => state.llm.profiles), profile];
      addProfileKey.set(profile._key);
    });
  }

  function cancelAddProfile() {
    const key = untracked(addProfileKey);
    batch(() => {
      state.llm.profiles = untracked(() => state.llm.profiles).filter((item) => !(item._key === key && item._draft));
      addProfileKey.set("");
    });
  }

  async function createProfile() {
    const draft = untracked(addProfileDraft);
    if (!draft) return;
    if (await saveLLMProfile(draft._key)) {
      batch(() => {
        draft._draft = false;
        addProfileKey.set("");
      });
    }
  }

  function confirmRemoveLLMProfile(profileKey: string) {
    if (untracked(agentSettingsReadOnly)) return;
    const key = String(profileKey || "").trim();
    batch(() => {
      deleteProfileTargetKey.set(key);
      deleteProfileDialogOpen.set(key !== "");
    });
  }

  function closeDeleteProfileDialog() {
    batch(() => {
      deleteProfileDialogOpen.set(false);
      deleteProfileTargetKey.set("");
    });
  }

  function removeLLMProfile(profileKey: string) {
    if (untracked(agentSettingsReadOnly)) return;
    const profiles = untracked(() => state.llm.profiles);
    const removed = profiles.find((item) => item._key === profileKey);
    if (!removed) return;
    const removedNames = new Set(
      [untracked(() => trimText(removed.name)), untracked(() => trimText(removed._savedName))].filter(Boolean).map((name) => name.toLowerCase()),
    );
    batch(() => {
      state.llm.profiles = profiles.filter((item) => item._key !== profileKey);
      state.llm.fallback_profiles = untracked(() => state.llm.fallback_profiles).filter((item) => {
        const name = trimText(item);
        return name !== "" && !removedNames.has(name.toLowerCase());
      });
    });
  }

  async function deleteLLMProfile() {
    const profileKey = untracked(deleteProfileTargetKey);
    const profile = untracked(() => state.llm.profiles.find((item) => item._key === profileKey)) || null;
    closeDeleteProfileDialog();
    if (!profile) return;
    const savedName = untracked(() => trimText(profile._savedName));
    if (!savedName) {
      removeLLMProfile(profileKey);
      return;
    }
    if (untracked(agentLoading) || untracked(agentSaving) || untracked(agentSettingsReadOnly)) return;
    batch(() => {
      agentSaving.set(true);
      agentSavingTarget.set(`profile:${profileKey}`);
    });
    const target = currentRef();
    try {
      const payload: any = await endpointApiFetch(target, "/settings/agent", {
        method: "PUT",
        body: { config_revision: untracked(settingsConfigRevision), llm: { delete_profile: savedName } },
      });
      if (target !== currentRef()) return;
      batch(() => {
        if (typeof payload?.config_path === "string") llmConfigPath.set(payload.config_path);
        settingsConfigRevision.set(trimText(payload?.config_revision) || untracked(settingsConfigRevision));
        if (untracked(openProfileKey) === profileKey) openProfileKey.set("");
        removeLLMProfile(profileKey);
        updateLoadedFallbackProfile(savedName, "");
      });
      if (target === LOCAL_CONSOLE_ENDPOINT_REF) invalidateConsoleSetupReadiness();
      await loadEndpoints();
      notice.success(t("msg_delete_success"));
    } catch (e) {
      notice.error(agentSettingsErrorMessage(e, target, "msg_delete_failed"));
    } finally {
      batch(() => {
        agentSaving.set(false);
        agentSavingTarget.set("");
      });
    }
  }

  function addFallbackProfile() {
    if (untracked(agentSettingsReadOnly)) return;
    const firstProfile = untracked(profileOptions)[0]?.value || "";
    if (!firstProfile) return;
    state.llm.fallback_profiles = [...untracked(() => state.llm.fallback_profiles), firstProfile];
  }

  function updateFallbackProfile(index: number, value: string) {
    if (untracked(agentSettingsReadOnly)) return;
    const items = [...untracked(() => state.llm.fallback_profiles)];
    if (index < 0 || index >= items.length) return;
    items[index] = trimText(value);
    state.llm.fallback_profiles = items;
  }

  function removeFallbackProfile(index: number) {
    if (untracked(agentSettingsReadOnly)) return;
    const items = [...untracked(() => state.llm.fallback_profiles)];
    if (index < 0 || index >= items.length) return;
    items.splice(index, 1);
    state.llm.fallback_profiles = items;
  }

  function moveFallbackProfile(index: number, delta: number) {
    if (untracked(agentSettingsReadOnly)) return;
    const items = [...untracked(() => state.llm.fallback_profiles)];
    const nextIndex = index + delta;
    if (index < 0 || index >= items.length || nextIndex < 0 || nextIndex >= items.length) return;
    const [current] = items.splice(index, 1);
    items.splice(nextIndex, 0, current);
    state.llm.fallback_profiles = items;
  }

  /* --- agent: payloads --- */

  function buildProfilePayload(profile: any) {
    const envManaged = llmProfileEnvManaged(profile);
    const provider = profileProviderChoice(profile);
    const inferenceProviderRaw = llmFieldEnvRawValue(envManaged, "inference_provider");
    const providerRaw = llmFieldEnvRawValue(envManaged, "provider");
    const secretFields = llmProfileSecretFields(profile);
    const secretDirty: Set<string> = profile._secretDirty || new Set();
    const payload: Record<string, any> = {
      name: trimText(profile.name),
      description: trimText(profile.description),
      // TypeSafe profiles have only the decision ability.
      abilities: setupProviderEvaluateOnly(provider) ? ["decision"] : splitAbilities(profile.abilities),
      inference_provider: providerRaw === "" ? inferenceProviderRaw || trimText(profile.inference_provider) : inferenceProviderRaw,
      provider: providerRaw,
      endpoint: setupProviderSupportsCustomAPIBase(provider) ? llmFieldEnvRawValue(envManaged, "endpoint") || trimText(profile.endpoint) : "",
      model: llmFieldEnvRawValue(envManaged, "model") || trimText(profile.model),
      context_window_tokens: llmFieldEnvRawValue(envManaged, "context_window_tokens") || trimText(profile.context_window_tokens),
      supports_image_parts: trimText(profile.supports_image_parts),
      headers: JSON.parse(profile.headers_text || "{}"),
      cache_ttl: trimText(profile.cache_ttl),
      cache_key_prefix: trimText(profile.cache_key_prefix),
      request_timeout: trimText(profile.request_timeout),
      temperature: trimText(profile.temperature),
      reasoning_budget_tokens: trimText(profile.reasoning_budget_tokens),
      azure_deployment: trimText(profile.azure_deployment),
      reasoning_effort: llmFieldEnvRawValue(envManaged, "reasoning_effort") || trimText(profile.reasoning_effort),
      tools_emulation_mode: llmFieldEnvRawValue(envManaged, "tools_emulation_mode") || trimText(profile.tools_emulation_mode),
    };
    const secret = (field: string) =>
      pickedReference(llmFieldEnvRawValue(envManaged, field), profile[field]) ||
      includeSecretValue(profile[field], secretFields, secretDirty, field);
    const clear = (...fields: string[]) => {
      for (const field of fields) payload[field] = "";
    };
    if (provider === SETUP_PROVIDER_CLOUDFLARE) {
      payload.cloudflare_api_token = secret("cloudflare_api_token");
      payload.cloudflare_account_id = llmFieldEnvRawValue(envManaged, "cloudflare_account_id") || trimText(profile.cloudflare_account_id);
      clear("api_key", "bedrock_aws_key", "bedrock_aws_secret", "bedrock_aws_session_token", "bedrock_aws_profile", "bedrock_region", "bedrock_model_arn");
    } else if (provider === SETUP_PROVIDER_BEDROCK) {
      payload.bedrock_aws_key = secret("bedrock_aws_key");
      payload.bedrock_aws_secret = secret("bedrock_aws_secret");
      payload.bedrock_aws_session_token = secret("bedrock_aws_session_token");
      payload.bedrock_aws_profile = trimText(profile.bedrock_aws_profile);
      payload.bedrock_region = llmFieldEnvRawValue(envManaged, "bedrock_region") || trimText(profile.bedrock_region);
      payload.bedrock_model_arn = llmFieldEnvRawValue(envManaged, "bedrock_model_arn") || trimText(profile.bedrock_model_arn);
      clear("api_key", "cloudflare_api_token", "cloudflare_account_id");
    } else if (provider === SETUP_PROVIDER_OPENAI_CODEX) {
      payload.api_key = secret("api_key");
      clear(
        "cloudflare_api_token",
        "cloudflare_account_id",
        "bedrock_aws_key",
        "bedrock_aws_secret",
        "bedrock_aws_session_token",
        "bedrock_aws_profile",
        "bedrock_region",
        "bedrock_model_arn",
      );
    } else if (provider === SETUP_PROVIDER_XAI_OAUTH || provider === SETUP_PROVIDER_MISTERMORPH_PRO) {
      clear(
        "api_key",
        "cloudflare_api_token",
        "cloudflare_account_id",
        "bedrock_aws_key",
        "bedrock_aws_secret",
        "bedrock_aws_session_token",
        "bedrock_aws_profile",
        "bedrock_region",
        "bedrock_model_arn",
      );
    } else {
      payload.api_key = secret("api_key");
      clear(
        "bedrock_aws_key",
        "bedrock_aws_secret",
        "bedrock_aws_session_token",
        "bedrock_aws_profile",
        "bedrock_region",
        "bedrock_model_arn",
        "cloudflare_api_token",
        "cloudflare_account_id",
      );
    }
    return payload;
  }

  function buildDefaultLLMTestPayload() {
    const env = untracked(llmEnvManaged);
    const llm: any = state.llm;
    const payload: Record<string, any> = {};
    const provider = normalizeSetupProviderChoice(llmFieldValue(llm, env, "inference_provider") || llmFieldValue(llm, env, "provider"), {
      allowEmpty: true,
    });
    const inferenceProviderRaw = llmFieldEnvRawValue(env, "inference_provider");
    const providerRaw = llmFieldEnvRawValue(env, "provider");
    if (inferenceProviderRaw !== "") payload.inference_provider = inferenceProviderRaw;
    else if (providerRaw !== "") payload.provider = providerRaw;
    else if (!isLLMFieldEnvManaged(env, "inference_provider") && provider !== "") payload.inference_provider = llm.inference_provider;
    const endpointRaw = llmFieldEnvRawValue(env, "endpoint");
    if (endpointRaw !== "") payload.endpoint = endpointRaw;
    else if (!setupProviderSupportsCustomAPIBase(provider)) payload.endpoint = "";
    else if (!isLLMFieldEnvManaged(env, "endpoint")) {
      const endpoint = trimText(llm.endpoint);
      if (endpoint !== "") payload.endpoint = endpoint;
    }
    // A field set by the environment sends its raw value; one in config sends the draft.
    const plain = (field: string) => {
      const raw = llmFieldEnvRawValue(env, field);
      if (raw !== "") payload[field] = raw;
      else if (!isLLMFieldEnvManaged(env, field)) {
        const value = trimText(llm[field]);
        if (value !== "") payload[field] = value;
      }
    };
    const secret = (field: string) => {
      const raw = pickedReference(llmFieldEnvRawValue(env, field), llm[field]);
      if (raw !== "") payload[field] = raw;
      else if (!isLLMFieldEnvManaged(env, field)) {
        const value = trimText(llm[field]);
        if (value !== "") payload[field] = value;
      }
    };
    plain("model");
    plain("context_window_tokens");
    plain("reasoning_effort");
    plain("tools_emulation_mode");
    const clear = (...fields: string[]) => {
      for (const field of fields) payload[field] = "";
    };
    if (provider === SETUP_PROVIDER_BEDROCK) {
      secret("bedrock_aws_key");
      secret("bedrock_aws_secret");
      plain("bedrock_region");
      plain("bedrock_model_arn");
    } else if (provider === SETUP_PROVIDER_CLOUDFLARE) {
      secret("cloudflare_api_token");
      plain("cloudflare_account_id");
    } else if (provider === SETUP_PROVIDER_OPENAI_CODEX) {
      secret("api_key");
      clear("cloudflare_api_token", "cloudflare_account_id", "bedrock_aws_key", "bedrock_aws_secret", "bedrock_region", "bedrock_model_arn");
    } else if (provider === SETUP_PROVIDER_XAI_OAUTH || provider === SETUP_PROVIDER_MISTERMORPH_PRO) {
      clear("api_key", "cloudflare_api_token", "cloudflare_account_id", "bedrock_aws_key", "bedrock_aws_secret", "bedrock_region", "bedrock_model_arn");
    } else {
      secret("api_key");
    }
    return payload;
  }

  function buildLLMSettingsPayload() {
    const env = untracked(llmEnvManaged);
    const secretFields = untracked(llmSecretFields);
    const secretDirty = untracked(llmSecretDirty);
    const llm: any = state.llm;
    const payload: Record<string, any> = {};
    const provider = normalizeSetupProviderChoice(llmFieldValue(llm, env, "inference_provider") || llmFieldValue(llm, env, "provider"), {
      allowEmpty: true,
    });
    const inferenceProviderRaw = llmFieldEnvRawValue(env, "inference_provider");
    const providerRaw = llmFieldEnvRawValue(env, "provider");
    if (inferenceProviderRaw !== "") payload.inference_provider = inferenceProviderRaw;
    else if (providerRaw !== "") payload.provider = providerRaw;
    else if (!isLLMFieldEnvManaged(env, "inference_provider")) payload.inference_provider = llm.inference_provider;
    if (!isLLMFieldEnvManaged(env, "endpoint")) {
      payload.endpoint = setupProviderSupportsCustomAPIBase(provider) ? trimText(llm.endpoint) : "";
    }
    if (!isLLMFieldEnvManaged(env, "model")) payload.model = trimText(llm.model);
    payload.description = trimText(llm.description);
    payload.abilities = splitAbilities(llm.abilities);
    const secret = (field: string) => {
      if (!isLLMFieldEnvManaged(env, field) || isSecretReference(llm[field])) {
        payload[field] = includeSecretValue(llm[field], secretFields, secretDirty, field);
      }
    };
    const plain = (field: string) => {
      if (!isLLMFieldEnvManaged(env, field)) payload[field] = trimText(llm[field]);
    };
    const clear = (...fields: string[]) => {
      for (const field of fields) payload[field] = "";
    };
    if (provider === SETUP_PROVIDER_BEDROCK) {
      secret("bedrock_aws_key");
      secret("bedrock_aws_secret");
      plain("bedrock_region");
      plain("bedrock_model_arn");
    } else if (provider === SETUP_PROVIDER_CLOUDFLARE) {
      secret("cloudflare_api_token");
      plain("cloudflare_account_id");
    } else if (provider === SETUP_PROVIDER_OPENAI_CODEX) {
      secret("api_key");
      clear("cloudflare_api_token", "cloudflare_account_id", "bedrock_aws_key", "bedrock_aws_secret", "bedrock_region", "bedrock_model_arn");
    } else if (provider === SETUP_PROVIDER_XAI_OAUTH || provider === SETUP_PROVIDER_MISTERMORPH_PRO) {
      clear("api_key", "cloudflare_api_token", "cloudflare_account_id", "bedrock_aws_key", "bedrock_aws_secret", "bedrock_region", "bedrock_model_arn");
    } else {
      secret("api_key");
    }
    payload.fallback_profiles = normalizeNamedList(llm.fallback_profiles);
    return payload;
  }

  function buildSavePayload(target = "all") {
    const tools = Object.fromEntries(Object.keys(DEFAULT_TOOLS).map((id) => [id, { enabled: !!state.tools[id] }]));
    if (target === "llm") return { llm: buildLLMSettingsPayload() };
    if (target === "tools") return { tools };
    const mcp = { servers: state.mcp.servers.map(serializeMCPServer) };
    if (target === "mcp") return { mcp };
    return { llm: buildLLMSettingsPayload(), tools, mcp };
  }

  function buildProfileTestPayload(profile: any) {
    return { profiles: [{ ...buildProfilePayload(profile), name: trimText(profile._savedName) || trimText(profile.name) }] };
  }

  function profileUsesCodexProvider(profile: any) {
    return profileProviderChoice(profile) === SETUP_PROVIDER_OPENAI_CODEX;
  }
  function profileCodexAuthDisabled(profile: any) {
    const envManaged = llmProfileEnvManaged(profile);
    return (
      trimText(llmFieldValue(profile, envManaged, "endpoint")) !== "" &&
      hasLLMFieldOrSecretValue(profile, envManaged, llmProfileSecretFields(profile), "api_key")
    );
  }
  function profileUsesXAIProvider(profile: any) {
    return selectedEndpointIsConsole() && profileProviderChoice(profile) === SETUP_PROVIDER_XAI_OAUTH;
  }
  function profileUsesProProvider(profile: any) {
    return selectedEndpointIsConsole() && profileProviderChoice(profile) === SETUP_PROVIDER_MISTERMORPH_PRO;
  }
  function hasResolvableProfileTestTarget(profile: any) {
    const name = trimText(profile?.name);
    if (name === "" || name.toLowerCase() === "default") return false;
    return state.llm.profiles.filter((item) => trimText(item?.name).toLowerCase() === name.toLowerCase()).length === 1;
  }
  function profileModelLookupCredentialsReady(profile: any) {
    const provider = profileProviderChoice(profile);
    const envManaged = llmProfileEnvManaged(profile);
    if (provider === SETUP_PROVIDER_MISTERMORPH_PRO) return !selectedEndpointIsConsole() || proLoggedIn();
    if (provider === SETUP_PROVIDER_OPENAI_CODEX) return profileUsesCodexAPIKey(profile) || codexLoggedIn();
    if (provider === SETUP_PROVIDER_XAI_OAUTH) return !selectedEndpointIsConsole() || xaiReady();
    if (provider === SETUP_PROVIDER_CLOUDFLARE) {
      return (
        hasLLMFieldOrSecretValue(profile, envManaged, llmProfileSecretFields(profile), "cloudflare_api_token") &&
        hasLLMFieldValue(profile, envManaged, "cloudflare_account_id")
      );
    }
    if (!setupProviderRequiresAPIKey(provider)) return true;
    return hasLLMFieldOrSecretValue(profile, envManaged, llmProfileSecretFields(profile), "api_key");
  }
  function testConnectionDisabledForProfile(profile: any) {
    const provider = profileProviderChoice(profile);
    const envManaged = llmProfileEnvManaged(profile);
    const secrets = llmProfileSecretFields(profile);
    if (testConnectionLoading() || agentLoading() || agentSaving()) return true;
    if (!hasResolvableProfileTestTarget(profile) || provider === "") return true;
    if (!hasLLMFieldValue(profile, envManaged, "model")) return true;
    if (provider === SETUP_PROVIDER_OPENAI_CODEX) return !profileUsesCodexAPIKey(profile) && !codexLoggedIn();
    if (provider === SETUP_PROVIDER_XAI_OAUTH) return selectedEndpointIsConsole() && !xaiReady();
    if (provider === SETUP_PROVIDER_MISTERMORPH_PRO) return selectedEndpointIsConsole() && !proLoggedIn();
    if (provider === SETUP_PROVIDER_BEDROCK) {
      return (
        !hasLLMFieldOrSecretValue(profile, envManaged, secrets, "bedrock_aws_key") ||
        !hasLLMFieldOrSecretValue(profile, envManaged, secrets, "bedrock_aws_secret") ||
        !hasLLMFieldValue(profile, envManaged, "bedrock_region")
      );
    }
    if (provider === SETUP_PROVIDER_CLOUDFLARE) {
      return (
        !hasLLMFieldOrSecretValue(profile, envManaged, secrets, "cloudflare_api_token") ||
        !hasLLMFieldValue(profile, envManaged, "cloudflare_account_id")
      );
    }
    return setupProviderRequiresAPIKey(provider) && !hasLLMFieldOrSecretValue(profile, envManaged, secrets, "api_key");
  }

  /* --- advanced settings dialog --- */

  function openConfigAdvancedSettings(name: string, scope: string, groups: any[]) {
    batch(() => {
      advancedSettingsTitle.set(`${name} · ${t("settings_advanced_action")}`);
      advancedSettingsScope.set(scope);
      advancedSettingsGroups.set(groups);
      advancedSettingsDirty.set(false);
      advancedSettingsOpen.set(true);
    });
  }
  function openDefaultLLMAdvancedSettings() {
    openConfigAdvancedSettings(t("settings_agent_default_profile_label"), "agent", DEFAULT_MODEL_ADVANCED_CONFIG_GROUPS as any[]);
  }
  function openContextAdvancedSettings() {
    openConfigAdvancedSettings("Context compaction", "agent", LLM_CONTEXT_CONFIG_GROUPS as any[]);
  }
  function openToolAdvancedSettings(item: ToolItem | undefined) {
    const groups = item ? (TOOL_ADVANCED_CONFIG_GROUPS as Record<string, any[]>)[item.id] : null;
    if (!groups || !item) return;
    openConfigAdvancedSettings(t(item.titleKey), "agent", groups);
  }
  function openChannelAdvancedSettings(channel: string) {
    const group = (CHANNEL_CONFIG_GROUPS as any[]).find((item) => item.id === channel);
    if (!group) return;
    openConfigAdvancedSettings(String(group.title).replace(/ behavior$/, ""), "console", [group]);
  }
  function closeAdvancedSettings() {
    batch(() => {
      advancedSettingsOpen.set(false);
      advancedSettingsGroups.set([]);
      advancedSettingsDirty.set(false);
    });
  }
  const advancedSettingsValues = computed(() => (advancedSettingsScope() === "console" ? consoleConfigValues() : agentConfigValues()));
  const advancedSettingsFieldStates = computed(() => (advancedSettingsScope() === "console" ? consoleFieldStates() : agentFieldStates()));
  const advancedSettingsLoading = computed(() => (advancedSettingsScope() === "console" ? consoleLoading() : agentLoading()));
  const advancedSettingsSaving = computed(() =>
    advancedSettingsScope() === "console"
      ? consoleSaving() && consoleSavingTarget() === "config"
      : agentSaving() && agentSavingTarget() === "config",
  );
  const advancedSettingsSaveDisabled = computed(() => advancedSettingsLoading() || advancedSettingsSaving() || !advancedSettingsDirty());

  async function saveAdvancedConfigSettings(update: ConfigUpdate) {
    // This tri-state field belongs to the LLM API, not the generic config schema.
    const imagePartsPath = "llm.supports_image_parts";
    const scope = untracked(advancedSettingsScope);
    let next = { config_changes: { ...(update?.config_changes || {}) }, reset: [...(update?.reset || [])] } as ConfigUpdate;
    if (scope === "agent" && (Object.prototype.hasOwnProperty.call(next.config_changes, imagePartsPath) || next.reset.includes(imagePartsPath))) {
      const { [imagePartsPath]: imageParts, ...changes } = next.config_changes;
      next = {
        ...next,
        config_changes: changes,
        reset: next.reset.filter((path) => path !== imagePartsPath),
        llm: { supports_image_parts: update.reset?.includes(imagePartsPath) ? "" : imageParts },
      };
    }
    if (await saveConfigSettings(scope, next)) closeAdvancedSettings();
  }
  function registerAdvancedPanelSave(save: (() => void) | null) {
    advancedPanelSave = save;
  }
  function saveAdvancedSettings() {
    advancedPanelSave?.();
  }

  // The default model's "···" menu. A profile's actions are in its panel.
  const llmActionMenuItems = computed(() => [
    {
      id: "advanced",
      label: t("settings_advanced_action"),
      disabled: agentLoading() || agentSaving(),
      onSelect: () => openDefaultLLMAdvancedSettings(),
    },
    { id: "context", label: "Context compaction", disabled: agentLoading() || agentSaving(), onSelect: () => openContextAdvancedSettings() },
    { id: "benchmark", label: t("setup_llm_test_button"), disabled: testConnectionDisabled(), onSelect: () => void openTestConnection() },
  ]);
  function channelActionMenuItems(channel: string) {
    return [
      {
        id: "advanced",
        label: t("settings_advanced_action"),
        disabled: consoleLoading() || consoleSaving(),
        onSelect: () => openChannelAdvancedSettings(channel),
      },
    ];
  }

  /* --- connection test --- */

  function primeConnectionTestState(targetProfile: any, nextPayload: any = null) {
    const payload = nextPayload || (targetProfile ? buildProfileTestPayload(targetProfile) : buildDefaultLLMTestPayload());
    const env = untracked(llmEnvManaged);
    const profileEnvManaged = targetProfile ? llmProfileEnvManaged(targetProfile) : null;
    const targetProviderChoice = targetProfile
      ? profileProviderChoice(targetProfile)
      : normalizeSetupProviderChoice(llmFieldValue(state.llm, env, "inference_provider") || llmFieldValue(state.llm, env, "provider"), {
          allowEmpty: true,
        });
    const targetEndpoint = targetProfile ? llmFieldValue(targetProfile, profileEnvManaged, "endpoint") : llmFieldValue(state.llm, env, "endpoint");
    const targetModel = targetProfile ? llmFieldValue(targetProfile, profileEnvManaged, "model") : llmFieldValue(state.llm, env, "model");
    batch(() => {
      testConnectionError.set("");
      testConnectionBenchmarks.set([]);
      testConnectionMeta.provider = targetProviderChoice;
      testConnectionMeta.evaluateOnly = targetProfile
        ? setupProfileDecisionOnly(targetProviderChoice, targetProfile.abilities)
        : setupProviderEvaluateOnly(targetProviderChoice);
      // The main model's test sends no abilities, so it runs as a chat model.
      testConnectionMeta.benchmarkIds = setupProfileBenchmarkIds(targetProviderChoice, targetProfile ? targetProfile.abilities : "");
      testConnectionMeta.apiBase = trimText(targetEndpoint);
      testConnectionMeta.model = trimText(targetModel) || String(payload.model || "").trim();
    });
    return payload;
  }

  async function openTestConnection(profileKey = "") {
    const targetProfile = untracked(() => state.llm.profiles.find((item) => item._key === profileKey)) || null;
    if (!targetProfile && untracked(testConnectionDisabled)) return;
    if (targetProfile && untracked(() => testConnectionDisabledForProfile(targetProfile))) return;
    testConnectionTargetProfileKey.set(targetProfile?._key || "");
    untracked(() => primeConnectionTestState(targetProfile));
    await openReentrantDialog(testConnectionOpen);
    await runConnectionTest();
  }

  async function runConnectionTest() {
    if (untracked(testConnectionLoading)) return;
    const targetProfile = untracked(currentTestTargetProfile);
    const targetProfileName = untracked(() => trimText(targetProfile?.name));
    if (untracked(testConnectionTargetProfileKey) !== "" && targetProfileName === "") {
      testConnectionError.set(t("settings_agent_profile_name_required"));
      return;
    }
    const nextPayload = untracked(() =>
      primeConnectionTestState(targetProfile, targetProfile ? buildProfileTestPayload(targetProfile) : buildDefaultLLMTestPayload()),
    );
    const shouldReloadCodexAuthStatus = untracked(() =>
      targetProfile
        ? profileUsesCodexProvider(targetProfile) && !profileUsesCodexAPIKey(targetProfile)
        : defaultIsCodexProvider() && !defaultCodexUsesAPIKey(),
    );
    const target = currentRef();
    testConnectionLoading.set(true);
    try {
      const body: Record<string, any> = { llm: nextPayload };
      if (targetProfileName !== "") body.target_profile = untracked(() => trimText(targetProfile!._savedName)) || targetProfileName;
      const payload: any = await endpointApiFetch(target, "/settings/agent/test", { method: "POST", body });
      batch(() => {
        testConnectionMeta.provider = String(payload?.provider || "").trim();
        const resolvedAPIBase = String(payload?.api_base || "").trim();
        if (resolvedAPIBase !== "") testConnectionMeta.apiBase = resolvedAPIBase;
        testConnectionMeta.model = String(payload?.model || "").trim();
        const items = Array.isArray(payload?.benchmarks) ? payload.benchmarks : [];
        testConnectionBenchmarks.set(
          items.map((item: any) => ({
            id: String(item?.id || "").trim(),
            ok: item?.ok === true,
            duration_ms: Number(item?.duration_ms || 0),
            detail: String(item?.detail || "").trim(),
            error: String(item?.error || "").trim(),
            raw_response: String(item?.raw_response || ""),
          })),
        );
      });
    } catch (e) {
      testConnectionError.set(agentSettingsErrorMessage(e, target, "msg_load_failed"));
    } finally {
      testConnectionLoading.set(false);
      if (shouldReloadCodexAuthStatus) void codexAuth.loadStatus(target);
    }
  }

  /* --- pickers --- */

  function openAPIBasePicker() {
    if (untracked(agentLoading) || untracked(agentSaving) || untracked(agentSettingsReadOnly)) return;
    apiBasePickerOpen.set(true);
  }
  function applyAPIBaseOption(item: { value?: string } | null) {
    if (untracked(agentSettingsReadOnly)) return;
    const nextEndpoint = String(item?.value || "").trim();
    if (untracked(() => state.llm.endpoint) === nextEndpoint) return;
    state.llm.endpoint = nextEndpoint;
  }

  async function openModelPicker(profileKey = "") {
    if (untracked(agentLoading) || untracked(agentSaving) || untracked(agentSettingsReadOnly)) return;
    const normalizedProfileKey = String(profileKey || "").trim();
    const targetProfile = normalizedProfileKey
      ? untracked(() => state.llm.profiles.find((profile) => profile._key === normalizedProfileKey)) || null
      : null;
    if (normalizedProfileKey && !targetProfile) return;
    if (targetProfile && !untracked(() => profileModelLookupCredentialsReady(targetProfile))) return;
    batch(() => {
      modelPickerTargetProfileKey.set(targetProfile?._key || "");
      modelPickerOpen.set(true);
      modelPickerLoading.set(true);
      modelPickerError.set("");
      modelPickerItems.set([]);
    });
    const target = currentRef();
    const body = untracked(() => {
      const env = llmEnvManaged();
      const targetEnv = targetProfile ? llmProfileEnvManaged(targetProfile) : null;
      const provider = targetProfile
        ? profileProviderChoice(targetProfile)
        : llmFieldValue(state.llm, env, "inference_provider") || llmFieldValue(state.llm, env, "provider");
      const providerChoice = normalizeSetupProviderChoice(provider, { allowEmpty: true });
      const endpoint = targetProfile ? llmFieldValue(targetProfile, targetEnv, "endpoint") : llmFieldValue(state.llm, env, "endpoint");
      const credentialField = providerChoice === SETUP_PROVIDER_CLOUDFLARE ? "cloudflare_api_token" : "api_key";
      const apiKey = targetProfile ? llmFieldValue(targetProfile, targetEnv, credentialField) : llmFieldValue(state.llm, env, credentialField);
      const apiKeyRaw = targetProfile ? llmFieldEnvRawValue(targetEnv, credentialField) : llmFieldEnvRawValue(env, credentialField);
      return {
        target_profile: targetProfile ? trimText(targetProfile._savedName) || trimText(targetProfile.name) : "",
        inference_provider: providerChoice,
        cloudflare_account_id:
          providerChoice === SETUP_PROVIDER_CLOUDFLARE
            ? llmFieldValue(targetProfile || state.llm, targetEnv || env, "cloudflare_account_id")
            : "",
        endpoint: setupProviderSupportsCustomAPIBase(providerChoice) ? endpoint : "",
        api_key: providerChoice === SETUP_PROVIDER_MISTERMORPH_PRO ? "" : apiKeyRaw || apiKey,
      };
    });
    try {
      const payload = await endpointApiFetch(target, "/settings/agent/models", { method: "POST", body });
      modelPickerItems.set(modelPickerItemsFromPayload(payload, currentLocale()));
    } catch (e) {
      modelPickerError.set(agentSettingsErrorMessage(e, target, "msg_load_failed"));
    } finally {
      modelPickerLoading.set(false);
    }
  }

  function applyModelOption(item: { value?: string } | null) {
    if (untracked(agentSettingsReadOnly)) return;
    const nextModel = String(item?.value || "").trim();
    const targetProfile = untracked(() => state.llm.profiles.find((profile) => profile._key === modelPickerTargetProfileKey())) || null;
    if (targetProfile) {
      updateProfileField(targetProfile._key, { field: "model", value: nextModel });
      return;
    }
    if (untracked(() => state.llm.model) === nextModel) return;
    state.llm.model = nextModel;
  }

  /* --- tools --- */

  let toolSchemaCatalog: any = null;
  const toolSchemaPreview = reactiveRecord({ open: false, title: "", json: "" });
  async function showToolSchema(title: string, pick: (catalog: any) => unknown) {
    batch(() => {
      toolSchemaPreview.title = title;
      toolSchemaPreview.json = "";
      toolSchemaPreview.open = true;
    });
    try {
      if (!toolSchemaCatalog) toolSchemaCatalog = await apiFetch("/settings/tools/schemas");
      const value = pick(toolSchemaCatalog);
      toolSchemaPreview.json = value ? JSON.stringify(value, null, 2) : t("settings_tool_schema_missing");
    } catch (err: any) {
      toolSchemaPreview.json = String(err?.message || err || "");
    }
  }
  function previewToolSchema(item: ToolItem) {
    return showToolSchema(item.id, (catalog) => catalog?.tools?.[item.id]);
  }
  function previewChannelToolSchema(channel: { id: string; title: string }, row: { id: string }) {
    return showToolSchema(`${row.id} · ${channel.title}`, (catalog) =>
      (catalog?.channels?.[channel.id] || []).find((tool: any) => tool.name === row.id),
    );
  }
  function setToolEnabled(id: string, value: boolean) {
    if (untracked(agentSettingsReadOnly)) return;
    if (!Object.prototype.hasOwnProperty.call(state.tools, id)) return;
    state.tools[id] = !!value;
  }

  /* --- MCP --- */

  async function saveMCPServers(servers: any[]) {
    if (untracked(agentSettingsReadOnly)) return;
    state.mcp.servers = Array.isArray(servers) ? servers : [];
    await saveAgentSettings("mcp");
  }

  /* --- console: load, apply, reset --- */

  // Console scopes that keep their own draft in `state`. A save response rewrites all of them, so
  // edits in scopes that were not part of the save are captured first and put back afterwards.
  const CONSOLE_DRAFT_SCOPES = [
    { id: "runtimes", slice: () => state.managedRuntimes },
    { id: "telegram", slice: () => state.telegram },
    { id: "slack", slice: () => state.slack },
    { id: "line", slice: () => state.line },
    { id: "lark", slice: () => state.lark },
    { id: "mixin", slice: () => state.mixin },
    { id: "discord", slice: () => state.discord },
    { id: "whatsapp", slice: () => state.whatsapp },
    { id: "bluesky", slice: () => state.bluesky },
    { id: "x", slice: () => state.x },
    { id: "guard", slice: () => state.guard },
  ].map((scope) => ({ ...scope, dirty: () => untracked(consoleDirtyOf[scope.id]), sync: () => {} }));

  // savedScopes: omit for a fresh load (everything is replaced); pass the scopes a save covered to
  // keep unsaved edits in every other scope.
  function applyConsolePayload(data: any, { savedScopes = null as string[] | null } = {}) {
    const secretKeys = new Set(untracked(consoleSecretDirty));
    const unsaved = Array.isArray(savedScopes) ? captureUnsavedScopes(CONSOLE_DRAFT_SCOPES, savedScopes, secretKeys as any) : [];
    const values = Array.isArray(data?.managed_runtimes) ? data.managed_runtimes : [];
    const telegram = obj(data?.telegram);
    const slack = obj(data?.slack);
    const line = obj(data?.line);
    const lark = obj(data?.lark);
    const mixin = obj(data?.mixin);
    const discord = obj(data?.discord);
    const wechat = obj(data?.wechat);
    const whatsapp = obj(data?.whatsapp);
    const bluesky = obj(data?.bluesky);
    const x = obj(data?.x);
    const guard = obj(data?.guard);
    const guardURLFetch = obj(obj(guard.network).url_fetch);
    const guardRedaction = obj(guard.redaction);
    const guardApprovals = obj(guard.approvals);
    batch(() => {
      consoleEnvManaged.set(obj(data?.env_managed));
      consoleSecretFields.set(obj(data?.secret_fields));
      if (typeof data?.config_revision === "string") settingsConfigRevision.set(data.config_revision);
      consoleConfigValues.set(obj(data?.config_values));
      consoleFieldStates.set(obj(data?.field_states));
      consoleEndpoints.set(Array.isArray(data?.endpoints) ? data.endpoints : []);
      authProfiles.set(Array.isArray(data?.auth_profiles) ? data.auth_profiles : []);
      for (const item of MANAGED_RUNTIME_ITEMS) state.managedRuntimes[item.id] = values.includes(item.id);
      state.telegram.bot_token = str(telegram.bot_token);
      state.telegram.allowed_chat_ids_text = formatConfigList(telegram.allowed_chat_ids);
      state.telegram.group_trigger_mode = normalizeConsoleGroupTriggerMode(telegram.group_trigger_mode);
      state.slack.bot_token = str(slack.bot_token);
      state.slack.app_token = str(slack.app_token);
      state.slack.allowed_team_ids_text = formatConfigList(slack.allowed_team_ids);
      state.slack.allowed_channel_ids_text = formatConfigList(slack.allowed_channel_ids);
      state.slack.group_trigger_mode = normalizeConsoleGroupTriggerMode(slack.group_trigger_mode);
      state.line.channel_access_token = str(line.channel_access_token);
      state.line.channel_secret = str(line.channel_secret);
      state.line.allowed_group_ids_text = formatConfigList(line.allowed_group_ids);
      state.line.group_trigger_mode = normalizeConsoleGroupTriggerMode(line.group_trigger_mode);
      state.lark.app_id = str(lark.app_id);
      state.lark.app_secret = str(lark.app_secret);
      state.lark.allowed_chat_ids_text = formatConfigList(lark.allowed_chat_ids);
      state.lark.group_trigger_mode = normalizeConsoleGroupTriggerMode(lark.group_trigger_mode);
      state.mixin.keystore_file = str(mixin.keystore_file);
      state.mixin.allowed_conversation_ids_text = formatConfigList(mixin.allowed_conversation_ids);
      state.discord.bot_token = str(discord.bot_token);
      state.discord.allowed_guild_ids_text = formatConfigList(discord.allowed_guild_ids);
      state.discord.allowed_channel_ids_text = formatConfigList(discord.allowed_channel_ids);
      state.discord.allowed_user_ids_text = formatConfigList(discord.allowed_user_ids);
      state.discord.group_trigger_mode = normalizeDiscordGroupTriggerMode(discord.group_trigger_mode);
      state.wechat.bot_id = str(wechat.bot_id);
      state.whatsapp.api_token = str(whatsapp.api_token);
      state.bluesky.service_url = str(bluesky.service_url);
      state.bluesky.identifier = str(bluesky.identifier);
      state.bluesky.app_password = str(bluesky.app_password);
      state.x.client_id = str(x.client_id);
      state.x.client_secret = str(x.client_secret);
      state.x.refresh_token = str(x.refresh_token);
      state.x.login = { logged_in: x.login?.logged_in === true, username: str(x.login?.username) };
      state.guard.enabled = typeof guard.enabled === "boolean" ? guard.enabled : true;
      state.guard.url_fetch_allowed_url_prefixes_text = formatConfigList(guardURLFetch.allowed_url_prefixes);
      state.guard.deny_private_ips = typeof guardURLFetch.deny_private_ips === "boolean" ? guardURLFetch.deny_private_ips : true;
      state.guard.follow_redirects = typeof guardURLFetch.follow_redirects === "boolean" ? guardURLFetch.follow_redirects : false;
      state.guard.allow_proxy = typeof guardURLFetch.allow_proxy === "boolean" ? guardURLFetch.allow_proxy : false;
      state.guard.redaction_enabled = typeof guardRedaction.enabled === "boolean" ? guardRedaction.enabled : true;
      state.guard.approvals_enabled = typeof guardApprovals.enabled === "boolean" ? guardApprovals.enabled : false;
      consoleSettingsLoaded.set(true);
      setLoadedConsoleSnapshots();
      const restored = new Set<string>();
      restoreUnsavedScopes(unsaved, restored);
      consoleSecretDirty.set(restored);
    });
  }

  function resetConsoleSettingsState() {
    consoleSettingsRequestSeq += 1;
    batch(() => {
      consoleLoading.set(false);
      consoleSaving.set(false);
      consoleSavingTarget.set("");
      Object.assign(state.managedRuntimes, MANAGED_RUNTIME_DEFAULTS);
      for (const kind of Object.keys(EMPTY_CHANNELS) as (keyof typeof EMPTY_CHANNELS)[]) {
        Object.assign((state as any)[kind], EMPTY_CHANNELS[kind]());
      }
      consoleEnvManaged.set({});
      consoleSecretFields.set({});
      consoleSecretDirty.set(new Set());
      consoleConfigPath.set("");
      consoleConfigValues.set({});
      consoleFieldStates.set({});
      consoleEndpoints.set([]);
      authProfiles.set([]);
      clearLoadedConsoleSnapshots();
    });
  }

  function resetSystemSettingsState() {
    batch(() => {
      systemLoading.set(false);
      systemSaving.set(false);
      systemSettingsLoaded.set(false);
      systemConfigValues.set({});
      systemFieldStates.set({});
    });
  }

  async function loadConsoleSettings() {
    if (!untracked(selectedEndpointIsConsole)) return;
    const requestSeq = ++consoleSettingsRequestSeq;
    const target = currentRef();
    consoleLoading.set(true);
    try {
      const data: any = await endpointApiFetch(target, "/settings/console");
      if (!isCurrentConsole(requestSeq, target)) return;
      batch(() => {
        consoleConfigPath.set(str(data?.config_path));
        applyConsolePayload(data);
      });
    } catch (e: any) {
      if (isCurrentConsole(requestSeq, target)) notice.error(e?.message || t("msg_load_failed"));
    } finally {
      if (isCurrentConsole(requestSeq, target)) consoleLoading.set(false);
    }
  }

  async function loadSystemSettings() {
    const target = currentRef();
    systemLoading.set(true);
    try {
      const data: any = await endpointApiFetch(target, "/settings/system");
      if (target !== currentRef()) return;
      batch(() => {
        settingsConfigRevision.set(trimText(data?.config_revision) || untracked(settingsConfigRevision));
        systemConfigValues.set(obj(data?.config_values));
        systemFieldStates.set(obj(data?.field_states));
        systemSettingsLoaded.set(true);
      });
    } catch (e: any) {
      if (target === currentRef()) notice.error(e?.message || t("msg_load_failed"));
    } finally {
      if (target === currentRef()) systemLoading.set(false);
    }
  }

  /* --- persona --- */

  function applyPersonaIdentityContent(raw: string) {
    batch(() => {
      loadedIdentityRaw.set(normalizeText(raw));
      Object.assign(state.persona, parseIdentityProfile(untracked(loadedIdentityRaw)));
      loadedIdentitySnapshot.set(untracked(() => buildPersonaIdentitySnapshot(state.persona)));
    });
  }

  function applyPersonaSoulContent(raw: string) {
    const next = normalizeSoulDocument(raw);
    batch(() => {
      soulContent.set(next);
      loadedSoulSnapshot.set(next);
    });
  }

  function updatePersonaSoulContent(value: string) {
    batch(() => {
      soulContent.set(String(value || ""));
      personaOk.set("");
    });
  }

  function updatePersonaField(field: string, value: string) {
    if (!Object.prototype.hasOwnProperty.call(state.persona, field)) return;
    state.persona[field] = String(value ?? "");
  }

  function setPersonaAvatarObjectURL(nextURL: string) {
    if (personaAvatarObjectURL && personaAvatarObjectURL.startsWith("blob:")) {
      try {
        URL.revokeObjectURL(personaAvatarObjectURL);
      } catch (error) {
        console.warn("settings: revoke avatar url", (error as Error)?.message);
      }
    }
    personaAvatarObjectURL = nextURL || "";
    personaAvatarURL.set(personaAvatarObjectURL);
  }

  function resetPersonaSettingsState() {
    batch(() => {
      Object.assign(state.persona, buildEmptyPersonaIdentityState());
      soulContent.set("");
      loadedIdentityRaw.set("");
      loadedIdentitySnapshot.set(untracked(() => buildPersonaIdentitySnapshot(state.persona)));
      loadedSoulSnapshot.set("");
      personaSettingsLoaded.set(false);
      setPersonaAvatarObjectURL("");
    });
  }

  async function loadPersonaFile(endpointRef: string, endpoint: string) {
    try {
      const payload: any = await runtimeApiFetchForEndpoint(endpointRef, endpoint);
      return String(payload?.content || "");
    } catch (e: any) {
      if (e?.status === 404) return "";
      throw e;
    }
  }

  async function loadPersonaAvatar(endpointRef: string, requestSeq = personaSettingsRequestSeq) {
    try {
      const blob = (await runtimeApiDownloadForEndpoint(endpointRef, PERSONA_AVATAR_ENDPOINT)) as Blob;
      const nextURL = URL.createObjectURL(blob);
      if (!isCurrentPersona(requestSeq, endpointRef)) {
        URL.revokeObjectURL(nextURL);
        return;
      }
      setPersonaAvatarObjectURL(nextURL);
    } catch (e: any) {
      if (!isCurrentPersona(requestSeq, endpointRef)) return;
      if (e?.status === 404) {
        setPersonaAvatarObjectURL("");
        return;
      }
      throw e;
    }
  }

  async function loadPersonaSettings(endpointRef = currentRef()) {
    const requestSeq = ++personaSettingsRequestSeq;
    const target = trimText(endpointRef) || LOCAL_CONSOLE_ENDPOINT_REF;
    batch(() => {
      personaLoading.set(true);
      personaErr.set("");
      personaOk.set("");
    });
    try {
      const identityContent = await loadPersonaFile(target, PERSONA_IDENTITY_ENDPOINT);
      if (!isCurrentPersona(requestSeq, target)) return;
      applyPersonaIdentityContent(identityContent);
      const soul = await loadPersonaFile(target, PERSONA_SOUL_ENDPOINT);
      if (!isCurrentPersona(requestSeq, target)) return;
      applyPersonaSoulContent(soul);
      await loadPersonaAvatar(target, requestSeq);
      if (!isCurrentPersona(requestSeq, target)) return;
      personaSettingsLoaded.set(true);
    } catch (e: any) {
      if (!isCurrentPersona(requestSeq, target)) return;
      personaErr.set(e?.message || t("msg_load_failed"));
      notice.error(untracked(personaErr));
    } finally {
      if (isCurrentPersona(requestSeq, target)) personaLoading.set(false);
    }
  }

  async function savePersona({ notify = true } = {}) {
    if (untracked(personaSaveDisabled)) return false;
    batch(() => {
      personaSaving.set(true);
      personaSavingTarget.set("persona");
      personaErr.set("");
      personaOk.set("");
    });
    const target = currentRef();
    let setupReadinessDirty = false;
    try {
      if (untracked(personaIdentityDirty)) {
        const content = untracked(() => buildIdentityYAML(state.persona, loadedIdentityRaw()));
        await runtimeApiFetchForEndpoint(target, PERSONA_IDENTITY_ENDPOINT, { method: "PUT", body: { content } });
        if (target !== currentRef()) return false;
        batch(() => {
          loadedIdentityRaw.set(content);
          loadedIdentitySnapshot.set(untracked(() => buildPersonaIdentitySnapshot(state.persona)));
        });
        dispatchPersonaIdentityUpdated();
        setupReadinessDirty = true;
      }
      if (untracked(personaSoulDirty)) {
        const content = normalizeSoulDocument(untracked(soulContent));
        await runtimeApiFetchForEndpoint(target, PERSONA_SOUL_ENDPOINT, { method: "PUT", body: { content } });
        if (target !== currentRef()) return false;
        batch(() => {
          soulContent.set(content);
          loadedSoulSnapshot.set(content);
        });
        setupReadinessDirty = true;
      }
      if (setupReadinessDirty) invalidateConsoleSetupReadiness();
      personaOk.set(t("msg_save_success"));
      noteSavedApplyMode(null);
      if (notify) notice.success(untracked(personaOk));
      return true;
    } catch (e: any) {
      personaErr.set(e?.message || t("msg_save_failed"));
      notice.error(untracked(personaErr));
      return false;
    } finally {
      batch(() => {
        personaSaving.set(false);
        personaSavingTarget.set("");
      });
    }
  }

  /** Uploads the avatar: `upload(endpointRef)` sends the bytes (the image field owns them). */
  async function savePersonaAvatar(upload: (endpointRef: string) => Promise<void>) {
    batch(() => {
      personaAvatarBusy.set(true);
      personaErr.set("");
      personaOk.set("");
    });
    const target = currentRef();
    try {
      await upload(target);
      if (target !== currentRef()) return;
      await loadPersonaAvatar(target);
      dispatchPersonaAvatarUpdated();
      personaOk.set(t("msg_save_success"));
      notice.success(untracked(personaOk));
    } catch (e: any) {
      personaErr.set(e?.message || t("msg_save_failed"));
      notice.error(untracked(personaErr));
    } finally {
      personaAvatarBusy.set(false);
    }
  }

  async function deletePersonaAvatar() {
    batch(() => {
      personaAvatarBusy.set(true);
      personaErr.set("");
      personaOk.set("");
    });
    const target = currentRef();
    try {
      await runtimeApiFetchForEndpoint(target, PERSONA_AVATAR_ENDPOINT, { method: "DELETE" });
      if (target !== currentRef()) return;
      setPersonaAvatarObjectURL("");
      dispatchPersonaAvatarUpdated();
      personaOk.set(t("msg_delete_success"));
      notice.success(untracked(personaOk));
    } catch (e: any) {
      personaErr.set(e?.message || t("msg_delete_failed"));
      notice.error(untracked(personaErr));
    } finally {
      personaAvatarBusy.set(false);
    }
  }

  /* --- console: edits and saves --- */

  function updateChannelField(kind: ChannelKind, field: string, value: unknown) {
    const draft = channelState(kind);
    const key = String(field || "").trim();
    if (!draft || !key || !Object.prototype.hasOwnProperty.call(draft, key)) return;
    batch(() => {
      if (kind === "guard") {
        draft[key] = typeof untracked(() => draft[key]) === "boolean" ? !!value : String(value || "");
      } else {
        draft[key] = String(value || "");
      }
      if (kind !== "mixin" && kind !== "guard") markConsoleSecretDirty(kind, key);
    });
  }
  function updateGroupTrigger(kind: ChannelKind, value: string) {
    updateChannelField(kind, "group_trigger_mode", value || (kind === "discord" ? "strict" : "talkative"));
  }

  function setManagedRuntimeEnabled(id: string, value: boolean) {
    if (!Object.prototype.hasOwnProperty.call(state.managedRuntimes, id)) return;
    state.managedRuntimes[id] = !!value;
  }

  function buildConsoleSavePayload(target = "all") {
    const env = untracked(consoleEnvManaged);
    const envOf = (kind: string) => obj(env?.[kind]);
    const secret = (kind: string, field: string) =>
      pickedReference(consoleFieldRawValue(envOf(kind), field), channelState(kind)?.[field]) ||
      includeConsoleSecretValue(kind, field, channelState(kind)?.[field]);
    const managed_runtimes = MANAGED_RUNTIME_ITEMS.filter((item) => state.managedRuntimes[item.id]).map((item) => item.id);
    const telegram: Record<string, any> = {
      allowed_chat_ids: parseConfigListText(state.telegram.allowed_chat_ids_text),
      group_trigger_mode: normalizeConsoleGroupTriggerMode(state.telegram.group_trigger_mode),
    };
    telegram.bot_token = secret("telegram", "bot_token");
    const slack: Record<string, any> = {
      allowed_team_ids: parseConfigListText(state.slack.allowed_team_ids_text),
      allowed_channel_ids: parseConfigListText(state.slack.allowed_channel_ids_text),
      group_trigger_mode: normalizeConsoleGroupTriggerMode(state.slack.group_trigger_mode),
    };
    slack.bot_token = secret("slack", "bot_token");
    slack.app_token = secret("slack", "app_token");
    const line: Record<string, any> = {
      allowed_group_ids: parseConfigListText(state.line.allowed_group_ids_text),
      group_trigger_mode: normalizeConsoleGroupTriggerMode(state.line.group_trigger_mode),
    };
    line.channel_access_token = secret("line", "channel_access_token");
    line.channel_secret = secret("line", "channel_secret");
    const lark: Record<string, any> = {
      app_id: consoleFieldRawValue(envOf("lark"), "app_id") || trimText(state.lark.app_id),
      allowed_chat_ids: parseConfigListText(state.lark.allowed_chat_ids_text),
      group_trigger_mode: normalizeConsoleGroupTriggerMode(state.lark.group_trigger_mode),
    };
    lark.app_secret = secret("lark", "app_secret");
    const mixin = {
      keystore_file: consoleFieldRawValue(envOf("mixin"), "keystore_file") || trimText(state.mixin.keystore_file),
      allowed_conversation_ids: parseConfigListText(state.mixin.allowed_conversation_ids_text),
    };
    const discord: Record<string, any> = {
      allowed_guild_ids: parseConfigListText(state.discord.allowed_guild_ids_text),
      allowed_channel_ids: parseConfigListText(state.discord.allowed_channel_ids_text),
      allowed_user_ids: parseConfigListText(state.discord.allowed_user_ids_text),
      group_trigger_mode: normalizeDiscordGroupTriggerMode(state.discord.group_trigger_mode),
    };
    discord.bot_token = secret("discord", "bot_token");
    const whatsapp: Record<string, any> = {};
    whatsapp.api_token = secret("whatsapp", "api_token");
    const bluesky: Record<string, any> = {
      service_url: trimText(state.bluesky.service_url),
      identifier: trimText(state.bluesky.identifier),
    };
    bluesky.app_password = secret("bluesky", "app_password");
    const x: Record<string, any> = { client_id: trimText(state.x.client_id) };
    x.client_secret = secret("x", "client_secret");
    x.refresh_token = secret("x", "refresh_token");
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
      redaction: { enabled: !!state.guard.redaction_enabled },
      approvals: { enabled: !!state.guard.approvals_enabled },
    };
    const all: Record<string, any> = { managed_runtimes, telegram, slack, line, lark, mixin, discord, whatsapp, bluesky, x, guard };
    if (target === "runtimes") return { managed_runtimes };
    if (target in all) return { [target]: all[target] };
    return all;
  }

  async function saveConsoleSettings(target: string | string[] = "all", { notify = true } = {}) {
    const known = ["runtimes", "telegram", "slack", "line", "lark", "mixin", "discord", "whatsapp", "bluesky", "x", "guard"];
    const requested = Array.isArray(target) ? target.map(String) : [String(target)];
    const targets = requested.includes("all") ? ["all"] : requested.filter((item) => known.includes(item));
    if (!untracked(selectedEndpointIsConsole) || targets.length === 0) return false;
    if (targets[0] === "all" && (untracked(consoleLoading) || untracked(consoleSaving) || !untracked(consoleDirty))) return false;
    if (targets[0] !== "all" && targets.some((item) => untracked(() => consoleTargetSaveDisabled(item)))) return false;
    batch(() => {
      consoleSaving.set(true);
      consoleSavingTarget.set(targets.length === 1 ? targets[0] : "multiple");
    });
    const requestSeq = ++consoleSettingsRequestSeq;
    const ref = currentRef();
    try {
      // The endpoint takes one key per target, so several targets go out in a single request.
      const body: Record<string, any> = { config_revision: untracked(settingsConfigRevision) };
      untracked(() => {
        for (const item of targets) Object.assign(body, buildConsoleSavePayload(item));
      });
      const payload: any = await endpointApiFetch(ref, "/settings/console", { method: "PUT", body });
      if (!isCurrentConsole(requestSeq, ref)) return false;
      batch(() => {
        if (typeof payload?.config_path === "string") consoleConfigPath.set(payload.config_path);
        applyConsolePayload(payload, { savedScopes: targets[0] === "all" ? known : targets });
      });
      noteSavedApplyMode(payload);
      if (notify) notice.success(settingsSavedMessage(payload));
      return true;
    } catch (e: any) {
      if (isCurrentConsole(requestSeq, ref)) notice.error(e?.message || t("msg_save_failed"));
      return false;
    } finally {
      if (isCurrentConsole(requestSeq, ref)) {
        batch(() => {
          consoleSaving.set(false);
          consoleSavingTarget.set("");
        });
      }
    }
  }

  // WeChat and X login write config on the server. Reload it, keeping unsaved drafts.
  async function reloadConsoleSettingsAfterLogin() {
    const target = currentRef();
    try {
      const data = await endpointApiFetch(target, "/settings/console");
      if (currentRef() !== target) return;
      applyConsolePayload(data, { savedScopes: [] });
    } catch (e: any) {
      notice.error(e?.message || t("msg_load_failed"));
    }
  }

  async function saveConsoleCollection(target: string, values: unknown, onComplete?: (error?: string) => void) {
    if (untracked(consoleSaving)) return;
    const ref = currentRef();
    batch(() => {
      consoleSaving.set(true);
      consoleSavingTarget.set(target);
    });
    try {
      const payload: any = await endpointApiFetch(ref, "/settings/console", {
        method: "PUT",
        body: { config_revision: untracked(settingsConfigRevision), [target]: values },
      });
      if (ref !== currentRef()) return;
      applyConsolePayload(payload, { savedScopes: [] });
      onComplete?.();
      if (target === "endpoints") await loadEndpoints().catch((error: Error) => console.warn("settings: endpoints", error?.message));
      notice.success(settingsSavedMessage(payload));
    } catch (e: any) {
      if (ref !== currentRef()) return;
      if (target === "endpoints") {
        if (onComplete) {
          onComplete(e?.message || t("msg_save_failed"));
          return;
        }
        batch(() => {
          consoleEndpointErrorTitle.set(t(e?.status === 502 ? "settings_endpoint_test_failed" : "msg_save_failed"));
          consoleEndpointError.set(`${t("settings_endpoints_not_saved")}\n\n${e?.message || t("msg_save_failed")}`);
        });
        await openReentrantDialog(consoleEndpointErrorOpen);
        return;
      }
      if (e?.status === 409) await loadConsoleSettings();
      notice.error(e?.message || t("msg_save_failed"));
    } finally {
      batch(() => {
        consoleSaving.set(false);
        consoleSavingTarget.set("");
      });
    }
  }

  /* --- agent saves --- */

  async function saveLLMProfile(profileKey: string, draft: any = null, { notify = true } = {}) {
    const storedProfile = untracked(() => state.llm.profiles.find((item) => item._key === profileKey)) || null;
    const profile = draft || storedProfile;
    if (!storedProfile || !profile || untracked(agentLoading) || untracked(agentSaving) || untracked(agentSettingsReadOnly)) return false;
    const validationError = untracked(() => profileValidationError(profile));
    if (validationError) {
      notice.error(validationError);
      return false;
    }
    if (untracked(() => profileSaveDisabled(profile))) return false;
    const originalName = untracked(() => trimText(profile._savedName));
    const nextName = untracked(() => trimText(profile.name));
    batch(() => {
      agentSaving.set(true);
      agentSavingTarget.set(`profile:${profileKey}`);
    });
    const target = currentRef();
    try {
      const body = untracked(() => ({
        config_revision: settingsConfigRevision(),
        llm: { profile: { original_name: originalName, ...buildProfilePayload(profile) } },
      }));
      const payload: any = await endpointApiFetch(target, "/settings/agent", { method: "PUT", body });
      if (target !== currentRef()) return false;
      batch(() => {
        if (profile !== storedProfile) {
          Object.assign(storedProfile, profile);
          storedProfile._secretDirty = new Set(untracked(() => profile._secretDirty) || []);
        }
        if (typeof payload?.config_path === "string") llmConfigPath.set(payload.config_path);
        settingsConfigRevision.set(trimText(payload?.config_revision) || untracked(settingsConfigRevision));
        storedProfile._envManaged = obj(payload?.env_managed?.llm_profiles?.[nextName]);
        storedProfile._secretFields = obj(payload?.secret_fields?.llm_profiles?.[nextName]);
        storedProfile.api_key = "";
        storedProfile.bedrock_aws_key = "";
        storedProfile.bedrock_aws_secret = "";
        storedProfile.bedrock_aws_session_token = "";
        storedProfile.cloudflare_api_token = "";
        storedProfile._secretDirty = new Set();
        storedProfile._savedName = nextName;
        storedProfile._savedSnapshot = JSON.stringify(untracked(() => serializeLLMProfile(storedProfile)));
        if (originalName && originalName !== nextName) {
          state.llm.fallback_profiles = untracked(() => state.llm.fallback_profiles).map((item) =>
            trimText(item).toLowerCase() === originalName.toLowerCase() ? nextName : item,
          );
          updateLoadedFallbackProfile(originalName, nextName);
        }
      });
      if (target === LOCAL_CONSOLE_ENDPOINT_REF) invalidateConsoleSetupReadiness();
      await loadEndpoints();
      noteSavedApplyMode(payload);
      if (notify) notice.success(settingsSavedMessage(payload));
      return true;
    } catch (e) {
      notice.error(agentSettingsErrorMessage(e, target, "msg_save_failed"));
      return false;
    } finally {
      batch(() => {
        agentSaving.set(false);
        agentSavingTarget.set("");
      });
    }
  }

  async function saveAgentSettings(target = "all", { notify = true } = {}) {
    const normalizedTarget = ["all", "llm", "tools", "mcp"].includes(String(target)) ? String(target) : "all";
    if (untracked(agentSettingsReadOnly)) return false;
    if (normalizedTarget === "llm" && untracked(llmSaveDisabled)) return false;
    if (normalizedTarget === "tools" && untracked(toolsSaveDisabled)) return false;
    if (normalizedTarget === "mcp" && untracked(mcpSaveDisabled)) return false;
    if (normalizedTarget === "all" && untracked(agentLoading)) return false;
    if ((normalizedTarget === "llm" || normalizedTarget === "all") && untracked(agentValidationError) !== "") {
      agentValidationVisible.set(true);
      return false;
    }
    batch(() => {
      agentSaving.set(true);
      agentSavingTarget.set(normalizedTarget);
      agentValidationVisible.set(false);
    });
    const ref = currentRef();
    try {
      const body = untracked(() => ({ config_revision: settingsConfigRevision(), ...buildSavePayload(normalizedTarget) }));
      const payload: any = await endpointApiFetch(ref, "/settings/agent", { method: "PUT", body });
      if (ref !== currentRef()) return false;
      if (typeof payload?.config_path === "string") llmConfigPath.set(payload.config_path);
      settingsConfigRevision.set(trimText(payload?.config_revision) || untracked(settingsConfigRevision));
      if (normalizedTarget === "llm" || normalizedTarget === "all") {
        if (ref === LOCAL_CONSOLE_ENDPOINT_REF) invalidateConsoleSetupReadiness();
        untracked(() => {
          const preservedProfiles = state.llm.profiles;
          const preservedTools = { ...state.tools };
          const previousToolsSnapshot = loadedToolsSnapshot();
          batch(() => {
            applyPayload(payload, { snapshotScope: normalizedTarget === "llm" ? "llm" : "all" });
            state.llm.profiles = preservedProfiles;
            if (normalizedTarget === "llm") {
              Object.assign(state.tools, preservedTools);
              loadedToolsSnapshot.set(previousToolsSnapshot);
            }
          });
        });
        await loadEndpoints();
      } else if (normalizedTarget === "tools") {
        loadedToolsSnapshot.set(untracked(buildToolsSnapshot));
      } else if (normalizedTarget === "mcp") {
        batch(() => {
          applyMCPPayload(payload?.mcp);
          loadedMCPSnapshot.set(untracked(buildMCPSnapshot));
        });
      }
      noteSavedApplyMode(payload);
      if (notify) notice.success(t("msg_save_success"));
      return true;
    } catch (e) {
      notice.error(agentSettingsErrorMessage(e, ref, "msg_save_failed"));
      return false;
    } finally {
      batch(() => {
        agentSaving.set(false);
        agentSavingTarget.set("");
      });
    }
  }

  function syncDefaultLLMAdvancedState(values: Record<string, any>) {
    const text = (path: string) => (values[path] === undefined || values[path] === null ? "" : String(values[path]));
    batch(() => {
      state.llm.context_window_tokens = text("llm.context_window_tokens");
      state.llm.supports_image_parts = text("llm.supports_image_parts");
      state.llm.cache_ttl = text("llm.cache_ttl");
      state.llm.cache_key_prefix = text("llm.cache_key_prefix");
      state.llm.request_timeout = text("llm.request_timeout");
      state.llm.temperature = text("llm.temperature");
      state.llm.reasoning_effort = text("llm.reasoning_effort");
      state.llm.reasoning_budget_tokens = text("llm.reasoning_budget_tokens");
      state.llm.tools_emulation_mode = text("llm.tools_emulation_mode") || "off";
      state.llm.headers_text = JSON.stringify(values["llm.headers"] && typeof values["llm.headers"] === "object" ? values["llm.headers"] : {}, null, 2);
    });
  }

  async function saveConfigSettings(scope: string, update: Record<string, any>, { notify = true } = {}) {
    const endpoint = scope === "agent" ? "/settings/agent" : scope === "console" ? "/settings/console" : "/settings/system";
    const ref = currentRef();
    batch(() => {
      if (scope === "agent") {
        agentSaving.set(true);
        agentSavingTarget.set("config");
      } else if (scope === "console") {
        consoleSaving.set(true);
        consoleSavingTarget.set("config");
      } else {
        systemSaving.set(true);
      }
    });
    try {
      const payload: any = await endpointApiFetch(ref, endpoint, {
        method: "PUT",
        body: { config_revision: untracked(settingsConfigRevision), ...update },
      });
      if (ref !== currentRef()) return false;
      const values = { ...obj(payload?.config_values) };
      const fieldStates = obj(payload?.field_states);
      batch(() => {
        settingsConfigRevision.set(trimText(payload?.config_revision) || untracked(settingsConfigRevision));
        if (scope === "agent") {
          values["llm.supports_image_parts"] = payload?.llm?.supports_image_parts ?? "";
          agentConfigValues.set(values);
          agentFieldStates.set(fieldStates);
          syncDefaultLLMAdvancedState(values);
        } else if (scope === "console") {
          consoleConfigValues.set(values);
          consoleFieldStates.set(fieldStates);
        } else {
          systemConfigValues.set(values);
          systemFieldStates.set(fieldStates);
        }
      });
      noteSavedApplyMode(payload);
      if (notify) notice.success(settingsSavedMessage(payload));
      return true;
    } catch (e: any) {
      if (e?.status === 409 && ref === currentRef()) {
        if (scope === "agent") await loadAgentSettings(ref);
        else if (scope === "console") await loadConsoleSettings();
        else await loadSystemSettings();
      }
      notice.error(e?.message || t("msg_save_failed"));
      return false;
    } finally {
      batch(() => {
        if (scope === "agent") {
          agentSaving.set(false);
          agentSavingTarget.set("");
        } else if (scope === "console") {
          consoleSaving.set(false);
          consoleSavingTarget.set("");
        } else {
          systemSaving.set(false);
        }
      });
    }
  }

  async function logout() {
    loggingOut.set(true);
    try {
      await apiFetch("/auth/logout", { method: "POST" });
    } catch (error) {
      console.warn("settings: logout", (error as Error)?.message);
    } finally {
      authState.clear();
      await navigate("/login", { replace: true, force: true });
      loggingOut.set(false);
    }
  }

  /* --- loading a section, and dropping drafts --- */

  function ensureSettingsSectionData(sectionID: string) {
    untracked(() => {
      if (["agent", "routes", "tools", "mcp"].includes(sectionID)) {
        if (!agentSettingsLoaded() && !agentLoading()) {
          void loadAgentSettings(settingsEndpointRef());
          return;
        }
        ensureLoadedAgentSnapshotsForSection(sectionID);
        return;
      }
      if (sectionID === "persona") {
        if (!personaSettingsLoaded() && !personaLoading()) void loadPersonaSettings(settingsEndpointRef());
        return;
      }
      if (["channels", "runtimes", "security", "automation", "console"].includes(sectionID)) {
        if (selectedEndpointIsConsole() && !consoleSettingsLoaded() && !consoleLoading()) void loadConsoleSettings();
        return;
      }
      if (sectionID === "system") {
        if (selectedEndpointIsConsole() && !systemSettingsLoaded() && !systemLoading()) void loadSystemSettings();
      }
    });
  }

  function discardSettingsDrafts() {
    agentSettingsRequestSeq += 1;
    personaSettingsRequestSeq += 1;
    batch(() => {
      agentLoading.set(false);
      resetAgentSettingsState();
      personaLoading.set(false);
      resetPersonaSettingsState();
      personaErr.set("");
      personaOk.set("");
      resetConsoleSettingsState();
      consoleEndpointErrorOpen.set(false);
      resetSystemSettingsState();
      apiBasePickerOpen.set(false);
      modelPickerOpen.set(false);
      modelPickerTargetProfileKey.set("");
      modelPickerError.set("");
      modelPickerItems.set([]);
      testConnectionOpen.set(false);
      testConnectionError.set("");
      testConnectionBenchmarks.set([]);
      testConnectionTargetProfileKey.set("");
      testConnectionMeta.provider = "";
      testConnectionMeta.evaluateOnly = false;
      testConnectionMeta.benchmarkIds = [];
      testConnectionMeta.apiBase = "";
      testConnectionMeta.model = "";
      addProfileKey.set("");
      openProfileKey.set("");
      closeDeleteProfileDialog();
      codexAuth.dialogOpen.set(false);
      xaiAuth.dialogOpen.set(false);
      proAuth.dialogOpen.set(false);
    });
  }

  /* --- watchers --- */

  // Leaving a section closes its panes and forgets a failed save.
  effect(() => {
    selectedSection()?.id;
    untracked(() =>
      batch(() => {
        openChannel.set("");
        openProfileKey.set("");
        sectionSaveFailed.set("");
      }),
    );
  });

  // Another endpoint: its own settings, from scratch.
  let previousEndpointRef: string | undefined;
  effect(() => {
    const next = trimText(endpointState.selectedRef);
    untracked(() => {
      if (previousEndpointRef !== undefined && previousEndpointRef !== next) {
        codexAuth.resetEndpointState();
        xaiAuth.resetEndpointState();
        proAuth.resetEndpointState();
        discardSettingsDrafts();
        ensureSettingsSectionData(selectedSectionID());
      }
      previousEndpointRef = next;
    });
  });

  effect(() => {
    if (!deleteProfileDialogOpen()) untracked(() => deleteProfileTargetKey.set(""));
  });

  // The sign-in cards load their status when a provider that needs one is chosen.
  let codexCardShown = false;
  effect(() => {
    const visible = showCodexAuthCard();
    untracked(() => {
      if (visible) void codexAuth.loadStatus();
      else if (codexCardShown) codexAuth.resetEndpointState();
      codexCardShown = visible;
    });
  });
  let xaiCardShown = false;
  effect(() => {
    const visible = showXAIAuthCard();
    untracked(() => {
      if (visible) void xaiAuth.loadStatus();
      else if (xaiCardShown) xaiAuth.resetFlow();
      xaiCardShown = visible;
    });
  });
  let proCardShown = false;
  effect(() => {
    const visible = showProAuthCard();
    untracked(() => {
      if (visible) void proAuth.loadStatus();
      else if (proCardShown) proAuth.resetFlow();
      proCardShown = visible;
    });
  });

  function dispose() {
    disposed = true;
    codexAuth.dispose();
    xaiAuth.dispose();
    proAuth.dispose();
    discardSettingsDrafts();
    setPersonaAvatarObjectURL("");
  }

  return {
    state,
    loggingOut,
    // endpoint
    settingsEndpointRef,
    consoleRuntimeEndpoints,
    secretRevealLocal,
    selectedEndpointIsConsole,
    consoleEndpointRef,
    canBrowsePaths,
    // sections
    selectedSectionID,
    settingsSections,
    selectedSection,
    activeSaveKind,
    ensureSettingsSectionData,
    discardSettingsDrafts,
    // save bar
    saveRegistry,
    sectionSaveUnits,
    sectionSaving,
    sectionSaveFailed,
    sectionSaveBusy,
    saveBarVisible,
    saveSection,
    discardSection,
    restartState,
    restartProcess,
    // agent
    agentLoading,
    agentSaving,
    agentSavingTarget,
    agentSettingsReadOnly,
    agentSettingsUnsupported,
    agentSettingsReadOnlyMessage,
    agentFormDisabledReason,
    agentValidationVisible,
    agentValidationError,
    agentConfigValues,
    agentFieldStates,
    llmEnvManaged,
    llmSecretFields,
    llmDirty,
    toolsDirty,
    mcpDirty,
    loadAgentSettings,
    saveAgentSettings,
    saveConfigSettings,
    saveMCPServers,
    mcpValidationError,
    llmRevealPrefix(profile?: any) {
      if (!secretRevealLocal()) return "";
      if (!profile || profile === state.llm) return "llm";
      const name = trimText(profile._savedName);
      return name ? `llm.profiles.${name}` : "";
    },
    providerItems,
    defaultLLMProviderItems,
    reasoningEffortItems,
    toolsEmulationItems,
    groupTriggerItems,
    apiBasePickerItems,
    profileOptions,
    routeProfileOptions,
    updateDefaultLLMField,
    updateProfileField,
    llmProfileEnvManaged,
    llmProfileSecretFields,
    profileSummary,
    profileLogo,
    profileProviderChoice,
    profileDirty,
    profileIsInUse,
    profileSaveDisabled,
    profileModelLookupCredentialsReady,
    profileUsesCodexProvider,
    profileCodexAuthDisabled,
    profileUsesXAIProvider,
    profileUsesProProvider,
    defaultCodexAuthDisabled,
    openProfileKey,
    openedProfile,
    openProfilePane,
    closeProfilePane,
    addProfileDraft,
    addProfileOpen,
    addProfileError,
    addProfileSaving,
    addProfileSaveDisabled,
    openAddProfileDialog,
    cancelAddProfile,
    createProfile,
    saveLLMProfile,
    deleteProfileDialogOpen,
    deleteProfileDialogText,
    confirmRemoveLLMProfile,
    closeDeleteProfileDialog,
    deleteLLMProfile,
    addFallbackProfile,
    updateFallbackProfile,
    removeFallbackProfile,
    moveFallbackProfile,
    llmActionMenuItems,
    testConnectionDisabled,
    testConnectionDisabledForProfile,
    openTestConnection,
    runConnectionTest,
    testConnectionOpen,
    testConnectionLoading,
    testConnectionError,
    testConnectionBenchmarks,
    testConnectionMeta,
    apiBasePickerOpen,
    openAPIBasePicker,
    applyAPIBaseOption,
    modelPickerOpen,
    modelPickerLoading,
    modelPickerError,
    modelPickerItems,
    modelPickerSelectedValue,
    openModelPicker,
    applyModelOption,
    codexAuth,
    xaiAuth,
    proAuth,
    // advanced dialog
    advancedSettingsOpen,
    advancedSettingsTitle,
    advancedSettingsScope,
    advancedSettingsGroups,
    advancedSettingsDirty,
    advancedSettingsValues,
    advancedSettingsFieldStates,
    advancedSettingsLoading,
    advancedSettingsSaving,
    advancedSettingsSaveDisabled,
    openConfigAdvancedSettings,
    openDefaultLLMAdvancedSettings,
    openContextAdvancedSettings,
    openToolAdvancedSettings,
    openChannelAdvancedSettings,
    closeAdvancedSettings,
    saveAdvancedConfigSettings,
    registerAdvancedPanelSave,
    saveAdvancedSettings,
    // tools
    toolSchemaPreview,
    previewToolSchema,
    previewChannelToolSchema,
    setToolEnabled,
    // console
    consoleLoading,
    consoleSaving,
    consoleSavingTarget,
    consoleConfigValues,
    consoleFieldStates,
    consoleEndpoints,
    consoleSettingsLoaded,
    consoleEndpointErrorOpen,
    consoleEndpointError,
    consoleEndpointErrorTitle,
    authProfiles,
    securityConfigGroups,
    consolePasswordConfigured,
    consoleDirtyOf,
    loadConsoleSettings,
    saveConsoleSettings,
    saveConsoleCollection,
    reloadConsoleSettingsAfterLogin,
    updateChannelField,
    updateGroupTrigger,
    setManagedRuntimeEnabled,
    consoleFieldEnvManaged,
    consoleFieldManagedHeadline,
    consoleSecretField,
    consoleSecretEditable,
    consoleSecretRevealPath,
    channelTiles,
    channelGroups,
    channelTriggerHiddenPaths,
    channelManagedItem,
    channelActionMenuItems,
    openChannel,
    openChannelTitleKey,
    openChannelPane,
    closeChannelPane,
    xLoginReady,
    // persona
    personaLoading,
    personaSaving,
    personaErr,
    personaOk,
    soulContent,
    personaAvatarURL,
    personaAvatarBusy,
    personaAvatarDisabled,
    personaDirty,
    personaEditorMeta,
    updatePersonaField,
    updatePersonaSoulContent,
    savePersona,
    savePersonaAvatar,
    deletePersonaAvatar,
    loadPersonaSettings,
    // system
    systemLoading,
    systemSaving,
    systemConfigValues,
    systemFieldStates,
    settingsConfigRevision,
    logout,
    dispose,
  };
}

export type SettingsStore = ReturnType<typeof createSettingsStore>;
