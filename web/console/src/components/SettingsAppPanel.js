import { computed, ref } from "vue";
import "./SettingsAppPanel.css";

import defaultEndpointAvatarURL from "../assets/images/app_logo_current.svg";
import { endpointState, runtimeEndpointByRef, translate } from "../core/context";
import { isDesktopRuntime } from "../core/desktop-runtime";
import { endpointDisplayItem } from "../core/endpoints";
import { isIOSDevice, promptPWAInstall, pwaInstalled, pwaInstallPrompt } from "../core/pwa";

// Installs the console as an app for the selected agent, named after it and with its avatar.
const SettingsAppPanel = {
  setup() {
    const t = translate;
    const installing = ref(false);
    const error = ref("");

    const agent = computed(() => {
      const item = runtimeEndpointByRef(endpointState.selectedRef);
      if (!item) {
        return null;
      }
      return {
        name: String(item.agent_name || "").trim() || endpointDisplayItem(item, t).title,
        image: String(item.avatar_url || "").trim() || defaultEndpointAvatarURL,
      };
    });

    // What the panel can offer: the install button, Safari's steps, or why neither applies.
    const mode = computed(() => {
      if (isDesktopRuntime()) return "desktop";
      if (pwaInstalled.value) return "installed";
      if (pwaInstallPrompt.value) return "prompt";
      if (isIOSDevice()) return "ios";
      if (!window.isSecureContext) return "insecure";
      return "waiting";
    });

    const hint = computed(() => {
      switch (mode.value) {
        case "desktop":
          return t("settings_app_hint_desktop");
        case "installed":
          return t("settings_app_hint_installed");
        case "ios":
          return t("settings_app_hint_ios");
        case "insecure":
          return t("settings_app_hint_insecure");
        case "waiting":
          return t("settings_app_hint_waiting");
        default:
          return t("settings_app_hint_prompt");
      }
    });

    async function install() {
      installing.value = true;
      error.value = "";
      try {
        await promptPWAInstall();
      } catch (e) {
        error.value = e?.message || t("settings_app_install_failed");
      } finally {
        installing.value = false;
      }
    }

    return { t, agent, mode, hint, installing, error, install };
  },
  template: `
    <div class="settings-panel-body settings-panel-body-plain settings-app-panel">
      <AppNotice v-if="error" type="error" :text="error" />
      <AppSection variant="boxed" :title="t('settings_app_title')" :meta="t('settings_section_app_meta')">
        <div class="settings-panel-body">
          <div v-if="agent" class="settings-app-row">
            <img class="settings-app-avatar" :src="agent.image" alt="" />
            <div class="settings-app-copy">
              <strong class="settings-app-name">{{ agent.name }}</strong>
              <p class="settings-app-hint">{{ hint }}</p>
            </div>
            <QButton
              v-if="mode === 'prompt' || mode === 'waiting'"
              class="primary xs settings-app-install"
              :loading="installing"
              :disabled="mode !== 'prompt'"
              @click="install"
            >
              <PhDownloadSimple class="icon" />
              {{ t("settings_app_install") }}
            </QButton>
          </div>
          <p v-else class="settings-app-hint">{{ t("settings_app_no_agent") }}</p>
        </div>
      </AppSection>
    </div>
  `,
};

export default SettingsAppPanel;
