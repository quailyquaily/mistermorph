package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/quailyquaily/mistermorph/internal/personastore"
	"github.com/spf13/viper"
)

func TestInstallWritesIdentityAndSoulUnderStateDir(t *testing.T) {
	initViperDefaults()

	stateDir := t.TempDir()
	workspaceDir := t.TempDir()

	prevWD, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	if err := os.Chdir(workspaceDir); err != nil {
		t.Fatalf("chdir workspace: %v", err)
	}
	t.Cleanup(func() {
		_ = os.Chdir(prevWD)
	})

	cmd := newInstallCmd()
	cmd.SetArgs([]string{"--yes", stateDir})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("install command failed: %v", err)
	}

	assertInstalledPersona(t, stateDir)
	if _, err := os.Stat(filepath.Join(stateDir, "cron.yaml")); err != nil {
		t.Fatalf("cron.yaml should exist under state dir: %v", err)
	}
	if _, err := os.Stat(filepath.Join(stateDir, "SCRIPTS.md")); !os.IsNotExist(err) {
		t.Fatalf("SCRIPTS.md should not be created during install, err=%v", err)
	}
}

func TestInstallUsesConfiguredStateDirWhenArgMissing(t *testing.T) {
	initViperDefaults()

	stateDir := filepath.Join(t.TempDir(), "configured-state")
	workspaceDir := t.TempDir()

	prevStateDir := viper.GetString("file_state_dir")
	viper.Set("file_state_dir", stateDir)
	t.Cleanup(func() {
		if prevStateDir == "" {
			viper.Set("file_state_dir", nil)
			return
		}
		viper.Set("file_state_dir", prevStateDir)
	})

	prevWD, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	if err := os.Chdir(workspaceDir); err != nil {
		t.Fatalf("chdir workspace: %v", err)
	}
	t.Cleanup(func() {
		_ = os.Chdir(prevWD)
	})

	cmd := newInstallCmd()
	cmd.SetArgs([]string{"--yes"})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("install command failed: %v", err)
	}

	assertInstalledPersona(t, stateDir)
	if _, err := os.Stat(filepath.Join(stateDir, "cron.yaml")); err != nil {
		t.Fatalf("cron.yaml should exist under configured file_state_dir: %v", err)
	}
	if _, err := os.Stat(filepath.Join(stateDir, "SCRIPTS.md")); !os.IsNotExist(err) {
		t.Fatalf("SCRIPTS.md should not be created during install, err=%v", err)
	}
}

func TestLoadIdentityTemplate(t *testing.T) {
	body, err := loadIdentityTemplate()
	if err != nil {
		t.Fatalf("loadIdentityTemplate() error = %v", err)
	}
	if body == "" {
		t.Fatalf("expected non-empty IDENTITY template")
	}
	if !strings.Contains(body, "name_alts: []") {
		t.Fatalf("identity template seems invalid")
	}
}

func TestLoadSoulTemplate(t *testing.T) {
	body, err := loadSoulTemplate()
	if err != nil {
		t.Fatalf("loadSoulTemplate() error = %v", err)
	}
	if body == "" {
		t.Fatalf("expected non-empty SOUL template")
	}
	if !strings.Contains(body, "# soul.md - Who You Are") {
		t.Fatalf("SOUL template seems invalid")
	}
}

func TestLoadCronTemplate(t *testing.T) {
	body, err := loadCronTemplate()
	if err != nil {
		t.Fatalf("loadCronTemplate() error = %v", err)
	}
	if body == "" {
		t.Fatalf("expected non-empty cron template")
	}
	if !strings.Contains(body, "version: 1") || !strings.Contains(body, "tasks: []") {
		t.Fatalf("cron template seems invalid")
	}
}

func TestInstallCommandExposesYesFlag(t *testing.T) {
	cmd := newInstallCmd()
	flag := cmd.Flags().Lookup("yes")
	if flag == nil {
		t.Fatalf("expected --yes flag to exist")
	}
	if flag.Shorthand != "y" {
		t.Fatalf("expected --yes shorthand to be -y, got %q", flag.Shorthand)
	}
}

// assertInstalledPersona checks that install wrote the identity and the soul preset into agent.db,
// no persona or heartbeat files, and no workflows.
func assertInstalledPersona(t *testing.T, stateDir string) {
	t.Helper()
	ctx := context.Background()
	store, err := personastore.Open(ctx, stateDir)
	if err != nil {
		t.Fatalf("open persona: %v", err)
	}
	defer func() { _ = store.Close() }()
	id, ok, err := store.Identity(ctx)
	if err != nil || !ok {
		t.Fatalf("identity row: ok=%v err=%v", ok, err)
	}
	if id.UpdatedBy != personastore.ByInstall || !strings.Contains(id.Soul, "# soul.md - Who You Are") {
		t.Fatalf("identity = %+v", id)
	}
	workflows, err := store.Workflows(ctx)
	if err != nil || len(workflows) != 0 {
		t.Fatalf("workflows = %+v, %v", workflows, err)
	}
	for _, name := range []string{filepath.Join("persona", "identity.yaml"), filepath.Join("persona", "soul.md"), "HEARTBEAT.md"} {
		if _, err := os.Stat(filepath.Join(stateDir, name)); !os.IsNotExist(err) {
			t.Fatalf("%s should not be written, err=%v", name, err)
		}
	}
	entries, err := os.ReadDir(stateDir)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".install-persona-") {
			t.Fatalf("scratch folder left: %s", entry.Name())
		}
	}
}

func TestInstallKeepsAnImportedIdentity(t *testing.T) {
	initViperDefaults()
	stateDir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(stateDir, "persona"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(stateDir, "persona", "identity.yaml"), []byte("name: Kept\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(stateDir, "persona", "soul.md"), []byte("Mine.\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	cmd := newInstallCmd()
	cmd.SetArgs([]string{"--yes", stateDir})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("install command failed: %v", err)
	}
	store, err := personastore.Open(context.Background(), stateDir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = store.Close() }()
	id, _, err := store.Identity(context.Background())
	if err != nil || id.Name != "Kept" || id.Soul != "Mine." {
		t.Fatalf("identity = %+v, %v", id, err)
	}
}
