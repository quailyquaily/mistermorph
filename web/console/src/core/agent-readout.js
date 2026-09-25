// Turns an agent's /overview and /stats/llm/usage responses into the short readout shown on the
// Overview drawing. Accepts both the nested payload (llm.model, channel.telegram_running) and the
// flattened field names used elsewhere (llm_model, channel_running_telegram).

const CHANNELS = ["telegram", "slack", "line", "lark", "mixin"];

export function formatUptimeShort(seconds) {
  const total = Math.trunc(Number(seconds));
  if (!Number.isFinite(total) || total < 0) {
    return "";
  }
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days > 0) return `${days}d ${String(hours).padStart(2, "0")}h`;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  return `${minutes}m`;
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function summarizeAgentReadout(overview, usage) {
  const o = overview && typeof overview === "object" ? overview : null;
  const channel = o?.channel && typeof o.channel === "object" ? o.channel : {};
  const running = o
    ? CHANNELS.filter((name) => channel[`${name}_running`] === true || o[`channel_running_${name}`] === true)
    : [];
  const summary = usage?.summary && typeof usage.summary === "object" ? usage.summary : null;
  const requests = Number(summary?.requests);
  const totalTokens = Number(summary?.total_tokens);
  const outputTokens = Number(summary?.output_tokens);
  const cost = Number(summary?.total_cost);
  const inputTokens = Number(summary?.input_tokens);
  const cachedTokens = Number(summary?.cached_input_tokens);
  // Share of input tokens served from the provider's prompt cache.
  const cacheRate =
    Number.isFinite(inputTokens) && inputTokens > 0 && Number.isFinite(cachedTokens)
      ? Math.min(Math.max(cachedTokens / inputTokens, 0), 1)
      : null;
  return {
    health: text(o?.health),
    uptime: o ? formatUptimeShort(o.uptime_sec) : "",
    model: text(o?.llm?.model) || text(o?.llm_model),
    channels: running,
    requests: Number.isFinite(requests) ? requests : null,
    tokens: Number.isFinite(totalTokens)
      ? totalTokens
      : Number.isFinite(inputTokens) && Number.isFinite(outputTokens)
        ? inputTokens + outputTokens
        : null,
    cost: Number.isFinite(cost) ? cost : null,
    currency: text(summary?.cost_currency) || "USD",
    cacheRate,
  };
}
