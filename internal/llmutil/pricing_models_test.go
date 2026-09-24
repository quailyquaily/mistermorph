package llmutil

import "testing"

func TestDefaultPricingIncludesSeptemberModels(t *testing.T) {
	catalog, _, err := LoadPricingCatalog(RuntimeValues{})
	if err != nil {
		t.Fatal(err)
	}
	for _, tt := range []struct {
		provider string
		model    string
	}{
		{"openai", "gpt-6-sol"},
		{"openai", "gpt-6-luna"},
		{"anthropic", "claude-opus-5-5"},
	} {
		t.Run(tt.model, func(t *testing.T) {
			for _, rule := range catalog.Chat {
				if rule.InferenceProvider == tt.provider && rule.Model == tt.model {
					return
				}
			}
			t.Fatalf("default pricing missing %s/%s", tt.provider, tt.model)
		})
	}
}
