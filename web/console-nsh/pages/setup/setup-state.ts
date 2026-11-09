// The first-run setup's data and requests (the Vue console's SetupView, its script half): the
// model, the persona and the soul, each saved to the route's endpoint, and where each step goes
// next. SetupPage.tsx draws it.
import { batch, cleanup, computed, effect, signal, untracked } from "nsh";
import type { Signal } from "nsh";
import { useProAuthFlow, useXAIAuthFlow, type DeviceAuthStatus } from "../../components/settings/AuthDialogs";
import type { AdjustedImage } from "../../components/settings/ImageUploadField";
import type { SetupPickerItem } from "../../components/settings/SetupPickerDialog";
import type { ConnectionBenchmark } from "../../components/settings/SetupConnectionTestDialog";
import {
  currentLocale,
  endpointApiFetch,
  formatTime,
  loadEndpoints,
  runtimeApiDownloadForEndpoint,
  runtimeApiFetchForEndpoint,
  translate,
} from "../../lib/core/context.js";
import { CONSOLE_LOCAL_ENDPOINT_REF } from "../../lib/core/endpoints.js";
import { endpointPagePath, endpointRefFromRouteParam, endpointRoutePath } from "../../lib/core/endpoint-routes.js";
import {
  hasLLMFieldValue as hasManagedLLMFieldValue,
  isLLMFieldEnvManaged as isManagedLLMField,
  llmFieldEnvName as managedLLMFieldEnvName,
  llmFieldEnvRawValue as managedLLMFieldEnvRawValue,
  llmFieldEnvValue as managedLLMFieldEnvValue,
  llmFieldManagedDisplayValue as managedLLMFieldDisplayValue,
  llmFieldManagedHeadline as managedLLMFieldHeadline,
  llmFieldValue as managedLLMFieldValue,
} from "../../lib/core/llm-env-managed.js";
import { dismissNotice, isNetworkErrorMessage, pushNotice, useNotice } from "../../lib/core/notices.js";
import {
  dispatchPersonaAvatarUpdated,
  dispatchPersonaIdentityUpdated,
  loadPersonaRecord,
  PERSONA_AVATAR_ENDPOINT,
  savePersonaRecord,
} from "../../lib/core/persona-profile.js";
import { pickRandomPersonaSeed } from "../../lib/core/persona-seeds.js";
import { openReentrantDialog } from "../../lib/core/reentrant-dialog.js";
import { llmSecretConfigPath } from "../../lib/core/secret-storage.js";
import { invalidateConsoleSetupReadiness, resolveConsoleSetupStage, setupStagePath } from "../../lib/core/setup.js";
import {
  OPENAI_COMPATIBLE_API_BASE_OPTIONS,
  normalizeSetupProviderChoice,
  resolveSetupAPIKeyHelp,
  SETUP_PROVIDER_BEDROCK,
  SETUP_PROVIDER_CLOUDFLARE,
  SETUP_PROVIDER_MISTERMORPH_PRO,
  SETUP_PROVIDER_OPENAI_CODEX,
  SETUP_PROVIDER_OPENAI_COMPATIBLE,
  SETUP_PROVIDER_OPTIONS,
  SETUP_PROVIDER_XAI_OAUTH,
  setupOpenAICodexUsesAPIKey,
  setupProviderEvaluateOnly,
  setupProviderRequiresAPIBase,
  setupProviderRequiresAPIKey,
  setupProviderSupportsAPIKey,
  setupProviderSupportsCustomAPIBase,
  setupProviderSupportsModelLookup,
} from "../../lib/core/setup-contract.js";
import { modelPickerItemsFromPayload } from "../../lib/core/setup-picker.js";
import { findSoulPreset, SOUL_PRESETS } from "../../lib/core/soul-presets.js";
import { endpointState } from "../../lib/stores/index.js";
import { openExternal } from "../../lib/platform";
import { currentRoute, locationOf, navigate } from "../../lib/router";
import { uploadPersonaAvatar } from "./avatar-upload";

export const t = translate as (key: string, vars?: Record<string, unknown>) => string;

export type SetupStage = "llm" | "persona" | "soul" | "done";

export const TOTAL_STEPS = 3;
const PREVIOUS_STAGE: Partial<Record<SetupStage, SetupStage>> = { persona: "llm", soul: "persona" };
const NEXT_STAGE: Partial<Record<SetupStage, SetupStage>> = { llm: "persona", persona: "soul", soul: "done" };

export interface StageMeta {
  index: number;
  titleKey: string;
  introKey: string;
  submitKey?: string;
  tone: SetupStage;
  kickerKey?: string;
}

export const STAGE_META: Record<SetupStage, StageMeta> = {
  llm: { index: 1, titleKey: "setup_llm_title", introKey: "setup_llm_intro", submitKey: "setup_action_continue", tone: "llm" },
  persona: {
    index: 2,
    titleKey: "setup_persona_title",
    introKey: "setup_persona_intro",
    submitKey: "setup_action_continue",
    tone: "persona",
  },
  soul: { index: 3, titleKey: "setup_soul_title", introKey: "setup_soul_intro", submitKey: "setup_action_finish", tone: "soul" },
  done: { index: TOTAL_STEPS, titleKey: "setup_done_title", introKey: "setup_done_intro", tone: "done", kickerKey: "setup_stage_done" },
};

export const LLM_FORM_FIELDS = [
  "provider",
  "endpoint",
  "model",
  "api_key",
  "bedrock_aws_key",
  "bedrock_aws_secret",
  "bedrock_region",
  "bedrock_model_arn",
  "cloudflare_api_token",
  "cloudflare_account_id",
] as const;
export type LLMFormField = (typeof LLM_FORM_FIELDS)[number];
export type LLMForm = Record<LLMFormField, string>;

export interface PersonaForm {
  name: string;
  creature: string;
  vibe: string;
  emoji: string;
}

export function normalizeText(value: unknown) {
  return String(value || "").replace(/\r\n/g, "\n");
}

export function normalizeSoulDocument(raw: unknown) {
  const value = normalizeText(raw).trim();
  return value ? `${value}\n` : "";
}

export function buildCustomSoulDocument() {
  return normalizeSoulDocument(`# soul.md

## Core Truths

-

## Boundaries

-

## Vibe


## Continuity

`);
}

function emptyLLMForm(): LLMForm {
  return {
    provider: SETUP_PROVIDER_OPENAI_COMPATIBLE,
    endpoint: "",
    model: "",
    api_key: "",
    bedrock_aws_key: "",
    bedrock_aws_secret: "",
    bedrock_region: "",
    bedrock_model_arn: "",
    cloudflare_api_token: "",
    cloudflare_account_id: "",
  };
}

function buildDefaultPayload() {
  return {
    llm: { ...emptyLLMForm(), reasoning_effort: "", tools_emulation_mode: "" } as Record<string, unknown>,
    tools: {
      write_file: { enabled: true },
      spawn: { enabled: true },
      contacts_send: { enabled: true },
      todo_update: { enabled: true },
      plan_create: { enabled: false },
      url_fetch: { enabled: true },
      web_search: { enabled: true },
      bash: { enabled: true },
    } as Record<string, unknown>,
  };
}

function normalizePayload(data: any) {
  const base = buildDefaultPayload();
  return {
    llm: { ...base.llm, ...(data?.llm && typeof data.llm === "object" ? data.llm : {}) },
    tools: { ...base.tools, ...(data?.tools && typeof data.tools === "object" ? data.tools : {}) },
  };
}

export function normalizeStage(value: unknown): SetupStage {
  return value === "persona" || value === "soul" || value === "done" ? value : "llm";
}

export function resolveDoneGreetingKey(date = new Date()) {
  const hour = date.getHours();
  if (hour >= 5 && hour < 10) return "setup_done_greeting_morning";
  if (hour >= 10 && hour < 12) return "setup_done_greeting_day";
  if (hour >= 12 && hour < 19) return "setup_done_greeting_afternoon";
  return "setup_done_greeting_evening";
}

export interface SoulCard {
  id: string;
  icon: string;
  title: string;
  note: string;
  faceSrc?: unknown;
  spriteSrc?: unknown;
  spriteFrames?: number;
  spriteFrameWidth?: number;
  spriteFrameHeight?: number;
  spriteScale?: number;
  indexLabel?: string;
  stackIndex?: number;
}

const CODEX_EMPTY_STATUS: DeviceAuthStatus = {
  logged_in: false,
  access_token_present: false,
  refresh_token_present: false,
  access_token_expired: false,
  expires_at: "",
  account_id: "",
  file_mode_ok: true,
  file_mode_warning: "",
};

function errorMessage(error: unknown, fallbackKey: string) {
  return (error as Error)?.message || t(fallbackKey);
}

/** The setup's state and actions. Call once, in the page's body. */
export function useSetup() {
  const notice = useNotice();
  const setupEndpointRef = () => endpointRefFromRouteParam(currentRoute().params.endpoint_ref);
  const routeEndpointRef = () => untracked(setupEndpointRef);

  // Stored secrets can be revealed for this console's own config only.
  const setupSecretRevealPath = (field: string) =>
    setupEndpointRef() === CONSOLE_LOCAL_ENDPOINT_REF ? llmSecretConfigPath("llm", field) : "";

  const loading = signal(false);
  const saving = signal(false);
  const err = signal("");

  // A network failure is not about the form: it goes to the floating notice stack.
  effect(() => {
    const value = err();
    untracked(() => {
      if (isNetworkErrorMessage(value)) {
        pushNotice({ id: "setup-network", type: "error", text: value, timeout: 0 });
      } else {
        dismissNotice("setup-network");
      }
    });
  });
  cleanup(() => dismissNotice("setup-network"));

  const spriteTick = signal(0);
  const spriteTimer = setInterval(() => spriteTick.update((tick) => (tick + 1) % 240), 220);
  cleanup(() => clearInterval(spriteTimer));

  const loadedPayload = signal(buildDefaultPayload());
  const loadedConfigSource = signal("defaults");
  const configRevision = signal("");
  const llmEnvManaged = signal<Record<string, unknown>>({});
  const llmSecretFields = signal<Record<string, { configured?: boolean; editable?: boolean; source?: string }>>({});
  // The persona as loaded: which API the runtime has, and the identity.yaml text on an old one.
  const loadedPersonaRecord = signal<any>(null);
  const loadedSoulRaw = signal<string | null>(null);
  const personaAvatarURL = signal("");
  const personaAvatarBusy = signal(false);
  const llmForm = signal<LLMForm>(emptyLLMForm());
  const personaForm = signal<PersonaForm>({ name: "", creature: "", vibe: "", emoji: "" });
  const soulSelectionContent = signal("");
  const soulEditorDraft = signal(buildCustomSoulDocument());
  const soulPresetId = signal("");
  const soulSelectionKind = signal<"" | "preset" | "custom">("");
  const soulEditMode = signal(false);
  const modelPickerOpen = signal(false);
  const modelPickerLoading = signal(false);
  const modelPickerError = signal("");
  const modelPickerItems = signal<SetupPickerItem[]>([]);
  const apiBasePickerOpen = signal(false);
  const testConnectionOpen = signal(false);
  const testConnectionLoading = signal(false);
  const testConnectionError = signal("");
  const testConnectionBenchmarks = signal<ConnectionBenchmark[]>([]);
  const testConnectionMeta = signal({ provider: "", apiBase: "", model: "" });
  const codexAuthLoading = signal(false);
  const codexAuthBusy = signal(false);
  const codexAuthError = signal("");
  const codexAuthDialogOpen = signal(false);
  const codexLoginSession = signal("");
  const codexLoginVerificationURL = signal("");
  const codexLoginUserCode = signal("");
  const codexLoginExpiresAt = signal("");
  const codexAuthStatus = signal<DeviceAuthStatus>({ ...CODEX_EMPTY_STATUS });
  let codexLoginPollTimer: ReturnType<typeof setTimeout> | undefined;
  let focusPersonaName: (() => void) | null = null;

  const setLLMField = (field: LLMFormField, value: string) => llmForm.update((form) => ({ ...form, [field]: value }));
  const setPersonaField = (field: keyof PersonaForm, value: string) =>
    personaForm.update((form) => ({ ...form, [field]: value }));

  const pro = useProAuthFlow({
    getEndpointRef: routeEndpointRef,
    request: endpointApiFetch as never,
    async onSettingsUpdated() {
      await loadLLMForm();
    },
  });
  const xai = useXAIAuthFlow({
    getEndpointRef: routeEndpointRef,
    request: endpointApiFetch as never,
    async onSettingsUpdated() {
      await loadLLMForm();
    },
  });

  /* ---------- the route ---------- */

  const routeStage = () => normalizeStage(currentRoute().meta?.setupStage);
  const repairKey = () => String(currentRoute().query?.repair || "").trim();
  const inRepairMode = () => repairKey() !== "";
  const stageMeta = () => STAGE_META[routeStage()] || STAGE_META.llm;
  const setupName = () => String(personaForm().name || "").trim() || t("setup_done_name_fallback");
  const stageTitle = () => t(stageMeta().titleKey, { name: setupName() });
  const stageIntro = () =>
    String(t(stageMeta().introKey, { name: setupName(), greeting: t(resolveDoneGreetingKey()) })).trim();
  const previousStage = () => PREVIOUS_STAGE[routeStage()] || "";
  const showPrevious = () => !inRepairMode() && previousStage() !== "";
  const stageKicker = () =>
    `[[ ${t("setup_title")} // ${
      stageMeta().kickerKey ? t(stageMeta().kickerKey!) : t("setup_stage_short", { current: stageMeta().index })
    } ]]`;
  const progressSteps = () =>
    Array.from({ length: TOTAL_STEPS }, (_, index) => ({ index: index + 1, active: index + 1 <= stageMeta().index }));

  /* ---------- the model ---------- */

  const llmFieldEnvName = (field: string) => managedLLMFieldEnvName(llmEnvManaged(), field);
  const llmFieldEnvRawValue = (field: string): string => managedLLMFieldEnvRawValue(llmEnvManaged(), field);
  const llmFieldEnvValue = (field: string): string => managedLLMFieldEnvValue(llmEnvManaged(), field);
  const isLLMFieldEnvManaged = (field: string): boolean => isManagedLLMField(llmEnvManaged(), field);
  const llmFieldValue = (field: string): string => managedLLMFieldValue(llmForm(), llmEnvManaged(), field);
  const hasLLMFieldValue = (field: string): boolean =>
    hasManagedLLMFieldValue(llmForm(), llmEnvManaged(), field) || llmSecretFields()?.[field]?.configured === true;
  const includeLLMSecret = (field: LLMFormField) => {
    const value = String(llmForm()[field] || "").trim();
    return value !== "" || llmSecretFields()?.[field]?.configured !== true ? value : undefined;
  };
  const llmSecretEditable = (field: string) => llmSecretFields()?.[field]?.editable !== false;
  const llmFieldManagedDisplayValue = (field: string) => managedLLMFieldDisplayValue(llmForm(), llmEnvManaged(), field);
  const llmFieldManagedHeadline = (field: string): string => managedLLMFieldHeadline(llmForm(), llmEnvManaged(), field);

  // Setup configures the main model, which cannot be an Evaluate-only provider.
  const providerItems = computed(() =>
    (SETUP_PROVIDER_OPTIONS as { title: string; value: string; group?: string; note?: string }[]).filter(
      (item) => !setupProviderEvaluateOnly(item.value),
    ),
  );
  const providerItem = () => providerItems().find((item) => item.value === llmForm().provider) || null;
  const providerManagedField = () => {
    if (isLLMFieldEnvManaged("inference_provider")) return "inference_provider";
    if (isLLMFieldEnvManaged("provider")) return "provider";
    return "";
  };
  const providerChoice = computed<string>(() => {
    const provider = isLLMFieldEnvManaged("inference_provider") ? llmFieldEnvValue("inference_provider") : llmFieldValue("provider");
    return normalizeSetupProviderChoice(provider, { allowEmpty: true });
  });
  const showCloudflareAccountField = () => providerChoice() === SETUP_PROVIDER_CLOUDFLARE;
  const showCodexOAuthFields = computed(() => providerChoice() === SETUP_PROVIDER_OPENAI_CODEX);
  const showXAIOAuthFields = computed(() => providerChoice() === SETUP_PROVIDER_XAI_OAUTH);
  const showProOAuthFields = computed(() => providerChoice() === SETUP_PROVIDER_MISTERMORPH_PRO);
  const providerHasAuthAction = () => showCodexOAuthFields() || showXAIOAuthFields() || showProOAuthFields();
  const showBedrockFields = () => providerChoice() === SETUP_PROVIDER_BEDROCK;
  const showEndpointField = () => setupProviderSupportsCustomAPIBase(providerChoice());
  const showCredentialFields = () =>
    !showBedrockFields() &&
    !showXAIOAuthFields() &&
    !showProOAuthFields() &&
    (showCloudflareAccountField() || setupProviderSupportsAPIKey(providerChoice()));
  const credentialFieldName = (): LLMFormField => (showCloudflareAccountField() ? "cloudflare_api_token" : "api_key");
  const credentialLabelKey = () =>
    showCloudflareAccountField() ? "settings_agent_cloudflare_api_token_label" : "settings_agent_api_key_label";
  const credentialPlaceholderKey = () =>
    showCloudflareAccountField() ? "settings_agent_cloudflare_api_token_placeholder" : "settings_agent_api_key_placeholder";
  const credentialHintKey = () => (showCloudflareAccountField() ? "setup_llm_api_token_hint" : "setup_llm_api_key_hint");
  const credentialHintPlainKey = () =>
    showCloudflareAccountField() ? "setup_llm_api_token_hint_plain" : "setup_llm_api_key_hint_plain";
  const showOpenAICompatibleHelpers = () => setupProviderSupportsModelLookup(providerChoice());

  const codexAuthSummary = () => {
    if (codexAuthLoading()) return t("settings_codex_auth_loading");
    return codexAuthStatus().logged_in ? t("settings_codex_auth_signed_in") : t("settings_codex_auth_signed_out");
  };
  const codexAuthButtonState = (): "loading" | "signed-in" | "signed-out" => {
    if (codexAuthLoading()) return "loading";
    return codexAuthStatus().logged_in ? "signed-in" : "signed-out";
  };
  const codexAuthNeedsLogin = () => codexAuthButtonState() === "signed-out";
  const codexUsesAPIKey = (): boolean => setupOpenAICodexUsesAPIKey(llmFieldValue("endpoint"), hasLLMFieldValue("api_key"));
  const codexAuthDisabled = () => String(llmFieldValue("endpoint") || "").trim() !== "" && hasLLMFieldValue("api_key");
  const codexAuthButtonTitle = () => `${t("settings_codex_auth_title")}: ${codexAuthSummary()}`;
  const codexLoginExpiresLabel = () => (codexLoginExpiresAt() ? formatTime(codexLoginExpiresAt()) : t("ttl_unknown"));

  const modelLookupDisabled = () =>
    loading() ||
    saving() ||
    !showOpenAICompatibleHelpers() ||
    (showProOAuthFields() ? pro.proAuthNeedsLogin() : !hasLLMFieldValue(credentialFieldName())) ||
    (showCloudflareAccountField() && !hasLLMFieldValue("cloudflare_account_id"));
  const apiBasePickerItems = computed<SetupPickerItem[]>(() =>
    (OPENAI_COMPATIBLE_API_BASE_OPTIONS as { id: string; title: string; baseURL: string }[]).map((item) => ({
      id: item.id,
      title: item.title,
      value: item.baseURL,
      note: "",
    })),
  );
  const credentialHelp = (): { title: string; url?: string } | null => {
    const provider = providerChoice();
    if (provider === "" || showBedrockFields() || setupProviderRequiresAPIBase(provider) || isLLMFieldEnvManaged(credentialFieldName())) {
      return null;
    }
    return resolveSetupAPIKeyHelp(provider, llmFieldValue("endpoint"));
  };
  const credentialHelpParts = () => {
    if (!credentialHelp()) return null;
    const marker = "__PROVIDER__";
    const template = String(t(credentialHintKey(), { provider: marker }) || "");
    const index = template.indexOf(marker);
    if (index === -1) return { before: template.trim(), after: "" };
    return { before: template.slice(0, index), after: template.slice(index + marker.length) };
  };

  const authBlocked = () =>
    (showCodexOAuthFields() && !codexUsesAPIKey() && !codexAuthStatus().logged_in) ||
    (showXAIOAuthFields() && !xai.xaiAuthReady()) ||
    (showProOAuthFields() && !pro.proAuthStatus().logged_in);
  const bedrockMissing = () =>
    (showBedrockFields() && !hasLLMFieldValue("bedrock_aws_key")) ||
    (showBedrockFields() && !hasLLMFieldValue("bedrock_aws_secret")) ||
    (showBedrockFields() && !hasLLMFieldValue("bedrock_region"));
  const llmSaveDisabled = () =>
    loading() ||
    saving() ||
    !hasLLMFieldValue("provider") ||
    !hasLLMFieldValue("model") ||
    authBlocked() ||
    (!showCodexOAuthFields() &&
      !showXAIOAuthFields() &&
      !showProOAuthFields() &&
      !showBedrockFields() &&
      setupProviderRequiresAPIKey(providerChoice()) &&
      !hasLLMFieldValue(credentialFieldName())) ||
    bedrockMissing() ||
    (showCloudflareAccountField() && !hasLLMFieldValue("cloudflare_account_id"));
  const testConnectionDisabled = () =>
    loading() ||
    saving() ||
    testConnectionLoading() ||
    !hasLLMFieldValue("provider") ||
    !hasLLMFieldValue("model") ||
    authBlocked() ||
    (!showCodexOAuthFields() &&
      !showXAIOAuthFields() &&
      !showProOAuthFields() &&
      setupProviderRequiresAPIKey(providerChoice()) &&
      !hasLLMFieldValue(credentialFieldName())) ||
    bedrockMissing() ||
    (showCloudflareAccountField() && !hasLLMFieldValue("cloudflare_api_token")) ||
    (showCloudflareAccountField() && !hasLLMFieldValue("cloudflare_account_id"));
  const personaSaveDisabled = () => loading() || saving() || String(personaForm().name || "").trim() === "";
  const soulSaveDisabled = () => loading() || saving() || (!soulEditMode() && String(soulPresetId() || "").trim() === "");

  /* ---------- the soul ---------- */

  const soulPresetCards = computed<SoulCard[]>(() =>
    (SOUL_PRESETS as (SoulCard & { titleKey: string; noteKey: string })[]).map((item, index) => ({
      ...item,
      indexLabel: String(index + 1).padStart(2, "0"),
      stackIndex: index,
      title: t(item.titleKey),
      note: t(item.noteKey),
    })),
  );
  const hasSoulSelection = () => soulSelectionKind() === "preset" || soulSelectionKind() === "custom";
  const isCustomSoulSelected = () => soulSelectionKind() === "custom";
  const soulDocumentExists = () => loadedSoulRaw() !== null;
  const customSoulCardIcon = () => (soulDocumentExists() ? "PhCpu" : "PhPlus");
  const selectedSoulCard = (): SoulCard | null => {
    if (soulSelectionKind() === "preset") return soulPresetCards().find((item) => item.id === soulPresetId()) || null;
    if (isCustomSoulSelected()) {
      return {
        id: "custom",
        icon: soulDocumentExists() ? "PhCpu" : "PhPlus",
        title: soulDocumentExists() ? t("setup_soul_existing_title") : t("setup_soul_custom_title"),
        note: "",
      };
    }
    return null;
  };
  const soulSaveVisible = () => soulEditMode() || soulSelectionKind() === "preset";
  const soulUsesCustomContent = () => soulDocumentExists();

  /* ---------- done ---------- */

  const doneStatusItems = () => [
    {
      stage: "llm" as SetupStage,
      icon: "PhGearSix",
      key: t("settings_agent_provider_label"),
      value: t("setup_done_status_ready"),
      action: t("setup_action_edit_llm"),
    },
    {
      stage: "persona" as SetupStage,
      icon: "PhUsers",
      key: t("setup_done_identity_label"),
      value: t("setup_done_status_ready"),
      action: t("setup_action_edit_persona"),
    },
    {
      stage: "soul" as SetupStage,
      icon: "PhCube",
      key: t("setup_soul_editor_label"),
      value: t("setup_done_status_ready"),
      action: t("setup_action_edit_soul"),
    },
  ];

  async function enterChat() {
    await navigate(endpointRoutePath(routeEndpointRef(), "/chat"), { replace: true });
  }

  /* ---------- loading ---------- */

  function applyPersonaRecord(record: any) {
    loadedPersonaRecord.set(record);
    const parsed = record?.profile || {};
    personaForm.set({
      name: String(parsed.name || ""),
      creature: String(parsed.creature || ""),
      vibe: String(parsed.vibe || ""),
      emoji: String(parsed.emoji || ""),
    });
  }

  function applySoulContent(raw: string | null) {
    const next = normalizeSoulDocument(raw);
    batch(() => {
      loadedSoulRaw.set(raw === null ? null : next);
      soulSelectionContent.set(next);
      soulEditorDraft.set(raw === null ? buildCustomSoulDocument() : next);
      soulPresetId.set("");
      soulSelectionKind.set(raw === null ? "" : "custom");
      soulEditMode.set(false);
    });
  }

  let personaAvatarObjectURL = "";
  function setPersonaAvatarObjectURL(nextURL: string) {
    if (personaAvatarObjectURL && personaAvatarObjectURL.startsWith("blob:")) {
      URL.revokeObjectURL(personaAvatarObjectURL);
    }
    personaAvatarObjectURL = nextURL || "";
    personaAvatarURL.set(personaAvatarObjectURL);
  }
  cleanup(() => setPersonaAvatarObjectURL(""));

  function loadSetupPersonaRecord() {
    const endpointRef = routeEndpointRef();
    return loadPersonaRecord((pathname: string, options?: any) => runtimeApiFetchForEndpoint(endpointRef, pathname, options));
  }

  function saveSetupPersonaRecord(change: { profile?: PersonaForm; soul?: string }) {
    const endpointRef = routeEndpointRef();
    return savePersonaRecord(
      (pathname: string, options?: any) => runtimeApiFetchForEndpoint(endpointRef, pathname, options),
      untracked(loadedPersonaRecord),
      change
    );
  }

  async function loadPersonaAvatar() {
    try {
      const blob = await runtimeApiDownloadForEndpoint(routeEndpointRef(), PERSONA_AVATAR_ENDPOINT);
      setPersonaAvatarObjectURL(URL.createObjectURL(blob));
    } catch (error) {
      if ((error as { status?: number })?.status === 404) {
        setPersonaAvatarObjectURL("");
      } else {
        console.warn("setup avatar:", (error as Error)?.message || error);
      }
    }
  }

  function applyLLMPayload(data: any) {
    const normalized = normalizePayload(data);
    const envManagedPayload = data?.env_managed && typeof data.env_managed === "object" ? data.env_managed : {};
    const llmEnvManagedPayload = envManagedPayload?.llm && typeof envManagedPayload.llm === "object" ? envManagedPayload.llm : {};
    const secretFieldsPayload = data?.secret_fields && typeof data.secret_fields === "object" ? data.secret_fields : {};
    batch(() => {
      loadedPayload.set(normalized);
      if (typeof data?.config_revision === "string") configRevision.set(data.config_revision);
      loadedConfigSource.set(String(data?.config_source || "defaults").trim() || "defaults");
      llmEnvManaged.set(llmEnvManagedPayload);
      llmSecretFields.set(secretFieldsPayload?.llm && typeof secretFieldsPayload.llm === "object" ? secretFieldsPayload.llm : {});
      if (untracked(loadedConfigSource) !== "config") {
        llmForm.set(emptyLLMForm());
        return;
      }
      const llm = normalized.llm as Record<string, unknown>;
      const text = (key: string) => String(llm[key] || "").trim();
      llmForm.set({
        provider: normalizeSetupProviderChoice(llm.inference_provider || llm.provider, { allowEmpty: true }),
        endpoint: text("endpoint"),
        model: text("model"),
        api_key: text("api_key"),
        bedrock_aws_key: text("bedrock_aws_key"),
        bedrock_aws_secret: text("bedrock_aws_secret"),
        bedrock_region: text("bedrock_region"),
        bedrock_model_arn: text("bedrock_model_arn"),
        cloudflare_api_token: text("cloudflare_api_token"),
        cloudflare_account_id: text("cloudflare_account_id"),
      });
    });
  }

  async function loadLLMForm() {
    batch(() => {
      loading.set(true);
      err.set("");
    });
    try {
      const payload = await endpointApiFetch(routeEndpointRef(), "/settings/agent");
      applyLLMPayload(payload);
    } catch (error) {
      err.set(errorMessage(error, "msg_load_failed"));
    } finally {
      loading.set(false);
    }
  }

  async function loadPersonaForm() {
    batch(() => {
      loading.set(true);
      err.set("");
    });
    try {
      applyPersonaRecord(await loadSetupPersonaRecord());
      await loadPersonaAvatar();
    } catch (error) {
      err.set(errorMessage(error, "msg_load_failed"));
    } finally {
      loading.set(false);
    }
  }

  async function loadSoulForm() {
    batch(() => {
      loading.set(true);
      err.set("");
    });
    try {
      const record = await loadSetupPersonaRecord();
      loadedPersonaRecord.set(record);
      applySoulContent(record.soulExists ? record.soul : null);
    } catch (error) {
      err.set(errorMessage(error, "msg_load_failed"));
    } finally {
      loading.set(false);
    }
  }

  async function loadStageForm(stage: SetupStage) {
    if (stage === "llm") return loadLLMForm();
    if (stage === "persona") return loadPersonaForm();
    if (stage === "soul") return loadSoulForm();
    await loadPersonaForm();
    await loadSoulForm();
  }

  async function replaceRoute(path: string, query: Record<string, string>) {
    await navigate(locationOf(path, query), { replace: true });
  }

  async function syncRoute(options: { loadStage?: boolean; refreshEndpoints?: boolean; onReady?: "done" } = {}) {
    const route = untracked(currentRoute);
    const currentPagePath = endpointPagePath(route.path);
    const endpointRef = routeEndpointRef();
    if (untracked(inRepairMode)) {
      if (options.loadStage !== false) await loadStageForm(untracked(routeStage));
      return;
    }
    if (options.refreshEndpoints !== false) {
      await loadEndpoints();
    }
    if (currentPagePath === "/setup") {
      const setupState = await resolveConsoleSetupStage(endpointState.items, { endpointRef });
      const target = setupStagePath(setupState.stage === "ready" ? "done" : setupState.stage, endpointRef);
      await replaceRoute(target, route.query);
      return;
    }
    if (options.onReady === "done" && currentPagePath !== "/setup/done") {
      const setupState = await resolveConsoleSetupStage(endpointState.items, { endpointRef });
      if (setupState.stage === "ready") {
        await replaceRoute(setupStagePath("done", endpointRef), route.query);
        return;
      }
    }
    if (options.loadStage !== false) {
      await loadStageForm(untracked(routeStage));
    }
  }

  async function finishStep() {
    const endpointRef = routeEndpointRef();
    if (untracked(inRepairMode)) {
      await replaceRoute(endpointRoutePath(endpointRef, "/setup"), {});
      return;
    }
    const nextStage = NEXT_STAGE[untracked(routeStage)];
    if (nextStage) {
      await replaceRoute(setupStagePath(nextStage, endpointRef), untracked(currentRoute).query);
      return;
    }
    await syncRoute({ loadStage: false, onReady: "done" });
  }

  /* ---------- saving ---------- */

  function buildLLMSettingsPayload() {
    const form = untracked(llmForm);
    const payload: Record<string, unknown> = {};
    const provider = normalizeSetupProviderChoice(untracked(() => llmFieldValue("provider")), { allowEmpty: true });
    const useCloudflareCredentials = normalizeSetupProviderChoice(form.provider) === SETUP_PROVIDER_CLOUDFLARE;
    const managed = (field: string) => untracked(() => isLLMFieldEnvManaged(field));
    const secret = (field: LLMFormField) => untracked(() => includeLLMSecret(field));
    const providerRaw = untracked(() => llmFieldEnvRawValue("provider"));
    if (providerRaw !== "") payload.provider = providerRaw;
    if (!managed("inference_provider") && providerRaw === "") payload.inference_provider = form.provider;
    if (!managed("endpoint")) {
      payload.endpoint = setupProviderSupportsCustomAPIBase(provider) ? String(form.endpoint || "").trim() : "";
    }
    if (!managed("model")) payload.model = String(form.model || "").trim();
    const clear = (fields: string[]) => {
      for (const field of fields) if (!managed(field)) payload[field] = "";
    };
    if (provider === SETUP_PROVIDER_BEDROCK) {
      if (!managed("bedrock_aws_key")) payload.bedrock_aws_key = secret("bedrock_aws_key");
      if (!managed("bedrock_aws_secret")) payload.bedrock_aws_secret = secret("bedrock_aws_secret");
      if (!managed("bedrock_region")) payload.bedrock_region = String(form.bedrock_region || "").trim();
      if (!managed("bedrock_model_arn")) payload.bedrock_model_arn = String(form.bedrock_model_arn || "").trim();
    } else if (provider === SETUP_PROVIDER_CLOUDFLARE) {
      if (!managed("cloudflare_api_token")) {
        payload.cloudflare_api_token = useCloudflareCredentials ? secret("cloudflare_api_token") : "";
      }
      if (!managed("cloudflare_account_id")) payload.cloudflare_account_id = String(form.cloudflare_account_id || "").trim();
    } else if (provider === SETUP_PROVIDER_OPENAI_CODEX) {
      if (!managed("api_key")) payload.api_key = secret("api_key");
      payload.cloudflare_api_token = "";
      payload.cloudflare_account_id = "";
      payload.bedrock_aws_key = "";
      payload.bedrock_aws_secret = "";
      payload.bedrock_region = "";
      payload.bedrock_model_arn = "";
    } else if (provider === SETUP_PROVIDER_XAI_OAUTH || provider === SETUP_PROVIDER_MISTERMORPH_PRO) {
      clear([
        "api_key",
        "cloudflare_api_token",
        "cloudflare_account_id",
        "bedrock_aws_key",
        "bedrock_aws_secret",
        "bedrock_region",
        "bedrock_model_arn",
      ]);
    } else if (!managed("api_key")) {
      payload.api_key = secret("api_key");
    }
    return payload;
  }

  function buildLLMTestPayload() {
    const form = untracked(llmForm);
    const payload: Record<string, unknown> = {};
    const managed = (field: string) => untracked(() => isLLMFieldEnvManaged(field));
    const provider = normalizeSetupProviderChoice(untracked(() => llmFieldValue("provider")), { allowEmpty: true });
    const inferenceProviderRaw = untracked(() => llmFieldEnvRawValue("inference_provider"));
    const providerRaw = untracked(() => llmFieldEnvRawValue("provider"));
    if (inferenceProviderRaw !== "") {
      payload.inference_provider = inferenceProviderRaw;
    } else if (providerRaw !== "") {
      payload.provider = providerRaw;
    } else if (!managed("inference_provider") && provider !== "") {
      payload.inference_provider = form.provider;
    }
    const copy = (field: LLMFormField) => {
      if (managed(field)) return;
      const value = String(form[field] || "").trim();
      if (value !== "") payload[field] = value;
    };
    if (!managed("endpoint")) {
      const endpoint = String(form.endpoint || "").trim();
      if (!setupProviderSupportsCustomAPIBase(provider)) payload.endpoint = "";
      else if (endpoint !== "") payload.endpoint = endpoint;
    }
    copy("model");
    const blank = ["cloudflare_api_token", "cloudflare_account_id", "bedrock_aws_key", "bedrock_aws_secret", "bedrock_region", "bedrock_model_arn"];
    if (provider === SETUP_PROVIDER_BEDROCK) {
      copy("bedrock_aws_key");
      copy("bedrock_aws_secret");
      copy("bedrock_region");
      copy("bedrock_model_arn");
    } else if (provider === SETUP_PROVIDER_CLOUDFLARE) {
      copy("cloudflare_api_token");
      copy("cloudflare_account_id");
    } else if (provider === SETUP_PROVIDER_OPENAI_CODEX) {
      copy("api_key");
      for (const field of blank) payload[field] = "";
    } else if (provider === SETUP_PROVIDER_XAI_OAUTH || provider === SETUP_PROVIDER_MISTERMORPH_PRO) {
      payload.api_key = "";
      for (const field of blank) payload[field] = "";
    } else {
      copy("api_key");
    }
    return payload;
  }

  async function saveLLM() {
    if (untracked(llmSaveDisabled)) return;
    batch(() => {
      saving.set(true);
      err.set("");
    });
    try {
      const llm = buildLLMSettingsPayload();
      if (Object.keys(llm).length === 0) {
        await finishStep();
        return;
      }
      const payload = await endpointApiFetch(routeEndpointRef(), "/settings/agent", {
        method: "PUT",
        body: { config_revision: untracked(configRevision), llm, tools: untracked(loadedPayload).tools },
      });
      applyLLMPayload(payload);
      invalidateConsoleSetupReadiness();
      await finishStep();
    } catch (error) {
      notice.error(errorMessage(error, "msg_save_failed"));
    } finally {
      saving.set(false);
    }
  }

  async function savePersona() {
    if (untracked(personaSaveDisabled)) return;
    batch(() => {
      saving.set(true);
      err.set("");
    });
    try {
      loadedPersonaRecord.set(await saveSetupPersonaRecord({ profile: untracked(personaForm) }));
      dispatchPersonaIdentityUpdated();
      invalidateConsoleSetupReadiness();
      await finishStep();
    } catch (error) {
      notice.error(errorMessage(error, "msg_save_failed"));
    } finally {
      saving.set(false);
    }
  }

  async function savePersonaAvatar(image: AdjustedImage) {
    batch(() => {
      personaAvatarBusy.set(true);
      err.set("");
    });
    try {
      await uploadPersonaAvatar(routeEndpointRef(), image);
      await loadPersonaAvatar();
      dispatchPersonaAvatarUpdated();
    } catch (error) {
      notice.error(errorMessage(error, "msg_save_failed"));
    } finally {
      personaAvatarBusy.set(false);
    }
  }

  async function deletePersonaAvatar() {
    batch(() => {
      personaAvatarBusy.set(true);
      err.set("");
    });
    try {
      await runtimeApiFetchForEndpoint(routeEndpointRef(), PERSONA_AVATAR_ENDPOINT, { method: "DELETE" });
      setPersonaAvatarObjectURL("");
      dispatchPersonaAvatarUpdated();
    } catch (error) {
      notice.error(errorMessage(error, "msg_delete_failed"));
    } finally {
      personaAvatarBusy.set(false);
    }
  }

  function fillRandomPersona() {
    if (untracked(loading) || untracked(saving)) return;
    const seed = pickRandomPersonaSeed();
    personaForm.set({ name: seed.name, emoji: seed.emoji, creature: seed.creature, vibe: seed.vibe });
    focusPersonaNameField();
  }

  async function saveSoul() {
    if (untracked(soulSaveDisabled)) return;
    batch(() => {
      saving.set(true);
      err.set("");
    });
    try {
      const source = untracked(soulEditMode) ? untracked(soulEditorDraft) : untracked(soulSelectionContent);
      const content = normalizeSoulDocument(source);
      batch(() => {
        loadedSoulRaw.set(content);
        soulSelectionContent.set(content);
        soulEditorDraft.set(content);
        soulPresetId.set("");
        soulSelectionKind.set("custom");
        soulEditMode.set(false);
      });
      loadedPersonaRecord.set(await saveSetupPersonaRecord({ soul: content }));
      invalidateConsoleSetupReadiness();
      await finishStep();
    } catch (error) {
      notice.error(errorMessage(error, "msg_save_failed"));
    } finally {
      saving.set(false);
    }
  }

  /* ---------- the provider and the pickers ---------- */

  function onProviderChange(item: { value?: string } | null) {
    const items = untracked(providerItems);
    const nextProvider = String(item?.value || "").trim() || items[0].value;
    const form = untracked(llmForm);
    const previousProvider = form.provider;
    const currentEndpoint = String(form.endpoint || "").trim();
    const next: LLMForm = { ...form, provider: nextProvider };
    if (!setupProviderSupportsCustomAPIBase(nextProvider)) {
      next.endpoint = "";
    } else if (!setupProviderSupportsCustomAPIBase(previousProvider) || currentEndpoint === "") {
      next.endpoint = "";
    }
    const normalizedProvider = normalizeSetupProviderChoice(nextProvider, { allowEmpty: true });
    if (normalizedProvider === SETUP_PROVIDER_XAI_OAUTH || normalizedProvider === SETUP_PROVIDER_MISTERMORPH_PRO) {
      Object.assign(next, {
        endpoint: "",
        api_key: "",
        cloudflare_api_token: "",
        cloudflare_account_id: "",
        bedrock_aws_key: "",
        bedrock_aws_secret: "",
        bedrock_region: "",
        bedrock_model_arn: "",
      });
      if (normalizedProvider === SETUP_PROVIDER_XAI_OAUTH) next.model = "grok-4.5";
    } else if (normalizedProvider === SETUP_PROVIDER_BEDROCK) {
      Object.assign(next, { api_key: "", cloudflare_api_token: "", cloudflare_account_id: "" });
    }
    llmForm.set(next);
  }

  function openAPIBasePicker() {
    if (!untracked(showOpenAICompatibleHelpers) || untracked(loading) || untracked(saving)) return;
    apiBasePickerOpen.set(true);
  }

  function applyAPIBaseOption(item: SetupPickerItem) {
    setLLMField("endpoint", String(item?.value || "").trim());
  }

  async function openModelPicker() {
    if (untracked(modelLookupDisabled)) return;
    batch(() => {
      modelPickerOpen.set(true);
      modelPickerLoading.set(true);
      modelPickerError.set("");
      modelPickerItems.set([]);
    });
    const provider = untracked(providerChoice);
    const credential = untracked(credentialFieldName);
    const apiKeyRaw = untracked(() => llmFieldEnvRawValue(credential));
    try {
      const payload = await endpointApiFetch(routeEndpointRef(), "/settings/agent/models", {
        method: "POST",
        body: {
          inference_provider: provider,
          cloudflare_account_id: untracked(showCloudflareAccountField) ? untracked(() => llmFieldValue("cloudflare_account_id")) : "",
          endpoint: setupProviderSupportsCustomAPIBase(provider) ? untracked(() => llmFieldValue("endpoint")) : "",
          api_key: provider === SETUP_PROVIDER_MISTERMORPH_PRO ? "" : apiKeyRaw || untracked(() => llmFieldValue(credential)),
        },
      });
      modelPickerItems.set(modelPickerItemsFromPayload(payload, currentLocale()));
    } catch (error) {
      modelPickerError.set(errorMessage(error, "msg_load_failed"));
    } finally {
      modelPickerLoading.set(false);
    }
  }

  function applyModelOption(item: SetupPickerItem) {
    setLLMField("model", String(item?.value || "").trim());
  }

  /* ---------- the connection test ---------- */

  function primeConnectionTestState(nextPayload: Record<string, unknown> | null = null) {
    const payload = nextPayload || buildLLMTestPayload();
    const targetProviderChoice = normalizeSetupProviderChoice(untracked(() => llmFieldValue("provider")), { allowEmpty: true });
    const targetEndpoint = untracked(() => llmFieldValue("endpoint"));
    const targetModel = untracked(() => llmFieldValue("model"));
    batch(() => {
      testConnectionError.set("");
      testConnectionBenchmarks.set([]);
      testConnectionMeta.set({
        provider: targetProviderChoice,
        apiBase: String(targetEndpoint || "").trim(),
        model: String(targetModel || "").trim() || String(payload.model || "").trim(),
      });
    });
    return payload;
  }

  async function openTestConnection() {
    if (untracked(testConnectionDisabled)) return;
    primeConnectionTestState();
    await openReentrantDialog(testConnectionOpen);
    await runConnectionTest();
  }

  async function runConnectionTest() {
    if (untracked(testConnectionLoading)) return;
    const nextPayload = primeConnectionTestState(buildLLMTestPayload());
    const shouldReloadCodexAuthStatus = untracked(showCodexOAuthFields) && !untracked(codexUsesAPIKey);
    testConnectionLoading.set(true);
    try {
      const payload = await endpointApiFetch(routeEndpointRef(), "/settings/agent/test", {
        method: "POST",
        body: { llm: nextPayload },
      });
      const resolvedAPIBase = String(payload?.api_base || "").trim();
      const items = Array.isArray(payload?.benchmarks) ? payload.benchmarks : [];
      batch(() => {
        testConnectionMeta.update((meta) => ({
          provider: String(payload?.provider || "").trim(),
          apiBase: resolvedAPIBase !== "" ? resolvedAPIBase : meta.apiBase,
          model: String(payload?.model || "").trim(),
        }));
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
    } catch (error) {
      testConnectionError.set(errorMessage(error, "msg_load_failed"));
    } finally {
      testConnectionLoading.set(false);
      if (shouldReloadCodexAuthStatus) void loadCodexAuthStatus();
    }
  }

  /* ---------- Codex sign-in ---------- */

  function applyCodexAuthStatus(payload: any) {
    const status = payload && typeof payload.status === "object" ? payload.status : payload;
    codexAuthStatus.set({
      logged_in: status?.logged_in === true,
      access_token_present: status?.access_token_present === true,
      refresh_token_present: status?.refresh_token_present === true,
      access_token_expired: status?.access_token_expired === true,
      expires_at: typeof status?.expires_at === "string" ? status.expires_at : "",
      account_id: typeof status?.account_id === "string" ? status.account_id : "",
      file_mode_ok: status?.file_mode_ok !== false,
      file_mode_warning: typeof status?.file_mode_warning === "string" ? status.file_mode_warning : "",
    });
  }

  async function loadCodexAuthStatus() {
    batch(() => {
      codexAuthLoading.set(true);
      codexAuthError.set("");
    });
    try {
      let payload = await endpointApiFetch(routeEndpointRef(), "/auth/codex/status");
      applyCodexAuthStatus(payload);
      const status = payload && typeof payload.status === "object" ? payload.status : payload;
      if (
        !untracked(codexUsesAPIKey) &&
        status?.refresh_token_present === true &&
        (status?.access_token_present !== true || status?.access_token_expired === true)
      ) {
        payload = await endpointApiFetch(routeEndpointRef(), "/auth/codex/refresh", { method: "POST" });
        applyCodexAuthStatus(payload);
      }
    } catch (error) {
      codexAuthError.set(errorMessage(error, "msg_load_failed"));
    } finally {
      codexAuthLoading.set(false);
    }
  }

  function clearCodexLoginTimer() {
    if (codexLoginPollTimer) {
      clearTimeout(codexLoginPollTimer);
      codexLoginPollTimer = undefined;
    }
  }
  cleanup(clearCodexLoginTimer);

  function resetCodexLoginSession() {
    clearCodexLoginTimer();
    batch(() => {
      codexLoginSession.set("");
      codexLoginVerificationURL.set("");
      codexLoginUserCode.set("");
      codexLoginExpiresAt.set("");
    });
  }

  function scheduleCodexLoginPoll(intervalSeconds: unknown = 5) {
    clearCodexLoginTimer();
    const delay = Math.max(2, Number(intervalSeconds) || 5) * 1000;
    codexLoginPollTimer = setTimeout(() => void pollCodexLogin(), delay);
  }

  async function startCodexLogin() {
    if (untracked(codexAuthBusy)) return;
    batch(() => {
      codexAuthBusy.set(true);
      codexAuthError.set("");
    });
    resetCodexLoginSession();
    try {
      const payload = await endpointApiFetch(routeEndpointRef(), "/auth/codex/login/start", { method: "POST" });
      const verificationURL = String(payload?.verification_url || "").trim();
      batch(() => {
        codexLoginSession.set(String(payload?.session_id || "").trim());
        codexLoginVerificationURL.set(verificationURL);
        codexLoginUserCode.set(String(payload?.user_code || "").trim());
        codexLoginExpiresAt.set(String(payload?.expires_at || "").trim());
      });
      if (verificationURL) openExternal(verificationURL);
      scheduleCodexLoginPoll(payload?.interval_seconds);
    } catch (error) {
      codexAuthError.set(errorMessage(error, "msg_load_failed"));
    } finally {
      codexAuthBusy.set(false);
    }
  }

  async function pollCodexLogin() {
    const sessionID = untracked(codexLoginSession);
    if (!sessionID || untracked(codexAuthBusy)) return;
    batch(() => {
      codexAuthBusy.set(true);
      codexAuthError.set("");
    });
    try {
      const payload = await endpointApiFetch(routeEndpointRef(), "/auth/codex/login/poll", {
        method: "POST",
        body: { session_id: sessionID, set_default: false },
      });
      if (payload?.pending === true) {
        scheduleCodexLoginPoll(5);
        return;
      }
      applyCodexAuthStatus(payload);
      resetCodexLoginSession();
      if (payload?.settings_updated === true) {
        invalidateConsoleSetupReadiness();
        await loadLLMForm();
      }
    } catch (error) {
      codexAuthError.set(errorMessage(error, "msg_load_failed"));
    } finally {
      codexAuthBusy.set(false);
    }
  }

  async function openCodexAuthDialog() {
    if (untracked(codexAuthDisabled)) return;
    const shouldStartLogin = untracked(codexAuthNeedsLogin) && !untracked(codexLoginSession) && !untracked(codexAuthBusy);
    await openReentrantDialog(codexAuthDialogOpen);
    void loadCodexAuthStatus();
    if (shouldStartLogin) void startCodexLogin();
  }

  async function logoutCodexAuth() {
    if (untracked(codexAuthBusy)) return;
    batch(() => {
      codexAuthBusy.set(true);
      codexAuthError.set("");
    });
    try {
      const payload = await endpointApiFetch(routeEndpointRef(), "/auth/codex/logout", { method: "POST" });
      applyCodexAuthStatus(payload);
      resetCodexLoginSession();
    } catch (error) {
      codexAuthError.set(errorMessage(error, "msg_delete_failed"));
    } finally {
      codexAuthBusy.set(false);
    }
  }

  /* ---------- the soul's choices ---------- */

  function applySoulPreset(id: string) {
    const preset = findSoulPreset(id);
    batch(() => {
      soulSelectionKind.set("preset");
      soulPresetId.set(preset.id);
      soulSelectionContent.set(preset.content);
    });
  }

  function selectCustomSoul() {
    const customSource = untracked(soulUsesCustomContent)
      ? untracked(loadedSoulRaw)
      : untracked(isCustomSoulSelected)
        ? untracked(soulSelectionContent)
        : buildCustomSoulDocument();
    batch(() => {
      soulSelectionKind.set("custom");
      soulPresetId.set("");
      soulSelectionContent.set(normalizeSoulDocument(customSource));
    });
  }

  function openSoulEditor() {
    const source = untracked(hasSoulSelection) ? untracked(soulSelectionContent) : buildCustomSoulDocument();
    batch(() => {
      soulSelectionContent.set(source);
      soulEditorDraft.set(source);
      soulEditMode.set(true);
    });
  }

  function cancelSoulEditor() {
    batch(() => {
      soulEditorDraft.set(untracked(soulSelectionContent));
      soulEditMode.set(false);
    });
  }

  function goToStage(stage: SetupStage) {
    void navigate(locationOf(setupStagePath(stage, routeEndpointRef()), untracked(currentRoute).query));
  }

  function goPrevious() {
    const previous = untracked(previousStage);
    if (previous) goToStage(previous);
  }

  function focusPersonaNameField() {
    if (untracked(routeStage) !== "persona") return;
    setTimeout(() => focusPersonaName?.(), 0);
  }

  /* ---------- watchers ---------- */

  effect(() => {
    void currentRoute().fullPath;
    untracked(() => void syncRoute().catch((error: Error) => err.set(errorMessage(error, "msg_load_failed"))));
  });

  effect(() => {
    if (routeStage() === "persona") untracked(focusPersonaNameField);
  });

  // Closing the Codex dialog abandons the sign-in.
  let codexDialogWasOpen = false;
  effect(() => {
    const open = codexAuthDialogOpen();
    untracked(() => {
      if (codexDialogWasOpen && !open) {
        resetCodexLoginSession();
        codexAuthError.set("");
      }
      codexDialogWasOpen = open;
    });
  });

  effect(() => {
    const visible = showCodexOAuthFields();
    untracked(() => {
      if (visible) {
        void loadCodexAuthStatus();
      } else {
        resetCodexLoginSession();
        codexAuthError.set("");
      }
    });
  });

  effect(() => {
    const visible = showProOAuthFields();
    untracked(() => {
      if (visible) void pro.loadProAuthStatus();
      else pro.resetProAuthFlow();
    });
  });

  effect(() => {
    const visible = showXAIOAuthFields();
    untracked(() => {
      if (visible) void xai.loadXAIAuthStatus();
      else xai.resetXAIAuthFlow();
    });
  });

  return {
    // state
    loading,
    saving,
    err,
    spriteTick,
    llmForm,
    personaForm,
    soulEditorDraft,
    soulPresetId,
    soulEditMode,
    personaAvatarURL,
    personaAvatarBusy,
    llmSecretFields,
    modelPickerOpen,
    modelPickerLoading,
    modelPickerError,
    modelPickerItems,
    apiBasePickerOpen,
    apiBasePickerItems,
    testConnectionOpen,
    testConnectionLoading,
    testConnectionError,
    testConnectionBenchmarks,
    testConnectionMeta,
    codexAuthLoading,
    codexAuthBusy,
    codexAuthError,
    codexAuthDialogOpen,
    codexAuthStatus,
    codexLoginSession,
    codexLoginVerificationURL,
    codexLoginUserCode,
    pro,
    xai,
    // derived
    setupEndpointRef,
    routeStage,
    stageMeta,
    stageTitle,
    stageIntro,
    stageKicker,
    progressSteps,
    showPrevious,
    providerItems,
    providerItem,
    providerManagedField,
    providerChoice,
    showCloudflareAccountField,
    showCodexOAuthFields,
    showXAIOAuthFields,
    showProOAuthFields,
    providerHasAuthAction,
    showBedrockFields,
    showEndpointField,
    showCredentialFields,
    showOpenAICompatibleHelpers,
    credentialLabelKey,
    credentialPlaceholderKey,
    credentialHelp,
    credentialHelpParts,
    credentialHintPlainKey,
    codexAuthSummary,
    codexAuthButtonState,
    codexAuthNeedsLogin,
    codexAuthDisabled,
    codexAuthButtonTitle,
    codexLoginExpiresLabel,
    modelLookupDisabled,
    llmFieldEnvName,
    isLLMFieldEnvManaged,
    llmFieldValue,
    llmFieldManagedDisplayValue,
    llmFieldManagedHeadline,
    llmSecretEditable,
    setupSecretRevealPath,
    llmSaveDisabled,
    testConnectionDisabled,
    personaSaveDisabled,
    soulSaveDisabled,
    soulPresetCards,
    selectedSoulCard,
    isCustomSoulSelected,
    customSoulCardIcon,
    soulSaveVisible,
    doneStatusItems,
    // actions
    setLLMField,
    setPersonaField,
    setFocusPersonaName: (fn: () => void) => {
      focusPersonaName = fn;
    },
    onProviderChange,
    openAPIBasePicker,
    applyAPIBaseOption,
    openModelPicker,
    applyModelOption,
    openTestConnection,
    runConnectionTest,
    openCodexAuthDialog,
    logoutCodexAuth,
    saveLLM,
    savePersona,
    savePersonaAvatar,
    deletePersonaAvatar,
    fillRandomPersona,
    saveSoul,
    applySoulPreset,
    selectCustomSoul,
    openSoulEditor,
    cancelSoulEditor,
    goPrevious,
    goToStage,
    enterChat,
    openExternal,
  };
}

export type SetupState = ReturnType<typeof useSetup>;
export type { Signal };
