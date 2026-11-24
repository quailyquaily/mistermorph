package workspace

import (
	"path/filepath"
	"testing"
	"time"
)

func TestListAttachmentsAndRecentUses(t *testing.T) {
	dir := t.TempDir()
	store := NewStore(filepath.Join(dir, "workspace_attachments.json"))
	for key, ws := range map[string]string{"console:a": "/w/a", "console:b": "/w/b", "tg:1": "/w/tg"} {
		if _, _, err := store.Set(key, Attachment{WorkspaceDir: ws}); err != nil {
			t.Fatal(err)
		}
	}
	got, err := store.ListAttachments("console:")
	if err != nil || len(got) != 2 {
		t.Fatalf("console attachments = %+v, %v", got, err)
	}
	for _, rec := range got {
		if rec.ScopeKey == "tg:1" || rec.UpdatedAt.IsZero() {
			t.Fatalf("record = %+v", rec)
		}
	}

	base := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	if err := store.RecordUse("/w/a", base); err != nil {
		t.Fatal(err)
	}
	if err := store.RecordUse("/w/b", base.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	// An older time never moves a use back.
	if err := store.RecordUse("/w/b", base); err != nil {
		t.Fatal(err)
	}
	uses, err := store.RecentUses(10)
	if err != nil || len(uses) != 2 || uses[0].WorkspaceDir != "/w/b" || !uses[0].UsedAt.Equal(base.Add(time.Hour)) {
		t.Fatalf("uses = %+v, %v", uses, err)
	}

	// Only the most recent MaxRecentUses are kept.
	for i := 0; i < MaxRecentUses+5; i++ {
		if err := store.RecordUse(filepath.Join("/many", string(rune('a'+i%26)), time.Duration(i).String()), base.Add(time.Duration(i+2)*time.Hour)); err != nil {
			t.Fatal(err)
		}
	}
	uses, err = store.RecentUses(0)
	if err != nil || len(uses) != MaxRecentUses {
		t.Fatalf("kept %d uses, %v", len(uses), err)
	}
	for _, use := range uses {
		if use.WorkspaceDir == "/w/a" {
			t.Fatal("the oldest use was kept")
		}
	}
}

func TestEmptyStoreListsNothing(t *testing.T) {
	var none *Store
	if got, err := none.ListAttachments("console:"); err != nil || got != nil {
		t.Fatalf("nil store = %v, %v", got, err)
	}
	if got, err := NewStore("").RecentUses(5); err != nil || got != nil {
		t.Fatalf("no state dir = %v, %v", got, err)
	}
}
