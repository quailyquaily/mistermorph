import { createApp, watch } from "vue";
import { applyTheme, closePopupMenu } from "./components/ui/popup";
import "./styles/ui-kit.css";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/400-italic.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./styles/base.css";

import AppLayout from "./layouts/AppLayout";
import { dismissBootSplash } from "./components/BootSplash";
import * as quailComponents from "./components/quail";
import AppNotice from "./components/AppNotice";
import AppSection from "./components/AppSection";
import { installChatBubbleTail } from "./core/chat-bubble-tail";
import { installDialogOrigin } from "./core/dialog-origin";
import { installTooltips } from "./core/tooltips";
import { vFadeTruncate } from "./core/fade-truncate";
import { vScrollEdges } from "./core/scroll-edges";
import { vSlidingSelection } from "./core/sliding-selection";
import { authState, endpointState, localeState } from "./core/context";
import { currentLocale } from "./i18n";
import { installDesktopRuntimeMode, reportDesktopFrontendReady } from "./core/desktop-runtime";
import { installExternalLinkHandler } from "./core/external-links";
import { installConsolePerformanceObservers } from "./core/performance";
import { installMacOS26Mode } from "./core/platform";
import { installPWA } from "./core/pwa";
import { installSystemNotifications } from "./core/system-notifications";
import { phosphorIcons } from "./icons/phosphor";
import { router } from "./router";
import { pinia } from "./stores/pinia";

localeState.hydrateLanguage();
// Screen readers, hyphenation and the browser's translate offer read the page language.
watch(
  () => localeState.lang,
  () => {
    document.documentElement.lang = currentLocale();
  },
  { immediate: true }
);
authState.hydrate();
endpointState.hydrateEndpointSelection();
installDesktopRuntimeMode();
installExternalLinkHandler();
installConsolePerformanceObservers();
installSystemNotifications();
installChatBubbleTail();
installTooltips();
installDialogOrigin();
installPWA();
const platformModeReady = installMacOS26Mode();

const app = createApp(AppLayout);
if (import.meta.env.DEV === true) {
  app.config.performance = true;
}
app.use(pinia);
app.use(router);
for (const [name, component] of Object.entries({ ...quailComponents, ...phosphorIcons })) {
  app.component(name, component);
}
app.component("AppNotice", AppNotice);
app.directive("sliding-selection", vSlidingSelection);
app.directive("scroll-edges", vScrollEdges);
app.directive("fade-truncate", vFadeTruncate);
app.component("AppSection", AppSection);
// Preserve the full plugin's outside-click behavior without registering it.
if (!window.__quailui_click_handler_installed) {
  document.body.addEventListener("click", closePopupMenu);
  window.__quailui_click_handler_installed = true;
}
applyTheme("morph", false);

async function boot() {
  await Promise.all([router.isReady(), platformModeReady]);
  app.mount("#app");
  const bootOverlay = document.getElementById("boot-overlay");
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      void dismissBootSplash(bootOverlay).finally(() => {
        reportDesktopFrontendReady();
      });
    });
  });
}

void boot();
