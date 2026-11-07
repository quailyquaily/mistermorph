// Settings' App section (the Vue console's SettingsAppPanel: install this agent as an app) and the
// Updates card of the System section (the Vue SettingsView's auto-update card: the version, the
// release channel, automatic updates, and the update check with the release it finds).
import type { JSX } from "nsh";
import { cleanup, computed, effect, Image, signal, Text, untracked, View } from "nsh";
import appLogo from "../../assets/images/app_logo_current.svg";
import { endpointApiFetch, endpointState, localeState, runtimeEndpointByRef } from "../../lib/core/context.js";
import { canCheckDesktopUpdate, desktopRuntimeVersion, isDesktopRuntime } from "../../lib/core/desktop-runtime.js";
import { CONSOLE_LOCAL_ENDPOINT_REF, endpointDisplayItem } from "../../lib/core/endpoints.js";
import { pushNotice } from "../../lib/core/notices.js";
import { checkDesktopUpdate, copyText, openExternal, origin } from "../../lib/platform";
import { Button, Icon, Markdown } from "../ui";
import { isMobile } from "../../lib/shell";
import { SettingRow, SettingsCard, SettingSwitch } from "../settings-page/parts";
import { SettingSelect } from "./SettingFields";
import { t } from "./DialogShell";

const UPDATE_RELEASES_URL = "https://mistermorph.com/releases/";

/* ---------- App ---------- */

/** Whether a browser would offer to install from this origin: HTTPS or a loopback address. */
function secureOrigin() {
  try {
    const url = new URL(origin());
    return url.protocol === "https:" || ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

/**
 * Installs the console as an app for the selected agent, named after it and with its avatar.
 * The browser's install offer (`beforeinstallprompt`) does not reach an nsh app, so on the web the
 * panel says how to install from the browser's own menu ("waiting") or why it cannot ("insecure").
 */
export function SettingsAppPanel() {
  const agent = () => {
    const item = runtimeEndpointByRef(endpointState.selectedRef);
    if (!item) return null;
    return {
      name: String(item.agent_name || "").trim() || endpointDisplayItem(item, t).title,
      image: String(item.avatar_url || "").trim(),
    };
  };
  const mode = () => (isDesktopRuntime() ? "desktop" : secureOrigin() ? "waiting" : "insecure");
  const hint = () => t(`settings_app_hint_${mode()}`);

  return (
    <View class="gap-4" testID="settings-app">
      <SettingsCard title={t("settings_app_title")} meta={t("settings_section_app_meta")}>
        <If when={agent()} else={<Text class="text-sm text-muted-foreground">{t("settings_app_no_agent")}</Text>}>
          {(current) => (
            <View class="flex-row flex-wrap items-center gap-3.5">
              <Image
                src={current().image || appLogo}
                accessibilityElementsHidden
                class="rounded-[14px] border border-line/70 bg-paper"
                style={{ width: 56, height: 56 }}
              />
              <View class="min-w-0 flex-1 gap-1">
                <Text class="text-base font-semibold text-subtle" style={{ numberOfLines: 1 }}>
                  {current().name}
                </Text>
                <Text class="text-xs leading-normal text-muted-foreground" testID="settings-app-hint">
                  {hint()}
                </Text>
              </View>
              <If when={mode() === "waiting"}>
                <Button variant="primary" size="xs" class={isMobile() ? "self-stretch" : ""} icon="PhDownloadSimple" label={t("settings_app_install")} disabled />
              </If>
            </View>
          )}
        </If>
      </SettingsCard>
    </View>
  );
}

/* ---------- Updates ---------- */

export interface SettingsUpdatePanelProps {
  /** The endpoint whose /settings/auto-update is shown: the console's own (`ep_console_local`). */
  endpointRef: string;
  /** The Settings page's config revision (`settingsConfigRevision`), sent with a change. */
  configRevision?: string;
  /** A change saved: the config file's new revision, for the page's other saves. */
  onConfigRevision?: (revision: string) => void;
}

interface UpdateResult {
  status?: string;
  channel?: string;
  channel_switch?: boolean;
  update_available?: boolean;
  current_version?: string;
  latest_version?: string;
  release_date?: string;
  release_notes?: string;
  checksum?: string;
  asset_url?: string;
}

const trim = (value: unknown) => String(value ?? "").trim();

function displayVersion(version: unknown) {
  const value = trim(version);
  if (!value || value.toLowerCase() === "dev") return "dev";
  return value.startsWith("v") ? value : `v${value}`;
}

function channelLabel(channel: unknown) {
  const value = trim(channel);
  return value === "community" || value === "pro" ? t(`settings_update_channel_${value}`) : value;
}

/** The release notes as a plain list: no "## Changelog" heading, short commit hashes. */
export function releaseNotesSource(notes: unknown) {
  return String(notes || "")
    .replace(/^\s*#{1,6}\s*changelog\s*$/im, "")
    .replace(/^(\s*[-*+]\s+)([0-9a-f]{40})\b/gim, (_, bullet: string, sha: string) => `${bullet}\`${sha.slice(0, 7)}\``)
    .trim();
}

const Row = SettingRow;

/** A row's control (`.settings-console-control`): at least 180pt, full width on phones. */
const control = () => (isMobile() ? "self-stretch" : "min-w-[180px]");

export function SettingsUpdatePanel(props: SettingsUpdatePanelProps) {
  const loading = signal(false);
  const checking = signal(false);
  const currentVersion = signal(desktopRuntimeVersion() || "dev");
  const result = signal<UpdateResult | null>(null);
  const checkError = signal("");
  const buildChannel = signal("");
  const enabled = signal(false);
  const channel = signal("");
  const revision = signal("");
  const saving = signal(false);
  const checksumCopied = signal(false);
  let seq = 0;
  let copiedTimer: ReturnType<typeof setTimeout> | null = null;
  cleanup(() => {
    seq += 1;
    if (copiedTimer) clearTimeout(copiedTimer);
  });

  const endpointRef = () => untracked(() => trim(props.endpointRef));
  const isCurrent = (requestSeq: number, target: string) => requestSeq === seq && target === endpointRef();

  function apply(payload: any) {
    const settings = payload?.auto_update || {};
    enabled.set(settings.enabled === true);
    channel.set(trim(settings.channel) || trim(payload?.build_channel) || untracked(buildChannel));
    const next = trim(payload?.config_revision);
    if (next) revision.set(next);
  }

  async function load() {
    const requestSeq = ++seq;
    const target = endpointRef();
    loading.set(true);
    checking.set(false);
    result.set(null);
    checkError.set("");
    try {
      const data = await endpointApiFetch(target, "/settings/auto-update");
      if (!isCurrent(requestSeq, target)) return;
      const nativeVersion = target === CONSOLE_LOCAL_ENDPOINT_REF ? desktopRuntimeVersion() : "";
      currentVersion.set(nativeVersion || trim(data?.current_version) || "dev");
      buildChannel.set(trim(data?.build_channel));
      apply(data);
    } catch (e) {
      if (isCurrent(requestSeq, target)) pushNotice({ type: "error", text: (e as Error)?.message || t("msg_load_failed") });
    } finally {
      if (isCurrent(requestSeq, target)) loading.set(false);
    }
  }

  async function save(change: Record<string, unknown>) {
    const target = endpointRef();
    saving.set(true);
    try {
      const payload = await endpointApiFetch(target, "/settings/auto-update", {
        method: "PUT",
        body: { config_revision: untracked(() => props.configRevision) || untracked(revision), auto_update: change },
      });
      if (target !== endpointRef()) return;
      apply({ ...payload, build_channel: untracked(buildChannel) });
      // Keep the page's other System saves on the new revision of the same config file.
      const next = trim(payload?.config_revision);
      if (next) props.onConfigRevision?.(next);
    } catch (e) {
      pushNotice({ type: "error", text: (e as Error)?.message || t("msg_save_failed") });
      await load();
    } finally {
      saving.set(false);
    }
  }

  function setChannel(value: string) {
    const next = trim(value);
    if (!next || next === untracked(channel)) return;
    channel.set(next);
    // A result belongs to the channel it checked.
    result.set(null);
    checkError.set("");
    void save({ channel: next });
  }

  function setEnabled(value: boolean) {
    if (value === untracked(enabled)) return;
    enabled.set(value);
    void save({ enabled: value });
  }

  const checkDisabled = () => loading() || checking();

  async function runCheck() {
    if (untracked(checkDisabled)) return;
    checking.set(true);
    checkError.set("");
    checksumCopied.set(false);
    const requestSeq = seq;
    const target = endpointRef();
    const selected = trim(untracked(channel)) || null;
    const path = selected === null ? "/settings/auto-update/check" : `/settings/auto-update/check?channel=${encodeURIComponent(selected)}`;
    try {
      const answer = (
        canCheckDesktopUpdate() && target === CONSOLE_LOCAL_ENDPOINT_REF
          ? await checkDesktopUpdate(selected)
          : await endpointApiFetch(target, path, { method: "POST" })
      ) as UpdateResult;
      if (!isCurrent(requestSeq, target)) return;
      result.set(answer);
      currentVersion.set(trim(answer?.current_version) || untracked(currentVersion));
    } catch (e) {
      if (isCurrent(requestSeq, target)) {
        result.set(null);
        checkError.set((e as Error)?.message || t("msg_load_failed"));
      }
    } finally {
      if (isCurrent(requestSeq, target)) checking.set(false);
    }
  }

  // idle: not checked yet; current, available, unknown (a dev build), or error after a check.
  const state = computed(() => {
    if (checking()) return "checking";
    if (checkError()) return "error";
    const current = result();
    if (!current) return "idle";
    if (current.update_available === true || current.channel_switch === true) return "available";
    if (current.status === "current_version_unknown") return "unknown";
    return "current";
  });
  const stateText = () => {
    const current = result();
    const version = displayVersion(current?.latest_version);
    const name = channelLabel(current?.channel);
    switch (state()) {
      case "checking":
        return t("settings_update_checking");
      case "error":
        return t("settings_update_failed", { error: checkError() });
      case "available":
        return current?.channel_switch === true
          ? t("settings_update_switch_available", { channel: name, version })
          : t("settings_update_available", { version });
      case "unknown":
        return t("settings_update_dev_build", { channel: name, version });
      case "current":
        return t("settings_update_up_to_date", { channel: name });
      default:
        return t("settings_update_not_checked");
    }
  };
  const stateTone = () =>
    state() === "error" ? "text-danger" : state() === "available" ? "text-blue-dark" : state() === "current" ? "text-ok" : "text-muted-foreground";
  const installedText = () => {
    const version = displayVersion(trim(result()?.current_version) || trim(currentVersion()) || "dev");
    const name = channelLabel(buildChannel());
    return name ? `${version} · ${name}` : version;
  };
  const hasRelease = () => (state() === "available" || state() === "unknown") && Boolean(trim(result()?.latest_version));
  const releaseTitle = () =>
    t("settings_update_release_title", { channel: channelLabel(result()?.channel), version: displayVersion(result()?.latest_version) });
  const releaseDate = () => {
    const raw = trim(result()?.release_date);
    const date = raw ? new Date(raw) : null;
    if (!date || Number.isNaN(date.getTime())) return "";
    try {
      return new Intl.DateTimeFormat(localeState.lang || undefined, { dateStyle: "medium" }).format(date);
    } catch {
      return date.toISOString().slice(0, 10);
    }
  };
  const notes = () => releaseNotesSource(result()?.release_notes);
  const checksum = () => trim(result()?.checksum);
  const checksumShort = () => {
    const value = checksum().replace(/^sha256:/i, "");
    return value.length > 24 ? `${value.slice(0, 12)}…${value.slice(-8)}` : value;
  };
  const assetURL = () => trim(result()?.asset_url);

  async function copyChecksum() {
    const value = untracked(checksum);
    if (!value) return;
    try {
      await copyText(value);
      checksumCopied.set(true);
      pushNotice({ type: "success", text: t("settings_desktop_update_checksum_copied") });
      if (copiedTimer) clearTimeout(copiedTimer);
      copiedTimer = setTimeout(() => {
        checksumCopied.set(false);
        copiedTimer = null;
      }, 1200);
    } catch (e) {
      pushNotice({ type: "error", text: (e as Error)?.message || t("msg_save_failed") });
    }
  }

  function openReleases() {
    const name = trim(untracked(result)?.channel);
    openExternal(name ? `${UPDATE_RELEASES_URL}?channel=${encodeURIComponent(name)}` : UPDATE_RELEASES_URL);
  }

  // Loads when shown and when the endpoint changes.
  effect(() => {
    void props.endpointRef;
    untracked(() => void load());
  });

  return (
    <SettingsCard title={t("settings_auto_update_card_title")} meta={t("settings_auto_update_card_hint")} list>
      <View testID="settings-update">
        <Row first title={t("settings_update_channel_title")} note={t("settings_update_channel_hint")}>
          <View class={isMobile() ? "self-stretch" : "w-[180px]"}>
            <SettingSelect
              value={channel()}
              options={[
                { title: t("settings_update_channel_community"), value: "community" },
                { title: t("settings_update_channel_pro"), value: "pro" },
              ]}
              label={t("settings_update_channel_title")}
              disabled={loading() || saving()}
              onChange={setChannel}
              testID="settings-update-channel"
            />
          </View>
        </Row>
        <Row inline title={t("settings_update_auto_title")} note={t("settings_update_auto_hint")}>
          <SettingSwitch
            checked={enabled()}
            disabled={loading() || saving()}
            onChange={setEnabled}
            accessibilityLabel={t("settings_update_auto_title")}
            testID="settings-update-auto"
          />
        </Row>
        <Row
          title={t("settings_update_version_title")}
          note={installedText()}
          status={
            <Text class={`text-xs leading-[17.4px] ${stateTone()}`} testID="settings-update-state">
              {stateText()}
            </Text>
          }
        >
          <Button
            variant="outlined"
            size="md"
            class={control()}
            icon="PhArrowClockwise"
            label={t("settings_update_check_action")}
            loading={checking()}
            disabled={checkDisabled()}
            onPress={() => void runCheck()}
            testID="settings-update-check"
          />
        </Row>
        <If when={hasRelease()}>
          <View class="flex-row flex-wrap items-start gap-3 border-t border-line-soft py-3" testID="settings-update-release">
            <View class="min-w-60 flex-1 gap-1.5">
              <Text class="text-sm font-medium text-foreground">{releaseTitle()}</Text>
              <View class="flex-row flex-wrap items-center gap-2">
                <If when={releaseDate()}>
                  <Text class="text-xs text-muted-foreground">{releaseDate()}</Text>
                </If>
                <Button variant="plain" size="xxs" label={t("settings_update_all_releases")} onPress={openReleases}>
                  <Icon name="PhArrowUpRight" size={12} color="subtle" />
                </Button>
              </View>
              <If when={notes()} else={<Text class="text-xs text-muted-foreground">{t("settings_desktop_update_changelog_empty")}</Text>}>
                <Markdown source={notes()} class="text-xs" />
              </If>
              <If when={checksum()}>
                <Button
                  variant="plain"
                  size="xxs"
                  class="-ml-2"
                  title={checksum()}
                  onPress={() => void copyChecksum()}
                  testID="settings-update-checksum"
                >
                  <Text class="text-xs text-subtle">SHA256</Text>
                  <Text class="font-mono text-xs text-foreground">{checksumShort()}</Text>
                  <Icon name={checksumCopied() ? "PhCheckCircle" : "PhCopy"} size={12} color="subtle" />
                </Button>
              </If>
            </View>
            <Button
              variant="outlined"
              icon="PhCloudArrowDown"
              label={t("settings_desktop_update_download_action")}
              disabled={!assetURL()}
              onPress={() => assetURL() && openExternal(assetURL())}
              testID="settings-update-download"
            />
          </View>
        </If>
      </View>
    </SettingsCard>
  );
}
