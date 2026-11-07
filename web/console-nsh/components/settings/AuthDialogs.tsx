// Device sign-in dialogs (Codex, xAI, Mister Morph Pro) and the Pro and xAI sign-in flows (the Vue
// console's CodexAuthDialog, XAIAuthDialog, ProAuthDialog, DeviceAuthDialogContent,
// useProAuthFlow and useXAIAuthFlow).
//
// Vue to nsh: a dialog's `modelValue` is `open`, `update:modelValue` is `onOpenChange(open)`;
// `update:setDefault` is `onSetDefaultChange(value)`; `login` / `logout` are `onLogin()` /
// `onLogout()`. The flows return signals (`flow.proAuthBusy()`), and must be called in a component
// body: they stop their polling when it goes.
import { type Accessor, cleanup, computed, effect, type Signal, signal, Text, untracked, View } from "nsh";
import { formatTime } from "../../lib/core/context.js";
import { invalidateConsoleSetupReadiness } from "../../lib/core/setup.js";
import { openReentrantDialog } from "../../lib/core/reentrant-dialog.js";
import { copyText, openExternal } from "../../lib/platform";
import { Button, Spinner, Toggle } from "../ui";
import { DialogShell, InlineNotice, t } from "./DialogShell";

export const CODEX_USAGE_URL = "https://chatgpt.com/codex/settings/usage";
export const PRO_USAGE_URL = "https://router.mistermorph.com/console/usage";

/** A sign-in status as the runtime reports it (`/auth/<provider>/status`). */
export interface DeviceAuthStatus {
  logged_in?: boolean;
  access_token_present?: boolean;
  refresh_token_present?: boolean;
  access_token_expired?: boolean;
  expires_at?: string;
  file_mode_ok?: boolean;
  file_mode_warning?: string;
  /** Codex: the ChatGPT account. */
  account_id?: string;
  /** Pro: the signed-in user. */
  user?: { name?: string; email?: string; union_id?: string; [key: string]: unknown };
  subscription?: string;
  subscription_api_key_present?: boolean;
  scope?: string;
  [key: string]: unknown;
}

/** The state of a device sign-in (the Vue `deviceAuthStateProps`). */
export interface DeviceAuthStateProps {
  loading?: boolean;
  busy?: boolean;
  error?: string;
  status?: DeviceAuthStatus | null;
  summary?: string;
  loginSession?: string;
  verificationURL?: string;
  userCode?: string;
  loginExpiresLabel?: string;
}

export interface DeviceAuthDialogContentProps extends DeviceAuthStateProps {
  accountLabel?: string;
  accountIntroKey?: string;
  sessionKey?: string;
  statusReadyKey?: string;
  statusNeedsLoginKey?: string;
  setDefaultNoteKey?: string;
  loginPendingKey?: string;
  loginExpiresKey?: string;
  openVerificationKey?: string;
  /** Default `settings_codex_auth_user_code`. */
  userCodeKey?: string;
  extraActionKey?: string;
  extraActionURL?: string;
  showSetDefaultToggle?: boolean;
  setDefault?: boolean;
  setDefaultKey?: string;
  reloginKey?: string;
  onLogin?: () => void;
  onLogout?: () => void;
  /** The Vue `update:setDefault`. */
  onSetDefaultChange?: (value: boolean) => void;
}

const tk = (key: string | undefined, vars?: Record<string, unknown>) => (key ? t(key, vars) : "");

/** The body the three dialogs share: the session row, the device code, and the actions. */
export function DeviceAuthDialogContent(props: DeviceAuthDialogContentProps) {
  const loggedIn = () => props.status?.logged_in === true;
  const introText = () => {
    const account = String(props.accountLabel || "").trim();
    return account && props.accountIntroKey ? t(props.accountIntroKey, { account }) : "";
  };
  const statusTone = () => (props.loading ? "text-muted-foreground" : loggedIn() ? "text-ok" : "text-warn-dark");
  const extraActionLabel = () => tk(props.extraActionKey);
  const showExtraAction = () => extraActionLabel() !== "" && String(props.extraActionURL || "").trim() !== "";

  const openVerificationURL = () => {
    const url = String(props.verificationURL || "").trim();
    if (url) openExternal(url);
  };
  const openExtraAction = () => {
    const url = String(props.extraActionURL || "").trim();
    if (url) openExternal(url);
  };
  const copyUserCode = async () => {
    const text = String(props.userCode || "").trim();
    if (!text) return;
    try {
      await copyText(text);
    } catch (error) {
      console.warn("could not copy the user code:", (error as Error)?.message || error);
    }
  };

  return (
    <View class="gap-3" testID="device-auth">
      <If when={introText()}>
        <Text class="text-sm text-subtle">{introText()}</Text>
      </If>

      <If when={props.error}>
        <InlineNotice type="error" text={props.error ?? ""} testID="device-auth-error" />
      </If>

      <View class="flex-row items-center gap-3 rounded-(--radius) border border-line-faint bg-card px-3 py-2.5">
        <View class="flex-1 gap-0.5">
          <Text class="text-sm font-medium text-foreground">{tk(props.sessionKey)}</Text>
          <Text class="text-xs text-muted-foreground">{loggedIn() ? tk(props.statusReadyKey) : tk(props.statusNeedsLoginKey)}</Text>
        </View>
        <If
          when={props.loading || props.busy}
          else={<Text class={`text-sm font-semibold ${statusTone()}`}>{props.summary ?? ""}</Text>}
        >
          <Spinner size={18} />
        </If>
      </View>

      <If when={props.status?.file_mode_ok === false}>
        <InlineNotice type="error" text={String(props.status?.file_mode_warning || "")} />
      </If>

      <If when={!loggedIn() && !props.loginSession}>
        <Text class="text-sm text-subtle">{tk(props.setDefaultNoteKey)}</Text>
      </If>

      <If when={props.loginSession}>
        <View class="gap-3 rounded-(--radius) border border-line-faint bg-paper px-3 py-3">
          <View class="gap-1">
            <Text class="font-mono text-xs uppercase tracking-wide text-muted-foreground">
              {tk(props.userCodeKey || "settings_codex_auth_user_code")}
            </Text>
            <View class="flex-row items-center gap-2">
              <View selectable>
                <Text class="font-mono text-xl font-semibold text-foreground" testID="device-auth-user-code">
                  {props.userCode ?? ""}
                </Text>
              </View>
              <Button
                variant="plain"
                size="xs"
                iconOnly
                icon="PhCopy"
                title={t("action_copy")}
                disabled={!props.userCode}
                onPress={() => void copyUserCode()}
              />
            </View>
          </View>
          <View class="gap-1">
            <Text class="text-sm font-medium text-foreground">{tk(props.loginPendingKey)}</Text>
            <Button
              variant="plain"
              size="xs"
              class="-ml-2"
              label={tk(props.openVerificationKey)}
              title={props.verificationURL || undefined}
              onPress={openVerificationURL}
            />
            <Text class="text-xs text-muted-foreground">{tk(props.loginExpiresKey, { time: props.loginExpiresLabel ?? "" })}</Text>
          </View>
        </View>
      </If>

      <If when={props.loginSession && props.showSetDefaultToggle}>
        <View class="flex-row items-center justify-between gap-3">
          <Text class="flex-1 text-sm text-foreground">{tk(props.setDefaultKey)}</Text>
          <Toggle
            checked={!!props.setDefault}
            disabled={props.busy}
            testID="device-auth-set-default"
            onChange={(value) => props.onSetDefaultChange?.(value)}
          />
        </View>
      </If>

      <View class="flex-row items-center justify-between gap-2">
        <View class="flex-row items-center gap-1">
          <If when={loggedIn() && props.reloginKey}>
            <Button
              variant="plain"
              size="xs"
              label={tk(props.reloginKey)}
              disabled={props.busy || props.loading || !!props.loginSession}
              onPress={() => props.onLogin?.()}
            />
          </If>
          <If when={loggedIn()}>
            <Button
              variant="ghost-danger"
              size="xs"
              label={t("action_logout")}
              loading={props.busy}
              disabled={props.busy || props.loading}
              onPress={() => props.onLogout?.()}
            />
          </If>
        </View>
        <If when={showExtraAction()}>
          <Button variant="plain" size="xs" label={extraActionLabel()} title={extraActionLabel()} onPress={openExtraAction} />
        </If>
      </View>
    </View>
  );
}

/** A dialog's open state: the Vue `modelValue` / `update:modelValue`. */
export interface AuthDialogOpenProps {
  open: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function CodexAuthDialog(props: DeviceAuthStateProps & AuthDialogOpenProps & { onLogout?: () => void }) {
  const accountLabel = () => String(props.status?.account_id || "").trim();
  return (
    <DialogShell
      open={props.open}
      title={t("settings_codex_auth_title")}
      closeDisabled={props.busy}
      onClose={() => props.onOpenChange?.(false)}
      testID="codex-auth-dialog"
    >
      <DeviceAuthDialogContent
        loading={props.loading}
        busy={props.busy}
        error={props.error}
        status={props.status}
        summary={props.summary}
        loginSession={props.loginSession}
        verificationURL={props.verificationURL}
        userCode={props.userCode}
        loginExpiresLabel={props.loginExpiresLabel}
        accountLabel={accountLabel()}
        accountIntroKey="settings_codex_auth_account_intro"
        sessionKey="settings_codex_auth_session"
        statusReadyKey="settings_codex_auth_status_ready"
        statusNeedsLoginKey="settings_codex_auth_status_needs_login"
        setDefaultNoteKey="settings_codex_auth_set_default_note"
        loginPendingKey="settings_codex_auth_login_pending"
        loginExpiresKey="settings_codex_auth_login_expires"
        openVerificationKey="settings_codex_auth_open_verification"
        userCodeKey="settings_codex_auth_user_code"
        extraActionKey="settings_codex_auth_usage"
        extraActionURL={CODEX_USAGE_URL}
        onLogout={() => props.onLogout?.()}
      />
    </DialogShell>
  );
}

export function XAIAuthDialog(
  props: DeviceAuthStateProps &
    AuthDialogOpenProps & {
      setDefault?: boolean;
      onSetDefaultChange?: (value: boolean) => void;
      onLogin?: () => void;
      onLogout?: () => void;
    },
) {
  return (
    <DialogShell
      open={props.open}
      title={t("settings_xai_auth_title")}
      closeDisabled={props.busy}
      onClose={() => props.onOpenChange?.(false)}
      testID="xai-auth-dialog"
    >
      <DeviceAuthDialogContent
        loading={props.loading}
        busy={props.busy}
        error={props.error}
        status={props.status}
        summary={props.summary}
        loginSession={props.loginSession}
        verificationURL={props.verificationURL}
        userCode={props.userCode}
        loginExpiresLabel={props.loginExpiresLabel}
        sessionKey="settings_xai_auth_session"
        statusReadyKey="settings_xai_auth_status_ready"
        statusNeedsLoginKey="settings_xai_auth_status_needs_login"
        setDefaultNoteKey="settings_xai_auth_login_note"
        loginPendingKey="settings_xai_auth_login_pending"
        loginExpiresKey="settings_xai_auth_login_expires"
        openVerificationKey="settings_xai_auth_open_verification"
        userCodeKey="settings_xai_auth_user_code"
        showSetDefaultToggle
        setDefault={props.setDefault}
        setDefaultKey="settings_xai_auth_set_default"
        reloginKey="settings_xai_auth_relogin"
        onSetDefaultChange={(value) => props.onSetDefaultChange?.(value)}
        onLogin={() => props.onLogin?.()}
        onLogout={() => props.onLogout?.()}
      />
    </DialogShell>
  );
}

/** The Pro account's name: the user's name, email or id. */
export function proUserLabel(status: DeviceAuthStatus | null | undefined) {
  const user = status && typeof status.user === "object" && status.user ? status.user : {};
  return (
    (typeof user.name === "string" && user.name.trim()) ||
    (typeof user.email === "string" && user.email.trim()) ||
    (typeof user.union_id === "string" && user.union_id.trim()) ||
    ""
  );
}

export function ProAuthDialog(props: DeviceAuthStateProps & AuthDialogOpenProps & { onLogout?: () => void }) {
  return (
    <DialogShell
      open={props.open}
      title={t("settings_pro_auth_title")}
      closeDisabled={props.busy}
      onClose={() => props.onOpenChange?.(false)}
      testID="pro-auth-dialog"
    >
      <DeviceAuthDialogContent
        loading={props.loading}
        busy={props.busy}
        error={props.error}
        status={props.status}
        summary={props.summary}
        loginSession={props.loginSession}
        verificationURL={props.verificationURL}
        userCode={props.userCode}
        loginExpiresLabel={props.loginExpiresLabel}
        accountLabel={proUserLabel(props.status)}
        accountIntroKey="settings_pro_auth_account_intro"
        sessionKey="settings_pro_auth_session"
        statusReadyKey="settings_pro_auth_status_ready"
        statusNeedsLoginKey="settings_pro_auth_status_needs_login"
        setDefaultNoteKey="settings_pro_auth_set_default_note"
        loginPendingKey="settings_pro_auth_login_pending"
        loginExpiresKey="settings_codex_auth_login_expires"
        openVerificationKey="settings_pro_auth_open_verification"
        userCodeKey="settings_codex_auth_user_code"
        extraActionKey="settings_pro_auth_usage"
        extraActionURL={PRO_USAGE_URL}
        onLogout={() => props.onLogout?.()}
      />
    </DialogShell>
  );
}

/* ---------- the sign-in flows ---------- */

/** How the flows reach the runtime: `endpointApiFetch` from lib/core/context.js. */
export type AuthRequest = (endpointRef: string, path: string, options?: { method?: string; body?: unknown }) => Promise<any>;

export interface AuthFlowOptions {
  request: AuthRequest;
  getEndpointRef: () => string;
  /** A sign-in changed the settings (`settings_updated`): reload them. */
  onSettingsUpdated: (payload: any, endpointRef: string) => void | Promise<void>;
}

/** "loading", "signed-out", "refreshable", "expired" or "signed-in". */
export type AuthButtonState = "loading" | "signed-out" | "refreshable" | "expired" | "signed-in";

function errorText(error: unknown, fallbackKey: string) {
  return (error as Error)?.message || t(fallbackKey);
}

function normalizeStatus(payload: any, extra: boolean): DeviceAuthStatus {
  const status = payload && typeof payload.status === "object" ? payload.status : payload;
  const base: DeviceAuthStatus = {
    logged_in: status?.logged_in === true,
    access_token_present: status?.access_token_present === true,
    refresh_token_present: status?.refresh_token_present === true,
    access_token_expired: status?.access_token_expired === true,
    expires_at: typeof status?.expires_at === "string" ? status.expires_at : "",
    file_mode_ok: status?.file_mode_ok !== false,
    file_mode_warning: typeof status?.file_mode_warning === "string" ? status.file_mode_warning : "",
  };
  if (!extra) return base;
  return {
    ...base,
    subscription_api_key_present: status?.subscription_api_key_present === true,
    subscription: typeof status?.subscription === "string" ? status.subscription : "",
    scope: typeof status?.scope === "string" ? status.scope : "",
    user: status?.user && typeof status.user === "object" ? status.user : {},
  };
}

function emptyStatus(extra: boolean) {
  return normalizeStatus({}, extra);
}

/**
 * The shared device sign-in flow: status, start, poll every `interval_seconds` (2 s at least),
 * logout. A request for another endpoint than the current one, or overtaken by a newer one, is
 * dropped. `prefix` is the runtime's route (`/auth/pro`), `keys` the summary texts' prefix.
 */
function useDeviceAuthFlow(
  options: AuthFlowOptions,
  config: {
    prefix: string;
    keys: string;
    extra: boolean;
    pollBody: (sessionID: string) => unknown;
    afterLogout?: (payload: any, error: Signal<string>) => void;
    onReset?: () => void;
  },
) {
  const loading = signal(false);
  const busy = signal(false);
  const error = signal("");
  const dialogOpen = signal(false);
  const loginSession = signal("");
  const verificationURL = signal("");
  const userCode = signal("");
  const expiresAt = signal("");
  const status = signal<DeviceAuthStatus>(emptyStatus(config.extra));
  let pollTimer: ReturnType<typeof setTimeout> | 0 = 0;
  let generation = 0;
  let loginEndpointRef = "";

  const buttonState = computed<AuthButtonState>(() => {
    if (loading()) return "loading";
    const current = status();
    if (!current.logged_in) return "signed-out";
    if (current.access_token_expired && current.refresh_token_present) return "refreshable";
    if (current.access_token_expired) return "expired";
    return "signed-in";
  });
  const summary = computed(() => {
    switch (buttonState()) {
      case "loading":
        return t(`${config.keys}_loading`);
      case "signed-out":
        return t(`${config.keys}_signed_out`);
      case "refreshable":
        return t(`${config.keys}_refreshable`);
      case "expired":
        return t(`${config.keys}_expired`);
      default:
        return t(`${config.keys}_signed_in`);
    }
  });
  const needsLogin = computed(() => ["signed-out", "expired"].includes(buttonState()));
  const buttonTitle = computed(() => `${t(`${config.keys}_title`)}: ${summary()}`);
  const expiresLabel = computed(() => (expiresAt() ? formatTime(expiresAt()) : t("ttl_unknown")));

  const currentEndpointRef = () => String(untracked(options.getEndpointRef) || "").trim();
  const isCurrent = (gen: number, endpointRef: string) => gen === generation && endpointRef === currentEndpointRef();
  const applyStatus = (payload: any) => status.set(normalizeStatus(payload, config.extra));

  async function loadStatus(endpointRef = currentEndpointRef()) {
    if (untracked(loading)) return;
    const target = String(endpointRef || "").trim();
    const gen = generation;
    loading.set(true);
    error.set("");
    try {
      const payload = await options.request(target, `${config.prefix}/status`);
      if (!isCurrent(gen, target)) return;
      applyStatus(payload);
    } catch (e) {
      if (isCurrent(gen, target)) error.set(errorText(e, "msg_load_failed"));
    } finally {
      if (isCurrent(gen, target)) loading.set(false);
    }
  }

  function clearTimer() {
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = 0;
    }
  }

  function resetLoginSession() {
    clearTimer();
    loginSession.set("");
    verificationURL.set("");
    userCode.set("");
    expiresAt.set("");
    loginEndpointRef = "";
  }

  function resetFlow() {
    generation += 1;
    loading.set(false);
    busy.set(false);
    resetLoginSession();
    error.set("");
    config.onReset?.();
  }

  function schedulePoll(intervalSeconds: unknown = 5) {
    clearTimer();
    const delay = Math.max(2, Number(intervalSeconds) || 5) * 1000;
    pollTimer = setTimeout(() => {
      pollTimer = 0;
      void poll();
    }, delay);
  }

  async function startLogin(endpointRef = currentEndpointRef()) {
    if (untracked(busy)) return;
    const target = String(endpointRef || "").trim();
    const gen = ++generation;
    loading.set(false);
    busy.set(true);
    error.set("");
    resetLoginSession();
    try {
      const payload = await options.request(target, `${config.prefix}/login/start`, { method: "POST" });
      if (!isCurrent(gen, target)) return;
      loginEndpointRef = target;
      const url = String(payload?.verification_url_complete || payload?.verification_url || "").trim();
      loginSession.set(String(payload?.session_id || "").trim());
      verificationURL.set(url);
      userCode.set(String(payload?.user_code || "").trim());
      expiresAt.set(String(payload?.expires_at || "").trim());
      if (url) openExternal(url);
      schedulePoll(payload?.interval_seconds);
    } catch (e) {
      if (isCurrent(gen, target)) error.set(errorText(e, "msg_load_failed"));
    } finally {
      if (gen === generation) busy.set(false);
    }
  }

  async function poll() {
    const sessionID = untracked(loginSession);
    const target = loginEndpointRef;
    if (!sessionID || untracked(busy)) return;
    if (target !== currentEndpointRef()) {
      resetFlow();
      return;
    }
    const gen = ++generation;
    loading.set(false);
    busy.set(true);
    error.set("");
    try {
      const payload = await options.request(target, `${config.prefix}/login/poll`, {
        method: "POST",
        body: config.pollBody(sessionID),
      });
      if (!isCurrent(gen, target) || target !== loginEndpointRef) return;
      if (payload?.pending === true) {
        schedulePoll(payload?.interval_seconds);
        return;
      }
      applyStatus(payload);
      resetLoginSession();
      if (payload?.settings_updated === true) {
        invalidateConsoleSetupReadiness();
        await options.onSettingsUpdated(payload, target);
      }
    } catch (e) {
      if (isCurrent(gen, target)) error.set(errorText(e, "msg_load_failed"));
    } finally {
      if (gen === generation) busy.set(false);
    }
  }

  async function logout() {
    if (untracked(busy)) return;
    const target = currentEndpointRef();
    const gen = ++generation;
    loading.set(false);
    busy.set(true);
    error.set("");
    try {
      const payload = await options.request(target, `${config.prefix}/logout`, { method: "POST" });
      if (!isCurrent(gen, target)) return;
      applyStatus(payload);
      resetLoginSession();
      config.afterLogout?.(payload, error);
    } catch (e) {
      if (isCurrent(gen, target)) error.set(errorText(e, "msg_delete_failed"));
    } finally {
      if (gen === generation) busy.set(false);
    }
  }

  /** Opens the dialog, loads the status, and starts a sign-in when one is needed. */
  async function openDialog() {
    const target = currentEndpointRef();
    const shouldStart = untracked(() => needsLogin() && !loginSession() && !busy());
    await openReentrantDialog(dialogOpen);
    void loadStatus(target);
    if (shouldStart) void startLogin(target);
  }

  function resetEndpointState() {
    resetFlow();
    status.set(emptyStatus(config.extra));
  }

  // Closing the dialog abandons the sign-in.
  let wasOpen = untracked(dialogOpen);
  effect(() => {
    const open = dialogOpen();
    untracked(() => {
      if (wasOpen && !open) resetFlow();
      wasOpen = open;
    });
  });
  cleanup(() => {
    generation += 1;
    clearTimer();
  });

  return {
    loading,
    busy,
    error,
    dialogOpen,
    status,
    summary,
    buttonState,
    needsLogin,
    buttonTitle,
    loginSession,
    verificationURL,
    userCode,
    expiresLabel,
    loadStatus,
    openDialog,
    startLogin,
    poll,
    logout,
    resetFlow,
    resetEndpointState,
  };
}

export interface ProAuthFlow {
  proAuthLoading: Signal<boolean>;
  proAuthBusy: Signal<boolean>;
  proAuthError: Signal<string>;
  proAuthDialogOpen: Signal<boolean>;
  proAuthStatus: Signal<DeviceAuthStatus>;
  proAuthSummary: Accessor<string>;
  proAuthButtonState: Accessor<AuthButtonState>;
  proAuthNeedsLogin: Accessor<boolean>;
  proAuthButtonTitle: Accessor<string>;
  proLoginSession: Signal<string>;
  proLoginVerificationURL: Signal<string>;
  proLoginUserCode: Signal<string>;
  proLoginExpiresLabel: Accessor<string>;
  loadProAuthStatus: (endpointRef?: string) => Promise<void>;
  openProAuthDialog: () => Promise<void>;
  pollProLogin: () => Promise<void>;
  logoutProAuth: () => Promise<void>;
  resetProAuthFlow: () => void;
  resetProAuthEndpointState: () => void;
}

/** The Mister Morph Pro sign-in (useProAuthFlow): a sign-in always becomes the default. */
export function useProAuthFlow(options: AuthFlowOptions): ProAuthFlow {
  const flow = useDeviceAuthFlow(options, {
    prefix: "/auth/pro",
    keys: "settings_pro_auth",
    extra: true,
    pollBody: (sessionID) => ({ session_id: sessionID, set_default: true }),
  });
  return {
    proAuthLoading: flow.loading,
    proAuthBusy: flow.busy,
    proAuthError: flow.error,
    proAuthDialogOpen: flow.dialogOpen,
    proAuthStatus: flow.status,
    proAuthSummary: flow.summary,
    proAuthButtonState: flow.buttonState,
    proAuthNeedsLogin: flow.needsLogin,
    proAuthButtonTitle: flow.buttonTitle,
    proLoginSession: flow.loginSession,
    proLoginVerificationURL: flow.verificationURL,
    proLoginUserCode: flow.userCode,
    proLoginExpiresLabel: flow.expiresLabel,
    loadProAuthStatus: flow.loadStatus,
    openProAuthDialog: flow.openDialog,
    pollProLogin: flow.poll,
    logoutProAuth: flow.logout,
    resetProAuthFlow: flow.resetFlow,
    resetProAuthEndpointState: flow.resetEndpointState,
  };
}

export interface XAIAuthFlow {
  xaiAuthLoading: Signal<boolean>;
  xaiAuthBusy: Signal<boolean>;
  xaiAuthError: Signal<string>;
  xaiAuthDialogOpen: Signal<boolean>;
  /** Whether a finished sign-in becomes the default profile (the dialog's switch). */
  xaiSetDefault: Signal<boolean>;
  xaiAuthStatus: Signal<DeviceAuthStatus>;
  xaiAuthSummary: Accessor<string>;
  xaiAuthButtonState: Accessor<AuthButtonState>;
  xaiAuthNeedsLogin: Accessor<boolean>;
  xaiAuthReady: Accessor<boolean>;
  xaiAuthButtonTitle: Accessor<string>;
  xaiLoginSession: Signal<string>;
  xaiLoginVerificationURL: Signal<string>;
  xaiLoginUserCode: Signal<string>;
  xaiLoginExpiresLabel: Accessor<string>;
  loadXAIAuthStatus: (endpointRef?: string) => Promise<void>;
  openXAIAuthDialog: () => Promise<void>;
  reloginXAIAuth: () => void;
  pollXAILogin: () => Promise<void>;
  logoutXAIAuth: () => Promise<void>;
  resetXAIAuthFlow: () => void;
  resetXAIAuthEndpointState: () => void;
}

/** The xAI (Grok) sign-in (useXAIAuthFlow): the dialog's switch decides whether it becomes the default. */
export function useXAIAuthFlow(options: AuthFlowOptions): XAIAuthFlow {
  const setDefault = signal(false);
  const flow = useDeviceAuthFlow(options, {
    prefix: "/auth/xai",
    keys: "settings_xai_auth",
    extra: false,
    pollBody: (sessionID) => ({ session_id: sessionID, set_default: untracked(setDefault) }),
    afterLogout: (payload, error) => {
      if (typeof payload?.revocation_warning === "string") error.set(payload.revocation_warning);
    },
    onReset: () => setDefault.set(false),
  });
  const ready = computed(() => flow.status().logged_in === true && flow.status().file_mode_ok !== false);
  return {
    xaiAuthLoading: flow.loading,
    xaiAuthBusy: flow.busy,
    xaiAuthError: flow.error,
    xaiAuthDialogOpen: flow.dialogOpen,
    xaiSetDefault: setDefault,
    xaiAuthStatus: flow.status,
    xaiAuthSummary: flow.summary,
    xaiAuthButtonState: flow.buttonState,
    xaiAuthNeedsLogin: flow.needsLogin,
    xaiAuthReady: ready,
    xaiAuthButtonTitle: flow.buttonTitle,
    xaiLoginSession: flow.loginSession,
    xaiLoginVerificationURL: flow.verificationURL,
    xaiLoginUserCode: flow.userCode,
    xaiLoginExpiresLabel: flow.expiresLabel,
    loadXAIAuthStatus: flow.loadStatus,
    openXAIAuthDialog: flow.openDialog,
    reloginXAIAuth: () => {
      if (untracked(flow.busy)) return;
      void flow.startLogin();
    },
    pollXAILogin: flow.poll,
    logoutXAIAuth: flow.logout,
    resetXAIAuthFlow: flow.resetFlow,
    resetXAIAuthEndpointState: flow.resetEndpointState,
  };
}
