// A task's processes as the agent reports them (GET /tasks/{id}/processes, internal/proctrack):
// one shared reading per endpoint and task, kept fresh while something on screen watches it. A
// reply's Processes column (ChatStatusCard) shows only while the reading has a live process, and
// the open Processes panel (ChatProcessTree) draws the same reading, so the two never disagree.
//
// A reading is polled while it has watchers: every couple of seconds for the open panel and a
// task still running, less often for a finished reply on screen (its kept processes may still
// exit, or a leftover be found). The last watcher gone ends it; nothing polls for a reply that is
// not on screen. Each endpoint and task has its own reading, and only the newest answer of one
// counts, so an answer that comes late never overwrites a fresher one.
import { cleanup, effect, signal, untracked, type Signal } from "nsh";
import { runtimeApiFetchForEndpoint } from "../../lib/core/context.js";
import { t } from "./i18n";

export interface ProcNode {
  pid: number;
  ppid: number;
  name: string;
  command?: string;
  started_at: string;
  orphan?: boolean;
  children?: ProcNode[];
}

export interface ProcGroup {
  kind: string;
  program: string;
  activity_id?: string;
  pid: number;
  running: boolean;
  keep?: boolean;
  processes?: ProcNode[];
}

export interface StoppedProc {
  pid: number;
  name: string;
  command?: string;
  by: string;
  at: string;
  error?: string;
}

export interface ProcessTree {
  supported: boolean;
  known: boolean;
  /** Whether the task itself still runs (not whether any of its processes do). */
  running: boolean;
  groups: ProcGroup[];
  other?: ProcNode[];
  stopped?: StoppedProc[];
}

export interface TaskProcessState {
  /** The last tree read (kept after a failed read), null before the first. */
  tree: ProcessTree | null;
  /** Why the last read failed, "" when it did not. */
  error: string;
  /** Whether a read has answered (or failed) yet. */
  loaded: boolean;
  /** Whether the last read succeeded and lists a process running now. */
  live: boolean;
}

/** How often a reading is taken again while the panel is open or the task runs. */
export const FAST_REFRESH_MS = 2000;
/** How often while only a finished reply's column watches it. */
export const SLOW_REFRESH_MS = 5000;

const EMPTY: TaskProcessState = Object.freeze({ tree: null, error: "", loaded: false, live: false });

/**
 * Whether `tree` lists a process running now: a call's root still running, or anything it left
 * behind (its processes, orphans included, under a group whose root has exited), or a process of
 * the task's under no call. What was stopped is history, and the task's own `running` says nothing
 * about its processes. A tree the agent cannot track or does not know has none.
 */
export function processTreeLive(tree: ProcessTree | null | undefined): boolean {
  if (!tree || tree.supported !== true || tree.known !== true) return false;
  const groups = Array.isArray(tree.groups) ? tree.groups : [];
  if (groups.some((group) => group?.running === true || (Array.isArray(group?.processes) && group.processes.length > 0))) return true;
  return Array.isArray(tree.other) && tree.other.length > 0;
}

interface Reading {
  key: string;
  endpointRef: string;
  taskID: string;
  state: Signal<TaskProcessState>;
  watchers: number;
  fastWatchers: number;
  timer?: ReturnType<typeof setTimeout>;
  /** Reads started, and the newest one that answered (an older answer is dropped). */
  started: number;
  answered: number;
  /** A poll (not a refresh) is on its way: the next one is scheduled when it answers. */
  polling: boolean;
  /** No watcher is left: answers still on their way are dropped. */
  ended: boolean;
}

/** How a reading asks the agent: `runtimeApiFetchForEndpoint`'s shape (tests give their own). */
export type TaskProcessFetch = (endpointRef: string, path: string) => Promise<unknown>;

export interface TaskProcessStore {
  /**
   * Watches task `taskID`'s processes on `endpointRef` while the calling component (or effect)
   * lives, and returns the reading as it is now. Another task or endpoint switches to that one's
   * reading (a new one starts empty). `fast` polls at FAST_REFRESH_MS. Nothing is read without
   * both ids.
   */
  watch(endpointRef: () => string, taskID: () => string, options?: { fast?: () => boolean }): () => TaskProcessState;
  /** Reads task `taskID`'s processes again now (after a Stop), if something watches them. */
  refresh(endpointRef: string, taskID: string): Promise<void>;
  /** How many readings are kept (watched) now. */
  size(): number;
}

const readingKey = (endpointRef: string, taskID: string) => `${endpointRef}\u0000${taskID}`;

export function createTaskProcessStore(fetch: TaskProcessFetch): TaskProcessStore {
  const readings = new Map<string, Reading>();

  async function read(reading: Reading) {
    const seq = ++reading.started;
    const path = `/tasks/${encodeURIComponent(reading.taskID)}/processes`;
    let next: TaskProcessState;
    try {
      const tree = (await fetch(reading.endpointRef, path)) as ProcessTree;
      next = { tree, error: "", loaded: true, live: processTreeLive(tree) };
    } catch (err) {
      const previous = untracked(reading.state);
      next = { tree: previous.tree, error: String((err as Error)?.message || err || t("msg_load_failed")), loaded: true, live: false };
    }
    if (reading.ended || seq < reading.answered) return;
    reading.answered = seq;
    reading.state.set(next);
  }

  const interval = (reading: Reading) => (reading.fastWatchers > 0 ? FAST_REFRESH_MS : SLOW_REFRESH_MS);

  function schedule(reading: Reading, delay: number) {
    if (reading.timer) clearTimeout(reading.timer);
    reading.timer = undefined;
    if (reading.ended || reading.polling) return;
    // An agent that cannot track processes never will: nothing to read again.
    if (untracked(reading.state).tree?.supported === false) return;
    reading.timer = setTimeout(() => void poll(reading), delay);
  }

  async function poll(reading: Reading) {
    reading.timer = undefined;
    if (reading.ended || reading.polling) return;
    reading.polling = true;
    try {
      await read(reading);
    } finally {
      reading.polling = false;
    }
    schedule(reading, interval(reading));
  }

  function add(endpointRef: string, taskID: string, fast: boolean): Reading {
    const key = readingKey(endpointRef, taskID);
    let reading = readings.get(key);
    const fresh = !reading;
    if (!reading) {
      reading = { key, endpointRef, taskID, state: signal<TaskProcessState>(EMPTY), watchers: 0, fastWatchers: 0, started: 0, answered: 0, polling: false, ended: false };
      readings.set(key, reading);
    }
    reading.watchers += 1;
    if (fast) reading.fastWatchers += 1;
    // A new reading reads at once; one that turns fast (the panel opens) reads again now.
    if (fresh || (fast && reading.fastWatchers === 1)) schedule(reading, 0);
    return reading;
  }

  function remove(reading: Reading, fast: boolean) {
    reading.watchers -= 1;
    if (fast) reading.fastWatchers -= 1;
    if (reading.watchers > 0) return;
    // A watcher that only changes (a row whose task finished, a recycled row) watches again in
    // the same pass: end the reading only if nothing did.
    queueMicrotask(() => {
      if (reading.watchers > 0 || reading.ended) return;
      reading.ended = true;
      if (reading.timer) clearTimeout(reading.timer);
      reading.timer = undefined;
      if (readings.get(reading.key) === reading) readings.delete(reading.key);
    });
  }

  return {
    watch(endpointRef, taskID, options = {}) {
      const current = signal<Reading | null>(null);
      effect(() => {
        const ref = String(endpointRef() || "").trim();
        const id = String(taskID() || "").trim();
        const fast = Boolean(options.fast?.());
        if (!ref || !id) {
          untracked(() => current.set(null));
          return;
        }
        const reading = untracked(() => add(ref, id, fast));
        untracked(() => current.set(reading));
        cleanup(() => remove(reading, fast));
      });
      return () => current()?.state() ?? EMPTY;
    },
    async refresh(endpointRef, taskID) {
      const reading = readings.get(readingKey(String(endpointRef || "").trim(), String(taskID || "").trim()));
      if (reading && !reading.ended) await read(reading);
    },
    size: () => readings.size,
  };
}

/** The Console's readings, asked through the agent's proxy. */
const store = createTaskProcessStore((endpointRef, path) => runtimeApiFetchForEndpoint(endpointRef, path));

/** Watches a task's processes (TaskProcessStore.watch) in the Console's shared readings. */
export const watchTaskProcesses: TaskProcessStore["watch"] = (endpointRef, taskID, options) => store.watch(endpointRef, taskID, options);

/** Reads a task's processes again now (TaskProcessStore.refresh). */
export const refreshTaskProcesses: TaskProcessStore["refresh"] = (endpointRef, taskID) => store.refresh(endpointRef, taskID);
