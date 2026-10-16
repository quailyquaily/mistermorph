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

func decisionModelTestValues(t *testing.T, judge map[string]any) RuntimeValues {
	t.Helper()
	v := viper.New()
	v.Set("llm.provider", "openai")
	v.Set("llm.model", "chat")
	v.Set("llm.api_key", "chat-key")
	v.Set("llm.profiles", map[string]any{"judge": judge, "fast": map[string]any{"provider": "openai", "model": "fast", "api_key": "fast-key"}})
	v.Set("llm.routes", map[string]any{"decision": "judge"})
	values, err := RuntimeValuesFromReader(v)
	if err != nil {
		t.Fatal(err)
	}
	return values
}

func TestDecisionModelProfile(t *testing.T) {
	values := decisionModelTestValues(t, map[string]any{"inference_provider": "openai", "model": "gpt-6-luna", "api_key": "judge-key", "decision_model": true})

	profile, err := ResolveProfile(values, "judge")
	if err != nil {
		t.Fatal(err)
	}
	if !profile.ClientConfig.EvaluateOnly || !profile.Values.DecisionModel {
		t.Fatalf("judge = %+v, want an Evaluate-only decision model", profile.ClientConfig)
	}
	if fast, err := ResolveProfile(values, "fast"); err != nil || fast.ClientConfig.EvaluateOnly {
		t.Fatalf("fast = %+v, %v; want a chat profile", fast.ClientConfig, err)
	}

	route, err := ResolveRoute(values, RoutePurposeDecision)
	if err != nil {
		t.Fatal(err)
	}
	var built []RuntimeValues
	build := func(_ llmconfig.ClientConfig, values RuntimeValues) (llm.Client, error) {
		built = append(built, values)
		return nil, nil
	}
	if _, err := BuildRouteClient(route, nil, build, nil, nil); err != nil {
		t.Fatalf("decision route: %v", err)
	}
	if len(built) != 1 || !built[0].DecisionModel {
		t.Fatalf("built = %+v, want the decision model's values", built)
	}

	main, err := ResolveRouteWithProfileOverride(values, RoutePurposeMainLoop, "judge")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := BuildRouteClient(main, nil, build, nil, nil); err == nil {
		t.Fatal("main_loop accepted a decision model")
	}
	if err := CheckSubagentProfile(profile); err == nil {
		t.Fatal("a decision model was accepted for subtasks")
	}
	subagents, err := ListSubagentProfiles(values)
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range subagents {
		if item.Name == "judge" {
			t.Fatal("ListSubagentProfiles listed the decision model")
		}
	}
}

func TestDecisionModelNeedsANativeDecisionAPI(t *testing.T) {
	for _, tc := range []struct {
		provider string
		ok       bool
	}{
		{"openai", true},
		{"openai_chat_compatible", true},
		{"openai_response_compatible", true},
		{"anthropic", false},
		{"openrouter", false},
	} {
		t.Run(tc.provider, func(t *testing.T) {
			judge := map[string]any{"inference_provider": tc.provider, "model": "m", "api_key": "k", "decision_model": true}
			if tc.provider != "openai" && tc.provider != "anthropic" && tc.provider != "openrouter" {
				judge["endpoint"] = "https://gateway.example.com/v1"
			}
			_, err := ResolveProfile(decisionModelTestValues(t, judge), "judge")
			if (err == nil) != tc.ok {
				t.Fatalf("ResolveProfile() error = %v, want ok=%v", err, tc.ok)
			}
		})
	}
}
