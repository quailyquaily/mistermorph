import { computed, nextTick, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import "./LoginView.css";
import loginLogoUrl from "../assets/images/app_logo.svg";

import {
  apiFetch,
  authState,
  ensureConsoleSession,
  endpointState,
  loadEndpoints,
  localeState,
  translate,
} from "../core/context";
import { endpointRoutePath } from "../core/endpoint-routes";
import { consoleSetupTargetEndpointRef, resolveConsoleSetupStage, setupStagePath } from "../core/setup";

const LoginView = {
  setup() {
    const router = useRouter();
    const route = useRoute();
    const t = translate;
    const lang = computed(() => localeState.lang);
    const password = ref("");
    const busy = ref(false);
    const err = ref("");
    const showPassword = ref(false);
    const capsLock = ref(false);
    const passwordInput = ref(null);
    const host = window.location.host;
    // /login?stay skips the automatic session check and redirect, e.g. to preview this page.
    const stay = computed(() => {
      const value = route.query.stay;
      return value !== undefined && !["0", "false"].includes(String(value).toLowerCase());
    });

    function onPasswordKey(event) {
      capsLock.value = Boolean(event.getModifierState?.("CapsLock"));
    }

    function focusPassword() {
      nextTick(() => passwordInput.value?.focus());
    }

    async function finishLogin() {
      await loadEndpoints();

      const setupState = await resolveConsoleSetupStage(endpointState.items);
      const redirect = typeof route.query.redirect === "string" ? route.query.redirect : "/overview";
      if (setupState.stage !== "ready") {
        const next = { path: setupStagePath(setupState.stage) };
        if (redirect && redirect !== "/overview" && redirect !== "/") {
          next.query = { redirect };
        }
        router.replace(next);
        return;
      }
      const targetRef = consoleSetupTargetEndpointRef(setupState.setup);
      if (redirect && redirect !== "/overview" && redirect !== "/") {
        router.replace(redirect);
        return;
      }
      if (targetRef) {
        router.replace(endpointRoutePath(targetRef, "/chat"));
        return;
      }
      router.replace("/overview");
    }

    async function submit() {
      if (busy.value) {
        return;
      }
      if (!password.value.trim()) {
        err.value = t("login_required_password");
        focusPassword();
        return;
      }
      busy.value = true;
      err.value = "";
      try {
        const body = await apiFetch("/auth/login", {
          method: "POST",
          body: { password: password.value },
          noAuth: true,
        });
        authState.token = body.access_token || "";
        authState.expiresAt = body.expires_at || "";
        authState.account = "console";
        authState.save();
        await finishLogin();
      } catch (e) {
        err.value = e.message || t("login_failed");
        busy.value = false;
        focusPassword();
        return;
      }
      busy.value = false;
    }

    onMounted(async () => {
      if (stay.value) {
        focusPassword();
        return;
      }
      if (busy.value) {
        return;
      }
      busy.value = true;
      err.value = "";
      try {
        const ok = await ensureConsoleSession();
        if (ok) {
          await finishLogin();
        }
      } catch {
      } finally {
        busy.value = false;
      }
      if (!authState.token) focusPassword();
    });

    return {
      t,
      lang,
      password,
      busy,
      err,
      showPassword,
      capsLock,
      passwordInput,
      host,
      onPasswordKey,
      submit,
      onLanguageChange: localeState.applyLanguageChange,
    };
  },
  template: `
    <main class="login-page">
      <section class="login-sheet" aria-labelledby="login-title">
        <header class="login-head">
          <img class="login-logo" src="${loginLogoUrl}" alt="" />
          <div class="login-head-copy">
            <h1 id="login-title" class="login-title">Mister Morph</h1>
            <p class="login-subtitle">{{ t("login_subtitle") }}</p>
          </div>
        </header>

        <form class="login-form" novalidate @submit.prevent="submit">
          <input class="login-username" type="text" name="username" autocomplete="username" value="console" tabindex="-1" aria-hidden="true" readonly />
          <label class="login-label" for="login-password">{{ t("login_password_label") }}</label>
          <div class="login-field" :class="{ 'has-error': err }">
            <input
              id="login-password"
              ref="passwordInput"
              v-model="password"
              class="login-input"
              name="password"
              :type="showPassword ? 'text' : 'password'"
              autocomplete="current-password"
              :placeholder="t('login_password_placeholder')"
              :disabled="busy"
              :aria-invalid="err ? 'true' : 'false'"
              :aria-describedby="err ? 'login-error' : capsLock ? 'login-caps' : undefined"
              @keydown="onPasswordKey"
              @keyup="onPasswordKey"
              @input="err = ''"
            />
            <button type="button" class="login-reveal" :disabled="busy" :aria-pressed="showPassword"
              :aria-label="t(showPassword ? 'login_hide_password' : 'login_show_password')"
              :title="t(showPassword ? 'login_hide_password' : 'login_show_password')"
              @click="showPassword = !showPassword">
              <PhEyeSlash v-if="showPassword" class="icon" />
              <PhEye v-else class="icon" />
            </button>
          </div>
          <div class="login-message-slot">
            <p v-if="err" id="login-error" class="login-message is-error" role="alert">{{ err }}</p>
            <p v-else-if="capsLock" id="login-caps" class="login-message" role="status">{{ t("login_caps_lock") }}</p>
          </div>
          <QButton type="submit" class="primary login-submit" :loading="busy">{{ t("login_button") }}</QButton>
        </form>

        <footer class="login-foot">
          <div class="login-foot-cell">
            <span class="login-foot-label">{{ t("login_host") }}</span>
            <span class="login-foot-value" :title="host">{{ host }}</span>
          </div>
          <div class="login-foot-cell login-language">
            <QLanguageSelector :lang="lang" :presist="true" @change="onLanguageChange" />
          </div>
        </footer>
      </section>
    </main>
  `,
};


export default LoginView;
