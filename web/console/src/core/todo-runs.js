// What the runtime's cron loop is doing with each TODO item now, from GET /todo/runs (or the
// "runs" field of /todo/tasks): running, or waiting for a free slot.

export const TODO_RUN_RUNNING = "running";
export const TODO_RUN_QUEUED = "queued";

// normalizeTodoRuns turns the API list into a Map from task ID to { state, manual, startedAt }.
// Unknown states and rows without an ID are left out; a missing or malformed list is empty.
export function normalizeTodoRuns(raw) {
  const runs = new Map();
  if (!Array.isArray(raw)) {
    return runs;
  }
  for (const item of raw) {
    const id = typeof item?.id === "string" ? item.id.trim() : "";
    const state = item?.state;
    if (!id || (state !== TODO_RUN_RUNNING && state !== TODO_RUN_QUEUED)) {
      continue;
    }
    runs.set(id, {
      state,
      manual: item.manual === true,
      startedAt: state === TODO_RUN_RUNNING && typeof item.started_at === "string" ? item.started_at : "",
    });
  }
  return runs;
}

// todoRunsSignature is a stable key for a runs Map, so a poll that changes nothing does not
// replace it and re-render the list.
export function todoRunsSignature(runs) {
  return [...runs.entries()]
    .map(([id, run]) => `${id}:${run.state}`)
    .sort()
    .join("|");
}
