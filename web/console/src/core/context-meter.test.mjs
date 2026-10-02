import assert from "node:assert/strict";
import test from "node:test";

import { contextMeter } from "./context-meter.js";

test("the meter splits the used input into cached and new, and marks compaction", () => {
  const meter = contextMeter({
    context_window_tokens: 200000,
    used_input_tokens: 80000,
    cached_input_tokens: 60000,
    compaction_trigger_tokens: 144000,
  });
  assert.equal(meter.state, "ok");
  assert.equal(meter.cachedShare, 0.3);
  assert.equal(meter.freshShare, 0.1);
  assert.equal(meter.triggerShare, 0.72);
  assert.equal(meter.free, 120000);
});

test("the meter warns near compaction and past it", () => {
  const base = { context_window_tokens: 200000, compaction_trigger_tokens: 144000 };
  assert.equal(contextMeter({ ...base, used_input_tokens: 130000 }).state, "near");
  assert.equal(contextMeter({ ...base, used_input_tokens: 150000 }).state, "over");
  assert.equal(contextMeter({ context_window_tokens: 200000, used_input_tokens: 190000 }).state, "ok");
});

test("cached tokens never exceed the used total, and no window means no meter", () => {
  const meter = contextMeter({ context_window_tokens: 1000, used_input_tokens: 100, cached_input_tokens: 400 });
  assert.equal(meter.cached, 100);
  assert.equal(meter.fresh, 0);
  assert.equal(meter.triggerShare, null);
  assert.equal(contextMeter({ used_input_tokens: 5 }), null);
});
