// Prompt-cache figures for a usage totals row (a model, an API host or a day).

function toFiniteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// Input tokens billed at the normal rate: neither read from nor written to the cache.
export function cacheBaseInputTokens(row) {
  const inputTokens = toFiniteNumber(row?.input_tokens);
  const cachedInputTokens = toFiniteNumber(row?.cached_input_tokens);
  const cacheCreationInputTokens = toFiniteNumber(row?.cache_creation_input_tokens);
  return Math.max(0, inputTokens - cachedInputTokens - cacheCreationInputTokens);
}

// Share of input tokens served from the cache, or null without input.
export function cacheRate(row) {
  const inputTokens = toFiniteNumber(row?.input_tokens);
  if (inputTokens <= 0) {
    return null;
  }
  const cachedInputTokens = Math.min(toFiniteNumber(row?.cached_input_tokens), inputTokens);
  return Math.max(0, cachedInputTokens / inputTokens);
}

// What caching changed the input bill by, against paying the normal rate for every input
// token. Negative means it saved money. Null when the row lacks the prices to tell.
export function cacheCostDelta(row) {
  const inputTokens = toFiniteNumber(row?.input_tokens);
  if (inputTokens <= 0) {
    return null;
  }

  const cachedInputTokens = toFiniteNumber(row?.cached_input_tokens);
  const cacheCreationInputTokens = toFiniteNumber(row?.cache_creation_input_tokens);
  if (cachedInputTokens <= 0 && cacheCreationInputTokens <= 0) {
    return 0;
  }

  const baseInputTokens = cacheBaseInputTokens(row);
  if (baseInputTokens <= 0 || !Object.prototype.hasOwnProperty.call(row || {}, "input_cost")) {
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
