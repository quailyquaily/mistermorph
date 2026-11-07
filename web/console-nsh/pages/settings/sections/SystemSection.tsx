// System: language, notifications, logs and the session; updates; the system config groups, with
// the rarely changed ones folded under Advanced.
import { signal, View } from "nsh";
import { endpointState } from "../../../lib/core/context.js";
import { endpointRoutePath } from "../../../lib/core/endpoint-routes.js";
import { SYSTEM_ADVANCED_CONFIG_GROUPS, SYSTEM_CONFIG_GROUPS } from "../../../lib/core/config-field-groups.js";
import { navigate } from "../../../lib/router";
import { Button } from "../../../components/ui";
import { LanguageSelector } from "../../../components/LanguageSelector";
import { ConfigSettingsPanel, type ConfigGroup } from "../../../components/settings/ConfigSettingsPanel";
import { SettingsUpdatePanel } from "../../../components/settings/SettingsAppPanel";
import { TopicNotificationSetting } from "../../../components/settings/TopicNotificationSetting";
import { Fold, SettingRow, SettingsCard } from "../../../components/settings-page/parts";
import type { SettingsStore } from "../store";
import { t } from "../i18n";

export function SystemSection(props: { s: SettingsStore }) {
  const s = props.s;
  const advancedOpen = signal(false);
  const panel = (group: ConfigGroup) => (
    <ConfigSettingsPanel
      groups={[group]}
      values={s.systemConfigValues()}
      fieldStates={s.systemFieldStates()}
      loading={s.systemLoading()}
      saving={s.systemSaving()}
      saveScope="system"
      onSave={(update) => void s.saveConfigSettings("system", update)}
    />
  );
  return (
    <View class="gap-5" testID="settings-system">
      <SettingsCard title={s.selectedSection()?.title} meta={s.selectedSection()?.meta}>
        <View>
          <SettingRow first title={t("settings_language_title")} note={t("settings_language_hint")}>
            <LanguageSelector />
          </SettingRow>
          <View class="border-t border-line-faint">
            <TopicNotificationSetting />
          </View>
          <SettingRow title={t("settings_logs_title")} note={t("settings_logs_hint")}>
            <Button
              variant="outlined"
              icon="PhCode"
              label={t("settings_logs_open")}
              onPress={() => void navigate(endpointRoutePath(endpointState.selectedRef, "/logs"))}
              testID="settings-open-logs"
            />
          </SettingRow>
          <SettingRow title={t("settings_session_title")} note={t("settings_session_hint")}>
            <Button
              variant="ghost-danger"
              label={t("action_logout")}
              loading={s.loggingOut()}
              onPress={() => void s.logout()}
              testID="settings-logout"
            />
          </SettingRow>
        </View>
      </SettingsCard>

      <SettingsUpdatePanel
        endpointRef={s.consoleEndpointRef()}
        configRevision={s.settingsConfigRevision()}
        onConfigRevision={(revision) => s.settingsConfigRevision.set(revision)}
      />

      <Each of={SYSTEM_CONFIG_GROUPS as ConfigGroup[]} key={(group) => group.id}>
        {(group) => panel(group())}
      </Each>

      <Fold open={advancedOpen()} onToggle={() => advancedOpen.update((open) => !open)} title={t("settings_advanced_action")} testID="settings-system-advanced">
        <Each of={SYSTEM_ADVANCED_CONFIG_GROUPS as ConfigGroup[]} key={(group) => group.id}>
          {(group) => panel(group())}
        </Each>
      </Fold>
    </View>
  );
}
