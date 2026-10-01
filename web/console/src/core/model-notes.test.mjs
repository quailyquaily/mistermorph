import assert from "node:assert/strict";
import test from "node:test";

import { modelNoteFor } from "./model-notes.js";

const notes = [
  { match: "claude-opus-4-7*", verdict: "avoid", note: { en: "Superseded.", zh: "别用" } },
  { match: "gpt-5*", verdict: "recommended", note: "Good default." },
  { match: "odd*", verdict: "great" },
];

test("notes match by family, ignoring the vendor prefix, case, and dot versus dash", () => {
  assert.deepEqual(modelNoteFor("claude-opus-4-7-20260101", "en", notes), { verdict: "avoid", note: "Superseded." });
  assert.deepEqual(modelNoteFor("anthropic/Claude-Opus-4.7", "zh-CN", notes), { verdict: "avoid", note: "别用" });
  assert.deepEqual(modelNoteFor("openai/gpt-5-mini", "ja", notes), { verdict: "recommended", note: "Good default." });
  assert.equal(modelNoteFor("claude-sonnet-5", "en", notes), null);
});

test("an unknown verdict counts as ok, and a missing language falls back to English", () => {
  assert.deepEqual(modelNoteFor("odd-model", "en", notes), { verdict: "ok", note: "" });
  assert.equal(modelNoteFor("claude-opus-4-7", "ja", notes).note, "Superseded.");
});
