package llmutil

import (
	"github.com/quailyquaily/mistermorph/internal/llmconfig"
	"github.com/quailyquaily/mistermorph/llm"
	"github.com/spf13/viper"
	"testing"
)

func TestDecisionTypeSafeProfile(t *testing.T) {
	values := RuntimeValues{Provider: "openai", Model: "chat", APIKey: "chat-key", Profiles: map[string]ProfileConfig{"judge": {Provider: "typesafe", Model: "jev-test", APIKey: "judge-key"}}}
	values.Routes.Decision = RoutePolicyConfig{Profile: "judge"}
	route, err := ResolveRoute(values, "decision")
	if err != nil {
		t.Fatal(err)
	}
	if route.ClientConfig.Provider != "typesafe" || route.ClientConfig.APIKey != "judge-key" {
		t.Fatalf("route=%+v", route)
	}
	client, err := BuildRouteClient(route, nil, ClientFromConfigWithValues, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer closeDistinctClients(client)
	route.Purpose = "main_loop"
	_, err = BuildRouteClient(route, nil, func(llmconfig.ClientConfig, RuntimeValues) (llm.Client, error) {
		t.Fatal("must reject before building")
		return nil, nil
	}, nil, nil)
	if err == nil {
		t.Fatal("Evaluate-only provider accepted for Chat")
	}
}

func TestDecisionRoute(t *testing.T) {
	for _, tt := range []struct {
		name    string
		routes  map[string]any
		want    string
		wantErr bool
	}{
		{"default", nil, "default", false},
		{"legacy", map[string]any{"addressing": "fast"}, "fast", false},
		{"decision", map[string]any{"decision": "fast"}, "fast", false},
		{"explicit default wins", map[string]any{"decision": "default", "addressing": "fast"}, "default", false},
		{"empty", map[string]any{"decision": map[string]any{}}, "default", false},
		{"missing profile", map[string]any{"decision": "missing"}, "", true},
		{"invalid", map[string]any{"decision": 42}, "", true},
	} {
		t.Run(tt.name, func(t *testing.T) {
			v := viper.New()
			v.Set("llm.provider", "openai")
			v.Set("llm.model", "default-model")
			v.Set("llm.api_key", "default-key")
			v.Set("llm.profiles", map[string]any{"fast": map[string]any{"provider": "openai", "model": "fast-model", "api_key": "fast-key"}, "decision": map[string]any{"provider": "openai", "model": "unused"}})
			v.Set("llm.routes", tt.routes)
			values, err := RuntimeValuesFromReader(v)
			if err != nil {
				if tt.wantErr {
					return
				}
				t.Fatal(err)
			}
			route, err := ResolveRoute(values, "decision")
			if tt.wantErr {
				if err == nil {
					t.Fatal("expected error")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if route.Profile != tt.want {
				t.Fatalf("profile=%s want %s", route.Profile, tt.want)
			}
			if tt.want == "fast" && route.ClientConfig.APIKey != "fast-key" {
				t.Fatal("profile borrowed default credentials")
			}
			alias, err := ResolveRoute(values, "addressing")
			if err != nil || alias.Profile != route.Profile {
				t.Fatalf("alias=%+v err=%v", alias, err)
			}
		})
	}
}
