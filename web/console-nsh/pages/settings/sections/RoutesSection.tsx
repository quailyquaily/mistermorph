// Model Routes: which model each kind of work uses (llm.routes in the config).
import { View } from "nsh";
import { ModelRoutesPanel } from "../../../components/settings/ModelRoutesPanel";
import type { SettingsStore } from "../store";

export function RoutesSection(props: { s: SettingsStore }) {
  const s = props.s;
  return (
    <View class="gap-5" testID="settings-routes">
      <ModelRoutesPanel
        values={s.agentConfigValues()}
        fieldStates={s.agentFieldStates()}
        profiles={s.routeProfileOptions()}
        loading={s.agentLoading()}
        saving={s.agentSaving() && s.agentSavingTarget() === "config"}
        saveScope="agent"
        onSave={(update) => void s.saveConfigSettings("agent", update)}
        onAddProfile={() => s.openAddProfileDialog()}
      />
    </View>
  );
}
