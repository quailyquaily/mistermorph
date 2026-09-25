// Shapes a /stats/llm/daily response into what the Stats page's daily chart draws: one bar per
// day for the chosen metric, a rounded axis, and the range figures shown under the chart.

export const DAILY_RANGES = [7, 30, 90];
export const DAILY_METRICS = ["cost", "tokens"];

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function cacheRateOf(totals) {
  const input = finite(totals?.input_tokens);
  if (input <= 0) {
    return null;
  }
  return Math.min(1, finite(totals?.cached_input_tokens) / input);
}

function tokensOf(totals) {
  return finite(totals?.total_tokens) || finite(totals?.input_tokens) + finite(totals?.output_tokens);
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

export function summarizeDailyUsage(payload, metric = "cost") {
  const key = metric === "tokens" ? "tokens" : "cost";
  const rawDays = Array.isArray(payload?.days) ? payload.days : [];
  const summary = payload?.summary && typeof payload.summary === "object" ? payload.summary : {};
  const to = typeof payload?.to === "string" ? payload.to : "";
  const every = dayLabelEvery(rawDays.length);

  const days = rawDays.map((day, index) => {
    const cost = finite(day?.total_cost);
    const tokens = tokensOf(day);
    const date = String(day?.date || "");
    return {
      date,
      label: date.slice(5),
      showLabel: (rawDays.length - 1 - index) % every === 0,
      isToday: Boolean(to) && date === to,
      requests: finite(day?.requests),
      inputTokens: finite(day?.input_tokens),
      outputTokens: finite(day?.output_tokens),
      cachedTokens: finite(day?.cached_input_tokens),
      tokens,
      cost,
      cacheRate: cacheRateOf(day),
      value: key === "tokens" ? tokens : cost,
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

  return {
    metric: key,
    currency: String(summary.cost_currency || "USD").toUpperCase(),
    days,
    scaleMax,
    ticks: scaleMax > 0 ? [scaleMax, scaleMax / 2, 0] : [0],
    total,
    average: days.length > 0 ? total / days.length : 0,
    activeDays: days.filter((day) => day.requests > 0).length,
    peak: peak ? { date: peak.date, value: peak.value } : null,
    today: today ? today.value : 0,
    cacheRate: cacheRateOf(summary),
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
