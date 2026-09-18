package chatcmd

import (
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	tea "charm.land/bubbletea/v2"
	"github.com/quailyquaily/mistermorph/guard"
	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
	"github.com/quailyquaily/mistermorph/internal/taskdomain"
)

func TestSharedApprovalUsesCurrentTopicAndKeepsDraft(t *testing.T) {
	decisions := 0
	m := remoteTestModel(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.Method + " " + r.URL.Path {
		case "GET /runtime/approvals/apr":
			fmt.Fprint(w, `{"approval_request_id":"apr","task_id":"task","topic_id":"a","status":"pending","tool_name":"bash","tool_params":{"cmd":"pwd"},"reasons":["approval required"]}`)
		case "POST /runtime/approvals/apr/approve":
			decisions++
			fmt.Fprint(w, `{"approval_request_id":"apr","task_id":"task","status":"approved","resumed":true}`)
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	})
	m.id, m.hasChat = "a", true
	m.tasks["task"] = taskdomain.TaskInfo{ID: "task", TopicID: "a", Status: taskdomain.TaskPending, ApprovalRequestID: "apr"}
	m.textarea.SetValue("keep this draft")
	m.Update(m.loadSharedApproval()())
	if m.approval == nil || m.approval.ID != "apr" {
		t.Fatal("approval was not loaded into the common panel")
	}
	_, cmd := m.Update(tea.KeyPressMsg{Code: 'y', Text: "y"})
	m.Update(cmd())
	if decisions != 1 || m.approval != nil || m.textarea.Value() != "keep this draft" {
		t.Fatal("approval lost its decision or draft")
	}
}

func TestSharedApprovalRejectsLateTopicResponse(t *testing.T) {
	m := remoteTestModel(t, func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"approval_request_id":"apr","task_id":"task","topic_id":"a","status":"pending"}`)
	})
	m.id = "a"
	m.tasks["task"] = taskdomain.TaskInfo{ID: "task", TopicID: "a", Status: taskdomain.TaskPending, ApprovalRequestID: "apr"}
	cmd := m.loadSharedApproval()
	m.newDraft()
	m.Update(cmd())
	if m.approval != nil {
		t.Fatal("old topic approval replaced current view")
	}
}

func TestSharedStopKeysTargetCurrentTopic(t *testing.T) {
	for _, key := range []tea.KeyPressMsg{{Code: tea.KeyEscape}, {Code: 'c', Mod: tea.ModCtrl}} {
		calls := 0
		m := remoteTestModel(t, func(w http.ResponseWriter, r *http.Request) {
			if r.Method != "POST" || r.URL.Path != "/runtime/topics/a/stop" {
				t.Errorf("unexpected stop %s", r.URL)
			}
			calls++
			fmt.Fprint(w, `{"found":true,"message":"Stopped by user"}`)
		})
		m.id = "a"
		m.thinking = true
		_, cmd := m.Update(key)
		if cmd == nil {
			t.Fatal("stop key did not stop shared task")
		}
		cmd()
		if calls != 1 {
			t.Fatal("stop key missed current topic")
		}
	}
}

func TestSharedHistoryPersistsExpandedMultilineInput(t *testing.T) {
	path := filepath.Join(t.TempDir(), "history")
	m := remoteTestModel(t, func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, `{"id":"task","topic_id":"a"}`) })
	m.historyPath = path
	m.textarea.SetValue("first\nsecond")
	m.submitInput(m.textarea.Value())
	if _, err := os.Stat(path); err != nil {
		t.Fatal(err)
	}
	next := newChatModel(nil)
	next.historyPath = path
	if err := next.loadHistory(); err != nil {
		t.Fatal(err)
	}
	if len(next.inputHistory) != 1 || next.inputHistory[0] != "first\nsecond" {
		t.Fatalf("lost multiline history: %q", next.inputHistory)
	}
}

func TestSharedApprovalDecisionDoesNotClearNextApproval(t *testing.T) {
	m := remoteTestModel(t, func(http.ResponseWriter, *http.Request) {})
	m.id = "a"
	m.approval = &guard.ApprovalRecord{ID: "next"}
	m.approvalParams = map[string]any{"cmd": "next command"}
	m.approvalResolving = true
	m.applySharedApprovalDecision(sharedApprovalDecision{gen: m.gen, topic: "a", id: "previous", response: daemonruntime.ApprovalDecisionResponse{Status: "approved"}})
	if m.approval == nil || m.approval.ID != "next" || !m.approvalResolving || m.approvalParams["cmd"] != "next command" {
		t.Fatal("a late decision replaced the next approval in the same topic")
	}
	m.applySharedApproval(sharedApproval{gen: m.gen, topic: "a", id: "previous", info: daemonruntime.ApprovalInfo{ApprovalRequestID: "previous", TopicID: "a", Status: "approved"}})
	if m.approval == nil || m.approval.ID != "next" {
		t.Fatal("a late approval read closed the next approval")
	}
	m.tasks["old-task"] = taskdomain.TaskInfo{ID: "old-task", TopicID: "a", Status: taskdomain.TaskPending, ApprovalRequestID: "previous"}
	m.applySharedApproval(sharedApproval{gen: m.gen, topic: "a", id: "previous", info: daemonruntime.ApprovalInfo{ApprovalRequestID: "previous", TopicID: "a", TaskID: "old-task", Status: "pending"}})
	if m.approval == nil || m.approval.ID != "next" {
		t.Fatal("a read issued before the decision reopened a resolved approval")
	}
}
