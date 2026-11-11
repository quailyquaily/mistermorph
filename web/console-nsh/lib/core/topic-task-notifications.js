import { endpointRoutePath } from "./endpoint-routes.js";
import { CONSOLE_LOCAL_ENDPOINT_REF } from "./endpoints.js";
import { isScheduledCronNotification } from "./system-notification-utils.js";
import {
  hasFeature,
  hasFocus,
  isVisible,
  localStore,
  notificationPermission,
  onNotificationPress,
  showNotification,
} from "../platform";

const PREFIX = "mistermorph_topic_notifications_v1:";
// How long a notification waits for its topic's name before it goes out without one.
const TOPIC_TITLE_TIMEOUT_MS = 3000;

export async function topicNotificationPermission() {
  return await notificationPermission();
}

function isForeground() {
  return isVisible() && hasFocus();
}

// The Vue console held a shared lock per foreground tab; here the host reports whether this
// window is shown and focused (lib/platform.ts), so there is nothing to track.
export function trackNotificationForeground() {
  return () => {};
}

// The topic's name, as the chat sidebar shows it: that is how a person knows the topic. A name
// that cannot be read, or takes too long, gives the untitled label, never the topic's ID.
async function topicNotificationTitle(topicID, topicTitle, translate) {
  let title = "";
  if (typeof topicTitle === "function") {
    let timer;
    try {
      title = await Promise.race([
        Promise.resolve().then(() => topicTitle(topicID)),
        new Promise((resolve) => {
          timer = setTimeout(resolve, TOPIC_TITLE_TIMEOUT_MS, "");
        }),
      ]);
    } catch {
      title = "";
    } finally {
      clearTimeout(timer);
    }
  }
  return String(title || "").trim() || translate("chat_topic_untitled");
}

// What the notifications go through: the host's (lib/platform.ts), the same in the browser and the
// desktop app; tests pass their own.
export const topicNotificationHost = {
  storage: localStore,
  isForeground,
  permission: notificationPermission,
  show: showNotification,
  onPress: onNotificationPress,
};

const pressTargets = new Map();
const pressListeners = new Set();

// topicTitle(topicID) reads the topic's current name; it may be async, and may fail.
export async function handleTopicTaskNotification(
  raw,
  { scope, translate, navigate, topicTitle, isCurrent = () => true, host = topicNotificationHost },
) {
  if (
    raw?.type !== "topic_task_completed" ||
    typeof raw.id !== "string" ||
    !raw.id.trim() ||
    typeof raw.topic_id !== "string" ||
    !raw.topic_id.trim() ||
    !["done", "failed"].includes(raw.status) ||
    isScheduledCronNotification(raw) ||
    // The phone app's native part tells of them, also once the page is suspended: showing them
    // here as well would tell some twice (lib/core/background-task-notifications.js).
    hasFeature("backgroundTaskNotifications")
  ) {
    return false;
  }
  const foregroundAtArrival = host.isForeground();
  const prefix = `${PREFIX}${scope}:`;
  const id = `${prefix}${raw.id}`;
  try {
    if (!isCurrent()) return false;
    // Keep consumed IDs across reloads, including events suppressed in the foreground and ones the
    // host failed to show: each task completion gets one try.
    const key = `${prefix}task:${raw.id}`;
    if (host.storage.getItem(key) !== null) return false;
    host.storage.setItem(key, "1");
    if (foregroundAtArrival || host.isForeground() || (await host.permission()) !== "granted") return false;
    const topicID = raw.topic_id.trim();
    // Read the name first: the person may come back while it loads, and then nothing is shown.
    const title = await topicNotificationTitle(topicID, topicTitle, translate);
    if (!isCurrent() || host.isForeground()) return false;
    pressTargets.set(id, () => navigate(endpointRoutePath(CONSOLE_LOCAL_ENDPOINT_REF, `/chat/${encodeURIComponent(topicID)}`)));
    if (!pressListeners.has(host.onPress)) {
      pressListeners.add(host.onPress);
      host.onPress((pressed) => {
        const go = pressTargets.get(pressed);
        pressTargets.delete(pressed);
        go?.();
      });
    }
    await host.show({ id, title, body: translate(`topic_notification_${raw.status}`), tag: id });
    return true;
  } catch {
    // Blocked storage or a refused notification must be a no-op.
    pressTargets.delete(id);
    return false;
  }
}
