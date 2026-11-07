// Logs (the Vue console's LogsView): the selected agent's runtime log, tailed every 4 seconds.
// Lines are grouped by local day (the day header sticks while its lines scroll) and marked where
// the file changes; each line opens to its fields and raw JSON. Search, level, event and time
// filters narrow what is loaded; Load older pages back; the line count sets the page size.
// Following keeps the newest line in view until the reader scrolls up, filters or opens a line;
// then a note says when newer logs came. Export saves the lines shown as a text file.
import type { ListRef } from "nsh";
import { batch, cleanup, computed, effect, List, signal, Text, untracked, View, windowSize } from "nsh";
import { Button as BaseButton } from "nsh/base";
import { currentLocale, endpointState, formatBytes, formatShortTime, runtimeApiFetchForEndpoint } from "../../lib/core/context.js";
import { filterLogEntries, logClock, logDayKey, logDayLabel, logFieldPreview, logSnapshotKey, parseLogLine } from "../../lib/core/logs.js";
import { contentKeys, createArrivalTracker, createHighlightWindow } from "../../lib/core/arrivals.js";
import { pushNotice } from "../../lib/core/notices.js";
import { isVisible, saveFile } from "../../lib/platform";
import { hint, t } from "../../components/observe/parts";
import { Button, EmptyState, Icon, Page, ProgressBar, SelectField, Skeleton, TextField } from "../../components/ui";

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

const LEVEL_TEXT: Record<string, string> = {
  error: "text-danger",
  warn: "text-warn-dark",
  info: "text-blue",
  debug: "text-muted-foreground",
};

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
          class={compact() ? "flex-1" : "w-40"}
          testID="logs-level"
        />
        <SelectField
          items={eventOptions()}
          value={event()}
          onChange={(value) => event.set(value)}
          placeholder={t("logs_event")}
          searchable
          class={compact() ? "w-full" : "w-48"}
          testID="logs-event"
        />
        <SelectField
          items={timeOptions()}
          value={String(timeRange())}
          onChange={(value) => timeRange.set(Number(value) || 0)}
          placeholder={t("logs_time_range")}
          class={compact() ? "flex-1" : "w-40"}
          testID="logs-time"
        />
      </>
    );
  }

  function EntryRow(props: { entry: LogEntry; clock: string }) {
    const isOpen = () => Boolean(open()[props.entry.id]);
    return (
      <View
        class={`border-b border-line-faint ${props.entry.level === "error" ? "bg-danger/5" : ""} ${isArrived(props.entry) ? "bg-selection" : ""}`}
        style={{ transitionProperty: "colors", transitionDuration: 600 }}
      >
        <BaseButton
          onPress={() => toggleOpen(props.entry.id)}
          selected={isOpen()}
          accessibilityLabel={props.entry.msg}
          class="flex-row items-start gap-3 px-3 py-1.5 hover:bg-hover"
        >
          <Text class="w-24 font-mono text-xs text-muted-foreground tabular-nums" tooltip={hint(props.entry.time)}>
            {props.clock || "—"}
          </Text>
          <Text class={`w-12 font-mono text-xs font-semibold ${LEVEL_TEXT[props.entry.level] ?? "text-muted-foreground"}`}>
            {levelLabel(props.entry.level)}
          </Text>
          <Text class="flex-1 font-mono text-xs line-clamp-2">
            <Text class={`font-medium ${props.entry.level === "error" ? "text-danger" : "text-foreground"}`}>{props.entry.msg}</Text>
            {props.entry.preview.map(([key, value]) => (
              <Text class="text-subtle">
                {"  "}
                <Text class="text-muted-foreground">{key}=</Text>
                {value}
              </Text>
            ))}
          </Text>
          <View style={{ transform: [{ rotate: isOpen() ? 90 : 0 }], transitionProperty: "transform", transitionDuration: 150 }}>
            <Icon name="PhCaretRight" size={12} color="muted-foreground" />
          </View>
        </BaseButton>
        <If when={isOpen()}>
          <View class="gap-2 px-3 pb-3 pl-6">
            <If when={!props.entry.event}>
              <View selectable>
                <Text class="font-mono text-xs text-foreground">{props.entry.msg}</Text>
              </View>
            </If>
            <If when={props.entry.fields.length > 0}>
              <View class="gap-1" selectable>
                <Each of={props.entry.fields} key={(field) => field[0]}>
                  {(field) => (
                    <View class="flex-row gap-3">
                      <Text class="w-40 font-mono text-xs text-muted-foreground">{field()[0]}</Text>
                      <Text class="flex-1 font-mono text-xs text-foreground">{field()[1]}</Text>
                    </View>
                  )}
                </Each>
              </View>
            </If>
            <View class="flex-row flex-wrap gap-2">
              <If when={props.entry.event && event() !== props.entry.event}>
                <Button
                  variant="plain"
                  size="xs"
                  icon="PhFunnelSimple"
                  label={t("logs_only_event")}
                  onPress={() => event.set(props.entry.event)}
                />
              </If>
              <If when={props.entry.event}>
                <Button
                  variant="plain"
                  size="xs"
                  icon="PhCode"
                  label={t(rawOpen()[props.entry.id] ? "logs_hide_raw" : "logs_show_raw")}
                  onPress={() => toggleRaw(props.entry.id)}
                />
              </If>
            </View>
            <If when={rawOpen()[props.entry.id]}>
              <View class="rounded-(--radius) bg-ink px-3 py-2" selectable>
                <Text class="font-mono text-xs text-paper">{props.entry.line}</Text>
              </View>
            </If>
          </View>
        </If>
      </View>
    );
  }

  return (
    <Page title={t("logs_title")} error={err()} scroll={false} testID="logs-page">
      <View class="flex-1 gap-3 p-5">
        <View class="flex-row flex-wrap items-center gap-2">
          <TextField
            value={query()}
            onChange={(value) => query.set(value)}
            placeholder={t("logs_search")}
            accessibilityLabel={t("logs_keyword")}
            leadingIcon="PhMagnifyingGlass"
            class="min-w-48 flex-1"
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
                <Text class="text-xs font-medium text-blue tabular-nums">{String(activeFilterCount())}</Text>
              </If>
            </Button>
          </If>
          <Button
            variant="outlined"
            size="sm"
            label={followLabel()}
            title={followLabel()}
            selected={following()}
            disabled={loading() || loadingOlder() || unsupported()}
            onPress={() => (untracked(following) ? following.set(false) : resumeFollowing())}
            testID="logs-follow"
          >
            <View class={`size-2 rounded-full ${following() ? "bg-ok" : "border border-muted-foreground"}`} />
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
          <If when={!compact()}>
            <FilterGroup />
          </If>
        </View>
        <If when={compact() && filtersOpen()}>
          <View class="flex-row flex-wrap gap-2">
            <FilterGroup />
          </View>
        </If>

        <If when={loading() && entries().length === 0}>
          <ProgressBar indeterminate label={t("runtime_loading")} />
        </If>
        <If when={hasNewer()}>
          <View class="flex-row items-center justify-between gap-3 rounded-(--radius) border border-blue-lighter bg-selection px-3 py-2">
            <Text class="text-sm text-foreground">{t("logs_new_available")}</Text>
            <Button variant="outlined" size="sm" label={t("logs_latest")} disabled={loading() || loadingOlder()} onPress={resumeFollowing} />
          </View>
        </If>

        <View class="flex-1 rounded-(--radius) border border-line-faint bg-card">
          <View class="flex-row items-center justify-between gap-3 border-b border-line-faint px-3 py-2">
            <Text class="text-base font-semibold text-foreground" role="header">
              {t("logs_stream")}
            </Text>
            <Text class="text-xs text-muted-foreground tabular-nums line-clamp-1">{metaText() || t("logs_meta_empty")}</Text>
          </View>
          <If when={!compact()}>
            <View class="flex-row gap-3 border-b border-line-faint px-3 py-1">
              <Text class="w-24 font-mono text-xs uppercase text-muted-foreground">{t("logs_timestamp")}</Text>
              <Text class="w-12 font-mono text-xs uppercase text-muted-foreground">{t("logs_level_short")}</Text>
              <Text class="flex-1 font-mono text-xs uppercase text-muted-foreground">{t("logs_event_message")}</Text>
            </View>
          </If>
          <If when={loading() && entries().length === 0}>
            <Skeleton rows={8} label={t("runtime_loading")} class="p-3" />
          </If>
          <If when={nextCursor()}>
            <View class="items-center border-b border-line-faint py-1.5">
              <Button
                variant="plain"
                size="xs"
                icon="PhCaretUp"
                label={t(loadingOlder() ? "runtime_loading" : "logs_load_older")}
                disabled={loading() || loadingOlder()}
                onPress={() => void loadOlder()}
                testID="logs-older"
              />
            </View>
          </If>
          <If when={!loading() && filteredEntries().length === 0}>
            <EmptyState
              icon="PhTerminalWindow"
              title={filterActive() && entries().length ? t("logs_no_matches") : emptyText()}
              action={
                <If when={filterActive()}>
                  <Button variant="outlined" size="sm" label={t("logs_clear_filters")} onPress={clearFilters} />
                </If>
              }
            />
          </If>
          <List
            ref={list}
            each={rows()}
            keyExtractor={(row) => row.key}
            estimatedItemSize={30}
            stickyHeaderIndices={dayIndices()}
            maintainVisibleContentPosition={{}}
            accessibilityLabel={t("logs_stream")}
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
                    else={
                      <View class="border-b border-line-faint bg-paper px-3 py-1">
                        <Text class="font-mono text-xs text-subtle">{(row() as Extract<Row, { type: "file" }>).label}</Text>
                      </View>
                    }
                  >
                    <View class="border-b border-line-faint bg-card px-3 py-1">
                      <Text class="font-mono text-xs font-medium text-subtle tabular-nums">{(row() as Extract<Row, { type: "day" }>).label}</Text>
                    </View>
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
        </View>

        <View class="flex-row flex-wrap items-center justify-between gap-3">
          <View class="flex-row flex-wrap items-center gap-3">
            <Text class="text-xs text-muted-foreground tabular-nums">
              {t("logs_visible_count", { count: filteredEntries().length, total: entries().length })}
            </Text>
            <If when={filterActive()}>
              <Text class="text-xs text-muted-foreground" tooltip={hint(t("logs_time_hint"))}>
                {t("logs_filter_scope")}
              </Text>
              <Button variant="plain" size="xs" icon="PhX" label={t("logs_clear_filters")} onPress={clearFilters} testID="logs-clear" />
            </If>
          </View>
          <View class="flex-row items-center gap-1" accessibilityLabel={t("logs_line_count")}>
            <Text class="mr-1 text-xs text-muted-foreground">{t("logs_line_count")}</Text>
            {LIMIT_OPTIONS.map((value) => (
              <BaseButton
                selected={limit() === value}
                onPress={() => limit.set(value)}
                accessibilityLabel={String(value)}
                testID={`logs-limit-${value}`}
                class="rounded-(--radius) border border-transparent px-2 py-0.5 hover:bg-hover selected:border-line selected:bg-selection"
              >
                <Text class={`text-xs tabular-nums ${limit() === value ? "font-medium text-foreground" : "text-subtle"}`}>{String(value)}</Text>
              </BaseButton>
            ))}
          </View>
        </View>
      </View>
    </Page>
  );
}
