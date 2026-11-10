// The Vue console's desktop bridge (Wails bindings), now the `morph.desktop.*` host functions of
// lib/platform.ts. The names stay so the logic copied from the Vue console keeps its calls.
import {
  checkDesktopUpdate as hostCheckDesktopUpdate,
  desktopVersion,
  hasFeature,
  isDesktop,
  pickDirectory,
  reportFrontendReady,
} from "../platform";

export function isDesktopRuntime() {
  return isDesktop();
}

export function canPostDesktopRawMessage() {
  return false;
}

export function canCheckDesktopUpdate() {
  return isDesktop() && hasFeature("checkUpdate");
}

export function desktopRuntimeVersion() {
  return desktopVersion();
}

export function installDesktopRuntimeMode() {}

export function reportDesktopFrontendReady() {
  reportFrontendReady();
}

export function postDesktopRawMessage() {
  return false;
}

// channel is the release channel to check; null uses the saved setting.
export async function checkDesktopUpdate(channel = null) {
  return await hostCheckDesktopUpdate(channel);
}

export function canPickDesktopDirectory() {
  return isDesktop() && hasFeature("pickDirectory");
}

// Shows the native folder picker. Resolves to the chosen folder, or "" when the user cancels.
export async function pickDesktopDirectory({ title = "", current = "" } = {}) {
  return await pickDirectory({ title: String(title || "").trim(), current: String(current || "").trim() });
}

export function logDesktopRuntimeEvent() {
  return false;
}
