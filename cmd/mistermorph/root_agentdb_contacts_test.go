package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/quailyquaily/mistermorph/internal/agentdb"
	"github.com/quailyquaily/mistermorph/internal/toolsutil"
	"github.com/quailyquaily/mistermorph/tools"
	"github.com/spf13/viper"
)

// A contacts folder nested below the state folder (contacts.dir_name: address/people) is imported
// into the state folder's agent.db, and the runtime reads them from there: not from an agent.db
// in address/.
func TestNestedContactsFolderIsReadFromTheStateAgentDB(t *testing.T) {
	resetRootConfigForTest(t)
	ctx := context.Background()
	state := t.TempDir()
	t.Setenv("MISTER_MORPH_FILE_STATE_DIR", state)
	morph := filepath.Join(os.Getenv("HOME"), ".morph")
	if err := os.MkdirAll(morph, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(morph, "config.yaml"), []byte("contacts:\n  dir_name: address/people\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	people := filepath.Join(state, "address", "people")
	if err := os.MkdirAll(people, 0o700); err != nil {
		t.Fatal(err)
	}
	active := "# Active Contacts\n\n## Ann\n\n```yaml\ncontact_id: \"tg:123\"\nkind: \"human\"\ntg_user_id: 123\nnickname: \"Ann\"\n```\n"
	if err := os.WriteFile(filepath.Join(people, "ACTIVE.md"), []byte(active), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = agentdb.CachedStateDir(state).Close()
		_ = agentdb.CachedStateDir(filepath.Join(state, "address")).Close()
	})

	if err := loadRootConfig(nil); err != nil {
		t.Fatal(err)
	}
	cfg, err := toolsutil.StaticRegistryConfigFromReader(viper.GetViper())
	if err != nil {
		t.Fatal(err)
	}
	reg := tools.NewRegistry()
	toolsutil.RegisterStaticTools(reg, cfg, map[string]bool{toolsutil.BuiltinContactsList: true}, nil)
	tool, ok := reg.Get(toolsutil.BuiltinContactsList)
	if !ok {
		t.Fatal("contacts_list is not registered")
	}
	out, err := tool.Execute(ctx, map[string]any{"status": "all"})
	if err != nil {
		t.Fatal(err)
	}
	var listed struct {
		Total    int `json:"total"`
		Contacts []struct {
			ContactID string `json:"contact_id"`
		} `json:"contacts"`
	}
	if err := json.Unmarshal([]byte(out), &listed); err != nil {
		t.Fatalf("contacts_list output %q: %v", out, err)
	}
	if listed.Total != 1 || len(listed.Contacts) != 1 || listed.Contacts[0].ContactID != "tg:123" {
		t.Fatalf("contacts_list = %s, want tg:123 imported from address/people/ACTIVE.md", out)
	}
	if _, err := os.Stat(filepath.Join(state, "address", "agent.db")); !os.IsNotExist(err) {
		t.Fatalf("a second agent.db was opened in the contacts folder's parent: %v", err)
	}
}
