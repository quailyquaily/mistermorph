// MCP servers: the list, and a server's settings in the page's pane column.
import { View } from "nsh";
import { isMobile } from "../../../lib/shell";
import { MCPSettingsPanel } from "../../../components/settings/MCPSettingsPanel";
import type { PaneTarget } from "../../../components/settings/PaneTarget";
import type { SettingsStore } from "../store";

export function McpSection(props: { s: SettingsStore; pane: PaneTarget }) {
  const s = props.s;
  return (
    <View class="gap-5" testID="settings-mcp">
      <MCPSettingsPanel
        servers={s.state.mcp.servers}
        loading={s.agentLoading()}
        saving={s.agentSaving() && s.agentSavingTarget() === "mcp"}
        readOnly={s.agentSettingsReadOnly()}
        readOnlyMessage={s.agentSettingsReadOnlyMessage()}
        validationError={s.mcpValidationError()}
        mobile={isMobile()}
        paneTarget={props.pane}
        onSave={(servers) => void s.saveMCPServers(servers)}
      />
    </View>
  );
}
