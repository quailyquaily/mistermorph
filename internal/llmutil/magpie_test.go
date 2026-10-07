package llmutil

import "testing"

func TestResolveRouteMagpie(t *testing.T) {
	for _, tt := range []struct {
		name, endpoint, apiKey, wantEndpoint, wantKey string
	}{
		{"defaults", "", "", "http://127.0.0.1:3425/v1", "magpie"},
		{"whitespace", "  ", "  ", "http://127.0.0.1:3425/v1", "magpie"},
		{"custom endpoint", "https://magpie.example.test/v1", "", "https://magpie.example.test/v1", "magpie"},
		{"custom key", "", "custom-key", "http://127.0.0.1:3425/v1", "custom-key"},
		{"custom both", "https://magpie.example.test/v1", "custom-key", "https://magpie.example.test/v1", "custom-key"},
	} {
		for _, named := range []bool{false, true} {
			name := tt.name + "/default"
			if named {
				name = tt.name + "/named"
			}
			t.Run(name, func(t *testing.T) {
				values := RuntimeValues{InferenceProvider: "magpie", Endpoint: tt.endpoint, APIKey: tt.apiKey, Model: "test-model"}
				if named {
					values = RuntimeValues{
						InferenceProvider: "openai", Endpoint: "https://api.openai.com", APIKey: "unrelated-key", Model: "unrelated-model",
						Profiles: map[string]ProfileConfig{"local": {InferenceProvider: "magpie", Endpoint: tt.endpoint, APIKey: tt.apiKey, Model: "test-model"}},
						Routes:   RoutesConfig{PurposeRoutes: PurposeRoutes{MainLoop: RoutePolicyConfig{Profile: "local"}}},
					}
				}
				route, err := ResolveRoute(values, RoutePurposeMainLoop)
				if err != nil {
					t.Fatal(err)
				}
				cfg := route.ClientConfig
				if route.Values.InferenceProvider != "magpie" || cfg.Provider != "openai_resp" || cfg.Endpoint != tt.wantEndpoint || cfg.APIKey != tt.wantKey || cfg.Model != "test-model" {
					t.Fatalf("unexpected Magpie route: provider=%q config=%+v", route.Values.InferenceProvider, cfg)
				}
			})
		}
	}
}
