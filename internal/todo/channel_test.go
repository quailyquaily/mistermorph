package todo

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestParseWIPEntryWithChatID(t *testing.T) {
	raw := `---
created_at: "1970-01-01T00:00:00Z"
updated_at: "1970-01-01T00:00:00Z"
open_count: 1
---

# TODO Work In Progress (WIP)

- [ ] CreatedAt: 2026-02-11 09:30 - ChatID: tg:-1001981343441 - 2026-02-11 10:00 Remind John (tg:@johnwick) to submit report.
`
	file, err := ParseWIP(raw)
	if err != nil {
		t.Fatalf("ParseWIP() error = %v", err)
	}
	if len(file.Entries) != 1 {
		t.Fatalf("entries mismatch: got %d want 1", len(file.Entries))
	}
	if file.Entries[0].ChatID != "tg:-1001981343441" {
		t.Fatalf("chat_id mismatch: got %q want %q", file.Entries[0].ChatID, "tg:-1001981343441")
	}
	if !strings.Contains(file.Entries[0].Content, "Remind John") {
		t.Fatalf("content mismatch: got %q", file.Entries[0].Content)
	}
}

func TestParseWIPEntryWithLegacyChannelPrefix(t *testing.T) {
	raw := `---
created_at: "1970-01-01T00:00:00Z"
updated_at: "1970-01-01T00:00:00Z"
open_count: 1
---

# TODO Work In Progress (WIP)

- [ ] CreatedAt: 2026-02-11 09:30 - Channel: tg:-1001981343441 - 2026-02-11 10:00 Remind John (tg:@johnwick) to submit report.
`
	file, err := ParseWIP(raw)
	if err != nil {
		t.Fatalf("ParseWIP() error = %v", err)
	}
	if len(file.Entries) != 1 {
		t.Fatalf("entries mismatch: got %d want 1", len(file.Entries))
	}
	if file.Entries[0].ChatID != "tg:-1001981343441" {
		t.Fatalf("chat_id mismatch: got %q want %q", file.Entries[0].ChatID, "tg:-1001981343441")
	}
}

func TestRenderWIPEntryWithChatID(t *testing.T) {
	file := WIPFile{
		CreatedAt: "1970-01-01T00:00:00Z",
		UpdatedAt: "1970-01-01T00:00:00Z",
		Entries: []Entry{
			{
				CreatedAt: "2026-02-11 09:30",
				ChatID:    "tg:-1001981343441",
				Content:   "2026-02-11 10:00 Remind John (tg:@johnwick) to submit report.",
			},
		},
	}
	rendered := RenderWIP(file)
	if !strings.Contains(rendered, "ChatID: tg:-1001981343441 - 2026-02-11 10:00 Remind John") {
		t.Fatalf("rendered wip missing chat_id segment:\n%s", rendered)
	}
}

func TestStoreAddWithChatIDAndCompleteKeepsChatID(t *testing.T) {
	root := t.TempDir()
	store := NewStore(filepath.Join(root, "TODO.md"), filepath.Join(root, "TODO.DONE.md"))
	store.Semantics = stubSemantics{
		matchFn: func(query string, entries []Entry) (int, error) {
			for i, item := range entries {
				if strings.Contains(item.Content, query) {
					return i, nil
				}
			}
			return -1, nil
		},
	}
	now := time.Date(2026, 2, 11, 9, 30, 0, 0, time.UTC)
	store.Now = func() time.Time { return now }

	addRes, err := store.AddWithChatID(context.Background(), "提醒 John (tg:1001) 提交报告", "tg:-1001981343441")
	if err != nil {
		t.Fatalf("AddWithChatID() error = %v", err)
	}
	if addRes.Entry == nil {
		t.Fatalf("AddWithChatID() missing entry")
	}
	if addRes.Entry.ChatID != "tg:-1001981343441" {
		t.Fatalf("add chat_id mismatch: got %q want %q", addRes.Entry.ChatID, "tg:-1001981343441")
	}

	now = now.Add(30 * time.Minute)
	completeRes, err := store.Complete(context.Background(), "提交报告")
	if err != nil {
		t.Fatalf("Complete() error = %v", err)
	}
	if completeRes.Entry == nil {
		t.Fatalf("Complete() missing done entry")
	}
	if completeRes.Entry.ChatID != "tg:-1001981343441" {
		t.Fatalf("done chat_id mismatch: got %q want %q", completeRes.Entry.ChatID, "tg:-1001981343441")
	}
}

func TestStoreAddWithInvalidChatID(t *testing.T) {
	root := t.TempDir()
	store := NewStore(filepath.Join(root, "TODO.md"), filepath.Join(root, "TODO.DONE.md"))
	store.Semantics = stubSemantics{}
	store.Now = func() time.Time {
		return time.Date(2026, 2, 11, 9, 30, 0, 0, time.UTC)
	}

	_, err := store.AddWithChatID(context.Background(), "提醒 John (tg:1001) 提交报告", "tg:@john")
	if err == nil {
		t.Fatalf("AddWithChatID() expected invalid chat_id error")
	}
	if !strings.Contains(strings.ToLower(err.Error()), "invalid chat_id") {
		t.Fatalf("AddWithChatID() error mismatch: %v", err)
	}
}
