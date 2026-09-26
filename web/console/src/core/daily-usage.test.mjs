import test from "node:test";
import assert from "node:assert/strict";

import { OTHER_KEY, assignModelSlots, barFraction, dayLabelEvery, niceCeil, summarizeDailyUsage } from "./daily-usage.js";

test("niceCeil rounds up to 1, 2, 2.5 or 5 steps", () => {
  const cases = [
    [0, 0],
    [-4, 0],
    [0.7, 1],
    [1, 1],
    [1.2, 2],
    [2.3, 2.5],
    [3.1, 5],
    [12.4, 20],
    [66_300_000, 100_000_000],
    [0.0042, 0.005],
  ];
  for (const [input, want] of cases) {
    assert.ok(Math.abs(niceCeil(input) - want) < want * 1e-9 + 1e-12, `niceCeil(${input}) = ${niceCeil(input)}, want ${want}`);
  }
});

test("dayLabelEvery thins labels for longer ranges", () => {
  assert.equal(dayLabelEvery(7), 1);
  assert.equal(dayLabelEvery(30), 5);
  assert.equal(dayLabelEvery(90), 15);
});

test("summarizeDailyUsage builds bars and range figures", () => {
  const payload = {
    to: "2026-03-07",
    summary: { cost_currency: "usd", input_tokens: 400, cached_input_tokens: 100 },
    days: [
      { date: "2026-03-04", requests: 0 },
      { date: "2026-03-05", requests: 2, total_cost: 3, input_tokens: 300, output_tokens: 30, total_tokens: 330, cached_input_tokens: 90 },
      { date: "2026-03-06", requests: 1, total_cost: 1, input_tokens: 100, output_tokens: 10, cached_input_tokens: 10 },
      { date: "2026-03-07", requests: 1, total_cost: 0.5, total_tokens: 20 },
    ],
  };

  const cost = summarizeDailyUsage(payload, "cost");
  assert.equal(cost.currency, "USD");
  assert.deepEqual(cost.days.map((day) => day.value), [0, 3, 1, 0.5]);
  assert.deepEqual(cost.days.map((day) => day.label), ["03-04", "03-05", "03-06", "03-07"]);
  assert.equal(cost.days[3].isToday, true);
  assert.equal(cost.days[2].tokens, 110);
  assert.equal(cost.days[1].cacheRate, 0.3);
  assert.equal(cost.days[0].cacheRate, null);
  assert.equal(cost.total, 4.5);
  assert.equal(cost.average, 4.5 / 4);
  assert.equal(cost.activeDays, 3);
  assert.deepEqual(cost.peak, { date: "2026-03-05", value: 3 });
  assert.equal(cost.today, 0.5);
  assert.equal(cost.scaleMax, 5);
  assert.deepEqual(cost.ticks, [5, 2.5, 0]);
  assert.equal(cost.cacheRate, 0.25);

  const tokens = summarizeDailyUsage(payload, "tokens");
  assert.deepEqual(tokens.days.map((day) => day.value), [0, 330, 110, 20]);
  assert.deepEqual(tokens.peak, { date: "2026-03-05", value: 330 });
  assert.equal(tokens.scaleMax, 500);
});

test("summarizeDailyUsage handles an empty or missing payload", () => {
  const empty = summarizeDailyUsage(null);
  assert.equal(empty.metric, "cost");
  assert.deepEqual(empty.days, []);
  assert.equal(empty.peak, null);
  assert.equal(empty.scaleMax, 0);
  assert.deepEqual(empty.ticks, [0]);
  assert.equal(empty.average, 0);
  assert.equal(empty.cacheRate, null);

  const idle = summarizeDailyUsage({ days: [{ date: "2026-03-01" }, { date: "2026-03-02" }] });
  assert.equal(idle.peak, null);
  assert.equal(idle.activeDays, 0);
});

test("barFraction keeps small days visible and clamps", () => {
  assert.equal(barFraction(0, 10), 0);
  assert.equal(barFraction(5, 0), 0);
  assert.equal(barFraction(5, 10), 0.5);
  assert.equal(barFraction(0.001, 10), 0.015);
  assert.equal(barFraction(20, 10), 1);
});

test("assignModelSlots keeps colours for models that stay among the leaders", () => {
  const first = assignModelSlots(new Map(), [{ model: "a" }, { model: "b" }, { model: "c" }, { model: "d" }, { model: "e" }]);
  assert.deepEqual([...first.entries()], [["a", 0], ["b", 1], ["c", 2], ["d", 3]]);

  // "b" drops out and "e" arrives: survivors keep their slot, "e" takes the freed one.
  const second = assignModelSlots(first, [{ model: "d" }, { model: "a" }, { model: "e" }, { model: "c" }]);
  assert.deepEqual(Object.fromEntries(second), { d: 3, a: 0, e: 1, c: 2 });

  assert.equal(assignModelSlots(null, null).size, 0);
});

test("summarizeDailyUsage stacks models by slot with the rest as Other", () => {
  const payload = {
    to: "2026-03-02",
    summary: { total_cost: 10, input_tokens: 1000, cached_input_tokens: 400, cache_creation_input_tokens: 100 },
    models: [
      { model: "big", total_tokens: 900, total_cost: 6 },
      { model: "small", total_tokens: 90, total_cost: 3 },
      { model: "tiny", total_tokens: 10, total_cost: 1 },
    ],
    days: [
      { date: "2026-03-01", requests: 0 },
      {
        date: "2026-03-02",
        requests: 3,
        total_cost: 10,
        input_tokens: 1000,
        cached_input_tokens: 400,
        cache_creation_input_tokens: 100,
        models: [
          { model: "tiny", requests: 1, total_tokens: 10, total_cost: 1 },
          { model: "big", requests: 1, total_tokens: 900, total_cost: 6 },
          { model: "small", requests: 1, total_tokens: 90, total_cost: 3 },
        ],
      },
    ],
  };
  const slots = assignModelSlots(new Map(), payload.models, 2);

  const cost = summarizeDailyUsage(payload, "cost", { slots });
  assert.deepEqual(cost.days[1].segments, [
    { key: "big", slot: 0, value: 6 },
    { key: "small", slot: 1, value: 3 },
    { key: OTHER_KEY, slot: null, value: 1 },
  ]);
  assert.equal(cost.days[1].value, 10);
  assert.deepEqual(cost.days[1].models.map((m) => m.model), ["big", "small", "tiny"]);
  assert.deepEqual(cost.legend.map((item) => [item.key, item.value]), [["big", 6], ["small", 3], [OTHER_KEY, 1]]);

  const isolated = summarizeDailyUsage(payload, "cost", { slots, isolate: "small" });
  assert.equal(isolated.days[1].value, 3);
  assert.equal(isolated.total, 3);
  assert.equal(isolated.scaleMax, 5);
  assert.equal(isolated.activeDays, 1);

  const cache = summarizeDailyUsage(payload, "cache", { slots, isolate: "small" });
  assert.equal(cache.isolate, null);
  assert.deepEqual(cache.days[1].segments.map((s) => [s.key, s.value]), [["hits", 400], ["writes", 100], ["uncached", 500]]);
  assert.equal(cache.days[1].value, 1000);
  assert.equal(cache.days[1].cacheRate, 0.4);
  assert.deepEqual(cache.legend.map((item) => [item.key, item.value]), [["hits", 400], ["writes", 100], ["uncached", 500]]);
  assert.equal(cache.cache.rate, 0.4);
});

test("an isolated model's cache rate covers only that model", () => {
  const payload = {
    summary: { input_tokens: 300, cached_input_tokens: 150 },
    models: [
      { model: "a", input_tokens: 100, cached_input_tokens: 100 },
      { model: "b", input_tokens: 200, cached_input_tokens: 50 },
    ],
    days: [{ date: "2026-03-01", requests: 2, models: [{ model: "a", total_cost: 1 }, { model: "b", total_cost: 1 }] }],
  };
  const slots = assignModelSlots(new Map(), payload.models, 1);
  assert.equal(summarizeDailyUsage(payload, "cost", { slots }).cacheRate, 0.5);
  assert.equal(summarizeDailyUsage(payload, "cost", { slots, isolate: "a" }).cacheRate, 1);
  assert.equal(summarizeDailyUsage(payload, "cost", { slots, isolate: OTHER_KEY }).cacheRate, 0.25);
});
