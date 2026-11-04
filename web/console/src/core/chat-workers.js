// The roster of subagents and coders a chat task started: who they are, how they are doing, and
// what they printed. Built from the task's activity ("workers", kept by the runtime beside the
// activity history), so it is the same live and after a reload.

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
      kind: text(item.kind) === "coder" ? "coder" : "subagent",
      status: text(item.status).toLowerCase(),
      activityId: text(item.activity_id || item.activityId),
      at: text(item.at),
      stream: text(item.stream),
      output: String(item.output || ""),
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

// workerOutput is the text to show for a worker: its error, else its output, else its summary.
export function workerOutput(worker) {
  const error = text(worker?.error);
  if (error) {
    return error;
  }
  const output = String(worker?.output || "");
  if (output.trim()) {
    return output;
  }
  return text(worker?.summary);
}

export function workerProcessLabel(process) {
  return `${process?.program ? `${process.program} ` : ""}PID ${process?.pid}`;
}

function hashName(name) {
  let hash = 2166136261;
  for (const char of text(name)) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

// workerAvatar draws a worker's avatar from its name alone, so a name looks the same wherever it
// appears: a hue, and a 5x5 pattern mirrored left to right (15 cells chosen, 25 drawn).
export function workerAvatar(name) {
  const hash = hashName(name);
  // A second round spreads names that differ only at the end.
  let bits = Math.imul(hash ^ (hash >>> 15), 2246822507) >>> 0;
  const cells = [];
  for (let row = 0; row < 5; row += 1) {
    const half = [];
    for (let col = 0; col < 3; col += 1) {
      half.push((bits & 1) === 1);
      bits = bits >>> 1 || Math.imul(hash, 3266489909) >>> 0;
    }
    const line = [...half, half[1], half[0]];
    line.forEach((on, x) => {
      if (on) cells.push({ x, y: row });
    });
  }
  if (cells.length === 0) {
    cells.push({ x: 2, y: 2 });
  }
  return { hue: hash % 360, cells };
}

// rosterWorkers lists the workers to show for a task, in the order they started.
export function rosterWorkers(activity, taskStatus) {
  const workers = Array.isArray(activity?.workers) ? activity.workers : [];
  return workers.map((worker) => ({
    ...worker,
    state: workerState(worker, taskStatus),
    note: workerOutput(worker),
  }));
}
