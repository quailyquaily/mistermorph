// What the job calendar asks the runtime: a month's recorded runs (GET /todo/runs/history), and the
// jobs as they are stored, for their triggers and the jobs they use. One loader per calendar,
// made in the component (its effects go with it).
//
// - `range` names the days on screen; a new range drops the runs shown and loads again (`loading`).
// - `liveKey` changes as the page's live runs change (/todo/runs, polled by the page's state): the
//   history is asked again then, quietly, the runs on screen staying until the answer comes.
// - `jobsKey` changes as the page's list of jobs does: the stored jobs are asked again.
// - An answer to a question that is no longer the latest is dropped (the API helper cannot abort
//   a request), so a slow month never lands on the month that replaced it.
//
// The stored jobs are read here because the page's items (todo-model.js normalizeTask) keep only
// the first schedule (at, cron, tz), not `triggers` or `uses`. Once they carry those, `stored` can go.
import { computed, effect, signal, untracked } from "nsh";
import { endpointState, runtimeApiFetch } from "../../lib/core/context.js";

/** A recorded run (the runtime's JobRun). */
export interface JobRunRecord {
  run_id: string;
  job_id: string;
  status: string;
  queued_at: string;
  started_at?: string;
  finished_at?: string;
  error?: string;
  cause: { kind: string; trigger_id: string; from_job_id: string; origin_run_id: string; note: string };
}

/** A job as GET /todo/tasks answers it, as far as the calendar reads it. */
export interface StoredJob {
  id: string;
  triggers?: { id?: string; kind: string; at?: string; cron?: string; tz?: string; channel?: string; chat_id?: string }[];
  uses?: { job_id: string }[];
}

export interface HistoryRange {
  from: Date;
  to: Date;
}

export type HistoryFetch = (pathname: string) => Promise<any>;

/** The most the runtime answers at once (its `limit`'s maximum). */
export const HISTORY_PAGE = 500;
/** As many pages are asked for one range: a month of a job that runs every few minutes ends here. */
export const HISTORY_MAX_PAGES = 12;

function errorText(error: unknown) {
  return String((error as Error)?.message || error || "").trim();
}

/** Every recorded run queued in [from, to), newest first, read page by page. */
export async function fetchHistory(fetch: HistoryFetch, range: HistoryRange, live: () => boolean = () => true): Promise<JobRunRecord[]> {
  const out: JobRunRecord[] = [];
  const seen = new Set<string>();
  let to = range.to.toISOString();
  for (let page = 0; page < HISTORY_MAX_PAGES && live(); page += 1) {
    const query = new URLSearchParams({ from: range.from.toISOString(), to, limit: String(HISTORY_PAGE) });
    const data = await fetch(`/todo/runs/history?${query.toString()}`);
    const items: JobRunRecord[] = Array.isArray(data?.items) ? data.items : [];
    let oldest = "";
    for (const item of items) {
      const id = String(item?.run_id || "");
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      out.push(item);
      const queued = String(item?.queued_at || "");
      if (queued && (!oldest || Date.parse(queued) < Date.parse(oldest))) oldest = queued;
    }
    // A full page may have older runs behind it: ask for the ones queued before its oldest.
    if (items.length < HISTORY_PAGE || !oldest || oldest === to) break;
    to = oldest;
  }
  return out;
}

export interface TodoHistory {
  /** The range's recorded runs, newest first; empty until the first answer. */
  runs: () => JobRunRecord[];
  /** The jobs as stored, by ID; empty until answered, and on a runtime that has none. */
  stored: () => Map<string, StoredJob>;
  /** A new range is being read (not a quiet refresh). */
  loading: () => boolean;
  /** Why the last read of the history failed, or "". The runs shown before stay. */
  error: () => string;
  /** Asks for the history again. */
  reload: () => void;
}

export function createTodoHistory(options: {
  range: () => HistoryRange | null;
  liveKey?: () => string;
  jobsKey?: () => string;
  /** The API helper (tests): the page's own by default. */
  fetch?: HistoryFetch;
}): TodoHistory {
  const fetch: HistoryFetch = options.fetch ?? ((pathname) => runtimeApiFetch(pathname));
  const runs = signal<JobRunRecord[]>([]);
  const stored = signal<Map<string, StoredJob>>(new Map());
  const loading = signal(false);
  const error = signal("");
  const reloads = signal(0);
  let seq = 0;
  let shownRange = "";
  // As values: what the keys are worked out from changes far more often than they do (the page's
  // list is replaced on every load), and only a new value asks again.
  const liveKey = computed(() => options.liveKey?.() ?? "");
  const jobsKey = computed(() => options.jobsKey?.() ?? "");
  const endpoint = computed(() => String(endpointState.selectedRef || "").trim());

  effect(() => {
    const range = options.range();
    const ref = endpoint();
    void liveKey();
    void reloads();
    untracked(() => {
      const mine = ++seq;
      if (!range) return;
      const key = `${ref}|${range.from.toISOString()}|${range.to.toISOString()}`;
      if (key !== shownRange) {
        shownRange = key;
        runs.set([]);
        loading.set(true);
      }
      error.set("");
      fetchHistory(fetch, range, () => mine === seq)
        .then((items) => {
          if (mine !== seq) return;
          runs.set(items);
          loading.set(false);
        })
        .catch((reason) => {
          if (mine !== seq) return;
          console.warn("todo history: load failed", errorText(reason));
          error.set(errorText(reason) || "error");
          loading.set(false);
        });
    });
  });

  let storedSeq = 0;
  effect(() => {
    void endpoint();
    // No jobs on the page: nothing to read triggers for.
    const none = jobsKey() === "";
    untracked(() => {
      const mine = ++storedSeq;
      if (none) {
        stored.set(new Map());
        return;
      }
      fetch("/todo/tasks")
        .then((data) => {
          if (mine !== storedSeq) return;
          const next = new Map<string, StoredJob>();
          for (const item of Array.isArray(data?.tasks) ? (data.tasks as StoredJob[]) : []) {
            const id = String(item?.id || "").trim();
            if (id) next.set(id, item);
          }
          stored.set(next);
        })
        .catch((reason) => {
          // The page's own read of the list reports its failure; the calendar keeps the first schedules.
          if (mine === storedSeq) console.warn("todo history: stored jobs not read", errorText(reason));
        });
    });
  });

  return {
    runs,
    stored,
    loading,
    error,
    reload: () => reloads.update((count) => count + 1),
  };
}
