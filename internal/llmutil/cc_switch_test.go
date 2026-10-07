package llmutil

import "testing"

func TestResolveRouteCCSwitch(t *testing.T) {
	for _, tt := range []struct {
		name, endpoint, apiKey, wantEndpoint, wantKey string
	}{
		{"defaults", "", "", "http://127.0.0.1:15721/v1", "PROXY_MANAGED"},
		{"whitespace", "  ", "  ", "http://127.0.0.1:15721/v1", "PROXY_MANAGED"},
		{"custom endpoint", "https://cc-switch.example.test/v1", "", "https://cc-switch.example.test/v1", "PROXY_MANAGED"},
		{"custom key", "", "custom-key", "http://127.0.0.1:15721/v1", "custom-key"},
		{"custom both", "https://cc-switch.example.test/v1", "custom-key", "https://cc-switch.example.test/v1", "custom-key"},
	} {
		for _, named := range []bool{false, true} {
			name := tt.name + "/default"
			if named {
				name = tt.name + "/named"
			}
			t.Run(name, func(t *testing.T) {
				values := RuntimeValues{InferenceProvider: "cc_switch", Endpoint: tt.endpoint, APIKey: tt.apiKey, Model: "test-model"}
				if named {
					values = RuntimeValues{
						InferenceProvider: "openai", Endpoint: "https://api.openai.com", APIKey: "unrelated-key", Model: "unrelated-model",
						Profiles: map[string]ProfileConfig{"local": {InferenceProvider: "cc_switch", Endpoint: tt.endpoint, APIKey: tt.apiKey, Model: "test-model"}},
						Routes:   RoutesConfig{PurposeRoutes: PurposeRoutes{MainLoop: RoutePolicyConfig{Profile: "local"}}},
					}
				}
				route, err := ResolveRoute(values, RoutePurposeMainLoop)
				if err != nil {
					t.Fatal(err)
				}
				cfg := route.ClientConfig
				if route.Values.InferenceProvider != "cc_switch" || cfg.Provider != "openai_resp" || cfg.Endpoint != tt.wantEndpoint || cfg.APIKey != tt.wantKey || cfg.Model != "test-model" {
					t.Fatalf("unexpected CCSwitch route: provider=%q config=%+v", route.Values.InferenceProvider, cfg)
				}
			})
		}
	}
}
