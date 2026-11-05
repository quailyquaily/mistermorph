import { endpointRoutePath } from "./endpoint-routes.js";
import { CONSOLE_LOCAL_ENDPOINT_REF } from "./endpoints.js";
import { resolveBrowserNotificationPermission } from "./system-notification-utils.js";

const PREFIX = "mistermorph_topic_notifications_v1:";

export function topicNotificationPermission(win = typeof window === "undefined" ? null : window) {
  if (!win?.navigator?.locks?.request || !win.navigator.locks.query) {
    return "unsupported";
  }
  return resolveBrowserNotificationPermission(win);
}

function isForeground(win) {
  return win.document.visibilityState === "visible" && win.document.hasFocus();
}

// A shared lock marks every foreground Console tab. It is released on blur, hide,
// or tab closure, so another tab need not guess whether a stored heartbeat is stale.
export function trackNotificationForeground(win, scope) {
  if (topicNotificationPermission(win) === "unsupported") {
    return () => {};
  }
  let controller;
  let release;
  function update() {
    if (!isForeground(win)) {
      controller?.abort();
      controller = null;
      release?.();
      release = null;
      return;
    }
    if (controller) return;
    controller = new AbortController();
    const signal = controller.signal;
    void win.navigator.locks.request(`${PREFIX}${scope}:foreground`, { mode: "shared", signal }, () => {
      if (signal.aborted || !isForeground(win)) return;
      return new Promise((resolve) => { release = resolve; });
    }).catch(() => {});
  }
  win.addEventListener("focus", update);
  win.addEventListener("blur", update);
  win.document.addEventListener("visibilitychange", update);
  update();
  return () => {
    win.removeEventListener("focus", update);
    win.removeEventListener("blur", update);
    win.document.removeEventListener("visibilitychange", update);
    controller?.abort();
    release?.();
  };
}

export async function handleTopicTaskNotification(raw, { win, scope, translate, navigate, isCurrent = () => true }) {
  if (raw?.type !== "topic_task_completed" ||
      typeof raw.id !== "string" || !raw.id.trim() ||
      typeof raw.topic_id !== "string" || !raw.topic_id.trim() ||
      !["done", "failed"].includes(raw.status) ||
      topicNotificationPermission(win) === "unsupported") {
    return false;
  }
  const foregroundAtArrival = isForeground(win);
  const prefix = `${PREFIX}${scope}:`;
  try {
    // Persist before displaying, under the same exclusive lock in every tab.
    // Keep consumed IDs across reloads, including events suppressed in foreground.
    return await win.navigator.locks.request(`${prefix}claim`, async () => {
      if (!isCurrent()) return false;
      const key = `${prefix}task:${raw.id}`;
      if (win.localStorage.getItem(key) !== null) return false;
      win.localStorage.setItem(key, "1");
      if (foregroundAtArrival || isForeground(win) || topicNotificationPermission(win) !== "granted") return false;
      const { held } = await win.navigator.locks.query();
      if (held.some((lock) => lock.name === `${prefix}foreground`) || !isCurrent() || isForeground(win)) return false;
      const topicID = raw.topic_id.trim();
      const notification = new win.Notification(translate("topic_notification_title", { topic: topicID }), {
        body: translate(`status_${raw.status}`),
        tag: `${prefix}${raw.id}`,
      });
      notification.onclick = () => {
        win.focus();
        notification.close();
        void navigate(endpointRoutePath(CONSOLE_LOCAL_ENDPOINT_REF, `/chat/${encodeURIComponent(topicID)}`));
      };
      return true;
    });
  } catch {
    // Missing locks, blocked storage, or a rejected Notification must be a no-op.
    return false;
  }
}
