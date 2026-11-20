// Settings' App section (the Vue console's SettingsAppPanel: install this agent as an app) and the
// Updates card of the System section: the shell's and the server's versions side by side, one
// button that checks both, each one's own download, one list of release notes for what the checks
// found, and automatic updates.
import type { JSX, ViewRef } from "nsh";
import { cleanup, computed, effect, Image, signal, Text, untracked, View } from "nsh";
import appLogo from "../../assets/images/app_logo_current.svg";
import { endpointApiFetch, endpointState, localeState, runtimeEndpointByRef } from "../../lib/core/context.js";
import { canCheckDesktopUpdate, isDesktopRuntime } from "../../lib/core/desktop-runtime.js";
import { endpointDisplayItem } from "../../lib/core/endpoints.js";
import { pushNotice } from "../../lib/core/notices.js";
import { checkDesktopUpdate, copyText, downloadTarget, openExternal, origin, shellInfo } from "../../lib/platform";
import { shellCheck, shellReleaseAnswer } from "../../lib/updateTargets";
import { type DownloadFile, type DownloadTarget, downloadChoice, downloadQuery, systemName, UNKNOWN_TARGET } from "../../lib/downloadTarget";
import { Button, Markdown } from "../ui";
import { isMobile } from "../../lib/shell";
import { SettingRow, SettingsCard, SettingSwitch } from "../settings-page/parts";
import { boundsFrame, createPartProbe, type PartLayoutListener } from "../shared/partProbe";
import { t } from "./DialogShell";

const UPDATE_RELEASES_URL = "https://mistermorph.com/releases/";
// The release source every check reads. The card offers no channel to pick: a check names this one
// itself, whatever channel the server's settings hold, and never saves it there.
const UPDATE_CHANNEL = "community";

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
                <Button variant="primary" size="xs" icon="PhDownloadSimple" label={t("settings_app_install")} disabled />
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
  /** Layout probe for tests: a target's download box (`shell.release`, `server.release`), its downloads column (`<target>.downloads`) and each download button (`button:<testID>`) on the page. */
  onPartLayout?: PartLayoutListener;
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
  /** The server's own platform (`linux-amd64`), which `asset_url` and `checksum` are for. */
  platform?: string;
  /** The file for the machine the Console runs on (`download_os` in the check). */
  download?: unknown;
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

/** One entry of the shared release notes: a release, and the components whose check found it. */
export interface ReleaseNote {
  key: string;
  targets: UpdateTarget[];
  version: string;
  date: string;
  notes: string;
}

/**
 * The releases the checks found as one list of notes. Components that found the same version with
 * the same notes (apart from spacing) share one entry; a different version, or other notes for the
 * same version, is its own entry. In the order given.
 */
export function releaseNoteEntries(found: { target: UpdateTarget; version: unknown; date?: unknown; notes?: unknown }[]): ReleaseNote[] {
  const entries: ReleaseNote[] = [];
  for (const item of found) {
    const version = trim(item.version);
    if (!version) continue;
    const notes = releaseNotesSource(item.notes);
    const key = `${displayVersion(version)}\n${notes.replace(/\s+/g, " ")}`;
    const same = entries.find((entry) => entry.key === key);
    if (same) {
      if (!same.targets.includes(item.target)) same.targets.push(item.target);
      if (!same.date) same.date = trim(item.date);
      continue;
    }
    entries.push({ key, targets: [item.target], version: displayVersion(version), date: trim(item.date), notes });
  }
  return entries;
}

function formatReleaseDate(raw: string) {
  const date = raw ? new Date(raw) : null;
  if (!date || Number.isNaN(date.getTime())) return "";
  try {
    return new Intl.DateTimeFormat(localeState.lang || undefined, { dateStyle: "medium" }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

const Row = SettingRow;

/** Which version a row of the Updates card is about: the installed app's (`shell`) or the connected server's. */
export type UpdateTarget = "shell" | "server";

/**
 * One target's update check: whether it runs, its answer or error, and what the answer's download
 * is for (the desktop app's own check, a device's system, or none: a server-only check).
 */
function createUpdateCheck() {
  const checking = signal(false);
  const result = signal<UpdateResult | null>(null);
  const error = signal("");
  const native = signal(false);
  const device = signal<DownloadTarget>(UNKNOWN_TARGET);
  // The check asked for no device's file (the server's check from a native app): the release box
  // points at the releases page for the server's builds.
  const serverOnly = signal(false);
  const copied = signal(false);
  return {
    checking,
    result,
    error,
    native,
    device,
    serverOnly,
    copied,
    reset() {
      checking.set(false);
      result.set(null);
      error.set("");
      copied.set(false);
    },
    // idle: not checked yet; current, available, unknown (a dev build), or error after a check.
    state: computed(() => {
      if (checking()) return "checking";
      if (error()) return "error";
      const current = result();
      if (!current) return "idle";
      if (current.update_available === true || current.channel_switch === true) return "available";
      if (current.status === "current_version_unknown") return "unknown";
      return "current";
    }),
  };
}
type UpdateCheck = ReturnType<typeof createUpdateCheck>;

/**
 * The Updates card. Two versions in one list, each from its own source and with its own check; one
 * button runs every check there is, and each answers (or fails) for itself:
 * - Shell version: the installed app the Console runs in (lib/platform.ts `shellInfo`), absent in a
 *   browser. The desktop app checks for itself; the Android app compares its installed version with
 *   the release's (the server's check with `download_os=android` reads the release feed and finds the
 *   APK); elsewhere, or without a known installed version, the row says checking is unavailable.
 * - Server version: the connected console server's (`GET /settings/auto-update`), checked by the
 *   server (`POST /settings/auto-update/check`). In a browser that check also names this device's
 *   download (`download_os`), as there is no shell to update.
 * A failed or missing lookup of one is "Unknown" there, never the other's version.
 * What the checks found is told once, below both: the release notes, shared by the components
 * that found the same release. A download stays its component's own, under its row.
 */
export function SettingsUpdatePanel(props: SettingsUpdatePanelProps) {
  const loading = signal(false);
  const buildChannel = signal("");
  const enabled = signal(false);
  const revision = signal("");
  const saving = signal(false);
  // The server's version: "loading" until its lookup answers, then "known" or "unknown" (failed,
  // or an answer without one). Each load starts over, so another server never shows the last one's.
  const serverLookup = signal<"loading" | "known" | "unknown">("loading");
  const serverVersion = signal("");
  // The shell is the host's, fixed for this run; null in a browser.
  const shell = shellInfo();
  const shellMode = shell ? shellCheck(shell, { checkUpdate: canCheckDesktopUpdate() }) : null;
  const checks: Record<UpdateTarget, UpdateCheck> = { shell: createUpdateCheck(), server: createUpdateCheck() };
  const parts = createPartProbe(() => props.onPartLayout);
  let seq = 0;
  const copiedTimers: Partial<Record<UpdateTarget, ReturnType<typeof setTimeout>>> = {};
  cleanup(() => {
    seq += 1;
    for (const timer of Object.values(copiedTimers)) if (timer) clearTimeout(timer);
  });

  const endpointRef = () => untracked(() => trim(props.endpointRef));
  const isCurrent = (requestSeq: number, target: string) => requestSeq === seq && target === endpointRef();

  function apply(payload: any) {
    const settings = payload?.auto_update || {};
    enabled.set(settings.enabled === true);
    const next = trim(payload?.config_revision);
    if (next) revision.set(next);
  }

  async function load() {
    const requestSeq = ++seq;
    const target = endpointRef();
    loading.set(true);
    serverLookup.set("loading");
    serverVersion.set("");
    buildChannel.set("");
    checks.shell.reset();
    checks.server.reset();
    try {
      const data = await endpointApiFetch(target, "/settings/auto-update");
      if (!isCurrent(requestSeq, target)) return;
      const version = trim(data?.current_version);
      serverVersion.set(version);
      serverLookup.set(version ? "known" : "unknown");
      buildChannel.set(trim(data?.build_channel));
      apply(data);
    } catch (e) {
      if (!isCurrent(requestSeq, target)) return;
      serverLookup.set("unknown");
      pushNotice({ type: "error", text: (e as Error)?.message || t("msg_load_failed") });
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

  function setEnabled(value: boolean) {
    if (value === untracked(enabled)) return;
    enabled.set(value);
    void save({ enabled: value });
  }

  const shellCheckable = () => Boolean(shellMode && shellMode.mode !== "unavailable");
  /** The components there is a check for: the server always, the shell when it has one. */
  const checkable = (): UpdateTarget[] => (shellCheckable() ? ["shell", "server"] : ["server"]);
  const checkingAny = () => checks.shell.checking() || checks.server.checking();
  const checkDisabled = () => loading() || checkingAny();

  /** The server's check: its release, with the file for `device` when one is named. */
  async function serverCheck(target: string, device: DownloadTarget | null) {
    const query = [`channel=${encodeURIComponent(UPDATE_CHANNEL)}`, device ? downloadQuery(device) : ""].filter(Boolean).join("&");
    return (await endpointApiFetch(target, `/settings/auto-update/check?${query}`, { method: "POST" })) as UpdateResult;
  }

  /** The one button: every check there is, side by side. Each ends for itself, so one's failure leaves the other's answer. */
  async function checkAll() {
    if (untracked(checkDisabled)) return;
    await Promise.all(checkable().map((which) => runCheck(which)));
  }

  async function runCheck(which: UpdateTarget) {
    const check = checks[which];
    if (untracked(() => loading() || check.checking())) return;
    if (which === "shell" && (!shell || !shellMode || shellMode.mode === "unavailable")) return;
    check.checking.set(true);
    check.error.set("");
    check.copied.set(false);
    const requestSeq = seq;
    const target = endpointRef();
    try {
      let device = UNKNOWN_TARGET;
      let native = false;
      let serverOnly = false;
      let answer: UpdateResult;
      if (which === "shell" && shellMode?.mode === "native") {
        // The desktop app checks for itself: its own version against its release.
        native = true;
        answer = (await checkDesktopUpdate(UPDATE_CHANNEL)) as UpdateResult;
      } else if (which === "shell" && shellMode?.mode === "release" && shell) {
        // The release's file for this app's system, its version compared with the installed one.
        device = { os: shellMode.os, arch: "" };
        answer = shellReleaseAnswer(shell.version, await serverCheck(target, device));
      } else if (!shell) {
        // A browser has no shell: the server's check also names this device's download.
        device = await downloadTarget();
        answer = await serverCheck(target, device);
      } else {
        serverOnly = true;
        answer = await serverCheck(target, null);
      }
      if (!isCurrent(requestSeq, target)) return;
      check.native.set(native);
      check.device.set(device);
      check.serverOnly.set(serverOnly);
      check.result.set(answer);
      if (which === "server") {
        const version = trim(answer?.current_version);
        if (version) {
          serverVersion.set(version);
          serverLookup.set("known");
        }
      }
    } catch (e) {
      if (isCurrent(requestSeq, target)) {
        check.result.set(null);
        check.error.set((e as Error)?.message || t("msg_load_failed"));
      }
    } finally {
      if (isCurrent(requestSeq, target)) check.checking.set(false);
    }
  }

  const stateText = (which: UpdateTarget) => {
    const check = checks[which];
    if (which === "shell" && shellMode?.mode === "unavailable") {
      return shellMode.reason === "unknown_version" ? t("settings_update_shell_unknown_version") : t("settings_update_shell_unsupported");
    }
    const current = check.result();
    const version = displayVersion(current?.latest_version);
    const name = channelLabel(current?.channel);
    switch (check.state()) {
      case "checking":
        return t("settings_update_checking");
      case "error":
        return t("settings_update_failed", { error: check.error() });
      case "available":
        return current?.channel_switch === true
          ? t("settings_update_switch_available", { channel: name, version })
          : t("settings_update_available", { version });
      case "unknown":
        return t("settings_update_dev_build", { version });
      case "current":
        return t("settings_update_up_to_date");
      default:
        return t("settings_update_not_checked");
    }
  };
  const stateTone = (which: UpdateTarget) => {
    const state = checks[which].state();
    return state === "error" ? "text-danger" : state === "available" ? "text-blue-dark" : state === "current" ? "text-ok" : "text-muted-foreground";
  };
  const installed = (version: string) => t("settings_update_installed", { version: version ? displayVersion(version) : t("settings_update_version_unknown") });
  // The installed app's version, from its host only; "Unknown" when the host cannot tell.
  const shellText = () => {
    if (!shell) return "";
    const fromCheck = checks.shell.native() ? trim(checks.shell.result()?.current_version) : "";
    return `${installed(shell.version || fromCheck)} · ${t(`settings_update_shell_${shell.kind}`)}`;
  };
  // The connected server's version, from that server only. A build of another channel than the one
  // the checks read says so, as its check then offers a switch.
  const serverText = () => {
    if (serverLookup() === "loading") return t("settings_update_version_loading");
    if (serverLookup() === "unknown") return installed("");
    const built = buildChannel();
    return built && built !== UPDATE_CHANNEL ? `${installed(serverVersion())} · ${channelLabel(built)}` : installed(serverVersion());
  };

  /** A component's row: its name, the installed version, and what its check says is available. */
  function versionRow(which: UpdateTarget, first: boolean) {
    return (
      <Row
        first={first}
        title={t(which === "shell" ? "settings_update_shell_title" : "settings_update_server_title")}
        note={which === "shell" ? shellText() : serverText()}
        testID={`settings-update-${which}`}
        status={
          // The view holds the test id, so a test reads which row says what (`id:… >> text:…`).
          <View testID={`settings-update-${which}-state`}>
            <Text class={`text-xs leading-[17.4px] ${stateTone(which)}`}>{stateText(which)}</Text>
          </View>
        }
      />
    );
  }

  // What the checks found, for the shared notes: the shell's first.
  const noteEntries = computed(() => {
    const found = [];
    for (const which of ["shell", "server"] as const) {
      const check = checks[which];
      const state = check.state();
      const current = check.result();
      if ((state === "available" || state === "unknown") && trim(current?.latest_version)) {
        found.push({ target: which, version: current?.latest_version, date: current?.release_date, notes: current?.release_notes });
      }
    }
    return releaseNoteEntries(found);
  });
  const noteTitle = (entry: ReleaseNote) =>
    t("settings_update_notes_entry", {
      component: t(entry.targets.length > 1 ? "settings_update_component_both" : `settings_update_component_${entry.targets[0]}`),
      version: entry.version,
    });

  // Loads when shown and when the endpoint changes.
  effect(() => {
    void props.endpointRef;
    untracked(() => void load());
  });

  return (
    <SettingsCard
      title={t("settings_auto_update_card_title")}
      // A browser has no app of ours to check: the server alone.
      meta={t(shell ? "settings_auto_update_card_hint" : "settings_auto_update_card_hint_server")}
      list
      actions={
        <Button
          variant="outlined"
          size="xs"
          label={t("settings_update_check_action")}
          loading={checkingAny()}
          disabled={checkDisabled()}
          onPress={() => void checkAll()}
          testID="settings-update-check"
        />
      }
    >
      <View testID="settings-update">
        <If when={shell}>
          <>
            {versionRow("shell", true)}
            <ReleaseBox target="shell" check={checks.shell} parts={parts} onPartLayout={props.onPartLayout} timers={copiedTimers} />
          </>
        </If>
        {versionRow("server", !shell)}
        <ReleaseBox target="server" check={checks.server} parts={parts} onPartLayout={props.onPartLayout} timers={copiedTimers} />
        <If when={noteEntries().length > 0}>
          <View class="gap-3 border-t border-line-soft py-3" testID="settings-update-notes">
            <View class="flex-row items-center gap-2">
              <Text role="header" class="min-w-0 flex-1 text-sm font-medium leading-[18.9px] text-foreground">
                {t("settings_update_notes_title")}
              </Text>
              <Button
                variant="plain"
                size="xxs"
                icon="PhArrowUpRight"
                label={t("settings_update_all_releases")}
                onPress={() => openExternal(`${UPDATE_RELEASES_URL}?channel=${UPDATE_CHANNEL}`)}
                testID="settings-update-all-releases"
              />
            </View>
            <Each of={noteEntries()} key={(entry) => entry.key}>
              {(entry) => (
                <View class="gap-1.5" testID="settings-update-note">
                  <View class="flex-row flex-wrap items-center gap-x-2 gap-y-1">
                    <Text class="text-xs font-semibold text-subtle" testID="settings-update-note-title">
                      {noteTitle(entry())}
                    </Text>
                    <If when={formatReleaseDate(entry().date)}>
                      <Text class="text-xs text-muted-foreground">{formatReleaseDate(entry().date)}</Text>
                    </If>
                  </View>
                  <If when={entry().notes} else={<Text class="text-xs text-muted-foreground">{t("settings_desktop_update_changelog_empty")}</Text>}>
                    <Markdown source={entry().notes} class="text-xs" />
                  </If>
                </View>
              )}
            </Each>
          </View>
        </If>
        <Row inline title={t("settings_update_auto_title")} note={t("settings_update_auto_hint")}>
          <SettingSwitch
            checked={enabled()}
            disabled={loading() || saving()}
            onChange={setEnabled}
            accessibilityLabel={t("settings_update_auto_title")}
            testID="settings-update-auto"
          />
        </Row>
      </View>
    </SettingsCard>
  );
}

/**
 * The download of the release a target's check found, under that target's row: the file for it (or
 * why there is none), with the file's checksum. Only this component's: the other's is under its own
 * row, and nothing here installs or restarts anything. The release's notes are the card's shared list.
 */
function ReleaseBox(props: {
  target: UpdateTarget;
  check: UpdateCheck;
  parts: ReturnType<typeof createPartProbe>;
  onPartLayout?: PartLayoutListener;
  timers: Partial<Record<UpdateTarget, ReturnType<typeof setTimeout>>>;
}) {
  const check = props.check;
  const id = (name: string) => `settings-update-${props.target}-${name}`;
  let downloadsNode: ViewRef | undefined;
  const result = () => check.result();
  const hasRelease = () => (check.state() === "available" || check.state() === "unknown") && Boolean(trim(result()?.latest_version));
  const choice = computed(() =>
    check.serverOnly() ? ({ kind: "none", reason: "server" } as const) : downloadChoice(result(), check.device(), check.native()),
  );
  const singleFile = () => {
    const current = choice();
    return current.kind === "file" ? current.file : null;
  };
  const choiceFiles = () => {
    const current = choice();
    return current.kind === "choose" ? current.files : [];
  };
  const fileSystem = (file: DownloadFile) => systemName(file.os, file.arch, t("settings_update_arch_apple_silicon"));
  const fileLabel = (file: DownloadFile) => {
    const system = fileSystem(file);
    return system ? t("settings_update_download_for", { system }) : t("settings_desktop_update_download_action");
  };
  // Why there is no file to download, and what to do instead.
  const downloadNote = () => {
    const current = choice();
    if (current.kind === "choose") return t("settings_update_download_choose");
    if (current.kind !== "none") return "";
    const device = check.device();
    const system = systemName(device.os, device.arch, t("settings_update_arch_apple_silicon"));
    switch (current.reason) {
      case "server":
        return t("settings_update_server_download_note");
      case "unknown_platform":
        return t("settings_update_download_unknown");
      case "unreachable":
        return t("settings_update_download_unreachable");
      case "not_published":
        return system ? t("settings_update_download_missing", { system }) : t("settings_update_download_pick");
      default:
        return t("settings_update_download_pick");
    }
  };
  // The checksum of the one file offered: never the server's own when the download is another's.
  const checksum = () => trim(singleFile()?.checksum);
  const checksumShort = () => {
    const value = checksum().replace(/^sha256:/i, "");
    return value.length > 24 ? `${value.slice(0, 12)}…${value.slice(-8)}` : value;
  };

  async function copyChecksum() {
    const value = untracked(checksum);
    if (!value) return;
    try {
      await copyText(value);
      check.copied.set(true);
      pushNotice({ type: "success", text: t("settings_desktop_update_checksum_copied") });
      const timer = props.timers[props.target];
      if (timer) clearTimeout(timer);
      props.timers[props.target] = setTimeout(() => {
        check.copied.set(false);
        props.timers[props.target] = undefined;
      }, 1200);
    } catch (e) {
      pushNotice({ type: "error", text: (e as Error)?.message || t("msg_save_failed") });
    }
  }

  function openReleases() {
    openExternal(`${UPDATE_RELEASES_URL}?channel=${encodeURIComponent(trim(untracked(result)?.channel) || UPDATE_CHANNEL)}`);
  }

  const probeButton = (testID: string) =>
    props.onPartLayout
      ? (event: Parameters<typeof boundsFrame>[0]) => props.parts.report(`button:${testID}`, downloadsNode, () => boundsFrame(event))
      : undefined;

  function downloadButton(file: DownloadFile | null) {
    if (!file) {
      return (
        <Button
          variant="outlined"
          icon="PhArrowUpRight"
          label={t("settings_update_open_releases")}
          onPress={openReleases}
          onLayout={probeButton(id("open-releases"))}
          testID={id("open-releases")}
        />
      );
    }
    // A download is an icon button, named by which file it is (the system and build it is for):
    // that name is its accessible name and its tooltip. The same words are plain text beside it,
    // not part of the button: what the reader checks before taking the file, and what tells one of
    // several from the others. On phones the row takes the card's width and a long name wraps.
    const testID = choice().kind === "choose" ? id(`download-${file.os}-${file.arch}`) : id("download");
    return (
      <View class={`flex-row items-center gap-2 ${isMobile() ? "" : "justify-end"}`} onLayout={probeButton(`${testID}-row`)} testID={`${testID}-row`}>
        <Text class={`min-w-0 text-sm text-foreground ${isMobile() ? "flex-1" : "shrink"}`} testID={`${testID}-label`}>
          {fileLabel(file)}
        </Text>
        <Button
          variant="outlined"
          icon="PhCloudArrowDown"
          label={fileLabel(file)}
          onPress={() => openExternal(file.url)}
          onLayout={probeButton(testID)}
          testID={testID}
        />
      </View>
    );
  }

  return (
    <If when={hasRelease()}>
      <View
        class={isMobile() ? "gap-3 pb-3" : "flex-row items-start gap-3 pb-3"}
        {...props.parts.probe(() => `${props.target}.release`)}
        testID={id("release")}
      >
        {/* On wider screens this column also keeps the downloads at the row's end. */}
        <If when={checksum() || !isMobile()}>
          <View class={isMobile() ? "gap-1.5" : "min-w-0 flex-1 gap-1.5"}>
            <If when={checksum()}>
              {/* The checksum is read as text; the button beside it copies it. */}
              <View class="flex-row items-center gap-1.5">
                <Text class="text-xs text-subtle">SHA256</Text>
                <Text class="font-mono text-xs text-foreground" testID={id("checksum-value")}>
                  {checksumShort()}
                </Text>
                <Button
                  variant="plain"
                  size="xxs"
                  icon={check.copied() ? "PhCheckCircle" : "PhCopy"}
                  label={t("action_copy")}
                  title={checksum()}
                  accessibilityLabel={`${t("action_copy")} SHA256`}
                  onPress={() => void copyChecksum()}
                  testID={id("checksum")}
                />
              </View>
            </If>
          </View>
        </If>
        <View
          class={isMobile() ? "w-full gap-2" : "gap-2"}
          ref={(node: ViewRef) => (downloadsNode = node)}
          onLayout={() => props.parts.report(`${props.target}.downloads`, downloadsNode)}
          testID={id("downloads")}
        >
          <If when={downloadNote()}>
            <Text class={`text-xs text-muted-foreground ${isMobile() ? "" : "max-w-60"}`} testID={id("download-note")}>
              {downloadNote()}
            </Text>
          </If>
          <If
            when={choice().kind === "file"}
            else={
              <If when={choice().kind === "choose"} else={downloadButton(null)}>
                <Each of={choiceFiles()} key={(file) => file.url}>
                  {(file) => downloadButton(file())}
                </Each>
              </If>
            }
          >
            {downloadButton(singleFile())}
          </If>
        </View>
      </View>
    </If>
  );
}
