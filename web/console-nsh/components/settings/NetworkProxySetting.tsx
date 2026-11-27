// The desktop app's network proxy: a row of Settings' General card and the dialog it opens. Only a
// host with the `networkProxy` feature has it (the desktop app; not a browser, not the phone app).
// The login and setup pages open the same dialog from a small entry (NetworkProxyEntry): the
// setting is the host's, so it needs no console session, and a proxy may be what logging in needs.
//
// The host owns the setting (lib/platform.ts, desktop/nsh/src/proxy.rs). The row shows what the
// app runs with since it was opened; a saved change applies when the user quits and reopens the
// app, which this panel never does by itself: saving stores the setting and nothing else. The
// password is write-only here: the host only says whether one is stored.
import { batch, effect, signal, Text, untracked, View } from "nsh";
import { cornersClass, fittingRadius, RADIUS } from "../corners";
import { pushNotice } from "../../lib/core/notices.js";
import {
  networkProxy,
  NetworkProxyError,
  type NetworkProxyRunning,
  type NetworkProxyState,
  hasFeature,
  quitDesktopApp,
  saveNetworkProxy,
} from "../../lib/platform";
import { isMobile } from "../../lib/shell";
import { SettingRow } from "../settings-page/parts";
import { Button, confirm, Icon, MessageDialog, TextField, Tip, TipButton } from "../ui";
import { InlineNotice, t } from "./DialogShell";
import { SecretInput } from "./SecretInput";
import { SettingDialog } from "./SettingDialog";
import { SettingField, SettingSelect } from "./SettingFields";

type Choice = "system" | "http" | "socks5";

const TYPE_LABELS = { http: "HTTP", socks5: "SOCKS5" } as const;

/** `host:port`, an IPv6 address in brackets. */
function hostPort(host: string, port: number | string) {
  return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
}

/** What the app runs with, by type, host and port: never a credential. */
export function runningProxyLabel(running: NetworkProxyRunning | undefined): string {
  if (!running || running.mode !== "explicit" || !running.type) return t("network_proxy_system");
  return `${TYPE_LABELS[running.type]} ${hostPort(running.host ?? "", running.port ?? "")}`;
}

/** The words for a field's error code, or the code when a newer host sends one this app lacks. */
function fieldError(code: string | undefined) {
  if (!code) return "";
  const key = `network_proxy_error_${code}`;
  const text = t(key);
  return text === key ? code : text;
}

/** The setting as the host has it, the dialog's draft, and saving it: one per row or entry. */
function createNetworkProxy() {
  const state = signal<NetworkProxyState | null>(null);
  const loadError = signal("");
  const open = signal(false);
  const applyOpen = signal(false);
  const saving = signal(false);
  const quitting = signal(false);

  // The dialog's draft.
  const choice = signal<Choice>("system");
  const host = signal("");
  const port = signal("");
  const username = signal("");
  const password = signal("");
  const clearPassword = signal(false);
  const errors = signal<Record<string, string>>({});
  const saveError = signal("");

  async function refresh() {
    try {
      const next = await networkProxy();
      batch(() => {
        state.set(next);
        loadError.set("");
      });
    } catch (error) {
      loadError.set(t("network_proxy_error_load", { error: (error as Error)?.message || String(error) }));
    }
  }
  effect(() => untracked(() => void refresh()));

  const explicit = () => choice() !== "system";
  const storedPassword = () => Boolean(state()?.saved.hasPassword) && !clearPassword();

  function openDialog() {
    const saved = untracked(state)?.saved;
    batch(() => {
      choice.set(saved && saved.mode === "explicit" ? saved.type : "system");
      host.set(saved?.host ?? "");
      port.set(saved?.port ? String(saved.port) : "");
      username.set(saved?.username ?? "");
      password.set("");
      clearPassword.set(false);
      errors.set({});
      saveError.set("");
      open.set(true);
    });
  }

  async function save() {
    if (untracked(saving)) return;
    const current = untracked(state);
    const picked = untracked(choice);
    const typed = untracked(password);
    batch(() => {
      saving.set(true);
      errors.set({});
      saveError.set("");
    });
    try {
      const next = await saveNetworkProxy({
        mode: picked === "system" ? "system" : "explicit",
        type: picked === "system" ? (current?.saved.type ?? "http") : picked,
        host: untracked(host).trim(),
        port: untracked(port).trim(),
        username: untracked(username),
        // Untouched keeps the stored password; a typed one replaces it.
        ...(typed ? { password: typed } : {}),
        ...(untracked(clearPassword) && !typed ? { clearPassword: true } : {}),
      });
      batch(() => {
        state.set(next);
        password.set("");
        open.set(false);
        // The route the app started with stays until it is reopened.
        if (next.pending) applyOpen.set(true);
      });
      if (!next.pending) pushNotice({ type: "success", text: t("network_proxy_saved") });
    } catch (error) {
      if (error instanceof NetworkProxyError && error.code === "validation") {
        errors.set(error.fields);
      } else if (error instanceof NetworkProxyError && error.code === "credential_store") {
        saveError.set(t("network_proxy_error_credential_store", { error: error.message }));
      } else {
        saveError.set(t("network_proxy_error_save", { error: (error as Error)?.message || String(error) }));
      }
    } finally {
      saving.set(false);
    }
  }

  async function quitNow() {
    const ok = await confirm({
      title: t("network_proxy_quit_confirm_title"),
      text: t("network_proxy_quit_confirm_text"),
      confirmLabel: t("network_proxy_quit_confirm"),
      cancelLabel: t("action_cancel"),
      danger: true,
    });
    if (!ok) return;
    quitting.set(true);
    try {
      await quitDesktopApp();
    } catch (error) {
      quitting.set(false);
      pushNotice({ type: "error", text: (error as Error)?.message || String(error) });
    }
  }

  const field = (name: string) => fieldError(errors()[name]);

  return {
    state, loadError, open, applyOpen, saving, quitting,
    choice, host, port, username, password, clearPassword, saveError,
    refresh, explicit, storedPassword, openDialog, save, quitNow, field,
  };
}

type NetworkProxyModel = ReturnType<typeof createNetworkProxy>;

export function NetworkProxySetting() {
  const model = createNetworkProxy();
  const { state, loadError, openDialog } = model;
  return (
    <>
      {/* A row of the card, found by the Settings search by its title. */}
      <SettingRow
        title={t("network_proxy_title")}
        note={t("network_proxy_hint")}
        testID="network-proxy"
        status={
          <>
            <If when={state()}>
              <Text class="text-xs leading-[20.3px] text-muted-foreground" testID="network-proxy-running">
                {t("network_proxy_running", { proxy: runningProxyLabel(state()?.running) })}
              </Text>
            </If>
            <If when={state()?.pending}>
              <Text class="text-xs font-medium leading-[20.3px] text-warn-dark" testID="network-proxy-pending">
                {t("network_proxy_pending")}
              </Text>
            </If>
            <If when={loadError()}>
              <Text class="text-xs leading-[20.3px] text-danger" role="alert" testID="network-proxy-load-error">
                {loadError()}
              </Text>
            </If>
          </>
        }
      >
        <Button
          variant="outlined"
          size="md"
          class={isMobile() ? "self-stretch" : "min-w-[180px]"}
          label={t("network_proxy_change")}
          disabled={!state()}
          onPress={openDialog}
          testID="network-proxy-open"
        />
      </SettingRow>
      <NetworkProxyDialogs model={model} />
    </>
  );
}

/** The 24pt entry's corners, as the language menu's trigger beside it. */
const ENTRY_CORNERS = cornersClass(fittingRadius(RADIUS.control, 24));

/**
 * The setting's entry on the pages before the console is entered (login, setup): a small button
 * drawn as the language menu's trigger is, opening the dialog Settings opens. Nothing where the
 * host has no such setting (a browser, the phone app).
 */
export function NetworkProxyEntry(props: { class?: string }) {
  return (
    <If when={hasFeature("networkProxy")}>
      <NetworkProxyEntryButton class={props.class} />
    </If>
  );
}

function NetworkProxyEntryButton(props: { class?: string }) {
  const model = createNetworkProxy();
  const { state, loadError, openDialog, refresh } = model;
  const opening = signal(false);

  async function press() {
    if (untracked(opening)) return;
    // The setting did not load (the host was slow, or refused): ask again before saying so.
    if (!untracked(state)) {
      opening.set(true);
      try {
        await refresh();
      } finally {
        opening.set(false);
      }
    }
    if (untracked(state)) openDialog();
    else pushNotice({ type: "error", text: untracked(loadError) || t("network_proxy_title") });
  }

  const pending = () => Boolean(state()?.pending);
  const name = () => (pending() ? `${t("network_proxy_title")}: ${t("network_proxy_pending")}` : t("network_proxy_title"));
  // What the app runs with, and that a saved change waits for the app to be reopened.
  const tip = () => {
    if (!state()) return undefined;
    const running = t("network_proxy_running", { proxy: runningProxyLabel(state()?.running) });
    return pending() ? `${running} · ${t("network_proxy_pending")}` : running;
  };
  return (
    <>
      <TipButton
        accessibilityLabel={name()}
        tooltip={tip() ? <Tip text={tip()!} /> : undefined}
        hitSlop={6}
        class={`flex-row items-center gap-1.5 ${ENTRY_CORNERS} px-2 py-1 hover:bg-hover focus-visible:bg-hover ${props.class ?? ""}`}
        onPress={() => void press()}
        testID="network-proxy-entry"
      >
        <Icon name="PhNetwork" size={14} color="muted-foreground" />
        <Text class="text-xs text-subtle">{t("network_proxy_title")}</Text>
        <If when={pending()}>
          <View class="size-1.5 rounded-full bg-warn" testID="network-proxy-entry-pending" />
        </If>
      </TipButton>
      {/* Before a session the console is asked nothing: not its secret store's name either. */}
      <NetworkProxyDialogs model={model} hostOnly />
    </>
  );
}

/** The setting's dialog, and the one that says a saved change applies when the app is reopened. */
function NetworkProxyDialogs(props: { model: NetworkProxyModel; hostOnly?: boolean }) {
  const {
    state, open, applyOpen, saving, quitting,
    choice, host, port, username, password, clearPassword, saveError,
    explicit, storedPassword, save, quitNow, field,
  } = props.model;
  return (
    <>
      <SettingDialog
        open={open()}
        onOpenChange={(value) => open.set(value)}
        title={t("network_proxy_title")}
        size="md"
        saving={saving()}
        onSave={() => void save()}
        testID="network-proxy-dialog"
      >
        <View class="gap-3">
          <If when={saveError()}>
            <InlineNotice type="error" text={saveError()} testID="network-proxy-save-error" />
          </If>
          <SettingField label={t("network_proxy_mode_label")} note={explicit() ? undefined : t("network_proxy_system_note")}>
            <SettingSelect
              value={choice()}
              options={[
                { title: t("network_proxy_system"), value: "system" },
                { title: TYPE_LABELS.http, value: "http" },
                { title: TYPE_LABELS.socks5, value: "socks5" },
              ]}
              onChange={(value) => choice.set(value as Choice)}
              disabled={saving()}
              label={t("network_proxy_mode_label")}
              testID="network-proxy-mode"
            />
          </SettingField>
          {/* Under System default the saved fields stay, to switch the proxy back on. */}
          <View class={`gap-3 ${explicit() ? "" : "opacity-55"}`}>
            <TextField
              label={t("network_proxy_host")}
              value={host()}
              onChange={(value) => host.set(value)}
              placeholder="proxy.example.com"
              error={field("host")}
              disabled={!explicit() || saving()}
              mono
              keyboardType="url"
              testID="network-proxy-host"
            />
            <TextField
              label={t("network_proxy_port")}
              value={port()}
              onChange={(value) => port.set(value)}
              placeholder="8080"
              error={field("port")}
              disabled={!explicit() || saving()}
              mono
              keyboardType="number-pad"
              testID="network-proxy-port"
            />
            <TextField
              label={t("network_proxy_username")}
              value={username()}
              onChange={(value) => username.set(value)}
              placeholder={t("network_proxy_optional")}
              error={field("username")}
              disabled={!explicit() || saving()}
              testID="network-proxy-username"
            />
            <SettingField label={t("network_proxy_password")}>
              <SecretInput
                value={password()}
                onChange={(value) => password.set(value)}
                status={{ configured: storedPassword(), source: "os", editable: true }}
                placeholder={t("network_proxy_optional")}
                disabled={!explicit() || saving()}
                consoleStore={!props.hostOnly}
                testID="network-proxy-password"
              />
              <If when={field("password")}>
                <Text class="text-xs text-danger" role="alert" testID="network-proxy-password-error">
                  {field("password")}
                </Text>
              </If>
              <If when={state()?.saved.hasPassword && !password()}>
                <View class="flex-row flex-wrap items-center gap-2">
                  <If when={clearPassword()}>
                    <Text class="min-w-0 shrink text-xs text-muted-foreground" testID="network-proxy-password-cleared">
                      {t("network_proxy_password_cleared")}
                    </Text>
                  </If>
                  <Button
                    variant="plain"
                    size="xs"
                    label={clearPassword() ? t("network_proxy_password_keep") : t("network_proxy_password_clear")}
                    disabled={saving()}
                    onPress={() => clearPassword.update((on) => !on)}
                    testID="network-proxy-password-clear"
                  />
                </View>
              </If>
            </SettingField>
          </View>
          <If when={state() && !state()!.credentialStore}>
            <InlineNotice type="warning" text={t("network_proxy_no_store")} testID="network-proxy-no-store" />
          </If>
          {/* What goes through the proxy, what does not, and what is blocked: not "all traffic". */}
          <View class="gap-1.5" testID="network-proxy-note">
            <Text class="text-xs leading-normal text-muted-foreground">{t("network_proxy_note_apply")}</Text>
            <Text class="text-xs leading-normal text-muted-foreground">{t("network_proxy_note_through")}</Text>
            <Text class="text-xs leading-normal text-muted-foreground">{t("network_proxy_note_blocked")}</Text>
            <Text class="text-xs leading-normal text-muted-foreground">{t("network_proxy_note_not")}</Text>
            <Text class="text-xs leading-normal text-muted-foreground">{t("network_proxy_note_secret")}</Text>
          </View>
        </View>
      </SettingDialog>

      <MessageDialog
        open={applyOpen()}
        onClose={() => applyOpen.set(false)}
        title={t("network_proxy_apply_title")}
        text={t("network_proxy_apply_text")}
        icon="PhGlobe"
        actions={[
          { id: "later", label: t("network_proxy_apply_later"), variant: "outlined", disabled: quitting(), onPress: () => applyOpen.set(false) },
          { id: "quit", label: t("network_proxy_apply_quit"), variant: "primary", loading: quitting(), onPress: () => void quitNow() },
        ]}
        testID="network-proxy-apply"
      />
    </>
  );
}
