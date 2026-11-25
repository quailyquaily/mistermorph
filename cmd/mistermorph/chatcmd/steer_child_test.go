package chatcmd

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
	"github.com/quailyquaily/mistermorph/internal/llmutil"
	"github.com/quailyquaily/mistermorph/internal/runtimecontrol"
)

func TestParseSteerChildArgs(t *testing.T) {
	for _, tc := range []struct {
		args, id, text string
		ok             bool
	}{
		{"e313d0f6 use metric units", "e313d0f6", "use metric units", true},
		{"  worker-2\tkeep it short  ", "worker-2", "keep it short", true},
		{"sub_abc line one\nline two", "sub_abc", "line one\nline two", true},
		{"", "", "", false},
		{"e313d0f6", "", "", false},
		{"e313d0f6    ", "", "", false},
	} {
		id, text, err := parseSteerChildArgs(tc.args)
		if (err == nil) != tc.ok || id != tc.id || text != tc.text {
			t.Fatalf("parse(%q) = %q, %q, %v", tc.args, id, text, err)
		}
		if err != nil && !strings.Contains(err.Error(), "/steer <child-id> <message>") {
			t.Fatalf("parse(%q) error = %v, want the usage", tc.args, err)
		}
	}
}

func TestResolveSteerChildID(t *testing.T) {
	rows := []chatAgentRecord{{ID: "sub_e313d0f6aa"}, {ID: "sub_e313d0f6bb"}, {ID: "sub_77aa"}}
	if id, err := resolveSteerChildID(rows, "77"); err != nil || id != "sub_77aa" {
		t.Fatalf("prefix = %q, %v", id, err)
	}
	if _, err := resolveSteerChildID(rows, "e313d0f6"); err == nil || !strings.Contains(err.Error(), "ambiguous") {
		t.Fatalf("ambiguous prefix error = %v", err)
	}
	if id, err := resolveSteerChildID(rows, "worker-3"); err != nil || id != "worker-3" {
		t.Fatalf("worker id = %q, %v", id, err)
	}
	// An ID no record knows goes to the runtime, which answers for it.
	if id, err := resolveSteerChildID(nil, "sub_unknown"); err != nil || id != "sub_unknown" {
		t.Fatalf("unknown = %q, %v", id, err)
	}
}

func TestSteerChildCommandQueuesForTheRunningTurnsSubagent(t *testing.T) {
	sess := &chatSession{}
	if _, err := sess.steerChildCommand(nil, "worker-1 hello", nil); err == nil || !strings.Contains(err.Error(), "No task is running") {
		t.Fatalf("without a turn: err = %v", err)
	}
	children := runtimecontrol.NewChildSteering()
	turn := &activeChatTurn{runID: "chat_1", runInput: "write a poem", children: children}
	sess.attachTurnSteering(context.Background(), turn, runtimecontrol.NewSteerQueue(0), nil, nil, llmutil.ResolvedRoute{}, "test-model")
	if turn.steering == nil {
		t.Fatal("attachTurnSteering() left no steering")
	}
	lease := children.OpenChild(context.Background(), agent.ChildSteerTarget{TaskID: "sub_e313d0f6aa", Kind: agent.ChildKindSubagent, Worker: &agent.WorkerMetadata{ID: "worker-1", Name: "Curie"}})
	rows := []chatAgentRecord{{ID: "sub_e313d0f6aa"}}

	text, err := sess.steerChildCommand(turn, "e313d0f6 make it rhyme", rows)
	if err != nil || !strings.Contains(text, "Curie (sub_e313d0f6aa)") || !strings.Contains(text, "next step") {
		t.Fatalf("queued: text = %q, err = %v", text, err)
	}
	if items := lease.Source().Drain(); len(items) != 1 || items[0] != "make it rhyme" {
		t.Fatalf("child queue = %q", items)
	}
	if _, err := sess.steerChildCommand(turn, "e313d0f6", rows); err == nil {
		t.Fatal("an empty message was accepted")
	}
	lease.Finish()
	if _, err := sess.steerChildCommand(turn, "worker-1 again", rows); err == nil || !strings.Contains(err.Error(), "already finished") {
		t.Fatalf("finished: err = %v", err)
	}
	// What the person sent goes into the parent's history between its request and its reply.
	history := chatChildMessageHistory(children)
	if len(history) != 1 || !strings.Contains(history[0], "the subagent Curie (worker-1)") || !strings.HasSuffix(history[0], "make it rhyme") {
		t.Fatalf("history = %q", history)
	}
}

func TestAgentInspectorRecordsMessagesSentToAChild(t *testing.T) {
	store := &chatAgentStore{}
	now := time.Now()
	store.handleEventAt(context.Background(), agent.Event{Kind: agent.EventKindSubtaskStart, RunID: "parent", TaskID: "sub_1", Text: "task"}, now)
	store.handleEventAt(context.Background(), agent.Event{Kind: agent.EventKindLLMStart, RunID: "sub_1", Step: 1}, now)
	store.handleEventAt(context.Background(), agent.Event{Kind: agent.EventKindSteerQueued, RunID: "sub_1", Text: "make it rhyme"}, now)
	store.handleEventAt(context.Background(), agent.Event{Kind: agent.EventKindSteerApplied, RunID: "sub_1", Step: 2, Text: "make it rhyme"}, now)
	store.handleEventAt(context.Background(), agent.Event{Kind: agent.EventKindSteerQueued, RunID: "sub_1", Text: "and short"}, now)
	store.handleEventAt(context.Background(), agent.Event{Kind: agent.EventKindTurnDone, RunID: "sub_1", Status: "done", Text: "poem"}, now)
	store.handleEventAt(context.Background(), agent.Event{Kind: runtimecontrol.EventKindSteerDropped, RunID: "sub_1", Text: "and short"}, now)
	row, err := findChatAgent(store.snapshot(), "sub_1")
	if err != nil {
		t.Fatal(err)
	}
	var labels []string
	for _, entry := range row.Entries {
		labels = append(labels, entry.Label)
	}
	want := []string{"Task", "Model request · step 1", "Your message · queued", "Your message · applied at step 2", "Your message · queued", "Assistant", "Your message · not applied (the subagent returned first)"}
	if strings.Join(labels, "|") != strings.Join(want, "|") {
		t.Fatalf("labels = %q, want %q", labels, want)
	}
	if row.Step != 1 {
		t.Fatalf("step = %d, want the model's step only", row.Step)
	}
}

func TestRemoteClientReadsAChildSteerRefusal(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req daemonruntime.SubmitTaskRequest
		_ = json.NewDecoder(r.Body).Decode(&req)
		if req.SteerTargetChildID != "sub_1" {
			t.Errorf("target = %q", req.SteerTargetChildID)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte(`{"code":"child_finished","error":"Curie has already finished, so your message was not sent.","child_id":"sub_1"}`))
	}))
	defer srv.Close()
	c, err := newRemoteClient(srv.URL, "secret")
	if err != nil {
		t.Fatal(err)
	}
	err = c.request(context.Background(), "POST", "/tasks", daemonruntime.SubmitTaskRequest{Task: "hi", TopicID: "t", SteerTargetChildID: "sub_1"}, nil)
	var rejected *daemonruntime.SteerRejectedError
	if !errors.As(err, &rejected) || rejected.Code != "child_finished" || !strings.Contains(err.Error(), "already finished") {
		t.Fatalf("err = %#v", err)
	}
}
