// Automation: heartbeat, scheduled tasks and the other console automation settings.
import { View } from "nsh";
import { AUTOMATION_CONFIG_GROUPS } from "../../../lib/core/config-field-groups.js";
import { ConfigSettingsPanel, type ConfigGroup } from "../../../components/settings/ConfigSettingsPanel";
import type { SettingsStore } from "../store";

export function AutomationSection(props: { s: SettingsStore }) {
  const s = props.s;
  return (
    <View class="gap-5" testID="settings-automation">
      <ConfigSettingsPanel
        groups={AUTOMATION_CONFIG_GROUPS as ConfigGroup[]}
        hideSingleGroupHeading
        values={s.consoleConfigValues()}
        fieldStates={s.consoleFieldStates()}
        loading={s.consoleLoading()}
        saving={s.consoleSaving() && s.consoleSavingTarget() === "config"}
        saveScope="console"
        onSave={(update) => void s.saveConfigSettings("console", update)}
      />
    </View>
  );
}
