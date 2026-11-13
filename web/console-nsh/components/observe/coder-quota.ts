// The local coding CLIs' subscription quotas (GET /stats/coder/quota; internal/coderusage): each
// coder's windows (Claude Code's 5-hour and 7-day ones, Codex's weekly one), how much of each is
// used and when it starts again. Pure helpers for the Usage page's Coding agents block.

export type QuotaStatus = "allowed" | "allowed_warning" | "rejected" | "";

export interface QuotaWindow {
  kind: string;
  window_minutes?: number;
  used_percent?: number;
  resets_at?: string;
  status?: QuotaStatus;
}

export interface CoderQuota {
  backend: string;
  plan?: string;
  status?: QuotaStatus;
  windows: QuotaWindow[];
  observed_at: string;
  source?: "run" | "read";
}

export interface CoderQuotaPayload {
  quotas: CoderQuota[];
  available: Record<string, boolean>;
  errors: Record<string, string>;
}

/** The coders, in the order shown, with their names. */
export const CODERS = [
  { backend: "codex", title: "Codex" },
  { backend: "claude", title: "Claude Code" },
] as const;

/** A response as the block reads it: missing or odd fields made empty. */
export function normalizeCoderQuota(data: any): CoderQuotaPayload {
  const quotas = (Array.isArray(data?.quotas) ? data.quotas : [])
    .filter((q: any) => q && typeof q.backend === "string" && q.backend)
    .map((q: any) => ({
      backend: String(q.backend),
      plan: typeof q.plan === "string" ? q.plan : "",
      status: typeof q.status === "string" ? q.status : "",
      observed_at: typeof q.observed_at === "string" ? q.observed_at : "",
      source: q.source === "read" ? "read" : "run",
      windows: (Array.isArray(q.windows) ? q.windows : [])
        .filter((w: any) => w && typeof w.kind === "string")
        .map((w: any) => ({
          kind: w.kind,
          window_minutes: Number(w.window_minutes) > 0 ? Number(w.window_minutes) : 0,
          used_percent: typeof w.used_percent === "number" && Number.isFinite(w.used_percent) ? Math.max(0, Math.min(100, w.used_percent)) : undefined,
          resets_at: typeof w.resets_at === "string" ? w.resets_at : "",
          status: typeof w.status === "string" ? w.status : "",
        })),
    }));
  const available: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(data?.available && typeof data.available === "object" ? data.available : {})) {
    available[key] = value === true;
  }
  const errors: Record<string, string> = {};
  for (const [key, value] of Object.entries(data?.errors && typeof data.errors === "object" ? data.errors : {})) {
    if (typeof value === "string" && value) errors[key] = value;
  }
  return { quotas, available, errors };
}

/** The coders the block shows: those installed here and those that reported a quota. */
export function shownCoders(payload: CoderQuotaPayload) {
  return CODERS.filter(
    (coder) => payload.available[coder.backend] || payload.quotas.some((q) => q.backend === coder.backend),
  ).map((coder) => ({
    ...coder,
    quota: payload.quotas.find((q) => q.backend === coder.backend) ?? null,
    available: payload.available[coder.backend] === true,
    error: payload.errors[coder.backend] ?? "",
  }));
}

/** A window named by its length: "5h", "7d", "7d opus". */
export function windowLabel(w: QuotaWindow): string {
  const minutes = w.window_minutes ?? 0;
  let label = w.kind;
  if (minutes > 0 && minutes % 1440 === 0) label = `${minutes / 1440}d`;
  else if (minutes > 0 && minutes % 60 === 0) label = `${minutes / 60}h`;
  else if (minutes > 0) label = `${minutes}m`;
  for (const model of ["opus", "sonnet"]) {
    if (w.kind.endsWith(`_${model}`)) label += ` ${model}`;
  }
  return label;
}

/** How long until `at`, briefly ("3h10m", "5d 4h", "12m"); "" once it has passed or when unknown. */
export function untilText(at: string | undefined, now: Date = new Date()): string {
  const time = at ? new Date(at).getTime() : NaN;
  if (!Number.isFinite(time)) return "";
  const minutesLeft = Math.round((time - now.getTime()) / 60000);
  if (minutesLeft <= 0) return "";
  const days = Math.floor(minutesLeft / 1440);
  const hours = Math.floor((minutesLeft % 1440) / 60);
  const minutes = minutesLeft % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h${String(minutes).padStart(2, "0")}m` : `${hours}h`;
  return `${minutes}m`;
}

/** The bar's tone: red at the limit or from 90%, amber from 70% or when the CLI warns. */
export function windowTone(w: QuotaWindow): "danger" | "warn" | undefined {
  const used = w.used_percent ?? 0;
  if (w.status === "rejected" || used >= 90) return "danger";
  if (w.status === "allowed_warning" || used >= 70) return "warn";
  return undefined;
}

/**
 * Whether a window has started again since the quota was seen: its reset time has passed, so what
 * it said is no longer what is used (the next run or refresh will say).
 */
export function windowExpired(w: QuotaWindow, now: Date = new Date()): boolean {
  const time = w.resets_at ? new Date(w.resets_at).getTime() : NaN;
  return Number.isFinite(time) && time <= now.getTime();
}
