import test from "node:test";
import assert from "node:assert/strict";

import { barFraction, dayLabelEvery, niceCeil, summarizeDailyUsage } from "./daily-usage.js";

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
