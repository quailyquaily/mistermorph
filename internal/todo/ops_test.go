package todo

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/internal/entryutil"
)

type stubSemantics struct {
	keepFn  func(items []entryutil.SemanticItem) ([]int, error)
	matchFn func(query string, entries []Entry) (int, error)
}

func (s stubSemantics) SelectDedupKeepIndices(_ context.Context, items []entryutil.SemanticItem) ([]int, error) {
	if s.keepFn == nil {
		out := make([]int, 0, len(items))
		for i := range items {
			out = append(out, i)
		}
		return out, nil
	}
	return s.keepFn(items)
}

func (s stubSemantics) MatchCompleteIndex(_ context.Context, query string, entries []Entry) (int, error) {
	if s.matchFn == nil {
		return -1, fmt.Errorf("no matching todo item in TODO.md")
	}
	return s.matchFn(query, entries)
}

func TestStoreAddAndComplete(t *testing.T) {
	root := t.TempDir()
	store := NewStore(filepath.Join(root, "TODO.md"), filepath.Join(root, "TODO.DONE.md"))
	store.Semantics = stubSemantics{
		matchFn: func(query string, entries []Entry) (int, error) {
			for i, item := range entries {
				if strings.Contains(item.Content, query) {
					return i, nil
				}
			}
			return -1, fmt.Errorf("no matching todo item in TODO.md")
		},
	}
	now := time.Date(2026, 2, 9, 10, 0, 0, 0, time.UTC)
	store.Now = func() time.Time { return now }

	addRes, err := store.Add(context.Background(), "帮 [John](tg:1001) 发消息给 [Momo](maep:12D3KooWPeer)")
	if err != nil {
		t.Fatalf("Add() error = %v", err)
	}
	if !addRes.OK || addRes.UpdatedCounts.OpenCount != 1 || addRes.UpdatedCounts.DoneCount != 0 {
		t.Fatalf("unexpected add result: %#v", addRes)
	}
	if addRes.Entry == nil || strings.TrimSpace(addRes.Entry.CreatedAt) != "2026-02-09 10:00" {
		t.Fatalf("unexpected add entry: %#v", addRes.Entry)
	}

	now = now.Add(30 * time.Minute)
	completeRes, err := store.Complete(context.Background(), "发消息给 [Momo](maep:12D3KooWPeer)")
	if err != nil {
		t.Fatalf("Complete() error = %v", err)
	}
	if !completeRes.OK || completeRes.UpdatedCounts.OpenCount != 0 || completeRes.UpdatedCounts.DoneCount != 1 {
		t.Fatalf("unexpected complete result: %#v", completeRes)
	}
	if completeRes.Entry == nil || strings.TrimSpace(completeRes.Entry.DoneAt) != "2026-02-09 10:30" {
		t.Fatalf("unexpected complete entry: %#v", completeRes.Entry)
	}

	listRes, err := store.List("both")
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	if len(listRes.WIPItems) != 0 || len(listRes.DONEItems) != 1 {
		t.Fatalf("unexpected list result: %#v", listRes)
	}
}

func TestStoreAddRejectsInvalidReferenceID(t *testing.T) {
	root := t.TempDir()
	store := NewStore(filepath.Join(root, "TODO.md"), filepath.Join(root, "TODO.DONE.md"))
	store.Semantics = stubSemantics{}
	store.Now = func() time.Time {
		return time.Date(2026, 2, 9, 10, 0, 0, 0, time.UTC)
	}

	_, err := store.Add(context.Background(), "提醒 [John](unknown id) 明天回复")
	if err == nil {
		t.Fatalf("expected Add() to fail for invalid reference id")
	}
	if !strings.Contains(strings.ToLower(err.Error()), "invalid reference id") {
		t.Fatalf("unexpected error: %v", err)
	}
}
