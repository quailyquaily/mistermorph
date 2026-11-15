package coderterm

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func writeUsageFile(t *testing.T, path, data string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(data), 0o600); err != nil {
		t.Fatal(err)
	}
}

func appendUsageFile(t *testing.T, path, data string) {
	t.Helper()
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := f.WriteString(data); err != nil {
		t.Fatal(err)
	}
}

// A Claude Code transcript as 2.1.325 writes it: one response as a line per content block, each
// with the response's ID and usage (the earlier ones with the output counted so far).
const claudeUsageTranscript = `{"type":"user","message":{"role":"user","content":"task"}}
{"type":"assistant","message":{"id":"msg_1","model":"claude-opus-5-5","content":[{"type":"thinking","thinking":""}],"stop_reason":null,"usage":{"input_tokens":10,"cache_read_input_tokens":1000,"cache_creation_input_tokens":200,"output_tokens":2}}}
{"type":"assistant","message":{"id":"msg_1","model":"claude-opus-5-5","content":[{"type":"text","text":"Looking."}],"stop_reason":null,"usage":{"input_tokens":10,"cache_read_input_tokens":1000,"cache_creation_input_tokens":200,"output_tokens":2}}}
{"type":"assistant","message":{"id":"msg_1","model":"claude-opus-5-5","content":[{"type":"tool_use","name":"Agent","input":{}}],"stop_reason":"tool_use","usage":{"input_tokens":10,"cache_read_input_tokens":1000,"cache_creation_input_tokens":200,"output_tokens":60}}}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"ok"}]}}
{"type":"assistant","isApiErrorMessage":true,"message":{"id":"msg_err","model":"<synthetic>","content":[{"type":"text","text":"API Error"}],"usage":{"input_tokens":0,"output_tokens":0}}}
{"type":"assistant","message":{"id":"msg_2","model":"claude-haiku-5-5","content":[{"type":"text","text":"Done."}],"stop_reason":"end_turn","usage":{"input_tokens":5,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":7}}}
`

const claudeUsageSubagent = `{"type":"user","isSidechain":true,"message":{"role":"user","content":"look"}}
{"type":"assistant","isSidechain":true,"message":{"id":"msg_a1","model":"claude-haiku-5-5","content":[{"type":"text","text":"Found."}],"stop_reason":"end_turn","usage":{"input_tokens":20,"cache_read_input_tokens":300,"cache_creation_input_tokens":0,"output_tokens":11}}}
`

func TestClaudeUsageCountsEachResponseOncePerModel(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "sid.jsonl")
	writeUsageFile(t, path, claudeUsageTranscript)
	writeUsageFile(t, filepath.Join(dir, "sid", "subagents", "agent-a1.jsonl"), claudeUsageSubagent)
	// Another session's sub-agent is not this session's.
	writeUsageFile(t, filepath.Join(dir, "other", "subagents", "agent-b1.jsonl"), claudeUsageSubagent)

	r := claudeBackend{}.newUsage()
	r.read(path)
	got := r.take()
	want := Usage{Turns: 1, Models: []ModelUsage{
		// The sub-agent's response and the parent's last one.
		{Model: "claude-haiku-5-5", InputTokens: 325, CachedInputTokens: 300, OutputTokens: 18},
		// Three lines of one response: counted once, with its last line's output.
		{Model: "claude-opus-5-5", InputTokens: 1210, CachedInputTokens: 1000, CacheCreationInputTokens: 200, OutputTokens: 60},
	}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("usage = %+v\nwant   %+v", got, want)
	}
	// Nothing new: nothing counted twice.
	r.read(path)
	if got := r.take(); len(got.Models) != 0 || got.Turns != 0 {
		t.Fatalf("second read = %+v", got)
	}
}

func TestClaudeUsageOverTasks(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "sid.jsonl")
	agent := filepath.Join(dir, "sid", "subagents", "agent-a1.jsonl")
	writeUsageFile(t, path, claudeUsageTranscript)
	r := claudeBackend{}.newUsage()
	r.read(path)
	r.take()

	// Between the tasks: a sub-agent reports late, and Claude Code starts a response whose
	// line is not written out yet.
	writeUsageFile(t, agent, claudeUsageSubagent)
	appendUsageFile(t, path, `{"type":"assistant","message":{"id":"msg_3","model":"claude-opus-5-5","content":[{"type":"text","text":"Compacted."}],"stop_reason":null,"usage":{"input_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":4}}}
{"type":"assistant","message":{"id":"msg_4","model":"claude-opus-5-5","content":[{"type":"te`)
	r.read(path)
	// The partial line waits; the rest belongs to the next task.
	appendUsageFile(t, path, `xt","text":"Second."}],"stop_reason":"end_turn","usage":{"input_tokens":2,"cache_read_input_tokens":50,"cache_creation_input_tokens":0,"output_tokens":9}}}
{"type":"assistant","message":{"id":"msg_3","model":"claude-opus-5-5","content":[{"type":"text","text":"More."}],"stop_reason":"end_turn","usage":{"input_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":6}}}
`)
	r.read(path)
	got := r.take()
	want := Usage{Turns: 2, Models: []ModelUsage{
		{Model: "claude-haiku-5-5", InputTokens: 320, CachedInputTokens: 300, OutputTokens: 11},
		// msg_3 by its last line (1 in, 6 out) and msg_4 (52 in, 9 out).
		{Model: "claude-opus-5-5", InputTokens: 53, CachedInputTokens: 50, OutputTokens: 15},
	}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("usage = %+v\nwant   %+v", got, want)
	}

	// A file cut short is not counted again.
	writeUsageFile(t, path, claudeUsageTranscript)
	r.read(path)
	if got := r.take(); len(got.Models) != 0 {
		t.Fatalf("after truncation = %+v", got)
	}
}

func TestClaudeUsageOfAResumedSessionStartsAtTheEnd(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "sid.jsonl")
	agent := filepath.Join(dir, "sid", "subagents", "agent-a1.jsonl")
	writeUsageFile(t, path, claudeUsageTranscript)
	writeUsageFile(t, agent, claudeUsageSubagent)
	r := claudeBackend{}.newUsage()
	baselineUsage(r, path)
	appendUsageFile(t, path, `{"type":"assistant","message":{"id":"msg_9","model":"claude-opus-5-5","content":[{"type":"text","text":"Back."}],"stop_reason":"end_turn","usage":{"input_tokens":3,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":4}}}
`)
	// The earlier sub-agent goes on in its own file, and a new one starts.
	appendUsageFile(t, agent, `{"type":"assistant","isSidechain":true,"message":{"id":"msg_a2","model":"claude-haiku-5-5","content":[],"stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}}
`)
	writeUsageFile(t, filepath.Join(dir, "sid", "subagents", "agent-a2.jsonl"), claudeUsageSubagent)
	r.read(path)
	got := r.take()
	want := Usage{Turns: 1, Models: []ModelUsage{
		// msg_a1 was counted before the restart, whichever file repeats it.
		{Model: "claude-haiku-5-5", InputTokens: 1, OutputTokens: 1},
		{Model: "claude-opus-5-5", InputTokens: 3, OutputTokens: 4},
	}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("usage = %+v\nwant   %+v", got, want)
	}
	// A session whose file does not exist yet starts at 0.
	fresh := claudeBackend{}.newUsage()
	baselineUsage(fresh, filepath.Join(dir, "new.jsonl"))
	writeUsageFile(t, filepath.Join(dir, "new.jsonl"), claudeUsageTranscript)
	fresh.read(filepath.Join(dir, "new.jsonl"))
	if got := fresh.take(); len(got.Models) != 2 {
		t.Fatalf("fresh = %+v", got)
	}
}

// A Codex rollout as the CLI of 2026-11-14 writes it: a token_count after each response, repeated
// with the same running total when only the rate limits changed, and one without info.
const codexUsageParent = "11111111-1111-4111-8111-111111111111"
const codexUsageChild = "22222222-2222-4222-8222-222222222222"

const codexUsageRollout = `{"timestamp":"2026-11-14T10:00:00Z","type":"event_msg","payload":{"type":"task_started","turn_id":"t1"}}
{"timestamp":"2026-11-14T10:00:01Z","type":"event_msg","payload":{"type":"token_count","info":null,"rate_limits":{}}}
{"timestamp":"2026-11-14T10:00:02Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1000,"cached_input_tokens":600,"output_tokens":50,"reasoning_output_tokens":20},"last_token_usage":{"input_tokens":1000,"cached_input_tokens":600,"cache_write_input_tokens":100,"output_tokens":50,"reasoning_output_tokens":20}}}}
{"timestamp":"2026-11-14T10:00:03Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1000,"cached_input_tokens":600,"output_tokens":50,"reasoning_output_tokens":20},"last_token_usage":{"input_tokens":1000,"cached_input_tokens":600,"cache_write_input_tokens":100,"output_tokens":50,"reasoning_output_tokens":20}}}}
{"timestamp":"2026-11-14T10:00:04Z","type":"event_msg","payload":{"type":"sub_agent_activity","kind":"started","agent_thread_id":"22222222-2222-4222-8222-222222222222","agent_path":"/root/review"}}
{"timestamp":"2026-11-14T10:00:05Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":3000,"cached_input_tokens":1600,"output_tokens":80,"reasoning_output_tokens":20},"last_token_usage":{"input_tokens":2000,"cached_input_tokens":1000,"output_tokens":30,"reasoning_output_tokens":0}}}}
{"timestamp":"2026-11-14T10:00:06Z","type":"event_msg","payload":{"type":"task_complete","turn_id":"t1","last_agent_message":"done"}}
`

const codexUsageChildRollout = `{"timestamp":"2026-11-14T10:00:04Z","type":"event_msg","payload":{"type":"task_started","turn_id":"c1"}}
{"timestamp":"2026-11-14T10:00:05Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":400,"cached_input_tokens":0,"output_tokens":40,"reasoning_output_tokens":5},"last_token_usage":{"input_tokens":400,"cached_input_tokens":0,"output_tokens":40,"reasoning_output_tokens":5}}}}
{"timestamp":"2026-11-14T10:00:06Z","type":"event_msg","payload":{"type":"task_complete","turn_id":"c1","last_agent_message":"reviewed"}}
`

func codexUsagePath(root, thread string) string {
	return filepath.Join(root, "2026", "11", "14", "rollout-2026-11-14T10-00-00-"+thread+".jsonl")
}

func TestCodexUsageSumsLastTokenUsage(t *testing.T) {
	root := t.TempDir()
	path := codexUsagePath(root, codexUsageParent)
	writeUsageFile(t, path, codexUsageRollout)
	// A rollout of some other session under the same folder is not this session's.
	writeUsageFile(t, codexUsagePath(root, "33333333-3333-4333-8333-333333333333"), codexUsageChildRollout)

	r := codexBackend{}.newUsage()
	r.read(path)
	got := r.take()
	// The sub-agent's rollout is not written yet: only the parent's two responses.
	want := Usage{Turns: 1, Models: []ModelUsage{{Model: "codex", InputTokens: 3000, CachedInputTokens: 1600, CacheCreationInputTokens: 100, OutputTokens: 80, ReasoningTokens: 20}}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("usage = %+v\nwant   %+v", got, want)
	}

	// It arrives after the task: counted with the next one, from its start, and its own turn
	// is not one of the session's.
	writeUsageFile(t, codexUsagePath(root, codexUsageChild), codexUsageChildRollout)
	appendUsageFile(t, path, `{"timestamp":"2026-11-14T10:01:00Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":3100,"cached_input_tokens":1600,"output_tokens":85,"reasoning_output_tokens":20},"last_token_usage":{"input_tokens":100,"cached_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0}}}}
{"timestamp":"2026-11-14T10:01:01Z","type":"event_msg","payload":{"type":"turn_aborted","turn_id":"t2","reason":"interrupted"}}
`)
	r.read(path)
	got = r.take()
	want = Usage{Models: []ModelUsage{{Model: "codex", InputTokens: 500, OutputTokens: 45, ReasoningTokens: 5}}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("second task = %+v\nwant          %+v", got, want)
	}
}

func TestCodexUsageOfAResumedSessionStartsAtTheEnd(t *testing.T) {
	root := t.TempDir()
	path := codexUsagePath(root, codexUsageParent)
	child := codexUsagePath(root, codexUsageChild)
	writeUsageFile(t, path, codexUsageRollout)
	writeUsageFile(t, child, codexUsageChildRollout)
	r := codexBackend{}.newUsage()
	baselineUsage(r, path)
	// The earlier sub-agent is messaged again and spends more; the same total repeated is not new.
	appendUsageFile(t, child, `{"timestamp":"2026-11-14T11:00:00Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":400,"cached_input_tokens":0,"output_tokens":40,"reasoning_output_tokens":5},"last_token_usage":{"input_tokens":400,"cached_input_tokens":0,"output_tokens":40,"reasoning_output_tokens":5}}}}
{"timestamp":"2026-11-14T11:00:01Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":470,"cached_input_tokens":0,"output_tokens":43,"reasoning_output_tokens":5},"last_token_usage":{"input_tokens":70,"cached_input_tokens":0,"output_tokens":3,"reasoning_output_tokens":0}}}}
`)
	r.read(path)
	got := r.take()
	want := Usage{Models: []ModelUsage{{Model: "codex", InputTokens: 70, OutputTokens: 3}}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("usage = %+v\nwant   %+v", got, want)
	}
}
