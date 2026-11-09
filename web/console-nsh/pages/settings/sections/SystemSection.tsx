// System: language, notifications, logs and the session; updates; the system config groups, with
// the rarely changed ones folded under Advanced.
import { signal, Text, View } from "nsh";
import { endpointState } from "../../../lib/core/context.js";
import { endpointRoutePath } from "../../../lib/core/endpoint-routes.js";
import { SYSTEM_ADVANCED_CONFIG_GROUPS, SYSTEM_CONFIG_GROUPS } from "../../../lib/core/config-field-groups.js";
import { navigate } from "../../../lib/router";
import { Button } from "../../../components/ui";
import { localeState } from "../../../lib/stores/index.js";
import { SettingSelect } from "../../../components/settings/SettingFields";
import { ConfigSettingsPanel, type ConfigGroup } from "../../../components/settings/ConfigSettingsPanel";
import { SettingsUpdatePanel } from "../../../components/settings/SettingsAppPanel";
import { TopicNotificationSetting } from "../../../components/settings/TopicNotificationSetting";
import { BoxFold, SettingRow, SettingsCard } from "../../../components/settings-page/parts";
import { isMobile } from "../../../lib/shell";
import type { SettingsStore } from "../store";
import { t } from "../i18n";

// The interface languages with the Vue selector's emblems (AppLanguageSelector), the ones this
// console has strings for.
const LANGUAGES = [
  { title: "🗽\u2002English", value: "en" },
  { title: "🐼\u2002简体中文", value: "zh" },
  { title: "🌸\u2002日本語", value: "ja" },
];

/** A row's control at the right (`.settings-console-control`): at least 180pt, full width on phones. */
const control = () => (isMobile() ? "self-stretch" : "min-w-[180px]");

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
          <SettingRow first title={t("settings_language_title")} note={t("settings_language_hint")} copyClass={isMobile() ? "" : "max-w-40"}>
            <View class={isMobile() ? "self-stretch" : "min-w-[180px] flex-[3]"}>
              <SettingSelect
                value={localeState.lang}
                options={LANGUAGES}
                onChange={(value) => localeState.setLanguage(value)}
                label={t("settings_language_title")}
                testID="settings-language"
              />
            </View>
          </SettingRow>
          <View class="border-t border-line-soft">
            <TopicNotificationSetting />
          </View>
          <If when={s.configPath()}>
            <SettingRow
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
          <SettingRow title={t("settings_logs_title")} note={t("settings_logs_hint")}>
            <Button
              variant="outlined"
              size="md"
              class={control()}
              icon="PhCode"
              label={t("settings_logs_open")}
              onPress={() => void navigate(endpointRoutePath(endpointState.selectedRef, "/logs"))}
              testID="settings-open-logs"
            />
          </SettingRow>
          <SettingRow title={t("settings_session_title")} note={t("settings_session_hint")}>
            <Button
              variant="outlined"
              size="md"
              class={`${control()} border-danger/35 hover:border-danger/60`}
              loading={s.loggingOut()}
              onPress={() => void s.logout()}
              testID="settings-logout"
            >
              <If when={!s.loggingOut()}>
                <Text class="text-sm font-medium text-danger">{t("action_logout")}</Text>
              </If>
            </Button>
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
