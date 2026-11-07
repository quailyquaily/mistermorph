// The Stats page's metric rows (the Vue StatsView's helpers): summary, cost and token figures of a
// totals row (the summary, an API host or a model), and the model ledger's columns and cells.
import { cacheCostDelta, cacheRate } from "../../lib/core/cache-cost.js";
import type { IconName } from "../icons";
import { compactCost, exactCost, percentOne, t, wholeNumber } from "./parts";

export interface Metric {
  key: string;
  label: string;
  value: string;
  title?: string;
  unavailable: boolean;
}

export type Totals = Record<string, any>;

export function hasMetricValue(totals: Totals | null | undefined, key: string) {
  return Boolean(totals) && Object.prototype.hasOwnProperty.call(totals, key);
}

function currencyOf(totals: Totals | null | undefined) {
  return typeof totals?.cost_currency === "string" ? totals.cost_currency : "USD";
}

function costMetric(totals: Totals, key: string, label: string): Metric {
  const currency = currencyOf(totals);
  const has = hasMetricValue(totals, key);
  return { key, label, value: has ? compactCost(totals[key], currency) : "-", title: exactCost(totals[key], currency), unavailable: !has };
}

function countMetric(totals: Totals, key: string, label: string): Metric {
  const has = hasMetricValue(totals, key);
  return { key, label, value: has ? wholeNumber(totals[key]) : "-", unavailable: !has };
}

export function summaryHeroMetrics(totals: Totals) {
  return {
    primary: costMetric(totals, "total_cost", t("stats_total_cost")),
    secondary: [countMetric(totals, "total_tokens", t("stats_total_tokens")), countMetric(totals, "requests", t("stats_requests"))],
  };
}

export function costMetrics(totals: Totals): Metric[] {
  return [
    costMetric(totals, "total_cost", t("stats_total")),
    costMetric(totals, "input_cost", t("stats_input")),
    costMetric(totals, "output_cost", t("stats_output")),
    costMetric(totals, "cached_input_cost", t("stats_cached_input")),
    costMetric(totals, "cache_creation_input_cost", t("stats_cache_write")),
  ];
}

export function tokenMetrics(totals: Totals): Metric[] {
  return [
    countMetric(totals, "total_tokens", t("stats_total")),
    countMetric(totals, "input_tokens", t("stats_input")),
    countMetric(totals, "output_tokens", t("stats_output")),
    countMetric(totals, "cached_input_tokens", t("stats_cached_input")),
    countMetric(totals, "cache_creation_input_tokens", t("stats_cache_write")),
  ];
}

export type LedgerKind = "cost" | "token" | "cache_cost_delta" | "cache_rate";
export interface LedgerColumn {
  key: string;
  label: string;
  kind: LedgerKind;
}
export interface LedgerGroup {
  key: string;
  label: string;
  icon: IconName;
  columns: LedgerColumn[];
  showRequests: boolean;
}

// Costs and tokens are two tables rather than one wide table, so each fits the page on desktop.
export function modelLedgerGroups(): LedgerGroup[] {
  return [
    {
      key: "cost",
      label: t("stats_costs"),
      icon: "PhWallet",
      showRequests: true,
      columns: [
        { key: "total_cost", label: t("stats_total"), kind: "cost" },
        { key: "input_cost", label: t("stats_input"), kind: "cost" },
        { key: "output_cost", label: t("stats_output"), kind: "cost" },
        { key: "cached_input_cost", label: t("stats_cached_input"), kind: "cost" },
        { key: "cache_creation_input_cost", label: t("stats_cache_write"), kind: "cost" },
        { key: "cache_cost_delta", label: t("stats_cache_delta"), kind: "cache_cost_delta" },
      ],
    },
    {
      key: "tokens",
      label: t("stats_tokens"),
      icon: "PhChartBar",
      showRequests: false,
      columns: [
        { key: "total_tokens", label: t("stats_total"), kind: "token" },
        { key: "input_tokens", label: t("stats_input"), kind: "token" },
        { key: "output_tokens", label: t("stats_output"), kind: "token" },
        { key: "cached_input_tokens", label: t("stats_cached_input"), kind: "token" },
        { key: "cache_creation_input_tokens", label: t("stats_cache_write"), kind: "token" },
        { key: "cache_rate", label: t("stats_cache_rate"), kind: "cache_rate" },
      ],
    },
  ];
}

export function ledgerValue(row: Totals, column: LedgerColumn): string {
  if (column.kind === "cost") {
    return hasMetricValue(row, column.key) ? compactCost(row[column.key], currencyOf(row)) : "-";
  }
  if (column.kind === "cache_cost_delta") {
    // Shown as savings: positive when the cache made input cheaper, negative when cache writes
    // cost more than they saved.
    const delta = cacheCostDelta(row);
    return delta === null ? "-" : compactCost(Math.abs(delta) < 1e-12 ? 0 : -delta, currencyOf(row));
  }
  if (column.kind === "cache_rate") {
    const rate = cacheRate(row);
    return rate === null ? "-" : percentOne(rate);
  }
  return hasMetricValue(row, column.key) ? wholeNumber(row[column.key]) : "-";
}

export function ledgerTitle(row: Totals, column: LedgerColumn): string {
  if (column.kind === "cost" && hasMetricValue(row, column.key)) return exactCost(row[column.key], currencyOf(row));
  if (column.kind === "cache_cost_delta") {
    const delta = cacheCostDelta(row);
    return delta === null ? "" : exactCost(-delta, currencyOf(row));
  }
  return "";
}

export function ledgerUnavailable(row: Totals, column: LedgerColumn): boolean {
  if (column.kind === "cache_cost_delta") return cacheCostDelta(row) === null;
  if (column.kind === "cache_rate") return cacheRate(row) === null;
  return !hasMetricValue(row, column.key);
}

/** "up" when the cache cost more than it saved, "down" when it saved, "" otherwise. */
export function ledgerTone(row: Totals, column: LedgerColumn): "" | "up" | "down" {
  if (column.kind !== "cache_cost_delta") return "";
  const delta = cacheCostDelta(row);
  if (delta === null || Math.abs(delta) < 1e-12) return "";
  return delta > 0 ? "up" : "down";
}
