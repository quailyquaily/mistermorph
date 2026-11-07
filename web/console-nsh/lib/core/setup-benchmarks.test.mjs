import assert from "node:assert/strict";
import test from "node:test";

import { profileBenchmarkIds } from "./setup-benchmarks.js";

const CHAT = ["text_reply", "json_response", "tool_calling", "evaluate"];

test("a profile's benchmarks follow its abilities, as the server picks them", () => {
  const cases = [
    { abilities: [], decisionOnly: false, want: CHAT },
    { abilities: ["text", "image"], decisionOnly: false, want: CHAT },
    { abilities: ["transcription"], decisionOnly: false, want: ["transcription"] },
    { abilities: ["text", "transcription"], decisionOnly: false, want: [...CHAT, "transcription"] },
    { abilities: ["decision"], decisionOnly: true, want: ["evaluate"] },
    { abilities: ["decision", "transcription"], decisionOnly: true, want: ["evaluate", "transcription"] },
    { abilities: ["image"], decisionOnly: false, want: CHAT },
  ];
  for (const { abilities, decisionOnly, want } of cases) {
    assert.deepEqual(profileBenchmarkIds(abilities, decisionOnly), want, abilities.join(","));
  }
});
