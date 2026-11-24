// Settings › Runtime (the Vue console's RuntimeView, mounted as RuntimePanel): the selected agent's
// health, its model, its channels with the tasks running in each, process and database metrics and technical
// details, refreshed every minute, and Poke, which wakes the agent's awareness loop with a message.
import type { JSX } from "nsh";
import { batch, cleanup, computed, effect, Image, signal, Text, untracked, View } from "nsh";
import {
  endpointState,
  formatBytes,
  formatShortTime,
  loadEndpoints,
  runtimeApiFetchForEndpoint,
  runtimeEndpointByRef,
  toBool,
  toInt,
} from "../../lib/core/context.js";
import { endpointChannelLabel, endpointDisplayItem } from "../../lib/core/endpoints.js";
import { useNotice } from "../../lib/core/notices.js";
import { reactiveRecord } from "../../lib/stores/reactive-record.js";
import { Button, Icon, StatusMark, Tip } from "../../components/ui";
import { CONTROL_CORNERS } from "../../components/corners";
import { compactNumber } from "../../components/observe/parts";
import { Button as BaseButton } from "nsh/base";
import { isMobile } from "../../lib/shell";
import { createPartProbe, type PartLayoutListener } from "../../components/shared/partProbe";
import { GroupTitle, SettingsCard } from "../../components/settings-page/parts";
import { PokeDialog } from "../../components/settings-page/PokeDialog";
import { CHANNEL_LOGOS } from "./constants";
import { t } from "./i18n";

const POKE_BODY_LIMIT = 10 * 1024;
const CHANNELS = ["telegram", "slack", "line", "lark", "mixin", "discord", "wechat", "whatsapp", "bluesky", "x"];
// The account channels report their connection status.
const STATUS_CHANNELS = new Set(["wechat", "whatsapp", "bluesky", "x"]);
// Where tasks come from besides the channels, in the Console's runtime: its own chat and the chat
// command (`morph chat`), local or over the API. Neither needs configuring.
const LOCAL_ENTRIES: { key: string; title: string; icon: "PhDesktop" | "PhTerminalWindow" }[] = [
  { key: "console", title: "endpoint_channel_console", icon: "PhDesktop" },
  { key: "cli", title: "runtime_entry_cli", icon: "PhTerminalWindow" },
];

/**
 * The tasks running in an entry, as GET /overview's `running_tasks` counts them (tasks in
 * TaskRunning: not queued, waiting on an approval or finished, and each counted once, under what
 * started it). null when the count is unknown: the agent did not take it, or could not.
 */
export function runningTaskCount(runningTasks: unknown, key: string): number | null {
  if (!runningTasks || typeof runningTasks !== "object") return null;
  const value = (runningTasks as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

/** "2 tasks running", "No tasks running", or that the count is unknown, never a guessed 0. */
/** The line under an entry: its running tasks, or nothing when none run (the usual case, not news). */
export function entryTasksText(count: number | null) {
  return count === 0 ? "" : runningTasksText(count);
}

export function runningTasksText(count: number | null) {
  if (count === null) return t("runtime_tasks_running_unknown");
  if (count === 0) return t("runtime_tasks_running_none");
  return t(count === 1 ? "runtime_tasks_running_one" : "runtime_tasks_running_many", { count });
}

/** One database of GET /overview's `runtime.databases`: its file name, never its path. */
export type DatabaseMetric = {
  file: string;
  /** `missing`: not created yet. `unavailable`: there, but it could not be inspected or read. */
  status: "ok" | "missing" | "unavailable";
  /** The file with its write-ahead log; null when unknown. */
  sizeBytes: number | null;
  /** The rows of its counted tables together; null when none could be counted, never a guessed 0. */
  records: number | null;
  /** Some tables could not be counted: `records` is what the others hold, a floor. */
  recordsPartial: boolean;
};

function wholeCount(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * The databases an overview reports, or null when it reports none (an agent of an earlier build,
 * or one without a state folder): "not reported" is not "no databases". Entries without a file
 * name are dropped; a size or count that is not a whole number is unknown. The tables' row counts
 * are added up into the database's records.
 */
export function parseDatabaseMetrics(raw: unknown): DatabaseMetric[] | null {
  if (!Array.isArray(raw)) return null;
  const out: DatabaseMetric[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    const file = String(entry.file || "").trim();
    if (!file) continue;
    const status = entry.status === "ok" || entry.status === "missing" ? entry.status : "unavailable";
    const counts = (Array.isArray(entry.tables) ? entry.tables : [])
      .filter((table) => table && typeof table === "object" && String((table as Record<string, unknown>).name || "").trim())
      .map((table) => wholeCount((table as Record<string, unknown>).rows));
    const known = counts.filter((count): count is number => count !== null);
    const missing = status === "missing";
    out.push({
      file,
      status,
      sizeBytes: missing ? null : wholeCount(entry.size_bytes),
      records: missing || !known.length ? null : known.reduce((sum, count) => sum + count, 0),
      recordsPartial: !missing && known.length > 0 && known.length < counts.length,
    });
  }
  return out;
}

/** 1234567 as "1,234,567". */
export function formatCount(value: number) {
  return String(Math.trunc(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * A record count to show in the database column: whole below 10,000 ("4,222"), compact above it
 * ("1.23M"), as a half-width column has no room for "1,234,567 records" beside a file name.
 */
export function shortCount(value: number) {
  return value < 10000 ? formatCount(value) : compactNumber(value);
}

/** A database's line in the ledger: its file, its records and its size. */
export type DatabaseLine = {
  file: string;
  /** Its size, or its state when it has none to give (not created yet, unreadable). */
  value: string;
  /** `value` is a state in words, not a size. */
  state: boolean;
  /** "4,222 records", "1.23M records" ("4,222+ records" when some tables could not be counted); "" when unknown. */
  records: string;
  /** The same count in full ("1,234,567 records"), for the hover hint and screen readers. */
  recordsExact: string;
  /** What a screen reader hears for the line ("agent.db size"). */
  label: string;
};

function recordsText(db: DatabaseMetric, format: (value: number) => string) {
  if (db.records === null) return "";
  const key = db.recordsPartial ? "runtime_db_records_partial" : db.records === 1 ? "runtime_db_records_one" : "runtime_db_records_many";
  return t(key, { count: format(db.records) });
}

/**
 * One line per database: its file, its records and its size. A missing database, and one that
 * cannot be read and has no size, says that state instead; an unknown size says it is unavailable.
 */
export function databaseLines(databases: DatabaseMetric[]): DatabaseLine[] {
  return databases.map((db) => {
    if (db.status === "missing" || (db.status === "unavailable" && db.sizeBytes === null)) {
      const state = t(db.status === "missing" ? "runtime_db_missing" : "runtime_db_unavailable");
      return { file: db.file, value: state, state: true, records: "", recordsExact: "", label: db.file };
    }
    return {
      file: db.file,
      value: db.sizeBytes === null ? t("runtime_db_unavailable") : formatBytes(db.sizeBytes),
      state: db.sizeBytes === null,
      records: recordsText(db, shortCount),
      recordsExact: recordsText(db, formatCount),
      label: t("runtime_db_size", { file: db.file }),
    };
  });
}

/** What else the overview says about the main loop's model; an agent of an earlier build says none. */
export type ModelDetails = {
  profile: string;
  endpointHost: string;
  /** null when unknown. */
  contextWindowTokens: number | null;
  reasoningEffort: string;
  /** The profiles the main loop spreads its requests over, by weight; empty for one. */
  candidates: { profile: string; model: string; weight: number }[];
  /** In the order they are tried. */
  fallbacks: { profile: string; model: string }[];
};

function trimmed(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

/** GET /overview's `llm` beyond provider and model; anything malformed is left out. */
export function parseModelDetails(llm: Record<string, unknown>): ModelDetails {
  const list = (value: unknown) => (Array.isArray(value) ? value.filter((item) => item && typeof item === "object") : []) as Record<string, unknown>[];
  return {
    profile: trimmed(llm.profile),
    endpointHost: trimmed(llm.endpoint_host),
    contextWindowTokens: wholeCount(llm.context_window_tokens) || null,
    reasoningEffort: trimmed(llm.reasoning_effort),
    candidates: list(llm.candidates)
      .map((item) => ({ profile: trimmed(item.profile), model: trimmed(item.model), weight: wholeCount(item.weight) ?? 0 }))
      .filter((item) => (item.profile || item.model) && item.weight > 0),
    fallbacks: list(llm.fallbacks)
      .map((item) => ({ profile: trimmed(item.profile), model: trimmed(item.model) }))
      .filter((item) => item.profile || item.model),
  };
}

/** "fast (gpt-5.2)", or whichever of the two there is. */
function profileWithModel(item: { profile: string; model: string }) {
  return item.profile && item.model && item.profile !== item.model ? `${item.profile} (${item.model})` : item.profile || item.model;
}

/**
 * The model card's lines after provider and model: only what the agent reported, so an agent of
 * an earlier build shows the two lines it always did.
 */
export function modelDetailRows(details: ModelDetails | null): { key: string; label: string; value: string }[] {
  if (!details) return [];
  const rows: { key: string; label: string; value: string }[] = [];
  if (details.profile) rows.push({ key: "profile", label: t("runtime_model_profile"), value: details.profile });
  if (details.endpointHost) rows.push({ key: "endpoint", label: t("runtime_model_endpoint"), value: details.endpointHost });
  if (details.contextWindowTokens) {
    rows.push({
      key: "context",
      label: t("runtime_model_context_window"),
      value: t("runtime_model_context_tokens", { count: compactNumber(details.contextWindowTokens) }),
    });
  }
  if (details.reasoningEffort) rows.push({ key: "effort", label: t("runtime_model_reasoning"), value: details.reasoningEffort });
  if (details.candidates.length > 1) {
    const total = details.candidates.reduce((sum, item) => sum + item.weight, 0);
    rows.push({
      key: "candidates",
      label: t("runtime_model_candidates"),
      value: details.candidates.map((item) => `${profileWithModel(item)} ${Math.round((item.weight / total) * 100)}%`).join(", "),
    });
  }
  if (details.fallbacks.length) {
    rows.push({ key: "fallbacks", label: t("runtime_model_fallbacks"), value: details.fallbacks.map(profileWithModel).join(" → ") });
  }
  return rows;
}

function stringValue(value: unknown, fallback = "-") {
  const text = String(value || "").trim();
  return text || fallback;
}

export function formatUptime(seconds: unknown) {
  const total = Number(seconds || 0);
  if (!Number.isFinite(total) || total < 0) return "-";
  const whole = Math.trunc(total);
  const days = Math.floor(whole / 86400);
  const hours = Math.floor((whole % 86400) / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

function utf8ByteLength(value: unknown) {
  return new TextEncoder().encode(String(value || "")).length;
}

function emptyOverview() {
  const channels: Record<string, unknown> = {};
  for (const id of CHANNELS) {
    channels[`channel_${id}_configured`] = false;
    channels[`channel_running_${id}`] = false;
    channels[`channel_status_${id}`] = "";
  }
  return {
    version: "-",
    started_at: "",
    uptime_sec: 0,
    health: "",
    mode: "",
    agent_name: "",
    poke_enabled: false,
    awareness_running: false,
    instance_id: "",
    last_poke_at: "",
    llm_provider: "-",
    llm_model: "-",
    runtime_go_version: "-",
    runtime_goroutines: 0,
    runtime_heap_alloc_bytes: 0,
    runtime_heap_sys_bytes: 0,
    runtime_heap_objects: 0,
    runtime_gc_cycles: 0,
    running_tasks: null,
    runtime_databases: null,
    ...channels,
  } as Record<string, any>;
}

type Tone = "healthy" | "stale" | "error" | "unknown";
const MARK: Record<Tone, "on" | "pending" | "error" | "off"> = { healthy: "on", stale: "pending", error: "error", unknown: "off" };

function StatusLabel(props: { tone: Tone; text: string; testID?: string; small?: boolean }) {
  return (
    <View class="min-w-0 flex-row items-center gap-2" testID={props.testID}>
      <StatusMark state={MARK[props.tone]} />
      <Text class={`min-w-0 shrink ${props.small ? "text-xs" : "text-sm"} text-foreground`}>{props.text}</Text>
    </View>
  );
}

/**
 * Label and value rows (`.runtime-ledger`): the label in the panel's grey, the value in mono, a third
 * and two thirds of the row (two fifths and three on phones), 10pt apart on hairlines. `columns`
 * lays the rows out two to a line (`.runtime-metrics`, 32pt apart).
 */
function Ledger(props: { rows: { key: string; label: string; value: string }[]; columns?: 2; testID?: string }) {
  const two = () => props.columns === 2 && !isMobile();
  // The last line has no hairline under it: in two columns, both of its rows.
  const lastLine = (index: number) => index >= props.rows.length - (two() ? props.rows.length % 2 || 2 : 1);
  return (
    <View testID={props.testID} class={two() ? "grid grid-cols-2 gap-x-8" : ""}>
      <Each of={props.rows} key={(row) => row.key}>
        {(row, index) => (
          // Top-aligned, not on the baseline: nsh puts a mono value's baseline above a sans label's,
          // so baseline alignment lifts the value. Both are text-sm at the same line height, so their
          // first lines share one box from the top, and a value that wraps hangs below.
          <View class={`flex-row items-start gap-4 py-2.5 ${lastLine(index()) ? "" : "border-b border-line-soft"}`}>
            <Text class={`min-w-0 ${isMobile() ? "flex-[2]" : "flex-1"} text-sm leading-normal text-subtle`}>{row().label}</Text>
            <View selectable class={`min-w-0 ${isMobile() ? "flex-[3]" : "flex-[2]"}`}>
              <Text class="font-mono text-sm leading-normal tabular-nums text-foreground">{row().value}</Text>
            </View>
          </View>
        )}
      </Each>
    </View>
  );
}

/**
 * The databases, as the metrics above them: two to a line on hairlines when the card is wide enough
 * for a name and a figure in each half (560pt), one otherwise and on a phone; each file's
 * name at the left and one figure at the right edge: its size, or its records. Pressing a figure
 * turns every figure over to the other measure, so the column always holds one kind of number; a
 * database not created yet or unreadable says that in words either way. The last line has no
 * hairline under it, in either column.
 */
function DatabaseLedger(props: { lines: DatabaseLine[]; testID?: string }) {
  const records = signal(false);
  const width = signal(0);
  const two = () => !isMobile() && width() >= 560;
  const lastLine = (index: number) => index >= props.lines.length - (two() ? props.lines.length % 2 || 2 : 1);
  /** The figure a line shows now, and whether it is words (a state) rather than a number. */
  const figure = (line: DatabaseLine) =>
    line.state
      ? { text: line.value, words: true }
      : records()
        ? line.records
          ? { text: line.records, words: false }
          : { text: t("runtime_db_unavailable"), words: true }
        : { text: line.value, words: false };
  return (
    <View testID={props.testID} class={two() ? "grid grid-cols-2 gap-x-8" : ""} onLayout={(event) => width.set(event.bounds.size.width)}>
      <Each of={props.lines} key={(line) => line.file}>
        {(line, index) => (
          <View
            class={`min-h-11 flex-row items-center gap-3 py-1.5 ${lastLine(index()) ? "" : "border-b border-line-soft"}`}
            testID={`runtime-db-${line().file}`}
          >
            <Text class="min-w-0 flex-1 font-mono text-sm leading-normal text-foreground line-clamp-1">{line().file}</Text>
            {/* The press area reaches past the figure by its padding, so the figure stays on the
                column's edge and the hover tint has room around it. */}
            <BaseButton
              onPress={() => records.update((on) => !on)}
              accessibilityLabel={`${line().label}: ${line().value}${line().recordsExact ? `, ${line().recordsExact}` : ""}`}
              tooltip={
                <Tip
                  text={`${records() && line().recordsExact !== line().records ? `${line().recordsExact} · ` : ""}${t(
                    records() ? "runtime_db_show_size" : "runtime_db_show_records",
                  )}`}
                />
              }
              testID={`runtime-db-${line().file}-figure`}
              class={`-mr-2 shrink-0 ${CONTROL_CORNERS} px-2 py-1 hover:bg-hover focus:bg-hover focus:ring-2 focus:ring-blue`}
            >
              <Text
                class={`text-right text-sm leading-normal ${
                  figure(line()).words ? "text-muted-foreground" : "font-mono tabular-nums text-foreground"
                }`}
              >
                {figure(line()).text}
              </Text>
            </BaseButton>
          </View>
        )}
      </Each>
    </View>
  );
}

/**
 * One line of the channels card, on the hairlines the model card beside it has: the entry, how it
 * runs (a channel's status), and its running tasks under its name when there are any.
 */
function RuntimeEntry(props: {
  id: string;
  /** The card's first line: no hairline above it. */
  first?: boolean;
  title: string;
  logo?: JSX.Element;
  status?: { tone: Tone; text: string };
  /** The running tasks' line; none for a channel that does not run. */
  tasks?: string;
  probe?: Record<string, unknown>;
}) {
  return (
    <View
      class={`min-h-11 min-w-0 flex-row items-center gap-2.5 py-2.5 ${props.first ? "" : "border-t border-line-soft"}`}
      testID={`runtime-entry-${props.id}`}
      {...(props.probe || {})}
    >
      <View class="size-5 shrink-0 items-center justify-center">{props.logo}</View>
      {/* A floor for the name: the status beside it shrinks and wraps before it does. */}
      <View class="min-w-[88px] flex-1 gap-0.5">
        <Text class="text-sm leading-normal text-foreground">{props.title}</Text>
        <If when={props.tasks}>
          <Text class="text-xs leading-normal tabular-nums text-subtle" testID={`runtime-entry-${props.id}-tasks`}>
            {props.tasks}
          </Text>
        </If>
      </View>
      <If when={props.status}>
        <View class="min-w-0 shrink">
          <StatusLabel tone={props.status!.tone} text={props.status!.text} />
        </View>
      </If>
    </View>
  );
}

export function RuntimePanel(props: { onPartLayout?: PartLayoutListener } = {}): JSX.Element {
  const parts = createPartProbe(() => props.onPartLayout);
  const notice = useNotice();
  const err = signal("");
  const loading = signal(true);
  const loadedEndpointRef = signal("");
  const lastUpdated = signal("");
  let loadSequence = 0;
  const poking = signal(false);
  const pokeDialogOpen = signal(false);
  const pokeBody = signal("");
  const pokeError = signal("");
  const overview = reactiveRecord(emptyOverview()) as Record<string, any>;

  const selectedEndpoint = computed(() => runtimeEndpointByRef(endpointState.selectedRef) as any);
  const endpointMeta = computed(() => {
    const item = selectedEndpoint();
    return item ? (endpointDisplayItem(item, t) as any) : null;
  });
  const hasData = computed(() => loadedEndpointRef() === endpointState.selectedRef && !!lastUpdated());
  const modeLabel = computed(() => endpointChannelLabel((hasData() && overview.mode) || selectedEndpoint()?.mode || "", t));
  const heroTitle = computed(() => {
    const name = hasData() ? String(overview.agent_name || "").trim() : "";
    return name || endpointMeta()?.title || t("runtime_title");
  });
  const statusTone = computed<Tone>(() => {
    if (!hasData()) return "unknown";
    if (err()) return "stale";
    const health = String(overview.health || "").trim().toLowerCase();
    if (["ok", "healthy", "ready"].includes(health)) return "healthy";
    if (["warn", "warning", "degraded"].includes(health)) return "stale";
    return health ? "error" : "unknown";
  });
  const statusLabel = computed(() => {
    if (!hasData()) return t(loading() ? "runtime_loading" : "runtime_unavailable");
    if (err()) return t("runtime_stale");
    if (statusTone() === "healthy") return t("runtime_healthy");
    return overview.health || t("runtime_unknown");
  });
  const statusRows = computed(() => [
    { key: "uptime", label: t("stat_uptime"), value: formatUptime(overview.uptime_sec) },
    { key: "started", label: t("stat_started"), value: formatShortTime(overview.started_at) },
    {
      key: "poke",
      label: t("runtime_field_last_poke"),
      value: overview.last_poke_at ? formatShortTime(overview.last_poke_at) : t("runtime_status_never"),
    },
  ]);
  const technicalRows = computed(() => [
    { key: "endpoint", label: t("runtime_field_endpoint"), value: endpointMeta()?.title || "-" },
    { key: "reference", label: t("runtime_endpoint_reference"), value: String(endpointState.selectedRef || "") },
    { key: "location", label: t("runtime_field_location"), value: endpointMeta()?.location || "-" },
    { key: "instance", label: t("runtime_field_instance"), value: stringValue(overview.instance_id) },
    { key: "version", label: t("stat_version"), value: stringValue(overview.version) },
    { key: "go", label: t("stat_go_version"), value: stringValue(overview.runtime_go_version) },
  ]);
  const routeRows = computed(() => [
    { key: "provider", label: t("stat_llm_provider"), value: stringValue(overview.llm_provider) },
    { key: "model", label: t("stat_llm_model"), value: stringValue(overview.llm_model) },
    ...modelDetailRows(overview.llm_details as ModelDetails | null),
  ]);
  const runtimeMetrics = computed(() => [
    { key: "goroutines", label: t("stat_goroutines"), value: String(overview.runtime_goroutines || 0) },
    { key: "heap_alloc", label: t("stat_heap_alloc"), value: formatBytes(overview.runtime_heap_alloc_bytes) },
    { key: "heap_sys", label: t("stat_heap_sys"), value: formatBytes(overview.runtime_heap_sys_bytes) },
    { key: "heap_objects", label: t("stat_heap_objects"), value: String(overview.runtime_heap_objects || 0) },
    { key: "gc", label: t("stat_gc_cycles"), value: String(overview.runtime_gc_cycles || 0) },
  ]);
  const databaseLedger = computed(() => {
    const databases = overview.runtime_databases as DatabaseMetric[] | null;
    return databases ? databaseLines(databases) : null;
  });
  const channelRows = computed(() =>
    CHANNELS.map((id) => ({
      key: id,
      title: t(`endpoint_channel_${id}`),
      configured: !!overview[`channel_${id}_configured`],
      running: !!overview[`channel_running_${id}`],
      status: STATUS_CHANNELS.has(id) ? String(overview[`channel_status_${id}`] || "") : "",
    })),
  );
  // The account channels report their connection: a lost session needs a new login, and X can run
  // out of API credits.
  function channelTone(item: { running: boolean; status: string }): Tone {
    if (!item.running) return "unknown";
    if (item.status === "reauth_needed" || item.status === "out_of_credits") return "error";
    if (item.status === "disconnected" || item.status === "connecting") return "stale";
    return "healthy";
  }
  function channelStatusText(item: { running: boolean; status: string }) {
    if (!item.running) return t("runtime_not_running");
    if (item.status === "reauth_needed") return t("runtime_channel_reauth_needed");
    if (item.status === "out_of_credits") return t("runtime_channel_out_of_credits");
    if (item.status === "disconnected") return t("runtime_channel_reconnecting");
    if (item.status === "connecting") return t("runtime_channel_connecting");
    return t("runtime_status_running");
  }
  // The Console's runtime runs its chat and takes the chat command's tasks; another runtime shows
  // them only when it counts them.
  const localEntries = computed(() => {
    const isConsole = String(overview.mode || "").trim().toLowerCase() === "console";
    return LOCAL_ENTRIES.filter((entry) => isConsole || runningTaskCount(overview.running_tasks, entry.key) !== null).map((entry) => ({
      key: entry.key,
      title: t(entry.title),
      icon: entry.icon,
      tasks: entryTasksText(runningTaskCount(overview.running_tasks, entry.key)),
    }));
  });
  const configuredChannels = computed(() => channelRows().filter((item) => item.configured));
  const unconfiguredChannels = computed(() => channelRows().filter((item) => !item.configured));
  const canPoke = computed(() => hasData() && toBool(overview.poke_enabled, false));
  const awarenessRunning = computed(() => toBool(overview.awareness_running, false));
  const pokeDisabled = computed(() => !hasData() || !!err() || poking() || awarenessRunning());
  const pokeBodyTooLarge = computed(() => utf8ByteLength(pokeBody()) > POKE_BODY_LIMIT);
  const pokeSubmitDisabled = computed(() => pokeDisabled() || !String(pokeBody() || "").trim() || pokeBodyTooLarge());

  async function load() {
    const sequence = ++loadSequence;
    loading.set(true);
    try {
      await loadEndpoints();
      if (sequence !== loadSequence) return;
      const endpointRef = endpointState.selectedRef;
      if (!endpointRef) throw new Error(t("msg_select_endpoint"));
      const data: any = await runtimeApiFetchForEndpoint(endpointRef, "/overview");
      if (sequence !== loadSequence || endpointRef !== endpointState.selectedRef) return;
      const llm = data && typeof data.llm === "object" ? data.llm : {};
      const channel = data && typeof data.channel === "object" ? data.channel : {};
      const rt = data && typeof data.runtime === "object" ? data.runtime : {};
      const runningChannel = String(channel.running || "").trim();
      batch(() => {
        overview.version = data.version || "-";
        overview.started_at = data.started_at || "";
        overview.uptime_sec = toInt(data.uptime_sec, 0);
        overview.health = data.health || "";
        overview.mode = data.mode || "";
        overview.agent_name = data.agent_name || "";
        overview.poke_enabled = toBool(data.poke_enabled, false);
        overview.awareness_running = toBool(data.awareness_running, false);
        overview.instance_id = data.instance_id || "";
        overview.last_poke_at = data.last_poke_at || "";
        overview.llm_provider = llm.provider || "-";
        overview.llm_model = llm.model || "-";
        overview.llm_details = parseModelDetails(llm);
        for (const id of CHANNELS) {
          const running = toBool(channel[`${id}_running`], false) || runningChannel === id;
          overview[`channel_running_${id}`] = running;
          overview[`channel_${id}_configured`] = toBool(channel[`${id}_configured`], false) || running;
          if (STATUS_CHANNELS.has(id)) overview[`channel_status_${id}`] = String(channel[`${id}_status`] || "").trim();
        }
        overview.runtime_go_version = rt.go_version || "-";
        overview.runtime_goroutines = toInt(rt.goroutines, 0);
        overview.runtime_heap_alloc_bytes = toInt(rt.heap_alloc_bytes, 0);
        overview.runtime_heap_sys_bytes = toInt(rt.heap_sys_bytes, 0);
        overview.runtime_heap_objects = toInt(rt.heap_objects, 0);
        overview.runtime_gc_cycles = toInt(rt.gc_cycles, 0);
        overview.runtime_databases = parseDatabaseMetrics(rt.databases);
        overview.running_tasks = data && typeof data.running_tasks === "object" ? data.running_tasks : null;
        loadedEndpointRef.set(endpointRef);
        lastUpdated.set(new Date().toISOString());
        err.set("");
      });
    } catch (e: any) {
      if (sequence === loadSequence) err.set(e?.message || t("msg_load_failed"));
    } finally {
      if (sequence === loadSequence) loading.set(false);
    }
  }

  function openPokeDialog() {
    if (untracked(pokeDisabled)) return;
    batch(() => {
      pokeBody.set("");
      pokeError.set("");
      pokeDialogOpen.set(true);
    });
  }

  function closePokeDialog() {
    if (untracked(poking)) return;
    batch(() => {
      pokeDialogOpen.set(false);
      pokeError.set("");
    });
  }

  function updatePokeBody(value: string) {
    batch(() => {
      pokeBody.set(String(value || ""));
      if (untracked(pokeError)) pokeError.set("");
    });
  }

  async function submitPoke() {
    if (untracked(pokeDisabled)) return;
    const endpointRef = endpointState.selectedRef;
    const body = String(untracked(pokeBody) || "").trim();
    if (!body) {
      pokeError.set(t("runtime_poke_empty"));
      return;
    }
    if (utf8ByteLength(body) > POKE_BODY_LIMIT) {
      pokeError.set(t("runtime_poke_too_large"));
      return;
    }
    poking.set(true);
    try {
      const data: any = await runtimeApiFetchForEndpoint(endpointRef, "/poke", {
        method: "POST",
        headers: { "Content-Type": "text/plain; charset=utf-8" },
        body,
      });
      if (endpointRef !== endpointState.selectedRef) return;
      batch(() => {
        if (typeof data?.poked_at === "string") overview.last_poke_at = data.poked_at;
        pokeDialogOpen.set(false);
        pokeBody.set("");
        pokeError.set("");
      });
      notice.success(t("runtime_poke_ok"));
    } catch (e: any) {
      const message = e?.message || t("msg_load_failed");
      if (e?.status === 400 || e?.status === 413) pokeError.set(message);
      else notice.error(message);
    } finally {
      poking.set(false);
    }
  }

  // Load now, then every minute; another endpoint starts over.
  let previousRef: string | undefined;
  effect(() => {
    const ref = endpointState.selectedRef;
    untracked(() => {
      if (previousRef !== undefined && previousRef !== ref) {
        batch(() => {
          loadedEndpointRef.set("");
          lastUpdated.set("");
          err.set("");
          pokeDialogOpen.set(false);
          pokeError.set("");
        });
      }
      previousRef = ref;
      void load();
    });
  });
  const refreshTimer = setInterval(() => void load(), 60000);
  cleanup(() => {
    loadSequence += 1;
    clearInterval(refreshTimer);
  });

  return (
    <View class="gap-[18px] pb-6" testID="runtime-panel" {...parts.probe(() => "panel")}>
      <SettingsCard
        title={heroTitle()}
        literal
        metaLead={
          <View class="flex-row items-center gap-3.5">
            <Text class="text-xs text-muted-foreground">{modeLabel()}</Text>
            <StatusLabel small tone={statusTone()} text={statusLabel()} testID="runtime-status" />
          </View>
        }
        actions={
          <If when={canPoke()}>
            <Button variant="plain" size="xs" label={t("runtime_action_poke")} loading={poking()} disabled={pokeDisabled()} onPress={openPokeDialog} testID="runtime-poke" />
          </If>
        }
      >
        <If when={canPoke() && awarenessRunning()}>
          <Text class="text-sm leading-normal text-subtle">{t("runtime_poke_busy")}</Text>
        </If>
        <Text class="min-h-[21px] text-sm leading-normal text-subtle" testID="runtime-update">
          {loading()
            ? t("runtime_loading")
            : hasData()
              ? t("runtime_updated", { time: formatShortTime(lastUpdated()) })
              : t("runtime_no_data")}
        </Text>
        <If when={err()}>
          <View role="alert" class="gap-1" testID="runtime-error">
            <Text class="text-sm text-danger">{err()}</Text>
            <If when={hasData()}>
              <Text class="text-xs text-muted-foreground">{t("runtime_stale_hint")}</Text>
            </If>
          </View>
        </If>
        <If when={hasData()}>
          <Ledger rows={statusRows()} testID="runtime-status-rows" />
        </If>
      </SettingsCard>

      <If when={hasData()}>
        {/* Side by side on wide windows, sharing the row's width; stacked on phones, where each
            card is as tall as what it holds (flex-1 in a column would split the column's height
            between them, and the channels card would draw past its own bottom edge). */}
        <View class={isMobile() ? "gap-[18px]" : "flex-row items-start gap-[18px]"}>
          <View class={isMobile() ? "min-w-0" : "min-w-0 flex-1"} {...parts.probe(() => "model")}>
            <SettingsCard title={t("runtime_current_model")} list>
              <Ledger rows={routeRows()} testID="runtime-model" />
            </SettingsCard>
          </View>
          <View class={isMobile() ? "min-w-0" : "min-w-0 flex-1"} {...parts.probe(() => "channels")}>
            <SettingsCard title={t("group_channels")} testID="runtime-channels" list>
              {/* One child of the card's body, whose children are 16pt apart: the lines meet on
                  their hairlines, as the model card's do. */}
              <View>
              <Each of={localEntries()} key={(item) => item.key}>
                {(item, index) => (
                  <RuntimeEntry
                    id={item().key}
                    first={index() === 0}
                    title={item().title}
                    logo={<Icon name={item().icon} size={18} color="subtle" />}
                    tasks={item().tasks}
                    probe={parts.probe(() => `entry-${item().key}`)}
                  />
                )}
              </Each>
              <Each of={configuredChannels()} key={(item) => item.key}>
                {(item, index) => (
                  <RuntimeEntry
                    id={item().key}
                    first={index() === 0 && !localEntries().length}
                    title={item().title}
                    logo={<Image class="overflow-hidden" src={CHANNEL_LOGOS[item().key]} accessibilityElementsHidden style={{ width: 20, height: 20 }} />}
                    status={{ tone: channelTone(item()), text: channelStatusText(item()) }}
                    tasks={item().running ? entryTasksText(runningTaskCount(overview.running_tasks, item().key)) : ""}
                    probe={parts.probe(() => `entry-${item().key}`)}
                  />
                )}
              </Each>
              <If when={unconfiguredChannels().length}>
                {/* The channels that could run here: named under their own head, their logos
                    dimmed, as a wrap of small entries rather than lines, so they stay quieter
                    than the ones that run. */}
                <View
                  class={`gap-2.5 pb-2.5 pt-3 ${localEntries().length || configuredChannels().length ? "border-t border-line-soft" : ""}`}
                  testID="runtime-unconfigured"
                >
                  <GroupTitle text={t("runtime_status_not_configured")} />
                  <View class="min-w-0 flex-row flex-wrap gap-x-5 gap-y-2.5" testID="runtime-unconfigured-list">
                    <Each of={unconfiguredChannels()} key={(item) => item.key}>
                      {(item) => (
                        <View class="min-w-0 max-w-full flex-row items-center gap-2" {...parts.probe(() => `unconfigured-${item().key}`)}>
                          <Image
                            class="overflow-hidden opacity-60"
                            src={CHANNEL_LOGOS[item().key]}
                            accessibilityElementsHidden
                            style={{ width: 16, height: 16 }}
                          />
                          <Text class="min-w-0 shrink text-sm leading-normal text-subtle">{item().title}</Text>
                        </View>
                      )}
                    </Each>
                  </View>
                </View>
              </If>
              </View>
            </SettingsCard>
          </View>
        </View>

        <View {...parts.probe(() => "metrics")}>
          <SettingsCard title={t("group_runtime")} list>
            <Ledger rows={runtimeMetrics()} columns={2} testID="runtime-metrics" />
            {/* Two columns, as the metrics: each database's file, its records and its size. */}
            <View class="gap-1 border-t border-line-soft pb-1 pt-3" testID="runtime-databases" {...parts.probe(() => "databases")}>
              <GroupTitle text={t("runtime_databases")} />
              <If
                when={databaseLedger()}
                else={
                  <Text class="py-2.5 text-sm leading-normal text-subtle" testID="runtime-databases-unreported">
                    {t("runtime_databases_unreported")}
                  </Text>
                }
              >
                <DatabaseLedger lines={databaseLedger() || []} testID="runtime-database-rows" />
              </If>
            </View>
          </SettingsCard>
        </View>

        <SettingsCard title={t("runtime_technical_details")} list testID="runtime-technical-card">
          <Ledger rows={technicalRows()} columns={2} testID="runtime-technical" />
        </SettingsCard>
      </If>

      <PokeDialog
        open={pokeDialogOpen()}
        onClose={closePokeDialog}
        body={pokeBody()}
        onBodyChange={updatePokeBody}
        bodyTooLarge={pokeBodyTooLarge()}
        disabled={poking()}
        error={pokeError()}
        submitDisabled={pokeSubmitDisabled()}
        submitting={poking()}
        onSubmit={() => void submitPoke()}
      />
    </View>
  );
}
