// What the runtime's cron loop is doing with each TODO item now, from GET /todo/runs (or the
// "runs" field of /todo/tasks): running, or waiting for a free slot; and how recent runs ended.

export const TODO_RUN_RUNNING = "running";
export const TODO_RUN_QUEUED = "queued";

// How a finished run ended, from GET /todo/runs "finished".
export const TODO_RUN_DONE = "done";
export const TODO_RUN_FAILED = "failed";
export const TODO_RUN_CANCELED = "canceled";

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

// normalizeTodoRuns turns the API list into a Map from task ID to { state, manual, startedAt,
// runID, stopping }: runID names that one execution, stopping is set once a stop was asked for.
// Unknown states and rows without an ID are left out; a missing or malformed list is empty.
export function normalizeTodoRuns(raw) {
  const runs = new Map();
  if (!Array.isArray(raw)) {
    return runs;
  }
  for (const item of raw) {
    const id = text(item?.id);
    const state = item?.state;
    if (!id || (state !== TODO_RUN_RUNNING && state !== TODO_RUN_QUEUED)) {
      continue;
    }
    runs.set(id, {
      state,
      manual: item.manual === true,
      startedAt: state === TODO_RUN_RUNNING && typeof item.started_at === "string" ? item.started_at : "",
      runID: text(item.run_id),
      stopping: item.stopping === true,
    });
  }
  return runs;
}

// normalizeFinishedTodoRuns turns GET /todo/runs "finished" into a Map from run ID to
// { id, status, stopping }; rows without a run ID or a known status are left out.
export function normalizeFinishedTodoRuns(raw) {
  const finished = new Map();
  if (!Array.isArray(raw)) {
    return finished;
  }
  for (const item of raw) {
    const runID = text(item?.run_id);
    const status = text(item?.status);
    if (!runID || ![TODO_RUN_DONE, TODO_RUN_FAILED, TODO_RUN_CANCELED].includes(status)) {
      continue;
    }
    finished.set(runID, { id: text(item.id), status, stopping: item.stopping === true });
  }
  return finished;
}

// todoRunsSignature is a stable key for a runs Map, so a poll that changes nothing does not
// replace it and re-render the list.
export function todoRunsSignature(runs) {
  return [...runs.entries()]
    .map(([id, run]) => `${id}:${run.state}:${run.runID || ""}:${run.stopping ? 1 : 0}`)
    .sort()
    .join("|");
}
