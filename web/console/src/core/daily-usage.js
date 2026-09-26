// Shapes a /stats/llm/daily response into what the Stats page's daily chart draws: one stacked
// bar per day for the chosen metric, a rounded axis, a legend and the range figures.
import { cacheCostDelta, cacheRate } from "./cache-cost.js";

export const DAILY_RANGES = [7, 30, 90];
export const DAILY_METRICS = ["cost", "tokens", "cache"];

// Models beyond this many share the "Other" segment; a fifth hue would not stay distinguishable.
export const MODEL_SLOTS = 4;
export const OTHER_KEY = "__other__";
export const CACHE_PARTS = ["hits", "writes", "uncached"];

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function tokensOf(totals) {
  return finite(totals?.total_tokens) || finite(totals?.input_tokens) + finite(totals?.output_tokens);
}

function modelValue(totals, metric) {
  return metric === "tokens" ? tokensOf(totals) : finite(totals?.total_cost);
}

function cacheParts(totals) {
  const input = finite(totals?.input_tokens);
  const hits = Math.min(finite(totals?.cached_input_tokens), input);
  const writes = Math.min(finite(totals?.cache_creation_input_tokens), input - hits);
  return { hits, writes, uncached: Math.max(0, input - hits - writes), input };
}

function cacheFigures(totals) {
  return { ...cacheParts(totals), rate: cacheRate(totals), delta: cacheCostDelta(totals) };
}

// Smallest 1, 2, 2.5 or 5 x 10^k at or above value, so the axis reads in round steps.
export function niceCeil(value) {
  const n = finite(value);
  if (n <= 0) {
    return 0;
  }
  const power = 10 ** Math.floor(Math.log10(n));
  for (const step of [1, 2, 2.5, 5, 10]) {
    const candidate = step * power;
    if (candidate >= n * (1 - 1e-9)) {
      return candidate;
    }
  }
  return 10 * power;
}

// Day labels step back from the last day, so today always carries one.
export function dayLabelEvery(count) {
  if (count <= 10) {
    return 1;
  }
  if (count <= 31) {
    return 5;
  }
  return 15;
}

// Gives the leading models (the response lists them by tokens) a colour slot each. Slots are
// sticky: a model keeps its colour while it stays among the leaders, so changing the range
// never repaints the models that remain.
export function assignModelSlots(previous, models, slots = MODEL_SLOTS) {
  const leaders = (Array.isArray(models) ? models : [])
    .map((item) => String(item?.model || ""))
    .filter(Boolean)
    .slice(0, slots);
  const next = new Map();
  for (const model of leaders) {
    if (previous instanceof Map && previous.has(model)) {
      next.set(model, previous.get(model));
    }
  }
  const used = new Set(next.values());
  for (const model of leaders) {
    if (!next.has(model)) {
      let slot = 0;
      while (used.has(slot)) {
        slot += 1;
      }
      next.set(model, slot);
      used.add(slot);
    }
  }
  return next;
}

function slotOrder(a, b) {
  const sa = a.slot === null ? Number.POSITIVE_INFINITY : a.slot;
  const sb = b.slot === null ? Number.POSITIVE_INFINITY : b.slot;
  return sa - sb;
}

// Splits a totals row's models into slotted segments plus one "Other", bottom first. A row
// without a model breakdown is all "Other".
function modelSegments(row, metric, slots) {
  const models = row?.models;
  if (!Array.isArray(models)) {
    const value = modelValue(row, metric);
    return value > 0 ? [{ key: OTHER_KEY, slot: null, value }] : [];
  }
  const segments = [];
  let other = 0;
  for (const item of models) {
    const value = modelValue(item, metric);
    const model = String(item?.model || "");
    if (slots.has(model)) {
      segments.push({ key: model, slot: slots.get(model), value });
    } else {
      other += value;
    }
  }
  segments.sort(slotOrder);
  if (other > 0) {
    segments.push({ key: OTHER_KEY, slot: null, value: other });
  }
  return segments.filter((segment) => segment.value > 0);
}

export function summarizeDailyUsage(payload, metric = "cost", options = {}) {
  const key = DAILY_METRICS.includes(metric) ? metric : "cost";
  const slots = options.slots instanceof Map ? options.slots : new Map();
  const isolate = key === "cache" ? null : options.isolate || null;
  const rawDays = Array.isArray(payload?.days) ? payload.days : [];
  const summary = payload?.summary && typeof payload.summary === "object" ? payload.summary : {};
  const to = typeof payload?.to === "string" ? payload.to : "";
  const every = dayLabelEvery(rawDays.length);

  const days = rawDays.map((day, index) => {
    const date = String(day?.date || "");
    const cache = cacheFigures(day);
    let segments;
    if (key === "cache") {
      segments = CACHE_PARTS.map((part) => ({ key: part, slot: null, value: cache[part] })).filter((s) => s.value > 0);
    } else {
      segments = modelSegments(day, key, slots);
      if (isolate) {
        segments = segments.filter((segment) => segment.key === isolate);
      }
    }
    const models = (Array.isArray(day?.models) ? day.models : [])
      .map((item) => {
        const model = String(item?.model || "");
        return {
          model,
          slot: slots.has(model) ? slots.get(model) : null,
          cost: finite(item?.total_cost),
          tokens: tokensOf(item),
          requests: finite(item?.requests),
        };
      })
      .sort((a, b) => (key === "tokens" ? b.tokens - a.tokens : b.cost - a.cost || b.tokens - a.tokens));
    return {
      date,
      label: date.slice(5),
      showLabel: (rawDays.length - 1 - index) % every === 0,
      isToday: Boolean(to) && date === to,
      requests: finite(day?.requests),
      inputTokens: finite(day?.input_tokens),
      outputTokens: finite(day?.output_tokens),
      tokens: tokensOf(day),
      cost: finite(day?.total_cost),
      cache,
      cacheRate: cache.rate,
      models,
      segments,
      value: segments.reduce((sum, segment) => sum + segment.value, 0),
    };
  });

  const total = days.reduce((sum, day) => sum + day.value, 0);
  let peak = null;
  for (const day of days) {
    if (day.value > 0 && (!peak || day.value > peak.value)) {
      peak = day;
    }
  }
  const scaleMax = niceCeil(peak ? peak.value : 0);
  const today = days.find((day) => day.isToday) || null;
  const rangeCache = cacheFigures(summary);
  // While one model (or Other) is isolated, the range cache rate covers only its requests.
  let isolatedCacheRate = rangeCache.rate;
  if (isolate && Array.isArray(payload?.models)) {
    const matching = payload.models.filter((item) =>
      isolate === OTHER_KEY ? !slots.has(String(item?.model || "")) : item?.model === isolate,
    );
    isolatedCacheRate = cacheRate({
      input_tokens: matching.reduce((sum, item) => sum + finite(item?.input_tokens), 0),
      cached_input_tokens: matching.reduce((sum, item) => sum + finite(item?.cached_input_tokens), 0),
    });
  }

  let legend;
  if (key === "cache") {
    legend = CACHE_PARTS.map((part) => ({ key: part, slot: null, value: rangeCache[part] }));
  } else {
    legend = modelSegments({ ...summary, models: payload?.models }, key, slots);
  }

  return {
    metric: key,
    isolate,
    currency: String(summary.cost_currency || "USD").toUpperCase(),
    days,
    legend,
    scaleMax,
    ticks: scaleMax > 0 ? [scaleMax, scaleMax / 2, 0] : [0],
    total,
    average: days.length > 0 ? total / days.length : 0,
    activeDays: days.filter((day) => (isolate ? day.segments.length > 0 : day.requests > 0)).length,
    peak: peak ? { date: peak.date, value: peak.value } : null,
    today: today ? today.value : 0,
    cacheRate: isolatedCacheRate,
    cache: rangeCache,
  };
}

// Bar height as a fraction of the plot, with a hairline floor so a small non-zero day stays visible.
export function barFraction(value, scaleMax, minFraction = 0.015) {
  const v = finite(value);
  const max = finite(scaleMax);
  if (v <= 0 || max <= 0) {
    return 0;
  }
  return Math.max(minFraction, Math.min(1, v / max));
}
