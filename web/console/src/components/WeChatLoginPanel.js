import { computed, onBeforeUnmount, ref } from "vue";
import QRCode from "qrcode";

import { translate } from "../core/context";
import { openExternalURL } from "../core/external-links";
import "./WeChatLoginPanel.css";

const STATUS_KEYS = {
  wait: "settings_wechat_login_status_wait",
  scaned: "settings_wechat_login_status_scanned",
  need_verifycode: "settings_wechat_login_status_need_code",
  expired: "settings_wechat_login_status_expired",
  verify_code_blocked: "settings_wechat_login_status_code_blocked",
  binded_redirect: "settings_wechat_login_status_already_bound",
  confirmed: "settings_wechat_login_status_confirmed",
};

// WeChat QR login. The server proxies every step and saves the bot token itself, so the token never
// reaches the browser; the browser only draws the QR code from the link WeChat returns.
const WeChatLoginPanel = {
  props: {
    request: { type: Function, required: true },
    endpointRef: { type: String, default: "" },
    configured: Boolean,
    botId: { type: String, default: "" },
    disabled: Boolean,
  },
  emits: ["changed"],
  setup(props, { emit }) {
    const t = translate;
    const sessionID = ref("");
    const qrURL = ref("");
    const qrImage = ref("");
    const status = ref("");
    const verifyCode = ref("");
    const error = ref("");
    const notice = ref("");
    const busy = ref(false);
    const confirmingUnbind = ref(false);
    // Bumped to abandon a login: a poll that returns for an older generation is ignored.
    let generation = 0;
    let unbindTimer = null;

    const statusText = computed(() => t(STATUS_KEYS[status.value] || STATUS_KEYS.wait));
    const needsCode = computed(() => status.value === "need_verifycode");

    function stop() {
      generation += 1;
      sessionID.value = "";
      qrURL.value = "";
      qrImage.value = "";
      status.value = "";
      verifyCode.value = "";
    }

    async function start() {
      if (busy.value || props.disabled) return;
      stop();
      const current = generation;
      busy.value = true;
      error.value = "";
      notice.value = "";
      try {
        const payload = await props.request(props.endpointRef, "/settings/wechat/login/start", { method: "POST" });
        if (current !== generation) return;
        sessionID.value = String(payload?.session_id || "");
        qrURL.value = String(payload?.qr_url || "");
        status.value = "wait";
        qrImage.value = qrURL.value
          ? await QRCode.toDataURL(qrURL.value, { margin: 1, width: 360, errorCorrectionLevel: "M" })
          : "";
        if (current !== generation) return;
        poll(current, "");
      } catch (e) {
        if (current === generation) {
          error.value = e?.message || t("msg_load_failed");
          stop();
        }
      } finally {
        busy.value = false;
      }
    }

    // Each poll is a long poll on the server; the next one starts when it returns.
    async function poll(current, code) {
      while (current === generation && sessionID.value) {
        let payload;
        try {
          payload = await props.request(props.endpointRef, "/settings/wechat/login/poll", {
            method: "POST",
            body: { session_id: sessionID.value, verify_code: code },
          });
        } catch (e) {
          if (current === generation) {
            error.value = e?.message || t("msg_load_failed");
            stop();
          }
          return;
        }
        code = "";
        if (current !== generation) return;
        status.value = String(payload?.status || "wait");
        if (payload?.done !== true) {
          if (needsCode.value) return; // resumes when the code is submitted
          continue;
        }
        if (payload?.connected === true) {
          const scanner = String(payload?.user_id || "").trim();
          notice.value = scanner
            ? t("settings_wechat_login_connected_by", { bot: payload?.bot_id || "", user: scanner })
            : t("settings_wechat_login_connected", { bot: payload?.bot_id || "" });
          stop();
          emit("changed");
        } else {
          error.value = statusText.value;
          stop();
        }
        return;
      }
    }

    function submitCode() {
      const code = verifyCode.value.trim();
      if (!code || !sessionID.value) return;
      status.value = "scaned";
      verifyCode.value = "";
      poll(generation, code);
    }

    function cancel() {
      stop();
      error.value = "";
    }

    function openLink() {
      openExternalURL(qrURL.value);
    }

    async function unbind() {
      if (!confirmingUnbind.value) {
        confirmingUnbind.value = true;
        clearTimeout(unbindTimer);
        unbindTimer = setTimeout(() => {
          confirmingUnbind.value = false;
        }, 4000);
        return;
      }
      clearTimeout(unbindTimer);
      confirmingUnbind.value = false;
      busy.value = true;
      error.value = "";
      notice.value = "";
      try {
        await props.request(props.endpointRef, "/settings/wechat/logout", { method: "POST" });
        emit("changed");
      } catch (e) {
        error.value = e?.message || t("msg_delete_failed");
      } finally {
        busy.value = false;
      }
    }

    onBeforeUnmount(() => {
      generation += 1;
      clearTimeout(unbindTimer);
    });

    return {
      t,
      sessionID,
      qrURL,
      qrImage,
      statusText,
      needsCode,
      verifyCode,
      error,
      notice,
      busy,
      confirmingUnbind,
      start,
      submitCode,
      cancel,
      openLink,
      unbind,
    };
  },
  template: `
    <div class="wechat-login">
      <div v-if="sessionID" class="wechat-login-session">
        <div class="wechat-login-qr">
          <img v-if="qrImage" :src="qrImage" :alt="t('settings_wechat_login_qr_alt')" />
        </div>
        <p class="wechat-login-status" role="status">{{ statusText }}</p>
        <form v-if="needsCode" class="wechat-login-code" @submit.prevent="submitCode">
          <QInput
            :modelValue="verifyCode"
            :placeholder="t('settings_wechat_login_code_placeholder')"
            @update:modelValue="verifyCode = $event"
          />
          <QButton class="primary" type="submit" :disabled="!verifyCode.trim()">{{ t("settings_wechat_login_code_submit") }}</QButton>
        </form>
        <div class="wechat-login-actions">
          <QButton v-if="qrURL" class="plain xs" @click="openLink">{{ t("settings_wechat_login_open_link") }}</QButton>
          <QButton class="plain xs" @click="cancel">{{ t("action_cancel") }}</QButton>
        </div>
      </div>

      <div v-else-if="configured" class="wechat-login-bound">
        <div class="wechat-login-bound-copy">
          <span class="wechat-login-bound-label">{{ t("settings_wechat_login_bound") }}</span>
          <code v-if="botId" class="wechat-login-bound-id">{{ botId }}</code>
        </div>
        <div class="wechat-login-actions">
          <QButton class="plain xs" :loading="busy" :disabled="disabled || busy" @click="start">{{ t("settings_wechat_login_reconnect") }}</QButton>
          <QButton class="danger plain xs" :disabled="disabled || busy" @click="unbind">
            {{ confirmingUnbind ? t("settings_wechat_login_unbind_confirm") : t("settings_wechat_login_unbind") }}
          </QButton>
        </div>
      </div>

      <QButton v-else class="primary wechat-login-start" :loading="busy" :disabled="disabled || busy" @click="start">
        {{ t("settings_wechat_login_connect") }}
      </QButton>

      <p v-if="notice" class="wechat-login-notice" role="status">{{ notice }}</p>
      <p v-if="error" class="wechat-login-error" role="alert">{{ error }}</p>
    </div>
  `,
};

export default WeChatLoginPanel;
