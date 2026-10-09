import { computed } from "vue";

import { translate } from "../core/context";
import { isNetworkErrorMessage, normalizeNoticeType } from "../core/notices";
import "./AppNotice.css";

const LABEL_KEYS = {
  error: "notice_error_label",
  warning: "notice_warning_label",
  info: "notice_info_label",
  success: "notice_success_label",
};

// A status line in the console's own terms: a square mark and a mono bracket label in the type's
// colour, then the message. Inline it sits in the flow, in place of Quail's QFence; floating it is
// one entry of the notice stack (AppNoticeHost). A network failure gets a plain-language line, with
// the browser's message kept in the tooltip.
const AppNotice = {
  props: {
    // error | warning | info | success ("danger" reads as error).
    type: { type: String, default: "info" },
    text: { type: String, default: "" },
    // Replaces the type's own label.
    label: { type: String, default: "" },
    floating: { type: Boolean, default: false },
    dismissible: { type: Boolean, default: false },
  },
  emits: ["dismiss"],
  setup(props) {
    const t = translate;
    const kind = computed(() => normalizeNoticeType(props.type));
    const message = computed(() => String(props.text || "").trim());
    const network = computed(() => kind.value === "error" && isNetworkErrorMessage(message.value));
    const labelText = computed(() => {
      if (props.label) return props.label;
      if (network.value) return t("notice_network_label");
      return t(LABEL_KEYS[kind.value]);
    });
    const body = computed(() => (network.value ? t("notice_network_text") : message.value));
    const role = computed(() => (kind.value === "error" || kind.value === "warning" ? "alert" : "status"));
    return { t, kind, message, network, labelText, body, role };
  },
  template: `
    <div
      :class="['app-notice', 'is-' + kind, { 'is-floating': floating, 'is-dismissible': dismissible }]"
      :role="role"
      :title="network ? message : undefined"
    >
      <span class="app-notice-mark" aria-hidden="true"></span>
      <span class="app-notice-label">
        <span class="app-notice-bracket" aria-hidden="true">[</span>{{ labelText }}<span class="app-notice-bracket" aria-hidden="true">]</span>
      </span>
      <span class="app-notice-text">{{ body }}</span>
      <button
        v-if="dismissible"
        type="button"
        class="app-notice-close"
        :title="t('action_close')"
        :aria-label="t('action_close')"
        @click="$emit('dismiss')"
      >
        <PhX class="app-notice-close-icon" aria-hidden="true" />
      </button>
    </div>
  `,
};

export default AppNotice;
