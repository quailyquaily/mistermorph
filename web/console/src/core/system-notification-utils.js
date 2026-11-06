const CLAIM_STORAGE_KEY = "mistermorph_console_notification_ids_v1";
const CLAIM_LIMIT = 64;

// The trigger a notification frame carries when a TODO item's schedule fired the run it tells of.
// The runtime says so from the run's own record. Such a run never raises a Console notification,
// succeeded or failed; a frame without the trigger is shown as before.
export const SCHEDULED_CRON_TRIGGER = "cron";

export function isScheduledCronNotification(raw) {
  return typeof raw?.trigger === "string" && raw.trigger.trim() === SCHEDULED_CRON_TRIGGER;
}

export function normalizeConsoleNotification(raw) {
  if (!raw || typeof raw !== "object" || isScheduledCronNotification(raw)) {
    return null;
  }
  const id = String(raw.id || "").trim();
  const title = String(raw.title || "").trim();
  if (!id || !title) {
    return null;
  }
  return {
    id,
    title,
    body: String(raw.body || "").trim(),
  };
}

export function claimConsoleNotification(storage, id, limit = CLAIM_LIMIT) {
  const notificationID = String(id || "").trim();
  if (!notificationID) {
    return false;
  }
  if (!storage || typeof storage.getItem !== "function" || typeof storage.setItem !== "function") {
    return true;
  }
  try {
    const parsed = JSON.parse(storage.getItem(CLAIM_STORAGE_KEY) || "[]");
    const ids = Array.isArray(parsed) ? parsed.map((item) => String(item || "").trim()).filter(Boolean) : [];
    if (ids.includes(notificationID)) {
      return false;
    }
    ids.push(notificationID);
    const max = Number.isInteger(limit) && limit > 0 ? limit : CLAIM_LIMIT;
    storage.setItem(CLAIM_STORAGE_KEY, JSON.stringify(ids.slice(-max)));
    return true;
  } catch {
    return true;
  }
}

export function resolveBrowserNotificationPermission(win = typeof window === "undefined" ? null : window) {
  if (!win || win.isSecureContext !== true || typeof win.Notification !== "function") {
    return "unsupported";
  }
  const permission = String(win.Notification.permission || "default").trim().toLowerCase();
  return permission === "granted" || permission === "denied" ? permission : "default";
}

export async function requestBrowserNotificationPermission(win = typeof window === "undefined" ? null : window) {
  const current = resolveBrowserNotificationPermission(win);
  if (current !== "default") return current;
  try {
    return await win.Notification.requestPermission();
  } catch {
    return "unsupported";
  }
}
