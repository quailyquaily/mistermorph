package coderterm

import (
	"fmt"
	"path/filepath"
	"reflect"
	"testing"
)

// claudeResponseLine is one assistant line of a transcript. cacheCreation is the usage's
// cache_creation object, or "" for a line without one.
func claudeResponseLine(id, model string, input, read, write, output int64, cacheCreation string) string {
	if cacheCreation != "" {
		cacheCreation = `,"cache_creation":` + cacheCreation
	}
	return fmt.Sprintf(`{"type":"assistant","message":{"id":%q,"model":%q,"content":[{"type":"text","text":"x"}],"stop_reason":"tool_use","usage":{"input_tokens":%d,"cache_read_input_tokens":%d,"cache_creation_input_tokens":%d,"output_tokens":%d%s}}}
`, id, model, input, read, write, output, cacheCreation)
}

// A list price goes by the single request, so a task's responses are reported one by one beside
// their sum: three responses of 50,000 input tokens are not one request of 150,000.
func TestClaudeUsageKeepsResponsesApart(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "sid.jsonl")
	const haiku, sonnet = "claude-haiku-5-5", "claude-sonnet-5-5"
	writeUsageFile(t, path,
		claudeResponseLine("msg_1", haiku, 2000, 48_000, 0, 400, "")+
			// The response's later line, with its final output.
			claudeResponseLine("msg_1", haiku, 2000, 48_000, 0, 1000, "")+
			claudeResponseLine("msg_2", haiku, 2000, 48_000, 0, 1000, "")+
			// Cache writes, split by lifetime.
			claudeResponseLine("msg_3", sonnet, 10, 0, 1500, 20,
				`{"ephemeral_5m_input_tokens":500,"ephemeral_1h_input_tokens":1000}`)+
			// A response without an ID cannot be told from another: each line counts.
			claudeResponseLine("", sonnet, 1, 0, 0, 2, `{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":0}`))
	// A sub-agent's response, the same numbers as the parent's: still its own request. Its file
	// repeats one of the parent's, which is not counted again.
	writeUsageFile(t, filepath.Join(dir, "sid", "subagents", "agent-a1.jsonl"),
		claudeResponseLine("msg_a1", haiku, 2000, 48_000, 0, 1000, "")+
			claudeResponseLine("msg_2", haiku, 2000, 48_000, 0, 1000, "")+
			// A split that does not fit in the cache writes it splits is left out.
			claudeResponseLine("msg_a2", sonnet, 0, 0, 100, 1, `{"ephemeral_1h_input_tokens":900}`))

	r := claudeBackend{}.newUsage()
	r.read(path)
	got := r.take()
	response := ResponseUsage{InputTokens: 50_000, CachedInputTokens: 48_000, OutputTokens: 1000, Count: 1}
	lifetimes := map[string]int64{"ephemeral_5m_input_tokens": 500, "ephemeral_1h_input_tokens": 1000}
	want := Usage{Models: []ModelUsage{
		{Model: haiku, InputTokens: 150_000, CachedInputTokens: 144_000, OutputTokens: 3000,
			Responses: []ResponseUsage{response, response, response}},
		{Model: sonnet, InputTokens: 1611, CacheCreationInputTokens: 1600, OutputTokens: 23, CacheCreation: lifetimes,
			Responses: []ResponseUsage{
				{InputTokens: 1510, CacheCreationInputTokens: 1500, OutputTokens: 20, CacheCreation: lifetimes, Count: 1},
				{InputTokens: 1, OutputTokens: 2, Count: 1},
				{InputTokens: 100, CacheCreationInputTokens: 100, OutputTokens: 1, Count: 1},
			}},
	}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("usage = %+v\nwant   %+v", got, want)
	}
}

// A response an earlier task reported can come again in a later one: unchanged it is nothing new;
// corrected, the later task takes the old numbers back and counts the new ones, so each of the
// two can be priced as the request it was.
func TestClaudeUsageCorrectsAResponseOverTasks(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "sid.jsonl")
	agent := filepath.Join(dir, "sid", "subagents", "agent-a1.jsonl")
	const haiku, opus = "claude-haiku-5-5", "claude-opus-5-5"
	lifetime := `{"ephemeral_1h_input_tokens":200}`
	writeUsageFile(t, path,
		claudeResponseLine("msg_1", opus, 10, 1000, 200, 4, lifetime)+
			claudeResponseLine("msg_2", opus, 5, 0, 0, 7, "")+
			claudeResponseLine("msg_3", haiku, 5, 0, 0, 7, ""))
	r := claudeBackend{}.newUsage()
	r.read(path)
	if got := r.take(); len(got.Models) != 2 || len(got.Models[1].Responses) != 2 {
		t.Fatalf("first task = %+v", got)
	}

	// The second task: msg_1 again with more output (twice: only the last line stands), msg_2
	// unchanged in a sub-agent's file, msg_3 answered by another model after all, and a new one.
	appendUsageFile(t, path,
		claudeResponseLine("msg_1", opus, 10, 1000, 200, 30, lifetime)+
			claudeResponseLine("msg_1", opus, 10, 1000, 200, 60, lifetime)+
			claudeResponseLine("msg_3", opus, 5, 0, 0, 7, "")+
			claudeResponseLine("msg_4", opus, 3, 0, 0, 9, ""))
	writeUsageFile(t, agent, claudeResponseLine("msg_2", opus, 5, 0, 0, 7, ""))
	r.read(path)
	got := r.take()
	lifetimes := map[string]int64{"ephemeral_1h_input_tokens": 200}
	want := Usage{Models: []ModelUsage{{
		// haiku's msg_3 is taken back alone, which no row can say: the model is left out.
		Model: opus, InputTokens: 8, OutputTokens: 72,
		Responses: []ResponseUsage{
			{InputTokens: 1210, CachedInputTokens: 1000, CacheCreationInputTokens: 200, OutputTokens: 4, CacheCreation: lifetimes, Count: -1},
			{InputTokens: 1210, CachedInputTokens: 1000, CacheCreationInputTokens: 200, OutputTokens: 60, CacheCreation: lifetimes, Count: 1},
			{InputTokens: 5, OutputTokens: 7, Count: 1},
			{InputTokens: 3, OutputTokens: 9, Count: 1},
		},
	}}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("second task = %+v\nwant          %+v", got, want)
	}

	// A third task that only repeats what was counted reports nothing.
	appendUsageFile(t, path, claudeResponseLine("msg_1", opus, 10, 1000, 200, 60, lifetime)+
		claudeResponseLine("msg_4", opus, 3, 0, 0, 9, ""))
	appendUsageFile(t, agent, claudeResponseLine("msg_3", opus, 5, 0, 0, 7, ""))
	r.read(path)
	if got := r.take(); len(got.Models) != 0 {
		t.Fatalf("third task = %+v", got)
	}
}

// Within one task a response's later line replaces the earlier one, also when it names another
// model: the task reports the response once, as it ended.
func TestClaudeUsageReplacesAResponseWithinATask(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "sid.jsonl")
	const haiku, opus = "claude-haiku-5-5", "claude-opus-5-5"
	writeUsageFile(t, path,
		claudeResponseLine("msg_1", opus, 10, 0, 0, 4, "")+
			claudeResponseLine("msg_2", haiku, 1, 0, 0, 1, "")+
			claudeResponseLine("msg_1", opus, 10, 0, 0, 60, "")+
			claudeResponseLine("msg_2", opus, 2, 0, 0, 3, ""))
	r := claudeBackend{}.newUsage()
	r.read(path)
	got := r.take()
	want := Usage{Models: []ModelUsage{{
		Model: opus, InputTokens: 12, OutputTokens: 63,
		Responses: []ResponseUsage{{InputTokens: 10, OutputTokens: 60, Count: 1}, {InputTokens: 2, OutputTokens: 3, Count: 1}},
	}}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("usage = %+v\nwant   %+v", got, want)
	}
}

// A Codex rollout names the model at the start of each turn (turn_context); its responses are kept
// one by one under it, as a list price goes by the single request. The model can change between
// turns, and a response before any turn_context is recorded under "codex".
func TestCodexUsageKeepsResponsesUnderTheTurnsModel(t *testing.T) {
	const context = `{"timestamp":"2026-11-14T09:59:59Z","type":"turn_context","payload":{"turn_id":"t1","cwd":"/work","model":%q,"effort":"medium"}}` + "\n"
	const response = `{"timestamp":"2026-11-14T10:02:00Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":%d,"output_tokens":90},"last_token_usage":{"input_tokens":%d,"output_tokens":7}}}}` + "\n"
	root := t.TempDir()
	path := codexUsagePath(root, codexUsageParent)
	writeUsageFile(t, path, fmt.Sprintf(context, "gpt-6.1-sol")+codexUsageRollout+
		fmt.Sprintf(context, "gpt-6.1-terra")+fmt.Sprintf(response, 3300, 300))
	r := codexBackend{}.newUsage()
	r.read(path)
	got := r.take()
	want := Usage{Turns: 1, Models: []ModelUsage{
		{
			Model: "gpt-6.1-sol", InputTokens: 3000, CachedInputTokens: 1600, CacheCreationInputTokens: 100, OutputTokens: 80, ReasoningTokens: 20,
			Responses: []ResponseUsage{
				{InputTokens: 1000, CachedInputTokens: 600, CacheCreationInputTokens: 100, OutputTokens: 50, Count: 1},
				{InputTokens: 2000, CachedInputTokens: 1000, OutputTokens: 30, Count: 1},
			},
		},
		{Model: "gpt-6.1-terra", InputTokens: 300, OutputTokens: 7, Responses: []ResponseUsage{{InputTokens: 300, OutputTokens: 7, Count: 1}}},
	}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("usage = %+v\nwant   %+v", got, want)
	}

	// Without a turn_context the model is not known.
	bare := codexUsagePath(root, "44444444-4444-4444-8444-444444444444")
	writeUsageFile(t, bare, fmt.Sprintf(response, 300, 300))
	r = codexBackend{}.newUsage()
	r.read(bare)
	if got := r.take(); len(got.Models) != 1 || got.Models[0].Model != "codex" || got.Models[0].InputTokens != 300 {
		t.Fatalf("usage without a model = %+v", got)
	}
}

// A persistent reader counts only new responses, and a reopened process retains its offset.
func TestCodexUsageReaderAcrossTasks(t *testing.T) {
	home := t.TempDir()
	env := func(string) string { return "" }
	r := NewCodexUsageReader(env, home, home, codexUsageParent, false)
	if got := r.Take(env, home, home, codexUsageParent); len(got.Models) != 0 {
		t.Fatalf("unexpected usage: %+v", got)
	}
	path := codexUsagePath(filepath.Join(home, ".codex", "sessions"), codexUsageParent)
	writeUsageFile(t, path, `{"type":"turn_context","payload":{"model":"gpt-6.1-sol"}}`+"\n"+codexUsageRollout)
	got := r.Take(env, home, home, codexUsageParent)
	if len(got.Models) != 1 || got.Models[0].Model != "gpt-6.1-sol" || got.Models[0].InputTokens != 3000 {
		t.Fatalf("usage: %+v", got)
	}
	if got := r.Take(env, home, home, codexUsageParent); len(got.Models) != 0 {
		t.Fatalf("counted again: %+v", got)
	}
	resumed := NewCodexUsageReader(env, home, home, codexUsageParent, true)
	if got := resumed.Take(env, home, home, codexUsageParent); len(got.Models) != 0 {
		t.Fatalf("counted history on resume: %+v", got)
	}
}
