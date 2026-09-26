import test from "node:test";
import assert from "node:assert/strict";

import { cacheBaseInputTokens, cacheCostDelta, cacheRate } from "./cache-cost.js";

test("cacheBaseInputTokens excludes cache reads and writes", () => {
  assert.equal(cacheBaseInputTokens({ input_tokens: 100, cached_input_tokens: 30, cache_creation_input_tokens: 10 }), 60);
  assert.equal(cacheBaseInputTokens({ input_tokens: 10, cached_input_tokens: 30 }), 0);
});

test("cacheRate is cached over input, clamped, null without input", () => {
  assert.equal(cacheRate({ input_tokens: 200, cached_input_tokens: 50 }), 0.25);
  assert.equal(cacheRate({ input_tokens: 10, cached_input_tokens: 50 }), 1);
  assert.equal(cacheRate({ input_tokens: 0 }), null);
  assert.equal(cacheRate(null), null);
});

test("cacheCostDelta compares against paying the base rate for all input", () => {
  // 60 base tokens cost 0.60 (0.01 each); 40 cached tokens cost 0.04 instead of 0.40.
  const row = { input_tokens: 100, cached_input_tokens: 40, input_cost: 0.6, cached_input_cost: 0.04 };
  assert.ok(Math.abs(cacheCostDelta(row) - -0.36) < 1e-12);
  assert.equal(cacheCostDelta({ input_tokens: 100, input_cost: 1 }), 0);
  assert.equal(cacheCostDelta({ input_tokens: 100, cached_input_tokens: 40 }), null);
  assert.equal(cacheCostDelta({ input_tokens: 0 }), null);
});
