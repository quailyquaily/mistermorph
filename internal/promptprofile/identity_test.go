package promptprofile

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/quailyquaily/mistermorph/agent"
)

func TestAppendIdentityPromptBlock_LoadsIdentityBlock(t *testing.T) {
	workspaceDir := t.TempDir()
	identityPath := filepath.Join(workspaceDir, "IDENTITY.md")
	if err := os.WriteFile(identityPath, []byte("Name: test\nVibe: casual\n"), 0o644); err != nil {
		t.Fatalf("write identity file: %v", err)
	}

	prevWD, err := os.Getwd()
	if err != nil {
		t.Fatalf("os.Getwd() error = %v", err)
	}
	if err := os.Chdir(workspaceDir); err != nil {
		t.Fatalf("os.Chdir() error = %v", err)
	}
	t.Cleanup(func() {
		_ = os.Chdir(prevWD)
	})

	spec := agent.DefaultPromptSpec()
	AppendIdentityPromptBlock(&spec, nil)

	found := false
	for _, block := range spec.Blocks {
		if block.Title == "Identity Profile" && strings.Contains(block.Content, "Vibe: casual") {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("Identity block not found in prompt blocks: %+v", spec.Blocks)
	}
}

func TestAppendIdentityPromptBlock_MissingIdentityFileDoesNotFail(t *testing.T) {
	workspaceDir := t.TempDir()
	prevWD, err := os.Getwd()
	if err != nil {
		t.Fatalf("os.Getwd() error = %v", err)
	}
	if err := os.Chdir(workspaceDir); err != nil {
		t.Fatalf("os.Chdir() error = %v", err)
	}
	t.Cleanup(func() {
		_ = os.Chdir(prevWD)
	})

	spec := agent.DefaultPromptSpec()
	AppendIdentityPromptBlock(&spec, nil)
	for _, block := range spec.Blocks {
		if block.Title == "Identity Profile" {
			t.Fatalf("unexpected Identity block when file is missing")
		}
	}
}

func TestAppendSoulPromptBlock_LoadsSoulBlock(t *testing.T) {
	workspaceDir := t.TempDir()
	soulPath := filepath.Join(workspaceDir, "SOUL.md")
	if err := os.WriteFile(soulPath, []byte("Core Truths:\nBe helpful.\n"), 0o644); err != nil {
		t.Fatalf("write soul file: %v", err)
	}

	prevWD, err := os.Getwd()
	if err != nil {
		t.Fatalf("os.Getwd() error = %v", err)
	}
	if err := os.Chdir(workspaceDir); err != nil {
		t.Fatalf("os.Chdir() error = %v", err)
	}
	t.Cleanup(func() {
		_ = os.Chdir(prevWD)
	})

	spec := agent.DefaultPromptSpec()
	AppendSoulPromptBlock(&spec, nil)

	found := false
	for _, block := range spec.Blocks {
		if block.Title == "Soul Profile" && strings.Contains(block.Content, "Be helpful.") {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("Soul block not found in prompt blocks: %+v", spec.Blocks)
	}
}

func TestAppendSoulPromptBlock_MissingSoulFileDoesNotFail(t *testing.T) {
	workspaceDir := t.TempDir()
	prevWD, err := os.Getwd()
	if err != nil {
		t.Fatalf("os.Getwd() error = %v", err)
	}
	if err := os.Chdir(workspaceDir); err != nil {
		t.Fatalf("os.Chdir() error = %v", err)
	}
	t.Cleanup(func() {
		_ = os.Chdir(prevWD)
	})

	spec := agent.DefaultPromptSpec()
	AppendSoulPromptBlock(&spec, nil)
	for _, block := range spec.Blocks {
		if block.Title == "Soul Profile" {
			t.Fatalf("unexpected Soul block when file is missing")
		}
	}
}
