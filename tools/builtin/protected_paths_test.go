package builtin

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/internal/pathroots"
)

// Deny lists written before agent.db or jobs.db existed (older config templates), or that leave
// the SQLite sidecar files out, still deny the agent's own state files.
var oldExplicitDenyLists = map[string][]string{
	"empty":             {},
	"oldest template":   {"config.yaml"},
	"agent.db template": {"config.yaml", "config.yaml.imported", "agent.db"},
	"a path entry":      {"/srv/morph/state/agent.db"},
}

var protectedNames = []string{
	"agent.db", "agent.db-wal", "agent.db-shm", "agent.db-journal",
	"jobs.db", "jobs.db-wal", "jobs.db-shm", "jobs.db-journal",
	"config.yaml.imported", "config.yaml.imported-wal",
}

func TestEffectiveDenyPathsAddsTheProtectedStateFilesAndSidecars(t *testing.T) {
	for name, list := range oldExplicitDenyLists {
		effective := EffectiveDenyPaths(list)
		for _, file := range append([]string{"/home/u/.morph/" + "agent.db"}, protectedNames...) {
			if _, denied := DeniedPath(filepath.Join("/home/u/.morph", filepath.Base(file)), list); !denied {
				t.Fatalf("%s: %s not denied (effective %v)", name, file, effective)
			}
		}
		for _, entry := range list {
			if _, denied := denyPath(entry, effective); !denied {
				t.Fatalf("%s: configured entry %s dropped", name, entry)
			}
		}
		if _, denied := DeniedPath("/home/u/notes.db", list); denied {
			t.Fatalf("%s: an ordinary file is denied", name)
		}
	}
	// A configured entry's sidecars are denied with it, a path entry's too.
	if _, denied := DeniedPath("/srv/data/memory.db-wal", []string{"memory.db"}); !denied {
		t.Fatal("memory.db-wal not denied with memory.db")
	}
	if _, denied := DeniedPath("/srv/morph/state/custom.db-shm", []string{"state/custom.db"}); !denied {
		t.Fatal("a path entry's sidecar is not denied")
	}
	// No entry twice, the configured ones first.
	effective := EffectiveDenyPaths([]string{" agent.db ", "config.yaml"})
	seen := map[string]bool{}
	for _, entry := range effective {
		if seen[entry] {
			t.Fatalf("%q twice in %v", entry, effective)
		}
		seen[entry] = true
	}
	if effective[0] != "agent.db" || effective[1] != "config.yaml" {
		t.Fatalf("effective = %v", effective)
	}
}

func TestReadFileRefusesTheProtectedStateFilesWithOldDenyLists(t *testing.T) {
	stateDir := t.TempDir()
	for _, name := range append([]string{"notes.txt"}, protectedNames...) {
		if err := os.WriteFile(filepath.Join(stateDir, name), []byte("API_TOKEN=literal-secret"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink(filepath.Join(stateDir, "agent.db-wal"), filepath.Join(stateDir, "innocent.txt")); err != nil {
		t.Fatal(err)
	}
	for name, list := range oldExplicitDenyLists {
		tool := NewReadFileToolWithDenyPaths(1<<20, list, pathroots.New("", "", stateDir))
		for _, file := range append([]string{"innocent.txt"}, protectedNames...) {
			for _, path := range []string{"file_state_dir/" + file, filepath.Join(stateDir, file)} {
				out, err := tool.Execute(context.Background(), map[string]any{"path": path})
				if err == nil || !strings.Contains(err.Error(), "denied") || strings.Contains(out, "literal-secret") {
					t.Fatalf("%s: read_file %s = %q, %v", name, path, out, err)
				}
			}
		}
		if out, err := tool.Execute(context.Background(), map[string]any{"path": "file_state_dir/notes.txt"}); err != nil || out == "" {
			t.Fatalf("%s: an ordinary file: %q, %v", name, out, err)
		}
	}
}

func TestShellToolsRefuseCommandsNamingTheProtectedStateFilesWithOldDenyLists(t *testing.T) {
	commands := []string{
		"cat agent.db",
		"sqlite3 ~/.morph/agent.db 'select * from jobs'",
		"strings ~/.morph/agent.db-wal",
		"xxd agent.db-shm | head",
		"cp jobs.db /tmp/x",
		"cat ./state/jobs.db-wal",
		"cat config.yaml.imported",
	}
	for name, list := range oldExplicitDenyLists {
		tool := NewBashTool(true, 5*time.Second, 4096, pathroots.PathRoots{})
		tool.DenyPaths = list
		for _, cmd := range commands {
			_, err := tool.Execute(context.Background(), map[string]any{"cmd": cmd})
			if err == nil || !strings.Contains(err.Error(), "denied path") {
				t.Fatalf("%s: bash %q = %v", name, cmd, err)
			}
		}
		for _, cmd := range commands {
			if _, denied := powershellCommandDenied(strings.ReplaceAll(cmd, "/", `\`), EffectiveDenyPaths(list)); !denied {
				t.Fatalf("%s: powershell %q not denied", name, cmd)
			}
		}
		if _, err := tool.Execute(context.Background(), map[string]any{"cmd": "echo agent.dbx"}); err != nil {
			t.Fatalf("%s: an unrelated command: %v", name, err)
		}
	}
}
