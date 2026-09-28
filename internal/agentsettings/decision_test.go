package agentsettings

import (
	"os"
	"path/filepath"
	"testing"
)

func TestConfigAcceptsEvaluateOnlyProfile(t *testing.T) {
	data := []byte(`llm:
  provider: openai
  model: chat-model
  api_key: chat-key
  profiles:
    judge:
      provider: typesafe
      model: jev-test
      api_key: judge-key
  routes:
    decision: judge
`)
	_, err := validateAgentConfigDocument(data, LLMSettingsPayload{}, nil)
	if err != nil {
		t.Fatal(err)
	}
}

func TestConfigRejectsMissingDecisionProfile(t *testing.T) {
	_, err := validateAgentConfigDocument([]byte("llm:\n  provider: openai\n  model: chat-model\n  api_key: chat-key\n  routes:\n    decision: missing\n"), LLMSettingsPayload{}, nil)
	if err == nil {
		t.Fatal("missing decision profile accepted")
	}
}

func TestConfigSkillsLoadChecksOnlyNewEntries(t *testing.T) {
	stateDir := t.TempDir()
	skillDir := filepath.Join(stateDir, "skills", "alpha")
	if err := os.MkdirAll(skillDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(skillDir, "SKILL.md"), []byte("---\nname: alpha\n---\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name     string
		load     string
		previous []string
		wantErr  bool
	}{
		{name: "a removed skill doesn't block other saves", load: "[gone]", previous: []string{"gone"}},
		{name: "a removed skill doesn't block adding one", load: "[gone, alpha]", previous: []string{"gone"}},
		{name: "a new unknown skill is rejected", load: "[alpha, missing]", previous: []string{"alpha"}, wantErr: true},
		{name: "no previous config", load: "[missing]", wantErr: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			data := []byte("file_state_dir: " + stateDir + "\nllm:\n  provider: openai\n  model: chat-model\n  api_key: chat-key\n" +
				"skills:\n  enabled: true\n  load: " + tc.load + "\n")
			_, err := validateAgentConfigDocument(data, LLMSettingsPayload{}, tc.previous)
			if (err != nil) != tc.wantErr {
				t.Fatalf("err = %v, wantErr %v", err, tc.wantErr)
			}
		})
	}
}
