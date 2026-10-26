import { computed, onBeforeUnmount, ref, watch } from "vue";

import { translate } from "../core/context";
import { isDesktopRuntime } from "../core/desktop-runtime";
import { pinElevationIdentity, pinnedElevationIdentity } from "../core/elevation-pins";
import { elevationFingerprint, sealElevationPassword, verifyElevationOffer } from "../core/elevation-seal";
import "./ChatQuestionCard.css";
import "./ChatElevationCard.css";

// An elevated command asking for the sudo password (docs/feat/feat_20261026_elevation_client_approval.md).
// While it is open, the password is sealed here for the runtime that signed the request, against
// the identity this browser pinned for the endpoint, and only the ciphertext leaves the page. The
// password lives in the field alone, never in component state, and the field is cleared once sent.
// Once closed, the card keeps the command and how it ended.
const ChatElevationCard = {
  props: {
    elevation: { type: Object, required: true },
    taskId: { type: String, default: "" },
    endpointRef: { type: String, default: "" },
    // The task still runs: an open request of an ended task got no answer.
    live: { type: Boolean, default: false },
  },
  emits: ["answer"],
  setup(props, { emit }) {
    const passwordInput = ref(null);
    const busy = ref(false);
    const error = ref("");
    const trustConfirm = ref(false);
    // The pin as this card last read it; bumped by trusting a new key.
    const pinned = ref(pinnedElevationIdentity(props.endpointRef));
    // The pin was empty when the card opened: show the fingerprint the request pins.
    const firstUse = ref(pinned.value === "");
    const now = ref(Date.now());
    let timer = 0;

    const status = computed(() => {
      const value = String(props.elevation?.status || "");
      if (value === "open" && !props.live) return "expired";
      return ["open", "allowed", "declined", "expired", "rejected"].includes(value) ? value : "expired";
    });
    const open = computed(() => status.value === "open");
    const remaining = computed(() => Math.max(0, Math.floor(Number(props.elevation?.deadline || 0) - now.value / 1000)));
    const remainingText = computed(() => {
      const seconds = remaining.value;
      return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
    });
    const binding = computed(() => ({
      elevationID: props.elevation?.id,
      taskID: props.taskId,
      command: props.elevation?.command,
      cwd: props.elevation?.cwd,
      deadline: props.elevation?.deadline,
    }));
    // The offer checked against the pin: ok, changed (another identity than the pinned one) or bad.
    const offerCheck = computed(() => {
      if (!open.value) return { state: "closed" };
      const offer = props.elevation?.offer;
      const offered = elevationFingerprint(String(offer?.identity || ""));
      try {
        verifyElevationOffer(binding.value, offer, pinned.value);
        return { state: "ok", fingerprint: offered };
      } catch (e) {
        if (e?.code === "identity_changed") {
          return { state: "changed", fingerprint: offered, pinnedFingerprint: elevationFingerprint(pinned.value) };
        }
        return { state: "bad" };
      }
    });
    // A page from plain HTTP could have been changed on the way; the desktop app loads its own.
    const insecure = computed(
      () => !isDesktopRuntime() && typeof window !== "undefined" && window.isSecureContext === false
    );
    const denied = computed(() => insecure.value && props.elevation?.webInsecure === "deny");
    const fieldVisible = computed(() => open.value && offerCheck.value.state === "ok" && !denied.value);
    const retry = computed(() => Number(props.elevation?.attempt || 0) >= 2);
    const outcomeText = computed(() => translate(`chat_elevation_${status.value}`));

    function stopTimer() {
      if (timer) {
        window.clearInterval(timer);
        timer = 0;
      }
    }

    watch(
      open,
      (value) => {
        stopTimer();
        if (value && typeof window !== "undefined") {
          now.value = Date.now();
          timer = window.setInterval(() => {
            now.value = Date.now();
          }, 1000);
        } else {
          busy.value = false;
          clearPassword();
        }
      },
      { immediate: true }
    );
    watch(
      () => props.elevation?.id,
      () => {
        busy.value = false;
        error.value = "";
        trustConfirm.value = false;
        clearPassword();
      }
    );
    onBeforeUnmount(() => {
      stopTimer();
      clearPassword();
    });

    function clearPassword() {
      if (passwordInput.value) passwordInput.value.value = "";
    }

    // done reports whether the answer was taken; a closed request cannot take one.
    function send(answer) {
      if (!open.value || busy.value) return;
      busy.value = true;
      error.value = "";
      emit("answer", {
        elevationID: props.elevation.id,
        ...answer,
        done(ok, message) {
          busy.value = false;
          if (!ok) error.value = message || translate("chat_elevation_closed");
        },
      });
    }

    function allow() {
      if (!fieldVisible.value || busy.value || remaining.value <= 0) return;
      const input = passwordInput.value;
      if (!input || input.value === "") {
        input?.focus();
        return;
      }
      const password = new TextEncoder().encode(input.value);
      clearPassword();
      const pin = pinnedElevationIdentity(props.endpointRef);
      let answer;
      try {
        // Zeroes the password bytes.
        answer = sealElevationPassword(binding.value, props.elevation.offer, pin, password);
      } catch (e) {
        password.fill(0);
        pinned.value = pin;
        error.value = e?.code === "identity_changed" ? "" : translate("chat_elevation_bad_offer");
        return;
      }
      if (!pin) {
        // Trust on first use: this runtime's later requests must come from the same identity.
        pinElevationIdentity(props.endpointRef, props.elevation.offer.identity);
        pinned.value = pinnedElevationIdentity(props.endpointRef);
      }
      send({ answer });
    }

    function decline() {
      clearPassword();
      send({ decline: true });
    }

    function trustNewKey() {
      if (!trustConfirm.value) {
        trustConfirm.value = true;
        return;
      }
      trustConfirm.value = false;
      pinElevationIdentity(props.endpointRef, props.elevation?.offer?.identity);
      pinned.value = pinnedElevationIdentity(props.endpointRef) || String(props.elevation?.offer?.identity || "");
      firstUse.value = true;
    }

    return {
      allow,
      busy,
      decline,
      denied,
      error,
      fieldVisible,
      firstUse,
      insecure,
      offerCheck,
      open,
      outcomeText,
      passwordInput,
      remaining,
      remainingText,
      retry,
      status,
      t: translate,
      trustConfirm,
      trustNewKey,
    };
  },
  template: `
    <section
      :class="['chat-question', 'chat-elevation', 'is-' + status]"
      role="region"
      :aria-label="t('chat_elevation_title')"
      :aria-busy="busy ? 'true' : null"
    >
      <div v-if="open" class="chat-question-grid">
        <span class="chat-question-key"><span class="chat-question-label">{{ t('chat_elevation_label') }}</span></span>
        <p class="chat-question-value chat-question-text chat-elevation-title">
          <span>{{ t('chat_elevation_title') }}</span>
          <span class="chat-elevation-countdown" role="timer">{{ t('chat_elevation_time_left', { time: remainingText }) }}</span>
        </p>
        <span class="chat-question-key"><span class="chat-question-label">{{ t('chat_elevation_command') }}</span></span>
        <code class="chat-question-value chat-elevation-command">{{ elevation.command }}</code>
        <template v-if="elevation.cwd">
          <span class="chat-question-key"><span class="chat-question-label">{{ t('chat_elevation_cwd') }}</span></span>
          <span class="chat-question-value chat-elevation-path">{{ elevation.cwd }}</span>
        </template>
        <template v-if="elevation.host">
          <span class="chat-question-key"><span class="chat-question-label">{{ t('chat_elevation_host') }}</span></span>
          <span class="chat-question-value chat-elevation-path">{{ elevation.host }}</span>
        </template>
        <p v-if="retry" class="chat-question-value chat-elevation-note is-alert" role="alert">{{ t('chat_elevation_retry') }}</p>

        <template v-if="offerCheck.state === 'changed'">
          <span class="chat-question-key is-reply"><span class="chat-question-label">{{ t('chat_elevation_key') }}</span></span>
          <div class="chat-question-value chat-elevation-key">
            <p class="chat-elevation-note is-alert" role="alert">{{ t('chat_elevation_key_changed') }}</p>
            <dl class="chat-elevation-fingerprints">
              <dt>{{ t('chat_elevation_key_trusted') }}</dt>
              <dd>{{ offerCheck.pinnedFingerprint }}</dd>
              <dt>{{ t('chat_elevation_key_new') }}</dt>
              <dd>{{ offerCheck.fingerprint }}</dd>
            </dl>
            <p v-if="trustConfirm" class="chat-elevation-note">{{ t('chat_elevation_trust_confirm') }}</p>
            <div class="chat-elevation-actions">
              <QButton v-if="trustConfirm" type="button" class="danger xs" :disabled="busy" @click="trustNewKey">
                {{ t('chat_elevation_trust_confirm_action') }}
              </QButton>
              <QButton v-if="trustConfirm" type="button" class="plain xs" @click="trustConfirm = false">
                {{ t('chat_elevation_cancel') }}
              </QButton>
              <QButton v-else type="button" class="outlined xs" :disabled="busy" @click="trustNewKey">
                {{ t('chat_elevation_trust_new') }}
              </QButton>
              <QButton type="button" class="plain xs" :disabled="busy" @click="decline">
                {{ t('chat_elevation_decline') }}
              </QButton>
            </div>
          </div>
        </template>

        <template v-else-if="offerCheck.state === 'bad' || denied">
          <span class="chat-question-key is-reply"><span class="chat-question-label">{{ t('chat_elevation_password') }}</span></span>
          <div class="chat-question-value chat-question-reply">
            <p class="chat-elevation-note is-alert">
              {{ offerCheck.state === 'bad' ? t('chat_elevation_bad_offer') : t('chat_elevation_insecure_deny') }}
            </p>
            <QButton type="button" class="plain xs" :disabled="busy" @click="decline">
              {{ t('chat_elevation_decline') }}
            </QButton>
          </div>
        </template>

        <template v-else>
          <span class="chat-question-key is-reply"><span class="chat-question-label">{{ t('chat_elevation_password') }}</span></span>
          <form class="chat-question-value chat-question-reply" @submit.prevent="allow">
            <input
              ref="passwordInput"
              class="chat-question-input chat-elevation-input"
              type="password"
              name="elevation-password"
              autocomplete="off"
              autocapitalize="off"
              spellcheck="false"
              :placeholder="t('chat_elevation_password_placeholder')"
              :aria-label="t('chat_elevation_password_placeholder')"
              :disabled="busy || remaining <= 0"
              enterkeyhint="send"
            />
            <QButton type="submit" class="primary xs" :disabled="busy || remaining <= 0">
              {{ t('chat_elevation_allow') }}
            </QButton>
            <QButton type="button" class="plain xs" :disabled="busy" @click="decline">
              {{ t('chat_elevation_decline') }}
            </QButton>
          </form>
          <p v-if="insecure" class="chat-question-value chat-elevation-note">{{ t('chat_elevation_insecure_warn') }}</p>
          <p v-if="firstUse && offerCheck.fingerprint" class="chat-question-value chat-elevation-note chat-elevation-first">
            {{ t('chat_elevation_first_key') }}
            <span class="chat-elevation-fingerprint">{{ offerCheck.fingerprint }}</span>
          </p>
        </template>
        <p v-if="error" class="chat-question-value chat-question-error" role="alert">{{ error }}</p>
      </div>
      <dl v-else class="chat-question-grid">
        <div class="chat-question-row">
          <dt class="chat-question-key"><span class="chat-question-label">{{ t('chat_elevation_command') }}</span></dt>
          <dd class="chat-question-value"><code class="chat-elevation-command">{{ elevation.command }}</code></dd>
        </div>
        <div class="chat-question-row">
          <dt class="chat-question-key"><span class="chat-question-label">{{ t('chat_elevation_outcome') }}</span></dt>
          <dd class="chat-question-value chat-elevation-outcome">{{ outcomeText }}</dd>
        </div>
      </dl>
    </section>
  `,
};

export default ChatElevationCard;
