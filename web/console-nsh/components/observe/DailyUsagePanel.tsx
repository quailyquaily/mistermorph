// Daily usage as stacked bars, one per calendar day in the viewer's time zone (the Vue console's
// StatsDailyPanel): cost or tokens split by model, or input tokens split by how the prompt cache
// served them. Drawn with nsh/base/plot: a Bar per segment in one stack, a grid at the axis ticks,
// a dashed average line. Hovering a day shows its readout and tooltip; pressing the plot pins the
// hovered day; pressing a legend entry shows only that model.
import { batch, cleanup, computed, effect, signal, Text, token, untracked, View, windowSize } from "nsh";
import { Bar, Grid, Plot, PlotAxis } from "nsh/base/plot";
import { endpointState, runtimeApiFetch } from "../../lib/core/context.js";
import { prefersReducedMotion, tweenValue } from "../../lib/core/tween.js";
import {
  DAILY_METRICS,
  DAILY_RANGES,
  OTHER_KEY,
  assignModelSlots,
  summarizeDailyUsage,
} from "../../lib/core/daily-usage.js";
import { ProgressBar, Tabs, TipButton } from "../ui";
import { compactCost, compactNumber, exactCost as exactCostText, exactNumber, formatIntl, hint, ObserveSection, percentWhole, t } from "./parts";

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
// fill class its bar paints with, the background class of its swatch, and the same colour as a
// theme token and the share of it (`tone`), which today's hatch is drawn in.
const SERIES: Record<string, { fill: string; swatch: string; tone: [Parameters<typeof token>[0], number] }> = {
  s0: { fill: "fill-chart-1", swatch: "bg-chart-1", tone: ["chart-1", 100] },
  s1: { fill: "fill-chart-2", swatch: "bg-chart-2", tone: ["chart-2", 100] },
  s2: { fill: "fill-chart-3", swatch: "bg-chart-3", tone: ["chart-3", 100] },
  s3: { fill: "fill-chart-4", swatch: "bg-chart-4", tone: ["chart-4", 100] },
  other: { fill: "fill-muted-foreground/40", swatch: "bg-muted-foreground/40", tone: ["muted-foreground", 40] },
  // Cache split: one hue (Vue's --stats-accent), darkest for what the cache served.
  hits: { fill: "fill-ink", swatch: "bg-ink", tone: ["ink", 100] },
  writes: { fill: "fill-ink/50", swatch: "bg-ink/50", tone: ["ink", 50] },
  uncached: { fill: "fill-ink/20", swatch: "bg-ink/20", tone: ["ink", 20] },
};
const STACK_FIELDS = ["s0", "s1", "s2", "s3", "other", "hits", "writes", "uncached"] as const;
// Today is still filling up, so its segments are hatched instead of solid (Vue
// .stats-daily-bar.is-today .stats-daily-segment): a 1px ring inside each segment in its colour,
// over 135deg stripes 2px wide on a 5px pitch. Each series has a twin that holds only today's
// value (the series itself then has none that day), stacked right after it, whose bar is painted
// by its background part: the ring as four 1px edge gradients, then the stripes.
const TODAY_SUFFIX = ":today";
const todayHatch = (field: string) => {
  const [name, share] = SERIES[field].tone;
  const c = share === 100 ? String(token(name)) : `color-mix(in srgb, ${token(name)} ${share}%, transparent)`;
  const edge = (side: string) => `linear-gradient(to ${side}, ${c} 0 1px, transparent 1px)`;
  return [edge("right"), edge("left"), edge("bottom"), edge("top"), `repeating-linear-gradient(135deg, ${c} 0 2px, transparent 2px 5px)`].join(", ");
};

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
  const range = signal(7);
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
      for (const field of STACK_FIELDS) {
        row[field] = null;
        row[field + TODAY_SUFFIX] = null;
      }
      const suffix = day.isToday ? TODAY_SUFFIX : "";
      for (const segment of day.segments as Segment[]) row[seriesField(segment) + suffix] = segment.value;
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

  // Vue's breakpoints are the window's.
  const phone = () => windowSize().width <= 560;
  const figureColumns = () => (windowSize().width <= 860 ? 3 : 6);
  const sectionPad = () => Math.round(Math.min(22, Math.max(16, windowSize().width * 0.02)));

  return (
    <ObserveSection
      variant="boxed"
      title={t("stats_daily_title")}
      padding={sectionPad()}
      gap={14}
      testID="stats-daily"
      meta={
        <Text class="font-mono text-[11px] leading-[15.4px] tracking-[0.06em] text-subtle line-clamp-1" tooltip={hint(t("stats_daily_zone", { zone: timeZone }))}>
          {timeZone}
        </Text>
      }
    >
      {/* Range and metric set what the chart shows, so they sit at the top of the body: range at
          the left edge, metric at the right. */}
      <View class="flex-row flex-wrap justify-between gap-2">
        <Tabs
          items={DAILY_RANGES.map((n: number) => ({ id: String(n), label: t("stats_daily_range_days", { count: n }) }))}
          value={String(range())}
          onChange={(id) => setRange(Number(id))}
        />
        <Tabs
          items={(DAILY_METRICS as Metric[]).map((m) => ({ id: m, label: t(METRIC_TITLE_KEYS[m]) }))}
          value={metric()}
          onChange={(id) => metric.set(id as Metric)}
        />
      </View>

      <If when={loading()}>
        <ProgressBar indeterminate label={t("runtime_loading")} />
      </If>
      <If when={err()}>
        <Text class="text-xs text-danger" role="alert">
          {err()}
        </Text>
      </If>

      {/* The hovered, pinned or latest day, on a tinted strip with the selection's rule. */}
      <If when={focusedDay()}>
        {(day) => (
          <View
            class={`border-l-2 border-blue bg-blue/5 px-2.5 py-1.5 ${phone() ? "gap-y-1" : "flex-row flex-wrap items-baseline gap-x-4.5 gap-y-1.5"}`}
            style={{ minHeight: 22 }}
            testID="stats-daily-readout"
          >
            <Text class={`${MONO} tracking-[0.04em] text-foreground`}>
              {day().date}
              {day().isToday ? ` · ${t("stats_daily_in_progress")}` : ""}
            </Text>
            <If
              when={phone()}
              else={
                <>
                  <ReadoutItem label={t("stats_daily_metric_cost")} value={cost(day().cost)} title={exactCost(day().cost)} />
                  <ReadoutItem label={t("stats_requests")} value={exactNumber(day().requests)} />
                  <ReadoutItem label={t("stats_tokens")} value={compactNumber(day().tokens)} title={exactNumber(day().tokens)} />
                  <ReadoutItem
                    label={`${t("stats_input")} / ${t("stats_output")}`}
                    value={`${compactNumber(day().inputTokens)} / ${compactNumber(day().outputTokens)}`}
                  />
                  <ReadoutItem label={t("stats_cache_rate")} value={percentWhole(day().cacheRate)} />
                </>
              }
            >
              {/* Phones: two columns, the in/out pair across both. */}
              <View class="flex-row gap-3">
                <ReadoutItem spread label={t("stats_daily_metric_cost")} value={cost(day().cost)} title={exactCost(day().cost)} />
                <ReadoutItem spread label={t("stats_requests")} value={exactNumber(day().requests)} />
              </View>
              <View class="flex-row gap-3">
                <ReadoutItem spread label={t("stats_tokens")} value={compactNumber(day().tokens)} title={exactNumber(day().tokens)} />
                <View class="flex-1" />
              </View>
              <ReadoutItem
                spread
                label={`${t("stats_input")} / ${t("stats_output")}`}
                value={`${compactNumber(day().inputTokens)} / ${compactNumber(day().outputTokens)}`}
              />
              <View class="flex-row gap-3">
                <ReadoutItem spread label={t("stats_cache_rate")} value={percentWhole(day().cacheRate)} />
                <View class="flex-1" />
              </View>
            </If>
          </View>
        )}
      </If>

      <View class="relative" onPress={togglePin}>
        <Plot
          data={rows()}
          xScale={{ type: "band", paddingInner: series().days.length > 31 ? 0.15 : 0.38, paddingOuter: 0.19 }}
          yScale={{ type: "linear", domain: [0, scaleMax()] }}
          accessibilityLabel={`${t("stats_daily_title")}: ${t(METRIC_TITLE_KEYS[metric()])}`}
          accessibilityValue={{ text: focusedDay() ? barLabel(focusedDay()) : "" }}
          appearGeneration={`${generation()}:${metric()}`}
          motion={{
            // Vue: bar heights ease over --motion-slow (260ms) with a small per-bar delay.
            appear: { duration: 260, easing: [0.2, 0, 0, 1] },
            update: { duration: 260, easing: [0.2, 0, 0, 1] },
            enter: { duration: 120 },
            exit: { duration: 160 },
            pointer: { stiffness: 320, damping: 32 },
          }}
          crossLineClass="w-full h-full bg-blue/6"
          tooltipPlacement="pointer"
          tooltipOffset={12}
          tooltipContent={
            <If when={tooltip()}>
              {(tip) => (
                <View
                  class="gap-0.75 border border-line bg-card px-2.5 py-2 shadow-md"
                  style={{ minWidth: phone() ? 160 : 190, maxWidth: phone() ? 220 : 280 }}
                >
                  <View class="mb-0.75 flex-row items-baseline justify-between gap-3 border-b border-dashed border-line-soft pb-1.25">
                    <Text class={`${MONO} text-foreground`}>{tip().date}</Text>
                    <If when={tip().total}>
                      <Text class={`${MONO} text-foreground`}>{tip().total}</Text>
                    </If>
                  </View>
                  <Each of={tip().rows} key={(row) => row.key}>
                    {(row) => (
                      <View class="flex-row items-center gap-2">
                        <View class={`size-2 ${row().swatch}`} />
                        <Text class={`flex-1 ${MONO} text-subtle line-clamp-1`}>{row().name}</Text>
                        <If when={row().note}>
                          <Text class={`${MONO} text-subtle`}>{row().note}</Text>
                        </If>
                        <Text class={`text-right ${MONO} text-foreground`}>{row().value}</Text>
                      </View>
                    )}
                  </Each>
                </View>
              )}
            </If>
          }
          onHoverChange={({ index }) => hovered.set(index)}
          class="mb-4.75 ml-13.5"
          style={{ height: phone() ? 150 : 184 }}
          testID="stats-daily-plot"
        >
          {/* A dashed rule at each tick above the base (Vue draws them from the same ticks). */}
          <Grid y={(series().ticks as number[]).filter((value) => value > 0)} class="stroke-line-soft" style={{ strokeDasharray: "3 3" }} />

          <Grid y={[0]} class="stroke-line" />
          {STACK_FIELDS.flatMap((field) => [
            <Bar
              value={(row: Record<string, number | string | null>) => row[field] as number}
              stack="day"
              stagger={0.5}
              inactiveOpacity={0.55}
              class={SERIES[field].fill}
            />,
            <Bar
              value={(row: Record<string, number | string | null>) => row[field + TODAY_SUFFIX] as number}
              stack="day"
              stagger={0.5}
              inactiveOpacity={0.55}
              backgroundStyle={{ backgroundImage: todayHatch(field) }}
            />,
          ])}
          <If when={averageLine() !== null}>
            <Grid y={[averageLine() ?? 0]} class="stroke-foreground/45" style={{ strokeDasharray: "3 3" }} />
          </If>
          <PlotAxis
            placement="left"
            tickValues={series().ticks}
            format={(value) => axisValue(value)}
            labelClass="pr-2.5 font-mono text-[11px] leading-none tabular-nums text-subtle"
          />
          <PlotAxis
            tickValues={labelIndices()}
            format={(index) => series().days[index]?.label ?? ""}
            labelClass="pt-1.5 font-mono text-[11px] leading-[13.2px] tabular-nums text-subtle"
          />
        </Plot>
        <If when={emptyMessage()}>
          <View class="absolute inset-0 items-center justify-center px-6" style={{ pointerEvents: "none" }}>
            <Text class={`text-center ${MONO} uppercase tracking-[0.12em] text-subtle`}>{emptyMessage()}</Text>
          </View>
        </If>
      </View>

      <If when={series().legend.length > 0}>
        <View class="-mt-1 flex-row flex-wrap gap-x-1.5 gap-y-0.5" testID="stats-daily-legend">
          <Each of={series().legend as Segment[]} key={(item) => item.key}>
            {(item) => (
              <TipButton
                disabled={isCache()}
                selected={isolate() === item().key}
                onPress={() => toggleIsolate(item().key)}
                accessibilityLabel={segmentName(item().key)}
                tooltip={hint(legendTitle(item()))}
                testID={`stats-daily-legend-${item().key}`}
                class={`min-h-6.5 flex-row items-center gap-1.75 border border-transparent px-2 py-0.5 transition-colors duration-150 selected:border-blue selected:bg-blue/8 ${
                  isCache() ? "" : "hover:bg-blue/6"
                } ${isolate() && isolate() !== item().key ? "opacity-45" : ""}`}
              >
                <View class={`size-2 ${swatchClass(item())}`} />
                <Text class={`${MONO} text-subtle line-clamp-1`}>{segmentName(item().key)}</Text>
                <Text class={`${MONO} text-foreground`}>{metricValue(item().value)}</Text>
              </TipButton>
            )}
          </Each>
        </View>
      </If>

      {/* The range's figures as one datasheet row (two of three on narrower windows). */}
      <View class="border-t border-line" testID="stats-daily-figures">
        <Each of={figureRows(figures(), figureColumns())}>
          {(row, rowIndex) => (
            <View class={`flex-row ${rowIndex() > 0 ? "mt-2.5 border-t border-dashed border-line-soft" : ""}`}>
              <Each of={row()}>
                {(item, index) => (
                  <View class={`flex-1 gap-0.75 pt-2.5 ${index() > 0 ? "border-l border-dashed border-line-soft px-3" : "pr-3"}`}>
                    <View class="flex-row items-center">
                      <If when={item().key === "avg"}>
                        <View class="mr-1.5 w-3.5 border-t border-dashed border-foreground/55" />
                      </If>
                      <Text class={`${MONO} uppercase tracking-[0.12em] text-subtle line-clamp-1`}>{item().label}</Text>
                    </View>
                    <View class="flex-row items-baseline" tooltip={hint(item().title)}>
                      <Text class={`${MONO} text-foreground`}>{item().value}</Text>
                      <If when={item().note}>
                        <Text class={`ml-1.5 ${MONO} text-subtle`}>{item().note}</Text>
                      </If>
                    </View>
                  </View>
                )}
              </Each>
            </View>
          )}
        </Each>
      </View>
    </ObserveSection>
  );
}

// Vue's .stats-daily-key/.stats-daily-value face: mono label size.
const MONO = "font-mono text-[11px] leading-[15.4px] tabular-nums";

function figureRows<T>(items: T[], size: number): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += size) rows.push(items.slice(i, i + size));
  return rows;
}

function ReadoutItem(props: { label: string; value: string; title?: string; spread?: boolean }) {
  return (
    <View class={`flex-row items-baseline gap-1.5 ${props.spread ? "flex-1 justify-between" : ""}`} tooltip={hint(props.title)}>
      <Text class={`${MONO} uppercase tracking-[0.12em] text-subtle`}>{props.label}</Text>
      <Text class={`${MONO} text-foreground`}>{props.value}</Text>
    </View>
  );
}
