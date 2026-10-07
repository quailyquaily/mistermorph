function currentWindow() {
  return typeof window === "undefined" ? null : window;
}

let frontendReadyReported = false;
const DESKTOP_LOG_MESSAGE_PREFIX = "mistermorph:desktop-log:";

function desktopMessageSender() {
  const win = currentWindow();
  if (!win) {
    return null;
  }

  const chromePostMessage = win.chrome?.webview?.postMessage;
  if (typeof chromePostMessage === "function") {
    return (message) => chromePostMessage.call(win.chrome.webview, message);
  }

  const webkitPostMessage = win.webkit?.messageHandlers?.external?.postMessage;
  if (typeof webkitPostMessage === "function") {
    return (message) => webkitPostMessage.call(win.webkit.messageHandlers.external, message);
  }

  const wailsInvoke = win._wails?.invoke || win.wails?.invoke;
  if (typeof wailsInvoke === "function") {
    return (message) => wailsInvoke(message);
  }

  return null;
}

function desktopCallByName() {
  const win = currentWindow();
  const byName = win?.wails?.Call?.ByName || win?._wails?.Call?.ByName;
  return typeof byName === "function" ? byName.bind(win.wails?.Call || win._wails?.Call) : null;
}

function desktopBindingName(method) {
  const win = currentWindow();
  const bindings = win?.__MISTERMORPH_DESKTOP_BINDINGS__;
  const name = bindings && typeof bindings === "object" ? bindings[method] : "";
  return typeof name === "string" && name.trim() ? name.trim() : `main.App.${method}`;
}

export function isDesktopRuntime() {
  if (currentWindow()?.__MISTERMORPH_DESKTOP_RUNTIME__ === true) {
    return true;
  }
  return desktopMessageSender() !== null || desktopCallByName() !== null;
}

export function canPostDesktopRawMessage() {
  return desktopMessageSender() !== null;
}

export function canCheckDesktopUpdate() {
  return desktopCallByName() !== null;
}

export function canUseDesktopNotifications() {
  return desktopCallByName() !== null;
}

export function desktopRuntimeVersion() {
  const version = currentWindow()?.__MISTERMORPH_DESKTOP_VERSION__;
  return typeof version === "string" ? version.trim() : "";
}

export function installDesktopRuntimeMode() {
  if (typeof document === "undefined" || !isDesktopRuntime()) {
    return;
  }
  document.documentElement.dataset.runtime = "desktop";
}

export function reportDesktopFrontendReady() {
  if (frontendReadyReported) {
    return;
  }
  const call = desktopCallByName();
  if (!call) {
    return;
  }
  frontendReadyReported = true;
  Promise.resolve(call(desktopBindingName("ReportFrontendReady"))).catch(() => {
    frontendReadyReported = false;
  });
}

export function postDesktopRawMessage(message) {
  const send = desktopMessageSender();
  if (!send) {
    return false;
  }
  try {
    send(message);
    return true;
  } catch {
    return false;
  }
}

// channel is the release channel to check; null uses the saved setting.
export async function checkDesktopUpdate(channel = null) {
  const call = desktopCallByName();
  if (!call) {
    throw new Error("desktop update binding is unavailable");
  }
  return await call(desktopBindingName("CheckUpdate"), channel);
}

export function canPickDesktopDirectory() {
  return isDesktopRuntime() && desktopCallByName() !== null;
}

// Shows the native folder picker. Resolves to the chosen folder, or "" when the user cancels.
export async function pickDesktopDirectory({ title = "", current = "" } = {}) {
  const call = desktopCallByName();
  if (!call) {
    throw new Error("desktop folder picker is unavailable");
  }
  const picked = await call(desktopBindingName("PickDirectory"), {
    title: String(title || "").trim(),
    current: String(current || "").trim(),
  });
  return typeof picked === "string" ? picked : "";
}

export async function requestDesktopNotificationPermission() {
  const call = desktopCallByName();
  if (!call) {
    throw new Error("desktop notification binding is unavailable");
  }
  return await call(desktopBindingName("RequestNotificationPermission"));
}

export async function showDesktopNotification(options = {}) {
  const call = desktopCallByName();
  if (!call) {
    throw new Error("desktop notification binding is unavailable");
  }
  return await call(desktopBindingName("ShowNotification"), {
    id: String(options.id || "").trim(),
    title: String(options.title || "").trim(),
    body: String(options.body || "").trim(),
  });
}

export function logDesktopRuntimeEvent(event, fields = {}) {
  const name = typeof event === "string" ? event.trim() : "";
  if (!name) {
    return false;
  }
  const win = currentWindow();
  const body = {
    event: name,
    path: typeof win?.location?.pathname === "string" ? win.location.pathname : "",
    search: typeof win?.location?.search === "string" ? win.location.search : "",
    fields: sanitizeDesktopLogFields(fields),
  };
  try {
    return postDesktopRawMessage(`${DESKTOP_LOG_MESSAGE_PREFIX}${JSON.stringify(body)}`);
  } catch {
    return false;
  }
}

function sanitizeDesktopLogFields(fields) {
  const value = fields && typeof fields === "object" ? fields : {};
  const out = {};
  Object.entries(value).forEach(([key, raw]) => {
    out[key] = sanitizeDesktopLogValue(raw);
  });
  return out;
}

function sanitizeDesktopLogValue(value) {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    return value.length > 240 ? `${value.slice(0, 240)}...(truncated)` : value;
  }
  if (Array.isArray(value)) {
    return { array_len: value.length };
  }
  if (typeof value === "object") {
    const out = {};
    Object.entries(value).forEach(([key, raw]) => {
      out[key] = sanitizeDesktopLogValue(raw);
    });
    return out;
  }
  return String(value);
}
