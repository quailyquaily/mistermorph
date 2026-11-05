// Which topics have unfinished tasks, from the runtime's GET /topics/activity: a task running (or
// queued), or one waiting for the person (an approval or a question).

export const TOPIC_ACTIVITY_RUNNING = "running";
export const TOPIC_ACTIVITY_PENDING = "pending";

// normalizeTopicActivity turns the API list into a Map from topic ID to { status, running,
// pending }. Rows without an ID or a known status are left out.
export function normalizeTopicActivity(raw) {
  const activity = new Map();
  if (!Array.isArray(raw)) {
    return activity;
  }
  for (const item of raw) {
    const id = typeof item?.id === "string" ? item.id.trim() : "";
    const status = item?.status;
    if (!id || (status !== TOPIC_ACTIVITY_RUNNING && status !== TOPIC_ACTIVITY_PENDING)) {
      continue;
    }
    activity.set(id, {
      status,
      running: Math.max(0, Number(item.running) || 0),
      pending: Math.max(0, Number(item.pending) || 0),
    });
  }
  return activity;
}

// topicActivitySignature is a stable key for an activity Map, so a poll that changes nothing does
// not replace it and re-render the topic list.
export function topicActivitySignature(activity) {
  return [...activity.entries()]
    .map(([id, item]) => `${id}:${item.status}:${item.running}:${item.pending}`)
    .sort()
    .join("|");
}
