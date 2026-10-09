import { reactive, readonly } from "vue";

// Floating notices: one stack for the whole app, shown by AppNoticeHost. Page-level errors (from
// AppPage) and short confirmations (useNotice) share it, so they never land on top of each other.

export const NOTICE_TYPES = ["error", "warning", "info", "success"];

// How long each type stays when nothing else is said. 0 keeps a notice until it is dismissed.
const DEFAULT_TIMEOUT = {
  error: 6000,
  warning: 6000,
  info: 4000,
  success: 3200,
};

const MAX_VISIBLE = 4;

const state = reactive({ items: [] });
const timers = new Map();
let seq = 0;

export const noticeState = readonly(state);

export function normalizeNoticeType(type) {
  const value = String(type || "").trim().toLowerCase();
  if (value === "danger") {
    return "error";
  }
  return NOTICE_TYPES.includes(value) ? value : "info";
}

function clearTimer(id) {
  const timer = timers.get(id);
  if (timer) {
    clearTimeout(timer);
    timers.delete(id);
  }
}

function startTimer(id, timeout) {
  clearTimer(id);
  if (timeout > 0) {
    timers.set(id, setTimeout(() => dismissNotice(id), timeout));
  }
}

// Shows a notice and returns its id. Passing an id updates that notice in place. The same message
// already on screen is refreshed instead of shown twice.
export function pushNotice({ id = "", type = "info", text = "", label = "", timeout } = {}) {
  const message = String(text || "").trim();
  if (!message) {
    if (id) {
      dismissNotice(id);
    }
    return "";
  }
  const kind = normalizeNoticeType(type);
  const life = Number.isFinite(timeout) ? Math.max(0, timeout) : DEFAULT_TIMEOUT[kind];
  let item = id ? state.items.find((entry) => entry.id === id) : null;
  if (!item) {
    item = state.items.find((entry) => !entry.pinned && entry.type === kind && entry.text === message);
  }
  if (item) {
    item.type = kind;
    item.text = message;
    item.label = String(label || "");
    startTimer(item.id, life);
    return item.id;
  }
  const next = { id: id || `notice-${++seq}`, type: kind, text: message, label: String(label || ""), pinned: Boolean(id) };
  state.items.push(next);
  while (state.items.length > MAX_VISIBLE) {
    const dropped = state.items.find((entry) => !entry.pinned) || state.items[0];
    dismissNotice(dropped.id);
  }
  startTimer(next.id, life);
  return next.id;
}

export function dismissNotice(id) {
  clearTimer(id);
  const index = state.items.findIndex((entry) => entry.id === id);
  if (index >= 0) {
    state.items.splice(index, 1);
  }
}

// Holds a notice while the pointer is on it, so it can be read; leaving starts its time again.
export function holdNotice(id) {
  clearTimer(id);
}

export function releaseNotice(id) {
  const item = state.items.find((entry) => entry.id === id);
  if (item && !item.pinned) {
    startTimer(id, Math.min(DEFAULT_TIMEOUT[item.type], 3000));
  }
}

// The replacement for Quail's useToast: notice.error(message), notice.success(message), and the
// other types, each taking optional { label, timeout }.
export function useNotice() {
  const show = (type) => (text, options = {}) => pushNotice({ ...options, type, text });
  return {
    error: show("error"),
    warning: show("warning"),
    info: show("info"),
    success: show("success"),
    dismiss: dismissNotice,
  };
}

// Browser messages for a request that never reached the server.
const NETWORK_ERROR = /failed to fetch|networkerror|network error|load failed|network request failed|err_(internet|network|connection)/i;

export function isNetworkErrorMessage(message) {
  return NETWORK_ERROR.test(String(message || ""));
}
