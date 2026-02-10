package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

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
	cmd.SetArgs([]string{stateDir})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("install command failed: %v", err)
	}

	if _, err := os.Stat(filepath.Join(stateDir, "IDENTITY.md")); err != nil {
		t.Fatalf("IDENTITY.md should exist under state dir: %v", err)
	}
	if _, err := os.Stat(filepath.Join(stateDir, "SOUL.md")); err != nil {
		t.Fatalf("SOUL.md should exist under state dir: %v", err)
	}
	if _, err := os.Stat(filepath.Join(workspaceDir, "IDENTITY.md")); !os.IsNotExist(err) {
		t.Fatalf("IDENTITY.md should not be created in workspace root, err=%v", err)
	}
	if _, err := os.Stat(filepath.Join(workspaceDir, "SOUL.md")); !os.IsNotExist(err) {
		t.Fatalf("SOUL.md should not be created in workspace root, err=%v", err)
	}
}

func TestEnsureInstallMAEPIdentity_ReusesExistingIdentity(t *testing.T) {
	initViperDefaults()
	originalDirName := viper.GetString("maep.dir_name")
	viper.Set("maep.dir_name", "maep")
	t.Cleanup(func() {
		if originalDirName == "" {
			viper.Set("maep.dir_name", nil)
			return
		}
		viper.Set("maep.dir_name", originalDirName)
	})

	root := t.TempDir()

	first, created, err := ensureInstallMAEPIdentity(root)
	if err != nil {
		t.Fatalf("ensureInstallMAEPIdentity() first call error = %v", err)
	}
	if !created {
		t.Fatalf("ensureInstallMAEPIdentity() first call expected created=true")
	}

	second, created, err := ensureInstallMAEPIdentity(root)
	if err != nil {
		t.Fatalf("ensureInstallMAEPIdentity() second call error = %v", err)
	}
	if created {
		t.Fatalf("ensureInstallMAEPIdentity() second call expected created=false")
	}
	if second.PeerID != first.PeerID {
		t.Fatalf("peer_id changed after second init: got %s want %s", second.PeerID, first.PeerID)
	}
	if second.NodeUUID != first.NodeUUID {
		t.Fatalf("node_uuid changed after second init: got %s want %s", second.NodeUUID, first.NodeUUID)
	}
	if second.NodeID != first.NodeID {
		t.Fatalf("node_id changed after second init: got %s want %s", second.NodeID, first.NodeID)
	}

	identityPath := filepath.Join(root, "maep", "identity.json")
	if _, err := os.Stat(identityPath); err != nil {
		t.Fatalf("identity file missing at %s: %v", identityPath, err)
	}
}

func TestEnsureInstallMAEPIdentity_RespectsMaepDirName(t *testing.T) {
	initViperDefaults()
	originalDirName := viper.GetString("maep.dir_name")
	viper.Set("maep.dir_name", "custom-maep")
	t.Cleanup(func() {
		if originalDirName == "" {
			viper.Set("maep.dir_name", nil)
			return
		}
		viper.Set("maep.dir_name", originalDirName)
	})

	root := t.TempDir()
	if _, _, err := ensureInstallMAEPIdentity(root); err != nil {
		t.Fatalf("ensureInstallMAEPIdentity() error = %v", err)
	}

	identityPath := filepath.Join(root, "custom-maep", "identity.json")
	if _, err := os.Stat(identityPath); err != nil {
		t.Fatalf("identity file missing at %s: %v", identityPath, err)
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
	if !strings.Contains(body, "# IDENTITY.md - Who Am I?") {
		t.Fatalf("IDENTITY template seems invalid")
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
	if !strings.Contains(body, "# SOUL.md - Who You Are") {
		t.Fatalf("SOUL template seems invalid")
	}
}

func TestLoadToolsTemplate(t *testing.T) {
	body, err := loadToolsTemplate()
	if err != nil {
		t.Fatalf("loadToolsTemplate() error = %v", err)
	}
	if body == "" {
		t.Fatalf("expected non-empty TOOLS template")
	}
	if !strings.Contains(body, "# TOOLS.md - Local Tool Notes") {
		t.Fatalf("TOOLS template seems invalid")
	}
}

func TestLoadTodoWIPTemplate(t *testing.T) {
	body, err := loadTodoWIPTemplate()
	if err != nil {
		t.Fatalf("loadTodoWIPTemplate() error = %v", err)
	}
	if body == "" {
		t.Fatalf("expected non-empty TODO.WIP template")
	}
	if !strings.Contains(body, "# TODO Work In Progress (WIP)") {
		t.Fatalf("TODO.WIP template seems invalid")
	}
}

func TestLoadTodoDoneTemplate(t *testing.T) {
	body, err := loadTodoDoneTemplate()
	if err != nil {
		t.Fatalf("loadTodoDoneTemplate() error = %v", err)
	}
	if body == "" {
		t.Fatalf("expected non-empty TODO.DONE template")
	}
	if !strings.Contains(body, "# TODO Done") {
		t.Fatalf("TODO.DONE template seems invalid")
	}
}

func TestLoadContactsActiveTemplate(t *testing.T) {
	body, err := loadContactsActiveTemplate()
	if err != nil {
		t.Fatalf("loadContactsActiveTemplate() error = %v", err)
	}
	if body == "" {
		t.Fatalf("expected non-empty contacts ACTIVE template")
	}
	if !strings.Contains(body, "# Active Contacts") {
		t.Fatalf("contacts ACTIVE template seems invalid")
	}
}

func TestLoadContactsInactiveTemplate(t *testing.T) {
	body, err := loadContactsInactiveTemplate()
	if err != nil {
		t.Fatalf("loadContactsInactiveTemplate() error = %v", err)
	}
	if body == "" {
		t.Fatalf("expected non-empty contacts INACTIVE template")
	}
	if !strings.Contains(body, "# Inactive Contacts") {
		t.Fatalf("contacts INACTIVE template seems invalid")
	}
}
