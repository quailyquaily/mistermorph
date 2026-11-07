// Logs (the Vue console's LogsView): the selected agent's runtime log, tailed every 4 seconds.
// Lines are grouped by local day (the day header sticks while its lines scroll) and marked where
// the file changes; each line opens to its fields and raw JSON. Search, level, event and time
// filters narrow what is loaded; Load older pages back; the line count sets the page size.
// Following keeps the newest line in view until the reader scrolls up, filters or opens a line;
// then a note says when newer logs came. Export saves the lines shown as a text file.
import type { ListRef } from "nsh";
import { batch, cleanup, computed, effect, List, signal, Text, token, untracked, View, windowSize } from "nsh";
import { Button as BaseButton } from "nsh/base";
import { currentLocale, endpointState, formatBytes, formatShortTime, runtimeApiFetchForEndpoint } from "../../lib/core/context.js";
import { filterLogEntries, logClock, logDayKey, logDayLabel, logFieldPreview, logSnapshotKey, parseLogLine } from "../../lib/core/logs.js";
import { contentKeys, createArrivalTracker, createHighlightWindow } from "../../lib/core/arrivals.js";
import { pushNotice } from "../../lib/core/notices.js";
import { isVisible, saveFile } from "../../lib/platform";
import { hint, ObserveSection, t } from "../../components/observe/parts";
import { SCROLLBAR } from "../../components/motion";
import { gutterX, gutterY } from "../../components/frame/metrics";
import { isMobile } from "../../lib/shell";
import type { IconName } from "../../components/icons";
import { Button, Icon, Page, ProgressBar, SelectField, Skeleton, TextField } from "../../components/ui";

const LIMIT_OPTIONS = [100, 300, 1000];
const LEVEL_OPTIONS = ["", "issues", "error", "warn", "info", "debug"];
const TIME_OPTIONS = [0, 15, 60, 1440];
const POLL_MS = 4000;
const HIGHLIGHT_MS = 1800;
const COMPACT_WIDTH = 620;

interface LogEntry {
  id: number;
  line: string;
  level: string;
  time: string;
  event: string;
  msg: string;
  fields: [string, string][];
  preview: [string, string][];
  file: string;
  arrivalKey?: string;
}

type Row =
  | { type: "day"; key: string; label: string }
  | { type: "file"; key: string; label: string }
  | { type: "entry"; key: string; entry: LogEntry; clock: string };

// Vue's .logs-level: muted, warn and error in their colour and weight, debug and raw lines faint.
const LEVEL_TEXT: Record<string, string> = {
  error: "font-semibold text-danger",
  warn: "font-semibold text-warn-dark",
  info: "font-medium text-muted-foreground",
  debug: "font-medium text-muted-foreground opacity-60",
};
// Vue's --logs-cols: time 96, level 68, the message, a 12pt chevron; 16 apart.
const TIME_W = 96;
const LEVEL_W = 68;
const LABEL = "font-mono text-[11px] font-medium uppercase leading-[15.4px] tracking-[0.12em]";
const errorHatch = () => `repeating-linear-gradient(-45deg, color-mix(in srgb, ${token("danger")} 9%, transparent) 0 1px, transparent 1px 7px)`;

export function LogsPage() {
  const err = signal("");
  const unsupported = signal(false);
  const loading = signal(false);
  const loadingOlder = signal(false);
  const limit = signal(300);
  const query = signal("");
  const level = signal("");
  const event = signal("");
  const timeRange = signal(0);
  const snapshotTime = signal(Date.now());
  const following = signal(true);
  const hasNewer = signal(false);
  const entries = signal<LogEntry[]>([]);
  const currentFile = signal("");
  const modTime = signal("");
  const sizeBytes = signal(0);
  const nextCursor = signal("");
  const open = signal<Record<number, boolean>>({});
  const rawOpen = signal<Record<number, boolean>>({});
  const filtersOpen = signal(false);
  const exporting = signal(false);
  let list: ListRef | undefined;
  let snapshotKey: string | null = null;
  let generation = 0;
  let entrySeq = 0;
  let disposed = false;

  const compact = () => windowSize().width <= COMPACT_WIDTH;

  // New lines at the bottom flash briefly; the first load, older pages and agent switches do not.
  const arrivals = createArrivalTracker({ edge: "end" });
  const arrivedRows = createHighlightWindow(HIGHLIGHT_MS);
  const arrivedTick = signal(0);
  const highlightTimers = new Set<ReturnType<typeof setTimeout>>();
  effect(() => {
    const items = entries();
    untracked(() => {
      const keys = contentKeys(items.map((entry) => `${entry.file}\n${entry.line}`));
      items.forEach((entry, index) => {
        entry.arrivalKey = keys[index];
      });
      const arrived = arrivals.update(keys, `${endpointState.selectedRef}|${limit()}`);
      if (arrived.size > 0) {
        arrivedRows.add(arrived);
        arrivedTick.update((n) => n + 1);
        const id = setTimeout(() => {
          highlightTimers.delete(id);
          if (!disposed) arrivedTick.update((n) => n + 1);
        }, HIGHLIGHT_MS + 50);
        highlightTimers.add(id);
      }
    });
  });
  const isArrived = (entry: LogEntry) => arrivedTick() >= 0 && arrivedRows.has(entry.arrivalKey ?? "");

  const filterActive = () => Boolean(query().trim() || level() || event() || timeRange());
  const filteredEntries = computed<LogEntry[]>(() =>
    (filterLogEntries as any)(entries(), query(), level(), {
      event: event(),
      since: timeRange() ? snapshotTime() - timeRange() * 60000 : null,
    }),
  );
  // Rows: a day header where the local day changes (sticky), a file marker where the file does.
  const rows = computed<Row[]>(() => {
    const locale = currentLocale();
    const out: Row[] = [];
    let prevDay = "";
    let prevFile = untracked(currentFile);
    let first = true;
    for (const entry of filteredEntries()) {
      const day = logDayKey(entry.time);
      if (first || (day && day !== prevDay)) {
        const label = day ? logDayLabel(entry.time, locale) : "";
        if (label) out.push({ type: "day", key: `day:${day}:${entry.id}`, label });
        first = false;
      }
      if (entry.file && entry.file !== prevFile) out.push({ type: "file", key: `file:${entry.id}`, label: entry.file });
      out.push({ type: "entry", key: `entry:${entry.id}`, entry, clock: logClock(entry.time, locale) });
      if (day) prevDay = day;
      if (entry.file) prevFile = entry.file;
    }
    return out;
  });
  const dayIndices = () => rows().flatMap((row, index) => (row.type === "day" ? [index] : []));
  const activeFilterCount = () => [level(), event(), timeRange()].filter(Boolean).length;
  const eventOptions = () => [
    { value: "", label: t("logs_all_events") },
    ...Array.from(new Set([...entries().map((entry) => entry.event), event()].filter(Boolean)))
      .sort()
      .map((value) => ({ value, label: value })),
  ];
  const levelOptions = () =>
    LEVEL_OPTIONS.map((value) => ({
      value,
      label: value === "" ? t("logs_all_levels") : value === "issues" ? t("logs_issues") : value.toUpperCase(),
    }));
  const timeOptions = () => TIME_OPTIONS.map((value) => ({ value: String(value), label: t(`logs_time_${value}`) }));
  const metaText = () =>
    [modTime() ? t("logs_updated", { value: formatShortTime(modTime()) }) : "", sizeBytes() > 0 ? formatBytes(sizeBytes()) : ""]
      .filter(Boolean)
      .join(" · ");
  const emptyText = () =>
    unsupported() ? t("logs_unsupported") : !endpointState.selectedRef ? t("msg_select_endpoint") : t("logs_empty");

  function toEntries(payload: any): LogEntry[] {
    return (Array.isArray(payload?.items) ? payload.items : []).map((line: unknown) => {
      const entry = parseLogLine(line) as Omit<LogEntry, "id" | "preview" | "file">;
      return { ...entry, preview: logFieldPreview(entry.fields), id: ++entrySeq, file: String(payload?.file || "") } as LogEntry;
    });
  }

  function scrollToBottom() {
    setTimeout(() => {
      if (!disposed) list?.scrollToEnd({ animated: false });
    }, 0);
  }

  async function loadLatest({ force = false } = {}) {
    const endpointRef = String(untracked(() => endpointState.selectedRef) || "");
    if (untracked(loading) || untracked(loadingOlder) || !endpointRef) return;
    const requestGeneration = generation;
    loading.set(true);
    try {
      const data: any = await runtimeApiFetchForEndpoint(endpointRef, `/logs/latest?limit=${untracked(limit)}`);
      if (requestGeneration !== generation) return;
      const key = logSnapshotKey(data);
      const changed = key !== snapshotKey;
      batch(() => {
        err.set("");
        unsupported.set(false);
        if (snapshotKey === null || force || (untracked(following) && changed)) {
          currentFile.set(String(data?.file || ""));
          modTime.set(String(data?.mod_time || ""));
          sizeBytes.set(Number(data?.size_bytes || 0));
          nextCursor.set(data?.has_next ? String(data.next_cursor || "") : "");
          entries.set(toEntries(data));
          snapshotTime.set(Date.now());
          rawOpen.set({});
          snapshotKey = key;
          hasNewer.set(false);
          scrollToBottom();
        } else {
          hasNewer.set(changed);
        }
      });
    } catch (e: any) {
      if (requestGeneration !== generation) return;
      if (e?.status === 404) {
        batch(() => {
          unsupported.set(true);
          entries.set([]);
          rawOpen.set({});
          currentFile.set("");
          modTime.set("");
          sizeBytes.set(0);
          nextCursor.set("");
          hasNewer.set(false);
          err.set("");
        });
        snapshotKey = null;
      } else {
        err.set(e?.message || t("msg_load_failed"));
      }
    } finally {
      if (requestGeneration === generation) loading.set(false);
    }
  }

  async function loadOlder() {
    const cursor = untracked(nextCursor);
    if (!cursor || untracked(loadingOlder) || untracked(loading)) return;
    following.set(false);
    const requestGeneration = generation;
    batch(() => {
      loadingOlder.set(true);
      err.set("");
    });
    try {
      const data: any = await runtimeApiFetchForEndpoint(
        endpointState.selectedRef,
        `/logs/latest?limit=${untracked(limit)}&cursor=${encodeURIComponent(cursor)}`,
      );
      if (requestGeneration !== generation) return;
      batch(() => {
        entries.update((current) => toEntries(data).concat(current));
        nextCursor.set(data?.has_next ? String(data.next_cursor || "") : "");
      });
    } catch (e: any) {
      if (requestGeneration === generation) err.set(e?.message || t("msg_load_failed"));
    } finally {
      if (requestGeneration === generation) loadingOlder.set(false);
    }
  }

  function resumeFollowing() {
    following.set(true);
    void loadLatest({ force: true });
  }

  function reset() {
    generation += 1;
    snapshotKey = null;
    batch(() => {
      loading.set(false);
      loadingOlder.set(false);
      entries.set([]);
      rawOpen.set({});
      open.set({});
      currentFile.set("");
      modTime.set("");
      sizeBytes.set(0);
      nextCursor.set("");
      err.set("");
      unsupported.set(false);
      hasNewer.set(false);
      following.set(!untracked(filterActive));
    });
    void loadLatest();
  }

  function clearFilters() {
    batch(() => {
      query.set("");
      level.set("");
      event.set("");
      timeRange.set(0);
    });
  }

  const toggleOpen = (id: number) => {
    const opening = !untracked(open)[id];
    batch(() => {
      open.update((map) => ({ ...map, [id]: opening }));
      if (opening) following.set(false);
    });
  };
  const toggleRaw = (id: number) => rawOpen.update((map) => ({ ...map, [id]: !map[id] }));
  const levelLabel = (value: string) => (value ? value.toUpperCase() : "RAW");

  async function exportLogs() {
    const lines = untracked(filteredEntries).map((entry) => entry.line);
    if (lines.length === 0) return;
    const base = String(untracked(currentFile) || "mistermorph").split(/[\\/]/).pop() || "mistermorph";
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    exporting.set(true);
    try {
      await saveFile({ name: `${base.replace(/\.(jsonl|log|txt)$/i, "")}-${stamp}.log`, text: `${lines.join("\n")}\n`, type: "text/plain" });
    } catch (e: any) {
      console.warn("logs: export failed", e);
      pushNotice({ type: "error", text: e?.message || t("msg_save_failed") });
    } finally {
      exporting.set(false);
    }
  }

  // Filtering stops following; the selected agent and the line count start over.
  let filterRuns = 0;
  effect(() => {
    query();
    level();
    event();
    timeRange();
    untracked(() => {
      if (filterRuns++ > 0) following.set(false);
    });
  });
  effect(() => {
    void endpointState.selectedRef;
    limit();
    untracked(reset);
  });

  const timer = setInterval(() => {
    if (!disposed && isVisible() && !untracked(unsupported)) void loadLatest();
  }, POLL_MS);
  cleanup(() => {
    disposed = true;
    generation += 1;
    clearInterval(timer);
    highlightTimers.forEach((id) => clearTimeout(id));
  });

  const followLabel = () => t(following() ? "logs_pause_follow" : "logs_resume_follow");

  function FilterGroup() {
    return (
      <>
        <SelectField
          items={levelOptions()}
          value={level()}
          onChange={(value) => level.set(value)}
          placeholder={t("logs_level")}
          class={compact() ? "flex-1" : "shrink grow basis-[100px]"}
          testID="logs-level"
        />
        <SelectField
          items={eventOptions()}
          value={event()}
          onChange={(value) => event.set(value)}
          placeholder={t("logs_event")}
          searchable
          class={compact() ? "w-full" : "shrink grow basis-[140px]"}
          testID="logs-event"
        />
        <SelectField
          items={timeOptions()}
          value={String(timeRange())}
          onChange={(value) => timeRange.set(Number(value) || 0)}
          placeholder={t("logs_time_range")}
          class={compact() ? "flex-1" : "shrink grow basis-[110px]"}
          testID="logs-time"
        />
      </>
    );
  }

  /** The level as Vue draws it: "[ INFO ]", the brackets faint unless the level is a problem. */
  function Level(props: { level: string }) {
    const issue = () => props.level === "warn" || props.level === "error";
    const tone = () => LEVEL_TEXT[props.level] ?? "font-medium text-muted-foreground opacity-60";
    return (
      <View class="flex-row items-baseline self-start" style={compact() ? undefined : { width: LEVEL_W }}>
        <Text class={`font-mono text-[11px] leading-normal ${issue() ? tone() : "text-muted-foreground opacity-55"}`}>[</Text>
        <Text class={`mx-1.25 font-mono text-[11px] leading-normal tracking-[0.06em] ${tone()}`}>{levelLabel(props.level)}</Text>
        <Text class={`font-mono text-[11px] leading-normal ${issue() ? tone() : "text-muted-foreground opacity-55"}`}>]</Text>
      </View>
    );
  }

  function EntryRow(props: { entry: LogEntry; clock: string }) {
    const isOpen = () => Boolean(open()[props.entry.id]);
    const message = () => (
      <Text class={`font-mono text-xs leading-normal text-muted-foreground line-clamp-1 ${compact() ? "" : "flex-1"}`}>
        <Text class={props.entry.level === "error" ? "text-danger" : props.entry.event ? "text-foreground" : "text-subtle"}>{props.entry.msg}</Text>
        {props.entry.preview.map(([key, value]) => (
          <Text>
            {"    "}
            <Text class="opacity-70">{key}=</Text>
            {value}
          </Text>
        ))}
      </Text>
    );
    const chevron = () => (
      <View
        class="w-3 items-center"
        style={{
          opacity: isOpen() ? 1 : 0.45,
          transform: [{ rotate: isOpen() ? 90 : 0 }],
          transitionProperty: "transform, opacity",
          transitionDuration: 180,
        }}
      >
        <Icon name="PhCaretRight" size={12} color="muted-foreground" />
      </View>
    );
    return (
      <View
        class={`border-b border-line-soft/60 ${isArrived(props.entry) ? "bg-selection-strong" : ""}`}
        // An arrival's tint holds, then fades back (Vue's .is-arrived).
        style={{ transitionProperty: "colors", transitionDuration: isArrived(props.entry) ? 0 : 1100 }}
      >
        <BaseButton
          onPress={() => toggleOpen(props.entry.id)}
          selected={isOpen()}
          accessibilityLabel={props.entry.msg}
          class={`hover:bg-hover-soft selected:bg-hover-soft ${compact() ? "gap-0.5 px-2.5 py-2" : "min-h-8 flex-row items-center gap-4 px-4 py-1.25"}`}
          style={{
            transitionProperty: "colors",
            transitionDuration: 180,
            // Errors get a faint drafting hatch so they survive a fast scroll (Vue
            // .logs-entry.is-error > .logs-entry-summary): 1px -45deg lines on a 7px pitch.
            backgroundImage: props.entry.level === "error" ? errorHatch() : undefined,
          }}
          hoverStyle={{ transitionDelay: 60 }}
        >
          <If
            when={compact()}
            else={
              <>
                <Text
                  class="font-mono text-xs leading-normal text-muted-foreground tabular-nums"
                  style={{ width: TIME_W }}
                  tooltip={hint(props.entry.time)}
                >
                  {props.clock || "—"}
                </Text>
                <Level level={props.entry.level} />
                {message()}
                {chevron()}
              </>
            }
          >
            {/* Phones: time and level, the message under them, the chevron across both. */}
            <View class="flex-row items-center gap-3">
              <View class="flex-1 gap-0.5">
                <View class="flex-row items-baseline gap-3">
                  <Text class="font-mono text-xs leading-normal text-muted-foreground tabular-nums">{props.clock || "—"}</Text>
                  <Level level={props.entry.level} />
                </View>
                {message()}
              </View>
              {chevron()}
            </View>
          </If>
        </BaseButton>
        <If when={isOpen()}>
          <View
            class="items-start gap-3 border-t border-dashed border-line-soft bg-background pb-3.5 pt-3"
            style={{ paddingLeft: compact() ? 10 : 16 + TIME_W + LEVEL_W + 32, paddingRight: compact() ? 10 : 16 }}
          >
            <If when={!props.entry.event}>
              <View selectable>
                <Text class="font-mono text-xs leading-[19.2px] text-foreground">{props.entry.msg}</Text>
              </View>
            </If>
            <If when={props.entry.fields.length > 0}>
              <View class="w-full gap-1.25" selectable>
                <Each of={props.entry.fields} key={(field) => field[0]}>
                  {(field) => (
                    <View class={compact() ? "mb-2" : "flex-row gap-6"}>
                      <Text class="font-mono text-xs leading-[19.2px] text-muted-foreground" style={compact() ? undefined : { maxWidth: 220, minWidth: 96 }}>
                        {field()[0]}
                      </Text>
                      <Text class="flex-1 font-mono text-xs leading-[19.2px] text-foreground">{field()[1]}</Text>
                    </View>
                  )}
                </Each>
              </View>
            </If>
            <View class="flex-row flex-wrap gap-2">
              <If when={props.entry.event && event() !== props.entry.event}>
                <ToolButton icon="PhFunnelSimple" label={t("logs_only_event")} onPress={() => event.set(props.entry.event)} />
              </If>
              <If when={props.entry.event}>
                <ToolButton
                  icon="PhCode"
                  label={t(rawOpen()[props.entry.id] ? "logs_hide_raw" : "logs_show_raw")}
                  selected={Boolean(rawOpen()[props.entry.id])}
                  onPress={() => toggleRaw(props.entry.id)}
                />
              </If>
            </View>
            <If when={rawOpen()[props.entry.id]}>
              <View class="w-full border border-line-soft bg-card px-3 py-2.5" selectable>
                <Text class="font-mono text-xs leading-[19.2px] text-foreground">{props.entry.line}</Text>
              </View>
            </If>
          </View>
        </If>
      </View>
    );
  }

  /** Vue's small instrument controls: square, hairline, tracked mono caps. */
  function ToolButton(props: { icon: IconName; label: string; selected?: boolean; onPress: () => void }) {
    return (
      <BaseButton
        onPress={() => props.onPress()}
        selected={props.selected}
        accessibilityLabel={props.label}
        class={`group flex-row items-center gap-1.5 border bg-card px-2.5 hover:border-blue/50 selected:border-blue/50 ${compact() ? "h-9" : "h-7"} border-line-soft`}
        style={{ transitionProperty: "colors", transitionDuration: 180 }}
      >
        <Icon name={props.icon} size={13} color={props.selected ? "blue" : "subtle"} />
        <Text class={`${LABEL} tracking-[0.08em] ${props.selected ? "text-blue" : "text-subtle group-hover:text-blue"}`}>{props.label}</Text>
      </BaseButton>
    );
  }

  return (
    <Page title={t("logs_title")} error={err()} scroll={false} testID="logs-page">
      <View
        class={`flex-1 ${compact() ? "gap-2.5" : "gap-3"}`}
        style={{ paddingTop: gutterY(), paddingLeft: gutterX(), paddingRight: gutterX(), paddingBottom: isMobile() ? 12 : 0 }}
      >
        <View class={`flex-row items-center ${compact() ? "gap-2" : "flex-wrap gap-2.5"}`}>
          <TextField
            value={query()}
            onChange={(value) => query.set(value)}
            placeholder={t("logs_search")}
            accessibilityLabel={t("logs_keyword")}
            leadingIcon="PhMagnifyingGlass"
            size={compact() ? "md" : "sm"}
            class={compact() ? "flex-1" : "shrink grow-2 basis-[180px]"}
            testID="logs-query"
          />
          <If when={compact()}>
            <Button
              variant="outlined"
              size="sm"
              icon="PhFunnelSimple"
              title={t("logs_filters")}
              selected={activeFilterCount() > 0}
              onPress={() => filtersOpen.update((value) => !value)}
              testID="logs-filters-toggle"
            >
              <If when={activeFilterCount() > 0}>
                <Text class="font-mono text-[11px] font-semibold text-blue tabular-nums">{String(activeFilterCount())}</Text>
              </If>
            </Button>
          </If>
          <If when={!compact()}>
            <FilterGroup />
          </If>
          {/* Following: Vue's 8pt square mark, filled green while the view follows the end. */}
          <Button
            variant="outlined"
            size="sm"
            title={followLabel()}
            selected={following()}
            disabled={loading() || loadingOlder() || unsupported()}
            onPress={() => (untracked(following) ? following.set(false) : resumeFollowing())}
            testID="logs-follow"
          >
            {/* The mark before the label, as Vue's button lays them out (8pt apart). */}
            <View class={`size-2 rounded-[1px] border ${following() ? "border-ok bg-ok" : "border-muted-foreground"}`} />
            <If when={!compact()}>
              <Text class="ml-0.5 text-sm font-medium tracking-[0.01em] text-foreground" style={{ numberOfLines: 1 }}>
                {followLabel()}
              </Text>
            </If>
          </Button>
          <Button
            variant="outlined"
            size="sm"
            iconOnly
            icon="PhDownloadSimple"
            title={t("logs_export")}
            disabled={filteredEntries().length === 0}
            loading={exporting()}
            onPress={() => void exportLogs()}
            testID="logs-export"
          />
        </View>
        <If when={compact() && filtersOpen()}>
          <View class="gap-2">
            <View class="flex-row gap-2">
              <View class="flex-1">
                <SelectField items={levelOptions()} value={level()} onChange={(value) => level.set(value)} placeholder={t("logs_level")} testID="logs-level" />
              </View>
              <View class="flex-1">
                <SelectField
                  items={timeOptions()}
                  value={String(timeRange())}
                  onChange={(value) => timeRange.set(Number(value) || 0)}
                  placeholder={t("logs_time_range")}
                  testID="logs-time"
                />
              </View>
            </View>
            <SelectField items={eventOptions()} value={event()} onChange={(value) => event.set(value)} placeholder={t("logs_event")} searchable testID="logs-event" />
          </View>
        </If>

        <If when={loading() && entries().length === 0}>
          <ProgressBar indeterminate label={t("runtime_loading")} />
        </If>
        <If when={hasNewer()}>
          <View class="flex-row items-center justify-between gap-3 rounded-(--radius) border border-blue/40 bg-blue/5 py-1.5 pl-3.5 pr-1.5">
            <Text class="text-xs text-subtle">{t("logs_new_available")}</Text>
            <Button variant="outlined" size="sm" label={t("logs_latest")} disabled={loading() || loadingOlder()} onPress={resumeFollowing} />
          </View>
        </If>

        <ObserveSection
          variant="boxed"
          flush
          gap={0}
          class="flex-1 bg-card"
          bodyClass="flex-1"
          title={t("logs_stream")}
          meta={<Text class="font-mono text-xs leading-[20.3px] text-muted-foreground tabular-nums line-clamp-1">{metaText() || t("logs_meta_empty")}</Text>}
          testID="logs-table"
        >
          <If when={!compact()}>
            <View class="flex-row gap-4 border-b border-line-soft px-4 pb-2.25 pt-2.5" accessibilityElementsHidden>
              <Text class={`${LABEL} text-muted-foreground`} style={{ width: TIME_W }}>{t("logs_timestamp")}</Text>
              <Text class={`${LABEL} text-muted-foreground`} style={{ width: LEVEL_W }}>{t("logs_level_short")}</Text>
              <Text class={`flex-1 ${LABEL} text-muted-foreground`}>{t("logs_event_message")}</Text>
              <View class="w-3" />
            </View>
          </If>
          <If when={loading() && entries().length === 0}>
            <Skeleton rows={8} label={t("runtime_loading")} class="p-4" />
          </If>
          <If when={nextCursor()}>
            <View class="items-center border-b border-dashed border-line-soft p-2">
              <BaseButton
                onPress={() => void loadOlder()}
                disabled={loading() || loadingOlder()}
                accessibilityLabel={t(loadingOlder() ? "runtime_loading" : "logs_load_older")}
                testID="logs-older"
                class="group h-6.5 flex-row items-center gap-1.5 px-2 disabled:opacity-60"
              >
                <Icon name="PhCaretUp" size={13} color="muted-foreground" />
                <Text class={`${LABEL} tracking-[0.08em] text-muted-foreground group-hover:text-blue`}>
                  {t(loadingOlder() ? "runtime_loading" : "logs_load_older")}
                </Text>
              </BaseButton>
            </View>
          </If>
          <If when={!loading() && filteredEntries().length === 0}>
            <View class="min-h-60 items-center justify-center gap-1.5">
              <View class="opacity-45">
                <Icon name="PhTerminalWindow" size={22} color="muted-foreground" />
              </View>
              <Text class="mb-1.5 text-sm text-muted-foreground">{filterActive() && entries().length ? t("logs_no_matches") : emptyText()}</Text>
              <If when={filterActive()}>
                <Button variant="outlined" size="sm" label={t("logs_clear_filters")} onPress={clearFilters} />
              </If>
            </View>
          </If>
          <List
            ref={list}
            each={rows()}
            keyExtractor={(row) => row.key}
            estimatedItemSize={33}
            stickyHeaderIndices={dayIndices()}
            maintainVisibleContentPosition={{}}
            accessibilityLabel={t("logs_stream")}
            scrollbar={SCROLLBAR}
            onScroll={(e) => {
              if (e.contentSize.height - e.offset.y - e.size.height > 48 && untracked(following)) following.set(false);
            }}
            class="flex-1"
            testID="logs-stream"
          >
            {(row) => (
              <If
                when={row().type === "entry"}
                else={
                  <If
                    when={row().type === "day"}
                    else={<Marker label={(row() as Extract<Row, { type: "file" }>).label} />}
                  >
                    <Marker day label={(row() as Extract<Row, { type: "day" }>).label} />
                  </If>
                }
              >
                <EntryRow
                  entry={(row() as Extract<Row, { type: "entry" }>).entry}
                  clock={(row() as Extract<Row, { type: "entry" }>).clock}
                />
              </If>
            )}
          </List>
        </ObserveSection>

        <View class="min-h-11 flex-row items-center justify-between gap-3 pb-2 pt-0.5">
          <View class="flex-1 flex-row flex-wrap items-center gap-x-3 gap-y-1">
            <Text class="font-mono text-xs text-subtle tabular-nums">
              {t("logs_visible_count", { count: filteredEntries().length, total: entries().length })}
            </Text>
            <If when={filterActive()}>
              <Text class="text-xs text-muted-foreground underline decoration-dotted" tooltip={hint(t("logs_time_hint"))}>
                {t("logs_filter_scope")}
              </Text>
              <Button variant="plain" size="xs" icon="PhX" label={t("logs_clear_filters")} onPress={clearFilters} testID="logs-clear" />
            </If>
          </View>
          {/* Line count: joined square buttons sharing their hairlines. */}
          <View class="flex-row items-center" accessibilityLabel={t("logs_line_count")}>
            <If when={!compact()}>
              <Text class={`mr-2.5 ${LABEL} text-muted-foreground`}>{t("logs_line_count")}</Text>
            </If>
            {LIMIT_OPTIONS.map((value, index) => (
              <BaseButton
                selected={limit() === value}
                onPress={() => limit.set(value)}
                accessibilityLabel={String(value)}
                testID={`logs-limit-${value}`}
                class={`group items-center justify-center border px-2 ${compact() ? "h-8" : "h-6.5"} min-w-11 ${index > 0 ? "-ml-px" : ""} ${
                  limit() === value ? "z-1 border-blue/55 bg-blue/10" : "border-line-soft"
                }`}
              >
                <Text
                  class={`font-mono text-[11px] tracking-[0.02em] tabular-nums ${
                    limit() === value ? "font-semibold text-blue" : "text-muted-foreground group-hover:text-foreground"
                  }`}
                >
                  {String(value)}
                </Text>
              </BaseButton>
            ))}
          </View>
        </View>
      </View>
    </Page>
  );

  /** A day's marker (sticky) or a file's: mono label, then a hairline to the end. */
  function Marker(props: { label: string; day?: boolean }) {
    return (
      <View class={`flex-row items-center gap-3 pb-1.5 pt-3 ${compact() ? "px-2.5" : "px-4"} ${props.day ? "bg-card" : ""}`}>
        <Text
          class={`font-mono text-[11px] font-medium leading-[15.4px] tabular-nums ${
            props.day ? "uppercase tracking-[0.12em] text-subtle" : "tracking-[0.02em] text-muted-foreground"
          }`}
        >
          {props.label}
        </Text>
        <View class="h-px flex-1 bg-line-soft/60" />
      </View>
    );
  }
}
