// Tools: each built-in tool with its switch, its Advanced settings and its schema, in groups; the
// name set spawn and coder share; then the tools channel runtimes add, as a matrix of tool by
// channel.
import type { JSX } from "nsh";
import { Image, Scroll, Text, View } from "nsh";
import { isMobile } from "../../../lib/shell";
import { Button as BaseButton } from "nsh/base";
import { TOOL_ADVANCED_CONFIG_GROUPS } from "../../../lib/core/config-field-groups.js";
import { WORKER_NAME_SETS, workerNameExamples } from "../../../lib/core/worker-identity.js";
import { localeState } from "../../../lib/stores/index.js";
import { Button, Icon } from "../../../components/ui";
import { InlineNotice } from "../../../components/settings/DialogShell";
import { SettingRow, SettingToggleRow, SettingsCard } from "../../../components/settings-page/parts";
import { SettingSelect } from "../../../components/settings/SettingFields";
import { TOOL_CHANNEL_ROWS, TOOL_CHANNELS, TOOL_GROUPS, type ToolChannel } from "../constants";
import type { SettingsStore } from "../store";
import { t } from "../i18n";

// The channel tool matrix (`.settings-tool-matrix`): the table takes the card's width, the tool
// names in the first column, a column per channel; 8pt by 6pt cells on hairlines. On phones the
// columns keep a fixed width and the table scrolls sideways.
const cell = () => `${isMobile() ? "w-16" : "min-w-0 flex-1"} items-center justify-center px-1.5 py-2`;

function ChannelHeading(props: { channel: ToolChannel }) {
  return (
    <View class={`${cell()} gap-1`}>
      <If when={props.channel.logo} else={<Icon name={props.channel.icon!} size={16} color="subtle" />}>
        <Image src={props.channel.logo!} accessibilityElementsHidden style={{ width: 16, height: 16 }} />
      </If>
      <Text class="text-xs font-medium text-subtle" style={{ numberOfLines: 1 }}>
        {props.channel.title}
      </Text>
    </View>
  );
}

/** A group's heading (`.settings-tool-group-title`): 12pt semibold caps. */
function GroupTitle(props: { text: string }) {
  return <Text class="text-xs font-semibold uppercase tracking-[0.04em] text-subtle">{props.text}</Text>;
}

/** The matrix in place on wide windows; a sideways scroll on phones. */
function MatrixFrame(props: { children?: JSX.Element }) {
  return (
    <If when={isMobile()} else={<View>{props.children}</View>}>
      <Scroll horizontal class="shrink">
        {props.children}
      </Scroll>
    </If>
  );
}

/**
 * The name set new spawn subagents and coders are named from: shared by both tools, so it sits
 * below every tool's own settings and saves with them. A few of the set's names, in the Console's
 * language, show what it is like.
 */
function AgentNameSetSetting(props: { s: SettingsStore; disabled: boolean }) {
  const s = props.s;
  const options = () => WORKER_NAME_SETS.map((set) => ({ title: t(`settings_agent_name_set_${set}`), value: set }));
  const examples = () =>
    t("settings_agent_name_set_examples", {
      names: workerNameExamples(s.agentNameSet(), localeState.lang).join(t("settings_agent_name_set_separator")),
    });
  return (
    <View class="gap-2" testID="settings-agent-name-set">
      <GroupTitle text={t("settings_agent_name_set_group")} />
      <View class="border-t border-line-soft">
        <SettingRow
          first
          title={t("settings_agent_name_set_title")}
          note={t("settings_agent_name_set_note")}
          status={
            <Text class="text-xs leading-[20.3px] text-subtle" testID="settings-agent-name-set-examples">
              {examples()}
            </Text>
          }
        >
          <View class={isMobile() ? "self-stretch" : "w-[200px] shrink-0"}>
            <SettingSelect
              value={s.agentNameSet()}
              options={options()}
              onChange={(value) => s.setAgentNameSet(value)}
              label={t("settings_agent_name_set_title")}
              disabled={props.disabled}
              testID="settings-agent-name-set-select"
            />
          </View>
        </SettingRow>
      </View>
    </View>
  );
}

export function ToolsSection(props: { s: SettingsStore }) {
  const s = props.s;
  const busy = () => s.agentLoading() || s.agentSaving();
  const hasAdvanced = (id: string) => Boolean((TOOL_ADVANCED_CONFIG_GROUPS as Record<string, unknown>)[id]);
  return (
    <View class="gap-4" testID="settings-tools">
      <SettingsCard title={s.selectedSection()?.title} meta={s.selectedSection()?.meta}>
        <If when={s.activeSaveKind() === "agent" && s.agentValidationVisible() && s.agentValidationError()}>
          <InlineNotice type="error" text={s.agentValidationError()} />
        </If>
        <If when={s.activeSaveKind() === "agent" && s.agentSettingsReadOnly()}>
          <InlineNotice type="warning" text={s.agentSettingsReadOnlyMessage()} />
        </If>
        <View class="gap-6">
          <Each of={TOOL_GROUPS} key={(group) => group.id}>
            {(group) => (
              <View class="gap-2">
                <GroupTitle text={t(group().titleKey)} />
                <View class="border-t border-line-soft">
                  <Each of={group().tools} key={(item) => item.id}>
                    {(item, index) => (
                      <SettingToggleRow
                        first={index() === 0}
                        title={t(item().titleKey)}
                        note={t(item().noteKey)}
                        leading={
                          <View class="mt-0.5">
                            <Icon name={item().icon} size={16} color="subtle" />
                          </View>
                        }
                        checked={item().toggle === false ? true : !!s.state.tools[item().id]}
                        disabled={item().toggle === false || busy() || s.agentSettingsReadOnly()}
                        onChange={(checked) => s.setToolEnabled(item().id, checked)}
                        testID={`settings-tool-${item().id}`}
                        actions={
                          <>
                            <If when={hasAdvanced(item().id)}>
                              <Button
                                variant="plain"
                                size="xs"
                                iconOnly
                                icon="PhGearSix"
                                title={t("settings_advanced_action")}
                                disabled={busy()}
                                onPress={() => s.openToolAdvancedSettings(item())}
                                testID={`settings-tool-${item().id}-advanced`}
                              />
                            </If>
                            <Button
                              variant="plain"
                              size="xs"
                              iconOnly
                              icon="PhBracketsCurly"
                              title={t("settings_tool_schema_preview")}
                              onPress={() => void s.previewToolSchema(item())}
                              testID={`settings-tool-${item().id}-schema`}
                            />
                          </>
                        }
                        control={
                          item().automatic ? (
                            <Text class="text-xs text-muted-foreground">{t("settings_tool_automatic")}</Text>
                          ) : undefined
                        }
                      />
                    )}
                  </Each>
                </View>
              </View>
            )}
          </Each>

          <If when={s.agentNameSetSupported()}>
            <AgentNameSetSetting s={s} disabled={busy() || s.agentSettingsReadOnly()} />
          </If>

          {/* Load skills (skills.enabled): which skills load is the Skills page's; whether any do
              is a setting of the agent's, saved with the tools. */}
          <If when={s.skillsEnabledSupported()}>
            <View class="gap-2">
              <GroupTitle text={t("settings_tool_group_skills")} />
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
                  disabled={busy() || s.agentSettingsReadOnly()}
                  onChange={(checked) => s.setSkillsEnabled(checked)}
                  testID="settings-skills-enabled"
                />
              </View>
            </View>
          </If>

          <View class="gap-2">
            <View class="gap-0.5">
              <GroupTitle text={t("settings_tool_group_channels")} />
              <Text class="text-xs leading-[17.4px] text-muted-foreground">{t("settings_tool_group_note_channels")}</Text>
            </View>
            <MatrixFrame>
              <View class="border-t border-line-soft" testID="settings-tool-matrix">
                <View class="flex-row border-b border-line-soft">
                  <View class="w-44 px-1.5 py-2" />
                  <Each of={TOOL_CHANNELS} key={(channel) => channel.id}>
                    {(channel) => <ChannelHeading channel={channel()} />}
                  </Each>
                </View>
                <Each of={TOOL_CHANNEL_ROWS} key={(row) => row.id}>
                  {(row, index) => (
                    <View class={`flex-row ${index() === 0 ? "" : "border-t border-line-soft"}`}>
                      <View class="w-44 flex-row items-center gap-2 px-1.5 py-2">
                        <Icon name={row().icon} size={14} color="subtle" />
                        <Text class="font-mono text-xs text-foreground" style={{ numberOfLines: 1 }}>
                          {row().id}
                        </Text>
                      </View>
                      <Each of={TOOL_CHANNELS} key={(channel) => channel.id}>
                        {(channel) => (
                          <View class={cell()}>
                            <If
                              when={channel().tools.includes(row().id)}
                              else={
                                <Text class="text-xs text-muted-foreground opacity-50" accessibilityElementsHidden>
                                  ·
                                </Text>
                              }
                            >
                              <BaseButton
                                onPress={() => void s.previewChannelToolSchema(channel(), row())}
                                accessibilityLabel={`${t("settings_tool_schema_preview")}: ${row().id} · ${channel().title}`}
                                testID={`settings-tool-matrix-${row().id}-${channel().id}`}
                                class="size-[26px] items-center justify-center rounded-(--radius) border border-transparent hover:border-line-soft hover:bg-foreground/6"
                              >
                                <Icon name="PhCheck" size={16} color="status-on" />
                              </BaseButton>
                            </If>
                          </View>
                        )}
                      </Each>
                    </View>
                  )}
                </Each>
              </View>
            </MatrixFrame>
          </View>
        </View>
      </SettingsCard>
    </View>
  );
}
