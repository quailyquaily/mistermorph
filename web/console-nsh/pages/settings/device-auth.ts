// The device sign-in flows of the Settings page: Mister Morph Pro and xAI (the Vue console's
// useProAuthFlow and useXAIAuthFlow), and OpenAI Codex (inline in SettingsView.js). Each asks the
// endpoint for a login session, opens the verification URL, then polls until the user approved it.
// Every request carries a generation and the endpoint it went to: a reply that comes after the
// user switched endpoints, closed the dialog or started over changes nothing.
import { batch, computed, effect, signal, untracked } from "nsh";
import { endpointApiFetch, formatTime } from "../../lib/core/context.js";
import { t } from "./i18n";
import { invalidateConsoleSetupReadiness } from "../../lib/core/setup.js";
import { openReentrantDialog } from "../../lib/core/reentrant-dialog.js";
import { openExternal } from "../../lib/platform";

export type AuthButtonState = "loading" | "signed-out" | "refreshable" | "expired" | "signed-in";

function delayFromIntervalSeconds(intervalSeconds: unknown = 5) {
  return Math.max(2, Number(intervalSeconds) || 5) * 1000;
}

function emptyStatus() {
  return {
    logged_in: false,
    access_token_present: false,
    refresh_token_present: false,
    access_token_expired: false,
    subscription_api_key_present: false,
    subscription: "",
    expires_at: "",
    scope: "",
    account_id: "",
    user: {} as Record<string, unknown>,
    file_mode_ok: true,
    file_mode_warning: "",
  };
}
export type DeviceAuthStatus = ReturnType<typeof emptyStatus>;

function normalizeStatus(payload: any): DeviceAuthStatus {
  const status = payload && typeof payload.status === "object" ? payload.status : payload;
  return {
    logged_in: status?.logged_in === true,
    access_token_present: status?.access_token_present === true,
    refresh_token_present: status?.refresh_token_present === true,
    access_token_expired: status?.access_token_expired === true,
    subscription_api_key_present: status?.subscription_api_key_present === true,
    subscription: typeof status?.subscription === "string" ? status.subscription : "",
    expires_at: typeof status?.expires_at === "string" ? status.expires_at : "",
    scope: typeof status?.scope === "string" ? status.scope : "",
    account_id: typeof status?.account_id === "string" ? status.account_id : "",
    user: status?.user && typeof status.user === "object" ? status.user : {},
    file_mode_ok: status?.file_mode_ok !== false,
    file_mode_warning: typeof status?.file_mode_warning === "string" ? status.file_mode_warning : "",
  };
}

export interface DeviceAuthOptions {
  /** "pro", "xai" or "codex": the /auth/<kind>/... routes and the i18n keys. */
  kind: "pro" | "xai" | "codex";
  getEndpointRef: () => string;
  onSettingsUpdated: (payload: any, endpointRef: string) => Promise<void> | void;
  /** Codex: refreshes an expired token after loading the status, when OAuth is in use. */
  refreshWhen?: () => boolean;
}

/** One device sign-in flow, as signals: its status, its dialog and its actions. */
export function createDeviceAuthFlow(options: DeviceAuthOptions) {
  const kind = options.kind;
  const loading = signal(false);
  const busy = signal(false);
  const error = signal("");
  const dialogOpen = signal(false);
  const setDefault = signal(false);
  const loginSession = signal("");
  const verificationURL = signal("");
  const userCode = signal("");
  const expiresAt = signal("");
  const status = signal<DeviceAuthStatus>(emptyStatus());
  let pollTimer: ReturnType<typeof setTimeout> | 0 = 0;
  let generation = 0;
  // Codex counts its status loads apart from its sign-in steps, as the Vue page did.
  let statusSeq = 0;
  let loginEndpointRef = "";

  const keyPrefix = `settings_${kind}_auth`;
  const summary = computed(() => {
    if (loading()) return t(`${keyPrefix}_loading`);
    const now = status();
    if (kind === "codex") return now.logged_in ? t(`${keyPrefix}_signed_in`) : t(`${keyPrefix}_signed_out`);
    if (!now.logged_in) return t(`${keyPrefix}_signed_out`);
    if (now.access_token_expired && now.refresh_token_present) return t(`${keyPrefix}_refreshable`);
    if (now.access_token_expired) return t(`${keyPrefix}_expired`);
    return t(`${keyPrefix}_signed_in`);
  });
  const buttonState = computed<AuthButtonState>(() => {
    if (loading()) return "loading";
    const now = status();
    if (kind === "codex") return now.logged_in ? "signed-in" : "signed-out";
    if (!now.logged_in) return "signed-out";
    if (now.access_token_expired && now.refresh_token_present) return "refreshable";
    if (now.access_token_expired) return "expired";
    return "signed-in";
  });
  const needsLogin = computed(() => ["signed-out", "expired"].includes(buttonState()));
  // xAI also needs its token file readable by this user only.
  const ready = computed(() => status().logged_in && (kind !== "xai" || status().file_mode_ok !== false));
  const buttonTitle = computed(() => `${t(`${keyPrefix}_title`)}: ${summary()}`);
  const loginExpiresLabel = computed(() => (expiresAt() ? formatTime(expiresAt()) : t("ttl_unknown")));

  const currentEndpointRef = () => String(options.getEndpointRef() || "").trim();
  const isCurrent = (gen: number, endpointRef: string) => gen === generation && endpointRef === currentEndpointRef();
  const applyStatus = (payload: unknown) => status.set(normalizeStatus(payload));

  function clearTimer() {
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = 0;
    }
  }

  function resetLoginSession() {
    clearTimer();
    batch(() => {
      loginSession.set("");
      verificationURL.set("");
      userCode.set("");
      expiresAt.set("");
    });
    loginEndpointRef = "";
  }

  /** Drops the session being signed in and any request on its way. */
  function resetFlow() {
    generation += 1;
    batch(() => {
      loading.set(false);
      busy.set(false);
      error.set("");
    });
    resetLoginSession();
  }

  /** Forgets everything about the endpoint, when another one is chosen. */
  function resetEndpointState() {
    statusSeq += 1;
    resetFlow();
    status.set(emptyStatus());
    dialogOpen.set(false);
  }

  function schedulePoll(intervalSeconds: unknown = 5) {
    clearTimer();
    pollTimer = setTimeout(() => {
      void poll();
    }, delayFromIntervalSeconds(intervalSeconds));
  }

  async function loadStatus(endpointRef = currentEndpointRef()) {
    if (untracked(loading) && kind !== "codex") return;
    const target = String(endpointRef || "").trim();
    const gen = kind === "codex" ? ++statusSeq : generation;
    const current = () => (kind === "codex" ? gen === statusSeq && target === currentEndpointRef() : isCurrent(gen, target));
    batch(() => {
      loading.set(true);
      error.set("");
    });
    try {
      let payload: any = await endpointApiFetch(target, `/auth/${kind}/status`);
      if (!current()) return;
      applyStatus(payload);
      const now = normalizeStatus(payload);
      if (
        options.refreshWhen?.() &&
        now.refresh_token_present &&
        (!now.access_token_present || now.access_token_expired)
      ) {
        payload = await endpointApiFetch(target, `/auth/${kind}/refresh`, { method: "POST" });
        if (!current()) return;
        applyStatus(payload);
      }
    } catch (e: any) {
      if (current()) error.set(e?.message || t("msg_load_failed"));
    } finally {
      if (current()) loading.set(false);
    }
  }

  async function startLogin(endpointRef = currentEndpointRef()) {
    if (untracked(busy)) return;
    const target = String(endpointRef || "").trim();
    const gen = ++generation;
    batch(() => {
      loading.set(false);
      busy.set(true);
      error.set("");
    });
    resetLoginSession();
    if (kind === "codex") loginEndpointRef = target;
    try {
      const payload: any = await endpointApiFetch(target, `/auth/${kind}/login/start`, { method: "POST" });
      if (!isCurrent(gen, target) || (kind === "codex" && loginEndpointRef !== target)) return;
      loginEndpointRef = target;
      const url =
        kind === "codex"
          ? String(payload?.verification_url || "").trim()
          : String(payload?.verification_url_complete || payload?.verification_url || "").trim();
      batch(() => {
        loginSession.set(String(payload?.session_id || "").trim());
        verificationURL.set(url);
        userCode.set(String(payload?.user_code || "").trim());
        expiresAt.set(String(payload?.expires_at || "").trim());
      });
      if (url) openExternal(url);
      schedulePoll(payload?.interval_seconds);
    } catch (e: any) {
      if (isCurrent(gen, target)) error.set(e?.message || t("msg_load_failed"));
    } finally {
      if (gen === generation) busy.set(false);
    }
  }

  async function poll() {
    const sessionID = untracked(loginSession);
    const target = loginEndpointRef;
    if (!sessionID || !target || untracked(busy)) return;
    if (target !== currentEndpointRef()) {
      resetFlow();
      return;
    }
    const gen = ++generation;
    batch(() => {
      loading.set(false);
      busy.set(true);
      error.set("");
    });
    const setDefaultValue = kind === "pro" ? true : kind === "xai" ? untracked(setDefault) : false;
    try {
      const payload: any = await endpointApiFetch(target, `/auth/${kind}/login/poll`, {
        method: "POST",
        body: { session_id: sessionID, set_default: setDefaultValue },
      });
      if (!isCurrent(gen, target) || target !== loginEndpointRef) return;
      if (payload?.pending === true) {
        schedulePoll(kind === "codex" ? 5 : payload?.interval_seconds);
        return;
      }
      applyStatus(payload);
      resetLoginSession();
      if (payload?.settings_updated === true) {
        invalidateConsoleSetupReadiness();
        await options.onSettingsUpdated(payload, target);
      }
    } catch (e: any) {
      if (isCurrent(gen, target)) error.set(e?.message || t("msg_load_failed"));
    } finally {
      if (gen === generation) busy.set(false);
    }
  }

  async function logout() {
    if (untracked(busy)) return;
    const target = currentEndpointRef();
    const gen = ++generation;
    batch(() => {
      loading.set(false);
      busy.set(true);
      error.set("");
    });
    try {
      const payload: any = await endpointApiFetch(target, `/auth/${kind}/logout`, { method: "POST" });
      if (!isCurrent(gen, target)) return;
      applyStatus(payload);
      resetLoginSession();
      if (kind === "xai" && typeof payload?.revocation_warning === "string") {
        error.set(payload.revocation_warning);
      }
    } catch (e: any) {
      if (isCurrent(gen, target)) error.set(e?.message || t("msg_delete_failed"));
    } finally {
      if (gen === generation) busy.set(false);
    }
  }

  /** Opens the dialog; signs in at once when there is no session. */
  async function openDialog() {
    const target = currentEndpointRef();
    const shouldStartLogin = untracked(needsLogin) && !untracked(loginSession) && !untracked(busy);
    await openReentrantDialog(dialogOpen);
    void loadStatus(target);
    if (shouldStartLogin) void startLogin(target);
  }

  /** xAI: signs in again from the dialog. */
  function relogin() {
    if (untracked(busy)) return;
    void startLogin();
  }

  // Closing the dialog drops the session being signed in.
  effect(() => {
    if (!dialogOpen()) untracked(resetFlow);
  });

  return {
    kind,
    loading,
    busy,
    error,
    dialogOpen,
    setDefault,
    status,
    summary,
    buttonState,
    needsLogin,
    ready,
    buttonTitle,
    loginSession,
    verificationURL,
    userCode,
    loginExpiresLabel,
    loadStatus,
    openDialog,
    relogin,
    poll,
    logout,
    resetFlow,
    resetEndpointState,
    dispose: resetFlow,
  };
}

export type DeviceAuthFlow = ReturnType<typeof createDeviceAuthFlow>;
