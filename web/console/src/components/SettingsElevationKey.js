import { computed, ref, watch } from "vue";

import { endpointState, runtimeApiFetchForEndpoint, runtimeEndpointByRef, translate } from "../core/context";
import { forgetElevationIdentity, pinElevationIdentity, pinnedElevationIdentity } from "../core/elevation-pins";
import { elevationFingerprint } from "../core/elevation-seal";

// The identity key of the runtime chat tasks go to, which approval cards seal sudo passwords for
// (docs/feat/feat_20261026_elevation_client_approval.md): its fingerprint, to compare with the one
// mistermorph console logs at start, and whether this browser trusts it.
const SettingsElevationKey = {
  setup() {
    const identity = ref("");
    const unavailable = ref(false);
    // Bumped when this panel changes the pin, so the state is read again.
    const pinVersion = ref(0);

    // The endpoint chat tasks go to, as the chat picks it; approval cards pin under that name.
    const endpointRef = computed(() => {
      const selected = runtimeEndpointByRef(endpointState.selectedRef);
      if (!selected) {
        return String(endpointState.selectedRef || "").trim();
      }
      return String(selected.submit_endpoint_ref || selected.endpoint_ref || "").trim();
    });
    // Computed here from the key, not taken from the runtime.
    const fingerprint = computed(() => (identity.value ? elevationFingerprint(identity.value) : ""));
    const state = computed(() => {
      void pinVersion.value;
      if (!identity.value) return unavailable.value ? "unavailable" : "loading";
      const pinned = pinnedElevationIdentity(endpointRef.value);
      if (!pinned) return "untrusted";
      return pinned === identity.value ? "trusted" : "changed";
    });
    const stateText = computed(() => {
      switch (state.value) {
        case "trusted":
          return translate("settings_elevation_key_trusted");
        case "untrusted":
          return translate("settings_elevation_key_untrusted");
        case "changed":
          return translate("settings_elevation_key_changed");
        case "unavailable":
          return translate("settings_elevation_key_unavailable");
      }
      return "";
    });

    async function load() {
      identity.value = "";
      unavailable.value = false;
      const ref = endpointRef.value;
      if (!ref) {
        unavailable.value = true;
        return;
      }
      try {
        const info = await runtimeApiFetchForEndpoint(ref, "/elevation/identity");
        const value = String(info?.identity || "").trim();
        if (ref !== endpointRef.value) return;
        if (value && elevationFingerprint(value)) {
          identity.value = value;
        } else {
          unavailable.value = true;
        }
      } catch {
        if (ref === endpointRef.value) unavailable.value = true;
      }
    }

    function trust() {
      if (!identity.value) return;
      pinElevationIdentity(endpointRef.value, identity.value);
      pinVersion.value += 1;
    }

    function forget() {
      forgetElevationIdentity(endpointRef.value);
      pinVersion.value += 1;
    }

    watch(endpointRef, load, { immediate: true });

    return { fingerprint, forget, state, stateText, t: translate, trust };
  },
  template: `
    <div class="settings-console-row settings-elevation-key">
      <div class="settings-card-copy">
        <h4 class="settings-card-title">{{ t("settings_elevation_key_title") }}</h4>
        <p class="settings-card-note">{{ t("settings_elevation_key_hint") }}</p>
        <p v-if="fingerprint" class="settings-elevation-fingerprint">{{ fingerprint }}</p>
        <p v-if="stateText" :class="['settings-card-note', { 'is-alert': state === 'changed' }]" role="status">{{ stateText }}</p>
      </div>
      <QButton v-if="state === 'trusted' || state === 'changed'" class="outlined settings-console-control" @click="forget">
        {{ t("settings_elevation_key_forget") }}
      </QButton>
      <QButton v-else-if="state === 'untrusted'" class="outlined settings-console-control" @click="trust">
        {{ t("settings_elevation_key_trust") }}
      </QButton>
    </div>
  `,
};

export default SettingsElevationKey;
