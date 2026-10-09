import { ref, shallowRef, watch } from "vue";

import { API_BASE, endpointState } from "./context";

// The console installs as a web app per agent. The page's manifest follows the selected agent, so
// the browser's install offers that agent's name and avatar; the server builds each manifest.

// The browser's install offer for the current manifest, kept until the app installs or the
// manifest changes.
const pwaInstallPrompt = shallowRef(null);
const pwaInstalled = ref(false);

let installed = false;

function pwaManifestURL(endpointRef) {
  const ref = String(endpointRef || "").trim();
  return ref ? `${API_BASE}/pwa/manifest.webmanifest?agent=${encodeURIComponent(ref)}` : "";
}

function pwaIconURL(endpointRef, size) {
  const ref = String(endpointRef || "").trim();
  return ref ? `${API_BASE}/pwa/icon?agent=${encodeURIComponent(ref)}&size=${size}` : "";
}

function isStandaloneDisplay() {
  try {
    return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  } catch {
    return false;
  }
}

// iOS has no install prompt; apps are added from Safari's share sheet.
function isIOSDevice() {
  const nav = window.navigator;
  return /iPad|iPhone|iPod/.test(nav.userAgent || "") || (nav.platform === "MacIntel" && nav.maxTouchPoints > 1);
}

function setHeadLink(rel, href) {
  let link = document.head.querySelector(`link[rel="${rel}"]`);
  if (!link) {
    link = document.createElement("link");
    link.rel = rel;
    document.head.appendChild(link);
  }
  if (link.getAttribute("href") !== href) {
    link.setAttribute("href", href);
    return true;
  }
  return false;
}

function setHeadMeta(name, content) {
  let meta = document.head.querySelector(`meta[name="${name}"]`);
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = name;
    document.head.appendChild(meta);
  }
  meta.setAttribute("content", content);
}

function agentName(endpointRef) {
  const item = endpointState.items.find((entry) => entry?.endpoint_ref === endpointRef);
  return String(item?.agent_name || item?.name || "").trim();
}

function syncManifest() {
  const ref = String(endpointState.selectedRef || "").trim();
  const manifestURL = pwaManifestURL(ref);
  if (!manifestURL) {
    return;
  }
  if (setHeadLink("manifest", manifestURL)) {
    // The offer was for the previous agent's manifest; the browser offers again for this one.
    pwaInstallPrompt.value = null;
  }
  setHeadLink("apple-touch-icon", pwaIconURL(ref, 180));
  const name = agentName(ref);
  if (name) {
    setHeadMeta("apple-mobile-web-app-title", name);
  }
}

function installPWA() {
  if (installed || typeof window === "undefined") {
    return;
  }
  installed = true;
  pwaInstalled.value = isStandaloneDisplay();
  window.addEventListener("beforeinstallprompt", (event) => {
    // Keep the offer for the settings button instead of the browser's own banner.
    event.preventDefault();
    pwaInstallPrompt.value = event;
  });
  window.addEventListener("appinstalled", () => {
    pwaInstallPrompt.value = null;
    pwaInstalled.value = true;
  });
  watch(
    () => [endpointState.selectedRef, agentName(endpointState.selectedRef)],
    syncManifest,
    { immediate: true }
  );
}

// Shows the browser's install dialog. Resolves to "accepted", "dismissed", or "" when the browser
// has nothing to offer.
async function promptPWAInstall() {
  const event = pwaInstallPrompt.value;
  if (!event) {
    return "";
  }
  pwaInstallPrompt.value = null;
  await event.prompt();
  const choice = await event.userChoice;
  return String(choice?.outcome || "");
}

export {
  installPWA,
  isIOSDevice,
  isStandaloneDisplay,
  promptPWAInstall,
  pwaIconURL,
  pwaInstalled,
  pwaInstallPrompt,
  pwaManifestURL,
};
