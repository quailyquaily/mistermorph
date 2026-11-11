// Models: the default model, the saved profiles (each opens in a side pane), the fallback order,
// and the LLM system settings.
import { signal, Text, untracked, View } from "nsh";
import { Button as BaseButton } from "nsh/base";
import { LLM_SYSTEM_CONFIG_GROUPS } from "../../../lib/core/config-field-groups.js";
import { Button, DropdownMenu, Icon, MenuIconTrigger, SelectField, TextField } from "../../../components/ui";
import { ConfigSettingsPanel, type ConfigGroup } from "../../../components/settings/ConfigSettingsPanel";
import { InlineNotice } from "../../../components/settings/DialogShell";
import { ProviderLogo } from "../../../components/settings/InferenceProviderPicker";
import { LLMConfigForm } from "../../../components/settings/LLMConfigForm";
import { SettingsPane } from "../../../components/settings/PaneTarget";
import { DirtyDot, Fold, PlaceholderButton, SettingField, SettingsCard } from "../../../components/settings-page/parts";
import { useRevealRow } from "../../../components/settings-page/reveal";
import type { LLMProfile, SettingsStore } from "../store";
import { t } from "../i18n";

function SubHeading(props: { title: string; note: string }) {
  const reveal = useRevealRow(() => props.title);
  return (
    <View ref={reveal.ref}
      style={reveal.style()} class={`gap-1 rounded-(--radius) ${reveal.ringed() ? "ring-2 ring-blue" : ""}`}>
      <Text class="text-sm font-medium leading-[18.9px] text-foreground">{props.title}</Text>
      <Text class="text-xs leading-[20.3px] text-muted-foreground">{props.note}</Text>
    </View>
  );
}

function ProfileRow(props: { s: SettingsStore; profile: LLMProfile }) {
  const s = props.s;
  const active = () => s.openProfileKey() === props.profile._key;
  const provider = () => s.providerItems.find((item) => item.value === s.profileProviderChoice(props.profile)) || null;
  return (
    <BaseButton
      onPress={() => s.openProfilePane(props.profile._key)}
      selected={active()}
      accessibilityLabel={props.profile.name || t("settings_agent_profile_placeholder")}
      testID={`settings-profile-${props.profile.name || props.profile._key}`}
      class={`flex-row items-center gap-3 border-b border-line-soft px-2 py-3 transition-colors duration-120 ${
        active() ? "bg-blue/9" : "hover:bg-blue/5"
      }`}
    >
      <View
        accessibilityLabel={t(s.profileIsInUse(props.profile) ? "settings_agent_profile_status_in_use" : "settings_agent_profile_status_available")}
      >
        <ProviderLogo item={provider()} size={28} />
        <If when={s.profileIsInUse(props.profile)}>
          <View class="absolute -bottom-[3px] -right-[3px] size-[11px] rounded-[1px] border-2 border-card bg-status-on" />
        </If>
      </View>
      <View class="flex-1 gap-0.5">
        <Text class="text-sm font-medium text-foreground line-clamp-1">{props.profile.name || t("settings_agent_profile_placeholder")}</Text>
        <Text class="text-xs text-muted-foreground line-clamp-1">{s.profileSummary(props.profile) || t("settings_agent_profile_not_set")}</Text>
      </View>
      <If when={s.profileDirty(props.profile)}>
        <DirtyDot label={t("settings_channel_unsaved")} testID="settings-profile-dirty" />
      </If>
      <Icon name="PhCaretRight" size={12} color="muted-foreground" />
    </BaseButton>
  );
}

export function AgentSection(props: { s: SettingsStore }) {
  const s = props.s;
  const busy = () => s.agentLoading() || s.agentSaving();
  const locked = () => busy() || s.agentSettingsReadOnly();
  const profiles = () => s.state.llm.profiles.filter((item) => !item._draft);
  const fallbackItems = () => s.profileOptions().map((item) => ({ value: item.value, label: item.title, description: item.note }));
  return (
    <View class="gap-4" testID="settings-agent">
      <SettingsCard
        title={t("settings_agent_block_title")}
        meta={s.selectedSection()?.meta}
        actions={
          <DropdownMenu
            disabled={busy()}
            trigger={<MenuIconTrigger label={t("todo_action_more")} testID="settings-llm-menu" />}
            items={s.llmActionMenuItems()}
          />
        }
      >
        <If when={s.agentValidationVisible() && s.agentValidationError()}>
          <InlineNotice type="error" text={s.agentValidationError()} testID="settings-agent-validation" />
        </If>
        <If when={s.agentSettingsReadOnly()}>
          <InlineNotice type="warning" text={s.agentSettingsReadOnlyMessage()} testID="settings-agent-readonly" />
        </If>

        <LLMConfigForm
          config={s.state.llm}
          showAbilities
          busy={busy()}
          disabledReason={s.agentFormDisabledReason()}
          readOnly={s.agentSettingsReadOnly()}
          envManaged={s.llmEnvManaged()}
          secretFields={s.llmSecretFields()}
          revealPrefix={s.llmRevealPrefix()}
          providerItems={s.defaultLLMProviderItems}
          reasoningEffortItems={s.reasoningEffortItems()}
          toolsEmulationItems={s.toolsEmulationItems()}
          enableAPIBasePicker
          enableModelPicker
          showCodexAuthAction
          codexAuthDisabled={s.defaultCodexAuthDisabled()}
          codexAuthState={s.codexAuth.buttonState()}
          codexAuthTitle={s.codexAuth.buttonTitle()}
          showXAIAuthAction={s.selectedEndpointIsConsole()}
          xaiAuthState={s.xaiAuth.buttonState()}
          xaiAuthTitle={s.xaiAuth.buttonTitle()}
          showProAuthAction={s.selectedEndpointIsConsole()}
          proAuthState={s.proAuth.buttonState()}
          proAuthTitle={s.proAuth.buttonTitle()}
          onUpdateField={(change) => s.updateDefaultLLMField(change)}
          onOpenApiBasePicker={() => s.openAPIBasePicker()}
          onOpenModelPicker={() => void s.openModelPicker()}
          onOpenCodexAuth={() => void s.codexAuth.openDialog()}
          onOpenXaiAuth={() => void s.xaiAuth.openDialog()}
          onOpenProAuth={() => void s.proAuth.openDialog()}
          testID="settings-llm-form"
        />

        <View class="gap-3 border-t border-line-soft pt-3">
          <SubHeading title={t("settings_agent_profiles_title")} note={t("settings_agent_profiles_note")} />
          <View testID="settings-profile-list">
            <If when={profiles().length}>
              <View class="mb-3 border-t border-line-soft">
                <Each of={profiles()} key={(profile) => profile._key}>
                  {(profile) => <ProfileRow s={s} profile={profile()} />}
                </Each>
              </View>
            </If>
            <PlaceholderButton
              label={t("settings_agent_profile_add")}
              disabled={locked()}
              onPress={() => s.openAddProfileDialog()}
              testID="settings-profile-add"
            />
          </View>
        </View>

        <View class="gap-3 border-t border-line-soft pt-3">
          <SubHeading title={t("settings_agent_fallback_title")} note={t("settings_agent_fallback_note")} />
          <If
            when={s.profileOptions().length}
            else={<Text class="text-xs leading-normal text-muted-foreground">{t("settings_agent_fallback_empty")}</Text>}
          >
            <View class="gap-2" testID="settings-fallback-list">
              <Each of={s.state.llm.fallback_profiles.map((name, index) => ({ name, index }))} key={(item) => `${item.index}:${item.name}`}>
                {(item) => (
                  <View class="flex-row items-center gap-2">
                    <Text class="w-5 font-mono text-xs text-muted-foreground">{String(item().index + 1)}</Text>
                    <SelectField
                      class="flex-1"
                      items={fallbackItems()}
                      value={item().name}
                      placeholder={t("settings_agent_fallback_placeholder")}
                      disabled={locked()}
                      onChange={(value) => s.updateFallbackProfile(untracked(item).index, value)}
                      testID={`settings-fallback-${item().index}`}
                    />
                    <Button
                      variant="outlined"
                      size="xs"
                      iconOnly
                      icon="PhCaretUp"
                      title={t("settings_agent_order_up")}
                      disabled={locked() || item().index === 0}
                      onPress={() => s.moveFallbackProfile(untracked(item).index, -1)}
                    />
                    <Button
                      variant="outlined"
                      size="xs"
                      iconOnly
                      icon="PhCaretDown"
                      title={t("settings_agent_order_down")}
                      disabled={locked() || item().index === s.state.llm.fallback_profiles.length - 1}
                      onPress={() => s.moveFallbackProfile(untracked(item).index, 1)}
                    />
                    <Button
                      variant="ghost-danger"
                      size="xs"
                      iconOnly
                      icon="PhTrash"
                      title={t("action_delete")}
                      disabled={locked()}
                      onPress={() => s.removeFallbackProfile(untracked(item).index)}
                    />
                  </View>
                )}
              </Each>
              <PlaceholderButton
                label={t("settings_agent_fallback_add")}
                disabled={locked() || !s.profileOptions().length}
                onPress={() => s.addFallbackProfile()}
                testID="settings-fallback-add"
              />
            </View>
          </If>
        </View>
      </SettingsCard>

      <Each of={LLM_SYSTEM_CONFIG_GROUPS as ConfigGroup[]} key={(group) => group.id}>
        {(group) => (
          <ConfigSettingsPanel
            groups={[group()]}
            values={s.agentConfigValues()}
            fieldStates={s.agentFieldStates()}
            loading={s.agentLoading()}
            saving={s.agentSaving() && s.agentSavingTarget() === "config"}
            saveScope="agent"
            onSave={(update) => void s.saveConfigSettings("agent", update)}
          />
        )}
      </Each>
    </View>
  );
}

/** A profile's settings, in the pane at the right (a sheet on phones). Closing keeps the draft. */
export function ProfilePane(props: { s: SettingsStore; sheet?: boolean }) {
  const s = props.s;
  const advancedOpen = signal(false);
  const busy = () => s.agentLoading() || s.agentSaving();
  const title = () => s.openedProfile()?.name || t("settings_agent_profile_placeholder");
  const meta = () => {
    const profile = s.openedProfile();
    if (!profile) return "";
    const status = t(s.profileIsInUse(profile) ? "settings_agent_profile_status_in_use" : "settings_agent_profile_status_available");
    const summary = s.profileSummary(profile);
    return summary ? `${status} · ${summary}` : status;
  };
  return (
    <SettingsPane
      literal
      open={!!s.openedProfile()}
      sheet={props.sheet}
      title={title()}
      meta={meta()}
      closeLabel={t("settings_channel_close")}
      onClose={() => s.closeProfilePane()}
      testID="settings-profile-pane"
      foot={
        <If when={s.openedProfile()}>
          {(profile) => (
            <>
              <Button
                variant="outlined"
                icon="PhGauge"
                label={t("setup_llm_test_button")}
                disabled={s.testConnectionDisabledForProfile(profile())}
                onPress={() => void s.openTestConnection(untracked(profile)._key)}
                testID="settings-profile-test"
              />
              <Button
                variant="ghost-danger"
                icon="PhTrash"
                label={t("settings_agent_profile_delete")}
                disabled={busy() || s.agentSettingsReadOnly()}
                onPress={() => s.confirmRemoveLLMProfile(untracked(profile)._key)}
                testID="settings-profile-delete"
              />
            </>
          )}
        </If>
      }
    >
      <Each of={s.openedProfile() ? [s.openedProfile()!] : []} key={(profile) => profile._key}>
        {(profile) => (
          <View class="gap-4">
            <SettingField label={t("settings_agent_profile_name_label")}>
              <TextField
                value={profile().name}
                clearable={Boolean(profile().name)}
                onChange={(value) => s.updateProfileField(untracked(profile)._key, { field: "name", value })}
                placeholder={t("settings_agent_profile_name_placeholder")}
                accessibilityLabel={t("settings_agent_profile_name_label")}
                disabled={busy() || s.agentSettingsReadOnly()}
                testID="settings-profile-name"
              />
            </SettingField>
            <LLMConfigForm
              config={profile()}
              showAbilities
              busy={busy()}
              disabledReason={s.agentFormDisabledReason()}
              readOnly={s.agentSettingsReadOnly()}
              envManaged={s.llmProfileEnvManaged(profile())}
              secretFields={s.llmProfileSecretFields(profile())}
              revealPrefix={s.llmRevealPrefix(profile())}
              providerItems={s.providerItems}
              reasoningEffortItems={s.reasoningEffortItems()}
              toolsEmulationItems={s.toolsEmulationItems()}
              enableModelPicker
              modelLookupCredentialsReady={s.profileModelLookupCredentialsReady(profile())}
              showCodexAuthAction={s.profileUsesCodexProvider(profile())}
              codexAuthDisabled={s.profileCodexAuthDisabled(profile())}
              codexAuthState={s.codexAuth.buttonState()}
              codexAuthTitle={s.codexAuth.buttonTitle()}
              showXAIAuthAction={s.profileUsesXAIProvider(profile())}
              xaiAuthState={s.xaiAuth.buttonState()}
              xaiAuthTitle={s.xaiAuth.buttonTitle()}
              showProAuthAction={s.profileUsesProProvider(profile())}
              proAuthState={s.proAuth.buttonState()}
              proAuthTitle={s.proAuth.buttonTitle()}
              onUpdateField={(change) => s.updateProfileField(untracked(profile)._key, change)}
              onOpenModelPicker={() => void s.openModelPicker(untracked(profile)._key)}
              onOpenCodexAuth={() => void s.codexAuth.openDialog()}
              onOpenXaiAuth={() => void s.xaiAuth.openDialog()}
              onOpenProAuth={() => void s.proAuth.openDialog()}
              testID="settings-profile-form"
            />
            {/* Less common settings stay folded; edits join the same draft and save bar. */}
            <Fold open={advancedOpen()} onToggle={() => advancedOpen.update((open) => !open)} title={t("settings_advanced_action")} testID="settings-profile-advanced">
              <LLMConfigForm
                config={profile()}
                busy={busy()}
                disabledReason={s.agentFormDisabledReason()}
                readOnly={s.agentSettingsReadOnly()}
                envManaged={s.llmProfileEnvManaged(profile())}
                secretFields={s.llmProfileSecretFields(profile())}
                revealPrefix={s.llmRevealPrefix(profile())}
                providerItems={s.providerItems}
                reasoningEffortItems={s.reasoningEffortItems()}
                toolsEmulationItems={s.toolsEmulationItems()}
                showAdvanced
                advancedOnly
                onUpdateField={(change) => s.updateProfileField(untracked(profile)._key, change)}
              />
            </Fold>
          </View>
        )}
      </Each>
    </SettingsPane>
  );
}
