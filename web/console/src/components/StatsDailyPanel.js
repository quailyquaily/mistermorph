import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import "./StatsDailyPanel.css";

import AppTabs from "./AppTabs";

import { endpointState, runtimeApiFetch, translate } from "../core/context";
import { currentLocale } from "../i18n";
import { formatCompactCost, formatExactCost } from "../core/cost-format.js";
import { prefersReducedMotion, tweenValue } from "../core/tween.js";
import {
  DAILY_METRICS,
  DAILY_RANGES,
  OTHER_KEY,
  assignModelSlots,
  barFraction,
  summarizeDailyUsage,
} from "../core/daily-usage.js";

const METRIC_TITLE_KEYS = {
  cost: "stats_daily_metric_cost",
  tokens: "stats_daily_metric_tokens",
  cache: "stats_daily_metric_cache",
};

const CACHE_PART_KEYS = {
  hits: "stats_daily_cache_hits",
  writes: "stats_daily_cache_writes",
  uncached: "stats_daily_cache_uncached",
};

function browserTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

// Daily usage as stacked bars, one per calendar day in the viewer's time zone: cost or tokens
// split by model, or input tokens split by how the prompt cache served them.
const StatsDailyPanel = {
  components: {
    AppTabs,
  },
  setup() {
    const t = translate;
    const range = ref(30);
    const metric = ref("cost");
    const payload = ref(null);
    const loading = ref(false);
    const err = ref("");
    const unsupported = ref(false);
    const hovered = ref(null);
    const pinned = ref(null);
    const isolate = ref(null);
    const slots = ref(new Map());
    const timeZone = browserTimeZone();
    let requestSeq = 0;

    const rangeTabs = computed(() => DAILY_RANGES.map((n) => ({ id: n, title: t("stats_daily_range_days", { count: n }) })));
    const rangeTab = computed(() => rangeTabs.value.find((tab) => tab.id === range.value) || null);
    const metricTabs = computed(() => DAILY_METRICS.map((m) => ({ id: m, title: t(METRIC_TITLE_KEYS[m]) })));
    const metricTab = computed(() => metricTabs.value.find((tab) => tab.id === metric.value) || null);
    const series = computed(() =>
      summarizeDailyUsage(payload.value, metric.value, { slots: slots.value, isolate: isolate.value }),
    );
    const isCache = computed(() => series.value.metric === "cache");
    const hasRequests = computed(() => Number(payload.value?.summary?.requests || 0) > 0);
    const emptyMessage = computed(() => {
      if (unsupported.value) {
        return t("stats_daily_unsupported");
      }
      return !loading.value && !err.value && !hasRequests.value ? t("stats_daily_empty") : "";
    });
    const selecting = computed(() => hovered.value !== null || pinned.value !== null);
    const focusedIndex = computed(() => {
      const count = series.value.days.length;
      for (const index of [hovered.value, pinned.value]) {
        if (Number.isInteger(index) && index >= 0 && index < count) {
          return index;
        }
      }
      return count - 1;
    });
    const focusedDay = computed(() => series.value.days[focusedIndex.value] || null);

    function compactNumber(value) {
      return new Intl.NumberFormat(currentLocale(), { notation: "compact", maximumFractionDigits: 2 }).format(Number(value) || 0);
    }

    function exactNumber(value) {
      return new Intl.NumberFormat(currentLocale()).format(Math.trunc(Number(value) || 0));
    }

    function percent(value) {
      if (value === null || value === undefined) {
        return "-";
      }
      return new Intl.NumberFormat(currentLocale(), { style: "percent", maximumFractionDigits: 0 }).format(value);
    }

    function cost(value) {
      return formatCompactCost(value, series.value.currency, currentLocale());
    }

    function exactCost(value) {
      return formatExactCost(value, series.value.currency, currentLocale());
    }

    function metricValue(value) {
      return series.value.metric === "cost" ? cost(value) : compactNumber(value);
    }

    function metricExact(value) {
      return series.value.metric === "cost" ? exactCost(value) : exactNumber(value);
    }

    function axisValue(value) {
      if (series.value.metric !== "cost") {
        return compactNumber(value);
      }
      if (value === 0) {
        return "0";
      }
      return new Intl.NumberFormat(currentLocale(), {
        style: "currency",
        currency: series.value.currency === "MIXED" ? "USD" : series.value.currency,
        maximumSignificantDigits: 3,
      }).format(value);
    }

    // Cache savings are what caching took off the input bill; negative when writes cost more.
    function savings(delta) {
      return delta === null || delta === undefined ? "-" : cost(-delta);
    }

    function segmentName(key) {
      if (key === OTHER_KEY) {
        return t("stats_daily_other");
      }
      return CACHE_PART_KEYS[key] ? t(CACHE_PART_KEYS[key]) : key;
    }

    function segmentClass(segment) {
      if (Number.isInteger(segment?.slot)) {
        return `is-slot-${segment.slot + 1}`;
      }
      return segment?.key === OTHER_KEY || !segment?.key ? "is-other" : `is-${segment.key}`;
    }

    const ticks = computed(() =>
      series.value.ticks.map((value) => ({
        value,
        label: axisValue(value),
        bottom: series.value.scaleMax > 0 ? (value / series.value.scaleMax) * 100 : 0,
      })),
    );

    const averageLine = computed(() => {
      const { average, scaleMax } = series.value;
      if (isCache.value || !hasRequests.value || average <= 0 || scaleMax <= 0) {
        return null;
      }
      return { bottom: (average / scaleMax) * 100 };
    });

    // Figures roll to their new values when the range or metric changes.
    const ROLL_MS = 420;
    const figureTargets = computed(() => {
      const s = series.value;
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
      };
    });
    const rolled = reactive({});
    let rollFrame = 0;
    watch(
      figureTargets,
      (targets) => {
        cancelAnimationFrame(rollFrame);
        const from = { ...rolled };
        if (prefersReducedMotion() || Object.keys(from).length === 0) {
          Object.assign(rolled, targets);
          return;
        }
        const start = performance.now();
        const step = (now) => {
          const elapsed = now - start;
          for (const [key, value] of Object.entries(targets)) {
            rolled[key] = tweenValue(from[key], value, elapsed, ROLL_MS);
          }
          if (elapsed < ROLL_MS) {
            rollFrame = requestAnimationFrame(step);
          }
        };
        rollFrame = requestAnimationFrame(step);
      },
      { immediate: true },
    );
    onBeforeUnmount(() => cancelAnimationFrame(rollFrame));

    function shown(key) {
      return key in rolled ? rolled[key] : figureTargets.value[key];
    }

    const figures = computed(() => {
      const s = series.value;
      const active = { key: "active", label: t("stats_daily_active"), value: `${s.activeDays}/${s.days.length}` };
      if (isCache.value) {
        return [
          { key: "rate", label: t("stats_cache_rate"), value: percent(shown("rate")) },
          { key: "hits", label: t("stats_daily_cache_hits"), value: compactNumber(shown("hits")), title: exactNumber(s.cache.hits) },
          { key: "writes", label: t("stats_daily_cache_writes"), value: compactNumber(shown("writes")), title: exactNumber(s.cache.writes) },
          { key: "uncached", label: t("stats_daily_cache_uncached"), value: compactNumber(shown("uncached")), title: exactNumber(s.cache.uncached) },
          { key: "savings", label: t("stats_cache_delta"), value: savings(s.cache.delta === null ? null : -shown("savings")), title: s.cache.delta === null ? "" : exactCost(-s.cache.delta) },
          active,
        ];
      }
      return [
        { key: "avg", label: t("stats_daily_avg"), value: metricValue(shown("average")), title: metricExact(s.average) },
        {
          key: "peak",
          label: t("stats_daily_peak"),
          value: s.peak ? metricValue(shown("peak")) : "-",
          note: s.peak ? s.peak.date.slice(5) : "",
          title: s.peak ? `${s.peak.date} · ${metricExact(s.peak.value)}` : "",
        },
        { key: "today", label: t("stats_daily_today"), value: metricValue(shown("today")), title: metricExact(s.today) },
        { key: "total", label: t("stats_daily_total"), value: metricValue(shown("total")), title: metricExact(s.total) },
        active,
        { key: "cache", label: t("stats_cache_rate"), value: percent(shown("cacheRate")) },
      ];
    });

    // Tooltip rows for the focused day: its models, or its cache split.
    const tooltip = computed(() => {
      const day = focusedDay.value;
      if (!selecting.value || !day || day.requests <= 0) {
        return null;
      }
      const count = series.value.days.length;
      const center = ((focusedIndex.value + 0.5) / count) * 100;
      let rows;
      if (isCache.value) {
        rows = day.segments.map((segment) => ({
          key: segment.key,
          name: segmentName(segment.key),
          swatch: segmentClass(segment),
          value: compactNumber(segment.value),
          title: exactNumber(segment.value),
        }));
        rows.push({ key: "rate", name: t("stats_daily_cache_rate"), value: percent(day.cache.rate) });
        rows.push({ key: "savings", name: t("stats_cache_delta"), value: savings(day.cache.delta) });
      } else {
        rows = day.models
          .filter((item) => !isolate.value || item.model === isolate.value || (isolate.value === OTHER_KEY && item.slot === null))
          .map((item) => {
            const value = series.value.metric === "tokens" ? item.tokens : item.cost;
            return {
              key: item.model,
              name: item.model,
              swatch: segmentClass({ key: item.model, slot: item.slot }),
              value: metricValue(value),
              title: metricExact(value),
              note: `${exactNumber(item.requests)} ${t("stats_daily_req")}`,
            };
          });
      }
      if (rows.length === 0) {
        return null;
      }
      return {
        date: day.date,
        total: isCache.value ? null : metricValue(day.value),
        rows,
        style: center > 55 ? { right: `${100 - center}%` } : { left: `${center}%` },
        side: center > 55 ? "is-left" : "is-right",
      };
    });

    // Bars grow from the baseline, left to right, whenever a range loads; switching the metric
    // reshapes them with the same stagger.
    const drawn = ref(false);
    function redrawBars() {
      drawn.value = false;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        drawn.value = true;
      }));
    }

    function barHeight(day) {
      return drawn.value ? `${barFraction(day.value, series.value.scaleMax) * 100}%` : "0%";
    }

    function barDelay(index) {
      const count = series.value.days.length || 1;
      return `${Math.round(index * Math.min(14, 280 / count))}ms`;
    }

    function segmentHeight(day, segment) {
      return day.value > 0 ? `${(segment.value / day.value) * 100}%` : "0";
    }

    function barLabel(day) {
      return `${day.date}: ${cost(day.cost)}, ${exactNumber(day.requests)} ${t("stats_requests")}, ${compactNumber(day.tokens)} ${t("stats_tokens")}, ${t("stats_cache_rate")} ${percent(day.cacheRate)}`;
    }

    function onBarClick(index) {
      pinned.value = pinned.value === index ? null : index;
    }

    function toggleIsolate(key) {
      if (!isCache.value) {
        isolate.value = isolate.value === key ? null : key;
      }
    }

    function legendTitle(item) {
      if (isCache.value) {
        return exactNumber(item.value);
      }
      const name = segmentName(item.key);
      return isolate.value === item.key ? t("stats_daily_show_all") : t("stats_daily_show_only", { name });
    }

    watch(payload, (data) => {
      slots.value = assignModelSlots(slots.value, data?.models);
      if (isolate.value && !series.value.legend.some((item) => item.key === isolate.value)) {
        isolate.value = null;
      }
    });

    async function load() {
      const seq = ++requestSeq;
      loading.value = true;
      err.value = "";
      unsupported.value = false;
      try {
        const query = new URLSearchParams({ days: String(range.value), tz: timeZone });
        const data = await runtimeApiFetch(`/stats/llm/daily?${query}`);
        if (seq === requestSeq) {
          payload.value = data && typeof data === "object" ? data : null;
          redrawBars();
        }
      } catch (e) {
        if (seq === requestSeq) {
          payload.value = null;
          // Agents built before the daily route answer 404.
          if (e?.status === 404) {
            unsupported.value = true;
          } else {
            err.value = e.message || t("msg_load_failed");
          }
        }
      } finally {
        if (seq === requestSeq) {
          loading.value = false;
        }
      }
    }

    function setRange(value) {
      if (range.value !== value) {
        range.value = value;
        pinned.value = null;
        hovered.value = null;
        void load();
      }
    }

    onMounted(load);
    watch(
      () => endpointState.selectedRef,
      () => {
        pinned.value = null;
        isolate.value = null;
        slots.value = new Map();
        void load();
      },
    );

    return {
      t,
      rangeTabs,
      rangeTab,
      metricTabs,
      metricTab,
      range,
      metric,
      loading,
      err,
      series,
      isCache,
      hasRequests,
      emptyMessage,
      hovered,
      pinned,
      isolate,
      selecting,
      focusedIndex,
      focusedDay,
      ticks,
      averageLine,
      figures,
      tooltip,
      timeZone,
      setRange,
      onBarClick,
      toggleIsolate,
      legendTitle,
      barHeight,
      barDelay,
      segmentHeight,
      segmentName,
      segmentClass,
      barLabel,
      metricValue,
      cost,
      exactCost,
      compactNumber,
      exactNumber,
      percent,
      savings,
    };
  },
  template: `
    <section class="stats-daily" :aria-busy="loading ? 'true' : 'false'">
      <header class="stats-daily-head">
        <div class="stats-daily-heading">
          <h2 class="stats-daily-title">{{ t("stats_daily_title") }}</h2>
          <span class="stats-daily-zone" :title="t('stats_daily_zone', { zone: timeZone })">{{ timeZone }}</span>
        </div>
        <div class="stats-daily-controls">
          <AppTabs :tabs="rangeTabs" :modelValue="rangeTab" :ariaLabel="t('stats_daily_range')" @change="setRange($event.tab.id)" />
          <AppTabs :tabs="metricTabs" :modelValue="metricTab" :ariaLabel="t('stats_daily_metric')" @change="metric = $event.tab.id" />
        </div>
      </header>

      <p v-if="err" class="stats-daily-error">{{ err }}</p>

      <div v-if="focusedDay" class="stats-daily-readout" aria-live="polite">
        <span class="stats-daily-readout-date">
          {{ focusedDay.date }}<template v-if="focusedDay.isToday"> · {{ t("stats_daily_in_progress") }}</template>
        </span>
        <span class="stats-daily-readout-item">
          <span class="stats-daily-key">{{ t("stats_daily_metric_cost") }}</span>
          <span class="stats-daily-value" :title="exactCost(focusedDay.cost)">{{ cost(focusedDay.cost) }}</span>
        </span>
        <span class="stats-daily-readout-item">
          <span class="stats-daily-key">{{ t("stats_requests") }}</span>
          <span class="stats-daily-value">{{ exactNumber(focusedDay.requests) }}</span>
        </span>
        <span class="stats-daily-readout-item">
          <span class="stats-daily-key">{{ t("stats_tokens") }}</span>
          <span class="stats-daily-value" :title="exactNumber(focusedDay.tokens)">{{ compactNumber(focusedDay.tokens) }}</span>
        </span>
        <span class="stats-daily-readout-item is-wide">
          <span class="stats-daily-key">{{ t("stats_input") }} / {{ t("stats_output") }}</span>
          <span class="stats-daily-value">{{ compactNumber(focusedDay.inputTokens) }} / {{ compactNumber(focusedDay.outputTokens) }}</span>
        </span>
        <span class="stats-daily-readout-item">
          <span class="stats-daily-key">{{ t("stats_cache_rate") }}</span>
          <span class="stats-daily-value">{{ percent(focusedDay.cacheRate) }}</span>
        </span>
      </div>

      <div class="stats-daily-chart" :class="{ 'is-dense': series.days.length > 31 }">
        <div class="stats-daily-axis" aria-hidden="true">
          <span v-for="tick in ticks" :key="'tick:' + tick.value" class="stats-daily-tick" :style="{ bottom: tick.bottom + '%' }">{{ tick.label }}</span>
        </div>
        <div class="stats-daily-plot" @mouseleave="hovered = null">
          <span v-for="tick in ticks" :key="'grid:' + tick.value" class="stats-daily-grid" :class="{ 'is-base': tick.value === 0 }" :style="{ bottom: tick.bottom + '%' }" aria-hidden="true"></span>
          <span v-if="averageLine" class="stats-daily-average" :style="{ bottom: averageLine.bottom + '%' }" aria-hidden="true"></span>
          <div class="stats-daily-bars">
            <button
              v-for="(day, index) in series.days"
              :key="day.date"
              type="button"
              class="stats-daily-bar"
              :class="{
                'is-today': day.isToday,
                'is-focused': index === focusedIndex && selecting,
                'is-pinned': index === pinned,
              }"
              :aria-label="barLabel(day)"
              :aria-pressed="index === pinned ? 'true' : 'false'"
              @mouseenter="hovered = index"
              @focus="hovered = index"
              @blur="hovered = null"
              @click="onBarClick(index)"
            >
              <span class="stats-daily-bar-stack" :style="{ height: barHeight(day), transitionDelay: barDelay(index) }">
                <span
                  v-for="segment in day.segments"
                  :key="segment.key"
                  class="stats-daily-segment"
                  :class="segmentClass(segment)"
                  :style="{ height: segmentHeight(day, segment) }"
                ></span>
              </span>
            </button>
          </div>
          <div v-if="tooltip" class="stats-daily-tooltip" :class="tooltip.side" :style="tooltip.style" aria-hidden="true">
            <div class="stats-daily-tooltip-head">
              <span>{{ tooltip.date }}</span>
              <span v-if="tooltip.total" class="stats-daily-value">{{ tooltip.total }}</span>
            </div>
            <div v-for="row in tooltip.rows" :key="row.key" class="stats-daily-tooltip-row">
              <span v-if="row.swatch" class="stats-daily-swatch" :class="row.swatch"></span>
              <span v-else class="stats-daily-swatch is-blank"></span>
              <span class="stats-daily-tooltip-name">{{ row.name }}</span>
              <span v-if="row.note" class="stats-daily-note">{{ row.note }}</span>
              <span class="stats-daily-value" :title="row.title || undefined">{{ row.value }}</span>
            </div>
          </div>
          <p v-if="emptyMessage" class="stats-daily-empty">{{ emptyMessage }}</p>
        </div>
        <div class="stats-daily-xaxis" aria-hidden="true">
          <span
            v-for="(day, index) in series.days"
            :key="'x:' + day.date"
            class="stats-daily-xlabel"
            :class="{ 'is-hidden': !day.showLabel, 'is-focused': index === focusedIndex && selecting }"
          >{{ day.label }}</span>
        </div>
      </div>

      <ul v-if="series.legend.length > 0" class="stats-daily-legend" :class="{ 'is-static': isCache }">
        <li v-for="item in series.legend" :key="item.key">
          <component
            :is="isCache ? 'span' : 'button'"
            :type="isCache ? undefined : 'button'"
            class="stats-daily-legend-item"
            :class="{ 'is-muted': isolate && isolate !== item.key, 'is-active': isolate === item.key }"
            :aria-pressed="isCache ? undefined : (isolate === item.key ? 'true' : 'false')"
            :title="legendTitle(item)"
            @click="toggleIsolate(item.key)"
          >
            <span class="stats-daily-swatch" :class="segmentClass(item)"></span>
            <span class="stats-daily-legend-name">{{ segmentName(item.key) }}</span>
            <span class="stats-daily-value">{{ metricValue(item.value) }}</span>
          </component>
        </li>
      </ul>

      <dl class="stats-daily-figures">
        <div v-for="item in figures" :key="item.key" class="stats-daily-figure">
          <dt class="stats-daily-key">
            <span v-if="item.key === 'avg'" class="stats-daily-average-swatch" aria-hidden="true"></span>{{ item.label }}
          </dt>
          <dd class="stats-daily-value" :title="item.title || undefined">
            {{ item.value }}<span v-if="item.note" class="stats-daily-note">{{ item.note }}</span>
          </dd>
        </div>
      </dl>
    </section>
  `,
};

export default StatsDailyPanel;
