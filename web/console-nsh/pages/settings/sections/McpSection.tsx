// SKILLs & MCP (the `mcp` section, /settings/mcp): one card under the section's title. First the
// Load skills switch (skills.enabled; which skills load is the Skills page's), a draft the page's
// save bar saves on its own; then the MCP servers, with the server's settings in the page's pane
// column, each change saved from there.
import { View } from "nsh";
import { isMobile } from "../../../lib/shell";
import { Icon } from "../../../components/ui";
import { MCPSettingsPanel } from "../../../components/settings/MCPSettingsPanel";
import type { PaneTarget } from "../../../components/settings/PaneTarget";
import { GroupTitle, SettingToggleRow } from "../../../components/settings-page/parts";
import type { SettingsStore } from "../store";
import { t } from "../i18n";

function LoadSkillsSetting(props: { s: SettingsStore }) {
  const s = props.s;
  return (
    <View class="gap-2" testID="settings-skills-group">
      <GroupTitle text={t("settings_skills_group")} />
      <View class="border-t border-line-soft">
        <SettingToggleRow
          first
          title={t("skills_enabled")}
          note={t("skills_enabled_note")}
          leading={
            <View class="mt-0.5">
              <Icon name="PhMagicWand" size={16} color="subtle" />
            </View>
          }
          checked={s.skillsEnabled()}
          disabled={s.agentLoading() || s.agentSaving() || s.agentSettingsReadOnly()}
          onChange={(checked) => s.setSkillsEnabled(checked)}
          testID="settings-skills-enabled"
        />
      </View>
    </View>
  );
}

export function McpSection(props: { s: SettingsStore; pane: PaneTarget }) {
  const s = props.s;
  // Load skills only for a runtime that reports skills.enabled (it would ignore one sent to it).
  // While it saves, the servers take no change: theirs could not be saved then.
  return (
    <View class="gap-5" testID="settings-mcp">
      <MCPSettingsPanel
        title={t("settings_skills_mcp_title")}
        meta={t("settings_section_skills_mcp_meta")}
        before={
          <If when={s.skillsEnabledSupported()}>
            <LoadSkillsSetting s={s} />
          </If>
        }
        serversTitle={t("settings_mcp_servers_group")}
        servers={s.state.mcp.servers}
        loading={s.agentLoading()}
        saving={s.agentSaving() && s.agentSavingTarget() === "mcp"}
        blocked={s.agentSaving() && s.agentSavingTarget() !== "mcp"}
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
