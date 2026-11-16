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

function sourcedPayload() {
  const totals = (requests, cost, tokens, extra = {}) => ({ requests, total_cost: cost, total_tokens: tokens, input_tokens: tokens, ...extra });
  const model = (name, requests, cost, tokens) => ({ model: name, ...totals(requests, cost, tokens) });
  const none = { totals: totals(0, 0, 0), models: [] };
  return {
    to: "2026-11-15",
    summary: { requests: 9, total_cost: 11, total_tokens: 1100, input_tokens: 1100, cost_currency: "USD", cost_estimated: true },
    models: [model("claude-opus-5-5", 6, 9, 900), model("gpt-5.2", 2, 2, 150), model("codex", 1, 0, 50)],
    sources: {
      agent: { summary: totals(4, 4, 350), models: [model("claude-opus-5-5", 2, 2, 200), model("gpt-5.2", 2, 2, 150)] },
      coder: { summary: totals(5, 7, 750, { cost_estimated: true }), models: [model("claude-opus-5-5", 4, 7, 700), model("codex", 1, 0, 50)] },
    },
    days: [
      // The agent only.
      {
        date: "2026-11-13",
        ...totals(2, 2, 150),
        models: [model("gpt-5.2", 2, 2, 150)],
        sources: { agent: { totals: totals(2, 2, 150), models: [model("gpt-5.2", 2, 2, 150)] }, coder: none },
      },
      // A coder only.
      {
        date: "2026-11-14",
        ...totals(1, 0, 50),
        models: [model("codex", 1, 0, 50)],
        sources: { agent: none, coder: { totals: totals(1, 0, 50), models: [model("codex", 1, 0, 50)] } },
      },
      // Both, with the same model on both sides.
      {
        date: "2026-11-15",
        ...totals(6, 9, 900, { cached_input_tokens: 300 }),
        models: [model("claude-opus-5-5", 6, 9, 900)],
        sources: {
          agent: { totals: totals(2, 2, 200, { cached_input_tokens: 100 }), models: [model("claude-opus-5-5", 2, 2, 200)] },
          coder: { totals: totals(4, 7, 700, { cached_input_tokens: 200 }), models: [model("claude-opus-5-5", 4, 7, 700)] },
        },
      },
    ],
  };
}

test("summarizeDailyUsage draws agent and coder apart when the range has coder runs", () => {
  const payload = sourcedPayload();
  const slots = assignModelSlots(null, payload.models);
  const cost = summarizeDailyUsage(payload, "cost", { slots });
  assert.equal(cost.split, true);
  // Each day has both halves; a model keeps its slot (its colour) on both sides.
  assert.deepEqual(cost.days.map((day) => [day.sources.agent.value, day.sources.coder.value]), [
    [2, 0],
    [0, 0],
    [2, 7],
  ]);
  assert.deepEqual(cost.days[2].sources.agent.segments, [{ key: "claude-opus-5-5", slot: 0, value: 2 }]);
  assert.deepEqual(cost.days[2].sources.coder.segments, [{ key: "claude-opus-5-5", slot: 0, value: 7 }]);
  assert.equal(cost.days[2].sources.coder.models[0].requests, 4);
  // One scale for both halves, mirrored below the base line.
  assert.equal(cost.scaleMax, 10);
  assert.deepEqual(cost.ticks, [10, 5, 0, -5, -10]);
  // A total, an average, a peak and a today per source.
  assert.equal(cost.sources.agent.total, 4);
  assert.equal(cost.sources.agent.average, 4 / 3);
  assert.deepEqual(cost.sources.agent.peak, { date: "2026-11-13", value: 2 });
  assert.equal(cost.sources.agent.today, 2);
  assert.equal(cost.sources.agent.estimated, false);
  assert.equal(cost.sources.coder.total, 7);
  assert.equal(cost.sources.coder.average, 7 / 3);
  assert.deepEqual(cost.sources.coder.peak, { date: "2026-11-15", value: 7 });
  assert.equal(cost.sources.coder.estimated, true);
  // The combined figures and the one legend stay.
  assert.equal(cost.total, 11);
  assert.deepEqual(cost.days.map((day) => day.value), [2, 0, 9]);
  assert.deepEqual(cost.legend.map((item) => item.key), ["claude-opus-5-5", "gpt-5.2"]);
  assert.equal(cost.activeDays, 3);

  const tokens = summarizeDailyUsage(payload, "tokens", { slots });
  assert.deepEqual(tokens.days.map((day) => [day.sources.agent.value, day.sources.coder.value]), [
    [150, 0],
    [0, 50],
    [200, 700],
  ]);
  assert.equal(tokens.scaleMax, 1000);
  assert.equal(tokens.sources.coder.total, 750);

  // The cache view splits each half by how the cache served it.
  const cache = summarizeDailyUsage(payload, "cache", { slots });
  assert.deepEqual(cache.days[2].sources.agent.segments, [
    { key: "hits", slot: null, value: 100 },
    { key: "uncached", slot: null, value: 100 },
  ]);
  assert.deepEqual(cache.days[2].sources.coder.segments, [
    { key: "hits", slot: null, value: 200 },
    { key: "uncached", slot: null, value: 500 },
  ]);
  assert.equal(cache.scaleMax, 1000);
});

test("isolating a model applies to both halves", () => {
  const payload = sourcedPayload();
  const slots = assignModelSlots(null, payload.models);
  const only = summarizeDailyUsage(payload, "cost", { slots, isolate: "claude-opus-5-5" });
  assert.deepEqual(only.days.map((day) => [day.sources.agent.value, day.sources.coder.value]), [
    [0, 0],
    [0, 0],
    [2, 7],
  ]);
  assert.equal(only.sources.agent.total, 2);
  assert.equal(only.sources.coder.total, 7);
  assert.equal(only.activeDays, 1);
  const gpt = summarizeDailyUsage(payload, "cost", { slots, isolate: "gpt-5.2" });
  assert.equal(gpt.sources.agent.total, 2);
  assert.equal(gpt.sources.coder.total, 0);
  assert.equal(gpt.scaleMax, 2);
});

test("a range without coder runs, and a payload without sources, draw as the single stack", () => {
  const payload = sourcedPayload();
  const slots = assignModelSlots(null, payload.models);
  const split = summarizeDailyUsage(payload, "cost", { slots });

  // An older agent: the same days without `sources`.
  const legacy = { ...payload, days: payload.days.map(({ sources, ...day }) => day) };
  delete legacy.sources;
  const single = summarizeDailyUsage(legacy, "cost", { slots });
  assert.equal(single.split, false);
  assert.equal(single.sources, null);
  assert.deepEqual(single.ticks, [10, 5, 0]);
  assert.deepEqual(single.days.map((day) => day.sources), [null, null, null]);
  // The combined stack is the one the split payload still carries.
  assert.deepEqual(single.days.map((day) => day.segments), split.days.map((day) => day.segments));
  assert.equal(single.total, 11);

  // Sources present, the coder's zero.
  const zero = { totals: { requests: 0 }, models: [] };
  const agentOnly = {
    ...payload,
    sources: { agent: payload.sources.agent, coder: { summary: { requests: 0 }, models: [] } },
    days: payload.days.map((day) => ({ ...day, sources: { agent: day.sources.agent, coder: zero } })),
  };
  const drawn = summarizeDailyUsage(agentOnly, "cost", { slots });
  assert.equal(drawn.split, false);
  assert.equal(drawn.sources, null);
  assert.deepEqual(drawn.ticks, [10, 5, 0]);
});
