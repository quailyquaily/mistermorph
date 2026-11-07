// Tools: each built-in tool with its switch, its Advanced settings and its schema, in groups; then
// the tools channel runtimes add, as a matrix of tool by channel.
import { Image, Scroll, Text, View } from "nsh";
import { Button as BaseButton } from "nsh/base";
import { TOOL_ADVANCED_CONFIG_GROUPS } from "../../../lib/core/config-field-groups.js";
import { Button, Icon } from "../../../components/ui";
import { InlineNotice } from "../../../components/settings/DialogShell";
import { SettingToggleRow, SettingsCard } from "../../../components/settings-page/parts";
import { TOOL_CHANNEL_ROWS, TOOL_CHANNELS, TOOL_GROUPS, type ToolChannel } from "../constants";
import type { SettingsStore } from "../store";
import { t } from "../i18n";

const CELL = "w-24 items-center justify-center px-2 py-2";

function ChannelHeading(props: { channel: ToolChannel }) {
  return (
    <View class={`${CELL} gap-1`}>
      <If when={props.channel.logo} else={<Icon name={props.channel.icon!} size={16} color="subtle" />}>
        <Image src={props.channel.logo!} accessibilityElementsHidden style={{ width: 16, height: 16 }} />
      </If>
      <Text class="text-xs text-subtle">{props.channel.title}</Text>
    </View>
  );
}

export function ToolsSection(props: { s: SettingsStore }) {
  const s = props.s;
  const busy = () => s.agentLoading() || s.agentSaving();
  const hasAdvanced = (id: string) => Boolean((TOOL_ADVANCED_CONFIG_GROUPS as Record<string, unknown>)[id]);
  return (
    <View class="gap-5" testID="settings-tools">
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
              <View class="gap-1">
                <Text class="font-mono text-xs uppercase tracking-wide text-muted-foreground">{t(group().titleKey)}</Text>
                <View>
                  <Each of={group().tools} key={(item) => item.id}>
                    {(item, index) => (
                      <SettingToggleRow
                        first={index() === 0}
                        title={t(item().titleKey)}
                        note={t(item().noteKey)}
                        leading={<Icon name={item().icon} size={18} color="subtle" />}
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
                            <Text class="font-mono text-xs uppercase text-muted-foreground">{t("settings_tool_automatic")}</Text>
                          ) : undefined
                        }
                      />
                    )}
                  </Each>
                </View>
              </View>
            )}
          </Each>

          <View class="gap-2">
            <Text class="font-mono text-xs uppercase tracking-wide text-muted-foreground">{t("settings_tool_group_channels")}</Text>
            <Text class="text-xs text-muted-foreground">{t("settings_tool_group_note_channels")}</Text>
            <Scroll horizontal class="shrink" testID="settings-tool-matrix">
              <View class="rounded-(--radius) border border-line-faint">
                <View class="flex-row border-b border-line-faint">
                  <View class="w-48 px-2 py-2" />
                  <Each of={TOOL_CHANNELS} key={(channel) => channel.id}>
                    {(channel) => <ChannelHeading channel={channel()} />}
                  </Each>
                </View>
                <Each of={TOOL_CHANNEL_ROWS} key={(row) => row.id}>
                  {(row, index) => (
                    <View class={`flex-row ${index() === 0 ? "" : "border-t border-line-faint"}`}>
                      <View class="w-48 flex-row items-center gap-2 px-2 py-2">
                        <Icon name={row().icon} size={15} color="subtle" />
                        <Text class="font-mono text-xs text-foreground">{row().id}</Text>
                      </View>
                      <Each of={TOOL_CHANNELS} key={(channel) => channel.id}>
                        {(channel) => (
                          <View class={CELL}>
                            <If
                              when={channel().tools.includes(row().id)}
                              else={
                                <Text class="text-sm text-muted-foreground" accessibilityElementsHidden>
                                  ·
                                </Text>
                              }
                            >
                              <BaseButton
                                onPress={() => void s.previewChannelToolSchema(channel(), row())}
                                accessibilityLabel={`${t("settings_tool_schema_preview")}: ${row().id} · ${channel().title}`}
                                testID={`settings-tool-matrix-${row().id}-${channel().id}`}
                                class="rounded-(--radius) p-1 hover:bg-hover"
                              >
                                <Icon name="PhCheck" size={14} color="ok" />
                              </BaseButton>
                            </If>
                          </View>
                        )}
                      </Each>
                    </View>
                  )}
                </Each>
              </View>
            </Scroll>
          </View>
        </View>
      </SettingsCard>
    </View>
  );
}
