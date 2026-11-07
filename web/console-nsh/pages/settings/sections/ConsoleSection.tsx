// Remote access: the remote agents this console connects to, remote control, the Web Console
// password, and the deployment settings folded under Advanced.
import { signal, View } from "nsh";
import { CONSOLE_DEPLOYMENT_CONFIG_GROUPS, REMOTE_CONTROL_CONFIG_GROUPS } from "../../../lib/core/config-field-groups.js";
import { currentRoute, locationOf, navigate } from "../../../lib/router";
import { isMobile } from "../../../lib/shell";
import { ConfigSettingsPanel, type ConfigGroup } from "../../../components/settings/ConfigSettingsPanel";
import { ConsoleEndpointsPanel } from "../../../components/settings/ConsoleEndpointsPanel";
import { ConsolePasswordPanel } from "../../../components/settings/ConsolePasswordPanel";
import type { PaneTarget } from "../../../components/settings/PaneTarget";
import { Fold } from "../../../components/settings-page/parts";
import type { SettingsStore } from "../store";
import { t } from "../i18n";

export function ConsoleSection(props: { s: SettingsStore; pane: PaneTarget }) {
  const s = props.s;
  const advancedOpen = signal(false);
  const configPanel = (groups: ConfigGroup[]) => (
    <ConfigSettingsPanel
      groups={groups}
      values={s.consoleConfigValues()}
      fieldStates={s.consoleFieldStates()}
      loading={s.consoleLoading()}
      saving={s.consoleSaving() && s.consoleSavingTarget() === "config"}
      saveScope="console"
      onSave={(update) => void s.saveConfigSettings("console", update)}
    />
  );
  // ?add=agent (from the agent switcher) opens the add pane; then the query goes.
  const consumeAddRequest = () => {
    const now = currentRoute();
    const { add: _add, ...query } = now.query;
    void navigate(locationOf(now.path, query), { replace: true });
  };
  return (
    <View class="gap-5" testID="settings-console">
      <ConsoleEndpointsPanel
        endpoints={s.consoleEndpoints()}
        runtimeEndpoints={s.consoleRuntimeEndpoints()}
        loading={s.consoleLoading() || !s.consoleSettingsLoaded()}
        saving={s.consoleSaving()}
        addRequested={currentRoute().query.add === "agent"}
        mobile={isMobile()}
        paneTarget={props.pane}
        onAddOpened={consumeAddRequest}
        onSave={(values, onComplete) => void s.saveConsoleCollection("endpoints", values, onComplete)}
      />
      {configPanel(REMOTE_CONTROL_CONFIG_GROUPS as ConfigGroup[])}
      <ConsolePasswordPanel
        configured={s.consolePasswordConfigured()}
        saving={s.consoleSaving() && s.consoleSavingTarget() === "config"}
        onSave={(values) => void s.saveConfigSettings("console", values)}
      />
      <Fold
        open={advancedOpen()}
        onToggle={() => advancedOpen.update((open) => !open)}
        title={t("remote_advanced_title")}
        note={t("remote_advanced_note")}
        testID="settings-console-advanced"
      >
        {configPanel(CONSOLE_DEPLOYMENT_CONFIG_GROUPS as ConfigGroup[])}
      </Fold>
    </View>
  );
}
