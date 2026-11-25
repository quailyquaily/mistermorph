package ownertools

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/internal/audience"
	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
	"github.com/quailyquaily/mistermorph/internal/llmstats"
	"github.com/quailyquaily/mistermorph/internal/workspace"
	"github.com/quailyquaily/mistermorph/tools"
)

type startedThreads struct {
	reqs []ThreadRequest
}

func (s *startedThreads) start(_ context.Context, req ThreadRequest) (ThreadStarted, error) {
	s.reqs = append(s.reqs, req)
	topicID := req.TopicID
	if topicID == "" {
		topicID = "new_topic"
	}
	return ThreadStarted{TopicID: topicID, TaskID: "thread_task", Title: req.Title, Workspace: req.WorkspaceDir, Continued: req.TopicID != ""}, nil
}

func (f *fixture) workThread(userText string) (*WorkThreadTool, *startedThreads) {
	f.t.Helper()
	deps := f.deps
	deps.UserText = userText
	started := &startedThreads{}
	return NewWorkThread(deps, started.start), started
}

func callThread(t *testing.T, tool *WorkThreadTool, ctx context.Context, params map[string]any) (string, error) {
	t.Helper()
	return tool.Execute(ctx, params)
}

func TestWorkThreadStartsInAKnownOrNamedWorkspace(t *testing.T) {
	f := newFixture(t)
	known := mustMkdir(t, filepath.Join(f.root, "known"))
	if err := f.ws.RecordUse(known, f.deps.now()); err != nil {
		t.Fatal(err)
	}
	named := mustMkdir(t, filepath.Join(f.root, "named"))

	tool, started := f.workThread("please work in " + named + " today")
	if tools.IsDeferred(tool) || !tools.IsSubtaskExcluded(tool) || !tools.IsCodeModeExcluded(tool) {
		t.Fatal("work_thread must be listed, kept from subtasks and called directly")
	}
	for _, dir := range []string{known, filepath.Join(known), named} {
		out, err := callThread(t, tool, ownerCtx(), map[string]any{"title": "  Build   it ", "task": "do it", "workspace": dir})
		if err != nil {
			t.Fatalf("workspace %s: %v", dir, err)
		}
		if !strings.Contains(out, `"topic_id":"new_topic"`) || !strings.Contains(out, `"state":"running"`) {
			t.Fatalf("result = %s", out)
		}
	}
	last := started.reqs[len(started.reqs)-1]
	if last.Title != "Build it" || last.Task != "do it" || last.WorkspaceDir != named || last.OriginTaskID != runID || last.TopicID != "" {
		t.Fatalf("request = %+v", last)
	}
}

func TestWorkThreadAsksInsteadOfGuessing(t *testing.T) {
	f := newFixture(t)
	unknown := mustMkdir(t, filepath.Join(f.root, "unknown"))
	tool, started := f.workThread("build the report")
	cases := map[string]struct {
		params map[string]any
		want   string
	}{
		"no workspace":     {map[string]any{"title": "x", "task": "y"}, "workspace is required"},
		"unknown":          {map[string]any{"title": "x", "task": "y", "workspace": unknown}, "ask the user which workspace"},
		"relative":         {map[string]any{"title": "x", "task": "y", "workspace": "proj"}, "not an absolute path"},
		"missing folder":   {map[string]any{"title": "x", "task": "y", "workspace": filepath.Join(f.root, "nope")}, ""},
		"state folder":     {map[string]any{"title": "x", "task": "y", "workspace": f.state}, ""},
		"no task":          {map[string]any{"title": "x", "workspace": f.topicWS}, "task is required"},
		"no title":         {map[string]any{"task": "y", "workspace": f.topicWS}, "title is required"},
		"unknown param":    {map[string]any{"title": "x", "task": "y", "workspace": f.topicWS, "model": "big"}, "unknown parameter"},
		"solo as a thread": {map[string]any{"task": "y", "workspace": f.topicWS, "topic_id": daemonruntime.ConsoleSoloTopicID}, "not a topic a work thread can run in"},
		"gone topic":       {map[string]any{"task": "y", "workspace": f.topicWS, "topic_id": "missing"}, "no topic missing"},
	}
	if err := f.ws.RecordUse(f.topicWS, f.deps.now()); err != nil {
		t.Fatal(err)
	}
	for name, c := range cases {
		_, err := callThread(t, tool, ownerCtx(), c.params)
		if err == nil || (c.want != "" && !strings.Contains(err.Error(), c.want)) {
			t.Fatalf("%s: error = %v, want %q", name, err, c.want)
		}
	}
	if len(started.reqs) != 0 {
		t.Fatalf("started %d threads", len(started.reqs))
	}
}

func TestWorkThreadContinuesATopicInItsOwnWorkspace(t *testing.T) {
	f := newFixture(t)
	other := mustMkdir(t, filepath.Join(f.root, "other"))
	topicID := f.topic("Migration")
	if _, _, err := f.ws.Set(ConsoleScopePrefix+topicID, workspace.Attachment{WorkspaceDir: f.topicWS}); err != nil {
		t.Fatal(err)
	}
	if err := f.ws.RecordUse(other, f.deps.now()); err != nil {
		t.Fatal(err)
	}
	tool, started := f.workThread("go on")
	if _, err := callThread(t, tool, ownerCtx(), map[string]any{"task": "next step", "workspace": other, "topic_id": topicID}); err == nil || !strings.Contains(err.Error(), "works in") {
		t.Fatalf("other workspace: %v", err)
	}
	out, err := callThread(t, tool, ownerCtx(), map[string]any{"task": "next step", "workspace": f.topicWS, "topic_id": topicID})
	if err != nil || !strings.Contains(out, `"continued":true`) {
		t.Fatalf("continue = %s, %v", out, err)
	}
	if len(started.reqs) != 1 || started.reqs[0].TopicID != topicID {
		t.Fatalf("requests = %+v", started.reqs)
	}
}

func TestWorkThreadIsTheOwnersSoloRunsAlone(t *testing.T) {
	f := newFixture(t)
	tool, started := f.workThread("")
	params := map[string]any{"title": "x", "task": "y", "workspace": f.topicWS}
	for name, ctx := range map[string]context.Context{
		"contact":   llmstats.WithRunID(audience.NewContext(context.Background(), audience.Contact("c1")), runID),
		"other run": llmstats.WithRunID(audience.NewContext(context.Background(), audience.Owner()), "cron:1"),
		"subtask":   agent.WithSubtaskDepth(ownerCtx(), 1),
	} {
		if _, err := callThread(t, tool, ctx, params); err == nil || !strings.Contains(err.Error(), "owner's own Console chat runs") {
			t.Fatalf("%s: %v", name, err)
		}
	}
	if _, err := NewWorkThread(f.deps, nil).Execute(ownerCtx(), params); err == nil {
		t.Fatal("work_thread without a starter ran")
	}
	if len(started.reqs) != 0 {
		t.Fatal("started a thread")
	}
}
