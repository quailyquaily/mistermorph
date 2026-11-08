package consolecmd

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestSessionStorePersistsAcrossRestart(t *testing.T) {
	t.Parallel()

	storePath := t.TempDir()
	store1 := newSessionStore(storePath)

	token, expiresAt, err := store1.Create(2 * time.Hour)
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	if token == "" {
		t.Fatalf("expected non-empty token")
	}
	if !expiresAt.After(time.Now().UTC()) {
		t.Fatalf("expected future expiry, got %s", expiresAt.Format(time.RFC3339Nano))
	}

	store2 := newSessionStore(storePath)
	gotExpiresAt, ok := store2.Validate(token)
	if !ok {
		t.Fatalf("expected token to remain valid after restart")
	}
	if !gotExpiresAt.Equal(expiresAt) {
		t.Fatalf("unexpected expiry: got=%s want=%s", gotExpiresAt.Format(time.RFC3339Nano), expiresAt.Format(time.RFC3339Nano))
	}
}

func TestSessionStoreDeletePersistsAcrossRestart(t *testing.T) {
	t.Parallel()

	storePath := t.TempDir()
	store1 := newSessionStore(storePath)

	token, _, err := store1.Create(2 * time.Hour)
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	store1.Delete(token)

	store2 := newSessionStore(storePath)
	if _, ok := store2.Validate(token); ok {
		t.Fatalf("expected token to stay deleted after restart")
	}
}

func TestSessionStoreImportsSessionsJSON(t *testing.T) {
	t.Parallel()

	stateDir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(stateDir, "console"), 0o700); err != nil {
		t.Fatal(err)
	}
	live := time.Now().UTC().Add(time.Hour).Truncate(time.Second)
	raw := `{"version":1,"sessions":{"` + tokenHash("live-token") + `":"` + live.Format(time.RFC3339Nano) + `",` +
		`"` + tokenHash("old-token") + `":"2020-01-01T00:00:00Z","bad":"not a time"}}`
	if err := os.WriteFile(filepath.Join(stateDir, "console", "sessions.json"), []byte(raw), 0o600); err != nil {
		t.Fatal(err)
	}
	store := newSessionStore(stateDir)
	defer func() { _ = store.Close() }()
	if got, ok := store.Validate("live-token"); !ok || !got.Equal(live) {
		t.Fatalf("live session = %s, %v", got, ok)
	}
	if _, ok := store.Validate("old-token"); ok {
		t.Fatal("expired session imported")
	}
	if _, err := os.Stat(filepath.Join(stateDir, "console", "sessions.json.imported")); err != nil {
		t.Fatalf("sessions.json not renamed: %v", err)
	}
	var stored int
	if err := store.db.QueryRow(`SELECT COUNT(*) FROM console_sessions WHERE token_hash = ?`, tokenHash("live-token")).Scan(&stored); err != nil || stored != 1 {
		t.Fatalf("hashed row = %d, %v", stored, err)
	}
	var plain int
	if err := store.db.QueryRow(`SELECT COUNT(*) FROM console_sessions WHERE token_hash = 'live-token'`).Scan(&plain); err != nil || plain != 0 {
		t.Fatalf("token stored in the clear: %d, %v", plain, err)
	}
}

func TestSessionStoreRejectsExpiredSessions(t *testing.T) {
	t.Parallel()

	store := newSessionStore(t.TempDir())
	defer func() { _ = store.Close() }()
	token, _, err := store.Create(time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec(`UPDATE console_sessions SET expires_at = ?`, "2020-01-01T00:00:00Z"); err != nil {
		t.Fatal(err)
	}
	if _, ok := store.Validate(token); ok {
		t.Fatal("expired session validated")
	}
	var rows int
	if err := store.db.QueryRow(`SELECT COUNT(*) FROM console_sessions`).Scan(&rows); err != nil || rows != 0 {
		t.Fatalf("expired row kept: %d, %v", rows, err)
	}
}
