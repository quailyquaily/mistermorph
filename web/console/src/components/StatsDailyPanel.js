import { computed, onMounted, ref, watch } from "vue";
import "./StatsDailyPanel.css";

import AppTabs from "./AppTabs";

import { endpointState, runtimeApiFetch, translate } from "../core/context";
import { currentLocale } from "../i18n";
import { formatCompactCost, formatExactCost } from "../core/cost-format.js";
import { DAILY_METRICS, DAILY_RANGES, barFraction, summarizeDailyUsage } from "../core/daily-usage.js";

function browserTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

// Daily cost or tokens as a bar chart, one bar per calendar day in the viewer's time zone.
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
    const timeZone = browserTimeZone();
    let requestSeq = 0;

    const rangeTabs = computed(() => DAILY_RANGES.map((n) => ({ id: n, title: t("stats_daily_range_days", { count: n }) })));
    const rangeTab = computed(() => rangeTabs.value.find((tab) => tab.id === range.value) || null);
    const metricTabs = computed(() =>
      DAILY_METRICS.map((m) => ({ id: m, title: t(m === "tokens" ? "stats_daily_metric_tokens" : "stats_daily_metric_cost") })),
    );
    const metricTab = computed(() => metricTabs.value.find((tab) => tab.id === metric.value) || null);
    const series = computed(() => summarizeDailyUsage(payload.value, metric.value));
    const hasRequests = computed(() => Number(payload.value?.summary?.requests || 0) > 0);
    const emptyMessage = computed(() => {
      if (unsupported.value) {
        return t("stats_daily_unsupported");
      }
      return !loading.value && !err.value && !hasRequests.value ? t("stats_daily_empty") : "";
    });
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
      return series.value.metric === "tokens" ? compactNumber(value) : cost(value);
    }

    function metricExact(value) {
      return series.value.metric === "tokens" ? exactNumber(value) : exactCost(value);
    }

    function axisValue(value) {
      if (series.value.metric === "tokens") {
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

    const ticks = computed(() =>
      series.value.ticks.map((value) => ({
        value,
        label: axisValue(value),
        bottom: series.value.scaleMax > 0 ? (value / series.value.scaleMax) * 100 : 0,
      })),
    );

    const averageLine = computed(() => {
      const { average, scaleMax } = series.value;
      if (!hasRequests.value || average <= 0 || scaleMax <= 0) {
        return null;
      }
      return { bottom: (average / scaleMax) * 100, label: metricValue(average) };
    });

    const figures = computed(() => {
      const s = series.value;
      return [
        { key: "avg", label: t("stats_daily_avg"), value: metricValue(s.average), title: metricExact(s.average) },
        {
          key: "peak",
          label: t("stats_daily_peak"),
          value: s.peak ? metricValue(s.peak.value) : "-",
          note: s.peak ? s.peak.date.slice(5) : "",
          title: s.peak ? `${s.peak.date} · ${metricExact(s.peak.value)}` : "",
        },
        { key: "today", label: t("stats_daily_today"), value: metricValue(s.today), title: metricExact(s.today) },
        { key: "total", label: t("stats_daily_total"), value: metricValue(s.total), title: metricExact(s.total) },
        { key: "active", label: t("stats_daily_active"), value: `${s.activeDays}/${s.days.length}` },
        { key: "cache", label: t("stats_cache_rate"), value: percent(s.cacheRate) },
      ];
    });

    function barHeight(day) {
      return `${barFraction(day.value, series.value.scaleMax) * 100}%`;
    }

    function barLabel(day) {
      return `${day.date}: ${cost(day.cost)}, ${exactNumber(day.requests)} ${t("stats_requests")}, ${compactNumber(day.tokens)} ${t("stats_tokens")}`;
    }

    function onBarClick(index) {
      pinned.value = pinned.value === index ? null : index;
    }

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
      hasRequests,
      emptyMessage,
      hovered,
      pinned,
      focusedIndex,
      focusedDay,
      ticks,
      averageLine,
      figures,
      timeZone,
      setRange,
      onBarClick,
      barHeight,
      barLabel,
      cost,
      exactCost,
      compactNumber,
      exactNumber,
      percent,
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
                'is-focused': index === focusedIndex && (hovered !== null || pinned !== null),
                'is-pinned': index === pinned,
              }"
              :aria-label="barLabel(day)"
              :aria-pressed="index === pinned ? 'true' : 'false'"
              @mouseenter="hovered = index"
              @focus="hovered = index"
              @blur="hovered = null"
              @click="onBarClick(index)"
            >
              <span class="stats-daily-bar-fill" :style="{ height: barHeight(day) }"></span>
            </button>
          </div>
          <p v-if="emptyMessage" class="stats-daily-empty">{{ emptyMessage }}</p>
        </div>
        <div class="stats-daily-xaxis" aria-hidden="true">
          <span
            v-for="(day, index) in series.days"
            :key="'x:' + day.date"
            class="stats-daily-xlabel"
            :class="{ 'is-hidden': !day.showLabel, 'is-focused': index === focusedIndex }"
          >{{ day.label }}</span>
        </div>
      </div>

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
