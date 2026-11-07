import assert from "node:assert/strict";
import test from "node:test";

import { compactDuration } from "./config-fields.js";
import { durationSeconds, formatDuration, splitDuration } from "./duration.js";

test("durationSeconds reads h/m/s durations and rejects the rest", () => {
  const cases = [
    ["90s", 90], ["1m30s", 90], ["1h", 3600], ["1h30m", 5400], ["720h", 2592000],
    ["0s", 0], ["0", 0], ["1.5h", 5400], ["", null], ["500ms", null], ["1d", null], ["5 m", null],
  ];
  for (const [text, want] of cases) assert.equal(durationSeconds(text), want, text);
});

test("formatDuration matches the compact form the panel shows for Go durations", () => {
  for (const goText of ["1m30s", "1h0m0s", "168h0m0s", "72h0m0s", "30s", "3m0s", "0s", "1h30m0s"]) {
    const shown = compactDuration(goText);
    assert.equal(formatDuration(durationSeconds(shown)), shown, goText);
  }
});

test("splitDuration picks the largest whole unit", () => {
  assert.deepEqual(splitDuration(90), { amount: "90", unit: 1 });
  assert.deepEqual(splitDuration(120), { amount: "2", unit: 60 });
  assert.deepEqual(splitDuration(5400), { amount: "90", unit: 60 });
  assert.deepEqual(splitDuration(3600), { amount: "1", unit: 3600 });
  assert.deepEqual(splitDuration(604800), { amount: "7", unit: 86400 });
});

test("an amount and unit save as Go duration text", () => {
  assert.equal(formatDuration(7 * 86400), "168h");
  assert.equal(formatDuration(1.5 * 3600), "1h30m");
  assert.equal(formatDuration(45 * 60), "45m");
});
