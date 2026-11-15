package taskruntime

import (
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/internal/coderterm"
	"github.com/quailyquaily/mistermorph/internal/coderusage"
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
					run.Models[0] != (coderusage.ModelUsage{Model: "claude-opus-5-5", InputTokens: 1210, CachedInputTokens: 1000, CacheCreationInputTokens: 200, OutputTokens: 60}) {
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
