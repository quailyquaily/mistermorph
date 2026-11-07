// Security: the guard (URL fetch limits, redaction, approvals), the guard's config details, and the
// auth profiles.
import { View } from "nsh";
import { TextField } from "../../../components/ui";
import { AuthProfilesPanel } from "../../../components/settings/AuthProfilesPanel";
import { ConfigSettingsPanel, type ConfigGroup } from "../../../components/settings/ConfigSettingsPanel";
import { SettingField, SettingToggleRow, SettingsCard } from "../../../components/settings-page/parts";
import type { SettingsStore } from "../store";
import { t } from "../i18n";

const TOGGLES = [
  ["enabled", "settings_console_guard_enabled_title", "settings_console_guard_enabled_note"],
  ["deny_private_ips", "settings_console_guard_deny_private_ips_title", "settings_console_guard_deny_private_ips_note"],
  ["follow_redirects", "settings_console_guard_follow_redirects_title", "settings_console_guard_follow_redirects_note"],
  ["allow_proxy", "settings_console_guard_allow_proxy_title", "settings_console_guard_allow_proxy_note"],
  ["redaction_enabled", "settings_console_guard_redaction_title", "settings_console_guard_redaction_note"],
  ["approvals_enabled", "settings_console_guard_approvals_title", "settings_console_guard_approvals_note"],
];

export function SecuritySection(props: { s: SettingsStore }) {
  const s = props.s;
  const busy = () => s.consoleLoading() || s.consoleSaving();
  return (
    <View class="gap-5" testID="settings-security">
      <SettingsCard title={t("settings_console_guard_title")} meta={s.selectedSection()?.meta}>
        <SettingField label={t("settings_console_guard_allowed_url_prefixes_label")} note={t("settings_console_guard_allowed_url_prefixes_note")}>
          <TextField
            value={s.state.guard.url_fetch_allowed_url_prefixes_text}
            onChange={(value) => s.updateChannelField("guard", "url_fetch_allowed_url_prefixes_text", value)}
            multiline
            rows={4}
            placeholder={t("settings_console_guard_allowed_url_prefixes_placeholder")}
            accessibilityLabel={t("settings_console_guard_allowed_url_prefixes_label")}
            disabled={busy()}
            testID="settings-guard-prefixes"
          />
        </SettingField>
        <View>
          <Each of={TOGGLES} key={(row) => row[0]}>
            {(row, index) => (
              <SettingToggleRow
                first={index() === 0}
                title={t(row()[1])}
                note={t(row()[2])}
                checked={!!s.state.guard[row()[0]]}
                disabled={busy()}
                onChange={(checked) => s.updateChannelField("guard", row()[0], checked)}
                testID={`settings-guard-${row()[0]}`}
              />
            )}
          </Each>
        </View>
      </SettingsCard>

      <ConfigSettingsPanel
        groups={s.securityConfigGroups() as ConfigGroup[]}
        values={s.consoleConfigValues()}
        fieldStates={s.consoleFieldStates()}
        inactiveGroups={s.state.guard.enabled ? {} : { "guard-storage": t("settings_guard_details_inactive") }}
        loading={s.consoleLoading()}
        saving={s.consoleSaving() && s.consoleSavingTarget() === "config"}
        saveScope="console"
        onSave={(update) => void s.saveConfigSettings("console", update)}
      />
      <AuthProfilesPanel
        profiles={s.authProfiles()}
        loading={s.consoleLoading()}
        saving={s.consoleSaving() && s.consoleSavingTarget() === "auth_profiles"}
        onSave={(profiles) => void s.saveConsoleCollection("auth_profiles", profiles)}
      />
    </View>
  );
}
