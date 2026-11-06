// Runtime activity and session-only acknowledgements are kept separate from task history.
export const TOPIC_ACTIVITY_RUNNING = "running";
export const TOPIC_ACTIVITY_PENDING = "pending";
export const TOPIC_ACTIVITY_DONE = "done";

export function normalizeTopicActivity(raw) {
  const activity = new Map();
  if (!Array.isArray(raw)) return activity;
  for (const item of raw) {
    const id = typeof item?.id === "string" ? item.id.trim() : "";
    const status = item?.status;
    if (!id || !["", TOPIC_ACTIVITY_RUNNING, TOPIC_ACTIVITY_PENDING].includes(status)) continue;
    activity.set(id, {
      status,
      running: Math.max(0, Number(item.running) || 0),
      pending: Math.max(0, Number(item.pending) || 0),
      // Running tasks a TODO item's schedule started; the server counts them apart from queued
      // ones and Run now runs.
      cronRunning: Math.max(0, Math.floor(Number(item.cron_running) || 0)),
    });
  }
  return activity;
}

export function topicActivitySignature(activity) {
  return [...activity.entries()]
    .map(([id, item]) => `${id}:${item.status}:${item.running}:${item.pending}:${item.cronRunning || 0}`)
    .sort()
    .join("|");
}

// The TODO runs running now across every topic in the activity, listed in the sidebar or not.
export function cronRunningCount(activity) {
  let count = 0;
  for (const item of activity?.values?.() || []) count += Math.max(0, Number(item?.cronRunning) || 0);
  return count;
}

// A selected topic in the mobile sidebar or a background/unfocused window is not viewed.
export function activelyViewedTopic({ topicID, viewActive, visibilityState, focused, showChatPane, creatingTopic }) {
  return viewActive && visibilityState === "visible" && focused && showChatPane && !creatingTopic
    ? topicID : "";
}

export function createTopicActivityTracker() {
  let endpoint = "";
  let request = 0;
  let activity = new Map();
  const completions = new Map();
  const unread = new Set();
  return {
    setEndpoint(next) {
      if (endpoint === next) return;
      endpoint = next;
      request++;
      activity = new Map();
      completions.clear();
      unread.clear();
    },
    // Also invalidates outstanding requests when the view is unmounted.
    beginRequest() { return ++request; },
    apply(token, raw, viewedTopicID = "") {
      if (token !== request || !Array.isArray(raw)) return;
      activity = normalizeTopicActivity(raw);
      for (const item of raw) {
        const id = typeof item?.id === "string" ? item.id.trim() : "";
        if (!activity.has(id)) continue;
        const taskID = typeof item.latest_done_task_id === "string" ? item.latest_done_task_id.trim() : "";
        const at = Date.parse(item.latest_done_at);
        const previous = completions.get(id);
        // Each topic's first observation is a baseline, including topics first seen later.
        if (!previous) {
          completions.set(id, { at: Number.isFinite(at) ? at : -Infinity, seen: new Set(taskID ? [taskID] : []) });
          continue;
        }
        if (!taskID || !Number.isFinite(at) || previous.seen.has(taskID)) continue;
        previous.seen.add(taskID);
        // Retention or deletion may expose an older successful task again.
        if (at < previous.at) continue;
        previous.at = at;
        unread.add(id);
      }
      if (viewedTopicID) unread.delete(viewedTopicID);
    },
    acknowledge(topicID) { unread.delete(topicID); },
    snapshot() {
      const result = new Map([...activity].filter(([, item]) => item.status));
      for (const id of unread) {
        if (!result.has(id)) result.set(id, { status: TOPIC_ACTIVITY_DONE, running: 0, pending: 0, cronRunning: 0 });
      }
      return result;
    },
  };
}
