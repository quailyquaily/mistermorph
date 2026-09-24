package agentsettings

import "testing"

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
	_, err := validateAgentConfigDocument(data, LLMSettingsPayload{})
	if err != nil {
		t.Fatal(err)
	}
}

func TestConfigRejectsMissingDecisionProfile(t *testing.T) {
	_, err := validateAgentConfigDocument([]byte("llm:\n  provider: openai\n  model: chat-model\n  api_key: chat-key\n  routes:\n    decision: missing\n"), LLMSettingsPayload{})
	if err == nil {
		t.Fatal("missing decision profile accepted")
	}
}
