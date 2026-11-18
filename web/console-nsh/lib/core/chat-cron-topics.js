import { normalizeTopicID } from "./chat-task-history.js";

// A TODO (cron) item's topic, "_cron_<job id>", holds that item's runs, listed apart from the
// person's own topics. The topic names its job in job_id; the topic's own ID, the job's ID and
// each run's ID are three things.
export const CRON_TOPIC_PREFIX = "_cron_";

export function isCronTopicID(topicID) {
  const id = String(topicID || "").trim();
  return id.startsWith(CRON_TOPIC_PREFIX) && id.length > CRON_TOPIC_PREFIX.length;
}

// topicJobID is the job whose runs the topic holds: its job_id, or, from an agent of an earlier
// version that does not send one, the job ID in a "_cron_<job id>" topic ID. "" for any other
// topic.
export function topicJobID(topic) {
  const explicit = String(topic?.job_id || "").trim();
  if (explicit) return explicit;
  const id = normalizeTopicID(topic?.id);
  return isCronTopicID(id) ? id.slice(CRON_TOPIC_PREFIX.length).trim() : "";
}

// The sidebar view to show while topicID is open. A TODO item's topic is listed only in the TODO
// runs view, so opening one, from a link or the address bar, turns that view on, never off; any
// other topic leaves the view as it is.
export function topicSidebarViewFor(topicID, view) {
  return isCronTopicID(normalizeTopicID(topicID)) ? "cron" : view;
}

// The TODO items' topics among the loaded ones, the one with the latest run first.
export function cronTopicsOf(topics) {
  return (Array.isArray(topics) ? topics : [])
    .filter((topic) => topicJobID(topic) !== "")
    .sort((a, b) => String(b?.updated_at || "").localeCompare(String(a?.updated_at || "")));
}

// What the sidebar lists in its TODO view: the TODO items' topics in one unlabeled group. Before
// any item has run there is no group at all, never the person's own topics; the view then shows
// its empty note.
export function cronSidebarGroups(topics) {
  const cronTopics = cronTopicsOf(topics);
  return cronTopics.length > 0 ? [{ key: "cron", label: "", topics: cronTopics }] : [];
}

function text(value) {
  return String(value || "").trim();
}

// cronTopicJobGone reports whether the job a TODO topic names is no longer in the list (a
// one-time item that has run, or one that was deleted). `models` (cronTopicModels) is null until
// the list has loaded, and nothing is gone until then; a topic that names no job is never gone.
export function cronTopicJobGone(models, topic) {
  if (!(models instanceof Map)) return false;
  const jobID = topicJobID(topic);
  return jobID !== "" && !models.has(jobID);
}

// The model each TODO item runs with, by its job ID, from GET /todo/tasks: the item's own
// LLM profile, or the default route when it names none or names one that is no longer
// configured, which is what the runtime falls back to. A topic that is not in the map has no item
// any more: a one-time item is gone once it has run, and an item can be deleted.
export function cronTopicModels(data) {
  const profiles = new Map();
  for (const raw of Array.isArray(data?.llm_profiles) ? data.llm_profiles : []) {
    const name = text(raw?.name);
    if (name) {
      profiles.set(name, { provider: text(raw?.inference_provider), model: text(raw?.model) });
    }
  }
  const fallback = {
    provider: text(data?.llm_default_route?.inference_provider),
    model: text(data?.llm_default_route?.model),
  };
  const models = new Map();
  for (const task of Array.isArray(data?.tasks) ? data.tasks : []) {
    const id = text(task?.id);
    if (!id) continue;
    const profile = text(task?.llm_profile);
    models.set(id, profiles.get(profile) || fallback);
  }
  return models;
}

// A TODO topic's second row: "OpenAI · gpt-5.2", what the item runs with, or, without an item, what
// its latest run used. `models` is null until the items have loaded, and the row is then blank
// rather than wrong. providerTitle names a provider ID for people; unscheduled is for a topic with
// neither an item nor a recorded run.
export function cronTopicModelText(models, topic, { providerTitle = (id) => id, unscheduled = "" } = {}) {
  if (!(models instanceof Map)) return "";
  const entry = models.get(topicJobID(topic));
  const provider = text(entry ? entry.provider : topic?.llm_provider);
  const model = text(entry ? entry.model : topic?.llm_model);
  if (!entry && !provider && !model) return unscheduled;
  return [text(providerTitle(provider)) || provider, model].filter(Boolean).join(" · ");
}
