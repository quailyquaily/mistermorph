package agent

import (
	"context"
	"io"
	"log/slog"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/llm"
	"github.com/quailyquaily/mistermorph/tools"
)

// The benchmarks compare one workflow done with direct tool calls against the same workflow in one
// codemode script, with a scripted model. They measure the engine side: model round trips, bytes
// of tool results sent back to the model, time and allocations. Model latency and token cost are
// not modelled; a real model adds one request per round trip.

type benchFile struct {
	name    string
	content string
	delay   time.Duration
}

func (f benchFile) Name() string            { return f.name }
func (f benchFile) Description() string     { return "Benchmark tool." }
func (f benchFile) ParameterSchema() string { return `{"type":"object"}` }
func (f benchFile) ParallelSafe() bool      { return true }
func (f benchFile) Execute(ctx context.Context, params map[string]any) (string, error) {
	if f.delay > 0 {
		select {
		case <-time.After(f.delay):
		case <-ctx.Done():
			return "", ctx.Err()
		}
	}
	return f.content + strings.TrimSpace(params["key"].(string)), nil
}

type benchWorkflow struct {
	name   string
	tool   benchFile
	direct []llm.Result
	script string
}

func benchWorkflows() []benchWorkflow {
	call := func(id string, key string) llm.ToolCall {
		return llm.ToolCall{ID: id, Name: "fetch", Arguments: map[string]any{"key": key}}
	}
	sequential := benchWorkflow{
		name: "sequential_3",
		tool: benchFile{name: "fetch", content: strings.Repeat("x", 2000) + " next="},
		direct: []llm.Result{
			{ToolCalls: []llm.ToolCall{call("a", "1")}},
			{ToolCalls: []llm.ToolCall{call("b", "2")}},
			{ToolCalls: []llm.ToolCall{call("c", "3")}},
		},
		script: `let key = "1"; for (let i = 0; i < 3; i++) { const r = await tools.fetch({key}); key = String(Number(r.slice(-1)) + 1) } return key`,
	}
	parallelCalls := make([]llm.ToolCall, 0, 6)
	for i := range 6 {
		parallelCalls = append(parallelCalls, call("p"+strconv.Itoa(i), strconv.Itoa(i)))
	}
	parallel := benchWorkflow{
		name:   "parallel_6",
		tool:   benchFile{name: "fetch", content: strings.Repeat("y", 2000), delay: 5 * time.Millisecond},
		direct: []llm.Result{{ToolCalls: parallelCalls}},
		script: `const r = await Promise.all([0,1,2,3,4,5].map(i => tools.fetch({key: String(i)}))); return r.map(s => s.length)`,
	}
	filter := benchWorkflow{
		name:   "filter_500KB",
		tool:   benchFile{name: "fetch", content: strings.Repeat("line of log text\n", 30000) + "ERROR disk full\n"},
		direct: []llm.Result{{ToolCalls: []llm.ToolCall{call("f", "")}}},
		script: `const log = await tools.fetch({key: ""}); return log.split("\n").filter(l => l.startsWith("ERROR"))`,
	}
	return []benchWorkflow{sequential, parallel, filter}
}

func runBenchWorkflow(b *testing.B, w benchWorkflow, codeMode bool) {
	b.Helper()
	reg := tools.NewRegistry()
	_ = reg.Register(w.tool)
	responses := append([]llm.Result(nil), w.direct...)
	var opts []Option
	opts = append(opts, WithLogger(slog.New(slog.NewTextHandler(io.Discard, nil))))
	if codeMode {
		responses = []llm.Result{codeCall(w.script)}
		opts = append(opts, WithCodeMode(CodeModeOptions{}))
	}
	responses = append(responses, finalResponse("done"))

	var roundTrips, toolBytes int
	b.ReportAllocs()
	b.ResetTimer()
	for b.Loop() {
		client := newMockClient(responses...)
		engine := New(client, reg, Config{MaxSteps: 10}, DefaultPromptSpec(), opts...)
		if _, _, err := engine.Run(context.Background(), "x", RunOptions{}); err != nil {
			b.Fatal(err)
		}
		calls := client.allCalls()
		roundTrips = len(calls)
		toolBytes = 0
		for _, m := range calls[len(calls)-1].Messages {
			if m.Role == "tool" {
				toolBytes += len(m.Content)
			}
		}
	}
	b.ReportMetric(float64(roundTrips), "model_requests")
	b.ReportMetric(float64(toolBytes), "tool_result_bytes")
}

func BenchmarkCodeModeWorkflows(b *testing.B) {
	for _, w := range benchWorkflows() {
		b.Run(w.name+"/direct", func(b *testing.B) { runBenchWorkflow(b, w, false) })
		b.Run(w.name+"/codemode", func(b *testing.B) { runBenchWorkflow(b, w, true) })
	}
}
