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

// What a source's uses may hold: a few named actions, each with a count (the runtime's bounds).
const USE_ACTION = /^[a-z][a-z0-9_]{0,31}$/;
const USE_LIMIT = 16;
const USE_MAX_COUNT = 9999;

/**
 * What a run did with a source, as the runtime recorded it: [{action, count}], an action once
 * (repeats add up), without malformed entries. A record from before uses were kept has none.
 */
export function soloSourceUsesOf(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    const action = String(item?.action || "").trim();
    const count = Math.floor(Number(item?.count));
    if (!USE_ACTION.test(action) || !Number.isFinite(count) || count < 1) continue;
    const had = out.find((use) => use.action === action);
    if (had) had.count = Math.min(USE_MAX_COUNT, had.count + count);
    else if (out.length < USE_LIMIT) out.push({ action, count: Math.min(USE_MAX_COUNT, count) });
  }
  return out;
}

/**
 * What a Solo reply used, in order: [{kind, id, label, uses}], without unknown kinds; a source
 * listed again adds its uses to the first.
 */
export function soloSourcesOf(task) {
  const raw = task?.result?.solo_sources ?? task?.sources;
  if (!Array.isArray(raw)) return [];
  const seen = new Map();
  const out = [];
  for (const item of raw) {
    const kind = String(item?.kind || "").trim();
    if (!SOURCE_KINDS.includes(kind)) continue;
    const id = String(item?.id || "").trim();
    const key = `${kind}\u0000${id}`;
    const had = seen.get(key);
    if (had) {
      had.uses = soloSourceUsesOf([...had.uses, ...soloSourceUsesOf(item?.uses)]);
      continue;
    }
    const source = { kind, id, label: String(item?.label || "").trim(), uses: soloSourceUsesOf(item?.uses) };
    seen.set(key, source);
    out.push(source);
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

/**
 * The topic list kept for the next visit: its first `limit` topics, and Solo with them however old
 * it is, as the runtime's own first page always has it (else the next visit opens without Solo
 * until the runtime answers).
 */
export function firstTopicsPageWithSolo(items, limit) {
  const list = Array.isArray(items) ? items : [];
  const page = list.slice(0, limit);
  if (limit <= 0 || page.some((topic) => isSoloTopicID(topic?.id))) return page;
  const solo = list.find((topic) => isSoloTopicID(topic?.id));
  return solo ? [...list.slice(0, limit - 1), solo] : page;
}
