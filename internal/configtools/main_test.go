package configtools

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/quailyquaily/mistermorph/internal/audience"
	"github.com/quailyquaily/mistermorph/internal/configstore"
	"github.com/quailyquaily/mistermorph/internal/secref"
	"github.com/quailyquaily/mistermorph/internal/testenv"
	"github.com/quailyquaily/mistermorph/tools"
)

// Tests here read configuration; keep MISTER_MORPH_* variables from the caller out of them.
func TestMain(m *testing.M) {
	testenv.ClearAppEnv()
	os.Exit(m.Run())
}

// memoryStore is a system keyring in memory.
type memoryStore struct {
	mu      sync.Mutex
	secrets map[string]string
	fail    bool
}

func newMemoryStore() *memoryStore { return &memoryStore{secrets: map[string]string{}} }

func (s *memoryStore) Get(_ context.Context, id string) ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	value, ok := s.secrets[id]
	if !ok {
		return nil, secref.ErrOSSecretNotFound
	}
	return []byte(value), nil
}

func (s *memoryStore) Put(_ context.Context, id, _ string, value []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.fail {
		return secref.ErrOSStoreUnavailable
	}
	s.secrets[id] = string(value)
	return nil
}

func (s *memoryStore) Delete(_ context.Context, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.secrets, id)
	return nil
}

func (s *memoryStore) values() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]string, 0, len(s.secrets))
	for _, value := range s.secrets {
		out = append(out, value)
	}
	return out
}

// dbConfig writes yaml as the agent.db config of a new state folder and returns its path.
func dbConfig(t *testing.T, yaml string) string {
	t.Helper()
	path := configstore.DBConfigPath(t.TempDir())
	if yaml != "" {
		if err := configstore.WriteFileBy(path, []byte(yaml), configstore.ByCLI); err != nil {
			t.Fatalf("WriteFileBy() error = %v", err)
		}
	}
	return path
}

// fileConfig writes yaml as a config file and returns its path.
func fileConfig(t *testing.T, yaml string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(path, []byte(yaml), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func readConfig(t *testing.T, path string) string {
	t.Helper()
	data, err := configstore.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		t.Fatalf("ReadFile() error = %v", err)
	}
	return string(data)
}

// ownerCtx is a private conversation with the owner, in a call the user approved.
func ownerCtx() context.Context {
	return tools.WithUserApproval(audience.NewContext(context.Background(), audience.Owner()))
}

func mustNotContain(t *testing.T, where, text string, secrets ...string) {
	t.Helper()
	for _, secret := range secrets {
		if secret != "" && strings.Contains(text, secret) {
			t.Fatalf("%s contains %q:\n%s", where, secret, text)
		}
	}
}
