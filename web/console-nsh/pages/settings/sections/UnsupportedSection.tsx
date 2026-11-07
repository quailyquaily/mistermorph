// What the agent, routes, tools and MCP sections show for a remote endpoint without the
// /settings/agent routes (an older agent).
import { Text, View } from "nsh";
import { Icon } from "../../../components/ui";
import { SettingsCard } from "../../../components/settings-page/parts";
import type { SettingsStore } from "../store";
import { t } from "../i18n";

export function UnsupportedSection(props: { s: SettingsStore }) {
  return (
    <SettingsCard title={props.s.selectedSection()?.title} meta={props.s.selectedSection()?.meta} testID="settings-unsupported">
      <View class="items-center gap-2 px-6 py-8">
        <Icon name="PhPlugs" size={28} color="muted-foreground" />
        <Text class="text-sm font-medium text-foreground">{t("settings_agent_endpoint_unsupported")}</Text>
        <Text class="text-center text-xs text-muted-foreground">{t("settings_agent_endpoint_unsupported_hint")}</Text>
      </View>
    </SettingsCard>
  );
}
