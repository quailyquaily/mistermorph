package taskruntime

import (
	"context"
	"math"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/internal/coderterm"
	"github.com/quailyquaily/mistermorph/internal/coderusage"
	"github.com/quailyquaily/mistermorph/internal/llmstats"
)

func TestCoderTerminalReportIsOneReportOfUsageAndQuota(t *testing.T) {
	usage := coderterm.Usage{Turns: 2, Models: []coderterm.ModelUsage{
		{Model: "claude-opus-5-5", InputTokens: 1210, CachedInputTokens: 1000, CacheCreationInputTokens: 200, OutputTokens: 60},
	}}
	statusLine := []byte(`{"rate_limits":{"five_hour":{"used_percentage":42,"resets_at":4102444800}}}`)
	type reported struct {
		run   coderusage.Run
		quota *coderusage.Quota
	}
	for _, tc := range []struct {
		name          string
		usage, status bool
		wantReports   int
	}{
		{name: "usage and quota", usage: true, status: true, wantReports: 1},
		{name: "usage only", usage: true, wantReports: 1},
		{name: "quota only", status: true, wantReports: 1},
		{name: "nothing", wantReports: 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var got []reported
			request := agent.CoderRequest{Backend: "claude", Report: func(run coderusage.Run, quota *coderusage.Quota) {
				got = append(got, reported{run, quota})
			}}
			report := coderTerminalReport{started: time.Now()}
			// The session calls Usage, then Status, when the task ends.
			if tc.usage {
				report.usage(usage)
			}
			if tc.status {
				report.status(statusLine)
			}
			report.send(request)
			if len(got) != tc.wantReports {
				t.Fatalf("reports = %+v, want %d", got, tc.wantReports)
			}
			if len(got) == 0 {
				return
			}
			run, quota := got[0].run, got[0].quota
			if tc.usage {
				if run.Backend != "claude" || run.Turns != 2 || len(run.Models) != 1 ||
					!reflect.DeepEqual(run.Models[0], coderusage.ModelUsage{Model: "claude-opus-5-5", InputTokens: 1210, CachedInputTokens: 1000, CacheCreationInputTokens: 200, OutputTokens: 60}) {
					t.Fatalf("run = %+v", run)
				}
			} else if !run.Empty() {
				t.Fatalf("run = %+v, want empty", run)
			}
			if tc.status != (quota != nil) {
				t.Fatalf("quota = %+v", quota)
			}
			if quota != nil && (quota.Backend != "claude" || len(quota.Windows) != 1 || quota.Windows[0].Kind != "five_hour") {
				t.Fatalf("quota = %+v", quota)
			}
		})
	}
	// Without a listener nothing is called.
	report := coderTerminalReport{}
	report.usage(usage)
	report.send(agent.CoderRequest{Backend: "claude"})
}

// What a terminal task's session files record reaches usage.db priced as the CLI's requests were:
// the responses one by one, and the cache writes by their lifetime. The usage below is what
// coderterm reports for two tasks of one session (its TestTerminalReportsResponsesApart).
func TestCoderTerminalUsageIsPricedByResponseInUsageDB(t *testing.T) {
	ctx := context.Background()
	const haiku, sonnet = "claude-haiku-5-5", "claude-sonnet-5-5"
	response := coderterm.ResponseUsage{InputTokens: 50_000, CachedInputTokens: 48_000, OutputTokens: 1000, Count: 1}
	hour := map[string]int64{"ephemeral_1h_input_tokens": 1_000_000}
	write := func(output, count int64) coderterm.ResponseUsage {
		return coderterm.ResponseUsage{InputTokens: 1_000_000, CacheCreationInputTokens: 1_000_000, OutputTokens: output, CacheCreation: hour, Count: count}
	}
	tasks := []coderterm.Usage{
		{Turns: 1, Models: []coderterm.ModelUsage{
			{Model: "claude-not-in-the-catalog", InputTokens: 100_000, OutputTokens: 2000,
				Responses: []coderterm.ResponseUsage{{InputTokens: 50_000, OutputTokens: 1000, Count: 1}, {InputTokens: 50_000, OutputTokens: 1000, Count: 1}}},
			{Model: haiku, InputTokens: 150_000, CachedInputTokens: 144_000, OutputTokens: 3000,
				Responses: []coderterm.ResponseUsage{response, response, response}},
			{Model: sonnet, InputTokens: 1_000_000, CacheCreationInputTokens: 1_000_000, CacheCreation: hour,
				Responses: []coderterm.ResponseUsage{write(0, 1)}},
		}},
		// The second task corrects the cache write's response: 1,000 output tokens more.
		{Turns: 1, Models: []coderterm.ModelUsage{
			{Model: sonnet, OutputTokens: 1000, Responses: []coderterm.ResponseUsage{write(0, -1), write(1000, 1)}},
		}},
	}
	path := filepath.Join(t.TempDir(), "usage.db")
	recorder := coderusage.NewRecorder(path, nil)
	var runs []coderusage.Run
	for _, usage := range tasks {
		report := coderTerminalReport{started: time.Now()}
		report.usage(usage)
		report.send(agent.CoderRequest{Backend: "claude", Report: func(run coderusage.Run, _ *coderusage.Quota) {
			runs = append(runs, run)
			recorder.RecordRun(ctx, run)
		}})
	}
	if len(runs) != 2 {
		t.Fatalf("runs = %+v", runs)
	}
	// The line the user and the agent read is the task's sum, as before.
	if got, want := runs[0].Summary(), "1.2M in (144.0k cached) · 5.0k out · 1 turn"; got != want {
		t.Fatalf("summary = %q, want %q", got, want)
	}

	store, err := llmstats.OpenUsageStore(ctx, path, llmstats.UsageStoreOptions{})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	check := func(when string) {
		t.Helper()
		records, err := store.Records(ctx, 0)
		if err != nil || len(records) != 4 {
			t.Fatalf("%s: records = %+v, %v", when, records, err)
		}
		unknown, small, cache, corrected := records[0], records[1], records[2], records[3]
		if unknown.TotalCost != 0 || unknown.CostCurrency != "" || unknown.InputTokens != 100_000 || len(unknown.PricingParts) != 2 {
			t.Fatalf("%s: unknown model = %+v", when, unknown)
		}
		// One row per model, its tokens the task's sum; its cost three requests of 50,000 input
		// tokens ($0.00118 each), not one of 150,000 ($0.0177).
		if small.Model != haiku || small.InputTokens != 150_000 || small.CachedInputTokens != 144_000 || small.OutputTokens != 3000 ||
			len(small.PricingParts) != 3 || math.Abs(small.TotalCost-0.00354) > 1e-9 || !small.CostEstimated {
			t.Fatalf("%s: three responses = %+v", when, small)
		}
		// 1,000,000 tokens written to the 1-hour cache: $4.00, not the 5-minute $2.50. One
		// request needs no parts: the row's own numbers are its.
		if cache.Model != sonnet || cache.CacheDetails["ephemeral_1h_input_tokens"] != 1_000_000 || cache.PricingParts != nil ||
			math.Abs(cache.CacheCreationInputCost-4) > 1e-9 || math.Abs(cache.TotalCost-4) > 1e-9 {
			t.Fatalf("%s: cache write = %+v", when, cache)
		}
		// The correction costs what the response's 1,000 more output tokens cost, and no cache
		// write again.
		if corrected.Model != sonnet || corrected.InputTokens != 0 || corrected.OutputTokens != 1000 || len(corrected.PricingParts) != 2 ||
			corrected.CacheCreationInputCost != 0 || corrected.InputCost != 0 || corrected.OutputCost <= 0 ||
			math.Abs(corrected.TotalCost-corrected.OutputCost) > 1e-9 {
			t.Fatalf("%s: corrected response = %+v", when, corrected)
		}
	}
	check("written")
	// A catalog change prices the rows again, from what they keep.
	catalog, _, err := llmstats.DefaultPricing()
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SetPricing(ctx, catalog, "another digest"); err != nil {
		t.Fatal(err)
	}
	check("repriced")
}
