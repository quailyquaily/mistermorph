// The form of one LLM profile (the Vue console's LLMConfigForm): provider, endpoint, credentials,
// model, description, abilities, and the advanced settings. Which fields show follows the provider:
// Cloudflare asks for an account and an API token, Bedrock for AWS keys and a region, the OAuth
// providers (Codex, xAI, Pro) for a sign-in instead of a key. A field taken from an environment
// variable shows locked, by the variable's name.
//
// Vue to nsh: each emit is an `on...` prop: `update-field` is `onUpdateField({ field, value })`,
// `open-api-base-picker` is `onOpenApiBasePicker()`, `open-model-picker` `onOpenModelPicker()`,
// `open-codex-auth` `onOpenCodexAuth()`, `open-xai-auth` `onOpenXaiAuth()`, `open-pro-auth`
// `onOpenProAuth()`.
import type { JSX } from "nsh";
import { Text, View } from "nsh";
import { Button as BaseButton } from "nsh/base";
import { CACHE_TTL_OPTIONS, IMAGE_PARTS_OPTIONS, PROFILE_ABILITY_OPTIONS } from "../../lib/core/config-options.js";
import { translate } from "../../lib/core/context.js";
import {
  hasLLMFieldValue,
  isLLMFieldEnvManaged,
  llmFieldManagedHeadline,
  llmFieldValue,
} from "../../lib/core/llm-env-managed.js";
import { profileAbilitySummaryKeys } from "../../lib/core/profile-abilities.js";
import { llmSecretConfigPath } from "../../lib/core/secret-storage.js";
import {
  normalizeSetupProviderChoice,
  resolveSetupAPIKeyHelp,
  SETUP_PROVIDER_BEDROCK,
  SETUP_PROVIDER_CLOUDFLARE,
  SETUP_PROVIDER_MISTERMORPH_PRO,
  SETUP_PROVIDER_OPENAI_CODEX,
  SETUP_PROVIDER_XAI_OAUTH,
  setupProfileAbilities,
  setupProfileDecisionOnly,
  setupProviderEvaluateOnly,
  setupProviderRequiresAPIBase,
  setupProviderSupportsAPIKey,
  setupProviderSupportsCustomAPIBase,
  setupProviderSupportsModelLookup,
} from "../../lib/core/setup-contract.js";
import { openExternal } from "../../lib/platform";
import { Button, type IconName, Icon, SelectField, TextField } from "../ui";
import { EnvManagedField } from "./EnvManagedField";
import { InferenceProviderPicker, type ProviderItem } from "./InferenceProviderPicker";
import { SecretInput, type SecretStatus } from "./SecretInput";
import { InSidePane, SettingChoices, SettingField, SettingFieldGrid, SettingSelect } from "./SettingFields";
import { isMobile } from "../../lib/shell";

const t = translate as (key: string, vars?: Record<string, unknown> | null) => string;

export interface LLMChoiceItem {
  title: string;
  value: string;
  [key: string]: unknown;
}

export type LLMAuthState = "signed-out" | "signed-in" | "loading" | "expired" | "refreshable" | string;

export interface LLMConfigFormProps {
  /** The profile's form values (strings by field: provider, inference_provider, endpoint, api_key, model, ...). */
  config: Record<string, any>;
  busy?: boolean;
  disabledReason?: string;
  /** Fields taken from environment variables: { field: { env_name, value, raw_value } }. */
  envManaged?: Record<string, any>;
  /** The config path this form's secrets sit under (llm, llm.profiles.<name>); empty when they cannot be revealed. */
  revealPrefix?: string;
  /** Secret fields' status: { api_key: { configured, source, editable }, ... }. */
  secretFields?: Record<string, SecretStatus | undefined>;
  providerItems?: ProviderItem[];
  reasoningEffortItems?: LLMChoiceItem[];
  toolsEmulationItems?: LLMChoiceItem[];
  enableAPIBasePicker?: boolean;
  enableModelPicker?: boolean;
  showAdvanced?: boolean;
  advancedOnly?: boolean;
  showAbilities?: boolean;
  /** null: decided from the form's own credentials. */
  modelLookupCredentialsReady?: boolean | null;
  readOnly?: boolean;
  showCodexAuthAction?: boolean;
  codexAuthState?: LLMAuthState;
  codexAuthTitle?: string;
  codexAuthDisabled?: boolean;
  showXAIAuthAction?: boolean;
  xaiAuthState?: LLMAuthState;
  xaiAuthTitle?: string;
  showProAuthAction?: boolean;
  proAuthState?: LLMAuthState;
  proAuthTitle?: string;
  onUpdateField?: (change: { field: string; value: string }) => void;
  onOpenApiBasePicker?: () => void;
  onOpenModelPicker?: () => void;
  onOpenCodexAuth?: () => void;
  onOpenXaiAuth?: () => void;
  onOpenProAuth?: () => void;
  testID?: string;
}

/** The sign-in button beside the provider: "Log in" while signed out, else an icon for its state. */
function AuthAction(props: {
  state: string;
  needsLogin: boolean;
  loginLabel: string;
  title: string;
  disabled?: boolean;
  refreshable?: boolean;
  testID: string;
  onPress: () => void;
}) {
  const icon = (): IconName => {
    if (props.state === "loading") return "PhArrowClockwise";
    if (props.state === "signed-in") return "PhCheckCircle";
    if (props.refreshable && props.state === "refreshable") return "PhArrowClockwise";
    return "PhXCircle";
  };
  return (
    <If
      when={props.needsLogin}
      else={
        <Button
          variant="outlined"
          size="md"
          iconOnly
          icon={icon()}
          title={props.title}
          disabled={props.disabled}
          selected={props.state === "signed-in" || props.state === "refreshable"}
          testID={props.testID}
          onPress={props.onPress}
        />
      }
    >
      <Button
        variant="outlined"
        size="md"
        label={props.loginLabel}
        title={props.title}
        disabled={props.disabled}
        testID={props.testID}
        onPress={props.onPress}
      />
    </If>
  );
}

export function LLMConfigForm(props: LLMConfigFormProps) {
  const configValue = (field: string) => {
    const value = props.config && typeof props.config === "object" ? props.config[field] : "";
    return typeof value === "string" ? value : "";
  };
  const isFieldEnvManaged = (field: string) => isLLMFieldEnvManaged(props.envManaged, field) as boolean;
  const fieldValue = (field: string) => llmFieldValue(props.config, props.envManaged, field) as string;
  const fieldManagedHeadline = (field: string) => llmFieldManagedHeadline(props.config, props.envManaged, field) as string;
  const isSecretConfigured = (field: string) => props.secretFields?.[field]?.configured === true;
  const secretPath = (field: string) => llmSecretConfigPath(props.revealPrefix || "", field) as string;

  const providerItem = () => {
    const provider = normalizeSetupProviderChoice(configValue("inference_provider") || configValue("provider"), { allowEmpty: true });
    return (props.providerItems || []).find((item) => item.value === provider) || null;
  };
  const providerManagedField = () => {
    if (isFieldEnvManaged("inference_provider")) return "inference_provider";
    if (isFieldEnvManaged("provider")) return "provider";
    return "";
  };
  const effectiveProvider = (): string =>
    normalizeSetupProviderChoice(fieldValue("inference_provider") || fieldValue("provider"), { allowEmpty: true });
  const showCloudflareAccountField = () => effectiveProvider() === SETUP_PROVIDER_CLOUDFLARE;
  const showCodexOAuthFields = () => effectiveProvider() === SETUP_PROVIDER_OPENAI_CODEX;
  const showXAIOAuthFields = () => effectiveProvider() === SETUP_PROVIDER_XAI_OAUTH;
  const showProOAuthFields = () => effectiveProvider() === SETUP_PROVIDER_MISTERMORPH_PRO;
  const showBedrockFields = () => effectiveProvider() === SETUP_PROVIDER_BEDROCK;
  const showAzureFields = () => effectiveProvider() === "azure";
  // Evaluate-only providers (TypeSafe) have only the decision ability, locked.
  const abilitiesLocked = () => Boolean(setupProviderEvaluateOnly(effectiveProvider()));
  // Evaluate-only profiles take no chat settings: no reasoning, tools, cache or headers.
  const evaluateOnly = () => Boolean(setupProfileDecisionOnly(effectiveProvider(), props.config?.abilities));
  const showEndpointField = () => Boolean(setupProviderSupportsCustomAPIBase(effectiveProvider()));
  const showCredentialFields = () =>
    !showBedrockFields() &&
    !showXAIOAuthFields() &&
    !showProOAuthFields() &&
    (showCloudflareAccountField() || Boolean(setupProviderSupportsAPIKey(effectiveProvider())));
  const credentialLabelKey = () =>
    showCloudflareAccountField() ? "settings_agent_cloudflare_api_token_label" : "settings_agent_api_key_label";
  const credentialPlaceholderKey = () =>
    showCloudflareAccountField() ? "settings_agent_cloudflare_api_token_placeholder" : "settings_agent_api_key_placeholder";
  const credentialHintKey = () => (showCloudflareAccountField() ? "setup_llm_api_token_hint" : "setup_llm_api_key_hint");
  const credentialHintPlainKey = () =>
    showCloudflareAccountField() ? "setup_llm_api_token_hint_plain" : "setup_llm_api_key_hint_plain";
  const reasoningEffortItem = () =>
    (props.reasoningEffortItems || []).find((item) => item.value === String(configValue("reasoning_effort") || "").trim()) ||
    (props.reasoningEffortItems || [])[0] ||
    null;
  const toolsEmulationItem = () =>
    (props.toolsEmulationItems || []).find((item) => item.value === String(configValue("tools_emulation_mode") || "").trim()) ||
    (props.toolsEmulationItems || [])[0] ||
    null;
  const showOpenAICompatibleHelpers = () =>
    Boolean(setupProviderSupportsModelLookup(effectiveProvider())) && Boolean(props.enableAPIBasePicker || props.enableModelPicker);
  const providerHasAuthAction = () =>
    Boolean(
      (props.showCodexAuthAction && showCodexOAuthFields()) ||
        (props.showXAIAuthAction && showXAIOAuthFields()) ||
        (props.showProAuthAction && showProOAuthFields()),
    );
  const codexAuthNeedsLogin = () => String(props.codexAuthState || "signed-out").trim() === "signed-out";
  const xaiAuthNeedsLogin = () => ["signed-out", "expired"].includes(String(props.xaiAuthState || "signed-out").trim());
  const proAuthNeedsLogin = () => ["signed-out", "expired"].includes(String(props.proAuthState || "signed-out").trim());
  const modelLookupCredentialsReady = () => {
    if (props.modelLookupCredentialsReady !== null && props.modelLookupCredentialsReady !== undefined) {
      return props.modelLookupCredentialsReady === true;
    }
    if (showProOAuthFields()) return !proAuthNeedsLogin();
    const credentialField = showCloudflareAccountField() ? "cloudflare_api_token" : "api_key";
    return hasLLMFieldValue(props.config, props.envManaged, credentialField) || isSecretConfigured(credentialField);
  };
  const modelLookupDisabled = () =>
    Boolean(
      props.busy ||
        props.readOnly ||
        !props.enableModelPicker ||
        !showOpenAICompatibleHelpers() ||
        !modelLookupCredentialsReady() ||
        (showCloudflareAccountField() && !hasLLMFieldValue(props.config, props.envManaged, "cloudflare_account_id")),
    );
  const credentialHelp = (): { title: string; url?: string } | null => {
    const provider = effectiveProvider();
    if (
      provider === "" ||
      showBedrockFields() ||
      setupProviderRequiresAPIBase(provider) ||
      isFieldEnvManaged(showCloudflareAccountField() ? "cloudflare_api_token" : "api_key")
    ) {
      return null;
    }
    return resolveSetupAPIKeyHelp(provider, fieldValue("endpoint"));
  };
  const credentialHelpParts = () => {
    const marker = "__PROVIDER__";
    const template = String(t(credentialHintKey(), { provider: marker }) || "");
    const index = template.indexOf(marker);
    if (index === -1) return { before: template.trim(), after: "" };
    return { before: template.slice(0, index), after: template.slice(index + marker.length) };
  };

  // Abilities are kept in the form as a comma-separated string. None means text, so text shows checked.
  const abilityValues = (): string[] => setupProfileAbilities(effectiveProvider(), props.config?.abilities);
  const abilitySummary = () => profileAbilitySummaryKeys(abilityValues()).map((key: string) => t(key)).join(" ");

  const busy = () => Boolean(props.busy || props.readOnly);

  const updateField = (field: string, value: unknown) => {
    if (props.readOnly) return;
    props.onUpdateField?.({ field, value: String(value || "") });
  };

  const onProviderChange = (item: ProviderItem) => {
    if (!item || typeof item !== "object") return;
    const nextProvider = String(item.value || "").trim();
    const currentProvider = String(configValue("inference_provider") || configValue("provider") || "").trim();
    const currentEndpoint = String(configValue("endpoint") || "").trim();
    updateField("inference_provider", nextProvider);
    if (
      setupProviderSupportsCustomAPIBase(nextProvider) &&
      setupProviderSupportsCustomAPIBase(currentProvider) &&
      currentEndpoint !== ""
    ) {
      return;
    }
    updateField("endpoint", "");
    const normalized = normalizeSetupProviderChoice(nextProvider, { allowEmpty: true });
    if (normalized === SETUP_PROVIDER_XAI_OAUTH || normalized === SETUP_PROVIDER_MISTERMORPH_PRO) {
      for (const field of [
        "api_key",
        "cloudflare_api_token",
        "cloudflare_account_id",
        "bedrock_aws_key",
        "bedrock_aws_secret",
        "bedrock_aws_session_token",
        "bedrock_aws_profile",
        "bedrock_region",
        "bedrock_model_arn",
      ]) {
        updateField(field, "");
      }
    }
    if (normalized === SETUP_PROVIDER_XAI_OAUTH) updateField("model", "grok-4.5");
  };

  /** A text field, or the variable it comes from. */
  const plainField = (field: string, options: { placeholder?: string; keyboardType?: "decimal-pad" | "number-pad"; multiline?: boolean; label?: string } = {}) => (
    <If when={isFieldEnvManaged(field)} else={
      <TextField
        value={String(props.config?.[field] ?? "")}
        clearable={Boolean(String(props.config?.[field] ?? ""))}
        placeholder={options.placeholder}
        keyboardType={options.keyboardType}
        multiline={options.multiline}
        mono={options.multiline}
        disabled={busy()}
        accessibilityLabel={options.label}
        testID={`llm-${field}`}
        onChange={(value) => updateField(field, value)}
      />
    }>
      <EnvManagedField name={fieldManagedHeadline(field)} />
    </If>
  );

  const secretField = (field: string, placeholder?: string, envName = true) => (
    <SecretInput
      envName={envName ? fieldManagedHeadline(field) : ""}
      value={String(props.config?.[field] ?? "")}
      status={props.secretFields?.[field]}
      revealPath={secretPath(field)}
      placeholder={placeholder}
      disabled={busy()}
      testID={`llm-${field}`}
      onChange={(value) => updateField(field, value)}
    />
  );

  const providerPicker = () => (
    <If when={!providerManagedField()} else={<EnvManagedField name={fieldManagedHeadline(providerManagedField())} />}>
      <InferenceProviderPicker
        value={providerItem()?.value || ""}
        items={props.providerItems || []}
        placeholder={t("settings_agent_provider_placeholder")}
        disabled={busy()}
        disabledReason={props.disabledReason}
        readOnly={props.readOnly}
        onChange={onProviderChange}
        testID="llm-provider"
      />
    </If>
  );

  const fieldWithAction = (field: JSX.Element, action: JSX.Element) => (
    <View class="flex-row items-center gap-2">
      <View class="flex-1 min-w-0">{field}</View>
      {action}
    </View>
  );

  return (
    <SettingFieldGrid testID={props.testID} tight>
      <If when={!props.advancedOnly}>
        <SettingField label={t("settings_agent_provider_label")} wide>
          <If when={providerHasAuthAction()} else={providerPicker()}>
            {fieldWithAction(
              providerPicker(),
              <>
                <If when={props.showCodexAuthAction && showCodexOAuthFields()}>
                  <AuthAction
                    state={String(props.codexAuthState || "signed-out")}
                    needsLogin={codexAuthNeedsLogin()}
                    loginLabel={t("settings_codex_auth_login_codex")}
                    title={props.codexAuthTitle || ""}
                    disabled={props.codexAuthDisabled}
                    testID="llm-codex-auth"
                    onPress={() => props.onOpenCodexAuth?.()}
                  />
                </If>
                <If when={props.showXAIAuthAction && showXAIOAuthFields()}>
                  <AuthAction
                    state={String(props.xaiAuthState || "signed-out")}
                    needsLogin={xaiAuthNeedsLogin()}
                    loginLabel={t("settings_xai_auth_login")}
                    title={props.xaiAuthTitle || ""}
                    disabled={props.busy}
                    refreshable
                    testID="llm-xai-auth"
                    onPress={() => props.onOpenXaiAuth?.()}
                  />
                </If>
                <If when={props.showProAuthAction && showProOAuthFields()}>
                  <AuthAction
                    state={String(props.proAuthState || "signed-out")}
                    needsLogin={proAuthNeedsLogin()}
                    loginLabel={t("settings_pro_auth_login_pro")}
                    title={props.proAuthTitle || ""}
                    disabled={props.busy}
                    refreshable
                    testID="llm-pro-auth"
                    onPress={() => props.onOpenProAuth?.()}
                  />
                </If>
              </>,
            )}
          </If>
        </SettingField>

        <If when={showEndpointField()}>
          <SettingField label={t("settings_agent_endpoint_label")} wide>
            <If
              when={props.enableAPIBasePicker && !isFieldEnvManaged("endpoint")}
              else={plainField("endpoint", { placeholder: t("settings_agent_endpoint_placeholder"), label: t("settings_agent_endpoint_label") })}
            >
              {fieldWithAction(
                <TextField
                  value={String(props.config?.endpoint ?? "")}
                  clearable={Boolean(String(props.config?.endpoint ?? ""))}
                  placeholder={t("settings_agent_endpoint_placeholder")}
                  disabled={busy()}
                  accessibilityLabel={t("settings_agent_endpoint_label")}
                  testID="llm-endpoint"
                  onChange={(value) => updateField("endpoint", value)}
                />,
                <Button
                  variant="outlined"
                  size="md"
                  iconOnly
                  icon="PhLink"
                  title={t("setup_llm_api_base_picker_title")}
                  disabled={busy() || !showOpenAICompatibleHelpers()}
                  testID="llm-api-base-picker"
                  onPress={() => props.onOpenApiBasePicker?.()}
                />,
              )}
            </If>
          </SettingField>
        </If>

        <If when={showCloudflareAccountField()}>
          <SettingField label={t("settings_agent_cloudflare_account_label")} wide>
            {plainField("cloudflare_account_id", {
              placeholder: t("settings_agent_cloudflare_account_placeholder"),
              label: t("settings_agent_cloudflare_account_label"),
            })}
          </SettingField>
        </If>

        <If when={showBedrockFields()}>
          <SettingField label={t("settings_agent_bedrock_aws_key_label")} wide>
            {secretField("bedrock_aws_key", t("settings_agent_bedrock_aws_key_placeholder"))}
          </SettingField>
          <SettingField label={t("settings_agent_bedrock_aws_secret_label")} wide>
            {secretField("bedrock_aws_secret", t("settings_agent_bedrock_aws_secret_placeholder"))}
          </SettingField>
          <SettingField label={t("settings_agent_bedrock_region_label")}>
            {plainField("bedrock_region", {
              placeholder: t("settings_agent_bedrock_region_placeholder"),
              label: t("settings_agent_bedrock_region_label"),
            })}
          </SettingField>
          <SettingField label={t("settings_agent_bedrock_model_arn_label")}>
            {plainField("bedrock_model_arn", {
              placeholder: t("settings_agent_bedrock_model_arn_placeholder"),
              label: t("settings_agent_bedrock_model_arn_label"),
            })}
          </SettingField>
        </If>

        <If when={showCredentialFields()}>
          <SettingField label={t(credentialLabelKey())}>
            <If
              when={showCloudflareAccountField()}
              else={secretField("api_key", t(credentialPlaceholderKey()))}
            >
              {secretField("cloudflare_api_token", t(credentialPlaceholderKey()))}
            </If>
            <If when={credentialHelp()}>
              <If
                when={credentialHelp()?.url}
                else={
                  <Text class="text-xs text-muted-foreground">{t(credentialHintPlainKey(), { provider: credentialHelp()?.title ?? "" })}</Text>
                }
              >
                <BaseButton
                  role="link"
                  onPress={() => openExternal(credentialHelp()?.url || "")}
                  accessibilityLabel={`${credentialHelpParts().before}${credentialHelp()?.title ?? ""}${credentialHelpParts().after}`}
                  class="flex-row flex-wrap items-center self-start rounded-(--radius) hover:bg-hover"
                  testID="llm-credential-help"
                >
                  <Text class="text-xs text-muted-foreground">
                    {credentialHelpParts().before}
                    <Text class="font-medium text-blue">{credentialHelp()?.title ?? ""}</Text>
                    {credentialHelpParts().after}
                  </Text>
                  <Icon name="PhArrowUpRight" size={12} color="blue" />
                </BaseButton>
              </If>
            </If>
          </SettingField>
        </If>

        <SettingField label={t("settings_agent_model_label")} wide={!showCredentialFields()}>
          <If when={!isFieldEnvManaged("model")} else={<EnvManagedField name={fieldManagedHeadline("model")} />}>
            {fieldWithAction(
              <TextField
                value={String(props.config?.model ?? "")}
                clearable={Boolean(String(props.config?.model ?? ""))}
                placeholder={t("settings_agent_model_placeholder")}
                disabled={busy()}
                accessibilityLabel={t("settings_agent_model_label")}
                testID="llm-model"
                onChange={(value) => updateField("model", value)}
              />,
              <If when={props.enableModelPicker}>
                <Button
                  variant="outlined"
                  size="md"
                  iconOnly
                  icon="PhMagnifyingGlass"
                  title={t("setup_llm_model_picker_title")}
                  disabled={modelLookupDisabled()}
                  testID="llm-model-picker"
                  onPress={() => props.onOpenModelPicker?.()}
                />
              </If>,
            )}
          </If>
        </SettingField>

        <SettingField label="Description" wide note="Shown to the agent when it picks a profile for a subtask.">
          <TextField
            value={String(props.config?.description ?? "")}
            clearable={Boolean(String(props.config?.description ?? ""))}
            placeholder="What this profile is good for"
            disabled={busy()}
            accessibilityLabel="Description"
            testID="llm-description"
            onChange={(value) => updateField("description", value)}
          />
        </SettingField>

        <If when={props.showAbilities}>
          <SettingField label="Abilities" wide note={abilitySummary()}>
            <SettingChoices
              value={abilityValues()}
              options={PROFILE_ABILITY_OPTIONS}
              disabledOptions={abilitiesLocked() ? PROFILE_ABILITY_OPTIONS : []}
              label="Abilities"
              disabled={busy()}
              onChange={(values) => updateField("abilities", values.join(","))}
            />
          </SettingField>
        </If>
      </If>

      <If when={props.showAdvanced && !evaluateOnly()}>
        <View class={`col-span-full gap-3 ${isMobile() || InSidePane() ? "" : "grid grid-cols-2"}`}>
          <SettingField label={t("settings_llm_reasoning_label")}>
            <If when={!isFieldEnvManaged("reasoning_effort")} else={<EnvManagedField name={fieldManagedHeadline("reasoning_effort")} />}>
              <SelectField
                items={(props.reasoningEffortItems || []).map((item) => ({ value: item.value, label: item.title }))}
                value={reasoningEffortItem()?.value ?? null}
                placeholder={t("settings_llm_reasoning_placeholder")}
                disabled={busy()}
                testID="llm-reasoning-effort"
                onChange={(value) => updateField("reasoning_effort", value)}
              />
            </If>
          </SettingField>
          <SettingField label={t("settings_llm_tools_emulation_label")}>
            <If
              when={!isFieldEnvManaged("tools_emulation_mode")}
              else={<EnvManagedField name={fieldManagedHeadline("tools_emulation_mode")} />}
            >
              <SelectField
                items={(props.toolsEmulationItems || []).map((item) => ({ value: item.value, label: item.title }))}
                value={toolsEmulationItem()?.value ?? null}
                placeholder={t("settings_llm_tools_emulation_placeholder")}
                disabled={busy()}
                testID="llm-tools-emulation"
                onChange={(value) => updateField("tools_emulation_mode", value)}
              />
            </If>
          </SettingField>
          <SettingField label={t("settings_agent_context_window_tokens_label")}>
            {plainField("context_window_tokens", {
              placeholder: t("settings_agent_context_window_tokens_placeholder"),
              keyboardType: "number-pad",
              label: t("settings_agent_context_window_tokens_label"),
            })}
          </SettingField>
        </View>
      </If>

      <If when={props.showAdvanced}>
        <If when={showBedrockFields()}>
          <SettingField label="AWS session token" wide>
            {secretField("bedrock_aws_session_token", undefined, false)}
          </SettingField>
          <SettingField label="AWS profile">
            <TextField
              value={String(props.config?.bedrock_aws_profile ?? "")}
              clearable={Boolean(String(props.config?.bedrock_aws_profile ?? ""))}
              disabled={busy()}
              accessibilityLabel="AWS profile"
              onChange={(value) => updateField("bedrock_aws_profile", value)}
            />
          </SettingField>
        </If>
        <If when={showAzureFields()}>
          <SettingField label="Azure deployment" wide>
            <TextField
              value={String(props.config?.azure_deployment ?? "")}
              clearable={Boolean(String(props.config?.azure_deployment ?? ""))}
              disabled={busy()}
              accessibilityLabel="Azure deployment"
              onChange={(value) => updateField("azure_deployment", value)}
            />
          </SettingField>
        </If>
        <If when={!evaluateOnly()}>
          <SettingField label="Supports image parts">
            <SettingSelect
              value={String(props.config?.supports_image_parts ?? "")}
              options={IMAGE_PARTS_OPTIONS}
              label="Supports image parts"
              disabled={busy()}
              onChange={(value) => updateField("supports_image_parts", value)}
            />
          </SettingField>
          <SettingField label="Cache TTL">
            <SettingSelect
              value={String(props.config?.cache_ttl ?? "")}
              options={CACHE_TTL_OPTIONS}
              allowCustom
              label="Cache TTL"
              disabled={busy()}
              onChange={(value) => updateField("cache_ttl", value)}
            />
          </SettingField>
          <SettingField label="Cache key prefix">
            <TextField
              value={String(props.config?.cache_key_prefix ?? "")}
              clearable={Boolean(String(props.config?.cache_key_prefix ?? ""))}
              disabled={busy()}
              accessibilityLabel="Cache key prefix"
              onChange={(value) => updateField("cache_key_prefix", value)}
            />
          </SettingField>
        </If>
        <SettingField label="Request timeout">
          <TextField
            value={String(props.config?.request_timeout ?? "")}
            clearable={Boolean(String(props.config?.request_timeout ?? ""))}
            placeholder="90s"
            disabled={busy()}
            accessibilityLabel="Request timeout"
            onChange={(value) => updateField("request_timeout", value)}
          />
        </SettingField>
        <If when={!evaluateOnly()}>
          <SettingField label="Temperature">
            <TextField
              value={String(props.config?.temperature ?? "")}
              clearable={Boolean(String(props.config?.temperature ?? ""))}
              keyboardType="decimal-pad"
              disabled={busy()}
              accessibilityLabel="Temperature"
              onChange={(value) => updateField("temperature", value)}
            />
          </SettingField>
          <SettingField label="Reasoning budget tokens">
            <TextField
              value={String(props.config?.reasoning_budget_tokens ?? "")}
              clearable={Boolean(String(props.config?.reasoning_budget_tokens ?? ""))}
              keyboardType="number-pad"
              disabled={busy()}
              accessibilityLabel="Reasoning budget tokens"
              onChange={(value) => updateField("reasoning_budget_tokens", value)}
            />
          </SettingField>
          <SettingField label="HTTP headers" wide>
            <TextField
              value={String(props.config?.headers_text ?? "")}
              placeholder="{}"
              multiline
              mono
              disabled={busy()}
              accessibilityLabel="HTTP headers"
              onChange={(value) => updateField("headers_text", value)}
            />
          </SettingField>
        </If>
      </If>
    </SettingFieldGrid>
  );
}
