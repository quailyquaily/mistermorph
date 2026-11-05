import { normalizeTopicID } from "./chat-task-history.js";

// A TODO (cron) item's topic, "_cron_<task_id>", holds that item's runs, listed apart from the
// person's own topics.
export const CRON_TOPIC_PREFIX = "_cron_";

export function isCronTopicID(topicID) {
  const id = String(topicID || "").trim();
  return id.startsWith(CRON_TOPIC_PREFIX) && id.length > CRON_TOPIC_PREFIX.length;
}

// The TODO items' topics among the loaded ones, the one with the latest run first.
export function cronTopicsOf(topics) {
  return (Array.isArray(topics) ? topics : [])
    .filter((topic) => isCronTopicID(normalizeTopicID(topic?.id)))
    .sort((a, b) => String(b?.updated_at || "").localeCompare(String(a?.updated_at || "")));
}

// What the sidebar lists in its TODO view: the TODO items' topics in one unlabeled group. Before
// any item has run there is no group at all, never the person's own topics; the view then shows
// its empty note.
export function cronSidebarGroups(topics) {
  const cronTopics = cronTopicsOf(topics);
  return cronTopics.length > 0 ? [{ key: "cron", label: "", topics: cronTopics }] : [];
}
