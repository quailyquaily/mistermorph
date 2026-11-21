package taskruntime

import (
	"context"
	"strings"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/internal/audience"
	cronstore "github.com/quailyquaily/mistermorph/internal/cron"
	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
	"github.com/quailyquaily/mistermorph/internal/jobrefs"
	"github.com/quailyquaily/mistermorph/internal/taskdomain"
)

// JobReferenceOptions says where a runtime reads referenced jobs: the job list beside cronPath,
// the executions this process holds now, and runs, the task records that keep each run's output
// under the job's topic. A nil runs gives the definitions with a note that no result is kept.
func JobReferenceOptions(cronPath string, runs taskdomain.TaskReader) jobrefs.Options {
	opts := jobrefs.Options{}
	if runs != nil {
		opts.Runs = runs
		opts.RunTopicID = daemonruntime.CronTopicID
	}
	if cronPath = strings.TrimSpace(cronPath); cronPath != "" {
		opts.Jobs = cronstore.NewStore(cronPath)
		opts.LiveRuns = func() []cronstore.TaskRun { return cronstore.Runs(cronPath) }
	}
	return opts
}

// ResolveJobReferences reads the jobs that text references ("[label](job:<id>)") for a run heard
// by the audience in ctx, or by requester when one is given. A caller that asks a model anything
// about the task before the run (a precheck) calls it first and passes the result in
// RunRequest.JobReferences; otherwise the run resolves them itself as it is prepared. The error of
// a reference that cannot be used is safe to show: it does not say whether the job exists.
// contextWindowTokens, when known, is the run's model's window, which bounds what is added.
func (rt *Runtime) ResolveJobReferences(ctx context.Context, text string, requester *jobrefs.Requester, contextWindowTokens int64) (*jobrefs.Resolved, error) {
	if rt == nil || len(jobrefs.ExtractIDs(text)) == 0 {
		return &jobrefs.Resolved{}, nil
	}
	who := jobrefs.Requester{Audience: audience.FromContext(ctx)}
	if requester != nil {
		who = *requester
	}
	opts := JobReferenceOptions(rt.commonDeps.RuntimeToolsConfig.JobManage.CronPath, rt.JobRuns)
	opts.Limits = jobrefs.LimitsForContextWindow(contextWindowTokens)
	resolved, err := jobrefs.Resolve(ctx, text, who, opts)
	if err != nil {
		return nil, err
	}
	return &resolved, nil
}

// JobReferencesRunContext gives a run the note of its resolved job references, as data beside the
// run's metadata rather than as part of the task or the system prompt.
func JobReferencesRunContext(resolved *jobrefs.Resolved) agent.RunContext {
	if resolved == nil || resolved.Empty() {
		return nil
	}
	note := resolved.ContextNote()
	if note == "" {
		return nil
	}
	return func(context.Context, agent.RunInput) []string { return []string{note} }
}
