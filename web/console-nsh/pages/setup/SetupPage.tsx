// First-run setup (the Vue console's SetupView): three steps on one sheet, each its own route
// (/e/<ref>/setup/llm, /persona, /soul, then /done): the model and its credentials, the agent's
// name and look, and its soul (a preset, or a document of one's own). Troubleshooting sends single
// steps here with ?repair=<key>; those go back to it when saved. setup-state.ts holds the logic.
import type { ImageAsset, InputRef, JSX } from "nsh";
import { Image, Scroll, Text, View, windowSize } from "nsh";
import { Button as BaseButton } from "nsh/base";
import { CodexAuthDialog, ProAuthDialog, XAIAuthDialog } from "../../components/settings/AuthDialogs";
import { EnvManagedField } from "../../components/settings/EnvManagedField";
import { ImageUploadField } from "../../components/settings/ImageUploadField";
import { InferenceProviderPicker } from "../../components/settings/InferenceProviderPicker";
import { SecretInput } from "../../components/settings/SecretInput";
import { SetupConnectionTestDialog } from "../../components/settings/SetupConnectionTestDialog";
import { SetupPickerDialog } from "../../components/settings/SetupPickerDialog";
import { MarkdownEditor } from "../../components/shared/MarkdownEditor";
import { Button, Icon, TextField, Tip, type IconName } from "../../components/ui";
import { isNetworkErrorMessage } from "../../lib/core/notices.js";
import {
  PERSONA_AVATAR_MAX_SOURCE_BYTES,
  PERSONA_AVATAR_SIZE,
  PERSONA_AVATAR_SOURCE_TYPES,
} from "../../lib/core/persona-profile.js";
import { DEFAULT_AVATAR_MARKUP } from "./default-avatar";
import { InlineNotice } from "./InlineNotice";
import { t, useSetup, type LLMFormField, type SetupStage, type SetupState, type SoulCard } from "./setup-state";

type Token = "warn" | "warn-dark" | "ok" | "blue-dark";

/** Each step's accent, as the Vue sheet tinted it. */
const STAGE_ACCENT: Record<SetupStage, Token> = {
  llm: "warn",
  persona: "ok",
  soul: "warn-dark",
  done: "blue-dark",
};

const NARROW = 620;

function FieldLabel(props: { children?: JSX.Element }) {
  return <Text class="font-mono text-sm uppercase tracking-widest text-muted-foreground">{props.children}</Text>;
}

/** A labelled field of the form. */
function Field(props: { label: string; children?: JSX.Element; class?: string; testID?: string }) {
  return (
    <View class={`gap-1.75 ${props.class ?? ""}`} testID={props.testID}>
      <FieldLabel>{props.label}</FieldLabel>
      {props.children}
    </View>
  );
}

/** Two fields side by side on wide windows, one above the other on narrow ones. */
function FieldPair(props: { children?: JSX.Element }) {
  return <View class={windowSize().width <= NARROW ? "gap-2.5" : "flex-row gap-2.5"}>{props.children}</View>;
}

/** A field with a square action button at its end. */
function FieldControl(props: { children?: JSX.Element; action?: JSX.Element }) {
  return (
    <View class="flex-row items-center gap-2">
      <View class="flex-1">{props.children}</View>
      {props.action}
    </View>
  );
}

/** The sign-in button beside the provider: "Log in" while signed out, else its state's icon. */
function AuthActionButton(props: {
  state: string;
  needsLogin: boolean;
  loginLabel: string;
  title: string;
  disabled?: boolean;
  onPress: () => void;
  testID: string;
}) {
  const icon = (): IconName =>
    props.state === "signed-in" ? "PhCheckCircle" : props.state === "loading" || props.state === "refreshable" ? "PhArrowClockwise" : "PhXCircle";
  const tone = () =>
    props.needsLogin || props.state === "signed-in" || props.state === "refreshable" || props.state === "loading"
      ? { box: "border-blue-lighter bg-selection", color: "blue" as const }
      : { box: "border-danger bg-card", color: "danger" as const };
  return (
    <BaseButton
      onPress={props.onPress}
      disabled={props.disabled}
      accessibilityLabel={props.title}
      testID={props.testID}
      tooltip={<Tip text={props.title} />}
      class={`min-h-9.5 min-w-9.5 flex-row items-center justify-center rounded-(--radius) border px-3 active:opacity-80 disabled:opacity-45 ${tone().box}`}
    >
      <If when={props.needsLogin} else={<Icon name={icon()} size={16} color={tone().color} />}>
        <Text class="text-sm font-medium text-blue">{props.loginLabel}</Text>
      </If>
    </BaseButton>
  );
}

/* ---------- the model ---------- */

function LLMStage(props: { s: SetupState }) {
  const s = props.s;
  const busy = () => s.loading() || s.saving();
  const managed = (field: string) => s.isLLMFieldEnvManaged(field);
  const credentialField = (): LLMFormField => (s.showCloudflareAccountField() ? "cloudflare_api_token" : "api_key");
  const textField = (field: LLMFormField, placeholderKey: string, testID: string) => (
    <TextField
      value={s.llmForm()[field]}
      onChange={(value) => s.setLLMField(field, value)}
      onSubmit={() => void s.saveLLM()}
      placeholder={t(placeholderKey)}
      disabled={busy()}
      testID={testID}
    />
  );
  const secretField = (field: LLMFormField, placeholderKey: string, testID: string) => (
    <SecretInput
      value={s.llmForm()[field]}
      onChange={(value) => s.setLLMField(field, value)}
      status={s.llmSecretFields()?.[field] ?? null}
      revealPath={s.setupSecretRevealPath(field)}
      placeholder={t(placeholderKey)}
      disabled={busy() || !s.llmSecretEditable(field)}
      testID={testID}
    />
  );
  const providerPicker = () => (
    <If when={!s.providerManagedField()} else={<EnvManagedField name={s.llmFieldManagedHeadline(s.providerManagedField())} />}>
      <InferenceProviderPicker
        value={s.providerItem()?.value || ""}
        items={s.providerItems()}
        placeholder={t("settings_agent_provider_placeholder")}
        disabled={busy()}
        onChange={(item) => s.onProviderChange(item)}
        testID="setup-provider"
      />
    </If>
  );
  return (
    <View class="gap-2.5 p-2" testID="setup-form-llm">
      <Field label={t("settings_agent_provider_label")}>
        <If when={s.providerHasAuthAction()} else={providerPicker()}>
          <FieldControl
            action={
              <>
                <If when={s.showCodexOAuthFields()}>
                  <AuthActionButton
                    state={s.codexAuthButtonState()}
                    needsLogin={s.codexAuthNeedsLogin()}
                    loginLabel={t("settings_codex_auth_login_codex")}
                    title={s.codexAuthButtonTitle()}
                    disabled={s.codexAuthDisabled()}
                    onPress={() => void s.openCodexAuthDialog()}
                    testID="setup-codex-auth"
                  />
                </If>
                <If when={s.showXAIOAuthFields()}>
                  <AuthActionButton
                    state={s.xai.xaiAuthButtonState()}
                    needsLogin={s.xai.xaiAuthNeedsLogin()}
                    loginLabel={t("settings_xai_auth_login")}
                    title={s.xai.xaiAuthButtonTitle()}
                    disabled={busy()}
                    onPress={() => void s.xai.openXAIAuthDialog()}
                    testID="setup-xai-auth"
                  />
                </If>
                <If when={s.showProOAuthFields()}>
                  <AuthActionButton
                    state={s.pro.proAuthButtonState()}
                    needsLogin={s.pro.proAuthNeedsLogin()}
                    loginLabel={t("settings_pro_auth_login_pro")}
                    title={s.pro.proAuthButtonTitle()}
                    disabled={busy()}
                    onPress={() => void s.pro.openProAuthDialog()}
                    testID="setup-pro-auth"
                  />
                </If>
              </>
            }
          >
            {providerPicker()}
          </FieldControl>
        </If>
      </Field>

      <If when={s.showEndpointField()}>
        <Field label={t("settings_agent_endpoint_label")}>
          <If when={!managed("endpoint")} else={<EnvManagedField name={s.llmFieldManagedHeadline("endpoint")} />}>
            <FieldControl
              action={
                <Button
                  variant="outlined"
                  size="md"
                  iconOnly
                  icon="PhLink"
                  title={t("setup_llm_api_base_picker_title")}
                  disabled={!s.showOpenAICompatibleHelpers() || busy()}
                  onPress={s.openAPIBasePicker}
                  testID="setup-api-base-picker"
                />
              }
            >
              {textField("endpoint", "settings_agent_endpoint_placeholder", "setup-endpoint")}
            </FieldControl>
          </If>
        </Field>
      </If>

      <If when={s.showCloudflareAccountField()}>
        <Field label={t("settings_agent_cloudflare_account_label")}>
          <If
            when={!managed("cloudflare_account_id")}
            else={<EnvManagedField name={s.llmFieldManagedHeadline("cloudflare_account_id")} />}
          >
            {textField("cloudflare_account_id", "settings_agent_cloudflare_account_placeholder", "setup-cloudflare-account")}
          </If>
        </Field>
      </If>

      <If when={s.showBedrockFields()}>
        <Field label={t("settings_agent_bedrock_aws_key_label")}>
          <If when={!managed("bedrock_aws_key")} else={<EnvManagedField name={s.llmFieldManagedHeadline("bedrock_aws_key")} />}>
            {secretField("bedrock_aws_key", "settings_agent_bedrock_aws_key_placeholder", "setup-bedrock-key")}
          </If>
        </Field>
        <Field label={t("settings_agent_bedrock_aws_secret_label")}>
          <If when={!managed("bedrock_aws_secret")} else={<EnvManagedField name={s.llmFieldManagedHeadline("bedrock_aws_secret")} />}>
            {secretField("bedrock_aws_secret", "settings_agent_bedrock_aws_secret_placeholder", "setup-bedrock-secret")}
          </If>
        </Field>
        <FieldPair>
          <Field label={t("settings_agent_bedrock_region_label")} class="flex-1">
            <If when={!managed("bedrock_region")} else={<EnvManagedField name={s.llmFieldManagedHeadline("bedrock_region")} />}>
              {textField("bedrock_region", "settings_agent_bedrock_region_placeholder", "setup-bedrock-region")}
            </If>
          </Field>
          <Field label={t("settings_agent_bedrock_model_arn_label")} class="flex-1">
            <If when={!managed("bedrock_model_arn")} else={<EnvManagedField name={s.llmFieldManagedHeadline("bedrock_model_arn")} />}>
              {textField("bedrock_model_arn", "settings_agent_bedrock_model_arn_placeholder", "setup-bedrock-arn")}
            </If>
          </Field>
        </FieldPair>
      </If>

      <If when={s.showCredentialFields()}>
        <Field label={t(s.credentialLabelKey())}>
          <If when={!managed(credentialField())} else={<EnvManagedField name={s.llmFieldManagedHeadline(credentialField())} />}>
            <If
              when={s.showCloudflareAccountField()}
              else={secretField("api_key", s.credentialPlaceholderKey(), "setup-api-key")}
            >
              {secretField("cloudflare_api_token", s.credentialPlaceholderKey(), "setup-cloudflare-token")}
            </If>
          </If>
          <If when={s.credentialHelp()}>
            {(help) => (
              <View class="h-4 flex-row items-center justify-end">
                <If
                  when={help().url}
                  else={
                    <Text class="text-xs text-muted-foreground">{t(s.credentialHintPlainKey(), { provider: help().title })}</Text>
                  }
                >
                  <BaseButton
                    onPress={() => s.openExternal(String(help().url))}
                    accessibilityLabel={`${s.credentialHelpParts()?.before ?? ""}${help().title}${s.credentialHelpParts()?.after ?? ""}`}
                    testID="setup-credential-help"
                    class="group flex-row items-center gap-1.5"
                  >
                    <Text class="text-xs text-muted-foreground group-hover:text-foreground">
                      {s.credentialHelpParts()?.before}
                      <Text class={`font-semibold text-${STAGE_ACCENT.llm}`}>{help().title}</Text>
                      {s.credentialHelpParts()?.after}
                    </Text>
                    <Icon name="PhArrowUpRight" size={13} color="muted-foreground" />
                  </BaseButton>
                </If>
              </View>
            )}
          </If>
        </Field>
      </If>

      <Field label={t("settings_agent_model_label")}>
        <If when={!managed("model")} else={<EnvManagedField name={s.llmFieldManagedHeadline("model")} />}>
          <FieldControl
            action={
              <Button
                variant="outlined"
                size="md"
                iconOnly
                icon="PhMagnifyingGlass"
                title={t("setup_llm_model_picker_title")}
                disabled={s.modelLookupDisabled()}
                onPress={() => void s.openModelPicker()}
                testID="setup-model-picker"
              />
            }
          >
            {textField("model", "settings_agent_model_placeholder", "setup-model")}
          </FieldControl>
        </If>
      </Field>

      <StageError s={s} />

      <View class="mt-1.5 flex-row flex-wrap items-end justify-between gap-3">
        <Button
          variant="outlined"
          size="md"
          label={t("setup_llm_test_button")}
          disabled={s.testConnectionDisabled()}
          onPress={() => void s.openTestConnection()}
          class="min-w-37"
          testID="setup-test-connection"
        />
        <SubmitButton s={s} disabled={s.llmSaveDisabled()} onPress={() => void s.saveLLM()} />
      </View>
    </View>
  );
}

function StageError(props: { s: SetupState }) {
  return (
    <If when={props.s.err() && !isNetworkErrorMessage(props.s.err())}>
      <InlineNotice type="error" text={props.s.err()} class="mt-0.5" testID="setup-error" />
    </If>
  );
}

function SubmitButton(props: { s: SetupState; disabled: boolean; onPress: () => void }) {
  return (
    <Button
      variant="primary"
      size="md"
      label={t(props.s.stageMeta().submitKey || "setup_action_continue")}
      loading={props.s.saving()}
      disabled={props.disabled}
      onPress={props.onPress}
      class={`min-w-33 justify-center ${windowSize().width <= NARROW ? "self-stretch" : ""}`}
      testID="setup-submit"
    />
  );
}

function PreviousButton(props: { s: SetupState }) {
  return (
    <If when={props.s.showPrevious()}>
      <Button variant="outlined" size="md" label={t("setup_action_previous")} onPress={props.s.goPrevious} testID="setup-previous" />
    </If>
  );
}

/* ---------- the persona ---------- */

function PersonaStage(props: { s: SetupState }) {
  const s = props.s;
  const field = (name: "name" | "emoji" | "creature", placeholderKey: string, testID: string, ref?: (node: InputRef) => void) => (
    <TextField
      value={s.personaForm()[name]}
      onChange={(value) => s.setPersonaField(name, value)}
      onSubmit={() => void s.savePersona()}
      placeholder={t(placeholderKey)}
      disabled={s.saving()}
      testID={testID}
      inputRef={ref}
    />
  );
  return (
    <View class="gap-2.5 p-2" testID="setup-form-persona">
      <Field label={t("settings_persona_avatar_title")}>
        <View style={{ maxWidth: 520 }}>
          <ImageUploadField
            previewUrl={s.personaAvatarURL()}
            defaultMarkup={DEFAULT_AVATAR_MARKUP}
            disabled={s.loading() || s.saving()}
            busy={s.personaAvatarBusy()}
            crop
            outputSize={PERSONA_AVATAR_SIZE}
            outputType="image/webp"
            outputQuality={0.9}
            accept="image/png,image/jpeg,image/webp"
            allowedTypes={Array.from(PERSONA_AVATAR_SOURCE_TYPES as Set<string>)}
            maxBytes={PERSONA_AVATAR_MAX_SOURCE_BYTES}
            dialogTitle={t("settings_persona_avatar_title")}
            onSave={(image) => void s.savePersonaAvatar(image)}
            onDelete={() => void s.deletePersonaAvatar()}
            testID="setup-avatar"
          />
        </View>
      </Field>
      <Field label={t("setup_identity_name_label")}>
        {field("name", "setup_identity_name_placeholder", "setup-persona-name", (node) => s.setFocusPersonaName(() => node.focus()))}
      </Field>
      <FieldPair>
        <Field label={t("setup_identity_emoji_label")} class="flex-1">
          {field("emoji", "setup_identity_emoji_placeholder", "setup-persona-emoji")}
        </Field>
        <Field label={t("setup_identity_creature_label")} class="flex-1">
          {field("creature", "setup_identity_creature_placeholder", "setup-persona-creature")}
        </Field>
      </FieldPair>
      <Field label={t("setup_identity_vibe_label")}>
        <TextField
          value={s.personaForm().vibe}
          onChange={(value) => s.setPersonaField("vibe", value)}
          multiline
          rows={3}
          placeholder={t("setup_identity_vibe_placeholder")}
          disabled={s.saving()}
          testID="setup-persona-vibe"
          inputClass="min-h-24"
        />
      </Field>

      <StageError s={s} />

      <View class="mt-1.5 flex-row items-center gap-3">
        <View class="flex-1 flex-row">
          <PreviousButton s={s} />
        </View>
        <Button
          variant="outlined"
          size="md"
          iconOnly
          icon="PhDiceFive"
          title={t("setup_persona_randomize")}
          disabled={s.loading() || s.saving()}
          onPress={s.fillRandomPersona}
          class="size-10"
          testID="setup-persona-random"
        />
        <View class="flex-1 flex-row justify-end">
          <SubmitButton s={s} disabled={s.personaSaveDisabled()} onPress={() => void s.savePersona()} />
        </View>
      </View>
    </View>
  );
}

/* ---------- the soul ---------- */

/** A preset's sprite sheet, walking: one frame of its first row at a time, scaled up. */
function SoulSprite(props: { card: SoulCard; tick: number }) {
  const frameWidth = () => Number(props.card.spriteFrameWidth) || 16;
  const frameHeight = () => Number(props.card.spriteFrameHeight) || 16;
  const scale = () => Number(props.card.spriteScale) || 5;
  const frame = () => props.tick % Math.max(Number(props.card.spriteFrames) || 1, 1);
  const sheet = () => props.card.spriteSrc as ImageAsset;
  return (
    <View
      accessibilityElementsHidden
      class="overflow-hidden"
      style={{ width: frameWidth() * scale(), height: frameHeight() * scale() }}
    >
      <Image
        src={sheet()}
        style={{
          width: (sheet()?.size?.width || frameWidth()) * scale(),
          height: (sheet()?.size?.height || frameHeight()) * scale(),
          transform: [{ translateX: -frame() * frameWidth() * scale() }],
        }}
      />
    </View>
  );
}

function SoulStage(props: { s: SetupState }) {
  const s = props.s;
  const accent = STAGE_ACCENT.soul;
  const cards = () => s.soulPresetCards();
  const stackStyle = (active: boolean, order: number) => ({
    width: Math.max(82, Math.min(118, windowSize().width * 0.17)),
    minHeight: 168,
    marginLeft: order === 0 ? 0 : -22,
    zIndex: active ? 40 : 10 + order,
    transform: active ? [{ translateY: -12 }, { scale: 1.02 }] : [{ translateY: 18 }, { scale: 0.94 }],
    transitionProperty: "transform",
    transitionDuration: 180,
  });
  return (
    <View class="gap-2.5 p-2" testID="setup-form-soul">
      <If
        when={!s.soulEditMode()}
        else={
          <View class="gap-2.5" testID="setup-soul-editor">
            <View class="flex-row items-center justify-between gap-3">
              <FieldLabel>{t("setup_soul_editor_label")}</FieldLabel>
              <Button variant="plain" label={t("action_cancel")} onPress={s.cancelSoulEditor} testID="setup-soul-editor-cancel" />
            </View>
            <MarkdownEditor
              value={s.soulEditorDraft()}
              onChange={(value) => s.soulEditorDraft.set(value)}
              disabled={s.saving()}
              height={360}
              hint={t("setup_soul_editor_hint")}
              accessibilityLabel={t("setup_soul_editor_label")}
              testID="setup-soul-markdown"
            />
          </View>
        }
      >
        <View class="gap-3">
          <If when={s.selectedSoulCard()}>
            {(card) => (
              <View class="items-center gap-2.25 px-3 pb-2 pt-0.5" testID="setup-soul-spotlight">
                <If
                  when={card().spriteSrc}
                  else={
                    <View class={`size-9.5 items-center justify-center rounded-(--radius) border border-line bg-card`}>
                      <Icon name={card().icon as IconName} size={18} color={accent} />
                    </View>
                  }
                >
                  <SoulSprite card={card()} tick={s.spriteTick()} />
                </If>
                <Text class="text-center text-base font-semibold text-foreground">{card().title}</Text>
                <If when={card().note}>
                  <Text class="max-w-72 text-center text-xs text-muted-foreground">{card().note}</Text>
                </If>
                <If when={s.isCustomSoulSelected()}>
                  <Button
                    variant="outlined"
                    size="xs"
                    label={t("setup_action_edit_soul")}
                    onPress={s.openSoulEditor}
                    class="self-center"
                    testID="setup-soul-edit"
                  />
                </If>
              </View>
            )}
          </If>
          <View class="min-h-52 flex-row items-start justify-center px-2.5 pb-1.5 pt-3.5" testID="setup-soul-cards">
            <Each of={cards()} key={(card) => card.id}>
              {(card) => (
                <BaseButton
                  selected={s.soulPresetId() === card().id}
                  onPress={() => s.applySoulPreset(card().id)}
                  accessibilityLabel={card().title}
                  testID={`setup-soul-${card().id}`}
                  class={`items-center justify-center gap-2 rounded-(--radius) border px-2.5 py-3 shadow-sm hover:bg-card ${
                    s.soulPresetId() === card().id ? `border-${accent} bg-card` : "border-line-soft bg-paper"
                  }`}
                  style={stackStyle(s.soulPresetId() === card().id, card().stackIndex ?? 0)}
                >
                  <View class="size-8.5 items-center justify-center overflow-hidden rounded-(--radius) border border-line bg-card">
                    <If when={card().faceSrc} else={<Icon name={card().icon as IconName} size={18} color={accent} />}>
                      <Image src={card().faceSrc as ImageAsset} accessibilityElementsHidden style={{ width: 38, height: 38 }} />
                    </If>
                  </View>
                  <Text class="text-center text-sm font-semibold text-foreground">{card().title}</Text>
                </BaseButton>
              )}
            </Each>
            <BaseButton
              selected={s.isCustomSoulSelected()}
              onPress={s.selectCustomSoul}
              accessibilityLabel={t("setup_soul_custom_title")}
              testID="setup-soul-custom"
              class={`items-center justify-center gap-2 rounded-(--radius) border px-2.5 py-3 shadow-sm hover:bg-card ${
                s.isCustomSoulSelected() ? `border-${accent} bg-card` : "border-line-soft bg-paper"
              }`}
              style={stackStyle(s.isCustomSoulSelected(), cards().length)}
            >
              <View class="size-8.5 items-center justify-center rounded-(--radius) border border-dashed border-line bg-card">
                <Icon name={s.customSoulCardIcon() as IconName} size={18} color={accent} />
              </View>
              <View class="w-full items-center gap-1.75 pt-1" accessibilityElementsHidden>
                <View class="h-1.75 w-[62%] rounded-full bg-line-faint" />
                <View class="h-1.75 w-[82%] rounded-full bg-line-faint" />
              </View>
            </BaseButton>
          </View>
        </View>
      </If>

      <StageError s={s} />

      <View class="mt-1.5 flex-row flex-wrap items-end justify-between gap-3">
        <View class="flex-row">
          <PreviousButton s={s} />
        </View>
        <If when={s.soulSaveVisible()}>
          <SubmitButton s={s} disabled={s.soulSaveDisabled()} onPress={() => void s.saveSoul()} />
        </If>
      </View>
    </View>
  );
}

/* ---------- done ---------- */

function DoneStage(props: { s: SetupState }) {
  const s = props.s;
  const accent = STAGE_ACCENT.done;
  return (
    <View class="gap-2.5 p-2" testID="setup-form-done">
      <View class="gap-2.5">
        <FieldLabel>{t("setup_done_status_label")}</FieldLabel>
        <View class="border-t border-line-faint">
          <Each of={s.doneStatusItems()} key={(item) => item.stage}>
            {(item) => (
              <View class="flex-row items-center justify-between gap-3 border-b border-line-faint py-2.75">
                <View class="flex-row items-center gap-2">
                  <Icon name={item().icon as IconName} size={16} color="muted-foreground" />
                  <Text class="font-mono text-xs uppercase tracking-widest text-muted-foreground">{item().key}</Text>
                </View>
                <View class="flex-row items-center gap-2.5">
                  <Text class={`text-sm font-semibold text-${accent}`}>{item().value}</Text>
                  <Button
                    variant="plain"
                    size="xs"
                    iconOnly
                    icon="PhPencilSimple"
                    title={item().action}
                    onPress={() => s.goToStage(item().stage)}
                    testID={`setup-done-edit-${item().stage}`}
                  />
                </View>
              </View>
            )}
          </Each>
        </View>
      </View>
      <View class="mt-1.5 flex-row justify-center">
        <Button
          variant="primary"
          size="md"
          label={t("setup_action_enter_chat")}
          onPress={() => void s.enterChat()}
          class="min-w-33 justify-center"
          testID="setup-enter-chat"
        />
      </View>
    </View>
  );
}

/* ---------- the sheet ---------- */

export function SetupPage() {
  const s = useSetup();
  const accent = () => STAGE_ACCENT[s.stageMeta().tone];
  const narrow = () => windowSize().width <= NARROW;
  return (
    <View class="flex-1 bg-background" testID="setup-page">
      <Scroll class="flex-1" contentClass={`grow items-center justify-center ${narrow() ? "p-4" : "p-6"}`}>
        <View
          class={`w-full rounded-(--radius) border border-line-faint bg-card ${narrow() ? "p-3" : "p-4.5"}`}
          style={{ maxWidth: 640 }}
          testID={`setup-stage-${s.routeStage()}`}
        >
          <View class="gap-2 p-2">
            <Text class="font-mono text-xs uppercase tracking-wide text-muted-foreground" testID="setup-kicker">
              {s.stageKicker()}
            </Text>
            <View class="flex-row gap-1.5" accessibilityElementsHidden>
              <Each of={s.progressSteps()} key={(step) => step.index}>
                {(step) => <View class={`h-1 flex-1 rounded-full ${step().active ? `bg-${accent()}` : "bg-line-faint"}`} />}
              </Each>
            </View>
            <Text role="header" class="text-3xl font-semibold text-foreground" style={{ maxWidth: narrow() ? undefined : 360 }}>
              {s.stageTitle()}
            </Text>
            <If when={s.stageIntro()}>
              <Text class="text-base text-muted-foreground">{s.stageIntro()}</Text>
            </If>
          </View>

          <Each of={[s.routeStage()]} key={(stage) => stage}>
            {(stage) =>
              stage() === "llm" ? (
                <LLMStage s={s} />
              ) : stage() === "persona" ? (
                <PersonaStage s={s} />
              ) : stage() === "soul" ? (
                <SoulStage s={s} />
              ) : (
                <DoneStage s={s} />
              )
            }
          </Each>
        </View>
      </Scroll>

      <SetupPickerDialog
        open={s.apiBasePickerOpen()}
        onOpenChange={(open) => s.apiBasePickerOpen.set(open)}
        items={s.apiBasePickerItems()}
        loading={false}
        error=""
        title={t("setup_llm_api_base_picker_title")}
        filterPlaceholder={t("setup_llm_api_base_picker_filter_placeholder")}
        emptyText={t("setup_llm_api_base_picker_empty")}
        onSelect={(item) => s.applyAPIBaseOption(item)}
      />
      <SetupPickerDialog
        open={s.modelPickerOpen()}
        onOpenChange={(open) => s.modelPickerOpen.set(open)}
        items={s.modelPickerItems()}
        loading={s.modelPickerLoading()}
        error={s.modelPickerError()}
        title={t("setup_llm_model_picker_title")}
        filterPlaceholder={t("setup_llm_model_picker_filter_placeholder")}
        emptyText={t("setup_llm_model_picker_empty")}
        showValue={false}
        selectedValue={s.llmForm().model}
        groupByPrefix
        allowCustom
        customLabel={t("setup_llm_model_picker_custom")}
        onSelect={(item) => s.applyModelOption(item)}
      />
      <SetupConnectionTestDialog
        open={s.testConnectionOpen()}
        onOpenChange={(open) => s.testConnectionOpen.set(open)}
        loading={s.testConnectionLoading()}
        error={s.testConnectionError()}
        benchmarks={s.testConnectionBenchmarks()}
        provider={s.testConnectionMeta().provider}
        apiBase={s.testConnectionMeta().apiBase}
        model={s.testConnectionMeta().model}
        showIntro={false}
        onRetry={() => void s.runConnectionTest()}
      />
      <CodexAuthDialog
        open={s.codexAuthDialogOpen()}
        onOpenChange={(open) => s.codexAuthDialogOpen.set(open)}
        loading={s.codexAuthLoading()}
        busy={s.codexAuthBusy()}
        error={s.codexAuthError()}
        status={s.codexAuthStatus()}
        summary={s.codexAuthSummary()}
        loginSession={s.codexLoginSession()}
        verificationURL={s.codexLoginVerificationURL()}
        userCode={s.codexLoginUserCode()}
        loginExpiresLabel={s.codexLoginExpiresLabel()}
        onLogout={() => void s.logoutCodexAuth()}
      />
      <XAIAuthDialog
        open={s.xai.xaiAuthDialogOpen()}
        onOpenChange={(open) => s.xai.xaiAuthDialogOpen.set(open)}
        setDefault={s.xai.xaiSetDefault()}
        onSetDefaultChange={(value) => s.xai.xaiSetDefault.set(value)}
        loading={s.xai.xaiAuthLoading()}
        busy={s.xai.xaiAuthBusy()}
        error={s.xai.xaiAuthError()}
        status={s.xai.xaiAuthStatus()}
        summary={s.xai.xaiAuthSummary()}
        loginSession={s.xai.xaiLoginSession()}
        verificationURL={s.xai.xaiLoginVerificationURL()}
        userCode={s.xai.xaiLoginUserCode()}
        loginExpiresLabel={s.xai.xaiLoginExpiresLabel()}
        onLogin={() => s.xai.reloginXAIAuth()}
        onLogout={() => void s.xai.logoutXAIAuth()}
      />
      <ProAuthDialog
        open={s.pro.proAuthDialogOpen()}
        onOpenChange={(open) => s.pro.proAuthDialogOpen.set(open)}
        loading={s.pro.proAuthLoading()}
        busy={s.pro.proAuthBusy()}
        error={s.pro.proAuthError()}
        status={s.pro.proAuthStatus()}
        summary={s.pro.proAuthSummary()}
        loginSession={s.pro.proLoginSession()}
        verificationURL={s.pro.proLoginVerificationURL()}
        userCode={s.pro.proLoginUserCode()}
        loginExpiresLabel={s.pro.proLoginExpiresLabel()}
        onLogout={() => void s.pro.logoutProAuth()}
      />
    </View>
  );
}
