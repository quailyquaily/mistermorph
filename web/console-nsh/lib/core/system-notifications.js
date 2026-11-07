import { effect, untracked } from "nsh";

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
import { claimConsoleNotification, normalizeConsoleNotification } from "./system-notification-utils";
import { localStore, notificationPermission, requestNotificationPermission, showNotification } from "../platform";

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
      return await requestNotificationPermission();
    }
  }
  return await requestNotificationPermission();
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
      await showDesktopNotification({ id: notification.id, title, body });
      return true;
    } catch {
      // Fall back to the host's other notification path below.
    }
  }
  if ((await notificationPermission()) !== "granted") {
    return false;
  }
  try {
    await showNotification({ id: notification.id, title, body, tag: notification.id });
    return true;
  } catch {
    return false;
  }
}

// router is { push(path) }: what a pressed task notification navigates with.
export function installSystemNotifications(router) {
  if (installed) {
    return;
  }
  installed = true;
  trackNotificationForeground();
  effect(() => {
    const valid = authValid.value;
    untracked(() => {
      if (valid) {
        void connectNotificationSocket(router);
      } else {
        disconnectNotificationSocket();
      }
    });
  });
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
        scope: BASE_PATH,
        translate,
        navigate: (path) => router.push(path),
        topicTitle: localTopicTitle,
        isCurrent: () => activeSocket === socket && generation === connectionGeneration && authValid.value,
      });
      return;
    }
    const event = normalizeConsoleNotification(raw);
    if (!event || !claimConsoleNotification(localStore, event.id)) {
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
  reconnectTimer = setTimeout(() => {
    reconnectTimer = 0;
    void connectNotificationSocket(router);
  }, RECONNECT_DELAY_MS);
}

function clearReconnectTimer() {
  if (!reconnectTimer) {
    return;
  }
  clearTimeout(reconnectTimer);
  reconnectTimer = 0;
}

function truncateNotificationText(value) {
  const text = String(value || "").trim().replace(/\s+/g, " ");
  if (text.length <= NOTIFICATION_TEXT_LIMIT) {
    return text;
  }
  return `${text.slice(0, NOTIFICATION_TEXT_LIMIT - 1)}…`;
}
