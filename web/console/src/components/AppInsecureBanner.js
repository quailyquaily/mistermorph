import { computed } from "vue";

import { endpointState, runtimeEndpointByRef, translate } from "../core/context";
import { isDesktopRuntime } from "../core/desktop-runtime";
import { connectionInsecure } from "../core/endpoints";
import "./AppNotice.css";
import "./AppInsecureBanner.css";

// A line across the top of the window while what the person sends, such as a sudo password on an
// approval card or the Console password, crosses the network unencrypted
// (docs/feat/feat_20261026_elevation_client_approval.md). It checks the page and the selected
// endpoint, with the endpoint its chat submits to. It cannot be dismissed: the runtime does not
// check, so this is the only warning.
const AppInsecureBanner = {
  setup() {
    const t = translate;
    const insecure = computed(() => {
      const desktop = isDesktopRuntime();
      const secureContext = typeof window === "undefined" || window.isSecureContext !== false;
      const selected = runtimeEndpointByRef(endpointState.selectedRef);
      const submit = runtimeEndpointByRef(String(selected?.submit_endpoint_ref || ""));
      return connectionInsecure({ desktop, secureContext, endpointURLs: [selected?.url, submit?.url] });
    });
    return { t, insecure };
  },
  template: `
    <div v-if="insecure" class="app-notice is-warning app-insecure-banner" role="alert">
      <span class="app-notice-label">
        <span class="app-notice-bracket" aria-hidden="true">[</span>{{ t('connection_insecure_label') }}<span class="app-notice-bracket" aria-hidden="true">]</span>
      </span>
      <span class="app-insecure-banner-value">
        <span class="app-notice-mark" aria-hidden="true"></span>
        <span class="app-notice-text">{{ t('connection_insecure_warn') }}</span>
      </span>
    </div>
  `,
};

export default AppInsecureBanner;
