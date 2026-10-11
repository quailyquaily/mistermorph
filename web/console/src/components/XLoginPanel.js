import { onBeforeUnmount, ref } from "vue";

import { translate } from "../core/context";
import { openExternalURL } from "../core/external-links";
import "./WeChatLoginPanel.css";

// X login over OAuth. The server starts the login, listens for X's redirect and saves the token
// itself, so no token reaches the browser; the browser only opens X's authorization page.
const XLoginPanel = {
  props: {
    request: { type: Function, required: true },
    endpointRef: { type: String, default: "" },
    loggedIn: Boolean,
    username: { type: String, default: "" },
    // The X app's client ID must be saved before a login can start.
    ready: Boolean,
    disabled: Boolean,
  },
  emits: ["changed"],
  setup(props, { emit }) {
    const t = translate;
    const sessionID = ref("");
    const authorizeURL = ref("");
    const error = ref("");
    const notice = ref("");
    const busy = ref(false);
    const confirmingLogout = ref(false);
    // Bumped to abandon a login: a poll that returns for an older generation is ignored.
    let generation = 0;
    let logoutTimer = null;

    function stop() {
      generation += 1;
      sessionID.value = "";
      authorizeURL.value = "";
    }

    async function start() {
      if (busy.value || props.disabled || !props.ready) return;
      stop();
      const current = generation;
      busy.value = true;
      error.value = "";
      notice.value = "";
      try {
        const payload = await props.request(props.endpointRef, "/settings/x/login/start", { method: "POST" });
        if (current !== generation) return;
        sessionID.value = String(payload?.session_id || "");
        authorizeURL.value = String(payload?.authorize_url || "");
        if (authorizeURL.value) openExternalURL(authorizeURL.value);
        poll(current);
      } catch (e) {
        if (current === generation) {
          error.value = e?.message || t("msg_load_failed");
          stop();
        }
      } finally {
        busy.value = false;
      }
    }

    // Each poll waits on the server; the next one starts when it returns.
    async function poll(current) {
      while (current === generation && sessionID.value) {
        let payload;
        try {
          payload = await props.request(props.endpointRef, "/settings/x/login/poll", {
            method: "POST",
            body: { session_id: sessionID.value },
          });
        } catch (e) {
          if (current === generation) {
            error.value = e?.message || t("msg_load_failed");
            stop();
          }
          return;
        }
        if (current !== generation) return;
        if (payload?.done !== true) continue;
        if (payload?.connected === true) {
          notice.value = t("settings_x_login_connected", { username: payload?.username || "" });
          stop();
          emit("changed");
        } else {
          error.value = String(payload?.error || t("msg_load_failed"));
          stop();
        }
        return;
      }
    }

    function cancel() {
      stop();
      error.value = "";
    }

    function openLink() {
      openExternalURL(authorizeURL.value);
    }

    async function logout() {
      if (!confirmingLogout.value) {
        confirmingLogout.value = true;
        clearTimeout(logoutTimer);
        logoutTimer = setTimeout(() => {
          confirmingLogout.value = false;
        }, 4000);
        return;
      }
      clearTimeout(logoutTimer);
      confirmingLogout.value = false;
      busy.value = true;
      error.value = "";
      notice.value = "";
      try {
        await props.request(props.endpointRef, "/settings/x/logout", { method: "POST" });
        emit("changed");
      } catch (e) {
        error.value = e?.message || t("msg_delete_failed");
      } finally {
        busy.value = false;
      }
    }

    onBeforeUnmount(() => {
      generation += 1;
      clearTimeout(logoutTimer);
    });

    return { t, sessionID, authorizeURL, error, notice, busy, confirmingLogout, start, cancel, openLink, logout };
  },
  template: `
    <div class="wechat-login">
      <div v-if="sessionID" class="wechat-login-session">
        <p class="wechat-login-status" role="status">{{ t("settings_x_login_waiting") }}</p>
        <div class="wechat-login-actions">
          <QButton v-if="authorizeURL" class="plain xs" @click="openLink">{{ t("settings_x_login_open_again") }}</QButton>
          <QButton class="plain xs" @click="cancel">{{ t("action_cancel") }}</QButton>
        </div>
      </div>

      <div v-else-if="loggedIn" class="wechat-login-bound">
        <div class="wechat-login-bound-copy">
          <span class="wechat-login-bound-label">{{ t("settings_x_login_bound") }}</span>
          <code v-if="username" class="wechat-login-bound-id">@{{ username }}</code>
        </div>
        <div class="wechat-login-actions">
          <QButton class="plain xs" :loading="busy" :disabled="disabled || busy || !ready" @click="start">{{ t("settings_x_login_again") }}</QButton>
          <QButton class="danger plain xs" :disabled="disabled || busy" @click="logout">
            {{ confirmingLogout ? t("settings_x_logout_confirm") : t("settings_x_logout") }}
          </QButton>
        </div>
      </div>

      <QButton v-else class="primary wechat-login-start" :loading="busy" :disabled="disabled || busy || !ready" @click="start">
        {{ t("settings_x_login") }}
      </QButton>

      <p v-if="!ready && !sessionID" class="wechat-login-status">{{ t("settings_x_login_needs_client_id") }}</p>
      <p v-if="notice" class="wechat-login-notice" role="status">{{ notice }}</p>
      <p v-if="error" class="wechat-login-error" role="alert">{{ error }}</p>
    </div>
  `,
};

export default XLoginPanel;
