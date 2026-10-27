import { computed, onBeforeUnmount, ref, watch } from "vue";

import { runtimeEndpointByRef, translate } from "../core/context";
import { isDesktopRuntime } from "../core/desktop-runtime";
import { endpointURLInsecure } from "../core/endpoints";
import "./ChatQuestionCard.css";
import "./ChatElevationCard.css";

// An elevated command asking for the sudo password (docs/feat/feat_20261026_elevation_client_approval.md).
// While it is open, the password goes to the runtime as typed, so it is only as safe as the
// connection: the card warns when the page or the endpoint is reached without encryption. The
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
    // Unencrypted on either hop: this page over plain HTTP (the desktop app talks to its own
    // runtime), or the Console reaching the endpoint over plain HTTP to another machine. The
    // runtime decides for itself; this only tells the person beforehand.
    const insecure = computed(() => {
      if (!isDesktopRuntime() && typeof window !== "undefined" && window.isSecureContext === false) return true;
      return endpointURLInsecure(runtimeEndpointByRef(props.endpointRef)?.url);
    });
    const denied = computed(() => insecure.value && props.elevation?.insecure === "deny");
    const fieldVisible = computed(() => open.value && !denied.value);
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
      const password = input.value;
      clearPassword();
      send({ password });
    }

    function decline() {
      clearPassword();
      send({ decline: true });
    }

    return {
      allow,
      busy,
      decline,
      denied,
      error,
      insecure,
      open,
      outcomeText,
      passwordInput,
      remaining,
      remainingText,
      retry,
      status,
      t: translate,
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

        <template v-if="denied">
          <span class="chat-question-key is-reply"><span class="chat-question-label">{{ t('chat_elevation_password') }}</span></span>
          <div class="chat-question-value chat-question-reply">
            <p class="chat-elevation-note is-alert">{{ t('chat_elevation_insecure_deny') }}</p>
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
