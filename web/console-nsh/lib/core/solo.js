// Solo (FT186): the owner's one pinned conversation with the agent, the topic "_solo". The runtime
// keeps there, as finished tasks of the topic, a card for each work thread Solo started
// ("solothread_<thread task>") and the thread's summary when it ends ("solosummary_<thread task>"),
// each with its thread in result.solo_thread; a Solo reply's result.solo_sources lists the
// workspace it used and the threads and sources it touched. This reads them for the chat.

export const SOLO_TOPIC_ID = "_solo";

const THREAD_STATES = ["running", "waiting", "done", "failed", "canceled"];
const SOURCE_KINDS = ["workspace", "thread", "topic", "memory", "journal"];

export function isSoloTopicID(topicID) {
  return String(topicID || "").trim() === SOLO_TOPIC_ID;
}

/** Whether a topic is a work thread Solo started. */
export function topicStartedFromSolo(topic) {
  return isSoloTopicID(topic?.started_from ?? topic?.startedFrom);
}

/** Whether a thread in this state has ended. */
export function soloThreadEnded(state) {
  return state === "done" || state === "failed" || state === "canceled";
}

/**
 * A task's Solo thread record (a card or a summary), or null when the task is none: kind, the
 * thread's topic and task, title, workspace, state, summary, and whether Solo gave an existing
 * thread more work.
 */
export function soloThreadOf(task) {
  const raw = task?.result?.solo_thread ?? task?.soloThread;
  if (!raw || typeof raw !== "object") return null;
  const topicID = String(raw.topic_id ?? raw.topicID ?? "").trim();
  const taskID = String(raw.task_id ?? raw.taskID ?? "").trim();
  if (!topicID || !taskID) return null;
  const state = THREAD_STATES.includes(raw.state) ? raw.state : "running";
  return {
    kind: raw.kind === "summary" ? "summary" : "card",
    topicID,
    taskID,
    title: String(raw.title || "").trim(),
    workspace: String(raw.workspace || "").trim(),
    state,
    summary: String(raw.summary || "").trim(),
    finishedAt: String(raw.finished_at ?? raw.finishedAt ?? "").trim(),
    continued: raw.continued === true,
  };
}

/** What a Solo reply used, in order: [{kind, id, label}], without unknown kinds or repeats. */
export function soloSourcesOf(task) {
  const raw = task?.result?.solo_sources ?? task?.sources;
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const kind = String(item?.kind || "").trim();
    if (!SOURCE_KINDS.includes(kind)) continue;
    const id = String(item?.id || "").trim();
    const key = `${kind}\u0000${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind, id, label: String(item?.label || "").trim() });
  }
  return out;
}

/** The topics of the thread cards in a history that still run (or wait), for following them. */
export function liveSoloThreads(items) {
  const out = [];
  for (const item of Array.isArray(items) ? items : []) {
    const thread = item?.soloThread;
    if (thread && thread.kind === "card" && !soloThreadEnded(thread.state)) out.push(thread.topicID);
  }
  return out;
}
