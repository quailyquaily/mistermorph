import { watch } from "vue";

import {
  authValid,
  BASE_PATH,
  translate,
  buildConsoleNotificationURL,
  createConsoleStreamTicket,
  runtimeApiFetchForEndpoint,
  safeJSON,
} from "./context";
import {
  canUseDesktopNotifications,
  isDesktopRuntime,
  requestDesktopNotificationPermission,
  showDesktopNotification,
} from "./desktop-runtime";
import {
  claimConsoleNotification,
  normalizeConsoleNotification,
  resolveBrowserNotificationPermission,
  requestBrowserNotificationPermission,
} from "./system-notification-utils";

import { CONSOLE_LOCAL_ENDPOINT_REF } from "./endpoints";
import { handleTopicTaskNotification, trackNotificationForeground } from "./topic-task-notifications";

const RECONNECT_DELAY_MS = 3000;
const NOTIFICATION_TEXT_LIMIT = 600;

let installed = false;
let activeSocket = null;
let reconnectTimer = 0;
let connectionGeneration = 0;

export async function requestSystemNotificationPermission() {
  if (isDesktopRuntime() && canUseDesktopNotifications()) {
    try {
      return (await requestDesktopNotificationPermission()) ? "granted" : "denied";
    } catch {
      return await requestBrowserNotificationPermission();
    }
  }
  return await requestBrowserNotificationPermission();
}

export async function showSystemNotification(event) {
  const notification = normalizeConsoleNotification(event);
  if (!notification) {
    return false;
  }
  const title = truncateNotificationText(notification.title);
  const body = truncateNotificationText(notification.body);
  if (isDesktopRuntime() && canUseDesktopNotifications()) {
    try {
      await showDesktopNotification({
        id: notification.id,
        title,
        body,
      });
      return true;
    } catch {
      // Fall back to the Web Notification API when the native service is unavailable.
    }
  }
  if (resolveBrowserNotificationPermission() !== "granted") {
    return false;
  }
  try {
    const systemNotification = new window.Notification(title, {
      body,
      tag: notification.id,
    });
    systemNotification.onclick = () => {
      window.focus();
      systemNotification.close();
    };
    return true;
  } catch {
    return false;
  }
}

export function installSystemNotifications(router) {
  if (installed || typeof window === "undefined") {
    return;
  }
  installed = true;
  trackNotificationForeground(window, BASE_PATH);
  watch(
    authValid,
    (valid) => {
      if (valid) {
        void connectNotificationSocket(router);
      } else {
        disconnectNotificationSocket();
      }
    },
    { immediate: true }
  );
}

async function connectNotificationSocket(router) {
  if (!authValid.value || activeSocket) {
    return;
  }
  clearReconnectTimer();
  const generation = ++connectionGeneration;
  let payload;
  try {
    payload = await createConsoleStreamTicket();
  } catch {
    scheduleReconnect(generation, router);
    return;
  }
  if (generation !== connectionGeneration || !authValid.value) {
    return;
  }
  const url = buildConsoleNotificationURL(payload?.ticket);
  if (!url) {
    scheduleReconnect(generation, router);
    return;
  }
  const socket = new WebSocket(url);
  activeSocket = socket;
  socket.onmessage = (message) => {
    if (activeSocket !== socket || generation !== connectionGeneration || !authValid.value) return;
    const raw = safeJSON(message.data, null);
    if (raw?.type === "topic_task_completed") {
      void handleTopicTaskNotification(raw, {
        win: window,
        scope: BASE_PATH,
        translate,
        navigate: (path) => router.push(path),
        topicTitle: localTopicTitle,
        isCurrent: () => activeSocket === socket && generation === connectionGeneration && authValid.value,
      });
      return;
    }
    const event = normalizeConsoleNotification(raw);
    if (!event || !claimConsoleNotification(window.localStorage, event.id)) {
      return;
    }
    void showSystemNotification(event);
  };
  socket.onclose = () => {
    if (activeSocket === socket) {
      activeSocket = null;
    }
    scheduleReconnect(generation, router);
  };
  socket.onerror = () => {
    socket.close();
  };
}

// The name of a topic of the local Console, whose tasks these notifications are about.
async function localTopicTitle(topicID) {
  const topic = await runtimeApiFetchForEndpoint(CONSOLE_LOCAL_ENDPOINT_REF, `/topics/${encodeURIComponent(topicID)}`);
  return topic?.title;
}

function disconnectNotificationSocket() {
  connectionGeneration += 1;
  clearReconnectTimer();
  const socket = activeSocket;
  activeSocket = null;
  if (socket) {
    socket.onclose = null;
    socket.close();
  }
}

function scheduleReconnect(generation, router) {
  if (!authValid.value || reconnectTimer || generation !== connectionGeneration) {
    return;
  }
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = 0;
    void connectNotificationSocket(router);
  }, RECONNECT_DELAY_MS);
}

function clearReconnectTimer() {
  if (!reconnectTimer) {
    return;
  }
  window.clearTimeout(reconnectTimer);
  reconnectTimer = 0;
}

function truncateNotificationText(value) {
  const text = String(value || "").trim().replace(/\s+/g, " ");
  if (text.length <= NOTIFICATION_TEXT_LIMIT) {
    return text;
  }
  return `${text.slice(0, NOTIFICATION_TEXT_LIMIT - 1)}…`;
}
