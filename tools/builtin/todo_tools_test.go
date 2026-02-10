package builtin

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/contacts"
	"github.com/quailyquaily/mistermorph/internal/todo"
	"github.com/quailyquaily/mistermorph/llm"
)

type stubTodoToolLLMClient struct {
	replies []string
	err     error
	calls   []llm.Request
}

func (s *stubTodoToolLLMClient) Chat(_ context.Context, req llm.Request) (llm.Result, error) {
	s.calls = append(s.calls, req)
	if s.err != nil {
		return llm.Result{}, s.err
	}
	if len(s.replies) == 0 {
		return llm.Result{}, fmt.Errorf("no more stub replies")
	}
	reply := s.replies[0]
	s.replies = s.replies[1:]
	return llm.Result{Text: reply}, nil
}

func TestTodoUpdateTool(t *testing.T) {
	root := t.TempDir()
	wip := filepath.Join(root, "TODO.md")
	done := filepath.Join(root, "TODO.DONE.md")
	contactsDir := filepath.Join(root, "contacts")
	seedTodoContacts(t, contactsDir)

	client := &stubTodoToolLLMClient{
		replies: []string{
			`{"status":"ok","rewritten_content":"提醒 John (tg:1001) 和 Momo (maep:12D3KooWPeer) 对齐消息内容"}`,
			`{"status":"matched","index":0}`,
		},
	}
	update := NewTodoUpdateToolWithLLM(true, wip, done, contactsDir, client, "gpt-5.2")
	out, err := update.Execute(context.Background(), map[string]any{
		"action":  "add",
		"content": "提醒 John (tg:1001) 和 Momo (maep:12D3KooWPeer) 对齐消息内容",
		"people":  []any{"John", "Momo"},
	})
	if err != nil {
		t.Fatalf("todo_update add error = %v", err)
	}
	var addParsed struct {
		OK            bool `json:"ok"`
		UpdatedCounts struct {
			OpenCount int `json:"open_count"`
			DoneCount int `json:"done_count"`
		} `json:"updated_counts"`
	}
	if err := json.Unmarshal([]byte(out), &addParsed); err != nil {
		t.Fatalf("todo_update add json parse error = %v", err)
	}
	if !addParsed.OK || addParsed.UpdatedCounts.OpenCount != 1 || addParsed.UpdatedCounts.DoneCount != 0 {
		t.Fatalf("unexpected add result: %s", out)
	}

	_, err = update.Execute(context.Background(), map[string]any{
		"action":  "complete",
		"content": "对齐消息内容",
	})
	if err != nil {
		t.Fatalf("todo_update complete error = %v", err)
	}
	if len(client.calls) != 2 || !client.calls[0].ForceJSON || !client.calls[1].ForceJSON {
		t.Fatalf("expected two ForceJSON llm calls (add resolve + complete match)")
	}

	store := todo.NewStore(wip, done)
	listOut, err := store.List("both")
	if err != nil {
		t.Fatalf("store list error = %v", err)
	}
	if listOut.OpenCount != 0 || listOut.DoneCount != 1 {
		t.Fatalf("unexpected list counts: %+v", listOut)
	}
	if len(listOut.WIPItems) != 0 || len(listOut.DONEItems) != 1 {
		t.Fatalf("unexpected list items: %+v", listOut)
	}
}

func TestTodoUpdateToolAddWithChatIDParam(t *testing.T) {
	root := t.TempDir()
	wip := filepath.Join(root, "TODO.md")
	done := filepath.Join(root, "TODO.DONE.md")
	contactsDir := filepath.Join(root, "contacts")
	seedTodoContacts(t, contactsDir)

	client := &stubTodoToolLLMClient{
		replies: []string{
			`{"status":"ok","rewritten_content":"提醒 John (tg:1001) 提交评估报告"}`,
		},
	}
	update := NewTodoUpdateToolWithLLM(true, wip, done, contactsDir, client, "gpt-5.2")
	out, err := update.Execute(context.Background(), map[string]any{
		"action":  "add",
		"content": "提醒 John 提交评估报告",
		"people":  []any{"John"},
		"chat_id": "tg:-1001981343441",
	})
	if err != nil {
		t.Fatalf("todo_update add error = %v", err)
	}
	var parsed struct {
		OK    bool `json:"ok"`
		Entry struct {
			ChatID  string `json:"chat_id"`
			Content string `json:"content"`
		} `json:"entry"`
	}
	if err := json.Unmarshal([]byte(out), &parsed); err != nil {
		t.Fatalf("todo_update add json parse error = %v", err)
	}
	if !parsed.OK {
		t.Fatalf("expected ok=true, got %s", out)
	}
	if parsed.Entry.ChatID != "tg:-1001981343441" {
		t.Fatalf("entry chat_id mismatch: got %q want %q", parsed.Entry.ChatID, "tg:-1001981343441")
	}

	store := todo.NewStore(wip, done)
	listOut, err := store.List("wip")
	if err != nil {
		t.Fatalf("store list error = %v", err)
	}
	if len(listOut.WIPItems) != 1 {
		t.Fatalf("expected one WIP item, got %d", len(listOut.WIPItems))
	}
	if listOut.WIPItems[0].ChatID != "tg:-1001981343441" {
		t.Fatalf("persisted chat_id mismatch: got %q want %q", listOut.WIPItems[0].ChatID, "tg:-1001981343441")
	}
}

func TestTodoUpdateToolAddRejectsInvalidChatID(t *testing.T) {
	root := t.TempDir()
	wip := filepath.Join(root, "TODO.md")
	done := filepath.Join(root, "TODO.DONE.md")
	contactsDir := filepath.Join(root, "contacts")
	seedTodoContacts(t, contactsDir)

	client := &stubTodoToolLLMClient{
		replies: []string{
			`{"status":"ok","rewritten_content":"提醒 John (tg:1001) 提交评估报告"}`,
		},
	}
	update := NewTodoUpdateToolWithLLM(true, wip, done, contactsDir, client, "gpt-5.2")
	_, err := update.Execute(context.Background(), map[string]any{
		"action":  "add",
		"content": "提醒 John 提交评估报告",
		"people":  []any{"John"},
		"chat_id": "tg:@john",
	})
	if err == nil {
		t.Fatalf("todo_update add expected invalid chat_id error")
	}
	if !strings.Contains(strings.ToLower(err.Error()), "invalid chat_id") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestTodoUpdateRequiresLLMBinding(t *testing.T) {
	root := t.TempDir()
	update := NewTodoUpdateTool(true, filepath.Join(root, "TODO.md"), filepath.Join(root, "TODO.DONE.md"), filepath.Join(root, "contacts"))
	_, err := update.Execute(context.Background(), map[string]any{
		"action":  "add",
		"content": "提醒 John (tg:1001) 对齐信息",
		"people":  []any{"John"},
	})
	if err == nil || !strings.Contains(strings.ToLower(err.Error()), "missing llm client") {
		t.Fatalf("expected missing llm client error, got %v", err)
	}
}

func TestTodoUpdatePeopleRequired(t *testing.T) {
	root := t.TempDir()
	update := NewTodoUpdateToolWithLLM(true, filepath.Join(root, "TODO.md"), filepath.Join(root, "TODO.DONE.md"), filepath.Join(root, "contacts"), &stubTodoToolLLMClient{}, "gpt-5.2")
	_, err := update.Execute(context.Background(), map[string]any{
		"action":  "add",
		"content": "提醒 John 明天确认",
	})
	if err == nil || !strings.Contains(strings.ToLower(err.Error()), "people is required for add action") {
		t.Fatalf("expected people-is-required-for-add error, got %v", err)
	}
}

func TestTodoUpdateCompleteDoesNotRequirePeople(t *testing.T) {
	root := t.TempDir()
	wip := filepath.Join(root, "TODO.md")
	done := filepath.Join(root, "TODO.DONE.md")
	contactsDir := filepath.Join(root, "contacts")
	seedTodoContacts(t, contactsDir)
	client := &stubTodoToolLLMClient{
		replies: []string{
			`{"status":"ok","rewritten_content":"提醒 John (tg:1001) 准备草稿"}`,
			`{"status":"matched","index":0}`,
		},
	}
	update := NewTodoUpdateToolWithLLM(true, wip, done, contactsDir, client, "gpt-5.2")
	_, err := update.Execute(context.Background(), map[string]any{
		"action":  "add",
		"content": "提醒 John 准备草稿",
		"people":  []any{"John"},
	})
	if err != nil {
		t.Fatalf("add error = %v", err)
	}
	_, err = update.Execute(context.Background(), map[string]any{
		"action":  "complete",
		"content": "准备草稿",
	})
	if err != nil {
		t.Fatalf("complete should not require people, got %v", err)
	}
}

func TestTodoUpdateCompleteAmbiguousFromLLM(t *testing.T) {
	root := t.TempDir()
	wip := filepath.Join(root, "TODO.md")
	done := filepath.Join(root, "TODO.DONE.md")
	contactsDir := filepath.Join(root, "contacts")
	seedTodoContacts(t, contactsDir)
	client := &stubTodoToolLLMClient{
		replies: []string{
			`{"status":"ok","rewritten_content":"提醒 John (tg:1001) 准备一版草稿"}`,
			`{"status":"ok","rewritten_content":"提醒 John (tg:1001) 和 Momo (maep:12D3KooWPeer) 确认草稿"}`,
			`{"keep_indices":[0,1]}`,
			`{"status":"ambiguous","candidate_indices":[0,1]}`,
		},
	}
	update := NewTodoUpdateToolWithLLM(true, wip, done, contactsDir, client, "gpt-5.2")

	_, err := update.Execute(context.Background(), map[string]any{
		"action":  "add",
		"content": "提醒 John (tg:1001) 准备一版草稿",
		"people":  []any{"John"},
	})
	if err != nil {
		t.Fatalf("first add error = %v", err)
	}
	_, err = update.Execute(context.Background(), map[string]any{
		"action":  "add",
		"content": "提醒 John (tg:1001) 和 Momo (maep:12D3KooWPeer) 确认草稿",
		"people":  []any{"John", "Momo"},
	})
	if err != nil {
		t.Fatalf("second add error = %v", err)
	}

	_, err = update.Execute(context.Background(), map[string]any{
		"action":  "complete",
		"content": "提醒 John 确认草稿",
	})
	if err == nil || !strings.Contains(strings.ToLower(err.Error()), "ambiguous") {
		t.Fatalf("expected ambiguous error, got %v", err)
	}
}

func TestTodoUpdateAddRejectsInvalidReferenceBeforeLLM(t *testing.T) {
	root := t.TempDir()
	client := &stubTodoToolLLMClient{}
	update := NewTodoUpdateToolWithLLM(true, filepath.Join(root, "TODO.md"), filepath.Join(root, "TODO.DONE.md"), filepath.Join(root, "contacts"), client, "gpt-5.2")
	_, err := update.Execute(context.Background(), map[string]any{
		"action":  "add",
		"content": "提醒 John (not-a-reference) 明天确认内容",
		"people":  []any{"John"},
	})
	if err == nil || !strings.Contains(strings.ToLower(err.Error()), "invalid reference id") {
		t.Fatalf("expected invalid reference id error, got %v", err)
	}
	if len(client.calls) != 0 {
		t.Fatalf("expected no llm calls for invalid reference input")
	}
}

func TestTodoUpdateAddMissingReferenceIDFallbackWritesRaw(t *testing.T) {
	root := t.TempDir()
	client := &stubTodoToolLLMClient{
		replies: []string{
			`{"status":"missing_reference_id","missing":[{"mention":"John","suggestion":"John (tg:1001)"}]}`,
		},
	}
	update := NewTodoUpdateToolWithLLM(true, filepath.Join(root, "TODO.md"), filepath.Join(root, "TODO.DONE.md"), filepath.Join(root, "contacts"), client, "gpt-5.2")
	out, err := update.Execute(context.Background(), map[string]any{
		"action":  "add",
		"content": "提醒 John 明天确认内容",
		"people":  []any{"John"},
	})
	if err != nil {
		t.Fatalf("expected raw-write fallback success, got error: %v", err)
	}
	var parsed struct {
		OK    bool `json:"ok"`
		Entry struct {
			Content string `json:"content"`
		} `json:"entry"`
		Warnings []string `json:"warnings"`
	}
	if err := json.Unmarshal([]byte(out), &parsed); err != nil {
		t.Fatalf("todo_update add json parse error = %v", err)
	}
	if !parsed.OK || strings.TrimSpace(parsed.Entry.Content) != "提醒 John 明天确认内容" {
		t.Fatalf("unexpected fallback add result: %s", out)
	}
	if len(parsed.Warnings) == 0 || parsed.Warnings[0] != "reference_unresolved_write_raw" {
		t.Fatalf("expected fallback warning, got: %#v", parsed.Warnings)
	}
}

func TestTodoUpdateAddMissingSelfReferenceIDFallbackWritesRaw(t *testing.T) {
	root := t.TempDir()
	wip := filepath.Join(root, "TODO.md")
	done := filepath.Join(root, "TODO.DONE.md")
	contactsDir := filepath.Join(root, "contacts")
	seedTodoContacts(t, contactsDir)

	client := &stubTodoToolLLMClient{
		replies: []string{
			`{"status":"ok","rewritten_content":"今晚20点提醒我看球赛"}`,
		},
	}
	update := NewTodoUpdateToolWithLLM(true, wip, done, contactsDir, client, "gpt-5.2")
	out, err := update.Execute(context.Background(), map[string]any{
		"action":  "add",
		"content": "今晚20点提醒我看球赛",
		"people":  []any{"我"},
	})
	if err != nil {
		t.Fatalf("expected raw-write fallback success, got error: %v", err)
	}
	var parsed struct {
		OK    bool `json:"ok"`
		Entry struct {
			Content string `json:"content"`
		} `json:"entry"`
		Warnings []string `json:"warnings"`
	}
	if err := json.Unmarshal([]byte(out), &parsed); err != nil {
		t.Fatalf("todo_update add json parse error = %v", err)
	}
	if !parsed.OK || strings.TrimSpace(parsed.Entry.Content) != "今晚20点提醒我看球赛" {
		t.Fatalf("unexpected fallback add result: %s", out)
	}
	if len(parsed.Warnings) == 0 || parsed.Warnings[0] != "reference_unresolved_write_raw" {
		t.Fatalf("expected fallback warning, got: %#v", parsed.Warnings)
	}
	if len(client.calls) != 1 {
		t.Fatalf("expected exactly one llm call, got %d", len(client.calls))
	}
}

func TestTodoUpdateAddSelfReferenceResolvedFromTelegramContext(t *testing.T) {
	root := t.TempDir()
	wip := filepath.Join(root, "TODO.md")
	done := filepath.Join(root, "TODO.DONE.md")
	contactsDir := filepath.Join(root, "contacts")
	seedTodoContacts(t, contactsDir)

	client := &stubTodoToolLLMClient{
		replies: []string{
			`{"status":"ok","rewritten_content":"今晚20点提醒我 (tg:1001) 看球赛"}`,
		},
	}
	update := NewTodoUpdateToolWithLLM(true, wip, done, contactsDir, client, "gpt-5.2")
	update.SetAddContext(todo.AddResolveContext{
		Channel:         "telegram",
		ChatType:        "private",
		ChatID:          1001,
		SpeakerUserID:   1001,
		SpeakerUsername: "john",
	})
	out, err := update.Execute(context.Background(), map[string]any{
		"action":  "add",
		"content": "今晚20点提醒我看球赛",
		"people":  []any{"我"},
	})
	if err != nil {
		t.Fatalf("expected add success, got error: %v", err)
	}
	var parsed struct {
		OK    bool `json:"ok"`
		Entry struct {
			Content string `json:"content"`
		} `json:"entry"`
		Warnings []string `json:"warnings"`
	}
	if err := json.Unmarshal([]byte(out), &parsed); err != nil {
		t.Fatalf("todo_update add json parse error = %v", err)
	}
	if !parsed.OK {
		t.Fatalf("expected ok=true, got %s", out)
	}
	if !strings.Contains(parsed.Entry.Content, "我 (tg:1001)") {
		t.Fatalf("expected self reference id resolved, got: %q", parsed.Entry.Content)
	}
	if len(client.calls) != 1 {
		t.Fatalf("expected exactly one llm call, got %d", len(client.calls))
	}
}

func seedTodoContacts(t *testing.T, contactsDir string) {
	t.Helper()
	svc := contacts.NewService(contacts.NewFileStore(contactsDir))
	now := time.Date(2026, 2, 9, 12, 0, 0, 0, time.UTC)
	_, err := svc.UpsertContact(context.Background(), contacts.Contact{
		ContactID:       "tg:1001",
		ContactNickname: "John",
		Kind:            contacts.KindHuman,
		Channel:         contacts.ChannelTelegram,
		TGPrivateChatID: 1001,
	}, now)
	if err != nil {
		t.Fatalf("seed john contact error = %v", err)
	}
	_, err = svc.UpsertContact(context.Background(), contacts.Contact{
		ContactID:       "maep:12D3KooWPeer",
		ContactNickname: "Momo",
		Kind:            contacts.KindAgent,
		Channel:         contacts.ChannelMAEP,
		MAEPNodeID:      "maep:12D3KooWPeer",
	}, now)
	if err != nil {
		t.Fatalf("seed momo contact error = %v", err)
	}
}
