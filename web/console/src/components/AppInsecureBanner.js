import { computed, ref } from "vue";

import { endpointState, runtimeEndpointByRef, translate } from "../core/context";
import { isDesktopRuntime } from "../core/desktop-runtime";
import { insecureHops } from "../core/endpoints";
import "./AppNotice.css";
import "./AppInsecureBanner.css";

// What the person closed, by which hops were unencrypted, for as long as the page is loaded: kept
// outside the component, so it stays closed when the layout swaps (login page to workspace).
const dismissedKey = ref("");

// A line across the top of the window while what the person sends, such as a sudo password on an
// approval card or the Console password, crosses the network unencrypted
// (docs/feat/feat_20261026_elevation_client_approval.md). It says which hop: the page itself, or the
// Console's hop to the selected endpoint or the endpoint its chat submits to. The runtime does not
// check, so this is the only warning: closing it lasts until the page reloads, and it comes back
// when a different hop turns unencrypted, such as another endpoint. It shows the short message,
// with the full one, which names the SSH tunnel and VPN exceptions, as its tooltip; on a phone it
// drops the label too.
const AppInsecureBanner = {
  setup() {
    const t = translate;
    const hops = computed(() => {
      const desktop = isDesktopRuntime();
      const secureContext = typeof window === "undefined" || window.isSecureContext !== false;
      const selected = runtimeEndpointByRef(endpointState.selectedRef);
      const submit = runtimeEndpointByRef(String(selected?.submit_endpoint_ref || ""));
      return insecureHops({ desktop, secureContext, endpointURLs: [selected?.url, submit?.url] });
    });
    const kind = computed(() => {
      const { page, endpoint } = hops.value;
      if (page && endpoint) return "both";
      if (page) return "page";
      return endpoint ? "endpoint" : "";
    });
    const key = computed(() => (kind.value ? `${kind.value}|${hops.value.endpoint}` : ""));
    const visible = computed(() => key.value !== "" && key.value !== dismissedKey.value);
    const text = computed(() => t(`connection_insecure_${kind.value}`, { host: hops.value.endpoint }));
    const shortText = computed(() => t(`connection_insecure_${kind.value}_short`, { host: hops.value.endpoint }));
    function dismiss() {
      dismissedKey.value = key.value;
    }
    return { t, visible, text, shortText, dismiss };
  },
  template: `
    <div v-if="visible" class="app-notice is-warning is-dismissible app-insecure-banner" role="alert">
      <span class="app-notice-label">
        <span class="app-notice-bracket" aria-hidden="true">[</span>{{ t('connection_insecure_label') }}<span class="app-notice-bracket" aria-hidden="true">]</span>
      </span>
      <span class="app-insecure-banner-value">
        <span class="app-notice-mark" aria-hidden="true"></span>
        <span class="app-notice-text app-insecure-banner-text" :title="text">{{ shortText }}</span>
      </span>
      <button
        type="button"
        class="app-notice-close"
        :title="t('action_close')"
        :aria-label="t('action_close')"
        @click="dismiss"
      >
        <PhX class="app-notice-close-icon" aria-hidden="true" />
      </button>
    </div>
  `,
};

export default AppInsecureBanner;
