// The login page: the console's password, then on to setup or the page that sent us here.
// Without a password the console logs in by itself and this page only passes through.
import type { InputRef } from "nsh";
import { effect, Image, signal, Text, untracked, View } from "nsh";
import loginLogo from "../../assets/images/app_logo.svg";
import { LanguageSelector } from "../../components/LanguageSelector";
import { Button, Icon, TextField } from "../../components/ui";
import {
  apiFetch,
  authState,
  endpointState,
  ensureConsoleSession,
  loadEndpoints,
  translate as t,
} from "../../lib/core/context.js";
import { endpointRoutePath } from "../../lib/core/endpoint-routes.js";
import { consoleSetupTargetEndpointRef, resolveConsoleSetupStage, setupStagePath } from "../../lib/core/setup.js";
import { origin } from "../../lib/platform";
import { currentRoute, locationOf, navigate } from "../../lib/router";

export function LoginPage() {
  const password = signal("");
  const busy = signal(false);
  const err = signal("");
  const showPassword = signal(false);
  let passwordInput: InputRef | undefined;
  const host = (() => {
    try {
      return new URL(origin()).host;
    } catch {
      return "";
    }
  })();
  // /login?stay skips the automatic session check and redirect, e.g. to preview this page.
  const stay = () => {
    const value = currentRoute().query.stay;
    return value !== undefined && !["0", "false"].includes(String(value).toLowerCase());
  };

  const focusPassword = () => queueMicrotask(() => passwordInput?.focus());

  async function finishLogin() {
    await loadEndpoints();
    const setupState = await resolveConsoleSetupStage(endpointState.items);
    const redirect = currentRoute().query.redirect || "/overview";
    if (setupState.stage !== "ready") {
      const keep = redirect && redirect !== "/overview" && redirect !== "/";
      await navigate(locationOf(setupStagePath(setupState.stage), keep ? { redirect } : {}), { replace: true });
      return;
    }
    const targetRef = consoleSetupTargetEndpointRef(setupState.setup);
    if (redirect && redirect !== "/overview" && redirect !== "/") {
      await navigate(redirect, { replace: true });
      return;
    }
    if (targetRef) {
      await navigate(endpointRoutePath(targetRef, "/chat"), { replace: true });
      return;
    }
    await navigate("/overview", { replace: true });
  }

  async function submit() {
    if (busy()) return;
    if (!password().trim()) {
      err.set(t("login_required_password"));
      focusPassword();
      return;
    }
    busy.set(true);
    err.set("");
    try {
      const body = await apiFetch("/auth/login", { method: "POST", body: { password: password() }, noAuth: true });
      authState.token = body.access_token || "";
      authState.expiresAt = body.expires_at || "";
      authState.account = "console";
      authState.save();
      await finishLogin();
    } catch (e) {
      err.set((e as Error)?.message || t("login_failed"));
      busy.set(false);
      focusPassword();
      return;
    }
    busy.set(false);
  }

  // Once, after the page's elements exist: log in by itself when the console has no password.
  effect(() => untracked(() => void start()));
  async function start() {
    if (stay()) {
      focusPassword();
      return;
    }
    busy.set(true);
    err.set("");
    try {
      if (await ensureConsoleSession()) {
        await finishLogin();
      }
    } catch (e) {
      console.warn("automatic login failed", (e as Error)?.message);
    } finally {
      busy.set(false);
    }
    if (!authState.token) focusPassword();
  }

  return (
    <View class="flex-1 items-center justify-center bg-background p-6">
      <View class="w-full max-w-sm gap-6">
        <View class="items-center gap-3">
          <Image src={loginLogo} class="size-14" />
          <Text class="text-xl font-semibold text-foreground" role="header">
            Mister Morph
          </Text>
        </View>
        <View class="gap-4 rounded-(--radius) border border-line-faint bg-card p-5">
          <View class="flex-row items-baseline justify-between gap-3">
            <Text class="text-base font-semibold text-foreground">{t("login_subtitle")}</Text>
            <Text class="font-mono text-xs text-muted-foreground line-clamp-1">{host}</Text>
          </View>
          <TextField
            label={t("login_password_label")}
            value={password()}
            onChange={(value) => {
              password.set(value);
              err.set("");
            }}
            onSubmit={() => void submit()}
            placeholder={t("login_password_placeholder")}
            masked={!showPassword()}
            disabled={busy()}
            error={err()}
            testID="login-password"
            inputRef={(node) => (passwordInput = node)}
            trailing={
              <Button
                variant="plain"
                size="xxs"
                iconOnly
                icon={showPassword() ? "PhEyeSlash" : "PhEye"}
                title={t(showPassword() ? "login_hide_password" : "login_show_password")}
                disabled={busy()}
                selected={showPassword()}
                onPress={() => showPassword.update((v) => !v)}
              />
            }
          />
          <Button variant="primary" size="md" block label={t("login_button")} loading={busy()} onPress={() => void submit()} />
        </View>
        <View class="items-center">
          <LanguageSelector />
        </View>
      </View>
    </View>
  );
}
