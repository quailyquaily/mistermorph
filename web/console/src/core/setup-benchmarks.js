const CHAT_BENCHMARK_IDS = ["text_reply", "json_response", "tool_calling", "evaluate"];

// The benchmarks a profile runs, as the server picks them (llmbench.BenchmarkIDs): the chat ones
// for a profile that chats, Evaluate for a decision-only one, and transcription for one with that
// ability. A transcription-only profile runs just that. abilities are the form's (none means
// text); decisionOnly is a profile that answers only Evaluate requests.
export function profileBenchmarkIds(abilities, decisionOnly) {
  const list = Array.isArray(abilities) && abilities.length > 0 ? abilities : ["text"];
  let ids = [];
  if (decisionOnly) {
    ids = ["evaluate"];
  } else if (list.includes("text")) {
    ids = [...CHAT_BENCHMARK_IDS];
  }
  if (list.includes("transcription")) {
    ids.push("transcription");
  }
  return ids.length > 0 ? ids : [...CHAT_BENCHMARK_IDS];
}
