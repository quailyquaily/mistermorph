import test from "node:test";
import assert from "node:assert/strict";

import { easeOutCubic, tweenValue } from "./tween.js";

test("easeOutCubic starts at 0, ends at 1 and clamps", () => {
  assert.equal(easeOutCubic(0), 0);
  assert.equal(easeOutCubic(1), 1);
  assert.equal(easeOutCubic(2), 1);
  assert.equal(easeOutCubic(-1), 0);
  assert.ok(easeOutCubic(0.5) > 0.5);
});

test("tweenValue interpolates and falls back to the target", () => {
  assert.equal(tweenValue(0, 100, 0, 400), 0);
  assert.equal(tweenValue(0, 100, 400, 400), 100);
  assert.equal(tweenValue(10, 20, 999, 400), 20);
  assert.equal(tweenValue(null, 5, 100, 400), 5);
  assert.equal(tweenValue(0, 5, 100, 0), 5);
});
