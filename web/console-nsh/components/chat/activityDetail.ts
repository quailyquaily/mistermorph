// What the temporary detail panel beside the conversation shows: one reply's plan, progress or
// reasoning, or one of its workers' output. A reply only keeps compact entry points (the status
// columns, the worker chips); pressing one selects it here, and the page shows it in the panel at
// the right, in place of the topic and workspace panel (the two are one right panel, never both).
//
// A selection names its reply by id (and its task, should the reply be replaced by the task's own
// row) and its worker by id, never a copy of the data: the panel looks them up in the live history,
// so a plan, progress or output still streaming keeps growing there.
import { signal, untracked } from "nsh";

export type ActivityDetailKind = "plan" | "activity" | "reasoning" | "worker";

export const ACTIVITY_DETAIL_KINDS: readonly ActivityDetailKind[] = ["plan", "activity", "reasoning", "worker"];

export interface ActivityDetailRef {
  /** The reply's history item id. */
  itemID: string;
  /** The reply's task, to find it again if its row was replaced. */
  taskID?: string;
  kind: ActivityDetailKind;
  /** The worker, for `worker`. */
  workerID?: string;
}

/** One key per entry point: the reply, the kind, and the worker. */
export function activityDetailKey(ref: ActivityDetailRef | null | undefined): string {
  if (!ref) return "";
  const item = String(ref.itemID || "").trim();
  if (!item) return "";
  return ref.kind === "worker" ? `${item}\u0000worker\u0000${String(ref.workerID || "").trim()}` : `${item}\u0000${ref.kind}`;
}

/** The selection as it should be kept: trimmed, a known kind, a worker only for `worker`. */
export function normalizeActivityDetail(ref: Partial<ActivityDetailRef> | null | undefined): ActivityDetailRef | null {
  const itemID = String(ref?.itemID || "").trim();
  const kind = String(ref?.kind || "").trim() as ActivityDetailKind;
  if (!itemID || !ACTIVITY_DETAIL_KINDS.includes(kind)) return null;
  const workerID = String(ref?.workerID || "").trim();
  if (kind === "worker" && !workerID) return null;
  const taskID = String(ref?.taskID || "").trim();
  return { itemID, kind, ...(taskID ? { taskID } : {}), ...(kind === "worker" ? { workerID } : {}) };
}

/** The reply a selection names in `items`: by id, else (a replaced row) by its task. */
export function findActivityDetailItem<T extends { id: string; taskId?: string; role?: string }>(
  items: readonly T[],
  ref: ActivityDetailRef | null | undefined,
): T | null {
  if (!ref) return null;
  const byID = items.find((item) => item?.id === ref.itemID);
  if (byID) return byID;
  const taskID = String(ref.taskID || "").trim();
  if (!taskID) return null;
  return items.find((item) => String(item?.role || "") === "agent" && String(item?.taskId || "").trim() === taskID) ?? null;
}

/** The worker of reply `itemID` that `key` (an `activityDetailKey`) names, "" if none. */
export function activityDetailWorkerID(key: string, itemID: string): string {
  const prefix = `${String(itemID || "").trim()}\u0000worker\u0000`;
  return key && key.startsWith(prefix) ? key.slice(prefix.length) : "";
}

/**
 * The entry point (`activityDetailKey`) that takes the keyboard focus back as the detail panel
 * closes. `request(key)` sets it, and it stays until that change has settled (the effects that
 * read it have run, the panel's close included), then clears: the entries on screen then see it
 * and take the focus, and an entry drawn later does not.
 */
export function createFocusReturn() {
  const key = signal("");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  return {
    key: () => key(),
    request(next: string) {
      stop();
      key.set(next);
      timer = setTimeout(() => {
        timer = undefined;
        if (untracked(key) === next) key.set("");
      }, 0);
    },
    dispose: stop,
  };
}
