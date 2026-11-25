// Solo (FT186): the owner's one pinned conversation with the agent, the topic "_solo". The runtime
// keeps there, as finished tasks of the topic, a card for each work thread Solo started
// ("solothread_<thread task>") and the thread's summary when it ends ("solosummary_<thread task>"),
// each with its thread in result.solo_thread; a Solo reply's result.solo_sources lists the
// workspace it used and the threads and sources it touched. This reads them for the chat.

import { workerState } from "./chat-workers.js";
import { readWorkerIndices, workerAvatarStyle, workerDisplayName } from "./worker-identity.js";

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

// What a thread record may list of its task's workers (the runtime's bounds), and how many of
// them a card or a chip shows.
const PARTICIPANT_LIMIT = 32;
const PARTICIPANT_MAX_OMITTED = 99999;
export const SOLO_PARTICIPANTS_SHOWN = 3;

/**
 * The subagents and coders of a thread's task, as its record lists them (FT189), in the order they
 * started: [{id, name, nameSet?, nameIndex?, avatarIndex?, kind, status}], a worker once, without
 * entries that name no worker. Only a worker's identity, kind and status are read, whatever else
 * an entry carries. A record from before participants were kept has none.
 */
export function soloParticipantsOf(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const id = String(item?.id ?? "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: String(item?.name ?? "").trim(),
      ...readWorkerIndices(item),
      kind: String(item?.kind ?? "").trim() === "coder" ? "coder" : "subagent",
      status: String(item?.status ?? "").trim().toLowerCase(),
    });
  }
  return out.slice(-PARTICIPANT_LIMIT);
}

function omittedCount(raw) {
  const count = Math.floor(Number(raw));
  return Number.isFinite(count) && count > 0 ? Math.min(PARTICIPANT_MAX_OMITTED, count) : 0;
}

/**
 * Who a thread record shows: its newest `limit` workers, newest first, each with its name in lang
 * (the worker's ID when its record has no name to show), its logo style and its state (a worker
 * still marked live in a thread that ended took the thread's ending with it), and how many more
 * there are: the listed ones not shown, and the ones the record no longer lists.
 */
export function soloParticipantRoster(thread, lang, limit = SOLO_PARTICIPANTS_SHOWN) {
  const all = Array.isArray(thread?.participants) ? thread.participants : [];
  const shown = all
    .slice(-limit)
    .reverse()
    .map((worker) => ({
      ...worker,
      displayName: workerDisplayName(worker, lang) || worker.id,
      avatarStyle: workerAvatarStyle(worker),
      state: workerState(worker, thread?.state),
    }));
  return { shown, more: all.length - shown.length + omittedCount(thread?.participantsOmitted) };
}

/**
 * The thread record a thread chip stands for: the card (else the summary) in `items` (a loaded
 * history) of exactly the task the chip's reply started, in the chip's topic. Null for any other
 * chip, for a thread chip that names no task (the reply only read the thread, or started it more
 * than once), and when that task's record is not loaded: a chip is never matched by its topic or
 * its title alone.
 */
export function soloThreadOfSource(source, items) {
  if (source?.kind !== "thread" || !source.id || !source.taskID) return null;
  let summary = null;
  for (const item of Array.isArray(items) ? items : []) {
    const thread = item?.soloThread;
    if (!thread || thread.taskID !== source.taskID || thread.topicID !== source.id) continue;
    if (thread.kind === "card") return thread;
    summary = summary || thread;
  }
  return summary;
}

/**
 * A task's Solo thread record (a card or a summary), or null when the task is none: kind, the
 * thread's topic and task, title, workspace, state, summary, whether Solo gave an existing
 * thread more work, and the task's subagents and coders (participants, participantsOmitted).
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
    participants: soloParticipantsOf(raw.participants),
    participantsOmitted: omittedCount(raw.participants_omitted ?? raw.participantsOmitted),
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
 * listed again adds its uses to the first. A thread the reply started also has the task that start
 * made (taskID, FT189), unless the thread is listed with two different tasks: then it has none.
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
    const taskID = kind === "thread" ? String(item?.task_id ?? item?.taskID ?? "").trim() : "";
    if (had) {
      had.source.uses = soloSourceUsesOf([...had.source.uses, ...soloSourceUsesOf(item?.uses)]);
      if (taskID) had.tasks.add(taskID);
      if (had.tasks.size > 1) delete had.source.taskID;
      else if (taskID) had.source.taskID = taskID;
      continue;
    }
    const source = { kind, id, label: String(item?.label || "").trim(), uses: soloSourceUsesOf(item?.uses) };
    if (taskID) source.taskID = taskID;
    seen.set(key, { source, tasks: new Set(taskID ? [taskID] : []) });
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
