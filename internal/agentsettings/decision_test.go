package agentsettings

import (
	"context"
	"os"
	"path/filepath"
	"strings"
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

func TestConfigChecksDecisionModelProfiles(t *testing.T) {
	cases := []struct {
		name    string
		judge   string
		route   string
		wantErr bool
	}{
		{name: "OpenAI decision model on the decision route", judge: "inference_provider: openai", route: "decision: judge"},
		{name: "provider without a native decision API", judge: "inference_provider: anthropic", route: "decision: judge", wantErr: true},
		{name: "decision model on the main loop", judge: "inference_provider: openai", route: "main_loop: judge", wantErr: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			data := []byte("llm:\n  provider: openai\n  model: chat-model\n  api_key: chat-key\n  profiles:\n    judge:\n      " + tc.judge +
				"\n      model: gpt-6-luna\n      api_key: judge-key\n      decision_model: true\n  routes:\n    " + tc.route + "\n")
			_, err := validateAgentConfigDocument(data, LLMSettingsPayload{}, nil)
			if (err != nil) != tc.wantErr {
				t.Fatalf("err = %v, wantErr %v", err, tc.wantErr)
			}
		})
	}
}

func TestFileOwnerSavesDecisionModel(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "config.yaml")
	config := "llm:\n  provider: openai\n  model: gpt-main\n  api_key: main-key\n  profiles:\n    judge:\n      inference_provider: openai\n      model: gpt-6-luna\n      api_key: judge-key\n"
	if err := os.WriteFile(configPath, []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}
	owner := NewFileOwner(FileOwnerOptions{ConfigPath: configPath, Reader: readFileOwnerTestConfig(t, configPath)})
	save := func(on bool) string {
		t.Helper()
		view, err := owner.View(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		profile := view.LLM.Profiles[0]
		profile.DecisionModel = on
		update := LLMProfileUpdate{OriginalName: "judge", LLMProfileSettingsPayload: profile}
		if _, err := owner.Update(context.Background(), AgentSettingsUpdate{LLM: LLMSettingsUpdate{Profile: &update}}); err != nil {
			t.Fatalf("Update(decision_model=%v) error = %v", on, err)
		}
		owner = NewFileOwner(FileOwnerOptions{ConfigPath: configPath, Reader: readFileOwnerTestConfig(t, configPath)})
		raw, err := os.ReadFile(configPath)
		if err != nil {
			t.Fatal(err)
		}
		return string(raw)
	}

	if text := save(true); !strings.Contains(text, "decision_model: true") {
		t.Fatalf("config after turning decision_model on:\n%s", text)
	}
	view, err := owner.View(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !view.LLM.Profiles[0].DecisionModel || view.LLM.DecisionModel {
		t.Fatalf("view: profile decision_model = %v, default = %v; want only the profile set", view.LLM.Profiles[0].DecisionModel, view.LLM.DecisionModel)
	}
	if text := save(false); strings.Contains(text, "decision_model") {
		t.Fatalf("config after turning decision_model off:\n%s", text)
	}
}

func TestConnectionTestKeepsDecisionModel(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "config.yaml")
	config := "llm:\n  provider: openai\n  model: gpt-main\n  api_key: main-key\n  profiles:\n    judge:\n      inference_provider: openai\n      model: gpt-6-luna\n      api_key: judge-key\n      decision_model: true\n"
	if err := os.WriteFile(configPath, []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}
	reader := readFileOwnerTestConfig(t, configPath)
	target := "judge"
	snapshot := LLMSettingsPayload{Profiles: []LLMProfileSettingsPayload{{Name: "judge", LLMConfigFieldsPayload: LLMConfigFieldsPayload{
		InferenceProvider: "openai", Model: "gpt-6-luna", APIKey: "judge-key", DecisionModel: true,
	}}}}
	settings, err := resolveAgentSettingsTestLLMFromReader(reader, agentSettingsTestRequest{LLM: snapshot, TargetProfile: &target})
	if err != nil {
		t.Fatal(err)
	}
	values, err := ResolveConnectionTestValues(reader, settings, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	if !values.DecisionModel {
		t.Fatal("the connection test lost decision_model, so it would run the Chat benchmarks")
	}
}
