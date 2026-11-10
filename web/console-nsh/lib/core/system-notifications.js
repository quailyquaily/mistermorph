import { effect, untracked } from "nsh";

import {
  API_BASE,
  authState,
  authValid,
  BASE_PATH,
  localeState,
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
import {
  configureBackgroundTaskNotifications,
  hasFeature,
  localStore,
  notificationPermission,
  onNotificationOpened,
  requestNotificationPermission,
  showNotification,
  takeOpenedNotification,
} from "../platform";
import { installBackgroundTaskNotifications } from "./background-task-notifications.js";

import { CONSOLE_LOCAL_ENDPOINT_REF } from "./endpoints";
import { handleTopicTaskNotification, trackNotificationForeground } from "./topic-task-notifications";

const RECONNECT_DELAY_MS = 3000;
const NOTIFICATION_TEXT_LIMIT = 600;

let installed = false;
let activeSocket = null;
let reconnectTimer = 0;
let connectionGeneration = 0;

export async function requestSystemNotificationPermission() {
  // The phone app shows task completions only (background-task-notifications.js), not a TODO
  // item's opt-in notifications: a TODO item cannot notify there.
  if (hasFeature("backgroundTaskNotifications")) {
    return "unsupported";
  }
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
  if (hasFeature("backgroundTaskNotifications")) {
    // The phone app: its native part tells of finished tasks while the app is away.
    installBackgroundTaskNotifications({
      configure: configureBackgroundTaskNotifications,
      take: takeOpenedNotification,
      onOpened: onNotificationOpened,
      api: () => API_BASE,
      token: () => authState.token,
      signedIn: () => authValid.value,
      language: () => localeState.lang,
      translate,
      topicExists: async (topicID) => Boolean(await localTopic(topicID)),
      navigate: (path) => router.push(path),
    });
  }
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

// A topic of the local Console, whose tasks these notifications are about.
function localTopic(topicID) {
  return runtimeApiFetchForEndpoint(CONSOLE_LOCAL_ENDPOINT_REF, `/topics/${encodeURIComponent(topicID)}`);
}

async function localTopicTitle(topicID) {
  return (await localTopic(topicID))?.title;
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
