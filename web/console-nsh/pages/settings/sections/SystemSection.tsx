// System: where the config is stored and the logs; updates; the system config groups, with the
// rarely changed ones folded under Advanced. Language, notifications and the session belong to this
// device, not to the server, so they are in General.
import { signal, Text, View } from "nsh";
import { endpointState } from "../../../lib/core/context.js";
import { endpointRoutePath } from "../../../lib/core/endpoint-routes.js";
import { SYSTEM_ADVANCED_CONFIG_GROUPS, SYSTEM_CONFIG_GROUPS } from "../../../lib/core/config-field-groups.js";
import { navigate } from "../../../lib/router";
import { Button } from "../../../components/ui";
import { ConfigSettingsPanel, type ConfigGroup } from "../../../components/settings/ConfigSettingsPanel";
import { SettingsUpdatePanel } from "../../../components/settings/SettingsAppPanel";
import { BoxFold, SettingRow, SettingsCard } from "../../../components/settings-page/parts";
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
    <View class="gap-4" testID="settings-system">
      <SettingsCard title={s.selectedSection()?.title} meta={s.selectedSection()?.meta} list>
        <View>
          <If when={s.configPath()}>
            <SettingRow
              first
              title={t("settings_config_store_title")}
              note={
                s.configPath().endsWith("agent.db#config.yaml")
                  ? t("settings_config_store_db")
                  : t("settings_config_store_file", { path: s.configPath() })
              }
            >
              <Text class="font-mono text-xs text-muted-foreground" testID="settings-config-store">
                {s.configPath().endsWith("agent.db#config.yaml") ? "agent.db" : s.configPath()}
              </Text>
            </SettingRow>
          </If>
          <SettingRow first={!s.configPath()} title={t("settings_logs_title")} note={t("settings_logs_hint")}>
            <Button
              variant="outlined"
              size="md"
              icon="PhCode"
              label={t("settings_logs_open")}
              onPress={() => void navigate(endpointRoutePath(endpointState.selectedRef, "/logs"))}
              testID="settings-open-logs"
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

      <BoxFold open={advancedOpen()} onToggle={() => advancedOpen.update((open) => !open)} title={t("settings_advanced_action")} testID="settings-system-advanced">
        <Each of={SYSTEM_ADVANCED_CONFIG_GROUPS as ConfigGroup[]} key={(group) => group.id}>
          {(group) => panel(group())}
        </Each>
      </BoxFold>
    </View>
  );
}
