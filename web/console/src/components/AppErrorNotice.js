import { computed, ref, watch } from "vue";

import { translate } from "../core/context";
import "./AppErrorNotice.css";

// Browser messages for a request that never reached the server.
const NETWORK_ERROR = /failed to fetch|networkerror|network error|load failed|network request failed|err_(internet|network|connection)/i;

export function isNetworkErrorMessage(message) {
  return NETWORK_ERROR.test(String(message || ""));
}

// A page-level error, floating over the top of the page so it never moves the layout. A network
// failure gets a plain-language line; the browser's own message stays in the tooltip. Dismissing
// hides this message only: a different one shows again.
const AppErrorNotice = {
  props: {
    message: { type: String, default: "" },
  },
  setup(props) {
    const t = translate;
    const dismissed = ref("");
    const text = computed(() => String(props.message || "").trim());
    const network = computed(() => isNetworkErrorMessage(text.value));
    const visible = computed(() => text.value !== "" && text.value !== dismissed.value);
    const label = computed(() => (network.value ? t("notice_network_label") : t("notice_error_label")));
    const body = computed(() => (network.value ? t("notice_network_text") : text.value));
    watch(text, (next) => {
      if (next !== dismissed.value) {
        dismissed.value = "";
      }
    });
    function dismiss() {
      dismissed.value = text.value;
    }
    return { t, text, network, visible, label, body, dismiss };
  },
  template: `
    <Transition name="app-error-notice">
      <div v-if="visible" class="app-error-notice" role="alert" :title="network ? text : undefined">
        <span class="app-error-notice-mark" aria-hidden="true"></span>
        <span class="app-error-notice-label">
          <span class="app-error-notice-bracket" aria-hidden="true">[</span>{{ label }}<span class="app-error-notice-bracket" aria-hidden="true">]</span>
        </span>
        <span class="app-error-notice-text">{{ body }}</span>
        <button type="button" class="app-error-notice-close" :title="t('action_close')" :aria-label="t('action_close')" @click="dismiss">
          <PhX class="app-error-notice-close-icon" aria-hidden="true" />
        </button>
      </div>
    </Transition>
  `,
};

export default AppErrorNotice;
