// The roster of subagents and coders a chat task started: who they are, how they are doing, and
// what they printed. Built from the task's activity ("workers", kept by the runtime beside the
// activity history), so it is the same live and after a reload.

import { readWorkerIndices, workerAvatarStyle, workerDisplayName } from "./worker-identity.js";

const TERMINAL_STATUSES = new Set(["done", "failed", "canceled"]);

function text(value) {
  return String(value ?? "").trim();
}

function normalizeProcesses(raw) {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .filter((process) => Number.isSafeInteger(process?.pid) && process.pid > 0)
    .map((process) => ({
      pid: process.pid,
      program: text(process.program),
      activityId: text(process.activity_id || process.activityId),
    }));
}

// normalizeActivityWorkers reads the runtime's worker list, or a list this function already
// returned, since activity is normalized again as updates arrive.
export function normalizeActivityWorkers(raw) {
  if (!Array.isArray(raw)) {
    return [];
  }
  const seen = new Set();
  const workers = [];
  for (const item of raw) {
    const id = text(item?.id);
    const name = text(item?.name);
    if (!id || !name || seen.has(id)) {
      continue;
    }
    seen.add(id);
    workers.push({
      id,
      name,
      ...readWorkerIndices(item),
      kind: text(item.kind) === "coder" ? "coder" : "subagent",
      status: text(item.status).toLowerCase(),
      activityId: text(item.activity_id || item.activityId),
      at: text(item.at),
      stream: text(item.stream),
      output: String(item.output || ""),
      result: String(item.result || ""),
      summary: text(item.summary),
      error: text(item.error),
      processes: normalizeProcesses(item.processes),
    });
  }
  return workers;
}

// workerState is what the roster shows for a worker: running, done, failed or canceled. A worker
// still marked live in a task that ended took the task's ending with it.
export function workerState(worker, taskStatus) {
  const status = text(worker?.status).toLowerCase();
  const task = text(taskStatus).toLowerCase();
  if (TERMINAL_STATUSES.has(status)) {
    return status;
  }
  if (TERMINAL_STATUSES.has(task)) {
    return task;
  }
  // queued, pending and running all show as running.
  return "running";
}

// workerSections is what the worker panel shows, in order: the error, the final result, and the
// output printed while running. The summary stands in when there is no result or output.
export function workerSections(worker) {
  const sections = [];
  const error = text(worker?.error);
  const result = String(worker?.result || "");
  const output = String(worker?.output || "");
  if (error) {
    sections.push({ kind: "error", text: error });
  }
  if (result.trim()) {
    sections.push({ kind: "result", text: result });
  }
  if (output.trim()) {
    sections.push({ kind: "output", text: output });
  }
  const summary = text(worker?.summary);
  if (!result.trim() && !output.trim() && summary && summary !== error) {
    sections.push({ kind: "summary", text: summary });
  }
  return sections;
}

// findActivityEntry is the activity entry with id, at any depth (history, current, children).
export function findActivityEntry(activity, id) {
  const want = text(id);
  if (!want) {
    return null;
  }
  const visit = (entries) => {
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (text(entry?.id) === want) {
        return entry;
      }
      const found = visit(entry?.children);
      if (found) {
        return found;
      }
    }
    return null;
  };
  return visit([...(Array.isArray(activity?.history) ? activity.history : []), activity?.current].filter(Boolean));
}

function settingText(value) {
  if (value === null || value === undefined) {
    return "";
  }
  if (Array.isArray(value)) {
    return value.map((item) => text(typeof item === "string" ? item : JSON.stringify(item))).filter(Boolean).join(", ");
  }
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return "";
    }
  }
  return text(value);
}

// workerAsk is how the agent started a worker: the call (spawn or coder) the worker belongs to,
// read from the activity. Its task is what the agent asked; its other arguments are the settings
// it gave (a coder's backend and directory, a subagent's tools and profile); its children are the
// calls the worker made on its own (a subagent's tools). null when the call is not in the activity.
export function workerAsk(activity, worker) {
  const entry = findActivityEntry(activity, worker?.activityId);
  if (!entry) {
    return null;
  }
  const args = entry.args && typeof entry.args === "object" ? entry.args : {};
  const task = typeof args.task === "string" ? args.task.trim() : "";
  const settings = Object.keys(args)
    .filter((key) => key !== "task")
    .sort()
    .map((key) => ({ key, value: settingText(args[key]) }))
    .filter((setting) => setting.value);
  return {
    task,
    settings,
    at: text(entry.at),
    calls: Array.isArray(entry.children) ? entry.children : [],
    callsOmitted: Math.max(0, Number(entry.childrenOmitted) || 0),
  };
}

export function workerProcessLabel(process) {
  return `${process?.program ? `${process.program} ` : ""}PID ${process?.pid}`;
}

// rosterWorkers lists the workers to show for a task, in the order they started, each with its
// name in lang and its logo style.
export function rosterWorkers(activity, taskStatus, lang) {
  const workers = Array.isArray(activity?.workers) ? activity.workers : [];
  return workers.map((worker) => ({
    ...worker,
    displayName: workerDisplayName(worker, lang),
    avatarStyle: workerAvatarStyle(worker),
    state: workerState(worker, taskStatus),
    sections: workerSections(worker),
  }));
}
