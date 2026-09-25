import { computed, onMounted, ref, watch } from "vue";
import "./StatsView.css";
import { formatCompactCost, formatExactCost } from "../core/cost-format.js";

import AppPage from "../components/AppPage";
import AppTabs from "../components/AppTabs";
import StatsDailyPanel from "../components/StatsDailyPanel";
import { endpointState, formatShortTime, runtimeApiFetch, translate } from "../core/context";
import { modelVendorMeta } from "../core/model-vendor";

function hasMetricValue(totals, key) {
  return Boolean(totals) && Object.prototype.hasOwnProperty.call(totals, key);
}

function formatNumber(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) {
    return "0";
  }
  return Math.trunc(n).toLocaleString();
}

function toFiniteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}




function formatPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return "-";
  }
  const clamped = Math.min(Math.max(n, 0), 1);
  return new Intl.NumberFormat(undefined, {
    style: "percent",
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(clamped);
}

function modelCacheBaseInputTokens(row) {
  const inputTokens = toFiniteNumber(row?.input_tokens);
  const cachedInputTokens = toFiniteNumber(row?.cached_input_tokens);
  const cacheCreationInputTokens = toFiniteNumber(row?.cache_creation_input_tokens);
  return Math.max(0, inputTokens - cachedInputTokens - cacheCreationInputTokens);
}

function modelCacheRate(row) {
  const inputTokens = toFiniteNumber(row?.input_tokens);
  if (inputTokens <= 0) {
    return null;
  }
  const cachedInputTokens = Math.min(toFiniteNumber(row?.cached_input_tokens), inputTokens);
  return Math.max(0, cachedInputTokens / inputTokens);
}

function modelCacheCostDelta(row) {
  const inputTokens = toFiniteNumber(row?.input_tokens);
  if (inputTokens <= 0) {
    return null;
  }

  const cachedInputTokens = toFiniteNumber(row?.cached_input_tokens);
  const cacheCreationInputTokens = toFiniteNumber(row?.cache_creation_input_tokens);
  if (cachedInputTokens <= 0 && cacheCreationInputTokens <= 0) {
    return 0;
  }

  const baseInputTokens = modelCacheBaseInputTokens(row);
  if (baseInputTokens <= 0 || !hasMetricValue(row, "input_cost")) {
    return null;
  }

  const inputCost = Number(row?.input_cost);
  if (!Number.isFinite(inputCost)) {
    return null;
  }

  const baseInputCostPerToken = inputCost / baseInputTokens;
  if (!Number.isFinite(baseInputCostPerToken)) {
    return null;
  }

  const actualInputCost =
    inputCost + toFiniteNumber(row?.cached_input_cost) + toFiniteNumber(row?.cache_creation_input_cost);
  const baselineInputCostWithoutCache = baseInputCostPerToken * inputTokens;
  return actualInputCost - baselineInputCostWithoutCache;
}

function summaryHeroMetric(t, totals, key) {
  const costCurrency = typeof totals?.cost_currency === "string" ? totals.cost_currency : "USD";
  switch (key) {
    case "total_cost":
      return {
        key,
        label: t("stats_total_cost"),
        value: hasMetricValue(totals, key) ? formatCompactCost(totals[key], costCurrency) : "-",
        title: formatExactCost(totals[key], costCurrency),
        unavailable: !hasMetricValue(totals, key),
      };
    case "total_tokens":
      return {
        key,
        label: t("stats_total_tokens"),
        value: hasMetricValue(totals, key) ? formatNumber(totals[key]) : "-",
        unavailable: !hasMetricValue(totals, key),
      };
    case "requests":
      return {
        key,
        label: t("stats_requests"),
        value: hasMetricValue(totals, key) ? formatNumber(totals[key]) : "-",
        unavailable: !hasMetricValue(totals, key),
      };
    default:
      return {
        key,
        label: key,
        value: "-",
        unavailable: true,
      };
  }
}

function summaryHeroMetrics(t, totals) {
  return {
    primary: summaryHeroMetric(t, totals, "total_cost"),
    secondary: ["total_tokens", "requests"].map((key) => summaryHeroMetric(t, totals, key)),
  };
}

function costMetrics(t, totals) {
  const costCurrency = typeof totals?.cost_currency === "string" ? totals.cost_currency : "USD";
  return [
    {
      key: "total_cost",
      label: t("stats_total"),
      value: hasMetricValue(totals, "total_cost") ? formatCompactCost(totals.total_cost, costCurrency) : "-",
      title: formatExactCost(totals.total_cost, costCurrency),
      unavailable: !hasMetricValue(totals, "total_cost"),
    },
    {
      key: "input_cost",
      label: t("stats_input"),
      value: hasMetricValue(totals, "input_cost") ? formatCompactCost(totals.input_cost, costCurrency) : "-",
      title: formatExactCost(totals.input_cost, costCurrency),
      unavailable: !hasMetricValue(totals, "input_cost"),
    },
    {
      key: "output_cost",
      label: t("stats_output"),
      value: hasMetricValue(totals, "output_cost") ? formatCompactCost(totals.output_cost, costCurrency) : "-",
      title: formatExactCost(totals.output_cost, costCurrency),
      unavailable: !hasMetricValue(totals, "output_cost"),
    },
    {
      key: "cached_input_cost",
      label: t("stats_cached_input"),
      value: hasMetricValue(totals, "cached_input_cost") ? formatCompactCost(totals.cached_input_cost, costCurrency) : "-",
      title: formatExactCost(totals.cached_input_cost, costCurrency),
      unavailable: !hasMetricValue(totals, "cached_input_cost"),
    },
    {
      key: "cache_creation_input_cost",
      label: t("stats_cache_write"),
      value: hasMetricValue(totals, "cache_creation_input_cost")
        ? formatCompactCost(totals.cache_creation_input_cost, costCurrency)
        : "-",
      title: formatExactCost(totals.cache_creation_input_cost, costCurrency),
      unavailable: !hasMetricValue(totals, "cache_creation_input_cost"),
    },
  ];
}

function tokenMetrics(t, totals) {
  return [
    {
      key: "total_tokens",
      label: t("stats_total"),
      value: hasMetricValue(totals, "total_tokens") ? formatNumber(totals.total_tokens) : "-",
      unavailable: !hasMetricValue(totals, "total_tokens"),
    },
    {
      key: "input_tokens",
      label: t("stats_input"),
      value: hasMetricValue(totals, "input_tokens") ? formatNumber(totals.input_tokens) : "-",
      unavailable: !hasMetricValue(totals, "input_tokens"),
    },
    {
      key: "output_tokens",
      label: t("stats_output"),
      value: hasMetricValue(totals, "output_tokens") ? formatNumber(totals.output_tokens) : "-",
      unavailable: !hasMetricValue(totals, "output_tokens"),
    },
    {
      key: "cached_input_tokens",
      label: t("stats_cached_input"),
      value: hasMetricValue(totals, "cached_input_tokens") ? formatNumber(totals.cached_input_tokens) : "-",
      unavailable: !hasMetricValue(totals, "cached_input_tokens"),
    },
    {
      key: "cache_creation_input_tokens",
      label: t("stats_cache_write"),
      value: hasMetricValue(totals, "cache_creation_input_tokens")
        ? formatNumber(totals.cache_creation_input_tokens)
        : "-",
      unavailable: !hasMetricValue(totals, "cache_creation_input_tokens"),
    },
  ];
}

function formatModelLedgerValue(row, column) {
  if (column.kind === "cost") {
    const currency = typeof row?.cost_currency === "string" ? row.cost_currency : "USD";
    return hasMetricValue(row, column.key) ? formatCompactCost(row[column.key], currency) : "-";
  }
  if (column.kind === "cache_cost_delta") {
    // Shown as savings: positive when the cache made input cheaper, negative when cache writes
    // cost more than they saved.
    const currency = typeof row?.cost_currency === "string" ? row.cost_currency : "USD";
    const delta = modelCacheCostDelta(row);
    return delta === null ? "-" : formatCompactCost(Math.abs(delta) < 1e-12 ? 0 : -delta, currency);
  }
  if (column.kind === "cache_rate") {
    const rate = modelCacheRate(row);
    return rate === null ? "-" : formatPercent(rate);
  }
  return hasMetricValue(row, column.key) ? formatNumber(row[column.key]) : "-";
}

function modelLedgerValueTitle(row, column) {
  const currency = typeof row?.cost_currency === "string" ? row.cost_currency : "USD";
  if (column.kind === "cost" && hasMetricValue(row, column.key)) {
    return formatExactCost(row[column.key], currency);
  }
  if (column.kind === "cache_cost_delta") {
    const delta = modelCacheCostDelta(row);
    return delta === null ? undefined : formatExactCost(-delta, currency);
  }
  return undefined;
}

function isModelLedgerValueUnavailable(row, column) {
  if (column.kind === "cache_cost_delta") {
    return modelCacheCostDelta(row) === null;
  }
  if (column.kind === "cache_rate") {
    return modelCacheRate(row) === null;
  }
  return !hasMetricValue(row, column.key);
}

function modelLedgerValueToneClass(row, column) {
  if (column.kind !== "cache_cost_delta") {
    return "";
  }
  const delta = modelCacheCostDelta(row);
  if (delta === null || Math.abs(delta) < 1e-12) {
    return "";
  }
  // delta > 0 means the cache cost more than it saved.
  return delta > 0 ? "stats-model-ledger-value-cell-cost-up" : "stats-model-ledger-value-cell-cost-down";
}

const StatsView = {
  components: {
    AppPage,
    AppTabs,
    StatsDailyPanel,
  },
  setup() {
    const t = translate;
    const loading = ref(false);
    const err = ref("");
    const activeTabID = ref("api_hosts");
    const payload = ref({
      updated_at: "",
      projected_records: 0,
      skipped_records: 0,
      summary: {},
      api_hosts: [],
      models: [],
    });

    const statsTabs = computed(() => [
      { id: "api_hosts", title: t("stats_group_api_hosts") },
      { id: "models", title: t("stats_group_models") },
    ]);
    const selectedStatsTab = computed(() => statsTabs.value.find((item) => item.id === activeTabID.value) || statsTabs.value[0] || null);

    const visibleHosts = computed(() => (Array.isArray(payload.value.api_hosts) ? payload.value.api_hosts : []));
    const visibleModels = computed(() => (Array.isArray(payload.value.models) ? payload.value.models : []));
    const heroSummaryMetrics = computed(() => summaryHeroMetrics(t, payload.value.summary || {}));
    const summaryCosts = computed(() => costMetrics(t, payload.value.summary || {}).filter(
      (item) => item.key !== "total_cost" && !item.unavailable,
    ));
    const summaryTokens = computed(() => tokenMetrics(t, payload.value.summary || {}).filter(
      (item) => item.key !== "total_tokens" && !item.unavailable,
    ));
    const summaryMetaItems = computed(() => {
      const items = [];
      if (payload.value.updated_at) {
        const value = formatShortTime(payload.value.updated_at);
        items.push({
          key: "updated",
          icon: "PhClockCounterClockwise",
          text: value,
          label: `${t("stats_updated_at")}: ${value}`,
        });
      }
      const projectedRecords = formatNumber(payload.value.projected_records);
      items.push({
        key: "projected_records",
        icon: "PhChartLineUp",
        text: projectedRecords,
        label: `${t("stats_projected_records")}: ${projectedRecords}`,
      });
      if (Number(payload.value.skipped_records || 0) > 0) {
        const skippedRecords = formatNumber(payload.value.skipped_records);
        const text = `${t("stats_skipped_records")}: ${skippedRecords}`;
        items.push({ key: "skipped_records", text, label: text });
      }
      return items;
    });
    async function load() {
      loading.value = true;
      err.value = "";
      try {
        const data = await runtimeApiFetch("/stats/llm/usage");
        payload.value = {
          updated_at: typeof data.updated_at === "string" ? data.updated_at : "",
          projected_records: Number(data.projected_records || 0),
          skipped_records: Number(data.skipped_records || 0),
          summary: data.summary && typeof data.summary === "object" ? data.summary : {},
          api_hosts: Array.isArray(data.api_hosts) ? data.api_hosts : [],
          models: Array.isArray(data.models) ? data.models : [],
        };
      } catch (e) {
        err.value = e.message || t("msg_load_failed");
      } finally {
        loading.value = false;
      }
    }

    function hostCostMetrics(item) {
      return costMetrics(t, item || {});
    }

    function hostTokenMetrics(item) {
      return tokenMetrics(t, item || {});
    }

    const modelLedgerCostColumns = computed(() => [
      { key: "total_cost", label: t("stats_total"), kind: "cost" },
      { key: "input_cost", label: t("stats_input"), kind: "cost" },
      { key: "output_cost", label: t("stats_output"), kind: "cost" },
      { key: "cached_input_cost", label: t("stats_cached_input"), kind: "cost" },
      { key: "cache_creation_input_cost", label: t("stats_cache_write"), kind: "cost" },
      { key: "cache_cost_delta", label: t("stats_cache_delta"), kind: "cache_cost_delta" },
    ]);
    const modelLedgerTokenColumns = computed(() => [
      { key: "total_tokens", label: t("stats_total"), kind: "token" },
      { key: "input_tokens", label: t("stats_input"), kind: "token" },
      { key: "output_tokens", label: t("stats_output"), kind: "token" },
      { key: "cached_input_tokens", label: t("stats_cached_input"), kind: "token" },
      { key: "cache_creation_input_tokens", label: t("stats_cache_write"), kind: "token" },
      { key: "cache_rate", label: t("stats_cache_rate"), kind: "cache_rate" },
    ]);

    // Costs and tokens are two tables rather than one wide table, so each fits the page on desktop.
    const modelLedgerGroups = computed(() => [
      { key: "cost", label: t("stats_costs"), icon: "PhWallet", columns: modelLedgerCostColumns.value, showRequests: true },
      { key: "tokens", label: t("stats_tokens"), icon: "PhChartBar", columns: modelLedgerTokenColumns.value, showRequests: false },
    ]);

    function onTabChange(detail) {
      const nextID = String(detail?.tab?.id || "").trim();
      activeTabID.value = nextID || "api_hosts";
    }

    onMounted(load);
    watch(
      () => endpointState.selectedRef,
      () => {
        void load();
      }
    );

    return {
      t,
      loading,
      err,
      payload,
      statsTabs,
      selectedStatsTab,
      visibleHosts,
      visibleModels,
      heroSummaryMetrics,
      summaryCosts,
      summaryTokens,
      summaryMetaItems,
      onTabChange,
      hostCostMetrics,
      hostTokenMetrics,
      modelLedgerCostColumns,
      modelLedgerTokenColumns,
      modelLedgerGroups,
      formatModelLedgerValue,
      modelLedgerValueTitle,
      isModelLedgerValueUnavailable,
      modelLedgerValueToneClass,
      modelVendorMeta,
      formatNumber,
    };
  },
  template: `
    <AppPage :title="t('stats_title')">
      <QProgress v-if="loading" :infinite="true" />
      <QFence v-if="err" type="danger" icon="PhXCircle" :text="err" />

      <section class="stats-page">
        <header class="stats-hero block-default">
          <div class="stats-hero-copy">
            <p v-if="summaryMetaItems.length > 0" class="stats-hero-meta">
              <span
                v-for="item in summaryMetaItems"
                :key="item.key"
                class="stats-hero-meta-item"
                :aria-label="item.label"
                :title="item.label"
              >
                <component :is="item.icon" v-if="item.icon" class="stats-hero-meta-icon" aria-hidden="true" />
                <span>{{ item.text }}</span>
              </span>
            </p>
          </div>

          <section class="stats-hero-spotlight">
            <span class="stats-hero-primary-label">{{ heroSummaryMetrics.primary.label }}</span>
            <span class="stats-hero-primary-value" :class="{ 'stats-hero-primary-value-unavailable': heroSummaryMetrics.primary.unavailable }">
              <span :title="heroSummaryMetrics.primary.title">{{ heroSummaryMetrics.primary.value }}</span>
            </span>
            <div class="stats-hero-secondary-grid">
              <article v-for="item in heroSummaryMetrics.secondary" :key="item.key" class="stats-hero-secondary-item">
                <span class="stats-hero-secondary-label">{{ item.label }}</span>
                <span class="stats-hero-secondary-value" :class="{ 'stats-hero-secondary-value-unavailable': item.unavailable }" :title="item.title">
                  {{ item.value }}
                </span>
              </article>
            </div>
          </section>

          <div class="stats-hero-side">
            <div v-if="summaryCosts.length > 0 || summaryTokens.length > 0" class="stats-hero-detail-groups">
              <section v-if="summaryCosts.length > 0" class="stats-hero-detail-group">
                <header class="stats-band-head">
                  <PhWallet class="stats-band-icon icon" />
                  <span class="stats-band-title">{{ t("stats_costs") }}</span>
                </header>
                <div class="stats-inline-meta stats-inline-meta-summary">
                  <div v-for="item in summaryCosts" :key="'summary:cost:' + item.key" class="stats-inline-meta-item">
                    <span class="stats-inline-meta-label">{{ item.label }}</span>
                    <span class="stats-inline-meta-value" :title="item.title">{{ item.value }}</span>
                  </div>
                </div>
              </section>

              <section v-if="summaryTokens.length > 0" class="stats-hero-detail-group">
                <header class="stats-band-head">
                  <PhChartBar class="stats-band-icon icon" />
                  <span class="stats-band-title">{{ t("stats_tokens") }}</span>
                </header>
                <div class="stats-inline-meta stats-inline-meta-summary">
                  <div v-for="item in summaryTokens" :key="'summary:token:' + item.key" class="stats-inline-meta-item">
                    <span class="stats-inline-meta-label">{{ item.label }}</span>
                    <span class="stats-inline-meta-value" :title="item.title">{{ item.value }}</span>
                  </div>
                </div>
              </section>
            </div>
          </div>
        </header>

        <StatsDailyPanel />

        <section class="stats-section">
          <AppTabs
            class="stats-section-tabs"
            :tabs="statsTabs"
            :modelValue="selectedStatsTab"
            :ariaLabel="t('stats_title')"
            @change="onTabChange"
          />

          <div v-if="selectedStatsTab && selectedStatsTab.id === 'api_hosts'" class="stats-section-panel">
            <div v-if="visibleHosts.length === 0" class="stats-empty">{{ t("stats_no_data") }}</div>
            <div v-else class="stats-host-list">
              <article v-for="host in visibleHosts" :key="host.api_host" class="stats-host-block">
                <header class="stats-host-head">
                  <div class="stats-host-ident">
                    <span class="stats-host-eyebrow">{{ t("stats_api_host") }}</span>
                    <code class="stats-host-name">{{ host.api_host }}</code>
                  </div>
                  <div class="stats-request-pill">
                    <span class="stats-request-pill-label">{{ t("stats_requests") }}</span>
                    <span class="stats-request-pill-value">{{ formatNumber(host.requests) }}</span>
                  </div>
                </header>

                <section class="stats-band stats-band-cost">
                  <header class="stats-band-head">
                    <PhWallet class="stats-band-icon icon" />
                    <span class="stats-band-title">{{ t("stats_costs") }}</span>
                  </header>
                  <div class="stats-band-grid">
                    <div v-for="item in hostCostMetrics(host)" :key="host.api_host + ':cost:' + item.key" class="stats-band-cell">
                      <span class="stats-ledger-label">{{ item.label }}</span>
                      <span class="stats-ledger-value" :class="{ 'stats-ledger-value-unavailable': item.unavailable }" :title="item.title">{{ item.value }}</span>
                    </div>
                  </div>
                </section>

                <section class="stats-band stats-band-token">
                  <header class="stats-band-head">
                    <PhChartBar class="stats-band-icon icon" />
                    <span class="stats-band-title">{{ t("stats_tokens") }}</span>
                  </header>
                  <div class="stats-band-grid">
                    <div v-for="item in hostTokenMetrics(host)" :key="host.api_host + ':token:' + item.key" class="stats-band-cell">
                      <span class="stats-ledger-label">{{ item.label }}</span>
                      <span class="stats-ledger-value" :class="{ 'stats-ledger-value-unavailable': item.unavailable }" :title="item.title">{{ item.value }}</span>
                    </div>
                  </div>
                </section>

                <div v-if="Array.isArray(host.models) && host.models.length > 0" class="stats-model-table">
                  <div v-for="group in modelLedgerGroups" :key="host.api_host + ':' + 'group:' + group.key" class="stats-model-ledger-scroll">
                    <table class="stats-model-ledger-table">
                      <thead>
                        <tr class="stats-model-ledger-group-row">
                          <th :colspan="group.columns.length + (group.showRequests ? 2 : 1)" class="stats-model-ledger-group">
                            <span class="stats-model-ledger-group-copy">
                              <component :is="group.icon" class="stats-model-ledger-group-icon icon" />
                              <span>{{ group.label }}</span>
                            </span>
                          </th>
                        </tr>
                        <tr class="stats-model-ledger-column-row">
                          <th class="stats-model-ledger-stub">{{ t("stats_model") }}</th>
                          <th v-if="group.showRequests" class="stats-model-ledger-stub stats-model-ledger-stub-requests">{{ t("stats_requests") }}</th>
                          <th v-for="column in group.columns" :key="host.api_host + ':' + 'head:' + column.key" class="stats-model-ledger-column">
                            {{ column.label }}
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr v-for="model in host.models" :key="host.api_host + ':' + group.key + ':' + model.model" class="stats-model-ledger-row">
                          <th scope="row" class="stats-model-ledger-model">
                            <div class="stats-model-ident">
                              <span class="stats-model-vendor-badge" :class="{ 'stats-model-vendor-badge-fallback': !modelVendorMeta(model.model).icon }">
                                <img
                                  v-if="modelVendorMeta(model.model).icon"
                                  :src="modelVendorMeta(model.model).icon"
                                  :alt="modelVendorMeta(model.model).label"
                                  class="stats-model-vendor-image"
                                />
                                <PhCpu v-else class="stats-model-vendor-fallback icon" />
                              </span>
                              <code class="stats-model-name">{{ model.model }}</code>
                            </div>
                          </th>
                          <td v-if="group.showRequests" class="stats-model-ledger-value-cell stats-model-ledger-requests">{{ formatNumber(model.requests) }}</td>
                          <td
                            v-for="column in group.columns"
                            :key="host.api_host + ':' + model.model + ':' + column.key"
                            class="stats-model-ledger-value-cell"
                            :class="[
                              { 'stats-model-ledger-value-cell-unavailable': isModelLedgerValueUnavailable(model, column) },
                              modelLedgerValueToneClass(model, column),
                            ]"
                            :title="modelLedgerValueTitle(model, column)"
                          >
                            {{ formatModelLedgerValue(model, column) }}
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>
              </article>
            </div>
          </div>

          <div v-else class="stats-section-panel">
            <div v-if="visibleModels.length === 0" class="stats-empty">{{ t("stats_no_data") }}</div>
            <div v-else class="stats-host-list">
              <section class="stats-host-block">
                <header class="stats-host-head">
                  <div class="stats-host-ident">
                    <span class="stats-host-eyebrow">{{ t("stats_group_models") }}</span>
                    <span class="stats-host-name">{{ t("stats_model") }}</span>
                  </div>
                </header>

                <div class="stats-model-table">
                  <div v-for="group in modelLedgerGroups" :key="'models:' + 'group:' + group.key" class="stats-model-ledger-scroll">
                    <table class="stats-model-ledger-table">
                      <thead>
                        <tr class="stats-model-ledger-group-row">
                          <th :colspan="group.columns.length + (group.showRequests ? 2 : 1)" class="stats-model-ledger-group">
                            <span class="stats-model-ledger-group-copy">
                              <component :is="group.icon" class="stats-model-ledger-group-icon icon" />
                              <span>{{ group.label }}</span>
                            </span>
                          </th>
                        </tr>
                        <tr class="stats-model-ledger-column-row">
                          <th class="stats-model-ledger-stub">{{ t("stats_model") }}</th>
                          <th v-if="group.showRequests" class="stats-model-ledger-stub stats-model-ledger-stub-requests">{{ t("stats_requests") }}</th>
                          <th v-for="column in group.columns" :key="'models:' + 'head:' + column.key" class="stats-model-ledger-column">
                            {{ column.label }}
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr v-for="model in visibleModels" :key="'models:' + group.key + ':' + model.model" class="stats-model-ledger-row">
                          <th scope="row" class="stats-model-ledger-model">
                            <div class="stats-model-ident">
                              <span class="stats-model-vendor-badge" :class="{ 'stats-model-vendor-badge-fallback': !modelVendorMeta(model.model).icon }">
                                <img
                                  v-if="modelVendorMeta(model.model).icon"
                                  :src="modelVendorMeta(model.model).icon"
                                  :alt="modelVendorMeta(model.model).label"
                                  class="stats-model-vendor-image"
                                />
                                <PhCpu v-else class="stats-model-vendor-fallback icon" />
                              </span>
                              <code class="stats-model-name">{{ model.model }}</code>
                            </div>
                          </th>
                          <td v-if="group.showRequests" class="stats-model-ledger-value-cell stats-model-ledger-requests">{{ formatNumber(model.requests) }}</td>
                          <td
                            v-for="column in group.columns"
                            :key="'models:' + model.model + ':' + column.key"
                            class="stats-model-ledger-value-cell"
                            :class="[
                              { 'stats-model-ledger-value-cell-unavailable': isModelLedgerValueUnavailable(model, column) },
                              modelLedgerValueToneClass(model, column),
                            ]"
                            :title="modelLedgerValueTitle(model, column)"
                          >
                            {{ formatModelLedgerValue(model, column) }}
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>
              </section>
            </div>
          </div>
        </section>
      </section>
    </AppPage>
  `,
};

export default StatsView;
