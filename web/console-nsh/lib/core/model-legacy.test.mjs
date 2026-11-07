import assert from "node:assert/strict";
import test from "node:test";

import { legacyReasons, parseModelID } from "./model-legacy.js";

test("model IDs split into family, version and date", () => {
  assert.deepEqual(parseModelID("anthropic/claude-sonnet-5.5"), { family: "claude sonnet", version: [5, 5], date: "" });
  assert.deepEqual(parseModelID("claude-3-5-sonnet-20241022"), { family: "claude sonnet", version: [3, 5], date: "20241022" });
  assert.deepEqual(parseModelID("gpt-6.1-sol"), { family: "gpt sol", version: [6, 1], date: "" });
  assert.deepEqual(parseModelID("gpt-4-0613"), { family: "gpt", version: [4], date: "0613" });
  assert.deepEqual(parseModelID("gpt-4o-mini-2024-07-18"), { family: "gpt mini o*", version: [4], date: "20240718" });
  assert.deepEqual(parseModelID("moonshotai/kimi-k3"), { family: "k* kimi", version: [3], date: "" });
  assert.deepEqual(parseModelID("llama-3.1-70b-instruct"), { family: "70b instruct llama", version: [3, 1], date: "" });
  assert.deepEqual(parseModelID("gemini-3.1-pro-preview"), { family: "gemini pro", version: [3, 1], date: "" });
});

function ids(map) {
  return Object.fromEntries([...map.entries()].map(([id, reason]) => [id, reason.kind + (reason.by ? ":" + reason.by : "")]));
}

test("older versions of a family, old snapshots, non-chat and old models go to Others", () => {
  const day = 24 * 60 * 60;
  const now = 1790000000;
  const reasons = legacyReasons([
    { value: "claude-sonnet-5-5", created: now },
    { value: "claude-sonnet-5", created: now - 60 * day },
    { value: "claude-3-5-sonnet-20240620", created: now - 800 * day },
    { value: "claude-3-5-sonnet-20241022", created: now - 700 * day },
    { value: "claude-haiku-4-5-20251001", created: now - 360 * day },
    { value: "gpt-6.1-sol", created: now - 10 * day },
    { value: "gpt-6-sol", created: now - 30 * day },
    { value: "gpt-6-luna", created: now - 30 * day },
    { value: "text-embedding-3-large", created: now - 900 * day },
    { value: "grok-4.20-reasoning", created: now - 100 * day },
    { value: "grok-4.7", created: now - 5 * day },
  ]);
  assert.deepEqual(ids(reasons), {
    "text-embedding-3-large": "not_chat",
    "claude-sonnet-5": "superseded:claude-sonnet-5-5",
    "claude-3-5-sonnet-20240620": "superseded:claude-sonnet-5-5",
    "claude-3-5-sonnet-20241022": "superseded:claude-sonnet-5-5",
    "gpt-6-sol": "superseded:gpt-6.1-sol",
  });
});

test("the age rule needs dates and compares within a vendor", () => {
  const year = 365 * 24 * 60 * 60;
  const reasons = legacyReasons([
    { value: "openai/gpt-6-astra", created: 2 * year },
    { value: "openai/o3", created: 0.5 * year },
    { value: "local-a" },
    { value: "local-b" },
  ]);
  assert.deepEqual(ids(reasons), { "openai/o3": "old" });
});
