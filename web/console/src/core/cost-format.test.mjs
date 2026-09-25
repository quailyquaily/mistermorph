import assert from "node:assert/strict";
import test from "node:test";
import { formatCompactCost, formatExactCost } from "./cost-format.js";

test("compact costs keep only the digits that matter", () => {
  const cases = [
    [24.008032, "$24.01"],
    [18.388715, "$18.39"],
    [0.025872, "$0.0259"],
    [0.000369, "$0.00037"],
    [0.002036, "$0.0020"],
    [0, "$0.00"],
    [-0.004742, "-$0.0047"],
  ];
  for (const [value, want] of cases) {
    assert.equal(formatCompactCost(value, "USD", "en-US"), want, String(value));
  }
});

test("exact costs keep full precision and bad input stays readable", () => {
  assert.equal(formatExactCost(0.025872, "USD", "en-US"), "$0.025872");
  assert.equal(formatCompactCost("x"), "-");
  assert.equal(formatExactCost(undefined), "");
});
