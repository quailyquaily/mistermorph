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

func TestTodoUpdateAndListTools(t *testing.T) {
	root := t.TempDir()
	wip := filepath.Join(root, "TODO.WIP.md")
	done := filepath.Join(root, "TODO.DONE.md")
	contactsDir := filepath.Join(root, "contacts")
	seedTodoContacts(t, contactsDir)

	client := &stubTodoToolLLMClient{
		replies: []string{
			`{"status":"ok","rewritten_content":"提醒 John (tg:id:1001) 和 Momo (maep:12D3KooWPeer) 对齐消息内容"}`,
			`{"status":"matched","index":0}`,
		},
	}
	update := NewTodoUpdateToolWithLLM(true, wip, done, contactsDir, client, "gpt-5.2")
	out, err := update.Execute(context.Background(), map[string]any{
		"action":  "add",
		"content": "提醒 John (tg:id:1001) 和 Momo (maep:12D3KooWPeer) 对齐消息内容",
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

	list := NewTodoListTool(true, wip, done)
	listOut, err := list.Execute(context.Background(), map[string]any{"scope": "both"})
	if err != nil {
		t.Fatalf("todo_list error = %v", err)
	}
	var listParsed struct {
		OpenCount int        `json:"open_count"`
		DoneCount int        `json:"done_count"`
		WIPItems  []struct{} `json:"wip_items"`
		DONEItems []struct{} `json:"done_items"`
	}
	if err := json.Unmarshal([]byte(listOut), &listParsed); err != nil {
		t.Fatalf("todo_list json parse error = %v", err)
	}
	if listParsed.OpenCount != 0 || listParsed.DoneCount != 1 {
		t.Fatalf("unexpected list counts: %s", listOut)
	}
	if len(listParsed.WIPItems) != 0 || len(listParsed.DONEItems) != 1 {
		t.Fatalf("unexpected list items: %s", listOut)
	}
}

func TestTodoUpdateRequiresLLMBinding(t *testing.T) {
	root := t.TempDir()
	update := NewTodoUpdateTool(true, filepath.Join(root, "TODO.WIP.md"), filepath.Join(root, "TODO.DONE.md"), filepath.Join(root, "contacts"))
	_, err := update.Execute(context.Background(), map[string]any{
		"action":  "add",
		"content": "提醒 John (tg:id:1001) 对齐信息",
	})
	if err == nil || !strings.Contains(strings.ToLower(err.Error()), "missing llm client") {
		t.Fatalf("expected missing llm client error, got %v", err)
	}
}

func TestTodoUpdateCompleteAmbiguousFromLLM(t *testing.T) {
	root := t.TempDir()
	wip := filepath.Join(root, "TODO.WIP.md")
	done := filepath.Join(root, "TODO.DONE.md")
	contactsDir := filepath.Join(root, "contacts")
	seedTodoContacts(t, contactsDir)
	client := &stubTodoToolLLMClient{
		replies: []string{
			`{"status":"ok","rewritten_content":"提醒 John (tg:id:1001) 准备一版草稿"}`,
			`{"status":"ok","rewritten_content":"提醒 John (tg:id:1001) 和 Momo (maep:12D3KooWPeer) 确认草稿"}`,
			`{"keep_indices":[0,1]}`,
			`{"status":"ambiguous","candidate_indices":[0,1]}`,
		},
	}
	update := NewTodoUpdateToolWithLLM(true, wip, done, contactsDir, client, "gpt-5.2")

	_, err := update.Execute(context.Background(), map[string]any{
		"action":  "add",
		"content": "提醒 John (tg:id:1001) 准备一版草稿",
	})
	if err != nil {
		t.Fatalf("first add error = %v", err)
	}
	_, err = update.Execute(context.Background(), map[string]any{
		"action":  "add",
		"content": "提醒 John (tg:id:1001) 和 Momo (maep:12D3KooWPeer) 确认草稿",
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
	update := NewTodoUpdateToolWithLLM(true, filepath.Join(root, "TODO.WIP.md"), filepath.Join(root, "TODO.DONE.md"), filepath.Join(root, "contacts"), client, "gpt-5.2")
	_, err := update.Execute(context.Background(), map[string]any{
		"action":  "add",
		"content": "提醒 John (not-a-reference) 明天确认内容",
	})
	if err == nil || !strings.Contains(strings.ToLower(err.Error()), "invalid reference id") {
		t.Fatalf("expected invalid reference id error, got %v", err)
	}
	if len(client.calls) != 0 {
		t.Fatalf("expected no llm calls for invalid reference input")
	}
}

func TestTodoUpdateAddMissingReferenceIDErrorFromLLM(t *testing.T) {
	root := t.TempDir()
	client := &stubTodoToolLLMClient{
		replies: []string{
			`{"status":"missing_reference_id","missing":[{"mention":"John","suggestion":"John (tg:id:1001)"}]}`,
		},
	}
	update := NewTodoUpdateToolWithLLM(true, filepath.Join(root, "TODO.WIP.md"), filepath.Join(root, "TODO.DONE.md"), filepath.Join(root, "contacts"), client, "gpt-5.2")
	_, err := update.Execute(context.Background(), map[string]any{
		"action":  "add",
		"content": "提醒 John 明天确认内容",
	})
	if err == nil {
		t.Fatalf("expected missing_reference_id error")
	}
	msg := strings.ToLower(err.Error())
	if !strings.Contains(msg, "missing_reference_id") || !strings.Contains(msg, "john") || !strings.Contains(msg, "tg:id:1001") {
		t.Fatalf("unexpected missing_reference_id error: %v", err)
	}
}

func seedTodoContacts(t *testing.T, contactsDir string) {
	t.Helper()
	svc := contacts.NewService(contacts.NewFileStore(contactsDir))
	now := time.Date(2026, 2, 9, 12, 0, 0, 0, time.UTC)
	_, err := svc.UpsertContact(context.Background(), contacts.Contact{
		ContactID:       "tg:id:1001",
		ContactNickname: "John",
		Kind:            contacts.KindHuman,
		Status:          contacts.StatusActive,
		ChannelEndpoints: []contacts.ChannelEndpoint{
			{Channel: contacts.ChannelTelegram, ChatID: 1001},
		},
	}, now)
	if err != nil {
		t.Fatalf("seed john contact error = %v", err)
	}
	_, err = svc.UpsertContact(context.Background(), contacts.Contact{
		ContactID:       "maep:12D3KooWPeer",
		ContactNickname: "Momo",
		Kind:            contacts.KindAgent,
		Status:          contacts.StatusActive,
		PeerID:          "12D3KooWPeer",
	}, now)
	if err != nil {
		t.Fatalf("seed momo contact error = %v", err)
	}
}
