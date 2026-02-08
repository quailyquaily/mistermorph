package maepruntime

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestStateStoreLoadMissing(t *testing.T) {
	store, err := NewStateStore(t.TempDir())
	if err != nil {
		t.Fatalf("NewStateStore() error = %v", err)
	}
	snapshot, found, err := store.Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if found {
		t.Fatalf("Load() found = true, want false")
	}
	if snapshot.ChannelOffsets != nil || snapshot.SessionStates != nil {
		t.Fatalf("Load() snapshot should be zero value when missing")
	}
}

func TestStateStoreSaveLoadRoundTrip(t *testing.T) {
	root := t.TempDir()
	store, err := NewStateStore(root)
	if err != nil {
		t.Fatalf("NewStateStore() error = %v", err)
	}
	now := time.Date(2026, 2, 8, 12, 0, 0, 0, time.UTC)
	want := StateSnapshot{
		ChannelOffsets: map[string]int64{
			ChannelTelegram: 123,
		},
		SessionStates: map[string]SessionState{
			"peerA::session:0194f5c0-8f6e-7d9d-a4d7-6d8d4f35f456": {
				TurnCount:         2,
				CooldownUntil:     now.Add(10 * time.Minute),
				UpdatedAt:         now,
				InterestLevel:     0.6,
				LowInterestRounds: 1,
				PreferenceSynced:  true,
			},
		},
	}
	if err := store.Save(want); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	got, found, err := store.Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if !found {
		t.Fatalf("Load() found = false, want true")
	}
	if got.ChannelOffsets[ChannelTelegram] != 123 {
		t.Fatalf("channel offset mismatch: got %d want 123", got.ChannelOffsets[ChannelTelegram])
	}
	session := got.SessionStates["peerA::session:0194f5c0-8f6e-7d9d-a4d7-6d8d4f35f456"]
	if session.TurnCount != 2 || session.LowInterestRounds != 1 || session.InterestLevel != 0.6 || !session.PreferenceSynced {
		t.Fatalf("session state mismatch: got %+v", session)
	}
}

func TestStateStoreLoadRejectsUnknownField(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "runtime", "state.json")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("MkdirAll() error = %v", err)
	}
	raw := []byte(`{"channel_offsets":{"telegram":1},"session_states":{},"unknown":1}`)
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}
	store, err := NewStateStore(root)
	if err != nil {
		t.Fatalf("NewStateStore() error = %v", err)
	}
	_, _, err = store.Load()
	if err == nil || !strings.Contains(err.Error(), "unknown field") {
		t.Fatalf("Load() error = %v, want unknown field", err)
	}
}

func TestStateStoreSaveRejectsInvalidOffset(t *testing.T) {
	store, err := NewStateStore(t.TempDir())
	if err != nil {
		t.Fatalf("NewStateStore() error = %v", err)
	}
	err = store.Save(StateSnapshot{
		ChannelOffsets: map[string]int64{ChannelTelegram: -1},
		SessionStates:  map[string]SessionState{},
	})
	if err == nil || !strings.Contains(err.Error(), "must be >= 0") {
		t.Fatalf("Save() error = %v, want invalid offset", err)
	}
}

func TestStateStoreSaveRejectsInvalidSessionState(t *testing.T) {
	store, err := NewStateStore(t.TempDir())
	if err != nil {
		t.Fatalf("NewStateStore() error = %v", err)
	}
	err = store.Save(StateSnapshot{
		ChannelOffsets: map[string]int64{ChannelTelegram: 1},
		SessionStates: map[string]SessionState{
			"peerA::topic:chat.message": {
				InterestLevel: 2,
			},
		},
	})
	if err == nil || !strings.Contains(err.Error(), "interest_level must be in [0,1]") {
		t.Fatalf("Save() error = %v, want interest_level range error", err)
	}
}
