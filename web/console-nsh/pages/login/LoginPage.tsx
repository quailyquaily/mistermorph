// The login page: the console's password, then on to setup or the page that sent us here.
// Without a password the console logs in by itself and this page only passes through.
import type { InputRef } from "nsh";
import { effect, Image, signal, Text, untracked, View, windowSize } from "nsh";
import loginLogo from "../../assets/images/app_logo.svg";
import { LanguageSelector } from "../../components/LanguageSelector";
import { Button, TextField } from "../../components/ui";
import { ObserveSection } from "../../components/observe/parts";
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
import { isMobile, origin, serverAddress } from "../../lib/platform";
import { currentRoute, locationOf, navigate } from "../../lib/router";
import { ServerDialog } from "./ServerDialog";

/** A field's label on the card: mono caps, as the section's title. */
const FIELD_LABEL = "font-mono text-[11px] font-medium uppercase leading-[15.4px] tracking-[0.12em] text-muted-foreground";

type Frame = { origin: { x: number; y: number }; size: { width: number; height: number } };
let loginWatcher: ((part: string, frame: Frame) => void) | null = null;

/**
 * For tests: the frames of the card's parts, each in its parent, as they are laid out
 * ("column", "server", "server.change", "password.box", "password.end", "password.reveal").
 * Read as the page is made; null stops it.
 */
export function watchLoginLayout(watcher: ((part: string, frame: Frame) => void) | null) {
  loginWatcher = watcher;
}

export function LoginPage() {
  const password = signal("");
  const busy = signal(false);
  const err = signal("");
  const showPassword = signal(false);
  let passwordInput: InputRef | undefined;
  const hostOf = () => {
    try {
      return new URL(origin()).host;
    } catch {
      return "";
    }
  };
  // The console's address as the page shows it: the phone app's as saved (its path too), the
  // browser's and the desktop app's own origin.
  const serverOf = () => (isMobile() ? serverAddress() : origin() || hostOf());
  const server = signal(serverOf());
  // The phone app has no server of its own: the user enters the console's address in a dialog.
  const serverOpen = signal(false);
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
    if (isMobile()) {
      if (!serverAddress()) {
        serverOpen.set(true);
        return;
      }
      if (!password().trim()) {
        // A console without a password logs in by itself.
        busy.set(true);
        err.set("");
        try {
          if (await ensureConsoleSession()) {
            await finishLogin();
            return;
          }
        } catch (e) {
          err.set((e as Error)?.message || t("login_failed"));
          busy.set(false);
          return;
        } finally {
          busy.set(false);
        }
      }
    }
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
    if (isMobile() && !serverAddress()) {
      serverOpen.set(true);
      return;
    }
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

  // Vue: centred, 24/16 padding and 10vh under it; on phones (<=480) it sits 12vh from the top.
  const phone = () => windowSize().width <= 480;
  const probe = loginWatcher;
  return (
    <View
      class={`flex-1 items-center px-4 ${phone() ? "" : "justify-center"}`}
      style={phone() ? { paddingTop: windowSize().height * 0.12 } : { paddingTop: 24, paddingBottom: windowSize().height * 0.1 }}
    >
      <View class="w-full gap-4" style={{ maxWidth: 400 }} onLayout={probe ? (event) => probe("column", event.bounds) : undefined}>
        {/* The brand: the mark and the name in tracked mono caps. */}
        <View class="flex-row items-center gap-3 px-0.5">
          <Image src={loginLogo} style={{ width: 32, height: 32 }} />
          <Text class="font-mono text-base font-semibold uppercase leading-[20.8px] tracking-[0.14em] text-foreground" role="header">
            Mister Morph
          </Text>
        </View>
        <ObserveSection variant="boxed" title={t("login_subtitle")} gap={0}>
          <View class="gap-4 px-2 pb-1 pt-2">
            {/* The console this password is for: its address in full, and in the phone app, which
                has no console of its own, the button that sets or changes it, named for what it does. */}
            <View class="gap-2" testID="login-server" onLayout={probe ? (event) => probe("server", event.bounds) : undefined}>
              <Text class={FIELD_LABEL}>{t("login_server_label")}</Text>
              <View class="flex-row items-center gap-3">
                <Text
                  class={`min-w-0 flex-1 font-mono text-xs leading-[17.4px] line-clamp-3 ${server() ? "text-foreground" : "text-muted-foreground"}`}
                  testID="login-server-address"
                >
                  {server() || t("login_server_none")}
                </Text>
                <If when={isMobile()}>
                  <Button
                    variant="outlined"
                    size="xs"
                    label={t(server() ? "login_server_change" : "login_server_set")}
                    disabled={busy()}
                    hitSlop={6}
                    class="shrink-0"
                    testID="login-server-open"
                    onLayout={probe ? (event) => probe("server.change", event.bounds) : undefined}
                    onPress={() => serverOpen.set(true)}
                  />
                </If>
              </View>
              <If when={isMobile()}>
                <Text class="text-xs leading-[17.4px] text-muted-foreground">{t("login_server_note")}</Text>
              </If>
            </View>
            <View>
              <Text class={`mb-2 ${FIELD_LABEL}`}>{t("login_password_label")}</Text>
              {/* A fixed slot under the field, so an error never shifts the button. */}
              <View style={{ minHeight: 44 + 30 }}>
                <TextField
                  value={password()}
                  onChange={(value) => {
                    password.set(value);
                    err.set("");
                  }}
                  onSubmit={() => void submit()}
                  placeholder={t("login_password_placeholder")}
                  accessibilityLabel={t("login_password_label")}
                  masked={!showPassword()}
                  disabled={busy()}
                  error={err()}
                  testID="login-password"
                  inputRef={(node) => (passwordInput = node)}
                  onBoxLayout={probe ? (event) => probe("password.box", event.bounds) : undefined}
                  trailing={
                    // The eye sits inside the field's end as far from its edge as from its top and
                    // bottom (a 32pt button in the 44pt box), so it is centred in its corner; the
                    // typed text ends before it, and showing the password moves nothing.
                    <View
                      class="shrink-0 flex-row items-center pr-[5px]"
                      onLayout={probe ? (event) => probe("password.end", event.bounds) : undefined}
                    >
                      <Button
                        variant="plain"
                        size="xs"
                        iconOnly
                        icon={showPassword() ? "PhEyeSlash" : "PhEye"}
                        title={t(showPassword() ? "login_hide_password" : "login_show_password")}
                        disabled={busy()}
                        selected={showPassword()}
                        // A 44pt target round the 32pt button.
                        hitSlop={6}
                        testID="login-password-reveal"
                        onLayout={probe ? (event) => probe("password.reveal", event.bounds) : undefined}
                        onPress={() => showPassword.update((v) => !v)}
                      />
                    </View>
                  }
                />
              </View>
              <Button variant="primary" size="md" block label={t("login_button")} loading={busy()} testID="login-submit" onPress={() => void submit()} />
            </View>
          </View>
        </ObserveSection>
        <View class="items-end">
          <LanguageSelector />
        </View>
      </View>
      <If when={isMobile()}>
        <ServerDialog
          open={serverOpen()}
          onClose={() => serverOpen.set(false)}
          onSaved={() => {
            serverOpen.set(false);
            server.set(serverOf());
            // A console without a password logs in by itself.
            void start();
          }}
        />
      </If>
    </View>
  );
}
