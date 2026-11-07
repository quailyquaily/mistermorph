// Daily usage as stacked bars, one per calendar day in the viewer's time zone (the Vue console's
// StatsDailyPanel): cost or tokens split by model, or input tokens split by how the prompt cache
// served them. Drawn with nsh/base/plot: a Bar per segment in one stack, a grid at the axis ticks,
// a dashed average line. Hovering a day shows its readout and tooltip; pressing the plot pins the
// hovered day; pressing a legend entry shows only that model.
import { batch, cleanup, computed, effect, signal, Text, untracked, View } from "nsh";
import { Bar, Grid, Plot, PlotAxis } from "nsh/base/plot";
import { Button as BaseButton } from "nsh/base";
import { endpointState, runtimeApiFetch } from "../../lib/core/context.js";
import { prefersReducedMotion, tweenValue } from "../../lib/core/tween.js";
import {
  DAILY_METRICS,
  DAILY_RANGES,
  OTHER_KEY,
  assignModelSlots,
  summarizeDailyUsage,
} from "../../lib/core/daily-usage.js";
import { ProgressBar } from "../ui";
import { compactCost, compactNumber, exactCost as exactCostText, exactNumber, formatIntl, hint, percentWhole, Segmented, t } from "./parts";

type Metric = "cost" | "tokens" | "cache";

const METRIC_TITLE_KEYS: Record<Metric, string> = {
  cost: "stats_daily_metric_cost",
  tokens: "stats_daily_metric_tokens",
  cache: "stats_daily_metric_cache",
};

const CACHE_PART_KEYS: Record<string, string> = {
  hits: "stats_daily_cache_hits",
  writes: "stats_daily_cache_writes",
  uncached: "stats_daily_cache_uncached",
};

// The series' colors, by segment: model slots 1 to 4, Other, and the cache split. Each has the
// fill class its bar paints with and the background class of its swatch.
const SERIES: Record<string, { fill: string; swatch: string }> = {
  s0: { fill: "fill-chart-1", swatch: "bg-chart-1" },
  s1: { fill: "fill-chart-2", swatch: "bg-chart-2" },
  s2: { fill: "fill-chart-3", swatch: "bg-chart-3" },
  s3: { fill: "fill-chart-4", swatch: "bg-chart-4" },
  other: { fill: "fill-muted-foreground/40", swatch: "bg-muted-foreground/40" },
  hits: { fill: "fill-blue", swatch: "bg-blue" },
  writes: { fill: "fill-blue/50", swatch: "bg-blue/50" },
  uncached: { fill: "fill-blue/20", swatch: "bg-blue/20" },
};
const STACK_FIELDS = ["s0", "s1", "s2", "s3", "other", "hits", "writes", "uncached"] as const;

interface Segment {
  key: string;
  slot: number | null;
  value: number;
}

function seriesField(segment: { key?: string; slot?: number | null } | null | undefined): string {
  if (segment && Number.isInteger(segment.slot)) return `s${segment.slot}`;
  if (!segment?.key || segment.key === OTHER_KEY) return "other";
  return segment.key;
}

function swatchClass(segment: { key?: string; slot?: number | null } | null | undefined) {
  return SERIES[seriesField(segment)]?.swatch ?? SERIES.other.swatch;
}

function browserTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

const ROLL_MS = 420;

export function DailyUsagePanel() {
  const range = signal(30);
  const metric = signal<Metric>("cost");
  const payload = signal<any>(null);
  const loading = signal(false);
  const err = signal("");
  const unsupported = signal(false);
  const hovered = signal<number | null>(null);
  const pinned = signal<number | null>(null);
  const isolate = signal<string | null>(null);
  const slots = signal<Map<string, number>>(new Map());
  const generation = signal(0);
  const timeZone = browserTimeZone();
  let requestSeq = 0;

  const series = computed(() => summarizeDailyUsage(payload(), metric(), { slots: slots(), isolate: isolate() }));
  const isCache = () => series().metric === "cache";
  const hasRequests = () => Number(payload()?.summary?.requests || 0) > 0;
  const emptyMessage = () => {
    if (unsupported()) return t("stats_daily_unsupported");
    return !loading() && !err() && !hasRequests() ? t("stats_daily_empty") : "";
  };
  const selecting = () => hovered() !== null || pinned() !== null;
  const focusedIndex = computed(() => {
    const count = series().days.length;
    for (const index of [hovered(), pinned()]) {
      if (Number.isInteger(index) && (index as number) >= 0 && (index as number) < count) return index as number;
    }
    return count - 1;
  });
  const focusedDay = () => series().days[focusedIndex()] || null;

  const cost = (value: unknown) => compactCost(value, series().currency);
  const exactCost = (value: unknown) => exactCostText(value, series().currency);
  const metricValue = (value: unknown) => (series().metric === "cost" ? cost(value) : compactNumber(value));
  const metricExact = (value: unknown) => (series().metric === "cost" ? exactCost(value) : exactNumber(value));
  const axisValue = (value: number) => {
    if (series().metric !== "cost") return compactNumber(value);
    if (value === 0) return "0";
    const currency = series().currency === "MIXED" ? "USD" : series().currency;
    try {
      return formatIntl(value, { style: "currency", currency, maximumSignificantDigits: 3 });
    } catch {
      return String(value);
    }
  };
  // Cache savings are what caching took off the input bill; negative when writes cost more.
  const savings = (delta: number | null | undefined) => (delta === null || delta === undefined ? "-" : cost(-delta));
  const segmentName = (key: string) => {
    if (key === OTHER_KEY) return t("stats_daily_other");
    return CACHE_PART_KEYS[key] ? t(CACHE_PART_KEYS[key]) : key;
  };

  // The rows the plot draws: each day's segments as fields of one stack.
  const rows = computed(() =>
    series().days.map((day: any, index: number) => {
      const row: Record<string, number | string | null> = { index, date: day.date };
      for (const field of STACK_FIELDS) row[field] = null;
      for (const segment of day.segments as Segment[]) row[seriesField(segment)] = segment.value;
      return row;
    }),
  );
  const labelIndices = () =>
    series()
      .days.map((day: any, index: number) => (day.showLabel ? index : -1))
      .filter((index: number) => index >= 0);
  const scaleMax = () => series().scaleMax || 1;
  const averageLine = () => {
    const { average, scaleMax: max } = series();
    if (isCache() || !hasRequests() || average <= 0 || max <= 0) return null;
    return average;
  };

  // Figures roll to their new values when the range or metric changes.
  const figureTargets = computed(() => {
    const s = series();
    return {
      average: s.average,
      peak: s.peak ? s.peak.value : 0,
      today: s.today,
      total: s.total,
      cacheRate: s.cacheRate,
      rate: s.cache.rate,
      hits: s.cache.hits,
      writes: s.cache.writes,
      uncached: s.cache.uncached,
      savings: s.cache.delta === null ? null : -s.cache.delta,
    } as Record<string, number | null>;
  });
  const rolled = signal<Record<string, number | null>>({});
  let rollFrame = 0;
  cleanup(() => cancelAnimationFrame(rollFrame));
  effect(() => {
    const targets = figureTargets();
    untracked(() => {
      cancelAnimationFrame(rollFrame);
      const from = { ...rolled() };
      if (prefersReducedMotion() || Object.keys(from).length === 0) {
        rolled.set({ ...targets });
        return;
      }
      const start = performance.now();
      const step = (now: number) => {
        const elapsed = now - start;
        const next: Record<string, number | null> = {};
        for (const [key, value] of Object.entries(targets)) next[key] = tweenValue(from[key], value, elapsed, ROLL_MS);
        rolled.set(next);
        if (elapsed < ROLL_MS) rollFrame = requestAnimationFrame(step);
      };
      rollFrame = requestAnimationFrame(step);
    });
  });
  const shown = (key: string) => (key in rolled() ? rolled()[key] : figureTargets()[key]);

  const figures = computed(() => {
    const s = series();
    const active = { key: "active", label: t("stats_daily_active"), value: `${s.activeDays}/${s.days.length}`, title: "", note: "" };
    if (isCache()) {
      return [
        { key: "rate", label: t("stats_cache_rate"), value: percentWhole(shown("rate")), title: "", note: "" },
        { key: "hits", label: t("stats_daily_cache_hits"), value: compactNumber(shown("hits")), title: exactNumber(s.cache.hits), note: "" },
        { key: "writes", label: t("stats_daily_cache_writes"), value: compactNumber(shown("writes")), title: exactNumber(s.cache.writes), note: "" },
        { key: "uncached", label: t("stats_daily_cache_uncached"), value: compactNumber(shown("uncached")), title: exactNumber(s.cache.uncached), note: "" },
        {
          key: "savings",
          label: t("stats_cache_delta"),
          value: savings(s.cache.delta === null ? null : -(shown("savings") ?? 0)),
          title: s.cache.delta === null ? "" : exactCost(-s.cache.delta),
          note: "",
        },
        active,
      ];
    }
    return [
      { key: "avg", label: t("stats_daily_avg"), value: metricValue(shown("average")), title: metricExact(s.average), note: "" },
      {
        key: "peak",
        label: t("stats_daily_peak"),
        value: s.peak ? metricValue(shown("peak")) : "-",
        note: s.peak ? s.peak.date.slice(5) : "",
        title: s.peak ? `${s.peak.date} · ${metricExact(s.peak.value)}` : "",
      },
      { key: "today", label: t("stats_daily_today"), value: metricValue(shown("today")), title: metricExact(s.today), note: "" },
      { key: "total", label: t("stats_daily_total"), value: metricValue(shown("total")), title: metricExact(s.total), note: "" },
      active,
      { key: "cache", label: t("stats_cache_rate"), value: percentWhole(shown("cacheRate")), title: "", note: "" },
    ];
  });

  // Tooltip rows for the focused day: its models, or its cache split.
  const tooltip = computed(() => {
    const day = focusedDay();
    if (!selecting() || !day || day.requests <= 0) return null;
    let list: { key: string; name: string; swatch: string; value: string; title?: string; note?: string }[];
    if (isCache()) {
      list = (day.segments as Segment[]).map((segment) => ({
        key: segment.key,
        name: segmentName(segment.key),
        swatch: swatchClass(segment),
        value: compactNumber(segment.value),
        title: exactNumber(segment.value),
      }));
      list.push({ key: "rate", name: t("stats_daily_cache_rate"), swatch: "", value: percentWhole(day.cache.rate) });
      list.push({ key: "savings", name: t("stats_cache_delta"), swatch: "", value: savings(day.cache.delta) });
    } else {
      const only = isolate();
      list = day.models
        .filter((item: any) => !only || item.model === only || (only === OTHER_KEY && item.slot === null))
        .map((item: any) => {
          const value = series().metric === "tokens" ? item.tokens : item.cost;
          return {
            key: item.model,
            name: item.model,
            swatch: swatchClass({ key: item.model, slot: item.slot }),
            value: metricValue(value),
            title: metricExact(value),
            note: `${exactNumber(item.requests)} ${t("stats_daily_req")}`,
          };
        });
    }
    if (list.length === 0) return null;
    return { date: day.date as string, total: isCache() ? null : metricValue(day.value), rows: list };
  });

  const barLabel = (day: any) =>
    `${day.date}: ${cost(day.cost)}, ${exactNumber(day.requests)} ${t("stats_requests")}, ${compactNumber(day.tokens)} ${t(
      "stats_tokens",
    )}, ${t("stats_cache_rate")} ${percentWhole(day.cacheRate)}`;

  const togglePin = () => {
    const index = untracked(hovered);
    if (index === null) return;
    pinned.update((current) => (current === index ? null : index));
  };
  const toggleIsolate = (key: string) => {
    if (!untracked(isCache)) isolate.update((current) => (current === key ? null : key));
  };
  const legendTitle = (item: Segment) => {
    if (isCache()) return exactNumber(item.value);
    return isolate() === item.key ? t("stats_daily_show_all") : t("stats_daily_show_only", { name: segmentName(item.key) });
  };

  async function load() {
    const seq = ++requestSeq;
    batch(() => {
      loading.set(true);
      err.set("");
      unsupported.set(false);
    });
    try {
      const query = new URLSearchParams({ days: String(untracked(range)), tz: timeZone });
      const data = await runtimeApiFetch(`/stats/llm/daily?${query}`);
      if (seq !== requestSeq) return;
      const next = data && typeof data === "object" ? data : null;
      batch(() => {
        slots.update((previous) => assignModelSlots(previous, next?.models));
        payload.set(next);
        // An isolated model that left the legend shows all again.
        const only = untracked(isolate);
        if (only && !summarizeDailyUsage(next, untracked(metric), { slots: untracked(slots), isolate: null }).legend.some((item: Segment) => item.key === only)) {
          isolate.set(null);
        }
        generation.update((n) => n + 1);
      });
    } catch (e: any) {
      if (seq !== requestSeq) return;
      batch(() => {
        payload.set(null);
        // Agents built before the daily route answer 404.
        if (e?.status === 404) unsupported.set(true);
        else err.set(e?.message || t("msg_load_failed"));
      });
    } finally {
      if (seq === requestSeq) loading.set(false);
    }
  }

  const setRange = (value: number) => {
    if (untracked(range) === value) return;
    batch(() => {
      range.set(value);
      pinned.set(null);
      hovered.set(null);
    });
    void load();
  };

  // Loads for the selected agent, and again from scratch when it changes.
  effect(() => {
    const ref = String(endpointState.selectedRef || "").trim();
    untracked(() => {
      if (!ref) return;
      batch(() => {
        pinned.set(null);
        isolate.set(null);
        slots.set(new Map());
      });
      void load();
    });
  });

  return (
    <View class="gap-3 rounded-(--radius) border border-line-faint bg-card p-4" testID="stats-daily">
      <View class="flex-row items-center justify-between gap-3">
        <Text class="text-base font-semibold text-foreground" role="header">
          {t("stats_daily_title")}
        </Text>
        <Text class="font-mono text-xs text-muted-foreground" tooltip={hint(t("stats_daily_zone", { zone: timeZone }))}>
          {timeZone}
        </Text>
      </View>

      <View class="flex-row flex-wrap items-center justify-between gap-3">
        <Segmented
          items={DAILY_RANGES.map((n: number) => ({ id: n, label: t("stats_daily_range_days", { count: n }) }))}
          value={range()}
          onChange={(id) => setRange(id)}
          label={t("stats_daily_range")}
          testID="stats-daily-range"
        />
        <Segmented
          items={(DAILY_METRICS as Metric[]).map((m) => ({ id: m, label: t(METRIC_TITLE_KEYS[m]) }))}
          value={metric()}
          onChange={(id) => metric.set(id)}
          label={t("stats_daily_metric")}
          testID="stats-daily-metric"
        />
      </View>

      <If when={loading()}>
        <ProgressBar indeterminate label={t("runtime_loading")} />
      </If>
      <If when={err()}>
        <Text class="text-sm text-danger" role="alert">
          {err()}
        </Text>
      </If>

      <If when={focusedDay()}>
        {(day) => (
          <View class="flex-row flex-wrap items-baseline gap-x-5 gap-y-1" testID="stats-daily-readout">
            <Text class="text-sm font-medium text-foreground tabular-nums">
              {day().date}
              {day().isToday ? ` · ${t("stats_daily_in_progress")}` : ""}
            </Text>
            <ReadoutItem label={t("stats_daily_metric_cost")} value={cost(day().cost)} title={exactCost(day().cost)} />
            <ReadoutItem label={t("stats_requests")} value={exactNumber(day().requests)} />
            <ReadoutItem label={t("stats_tokens")} value={compactNumber(day().tokens)} title={exactNumber(day().tokens)} />
            <ReadoutItem
              label={`${t("stats_input")} / ${t("stats_output")}`}
              value={`${compactNumber(day().inputTokens)} / ${compactNumber(day().outputTokens)}`}
            />
            <ReadoutItem label={t("stats_cache_rate")} value={percentWhole(day().cacheRate)} />
          </View>
        )}
      </If>

      <View class="relative" onPress={togglePin}>
        <Plot
          data={rows()}
          xScale={{ type: "band", paddingInner: series().days.length > 31 ? 0.15 : 0.3, paddingOuter: 0.1 }}
          yScale={{ type: "linear", domain: [0, scaleMax()] }}
          accessibilityLabel={`${t("stats_daily_title")}: ${t(METRIC_TITLE_KEYS[metric()])}`}
          accessibilityValue={{ text: focusedDay() ? barLabel(focusedDay()) : "" }}
          appearGeneration={`${generation()}:${metric()}`}
          motion={{
            appear: { duration: 420, easing: "easeOut" },
            update: { duration: 240 },
            enter: { duration: 120 },
            exit: { duration: 160 },
            pointer: { stiffness: 320, damping: 32 },
          }}
          crossLineClass="w-full h-full bg-foreground/5"
          tooltipPlacement="pointer"
          tooltipOffset={10}
          tooltipContent={
            <If when={tooltip()}>
              {(tip) => (
                <View class="min-w-44 gap-1 rounded-(--radius) border border-line bg-popover px-2.5 py-2 shadow-md">
                  <View class="flex-row items-baseline justify-between gap-3">
                    <Text class="text-xs font-medium text-foreground tabular-nums">{tip().date}</Text>
                    <If when={tip().total}>
                      <Text class="text-xs font-medium text-foreground tabular-nums">{tip().total}</Text>
                    </If>
                  </View>
                  <Each of={tip().rows} key={(row) => row.key}>
                    {(row) => (
                      <View class="flex-row items-center gap-1.5">
                        <View class={`size-2 ${row().swatch || "border border-line"}`} />
                        <Text class="flex-1 text-xs text-subtle line-clamp-1">{row().name}</Text>
                        <If when={row().note}>
                          <Text class="text-xs text-muted-foreground tabular-nums">{row().note}</Text>
                        </If>
                        <Text class="text-xs text-foreground tabular-nums">{row().value}</Text>
                      </View>
                    )}
                  </Each>
                </View>
              )}
            </If>
          }
          onHoverChange={({ index }) => hovered.set(index)}
          class="mb-6 ml-14 h-48"
          testID="stats-daily-plot"
        >
          <Grid y={[scaleMax() / 2, scaleMax()]} class="stroke-line-faint" />
          <Grid y={[0]} class="stroke-line" />
          {STACK_FIELDS.map((field) => (
            <Bar
              value={(row: Record<string, number | string | null>) => row[field] as number}
              stack="day"
              stagger={0.5}
              inactiveOpacity={0.55}
              class={SERIES[field].fill}
            />
          ))}
          <If when={averageLine() !== null}>
            <Grid y={[averageLine() ?? 0]} class="stroke-muted-foreground" style={{ strokeDasharray: "4 3" }} />
          </If>
          <PlotAxis
            placement="left"
            tickValues={series().ticks}
            format={(value) => axisValue(value)}
            labelClass="pr-2 text-xs tabular-nums text-muted-foreground"
          />
          <PlotAxis
            tickValues={labelIndices()}
            format={(index) => series().days[index]?.label ?? ""}
            labelClass="pt-2 text-xs tabular-nums text-muted-foreground"
          />
        </Plot>
        <If when={emptyMessage()}>
          <View class="absolute inset-0 items-center justify-center px-6" style={{ pointerEvents: "none" }}>
            <Text class="text-center text-sm text-muted-foreground">{emptyMessage()}</Text>
          </View>
        </If>
      </View>

      <If when={series().legend.length > 0}>
        <View class="flex-row flex-wrap gap-x-3 gap-y-1" testID="stats-daily-legend">
          <Each of={series().legend as Segment[]} key={(item) => item.key}>
            {(item) => (
              <BaseButton
                disabled={isCache()}
                selected={isolate() === item().key}
                onPress={() => toggleIsolate(item().key)}
                accessibilityLabel={segmentName(item().key)}
                tooltip={hint(legendTitle(item()))}
                testID={`stats-daily-legend-${item().key}`}
                class={`flex-row items-center gap-1.5 rounded-(--radius) px-1.5 py-0.5 hover:bg-hover selected:bg-selection ${
                  isolate() && isolate() !== item().key ? "opacity-45" : ""
                }`}
              >
                <View class={`size-2 ${swatchClass(item())}`} />
                <Text class="text-xs text-subtle line-clamp-1">{segmentName(item().key)}</Text>
                <Text class="text-xs text-foreground tabular-nums">{metricValue(item().value)}</Text>
              </BaseButton>
            )}
          </Each>
        </View>
      </If>

      <View class="flex-row flex-wrap gap-x-6 gap-y-2" testID="stats-daily-figures">
        <Each of={figures()} key={(item) => item.key}>
          {(item) => (
            <View class="gap-0.5">
              <View class="flex-row items-center gap-1.5">
                <If when={item().key === "avg"}>
                  <View class="h-px w-3.5 border-t border-dashed border-muted-foreground" />
                </If>
                <Text class="font-mono text-xs uppercase tracking-wide text-muted-foreground">{item().label}</Text>
              </View>
              <View class="flex-row items-baseline gap-1" tooltip={hint(item().title)}>
                <Text class="text-sm font-medium text-foreground tabular-nums">{item().value}</Text>
                <If when={item().note}>
                  <Text class="text-xs text-muted-foreground tabular-nums">{item().note}</Text>
                </If>
              </View>
            </View>
          )}
        </Each>
      </View>
    </View>
  );
}

function ReadoutItem(props: { label: string; value: string; title?: string }) {
  return (
    <View class="flex-row items-baseline gap-1.5" tooltip={hint(props.title)}>
      <Text class="font-mono text-xs uppercase tracking-wide text-muted-foreground">{props.label}</Text>
      <Text class="text-sm text-foreground tabular-nums">{props.value}</Text>
    </View>
  );
}
