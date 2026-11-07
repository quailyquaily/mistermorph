// Persona: the avatar, the identity (identity.yaml: name, emoji, creature, vibe) and the soul
// (soul.md). Edits go to the section save bar; the avatar saves at once, as on the Vue page.
import { Text, View } from "nsh";
import { API_BASE, authState } from "../../../lib/core/context.js";
import {
  PERSONA_AVATAR_ENDPOINT,
  PERSONA_AVATAR_MAX_SOURCE_BYTES,
  PERSONA_AVATAR_SIZE,
  PERSONA_AVATAR_SOURCE_TYPES,
} from "../../../lib/core/persona-profile.js";
import { safeJSON } from "../../../lib/core/context.js";
import { ProgressBar, TextField } from "../../../components/ui";
import { ImageUploadField, type AdjustedImage, uploadAdjustedImage } from "../../../components/settings/ImageUploadField";
import { MarkdownEditor } from "../../../components/shared/MarkdownEditor";
import { SettingField, SettingsCard } from "../../../components/settings-page/parts";
import type { SettingsStore } from "../store";
import { t } from "../i18n";

/**
 * Sends the avatar to the agent through the console's proxy as a PUT. The runtime takes WebP only
 * ("avatar must be image/webp"), so the host crops, scales and re-encodes the picked image to the
 * field's output (image/webp, PERSONA_AVATAR_SIZE square) on the way: uploadAdjustedImage passes
 * the adjustment as the upload's `image` option.
 */
async function uploadAvatar(image: AdjustedImage, endpointRef: string) {
  const query = new URLSearchParams({ endpoint: endpointRef, uri: PERSONA_AVATAR_ENDPOINT });
  const headers: Record<string, string> = {};
  if (authState.token) headers.Authorization = `Bearer ${authState.token}`;
  const result = await uploadAdjustedImage(image, {
    url: `${API_BASE}/proxy?${query.toString()}`,
    method: "PUT",
    headers: { ...headers, "Content-Type": image.type },
  });
  if (!result.ok) {
    const parsed = (result.body ? safeJSON(result.body, { error: result.body }) : {}) as { error?: string };
    const error = new Error(parsed.error || `HTTP ${result.status}`) as Error & { status?: number };
    error.status = result.status;
    throw error;
  }
}

export function PersonaSection(props: { s: SettingsStore }) {
  const s = props.s;
  const busy = () => s.personaLoading() || s.personaSaving();
  return (
    <View class="gap-5" testID="settings-persona">
      <If when={s.personaLoading()}>
        <ProgressBar indeterminate label={t("settings_persona_title")} />
      </If>
      <SettingsCard title={t("settings_persona_title")} meta={s.selectedSection()?.meta}>
        <SettingField label={t("settings_persona_avatar_title")}>
          <ImageUploadField
            previewUrl={s.personaAvatarURL()}
            disabled={s.personaAvatarDisabled()}
            busy={s.personaAvatarBusy()}
            crop
            outputSize={PERSONA_AVATAR_SIZE}
            outputType="image/webp"
            outputQuality={0.9}
            accept="image/png,image/jpeg,image/webp"
            allowedTypes={Array.from(PERSONA_AVATAR_SOURCE_TYPES as Set<string>)}
            maxBytes={PERSONA_AVATAR_MAX_SOURCE_BYTES}
            dialogTitle={t("settings_persona_avatar_title")}
            onSave={(image) => void s.savePersonaAvatar((endpointRef) => uploadAvatar(image, endpointRef))}
            onDelete={() => void s.deletePersonaAvatar()}
            testID="settings-persona-avatar"
          />
        </SettingField>
        <SettingField label={t("settings_persona_identity_name_label")}>
          <TextField
            value={s.state.persona.name}
            onChange={(value) => s.updatePersonaField("name", value)}
            placeholder={t("settings_persona_identity_name_placeholder")}
            accessibilityLabel={t("settings_persona_identity_name_label")}
            disabled={busy()}
            testID="settings-persona-name"
          />
        </SettingField>
        <View class="flex-row flex-wrap gap-4">
          <SettingField label={t("settings_persona_identity_emoji_label")} class="min-w-48 flex-1">
            <TextField
              value={s.state.persona.emoji}
              onChange={(value) => s.updatePersonaField("emoji", value)}
              placeholder={t("settings_persona_identity_emoji_placeholder")}
              accessibilityLabel={t("settings_persona_identity_emoji_label")}
              disabled={busy()}
              testID="settings-persona-emoji"
            />
          </SettingField>
          <SettingField label={t("settings_persona_identity_creature_label")} class="min-w-48 flex-1">
            <TextField
              value={s.state.persona.creature}
              onChange={(value) => s.updatePersonaField("creature", value)}
              placeholder={t("settings_persona_identity_creature_placeholder")}
              accessibilityLabel={t("settings_persona_identity_creature_label")}
              disabled={busy()}
              testID="settings-persona-creature"
            />
          </SettingField>
        </View>
        <SettingField label={t("settings_persona_identity_vibe_label")}>
          <TextField
            value={s.state.persona.vibe}
            onChange={(value) => s.updatePersonaField("vibe", value)}
            placeholder={t("settings_persona_identity_vibe_placeholder")}
            accessibilityLabel={t("settings_persona_identity_vibe_label")}
            multiline
            rows={4}
            disabled={busy()}
            testID="settings-persona-vibe"
          />
        </SettingField>
        <SettingField
          label={t("settings_persona_soul_title")}
          right={<Text class="font-mono text-xs text-muted-foreground">{s.personaEditorMeta()}</Text>}
        >
          <MarkdownEditor
            value={s.soulContent()}
            onChange={(value) => s.updatePersonaSoulContent(value)}
            height={460}
            disabled={busy()}
            placeholder={t("settings_persona_soul_placeholder")}
            accessibilityLabel={t("settings_persona_soul_title")}
            testID="settings-persona-soul"
          />
        </SettingField>
      </SettingsCard>
    </View>
  );
}
