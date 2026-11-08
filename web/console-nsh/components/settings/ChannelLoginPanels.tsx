// WeChat QR login and X OAuth login (the Vue console's WeChatLoginPanel and XLoginPanel).
//
// The server runs every step and saves the token itself, so no token reaches the app: WeChat's
// login only draws the QR code from the link WeChat returns, X's opens X's authorization page.
//
// Vue to nsh: `changed` is `onChanged()`; `request` is the same function (`endpointApiFetch`).
import type { JSX } from "nsh";
import { Canvas, cleanup, computed, signal, Text, token, untracked, View } from "nsh";
import { openExternal } from "../../lib/platform";
import { create as createQRCode } from "../../lib/vendor/qrcode.js";
import { Button, TextField } from "../ui";
import { t } from "./DialogShell";

/** How the panels reach the runtime: `endpointApiFetch` from lib/core/context.js. */
export type ChannelRequest = (endpointRef: string, path: string, options?: { method?: string; body?: unknown }) => Promise<any>;

const STATUS_KEYS: Record<string, string> = {
  wait: "settings_wechat_login_status_wait",
  scaned: "settings_wechat_login_status_scanned",
  need_verifycode: "settings_wechat_login_status_need_code",
  expired: "settings_wechat_login_status_expired",
  verify_code_blocked: "settings_wechat_login_status_code_blocked",
  binded_redirect: "settings_wechat_login_status_already_bound",
  confirmed: "settings_wechat_login_status_confirmed",
};

const errorText = (error: unknown, key: string) => (error as Error)?.message || t(key);

/** The QR modules of `text` (error correction M), or null when it cannot be encoded. */
function qrModules(text: string): { size: number; dark: (row: number, col: number) => boolean } | null {
  try {
    const qr = createQRCode(text, { errorCorrectionLevel: "M" }) as { modules: { size: number; data: ArrayLike<number> } };
    const { size, data } = qr.modules;
    return { size, dark: (row, col) => Boolean(data[row * size + col]) };
  } catch (error) {
    console.warn("could not draw the WeChat QR code:", (error as Error)?.message || error);
    return null;
  }
}

/** A QR code drawn dark on light in both themes, so a phone can read it. */
function QRCode(props: { text: string; size?: number; label?: string }) {
  const modules = computed(() => (props.text ? qrModules(props.text) : null));
  return (
    <View
      class="items-center justify-center bg-primary-foreground p-2"
      accessibilityLabel={props.label}
      role="image"
      testID="wechat-login-qr"
      style={{ width: props.size ?? 196, height: props.size ?? 196 }}
    >
      <Canvas
        class="flex-1 self-stretch"
        draw={(cx, size) => {
          const qr = modules();
          if (!qr) return;
          const margin = 1;
          const cells = qr.size + margin * 2;
          const cell = Math.min(size.width, size.height) / cells;
          const left = (size.width - cell * cells) / 2;
          const top = (size.height - cell * cells) / 2;
          cx.fillStyle = token("foreground") as string;
          for (let row = 0; row < qr.size; row += 1) {
            for (let col = 0; col < qr.size; col += 1) {
              if (qr.dark(row, col)) {
                // A hair wider than the cell, so neighbours meet without seams.
                cx.fillRect(left + (col + margin) * cell, top + (row + margin) * cell, cell + 0.5, cell + 0.5);
              }
            }
          }
        }}
      />
    </View>
  );
}

/** The bound account row: its label and id, and the panel's actions. */
function BoundRow(props: { label: string; id: string; children?: JSX.Element }) {
  return (
    <View class="min-h-11 flex-row flex-wrap items-center justify-between gap-2 rounded-(--radius) border border-line-faint py-1.5 pl-3 pr-1.5">
      <View class="shrink gap-0.5">
        <Text class="text-xs text-muted-foreground">{props.label}</Text>
        <If when={props.id}>
          <View selectable>
            <Text class="font-mono text-sm text-foreground line-clamp-1">{props.id}</Text>
          </View>
        </If>
      </View>
      <View class="flex-row flex-wrap items-center gap-1">{props.children}</View>
    </View>
  );
}

function Messages(props: { notice: string; error: string }) {
  return (
    <>
      <If when={props.notice}>
        <Text class="text-xs text-ok" testID="channel-login-notice">
          {props.notice}
        </Text>
      </If>
      <If when={props.error}>
        <Text class="text-xs text-danger" role="alert" testID="channel-login-error">
          {props.error}
        </Text>
      </If>
    </>
  );
}

/** A second press within 4 seconds confirms (the panels' unbind and logout). */
function useConfirmPress() {
  const confirming = signal(false);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  cleanup(clear);
  return {
    confirming,
    /** True when this press confirms; otherwise arms the confirmation. */
    press() {
      if (!untracked(confirming)) {
        confirming.set(true);
        clear();
        timer = setTimeout(() => confirming.set(false), 4000);
        return false;
      }
      clear();
      confirming.set(false);
      return true;
    },
  };
}

export interface WeChatLoginPanelProps {
  request: ChannelRequest;
  endpointRef?: string;
  /** A bot token is saved. */
  configured?: boolean;
  botId?: string;
  disabled?: boolean;
  /** A login or an unbind changed the saved settings: reload them. */
  onChanged?: () => void;
}

export function WeChatLoginPanel(props: WeChatLoginPanelProps) {
  const sessionID = signal("");
  const qrURL = signal("");
  const status = signal("");
  const verifyCode = signal("");
  const error = signal("");
  const notice = signal("");
  const busy = signal(false);
  const unbindConfirm = useConfirmPress();
  // Bumped to abandon a login: a poll that returns for an older generation is ignored.
  let generation = 0;
  cleanup(() => {
    generation += 1;
  });

  const statusText = () => t(STATUS_KEYS[status()] || STATUS_KEYS.wait);
  const needsCode = () => status() === "need_verifycode";
  const endpointRef = () => untracked(() => props.endpointRef || "");

  function stop() {
    generation += 1;
    sessionID.set("");
    qrURL.set("");
    status.set("");
    verifyCode.set("");
  }

  async function start() {
    if (untracked(busy) || untracked(() => props.disabled)) return;
    stop();
    const current = generation;
    busy.set(true);
    error.set("");
    notice.set("");
    try {
      const payload = await props.request(endpointRef(), "/settings/wechat/login/start", { method: "POST" });
      if (current !== generation) return;
      sessionID.set(String(payload?.session_id || ""));
      qrURL.set(String(payload?.qr_url || ""));
      status.set("wait");
      void poll(current, "");
    } catch (e) {
      if (current === generation) {
        error.set(errorText(e, "msg_load_failed"));
        stop();
      }
    } finally {
      busy.set(false);
    }
  }

  // Each poll is a long poll on the server; the next one starts when it returns.
  async function poll(current: number, code: string) {
    while (current === generation && untracked(sessionID)) {
      let payload: any;
      try {
        payload = await props.request(endpointRef(), "/settings/wechat/login/poll", {
          method: "POST",
          body: { session_id: untracked(sessionID), verify_code: code },
        });
      } catch (e) {
        if (current === generation) {
          error.set(errorText(e, "msg_load_failed"));
          stop();
        }
        return;
      }
      code = "";
      if (current !== generation) return;
      status.set(String(payload?.status || "wait"));
      if (payload?.done !== true) {
        if (untracked(needsCode)) return; // resumes when the code is submitted
        continue;
      }
      if (payload?.connected === true) {
        const scanner = String(payload?.user_id || "").trim();
        notice.set(
          scanner
            ? t("settings_wechat_login_connected_by", { bot: payload?.bot_id || "", user: scanner })
            : t("settings_wechat_login_connected", { bot: payload?.bot_id || "" }),
        );
        stop();
        props.onChanged?.();
      } else {
        error.set(untracked(statusText));
        stop();
      }
      return;
    }
  }

  function submitCode() {
    const code = untracked(verifyCode).trim();
    if (!code || !untracked(sessionID)) return;
    status.set("scaned");
    verifyCode.set("");
    void poll(generation, code);
  }

  function cancel() {
    stop();
    error.set("");
  }

  async function unbind() {
    if (!unbindConfirm.press()) return;
    busy.set(true);
    error.set("");
    notice.set("");
    try {
      await props.request(endpointRef(), "/settings/wechat/logout", { method: "POST" });
      props.onChanged?.();
    } catch (e) {
      error.set(errorText(e, "msg_delete_failed"));
    } finally {
      busy.set(false);
    }
  }

  return (
    <View class="gap-2.5" testID="wechat-login">
      <If
        when={sessionID()}
        else={
          <If
            when={props.configured}
            else={
              <Button
                variant="primary"
                label={t("settings_wechat_login_connect")}
                loading={busy()}
                disabled={props.disabled || busy()}
                onPress={() => void start()}
                testID="wechat-login-start"
              />
            }
          >
            <BoundRow label={t("settings_wechat_login_bound")} id={props.botId || ""}>
              <Button
                variant="plain"
                size="xs"
                label={t("settings_wechat_login_reconnect")}
                loading={busy()}
                disabled={props.disabled || busy()}
                onPress={() => void start()}
              />
              <Button
                variant="ghost-danger"
                size="xs"
                label={unbindConfirm.confirming() ? t("settings_wechat_login_unbind_confirm") : t("settings_wechat_login_unbind")}
                disabled={props.disabled || busy()}
                onPress={() => void unbind()}
              />
            </BoundRow>
          </If>
        }
      >
        <View class="items-center gap-2.5 rounded-(--radius) border border-line-faint p-4">
          <If when={qrURL()}>
            <QRCode text={qrURL()} label={t("settings_wechat_login_qr_alt")} />
          </If>
          <Text class="text-center text-xs text-foreground" testID="wechat-login-status">
            {statusText()}
          </Text>
          <If when={needsCode()}>
            <View class="w-full max-w-72 flex-row items-start gap-2">
              <TextField
                class="flex-1"
                value={verifyCode()}
                clearable={Boolean(verifyCode())}
                placeholder={t("settings_wechat_login_code_placeholder")}
                onChange={(value) => verifyCode.set(value)}
                onSubmit={submitCode}
                testID="wechat-login-code"
              />
              <Button
                variant="primary"
                label={t("settings_wechat_login_code_submit")}
                disabled={!verifyCode().trim()}
                onPress={submitCode}
              />
            </View>
          </If>
          <View class="flex-row flex-wrap gap-1">
            <If when={qrURL()}>
              <Button variant="plain" size="xs" label={t("settings_wechat_login_open_link")} onPress={() => openExternal(untracked(qrURL))} />
            </If>
            <Button variant="plain" size="xs" label={t("action_cancel")} onPress={cancel} />
          </View>
        </View>
      </If>
      <Messages notice={notice()} error={error()} />
    </View>
  );
}

export interface XLoginPanelProps {
  request: ChannelRequest;
  endpointRef?: string;
  loggedIn?: boolean;
  username?: string;
  /** The X app's client ID is saved: a login can start. */
  ready?: boolean;
  disabled?: boolean;
  onChanged?: () => void;
}

export function XLoginPanel(props: XLoginPanelProps) {
  const sessionID = signal("");
  const authorizeURL = signal("");
  const error = signal("");
  const notice = signal("");
  const busy = signal(false);
  const logoutConfirm = useConfirmPress();
  let generation = 0;
  cleanup(() => {
    generation += 1;
  });
  const endpointRef = () => untracked(() => props.endpointRef || "");

  function stop() {
    generation += 1;
    sessionID.set("");
    authorizeURL.set("");
  }

  async function start() {
    if (untracked(busy) || untracked(() => props.disabled || !props.ready)) return;
    stop();
    const current = generation;
    busy.set(true);
    error.set("");
    notice.set("");
    try {
      const payload = await props.request(endpointRef(), "/settings/x/login/start", { method: "POST" });
      if (current !== generation) return;
      sessionID.set(String(payload?.session_id || ""));
      authorizeURL.set(String(payload?.authorize_url || ""));
      const url = untracked(authorizeURL);
      if (url) openExternal(url);
      void poll(current);
    } catch (e) {
      if (current === generation) {
        error.set(errorText(e, "msg_load_failed"));
        stop();
      }
    } finally {
      busy.set(false);
    }
  }

  // Each poll waits on the server; the next one starts when it returns.
  async function poll(current: number) {
    while (current === generation && untracked(sessionID)) {
      let payload: any;
      try {
        payload = await props.request(endpointRef(), "/settings/x/login/poll", {
          method: "POST",
          body: { session_id: untracked(sessionID) },
        });
      } catch (e) {
        if (current === generation) {
          error.set(errorText(e, "msg_load_failed"));
          stop();
        }
        return;
      }
      if (current !== generation) return;
      if (payload?.done !== true) continue;
      if (payload?.connected === true) {
        notice.set(t("settings_x_login_connected", { username: payload?.username || "" }));
        stop();
        props.onChanged?.();
      } else {
        error.set(String(payload?.error || t("msg_load_failed")));
        stop();
      }
      return;
    }
  }

  function cancel() {
    stop();
    error.set("");
  }

  async function logout() {
    if (!logoutConfirm.press()) return;
    busy.set(true);
    error.set("");
    notice.set("");
    try {
      await props.request(endpointRef(), "/settings/x/logout", { method: "POST" });
      props.onChanged?.();
    } catch (e) {
      error.set(errorText(e, "msg_delete_failed"));
    } finally {
      busy.set(false);
    }
  }

  return (
    <View class="gap-2.5" testID="x-login">
      <If
        when={sessionID()}
        else={
          <If
            when={props.loggedIn}
            else={
              <Button
                variant="primary"
                label={t("settings_x_login")}
                loading={busy()}
                disabled={props.disabled || busy() || !props.ready}
                onPress={() => void start()}
                testID="x-login-start"
              />
            }
          >
            <BoundRow label={t("settings_x_login_bound")} id={props.username ? `@${props.username}` : ""}>
              <Button
                variant="plain"
                size="xs"
                label={t("settings_x_login_again")}
                loading={busy()}
                disabled={props.disabled || busy() || !props.ready}
                onPress={() => void start()}
              />
              <Button
                variant="ghost-danger"
                size="xs"
                label={logoutConfirm.confirming() ? t("settings_x_logout_confirm") : t("settings_x_logout")}
                disabled={props.disabled || busy()}
                onPress={() => void logout()}
              />
            </BoundRow>
          </If>
        }
      >
        <View class="items-center gap-2.5 rounded-(--radius) border border-line-faint p-4">
          <Text class="text-center text-xs text-foreground">
            {t("settings_x_login_waiting")}
          </Text>
          <View class="flex-row flex-wrap gap-1">
            <If when={authorizeURL()}>
              <Button variant="plain" size="xs" label={t("settings_x_login_open_again")} onPress={() => openExternal(untracked(authorizeURL))} />
            </If>
            <Button variant="plain" size="xs" label={t("action_cancel")} onPress={cancel} />
          </View>
        </View>
      </If>
      <If when={!props.ready && !sessionID()}>
        <Text class="text-xs text-muted-foreground">{t("settings_x_login_needs_client_id")}</Text>
      </If>
      <Messages notice={notice()} error={error()} />
    </View>
  );
}
