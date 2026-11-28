// General: this device's own settings, the same whichever agent is selected: the interface language,
// the theme,
// notifications, the desktop app's network proxy, the console session, and, in a web browser,
// installing the selected agent as an app.
import { Text, View } from "nsh";
import { Button } from "../../../components/ui";
import { localeState } from "../../../lib/stores/index.js";
import { SettingSelect } from "../../../components/settings/SettingFields";
import { ThemeSetting } from "../../../components/settings/ThemePicker";
import { NetworkProxySetting } from "../../../components/settings/NetworkProxySetting";
import { SettingsAppPanel } from "../../../components/settings/SettingsAppPanel";
import { TopicNotificationSetting } from "../../../components/settings/TopicNotificationSetting";
import { SettingRow, SettingsCard } from "../../../components/settings-page/parts";
import { isMobile } from "../../../lib/shell";
import { hasFeature, isBrowser } from "../../../lib/platform";
import type { SettingsStore } from "../store";
import { t } from "../i18n";

// The interface languages with the Vue selector's emblems (AppLanguageSelector), the ones this
// console has strings for.
const LANGUAGES = [
  { title: "🗽 English", value: "en" },
  { title: "🐼 简体中文", value: "zh" },
  { title: "🌸 日本語", value: "ja" },
];

/** A row's control at the right (`.settings-console-control`): at least 180pt, full width on phones. */
const control = () => (isMobile() ? "self-stretch" : "min-w-[180px]");

export function GeneralSection(props: { s: SettingsStore }) {
  const s = props.s;
  return (
    <View class="gap-4" testID="settings-general">
      <SettingsCard title={s.selectedSection()?.title} list>
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
          <ThemeSetting />
          <View class="border-t border-line-soft">
            <TopicNotificationSetting />
          </View>
          {/* The desktop app's own proxy setting: only a host that has it shows the row. */}
          <If when={hasFeature("networkProxy")}>
            <NetworkProxySetting />
          </If>
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
      {/* The desktop and phone apps are the installed app already: no App card, nor its gap. */}
      <If when={isBrowser()}>
        <SettingsAppPanel />
      </If>
    </View>
  );
}
