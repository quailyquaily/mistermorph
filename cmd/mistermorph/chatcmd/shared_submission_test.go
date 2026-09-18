package chatcmd

import (
	"encoding/json"
	"fmt"
	"net/http"
	"testing"

	tea "charm.land/bubbletea/v2"
	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
)

func TestSharedSubmissionWaitsForAcknowledgementBeforeResending(t *testing.T) {
	m := remoteTestModel(t, func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"id":"task","topic_id":"existing"}`)
	})
	m.id, m.hasChat = "existing", true
	m.textarea.SetValue("hello")
	first := m.submitInput(m.textarea.Value())
	if first == nil {
		t.Fatal("first submission was rejected")
	}
	if second := m.submitInput(m.textarea.Value()); second != nil || len(m.operations) != 1 {
		t.Fatal("repeated Enter submitted the unacknowledged draft twice")
	}
	m.Update(remoteSubmissionResult(t, first))
	m.textarea.SetValue("additional instruction")
	if m.submitInput(m.textarea.Value()) == nil {
		t.Fatal("acknowledged submission prevented a new instruction")
	}
}

func TestSharedCommandFailurePreservesInputAndHistory(t *testing.T) {
	for _, tt := range []struct{ input, task string }{
		{"/think explain this", "/think explain this"},
		{"/models list", "/models list"},
		{"/skills", "/skills"},
		{"/ctx compact", "/ctx compact"},
		{"/reset", "/reset"},
		{"/init", "/init"},
		{"/update", "/update"},
		{"/RESET ignored-argument", "/reset"},
		{"/MoDeLs list", "/models list"},
		{"/think@assistant Keep Case", "/think Keep Case"},
	} {
		t.Run(tt.input, func(t *testing.T) {
			var submitted daemonruntime.SubmitTaskRequest
			m := remoteTestModel(t, func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodPost || r.URL.Path != "/runtime/tasks" {
					t.Errorf("unexpected command request: %s %s", r.Method, r.URL.Path)
				}
				if err := json.NewDecoder(r.Body).Decode(&submitted); err != nil {
					t.Error(err)
				}
				http.Error(w, "unavailable", http.StatusServiceUnavailable)
			})
			m.id, m.hasChat = "existing", true
			m.textarea.SetValue(tt.input)
			cmd := m.submitInput(tt.input)
			m.Update(remoteSubmissionResult(t, cmd))
			if submitted.Task != tt.task || submitted.TopicID != "existing" {
				t.Fatalf("command submission = %+v, want task %q in existing topic", submitted, tt.task)
			}
			if m.textarea.Value() != tt.input {
				t.Fatalf("failed command lost its draft: got %q", m.textarea.Value())
			}
			if len(m.inputHistory) != 1 || m.inputHistory[0] != tt.input {
				t.Fatalf("command missing from input history: %q", m.inputHistory)
			}
		})
	}
}

func TestSharedInputHistoryKeepsPasteContentAcrossTopics(t *testing.T) {
	var submitted daemonruntime.SubmitTaskRequest
	m := remoteTestModel(t, func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&submitted); err != nil {
			t.Error(err)
		}
		fmt.Fprint(w, `{"id":"task","topic_id":"existing"}`)
	})
	m.id, m.hasChat = "existing", true
	const pasted = "first line\nsecond line"
	m.Update(tea.PasteMsg{Content: pasted})
	cmd := m.submitInput(m.textarea.Value())
	m.Update(remoteSubmissionResult(t, cmd))
	m.newDraft()
	m.Update(keyRemote(tea.KeyUp))
	cmd = m.submitInput(m.textarea.Value())
	remoteSubmissionResult(t, cmd)
	if submitted.Task != pasted {
		t.Fatalf("recalled input sent a paste placeholder instead of its content: %q", submitted.Task)
	}
}

func TestSharedLocalCommandsRemainInInputHistory(t *testing.T) {
	m := remoteTestModel(t, func(w http.ResponseWriter, r *http.Request) { http.NotFound(w, r) })
	m.textarea.SetValue("/topic new")
	m.submitInput(m.textarea.Value())
	if len(m.inputHistory) != 1 || m.inputHistory[0] != "/topic new" {
		t.Fatalf("local command missing from input history: %q", m.inputHistory)
	}
}
