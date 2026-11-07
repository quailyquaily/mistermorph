// Channels: a tile per channel (configured first), and the channel's settings in a pane at the
// right (a sheet on phones). Closing the pane keeps the draft: it stays in the save bar, and the
// tile shows it is unsaved.
import type { JSX } from "nsh";
import { Image, keymap, Scroll, Text, untracked, View } from "nsh";
import { Button as BaseButton } from "nsh/base";
import { endpointApiFetch } from "../../../lib/core/context.js";
import { CHANNEL_TRIGGER_CONFIG_GROUPS } from "../../../lib/core/config-field-groups.js";
import { Button, DropdownMenu, SelectField, SidePane, TextField } from "../../../components/ui";
import { ConfigSettingsPanel, type ConfigGroup } from "../../../components/settings/ConfigSettingsPanel";
import { EnvManagedField } from "../../../components/settings/EnvManagedField";
import { SecretInput } from "../../../components/settings/SecretInput";
import { WeChatLoginPanel, XLoginPanel } from "../../../components/settings/ChannelLoginPanels";
import { DirtyDot, SettingField, SettingToggleRow } from "../../../components/settings-page/parts";
import { CHANNEL_LOGOS } from "../constants";
import type { SettingsStore } from "../store";
import { t } from "../i18n";

type Field =
  | { kind: "secret"; field: string; key: string; note?: boolean }
  | { kind: "text"; field: string; key: string; note?: boolean }
  | { kind: "envText"; field: string; key: string; note?: boolean }
  | { kind: "list"; field: string; key: string; rows: number; placeholderKey?: string }
  | { kind: "trigger" }
  | { kind: "wechat" }
  | { kind: "xlogin" };

// Each channel's fields, in the Vue page's order. `key` is the i18n stem: `<stem>_label`,
// `<stem>_placeholder`, `<stem>_note`.
const CHANNEL_FIELDS: Record<string, { metaKey: string; fields: Field[] }> = {
  telegram: {
    metaKey: "settings_console_telegram_token_note",
    fields: [
      { kind: "secret", field: "bot_token", key: "settings_console_telegram_bot_token" },
      { kind: "list", field: "allowed_chat_ids_text", key: "settings_console_telegram_allowed_chat_ids", rows: 4 },
      { kind: "trigger" },
    ],
  },
  slack: {
    metaKey: "settings_console_slack_token_note",
    fields: [
      { kind: "secret", field: "bot_token", key: "settings_console_slack_bot_token" },
      { kind: "secret", field: "app_token", key: "settings_console_slack_app_token" },
      { kind: "list", field: "allowed_team_ids_text", key: "settings_console_slack_allowed_team_ids", rows: 3 },
      { kind: "list", field: "allowed_channel_ids_text", key: "settings_console_slack_allowed_channel_ids", rows: 4 },
      { kind: "trigger" },
    ],
  },
  line: {
    metaKey: "settings_console_line_token_note",
    fields: [
      { kind: "secret", field: "channel_access_token", key: "settings_console_line_channel_access_token" },
      { kind: "secret", field: "channel_secret", key: "settings_console_line_channel_secret" },
      { kind: "list", field: "allowed_group_ids_text", key: "settings_console_line_allowed_group_ids", rows: 4 },
      { kind: "trigger" },
    ],
  },
  lark: {
    metaKey: "settings_console_lark_token_note",
    fields: [
      { kind: "envText", field: "app_id", key: "settings_console_lark_app_id" },
      { kind: "secret", field: "app_secret", key: "settings_console_lark_app_secret" },
      { kind: "list", field: "allowed_chat_ids_text", key: "settings_console_lark_allowed_chat_ids", rows: 4 },
      { kind: "trigger" },
    ],
  },
  mixin: {
    metaKey: "settings_console_mixin_note",
    fields: [
      { kind: "envText", field: "keystore_file", key: "settings_console_mixin_keystore_file", note: true },
      { kind: "list", field: "allowed_conversation_ids_text", key: "settings_console_mixin_allowed_conversation_ids", rows: 4 },
    ],
  },
  discord: {
    metaKey: "settings_console_discord_token_note",
    fields: [
      { kind: "secret", field: "bot_token", key: "settings_console_discord_bot_token" },
      {
        kind: "list",
        field: "allowed_guild_ids_text",
        key: "settings_console_discord_allowed_guild_ids",
        rows: 3,
        placeholderKey: "settings_console_discord_allowed_ids_placeholder",
      },
      {
        kind: "list",
        field: "allowed_channel_ids_text",
        key: "settings_console_discord_allowed_channel_ids",
        rows: 3,
        placeholderKey: "settings_console_discord_allowed_ids_placeholder",
      },
      {
        kind: "list",
        field: "allowed_user_ids_text",
        key: "settings_console_discord_allowed_user_ids",
        rows: 3,
        placeholderKey: "settings_console_discord_allowed_ids_placeholder",
      },
      { kind: "trigger" },
    ],
  },
  wechat: { metaKey: "settings_console_wechat_note", fields: [{ kind: "wechat" }] },
  whatsapp: {
    metaKey: "settings_console_whatsapp_note",
    fields: [{ kind: "secret", field: "api_token", key: "settings_console_whatsapp_api_token", note: true }],
  },
  bluesky: {
    metaKey: "settings_console_bluesky_note",
    fields: [
      { kind: "text", field: "identifier", key: "settings_console_bluesky_identifier", note: true },
      { kind: "secret", field: "app_password", key: "settings_console_bluesky_app_password", note: true },
      { kind: "text", field: "service_url", key: "settings_console_bluesky_service_url", note: true },
    ],
  },
  x: {
    metaKey: "settings_console_x_note",
    fields: [
      { kind: "text", field: "client_id", key: "settings_console_x_client_id", note: true },
      { kind: "secret", field: "client_secret", key: "settings_console_x_client_secret", note: true },
      { kind: "xlogin" },
    ],
  },
};

export function ChannelsSection(props: { s: SettingsStore }) {
  const s = props.s;
  return (
    <View class="gap-6" testID="settings-channels">
      <Each of={s.channelGroups()} key={(group) => group.id}>
        {(group) => (
          <View class="gap-2">
            <Text class="font-mono text-xs uppercase tracking-wide text-muted-foreground">{t(group().titleKey)}</Text>
            <View class="flex-row flex-wrap gap-3">
              <Each of={group().items} key={(item) => item.id}>
                {(item) => (
                  <BaseButton
                    onPress={() => s.openChannelPane(untracked(item).id)}
                    selected={s.openChannel() === item().id}
                    accessibilityLabel={t(item().titleKey)}
                    testID={`settings-channel-${item().id}`}
                    class={`w-40 flex-row items-center gap-2.5 rounded-(--radius) border bg-card px-3 py-3 hover:bg-hover ${
                      s.openChannel() === item().id ? "border-blue bg-selection" : "border-line-faint"
                    } ${item().configured ? "" : "opacity-80"}`}
                  >
                    <Image src={CHANNEL_LOGOS[item().id]} accessibilityElementsHidden style={{ width: 22, height: 22 }} />
                    <Text class="flex-1 text-sm font-medium text-foreground line-clamp-1">{t(item().titleKey)}</Text>
                    <If when={item().running}>
                      <View
                        accessibilityLabel={t("settings_channel_state_running")}
                        testID={`settings-channel-${item().id}-running`}
                        class="size-2 rounded-full bg-ok"
                      />
                    </If>
                    <If when={item().dirty}>
                      <DirtyDot label={t("settings_channel_unsaved")} testID={`settings-channel-${item().id}-dirty`} />
                    </If>
                  </BaseButton>
                )}
              </Each>
            </View>
          </View>
        )}
      </Each>
    </View>
  );
}

function ChannelField(props: { s: SettingsStore; channel: string; field: Field }) {
  const s = props.s;
  const channel = props.channel;
  const f = props.field;
  const draft = () => (s.state as any)[channel] as Record<string, any>;
  const busy = () => s.consoleLoading() || s.consoleSaving();
  const set = (field: string, value: unknown) => s.updateChannelField(channel as any, field, value);
  switch (f.kind) {
    case "secret":
      return (
        <SettingField label={t(`${f.key}_label`)} note={f.note ? t(`${f.key}_note`) : undefined}>
          <SecretInput
            envName={s.consoleFieldManagedHeadline(channel, f.field)}
            value={draft()[f.field]}
            status={s.consoleSecretField(channel, f.field)}
            revealPath={s.consoleSecretRevealPath(channel, f.field)}
            placeholder={t(`${f.key}_placeholder`)}
            disabled={busy()}
            onChange={(value) => set(f.field, value)}
            testID={`settings-${channel}-${f.field}`}
          />
        </SettingField>
      );
    case "text":
      return (
        <SettingField label={t(`${f.key}_label`)} note={f.note ? t(`${f.key}_note`) : undefined}>
          <TextField
            value={draft()[f.field]}
            onChange={(value) => set(f.field, value)}
            placeholder={t(`${f.key}_placeholder`)}
            accessibilityLabel={t(`${f.key}_label`)}
            disabled={busy()}
            testID={`settings-${channel}-${f.field}`}
          />
        </SettingField>
      );
    case "envText":
      return (
        <SettingField label={t(`${f.key}_label`)} note={f.note ? t(`${f.key}_note`) : undefined}>
          <If
            when={s.consoleFieldEnvManaged(channel, f.field)}
            else={
              <TextField
                value={draft()[f.field]}
                onChange={(value) => set(f.field, value)}
                placeholder={t(`${f.key}_placeholder`)}
                accessibilityLabel={t(`${f.key}_label`)}
                disabled={busy()}
                testID={`settings-${channel}-${f.field}`}
              />
            }
          >
            <EnvManagedField name={s.consoleFieldManagedHeadline(channel, f.field)} />
          </If>
        </SettingField>
      );
    case "list":
      return (
        <SettingField label={t(`${f.key}_label`)} note={t(`${f.key}_note`)}>
          <TextField
            value={draft()[f.field]}
            onChange={(value) => set(f.field, value)}
            multiline
            rows={f.rows}
            placeholder={t(f.placeholderKey || `${f.key}_placeholder`)}
            accessibilityLabel={t(`${f.key}_label`)}
            disabled={busy()}
            testID={`settings-${channel}-${f.field}`}
          />
        </SettingField>
      );
    case "trigger": {
      const fallback = channel === "discord" ? "strict" : "talkative";
      return (
        <SettingField label={t("settings_console_group_trigger_label")} note={t(`settings_console_${channel}_group_trigger_note`)}>
          <SelectField
            items={s.groupTriggerItems().map((item) => ({ value: item.value, label: item.title }))}
            value={s.groupTriggerItems().some((item) => item.value === draft().group_trigger_mode) ? draft().group_trigger_mode : fallback}
            onChange={(value) => s.updateGroupTrigger(channel as any, value)}
            testID={`settings-${channel}-group-trigger`}
          />
        </SettingField>
      );
    }
    case "wechat":
      return (
        <SettingField label={t("settings_console_wechat_account_label")}>
          <If
            when={s.consoleFieldEnvManaged("wechat", "bot_token")}
            else={
              <WeChatLoginPanel
                request={endpointApiFetch as any}
                endpointRef={s.settingsEndpointRef()}
                configured={s.consoleSecretField("wechat", "bot_token")?.configured === true}
                botId={s.state.wechat.bot_id}
                disabled={busy()}
                onChanged={() => void s.reloadConsoleSettingsAfterLogin()}
              />
            }
          >
            <EnvManagedField name={s.consoleFieldManagedHeadline("wechat", "bot_token")} />
          </If>
        </SettingField>
      );
    case "xlogin":
      return (
        <SettingField label={t("settings_console_x_account_label")} note={t("settings_console_x_account_note")}>
          <If
            when={s.consoleFieldEnvManaged("x", "refresh_token")}
            else={
              <XLoginPanel
                request={endpointApiFetch as any}
                endpointRef={s.settingsEndpointRef()}
                loggedIn={s.state.x.login?.logged_in === true}
                username={s.state.x.login?.username || ""}
                ready={s.xLoginReady()}
                disabled={busy()}
                onChanged={() => void s.reloadConsoleSettingsAfterLogin()}
              />
            }
          >
            <EnvManagedField name={s.consoleFieldManagedHeadline("x", "refresh_token")} />
          </If>
        </SettingField>
      );
  }
}

function ChannelPaneBody(props: { s: SettingsStore }) {
  const s = props.s;
  const managed = () => s.channelManagedItem(s.openChannel());
  return (
    <View class="gap-4">
      <Each of={s.openChannel() ? [s.openChannel()] : []} key={(id) => id}>
        {(id) => (
          <View class="gap-4">
            <Each of={CHANNEL_FIELDS[id()]?.fields || []}>{(field) => <ChannelField s={s} channel={untracked(id)} field={field()} />}</Each>
          </View>
        )}
      </Each>
      {/* Kept mounted while another channel (or none) is open, so a draft here is not lost. */}
      <Each of={CHANNEL_TRIGGER_CONFIG_GROUPS as ConfigGroup[]} key={(group) => group.id}>
        {(group) => (
          <View style={{ display: s.openChannel() === group().id ? "flex" : "none" }} testID={`settings-channel-trigger-${group().id}`}>
            <ConfigSettingsPanel
              groups={[group()]}
              values={s.consoleConfigValues()}
              fieldStates={s.consoleFieldStates()}
              loading={s.consoleLoading()}
              saving={s.consoleSaving() && s.consoleSavingTarget() === "config"}
              hiddenPaths={s.channelTriggerHiddenPaths(group().id)}
              embedded
              hideSingleGroupHeading
              saveScope="console"
              onSave={(update) => void s.saveConfigSettings("console", update)}
            />
          </View>
        )}
      </Each>
      <If when={managed()}>
        {(item) => (
          <View class="border-t border-line-faint">
            <SettingToggleRow
              first
              title={t("settings_channel_run_in_console")}
              note={t(item().noteKey)}
              checked={!!s.state.managedRuntimes[s.openChannel()]}
              disabled={s.consoleLoading() || s.consoleSaving()}
              onChange={(checked) => s.setManagedRuntimeEnabled(untracked(s.openChannel), checked)}
              testID="settings-channel-run-in-console"
            />
          </View>
        )}
      </If>
    </View>
  );
}

function ChannelPaneHeader(props: { s: SettingsStore }) {
  const s = props.s;
  const id = () => s.openChannel();
  return (
    <View class="flex-row items-start gap-3 border-b border-line-faint px-4 py-3">
      <View class="flex-1 gap-0.5">
        <Text class="text-base font-semibold text-foreground line-clamp-1" role="header">
          {t(s.openChannelTitleKey())}
        </Text>
        <If when={CHANNEL_FIELDS[id()]?.metaKey}>
          <Text class="text-xs text-muted-foreground">{t(CHANNEL_FIELDS[id()]?.metaKey || "")}</Text>
        </If>
      </View>
      <DropdownMenu
        trigger={
          <Button
            variant="plain"
            size="xs"
            iconOnly
            icon="PhDotsThree"
            title={t("todo_action_more")}
            disabled={s.consoleLoading() || s.consoleSaving()}
            testID="settings-channel-menu"
          />
        }
        items={s.channelActionMenuItems(id())}
      />
      <Button variant="plain" size="xs" iconOnly icon="PhX" title={t("settings_channel_close")} onPress={() => s.closeChannelPane()} testID="settings-channel-close" />
    </View>
  );
}

/**
 * The open channel's pane. On wide windows it is a column that stays mounted while closed (hidden),
 * so the trigger settings keep their drafts; on phones it is a sheet.
 */
export function ChannelPane(props: { s: SettingsStore; sheet?: boolean }) {
  const s = props.s;
  const open = () => Boolean(s.openChannel());
  const frame = (body: JSX.Element) => (
    <View class="flex-1" testID="settings-channel-pane" accessibilityLabel={t(s.openChannelTitleKey())}>
      <ChannelPaneHeader s={s} />
      <Scroll class="flex-1" contentClass="gap-4 p-4 pb-28">
        {body}
      </Scroll>
    </View>
  );
  keymap.bind("escape", () => {
    if (untracked(open) && !props.sheet) s.closeChannelPane();
  });
  return (
    <If
      when={props.sheet}
      else={
        <View class="w-96 border-l border-line-faint bg-card" style={{ display: open() ? "flex" : "none" }}>
          {frame(<ChannelPaneBody s={s} />)}
        </View>
      }
    >
      <SidePane open={open()} sheet onClose={() => s.closeChannelPane()} label={t(s.openChannelTitleKey())}>
        {frame(<ChannelPaneBody s={s} />)}
      </SidePane>
    </If>
  );
}
