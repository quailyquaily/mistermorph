import assert from "node:assert/strict";
import test from "node:test";

import { compactDuration, createConfigDraft } from "./config-fields.js";

test("compactDuration drops zero units from Go durations", () => {
  const cases = [
    ["30m0s", "30m"],
    ["1h0m0s", "1h"],
    ["1h30m0s", "1h30m"],
    ["45s", "45s"],
    ["0s", "0s"],
    ["30m", "30m"],
    ["", ""],
    ["not a duration", "not a duration"],
  ];
  for (const [input, want] of cases) {
    assert.equal(compactDuration(input), want, input);
  }
});

test("createConfigDraft compacts duration fields only", () => {
  const draft = createConfigDraft(
    { "heartbeat.interval": "30m0s", "llm.request_timeout": "1m0s" },
    [
      { path: "heartbeat.interval", type: "select", duration: true },
      { path: "llm.request_timeout", type: "string" },
    ],
  );
  assert.deepEqual(draft, { "heartbeat.interval": "30m", "llm.request_timeout": "1m0s" });
});
