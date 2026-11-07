import assert from "node:assert/strict";
import test from "node:test";
import { formatUptimeShort, summarizeAgentReadout } from "./agent-readout.js";

test("uptime reads at the right scale", () => {
  assert.equal(formatUptimeShort(59), "0m");
  assert.equal(formatUptimeShort(43612), "12h 06m");
  assert.equal(formatUptimeShort(2337503), "27d 01h");
  assert.equal(formatUptimeShort(undefined), "");
  assert.equal(formatUptimeShort(-5), "");
});

test("nested overview payloads summarise model, channels and usage", () => {
  const readout = summarizeAgentReadout(
    { health: "ok", uptime_sec: 43612, llm: { model: "gpt-5.6-sol" }, channel: { telegram_running: true, slack_running: false, lark_running: true } },
    { summary: { requests: 175, total_cost: 5.3478, cost_currency: "USD", input_tokens: 1000, cached_input_tokens: 390, total_tokens: 1250 } },
  );
  assert.deepEqual(readout, {
    health: "ok", uptime: "12h 06m", model: "gpt-5.6-sol", channels: ["telegram", "lark"],
    requests: 175, tokens: 1250, cost: 5.3478, currency: "USD", cacheRate: 0.39,
  });
});

test("flattened fields and missing data stay readable", () => {
  const readout = summarizeAgentReadout({ llm_model: "m", channel_running_slack: true }, null);
  assert.equal(readout.model, "m");
  assert.deepEqual(readout.channels, ["slack"]);
  assert.equal(readout.requests, null);
  assert.equal(readout.cost, null);
  assert.equal(readout.cacheRate, null);
  assert.equal(readout.tokens, null);
  assert.equal(summarizeAgentReadout(null, { summary: { input_tokens: 900, output_tokens: 100 } }).tokens, 1000);
  assert.equal(summarizeAgentReadout(null, { summary: { input_tokens: 0, cached_input_tokens: 0 } }).cacheRate, null);
  assert.deepEqual(summarizeAgentReadout(null, null).channels, []);
});
