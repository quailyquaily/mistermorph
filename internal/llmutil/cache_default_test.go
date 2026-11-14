package llmutil

import "testing"

func TestAnthropicCachesByDefault(t *testing.T) {
	for _, tc := range []struct {
		name string
		in   RuntimeValues
		want string
	}{
		{"anthropic provider, unset", RuntimeValues{Provider: "anthropic"}, "short"},
		{"anthropic inference provider, unset", RuntimeValues{InferenceProvider: " Anthropic "}, "short"},
		{"anthropic, set", RuntimeValues{Provider: "anthropic", CacheTTL: "long"}, "long"},
		{"anthropic, off", RuntimeValues{Provider: "anthropic", CacheTTL: "off"}, "off"},
		{"another provider, unset", RuntimeValues{Provider: "openai", InferenceProvider: "openai"}, ""},
	} {
		if got := withDefaultCacheTTL(tc.in).CacheTTL; got != tc.want {
			t.Errorf("%s: cache_ttl = %q, want %q", tc.name, got, tc.want)
		}
	}
	// A named profile made without a cache_ttl, as the Console makes them.
	values := RuntimeValues{Profiles: map[string]ProfileConfig{"claude": {InferenceProvider: "anthropic", Model: "claude-opus-5-5"}}}
	resolved, err := resolveProfileValues(values, "claude")
	if err != nil || resolved.CacheTTL != "short" {
		t.Fatalf("claude profile: cache_ttl = %q, err = %v", resolved.CacheTTL, err)
	}
}
