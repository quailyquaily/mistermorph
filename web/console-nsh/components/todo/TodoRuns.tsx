// Runs, newest first, as a timeline: one job's (its page's Runs column), or every job's today (the
// list's Today column). They come from the runtime's run history (GET /todo/runs/history), which
// keeps why each run started: a schedule, a person, a poke, a message, or another job. A runtime
// without that history shows nothing here (`onAvailable(false)`): the page then keeps its single
// last-run line.
//
// A row says each thing once: the mark is the outcome (the turning ring while it runs, filled when
// it finished, the error colour when it failed, hollow when it was stopped or skipped), so a
// finished run has no "Finished"; words are kept for what a mark cannot say (why it failed, what it
// was skipped for).
import { effect, signal, Text, untracked, View } from "nsh";
import { Button as BaseButton } from "nsh/base";
import { currentLocale, endpointState, runtimeApiFetchForEndpoint, translate } from "../../lib/core/context.js";
import { formatDate } from "../../lib/core/intl-format.js";
import { StatusMark, type StatusState } from "../ui";

const t = translate as (key: string, vars?: Record<string, unknown> | null) => string;

export interface TodoRunCause {
  kind: string;
  trigger_id: string;
  from_job_id: string;
  origin_run_id: string;
  note: string;
}

export interface TodoHistoryRun {
  run_id: string;
  job_id: string;
  status: string;
  queued_at: string;
  started_at?: string;
  finished_at?: string;
  error?: string;
  cause: TodoRunCause;
}

/** The mark of a run's status. */
export function runMarkState(status: string): StatusState {
  if (status === "running") return "running";
  if (status === "queued") return "pending";
  if (status === "done") return "on";
  if (status === "failed") return "error";
  return "off";
}

/** Why a run started, in words; `jobTitle` names the job that started it. */
export function runCauseText(cause: TodoRunCause | undefined, jobTitle: (id: string) => string): string {
  switch (cause?.kind) {
    case "schedule":
      return t("todo_cause_schedule");
    case "poke":
      return t("todo_cause_poke");
    case "message":
      return t("todo_cause_message");
    case "job":
      return cause.from_job_id ? t("todo_cause_job", { job: jobTitle(cause.from_job_id) }) : t("todo_cause_job_unknown");
    default:
      return t("todo_cause_manual");
  }
}

/** How long a finished run took ("41 s", "3 min"), or "" while it has no end. */
export function runDurationText(run: TodoHistoryRun): string {
  const from = Date.parse(run.started_at || "");
  const to = Date.parse(run.finished_at || "");
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return "";
  const seconds = Math.round((to - from) / 1000);
  return seconds < 90 ? t("todo_run_seconds", { count: seconds }) : t("todo_run_minutes", { count: Math.round(seconds / 60) });
}

/** What a mark cannot say about how a run ended: why it failed, or what it was skipped for. */
export function runOutcomeText(run: TodoHistoryRun): string {
  if (run.status === "failed") return run.error ? t("todo_run_failed_why", { error: run.error }) : t("todo_run_status_failed");
  if (run.status === "skipped") return run.cause?.note ? t("todo_run_skipped_why", { note: run.cause.note }) : t("todo_run_status_skipped");
  if (run.status === "canceled") return t("todo_run_status_canceled");
  if (run.status === "queued") return t("todo_run_state_queued");
  return "";
}

function startOfToday(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function timeText(value: string, today: boolean): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const locale = currentLocale() as string;
  const clock = formatDate(date, locale, { hour: "2-digit", minute: "2-digit" }) as string;
  if (today || date >= startOfToday()) return clock;
  return `${formatDate(date, locale, { month: "short", day: "numeric" })} ${clock}`;
}

export function TodoRuns(props: {
  /** One job's runs; without it, every job's runs of today. */
  jobID?: string;
  title: string;
  jobTitle: (id: string) => string;
  /** Read again whenever this changes (the page's live runs). */
  watch?: () => unknown;
  onOpenJob?: (id: string) => void;
  /** Whether the runtime keeps a history (false: nothing is shown). */
  onAvailable?: (available: boolean) => void;
  class?: string;
  testID?: string;
}) {
  const runs = signal<TodoHistoryRun[]>([]);
  // null until the first answer; false for a runtime without the history.
  const available = signal<boolean | null>(null);
  const today = () => !props.jobID;
  let request = 0;

  effect(() => {
    const endpointRef = endpointState.selectedRef as string;
    const jobID = props.jobID ?? "";
    props.watch?.();
    untracked(() => {
      if (!endpointRef) return;
      const mine = ++request;
      const query = jobID ? `job_id=${encodeURIComponent(jobID)}&limit=30` : `from=${encodeURIComponent(startOfToday().toISOString())}&limit=100`;
      void (runtimeApiFetchForEndpoint(endpointRef, `/todo/runs/history?${query}`) as Promise<{ items?: TodoHistoryRun[] }>)
        .then((data) => {
          if (mine !== request) return;
          runs.set(Array.isArray(data?.items) ? data.items : []);
          available.set(true);
          props.onAvailable?.(true);
        })
        .catch(() => {
          if (mine !== request) return;
          // Keep what is shown when a later read fails; a first failure means no history here.
          if (untracked(available) === null) {
            available.set(false);
            props.onAvailable?.(false);
          }
        });
    });
  });

  return (
    <If when={available()}>
      <View class={`gap-2 ${props.class ?? ""}`} accessibilityLabel={props.title} testID={props.testID ?? "todo-runs"}>
        <Text class="px-1.5 text-xl font-normal leading-[24px] tracking-[-0.6px] text-foreground" role="header">
          {props.title}
        </Text>
        <If
          when={runs().length > 0}
          else={<Text class="px-1.5 text-[13px] leading-[20px] text-muted-foreground">{t(today() ? "todo_runs_none_today" : "todo_last_run_never")}</Text>}
        >
          <View role="list">
            <Each of={runs()} key={(run) => run.run_id}>
              {(run) => (
                <BaseButton
                  onPress={() => props.onOpenJob?.(run().job_id)}
                  disabled={!props.onOpenJob || !today()}
                  accessibilityLabel={`${timeText(run().queued_at, today())}, ${today() ? `${props.jobTitle(run().job_id)}, ` : ""}${runCauseText(run().cause, props.jobTitle)}, ${t(`todo_run_status_${run().status}`)}`}
                  testID={`todo-run-row-${run().run_id}`}
                  class="flex-row gap-2.5 rounded-(--radius) px-1.5 hover:bg-hover-faint disabled:hover:bg-transparent"
                >
                  <Text class="w-[74px] pt-2 font-mono text-xs leading-[16.2px] text-muted-foreground">{timeText(run().queued_at, today())}</Text>
                  {/* The spine: a hairline through every row, the run's mark on it. */}
                  <View class="w-[9px] items-center">
                    <View class="h-3 w-px bg-line" />
                    <StatusMark state={runMarkState(run().status)} size={7} corner={2} />
                    <View class="w-px flex-1 bg-line" />
                  </View>
                  <View class="min-w-0 flex-1 gap-0.5 pb-[9px] pt-[7px]">
                    <Text class="text-sm leading-[18px] text-foreground">
                      {today() ? props.jobTitle(run().job_id) : runCauseText(run().cause, props.jobTitle)}
                    </Text>
                    <Text class={`text-xs leading-[16.2px] ${run().status === "failed" ? "text-danger" : "text-muted-foreground"}`}>
                      {[today() ? runCauseText(run().cause, props.jobTitle) : "", runOutcomeText(run()), run().status === "done" ? runDurationText(run()) : ""]
                        .filter(Boolean)
                        .join(t("todo_when_separator"))}
                    </Text>
                  </View>
                </BaseButton>
              )}
            </Each>
          </View>
        </If>
      </View>
    </If>
  );
}
