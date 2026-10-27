package memorytools

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"testing"

	"github.com/quailyquaily/mistermorph/internal/audience"
	"github.com/quailyquaily/mistermorph/internal/domainjournal"
	"github.com/quailyquaily/mistermorph/internal/memories"
	"github.com/quailyquaily/mistermorph/tools"
)

func setup(t *testing.T) (*memories.Store, string) {
	t.Helper()
	root := t.TempDir()
	store, err := memories.Open(context.Background(), filepath.Join(root, "memory.db"))
	if err != nil {
		t.Fatalf("memories.Open() error = %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	return store, filepath.Join(root, "journal")
}

func toolsFor(store *memories.Store, journalDir string, a audience.Audience) map[string]tools.Tool {
	out := map[string]tools.Tool{}
	for _, tool := range New(Deps{Store: store, JournalDir: journalDir, Audience: a}) {
		out[tool.Name()] = tool
	}
	return out
}

func call(t *testing.T, tool tools.Tool, params map[string]any) (map[string]any, error) {
	t.Helper()
	raw, err := tool.Execute(context.Background(), params)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		t.Fatalf("%s result is not JSON: %v (%s)", tool.Name(), err, raw)
	}
	return out, nil
}

func TestToolSetAndVisibility(t *testing.T) {
	store, journalDir := setup(t)
	names := func(list []tools.Tool) string {
		var out []string
		for _, tool := range list {
			deferred := ""
			if tools.IsDeferred(tool) {
				deferred = "*"
			}
			out = append(out, tool.Name()+deferred)
		}
		return strings.Join(out, ",")
	}
	if got, want := names(New(Deps{Store: store, JournalDir: journalDir, Audience: audience.Owner()})), "memory_save,memory_search*,memory_forget*,journal_search*,journal_read*"; got != want {
		t.Fatalf("tools = %s, want %s (memory_save visible, the rest deferred)", got, want)
	}
	if got, want := names(New(Deps{Store: store, JournalDir: journalDir, Audience: audience.Owner(), ReadOnly: true})), "memory_search*,journal_search*,journal_read*"; got != want {
		t.Fatalf("read-only tools = %s, want %s", got, want)
	}
	for _, tool := range Catalog() {
		var schema map[string]any
		if err := json.Unmarshal([]byte(tool.ParameterSchema()), &schema); err != nil || schema["type"] != "object" {
			t.Fatalf("%s schema = %s, %v", tool.Name(), tool.ParameterSchema(), err)
		}
	}
}

func TestSaveSearchForget(t *testing.T) {
	store, journalDir := setup(t)
	alice := toolsFor(store, journalDir, audience.Contact("tg:@alice"))
	bob := toolsFor(store, journalDir, audience.Contact("tg:@bob"))

	saved, err := call(t, alice[SaveName], map[string]any{
		"name": "timezone", "type": "person", "description": "Alice works in JST", "body": "Alice is in Tokyo, UTC+9.",
	})
	if err != nil {
		t.Fatalf("memory_save error = %v", err)
	}
	if saved["status"] != "created" || saved["subject"] != "contact:tg:@alice" || saved["visibility"] != "private" {
		t.Fatalf("memory_save = %#v, want created about alice, private", saved)
	}
	again, err := call(t, alice[SaveName], map[string]any{
		"name": "timezone", "type": "person", "description": "Alice works in JST", "body": "Alice is in Osaka, UTC+9.",
	})
	if err != nil || again["status"] != "replaced" || again["id"] != saved["id"] {
		t.Fatalf("second memory_save = %#v, %v; want the same memory replaced", again, err)
	}

	if _, err := call(t, alice[SaveName], map[string]any{
		"subject": "general", "name": "rule", "type": "feedback", "description": "d", "body": "b",
	}); err == nil || !strings.Contains(err.Error(), "direct message") {
		t.Fatalf("memory_save(general from a contact) error = %v, want the rule's refusal", err)
	}

	found, err := call(t, alice[SearchName], map[string]any{"query": "Osaka"})
	if err != nil || len(found["memories"].([]any)) != 1 {
		t.Fatalf("alice memory_search = %#v, %v; want her memory", found, err)
	}
	if found, _ := call(t, bob[SearchName], map[string]any{"query": "Osaka"}); len(found["memories"].([]any)) != 0 {
		t.Fatalf("bob memory_search = %#v, want nothing", found)
	}
	if _, err := call(t, bob[ForgetName], map[string]any{"id": saved["id"]}); err == nil || !strings.Contains(err.Error(), "no memory") {
		t.Fatalf("bob memory_forget error = %v, want not found", err)
	}
	if out, err := call(t, alice[ForgetName], map[string]any{"id": saved["id"]}); err != nil || out["forgotten"] != saved["id"] {
		t.Fatalf("alice memory_forget = %#v, %v", out, err)
	}
}

func TestJournalToolsRespectTheAudience(t *testing.T) {
	store, journalDir := setup(t)
	journal, err := domainjournal.New(domainjournal.JournalOptions{Dir: journalDir})
	if err != nil {
		t.Fatalf("domainjournal.New() error = %v", err)
	}
	for i, audienceString := range []string{"", "contact:tg:@alice", "conversation:tg:-100"} {
		payload := fmt.Sprintf(`{"task":{"id":"t%d","task":"budget review for friday","status":"queued"}}`, i)
		if _, err := journal.Append(domainjournal.Event{
			ID: fmt.Sprintf("evt_%d", i), Time: "2026-10-01T10:00:00Z", Domain: "task", Type: "task_upsert", SchemaVersion: 1,
			Trace: domainjournal.Trace{TaskID: fmt.Sprintf("t%d", i)}, Audience: audienceString, Payload: json.RawMessage(payload),
		}); err != nil {
			t.Fatalf("Append() error = %v", err)
		}
	}
	_ = journal.Close()

	for _, tc := range []struct {
		who  audience.Audience
		want string
	}{
		{audience.Owner(), "evt_2,evt_1,evt_0"},
		{audience.Contact("tg:@alice"), "evt_1"},
		{audience.Conversation("tg:-100"), "evt_2"},
		{audience.Contact("tg:@bob"), ""},
	} {
		got, err := call(t, toolsFor(store, journalDir, tc.who)[JournalSearchName], map[string]any{"query": "budget"})
		if err != nil {
			t.Fatalf("journal_search(%s) error = %v", tc.who.String(), err)
		}
		var ids []string
		for _, event := range got["events"].([]any) {
			ids = append(ids, event.(map[string]any)["id"].(string))
		}
		if strings.Join(ids, ",") != tc.want {
			t.Fatalf("journal_search(%s) = %v, want %s", tc.who.String(), ids, tc.want)
		}
	}

	alice := toolsFor(store, journalDir, audience.Contact("tg:@alice"))
	if out, err := call(t, alice[JournalReadName], map[string]any{"seq": float64(2)}); err != nil || out["id"] != "evt_1" {
		t.Fatalf("alice journal_read(her event) = %#v, %v", out, err)
	}
	if _, err := call(t, alice[JournalReadName], map[string]any{"seq": float64(1)}); err == nil || !strings.Contains(err.Error(), "no journal event") {
		t.Fatalf("alice journal_read(owner's event) error = %v, want it reported missing", err)
	}
	if _, err := call(t, alice[JournalSearchName], map[string]any{"since": "last week"}); err == nil {
		t.Fatal("journal_search(bad since) error = nil")
	}
}

func TestNoAudienceHasNothing(t *testing.T) {
	store, journalDir := setup(t)
	for name, tool := range toolsFor(store, journalDir, audience.Audience{}) {
		if _, err := tool.Execute(context.Background(), map[string]any{"name": "x", "type": "person", "description": "d", "body": "b", "id": "x", "seq": float64(1)}); err == nil {
			t.Fatalf("%s without an audience error = nil", name)
		}
	}
}
