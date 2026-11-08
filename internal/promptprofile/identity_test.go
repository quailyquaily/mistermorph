package promptprofile

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/internal/personastore"
)

func TestApplyPersonaIdentityFromAgentDB(t *testing.T) {
	ctx := context.Background()
	stateDir := t.TempDir()
	personaDir := filepath.Join(stateDir, "persona")

	spec := agent.PromptSpec{}
	ApplyPersonaIdentity(&spec, nil, personaDir)
	if spec.Identity != "" {
		t.Fatalf("no identity row, but the prompt has %q", spec.Identity)
	}

	store, err := personastore.Open(ctx, stateDir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = store.Close() }()
	if _, err := store.SaveIdentity(ctx, personastore.Identity{Name: "Momo", Creature: "cat",
		Extra: personastore.Extra{{Key: "home", Value: "attic"}}}, personastore.ByCLI); err != nil {
		t.Fatal(err)
	}
	spec = agent.PromptSpec{}
	ApplyPersonaIdentity(&spec, nil, personaDir)
	if !strings.Contains(spec.Identity, "[identity.yaml]\nname: Momo\nname_alts: []\ncreature: cat\n") ||
		!strings.Contains(spec.Identity, "home: attic") {
		t.Fatalf("identity block = %q", spec.Identity)
	}
	if strings.Contains(spec.Identity, "[soul.md]") {
		t.Fatalf("an empty soul is in the prompt: %q", spec.Identity)
	}

	soul := "## Core Truths\n\nBe kind."
	if _, err := store.PatchIdentity(ctx, personastore.IdentityPatch{Soul: &soul}, personastore.ByCLI); err != nil {
		t.Fatal(err)
	}
	spec = agent.PromptSpec{}
	ApplyPersonaIdentity(&spec, nil, personaDir)
	if !strings.Contains(spec.Identity, "[soul.md]\n## Core Truths\n\nBe kind.") {
		t.Fatalf("soul block = %q", spec.Identity)
	}
}

func TestApplyPersonaIdentityLeavesADraftSoulOut(t *testing.T) {
	stateDir := t.TempDir()
	personaDir := filepath.Join(stateDir, "persona")
	if err := os.MkdirAll(personaDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(personaDir, "soul.md"), []byte("---\nstatus: draft\n---\nNot yet.\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	spec := agent.PromptSpec{}
	ApplyPersonaIdentity(&spec, nil, personaDir)
	if strings.Contains(spec.Identity, "Not yet") || strings.Contains(spec.Identity, "[soul.md]") {
		t.Fatalf("draft soul in the prompt: %q", spec.Identity)
	}
}
