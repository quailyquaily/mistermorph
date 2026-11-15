package codersessions

import (
	"fmt"
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

// sums is the usage without its responses, for the checks of what was counted.
func sums(u Usage) Usage {
	out := Usage{Turns: u.Turns}
	for _, m := range u.Models {
		m.Responses = nil
		out.Models = append(out.Models, m)
	}
	return out
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

	r := &codexUsage{}
	r.read(path)
	got := r.take()
	// The sub-agent's rollout is not written yet: only the parent's two responses.
	want := Usage{Turns: 1, Models: []ModelUsage{{Model: "codex", InputTokens: 3000, CachedInputTokens: 1600, CacheCreationInputTokens: 100, OutputTokens: 80, ReasoningTokens: 20}}}
	if !reflect.DeepEqual(sums(got), want) {
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
	if !reflect.DeepEqual(sums(got), want) {
		t.Fatalf("second task = %+v\nwant          %+v", got, want)
	}
}

func TestCodexUsageOfAResumedSessionStartsAtTheEnd(t *testing.T) {
	root := t.TempDir()
	path := codexUsagePath(root, codexUsageParent)
	child := codexUsagePath(root, codexUsageChild)
	writeUsageFile(t, path, codexUsageRollout)
	writeUsageFile(t, child, codexUsageChildRollout)
	r := &codexUsage{}
	r.read(path)
	r.take()
	// The earlier sub-agent is messaged again and spends more; the same total repeated is not new.
	appendUsageFile(t, child, `{"timestamp":"2026-11-14T11:00:00Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":400,"cached_input_tokens":0,"output_tokens":40,"reasoning_output_tokens":5},"last_token_usage":{"input_tokens":400,"cached_input_tokens":0,"output_tokens":40,"reasoning_output_tokens":5}}}}
{"timestamp":"2026-11-14T11:00:01Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":470,"cached_input_tokens":0,"output_tokens":43,"reasoning_output_tokens":5},"last_token_usage":{"input_tokens":70,"cached_input_tokens":0,"output_tokens":3,"reasoning_output_tokens":0}}}}
`)
	r.read(path)
	got := r.take()
	want := Usage{Models: []ModelUsage{{Model: "codex", InputTokens: 70, OutputTokens: 3}}}
	if !reflect.DeepEqual(sums(got), want) {
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
	r := &codexUsage{}
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
	r = &codexUsage{}
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
