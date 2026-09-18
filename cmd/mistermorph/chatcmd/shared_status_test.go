package chatcmd

import (
	"context"
	"errors"
	"net/http"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
	"github.com/quailyquaily/mistermorph/internal/taskdomain"
)

func TestSharedActivityTracksHTTPStateWithoutAStream(t *testing.T) {
	m := remoteTestModel(t, func(w http.ResponseWriter, r *http.Request) { http.NotFound(w, r) })
	m.id, m.hasChat = "topic", true
	started := time.Now().Add(-time.Minute)
	task := taskdomain.TaskInfo{ID: "task", TopicID: m.id, Status: taskdomain.TaskRunning, StartedAt: &started, Model: "task-model"}
	m.Update(remoteLoaded{gen: m.gen, id: m.id, refresh: true, tasks: []taskdomain.TaskInfo{task}})
	if !m.thinking || !m.runStartedAt.Equal(started) || m.status.model != "task-model" {
		t.Fatalf("HTTP task not mapped to shared activity/status: thinking=%v start=%v status=%+v", m.thinking, m.runStartedAt, m.status)
	}
	s := m.streams[task.ID]
	m.Update(remoteStreamEvent{gen: m.gen, id: task.ID, sub: s, err: errors.New("offline")})
	if !m.thinking || !m.runStartedAt.Equal(started) {
		t.Fatal("stream failure stopped the running task indicator")
	}
	m.Update(keyRemote(tea.KeyEscape))
	select {
	case <-m.submitted:
		t.Fatal("remote activity was sent to the standalone command channel")
	default:
	}
	task.Status = taskdomain.TaskDone
	m.Update(remoteLoaded{gen: m.gen, id: m.id, refresh: true, tasks: []taskdomain.TaskInfo{task}})
	if m.thinking || !m.runStartedAt.IsZero() || m.status.model != "task-model" {
		t.Fatalf("completion did not clear only activity: thinking=%v status=%+v", m.thinking, m.status)
	}
}

func TestSharedSubmittingAndFailureUpdateActivity(t *testing.T) {
	m := remoteTestModel(t, func(w http.ResponseWriter, r *http.Request) { http.Error(w, "offline", 503) })
	m.Init()
	m.textarea.SetValue("hi")
	_, cmd := m.Update(keyRemote(tea.KeyEnter))
	if !m.thinking {
		t.Fatal("submission did not start activity before the HTTP response")
	}
	// Ignore the independent animation tick; execute the submit command.
	if batch, ok := cmd().(tea.BatchMsg); ok {
		for _, command := range batch {
			if result, ok := command().(remoteWrite); ok {
				m.Update(result)
			}
		}
	} else {
		t.Fatal("submission did not schedule its activity animation")
	}
	if m.thinking || m.textarea.Value() != "hi" {
		t.Fatal("failed submission kept activity or lost the draft")
	}
}

func TestSharedMetadataUpdatesStatusAndIgnoresOldTopics(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	m := newSharedChatModel(ctx, nil)
	m.id = "current"
	metadata := daemonruntime.TopicMetadata{TopicID: "current", Context: daemonruntime.TopicMetadataContext{
		Available: true, Model: "topic-model", ContextWindowTokens: 1000, UsageRatio: .18,
	}}
	m.Update(sharedMetadata{gen: m.gen, id: m.id, metadata: metadata})
	if !m.status.contextKnown || m.status.contextRatio != .18 || m.status.model != "topic-model" {
		t.Fatalf("metadata was not applied: %+v", m.status)
	}
	m.newDraft()
	m.Update(sharedMetadata{gen: m.gen - 1, id: "current", metadata: metadata})
	if m.status.contextKnown {
		t.Fatal("previous topic context appeared in a new conversation")
	}
}
