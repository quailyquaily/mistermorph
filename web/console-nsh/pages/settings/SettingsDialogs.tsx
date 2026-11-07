// The Settings page's dialogs: Add Profile, a section's Advanced settings, the API base and model
// pickers, a tool's schema, the connection test, the sign-in dialogs, and deleting a profile.
import { cleanup, signal, Text, untracked, View } from "nsh";
import { MessageDialog, TextField } from "../../components/ui";
import { CodexAuthDialog, ProAuthDialog, XAIAuthDialog } from "../../components/settings/AuthDialogs";
import {
  ConfigSettingsPanel,
  type SettingsSaveEntry,
  SettingsSaveRegistryContext,
} from "../../components/settings/ConfigSettingsPanel";
import { LLMConfigForm } from "../../components/settings/LLMConfigForm";
import { SettingDialog } from "../../components/settings/SettingDialog";
import { SetupConnectionTestDialog } from "../../components/settings/SetupConnectionTestDialog";
import { SetupPickerDialog } from "../../components/settings/SetupPickerDialog";
import { RawJsonDialog } from "../../components/shared/RawJsonDialog";
import { SettingField } from "../../components/settings-page/parts";
import { t } from "./i18n";
import type { SettingsStore } from "./store";

/**
 * The Advanced dialog's settings. Its panel saves from the dialog's Save button: the panel registers
 * with a registry of the dialog's own (not the page's save bar), and Save takes its changes.
 */
function AdvancedSettingsBody(props: { s: SettingsStore }) {
  const s = props.s;
  let entry: SettingsSaveEntry | null = null;
  const registry = {
    register(next: SettingsSaveEntry) {
      entry = next;
    },
    unregister(key: string) {
      if (entry?.key === key) entry = null;
    },
  };
  s.registerAdvancedPanelSave(() => {
    if (!entry) return;
    let update;
    try {
      update = entry.collectUpdate();
    } catch (error) {
      // The panel shows what is invalid.
      console.warn("settings: advanced settings are invalid", (error as Error)?.message || error);
      return;
    }
    if (update) void s.saveAdvancedConfigSettings(update);
  });
  cleanup(() => s.registerAdvancedPanelSave(null));
  return (
    <SettingsSaveRegistryContext.Provider value={registry}>
      <ConfigSettingsPanel
        groups={s.advancedSettingsGroups()}
        values={s.advancedSettingsValues()}
        fieldStates={s.advancedSettingsFieldStates()}
        loading={s.advancedSettingsLoading()}
        saving={s.advancedSettingsSaving()}
        embedded
        hideSingleGroupHeading
        savePlacement="none"
        saveScope="advanced"
        onDirtyChange={(dirty) => s.advancedSettingsDirty.set(dirty)}
        testID="settings-advanced-panel"
      />
    </SettingsSaveRegistryContext.Provider>
  );
}

export function SettingsDialogs(props: { s: SettingsStore }) {
  const s = props.s;
  const agentBusy = () => s.agentLoading() || s.agentSaving();
  return (
    <>
      <SettingDialog
        open={s.addProfileOpen()}
        onOpenChange={(open) => {
          if (!open) s.cancelAddProfile();
        }}
        title={t("settings_agent_profile_add")}
        size="lg"
        saving={s.addProfileSaving()}
        saveDisabled={s.addProfileSaveDisabled()}
        onSave={() => void s.createProfile()}
        testID="settings-add-profile"
      >
        <If when={s.addProfileDraft()}>
          {(draft) => (
            <View class="gap-4">
              <SettingField label={t("settings_agent_profile_name_label")}>
                <TextField
                  value={draft().name}
                  clearable={Boolean(draft().name)}
                  onChange={(value) => s.updateProfileField(untracked(draft)._key, { field: "name", value })}
                  placeholder={t("settings_agent_profile_name_placeholder")}
                  accessibilityLabel={t("settings_agent_profile_name_label")}
                  disabled={s.agentSaving() || s.agentSettingsReadOnly()}
                  error={s.addProfileError()}
                  autoFocus
                  testID="settings-add-profile-name"
                />
              </SettingField>
              <LLMConfigForm
                config={draft()}
                showAbilities
                busy={agentBusy()}
                disabledReason={s.agentFormDisabledReason()}
                readOnly={s.agentSettingsReadOnly()}
                envManaged={s.llmProfileEnvManaged(draft())}
                secretFields={s.llmProfileSecretFields(draft())}
                providerItems={s.providerItems}
                reasoningEffortItems={s.reasoningEffortItems()}
                toolsEmulationItems={s.toolsEmulationItems()}
                enableModelPicker
                modelLookupCredentialsReady={s.profileModelLookupCredentialsReady(draft())}
                showCodexAuthAction={s.profileUsesCodexProvider(draft())}
                codexAuthDisabled={s.profileCodexAuthDisabled(draft())}
                codexAuthState={s.codexAuth.buttonState()}
                codexAuthTitle={s.codexAuth.buttonTitle()}
                showXAIAuthAction={s.profileUsesXAIProvider(draft())}
                xaiAuthState={s.xaiAuth.buttonState()}
                xaiAuthTitle={s.xaiAuth.buttonTitle()}
                showProAuthAction={s.profileUsesProProvider(draft())}
                proAuthState={s.proAuth.buttonState()}
                proAuthTitle={s.proAuth.buttonTitle()}
                onUpdateField={(change) => s.updateProfileField(untracked(draft)._key, change)}
                onOpenModelPicker={() => void s.openModelPicker(untracked(draft)._key)}
                onOpenCodexAuth={() => void s.codexAuth.openDialog()}
                onOpenXaiAuth={() => void s.xaiAuth.openDialog()}
                onOpenProAuth={() => void s.proAuth.openDialog()}
              />
            </View>
          )}
        </If>
      </SettingDialog>

      <SettingDialog
        open={s.advancedSettingsOpen()}
        onOpenChange={(open) => {
          if (!open) s.closeAdvancedSettings();
        }}
        title={s.advancedSettingsTitle()}
        size="xl"
        saving={s.advancedSettingsSaving()}
        saveDisabled={s.advancedSettingsSaveDisabled()}
        onSave={() => s.saveAdvancedSettings()}
        testID="settings-advanced"
      >
        <If when={s.advancedSettingsOpen()}>
          <AdvancedSettingsBody s={s} />
        </If>
      </SettingDialog>

      <SetupPickerDialog
        open={s.apiBasePickerOpen()}
        onOpenChange={(open) => s.apiBasePickerOpen.set(open)}
        items={s.apiBasePickerItems}
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
        selectedValue={s.modelPickerSelectedValue()}
        groupByPrefix
        allowCustom
        customLabel={t("setup_llm_model_picker_custom")}
        onSelect={(item) => s.applyModelOption(item)}
      />

      <RawJsonDialog
        open={s.toolSchemaPreview.open}
        title={s.toolSchemaPreview.title}
        json={s.toolSchemaPreview.json}
        onClose={() => {
          s.toolSchemaPreview.open = false;
        }}
        testID="settings-tool-schema"
      />

      <SetupConnectionTestDialog
        open={s.testConnectionOpen()}
        onOpenChange={(open) => s.testConnectionOpen.set(open)}
        loading={s.testConnectionLoading()}
        error={s.testConnectionError()}
        benchmarks={s.testConnectionBenchmarks()}
        provider={s.testConnectionMeta.provider}
        evaluateOnly={s.testConnectionMeta.evaluateOnly}
        benchmarkIds={s.testConnectionMeta.benchmarkIds}
        apiBase={s.testConnectionMeta.apiBase}
        model={s.testConnectionMeta.model}
        showIntro={false}
        onRetry={() => void s.runConnectionTest()}
      />

      <CodexAuthDialog
        open={s.codexAuth.dialogOpen()}
        onOpenChange={(open) => s.codexAuth.dialogOpen.set(open)}
        loading={s.codexAuth.loading()}
        busy={s.codexAuth.busy()}
        error={s.codexAuth.error()}
        status={s.codexAuth.status()}
        summary={s.codexAuth.summary()}
        loginSession={s.codexAuth.loginSession()}
        verificationURL={s.codexAuth.verificationURL()}
        userCode={s.codexAuth.userCode()}
        loginExpiresLabel={s.codexAuth.loginExpiresLabel()}
        onLogout={() => void s.codexAuth.logout()}
      />
      <XAIAuthDialog
        open={s.xaiAuth.dialogOpen()}
        onOpenChange={(open) => s.xaiAuth.dialogOpen.set(open)}
        loading={s.xaiAuth.loading()}
        busy={s.xaiAuth.busy()}
        error={s.xaiAuth.error()}
        status={s.xaiAuth.status()}
        summary={s.xaiAuth.summary()}
        loginSession={s.xaiAuth.loginSession()}
        verificationURL={s.xaiAuth.verificationURL()}
        userCode={s.xaiAuth.userCode()}
        loginExpiresLabel={s.xaiAuth.loginExpiresLabel()}
        setDefault={s.xaiAuth.setDefault()}
        onSetDefaultChange={(value) => s.xaiAuth.setDefault.set(value)}
        onLogin={() => s.xaiAuth.relogin()}
        onLogout={() => void s.xaiAuth.logout()}
      />
      <ProAuthDialog
        open={s.proAuth.dialogOpen()}
        onOpenChange={(open) => s.proAuth.dialogOpen.set(open)}
        loading={s.proAuth.loading()}
        busy={s.proAuth.busy()}
        error={s.proAuth.error()}
        status={s.proAuth.status()}
        summary={s.proAuth.summary()}
        loginSession={s.proAuth.loginSession()}
        verificationURL={s.proAuth.verificationURL()}
        userCode={s.proAuth.userCode()}
        loginExpiresLabel={s.proAuth.loginExpiresLabel()}
        onLogout={() => void s.proAuth.logout()}
      />

      <MessageDialog
        open={s.deleteProfileDialogOpen()}
        onClose={() => s.closeDeleteProfileDialog()}
        icon="PhTrash"
        tone="danger"
        title={t("action_delete")}
        text={s.deleteProfileDialogText()}
        testID="settings-delete-profile"
        actions={[
          { id: "cancel", label: t("action_cancel"), variant: "outlined", onPress: () => s.closeDeleteProfileDialog() },
          { id: "delete", label: t("action_delete"), variant: "danger", onPress: () => void s.deleteLLMProfile() },
        ]}
      />
    </>
  );
}
