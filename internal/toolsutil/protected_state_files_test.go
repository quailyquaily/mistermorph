package toolsutil

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	cronstore "github.com/quailyquaily/mistermorph/internal/cron"
	"github.com/quailyquaily/mistermorph/tools"
	"github.com/spf13/viper"
)

// An install upgraded with the deny lists an older config template wrote out explicitly: the
// job list in agent.db holds a job's literal bash_env value, in the database and, while it is
// open, in its -wal file. read_file and bash, built from that config, refuse every one of them.
func TestOldExplicitDenyListsStillProtectTheJobListInAgentDB(t *testing.T) {
	stateDir := t.TempDir()
	const secret = "sk-literal-job-secret"
	store := cronstore.NewStore(filepath.Join(stateDir, "cron.yaml"))
	if _, err := store.AddRecurring(cronstore.Task{Cron: "* * * * *", Content: "report",
		BashEnv: []cronstore.BashEnvRef{{Name: "API_TOKEN", Value: secret}}}); err != nil {
		t.Fatal(err)
	}
	// The store stays open, as in a running agent: recent commits sit in agent.db-wal.
	if _, err := os.Stat(filepath.Join(stateDir, "agent.db-wal")); err != nil {
		t.Fatalf("agent.db-wal: %v", err)
	}
	// A jobs.db an earlier build left behind, and a leftover rollback journal.
	for _, name := range []string{"jobs.db", "jobs.db-wal", "agent.db-journal"} {
		if err := os.WriteFile(filepath.Join(stateDir, name), []byte(secret), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	for _, list := range [][]string{{"config.yaml"}, {"config.yaml", "config.yaml.imported", "agent.db"}} {
		reader := viper.New()
		reader.Set("file_state_dir", stateDir)
		reader.Set("file_cache_dir", t.TempDir())
		reader.Set("tools.read_file.max_bytes", 1<<20)
		reader.Set("tools.read_file.deny_paths", list)
		reader.Set("tools.bash.enabled", true)
		reader.Set("tools.bash.deny_paths", list)
		cfg, err := StaticRegistryConfigFromReader(reader)
		if err != nil {
			t.Fatal(err)
		}
		reg := tools.NewRegistry()
		RegisterStaticTools(reg, cfg, nil, nil)
		readFile, ok := reg.Get("read_file")
		if !ok {
			t.Fatal("read_file not registered")
		}
		bash, ok := reg.Get("bash")
		if !ok {
			t.Fatal("bash not registered")
		}
		for _, name := range []string{"agent.db", "agent.db-wal", "agent.db-shm", "agent.db-journal", "jobs.db", "jobs.db-wal"} {
			out, err := readFile.Execute(context.Background(), map[string]any{"path": "file_state_dir/" + name})
			if err == nil || strings.Contains(out, secret) {
				t.Fatalf("deny_paths %v: read_file %s returned %d bytes, %v", list, name, len(out), err)
			}
			out, err = bash.Execute(context.Background(), map[string]any{"cmd": "cat " + filepath.Join(stateDir, name)})
			if err == nil || strings.Contains(out, secret) {
				t.Fatalf("deny_paths %v: bash cat %s returned %d bytes, %v", list, name, len(out), err)
			}
		}
	}
}
