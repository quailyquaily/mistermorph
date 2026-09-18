package chatcmd

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
)

func TestSharedChatLoadsRuntimeSkillsIntoCommonComposer(t *testing.T) {
	var submitted daemonruntime.SubmitTaskRequest
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer secret" {
			t.Error("missing runtime authentication")
		}
		switch r.URL.Path {
		case "/runtime/settings/agent":
			fmt.Fprint(w, `{"llm":{"model":"server-model"},"skills":{"loaded":[{"id":"imagegen","name":"Image Generator","description":"Generate images"}],"available":[{"id":"imagegen"},{"id":"docs","description":"Read documentation"}]}}`)
		case "/runtime/tasks":
			if err := json.NewDecoder(r.Body).Decode(&submitted); err != nil {
				t.Error(err)
			}
			fmt.Fprint(w, `{"id":"task","topic_id":"topic"}`)
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
	}))
	defer srv.Close()
	client, err := newRemoteClient(srv.URL+"/runtime", "secret")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	m := newSharedChatModel(ctx, client)
	m.Update(m.loadSharedSettings()())
	if len(m.skillItems) != 2 || m.status.model != "server-model" {
		t.Fatalf("runtime catalog not applied: skills=%v model=%q", m.skillItems, m.status.model)
	}
	m.textarea.SetValue("Use $ima")
	m.textarea.CursorEnd()
	m.Update(keyRemote(tea.KeyTab))
	if m.textarea.Value() != "Use $imagegen " {
		t.Fatalf("runtime skill reference was not inserted: %q", m.textarea.Value())
	}
	_, cmd := m.Update(keyRemote(tea.KeyEnter))
	if cmd == nil {
		t.Fatal("completed input was not submitted")
	}
	remoteSubmissionResult(t, cmd)
	if submitted.Task != "Use $imagegen" || submitted.TopicID != "" {
		t.Fatalf("submission = %+v", submitted)
	}
}

func TestSharedChatCommonComposerExpandsPasteAndPreservesTopic(t *testing.T) {
	var submitted daemonruntime.SubmitTaskRequest
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&submitted); err != nil {
			t.Error(err)
		}
		fmt.Fprint(w, `{"id":"task","topic_id":"existing"}`)
	}))
	defer srv.Close()
	client, _ := newRemoteClient(srv.URL+"/runtime", "secret")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	m := newSharedChatModel(ctx, client)
	m.id, m.hasChat = "existing", true
	m.Update(tea.PasteMsg{Content: "first line\nsecond line"})
	if !strings.Contains(m.textarea.Value(), "[Pasted text") {
		t.Fatalf("shared chat bypassed the common paste handling: %q", m.textarea.Value())
	}
	_, cmd := m.Update(keyRemote(tea.KeyEnter))
	m.Update(remoteSubmissionResult(t, cmd))
	if submitted.Task != "first line\nsecond line" || submitted.TopicID != "existing" {
		t.Fatalf("submission lost paste content or topic: %+v", submitted)
	}
	if m.textarea.Value() != "" {
		t.Fatalf("successful submission kept its paste placeholder: %q", m.textarea.Value())
	}
	if len(m.inputHistory) != 1 {
		t.Fatal("shared chat bypassed input history")
	}
	cmd = m.command("/models list")
	if cmd == nil {
		t.Fatal("runtime command was rejected")
	}
	cmd()
	if submitted.Task != "/models list" || submitted.TopicID != "existing" {
		t.Fatalf("runtime command changed topic: %+v", submitted)
	}
}

func TestSharedChatDoesNotReloadAnEmptySkillCatalogOnEachKeystroke(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	m := newSharedChatModel(ctx, nil)
	m.applySharedSettings(sharedSettings{})
	m.Update(tea.KeyPressMsg{Code: '$', Text: "$"})
	if m.skillsLoading {
		t.Fatal("an empty runtime catalog triggered another settings request")
	}
}
