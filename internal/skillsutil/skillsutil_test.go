package skillsutil

import (
	"context"
	"os"
	"path/filepath"
	"sort"
	"testing"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/spf13/viper"
)

func TestPromptSpecWithSkills_LoadAllWildcard(t *testing.T) {
	root := t.TempDir()
	writeSkill(t, root, "alpha")
	writeSkill(t, root, "beta")

	spec, loaded, _, err := PromptSpecWithSkills(
		context.Background(),
		nil,
		agent.DefaultLogOptions(),
		"task",
		nil,
		"gpt-5.2",
		SkillsConfig{
			Roots:     []string{root},
			Mode:      "on",
			Requested: []string{"*"},
			Auto:      false,
		},
	)
	if err != nil {
		t.Fatalf("PromptSpecWithSkills: %v", err)
	}
	if len(spec.Skills) != 2 {
		t.Fatalf("expected 2 loaded skills, got %d", len(spec.Skills))
	}
	sort.Strings(loaded)
	if len(loaded) != 2 || loaded[0] != "alpha" || loaded[1] != "beta" {
		t.Fatalf("unexpected loaded skills: %#v", loaded)
	}
}

func TestPromptSpecWithSkills_LoadAllWildcardIgnoresUnknownRequests(t *testing.T) {
	root := t.TempDir()
	writeSkill(t, root, "alpha")
	writeSkill(t, root, "beta")

	_, loaded, _, err := PromptSpecWithSkills(
		context.Background(),
		nil,
		agent.DefaultLogOptions(),
		"task",
		nil,
		"gpt-5.2",
		SkillsConfig{
			Roots:     []string{root},
			Mode:      "on",
			Requested: []string{"*", "missing-skill"},
			Auto:      false,
		},
	)
	if err != nil {
		t.Fatalf("PromptSpecWithSkills with wildcard should not fail on unknown skill: %v", err)
	}
	sort.Strings(loaded)
	if len(loaded) != 2 || loaded[0] != "alpha" || loaded[1] != "beta" {
		t.Fatalf("unexpected loaded skills: %#v", loaded)
	}
}

func TestPromptSpecWithSkills_InjectsSkillMetadataOnly(t *testing.T) {
	prevSkillsDirName := viper.GetString("skills.dir_name")
	viper.Set("skills.dir_name", "skills")
	t.Cleanup(func() {
		viper.Set("skills.dir_name", prevSkillsDirName)
	})

	root := t.TempDir()
	writeSkillWithFrontmatter(t, root, "jsonbill", `---
name: jsonbill
description: Generate invoice PDF.
auth_profiles: ["jsonbill"]
requirements:
  - http_client
  - optional: file_send (chat)
---

# JSONBill

very long instructions that should not be injected
`)

	spec, loaded, _, err := PromptSpecWithSkills(
		context.Background(),
		nil,
		agent.DefaultLogOptions(),
		"task",
		nil,
		"gpt-5.2",
		SkillsConfig{
			Roots:     []string{root},
			Mode:      "on",
			Requested: []string{"jsonbill"},
			Auto:      false,
		},
	)
	if err != nil {
		t.Fatalf("PromptSpecWithSkills: %v", err)
	}
	if len(loaded) != 1 || loaded[0] != "jsonbill" {
		t.Fatalf("unexpected loaded skills: %#v", loaded)
	}
	if len(spec.Skills) < 1 {
		t.Fatalf("expected at least 1 skill, got %d", len(spec.Skills))
	}
	if len(spec.Skills) != 1 {
		t.Fatalf("expected only 1 skill metadata, got %d", len(spec.Skills))
	}
	sk := spec.Skills[0]
	if sk.Name != "jsonbill" {
		t.Fatalf("unexpected skill name: %q", sk.Name)
	}
	if sk.Description != "Generate invoice PDF." {
		t.Fatalf("unexpected skill description: %q", sk.Description)
	}
	if sk.FilePath != "file_state_dir/skills/jsonbill/SKILL.md" {
		t.Fatalf("unexpected skill file path: %q", sk.FilePath)
	}
	if len(sk.Requirements) != 2 ||
		sk.Requirements[0] != "http_client" ||
		sk.Requirements[1] != "optional: file_send (chat)" {
		t.Fatalf("unexpected skill requirements: %#v", sk.Requirements)
	}
}

func TestPromptSpecWithSkills_InjectsSkillFilePathWithConfiguredSkillsDir(t *testing.T) {
	prevSkillsDirName := viper.GetString("skills.dir_name")
	viper.Set("skills.dir_name", "my_skills")
	t.Cleanup(func() {
		viper.Set("skills.dir_name", prevSkillsDirName)
	})

	root := t.TempDir()
	writeSkillWithFrontmatter(t, root, "alpha", `---
name: alpha
description: d
---
`)

	spec, _, _, err := PromptSpecWithSkills(
		context.Background(),
		nil,
		agent.DefaultLogOptions(),
		"task",
		nil,
		"gpt-5.2",
		SkillsConfig{
			Roots:     []string{root},
			Mode:      "on",
			Requested: []string{"alpha"},
			Auto:      false,
		},
	)
	if err != nil {
		t.Fatalf("PromptSpecWithSkills: %v", err)
	}
	if len(spec.Skills) != 1 {
		t.Fatalf("expected 1 skill, got %d", len(spec.Skills))
	}
	if spec.Skills[0].FilePath != "file_state_dir/my_skills/alpha/SKILL.md" {
		t.Fatalf("unexpected skill file path: %q", spec.Skills[0].FilePath)
	}
}

func writeSkill(t *testing.T, root, id string) {
	t.Helper()
	dir := filepath.Join(root, id)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir skill dir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte("# "+id+"\n"), 0o644); err != nil {
		t.Fatalf("write SKILL.md: %v", err)
	}
}

func writeSkillWithFrontmatter(t *testing.T, root, id, content string) {
	t.Helper()
	dir := filepath.Join(root, id)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir skill dir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte(content), 0o644); err != nil {
		t.Fatalf("write SKILL.md: %v", err)
	}
}
