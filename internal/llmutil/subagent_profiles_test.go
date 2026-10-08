package llmutil

import (
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/spf13/viper"
)

func subagentTestValues() RuntimeValues {
	return RuntimeValues{
		Provider:    "openai",
		APIKey:      "sk-default",
		Model:       "gpt-main",
		Description: "Complex analysis.",
		Profiles: map[string]ProfileConfig{
			"fast": {
				Provider:    "anthropic",
				APIKey:      "sk-fast",
				Model:       "claude-fast",
				Description: "Short summaries.",
				Abilities:   []string{"Text", " decision "},
			},
			"painter": {
				Provider:  "openai",
				APIKey:    "sk-image",
				Model:     "gpt-image",
				Abilities: []string{"image"},
			},
			"judge": {
				Provider: "typesafe",
				APIKey:   "sk-judge",
				Model:    "judge-1",
			},
			"broken": {
				Provider:          "openai",
				APIKey:            "sk-broken",
				Model:             "gpt-broken",
				RequestTimeoutRaw: "ten",
			},
		},
	}
}

func TestRuntimeValuesFromReaderReadsDescriptionAndAbilities(t *testing.T) {
	v := viper.New()
	v.SetConfigType("yaml")
	if err := v.ReadConfig(strings.NewReader(`
llm:
  provider: openai
  model: gpt-main
  description: "  Complex analysis.  "
  abilities: ["text", "image"]
  profiles:
    fast:
      provider: openai
      model: gpt-fast
      description: "Short summaries."
      abilities: ["text"]
    plain:
      provider: openai
      model: gpt-plain
`)); err != nil {
		t.Fatalf("ReadConfig() error = %v", err)
	}
	values, err := RuntimeValuesFromReader(v)
	if err != nil {
		t.Fatalf("RuntimeValuesFromReader() error = %v", err)
	}
	if values.Description != "Complex analysis." {
		t.Fatalf("Description = %q", values.Description)
	}
	if !reflect.DeepEqual(values.Abilities, []string{"text", "image"}) {
		t.Fatalf("Abilities = %#v", values.Abilities)
	}
	fast := values.Profiles["fast"]
	if fast.Description != "Short summaries." || !reflect.DeepEqual(fast.Abilities, []string{"text"}) {
		t.Fatalf("fast profile = %#v", fast)
	}

	plain, err := ResolveProfile(values, "plain")
	if err != nil {
		t.Fatalf("ResolveProfile(plain) error = %v", err)
	}
	if plain.Values.Description != "" || len(plain.Values.Abilities) != 0 {
		t.Fatalf("named profile inherited top-level fields: description=%q abilities=%#v", plain.Values.Description, plain.Values.Abilities)
	}
}

func TestNormalizeAbilities(t *testing.T) {
	cases := []struct {
		name    string
		raw     []string
		want    []string
		wantErr string
	}{
		{name: "empty", raw: nil, want: nil},
		{name: "blank entries", raw: []string{" ", ""}, want: nil},
		{name: "trim lower dedupe", raw: []string{" Text", "IMAGE", "text"}, want: []string{"text", "image"}},
		{name: "unknown", raw: []string{"text", "txt"}, wantErr: `unknown ability "txt"`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := NormalizeAbilities(tc.raw)
			if tc.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("NormalizeAbilities() error = %v, want %q", err, tc.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("NormalizeAbilities() error = %v", err)
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("NormalizeAbilities() = %#v, want %#v", got, tc.want)
			}
		})
	}
}

func TestHasAbility(t *testing.T) {
	if !HasAbility(nil, AbilityText) {
		t.Fatal("empty abilities should allow every ability")
	}
	if !HasAbility([]string{AbilityText}, AbilityText) {
		t.Fatal("text ability not found")
	}
	if HasAbility([]string{AbilityImage}, AbilityText) {
		t.Fatal("image-only profile should not have text")
	}
}

func TestResolveProfileReportsUnknownAbility(t *testing.T) {
	values := subagentTestValues()
	values.Profiles["typo"] = ProfileConfig{Provider: "openai", Model: "gpt-typo", Abilities: []string{"txt"}}
	_, err := ResolveProfile(values, "typo")
	if err == nil || !strings.Contains(err.Error(), "llm.profiles.typo.abilities") {
		t.Fatalf("ResolveProfile(typo) error = %v, want abilities error", err)
	}

	values.Abilities = []string{"txt"}
	_, err = ResolveProfile(values, RouteProfileDefault)
	if err == nil || !strings.Contains(err.Error(), "llm.abilities") {
		t.Fatalf("ResolveProfile(default) error = %v, want llm.abilities error", err)
	}
}

func TestResolveProfileNormalizesAbilities(t *testing.T) {
	profile, err := ResolveProfile(subagentTestValues(), "fast")
	if err != nil {
		t.Fatalf("ResolveProfile(fast) error = %v", err)
	}
	if !reflect.DeepEqual(profile.Values.Abilities, []string{"text", "decision"}) {
		t.Fatalf("Abilities = %#v", profile.Values.Abilities)
	}
	if profile.Values.Description != "Short summaries." {
		t.Fatalf("Description = %q", profile.Values.Description)
	}
}

func TestListSubagentProfiles(t *testing.T) {
	got, err := ListSubagentProfiles(subagentTestValues())
	if err != nil {
		t.Fatalf("ListSubagentProfiles() error = %v", err)
	}
	names := make([]string, 0, len(got))
	for _, profile := range got {
		names = append(names, profile.Name)
	}
	if !reflect.DeepEqual(names, []string{"default", "broken", "fast"}) {
		t.Fatalf("names = %#v, want default, broken, fast (painter and judge excluded)", names)
	}
	if got[0].Model != "gpt-main" || got[0].Description != "Complex analysis." || got[0].Err != nil {
		t.Fatalf("default = %#v", got[0])
	}
	if got[1].Err == nil || !strings.Contains(got[1].Err.Error(), "request_timeout") {
		t.Fatalf("broken = %#v, want request_timeout error", got[1])
	}
	if got[2].Model != "claude-fast" || got[2].Description != "Short summaries." || got[2].Err != nil {
		t.Fatalf("fast = %#v", got[2])
	}
}

func TestListSubagentProfilesExcludesBrokenNonTextProfiles(t *testing.T) {
	values := subagentTestValues()
	values.Profiles["broken_painter"] = ProfileConfig{Provider: "openai", Model: "gpt-image", Abilities: []string{"image"}, RequestTimeoutRaw: "ten"}
	values.Profiles["broken_judge"] = ProfileConfig{Provider: "typesafe", Model: "judge", RequestTimeoutRaw: "ten"}
	got, err := ListSubagentProfiles(values)
	if err != nil {
		t.Fatalf("ListSubagentProfiles() error = %v", err)
	}
	for _, profile := range got {
		if profile.Name == "broken_painter" || profile.Name == "broken_judge" {
			t.Fatalf("listed %q, which cannot run a subagent", profile.Name)
		}
	}
}

func TestListSubagentProfilesReportsRouteParseError(t *testing.T) {
	values := subagentTestValues()
	values.Routes.ParseErr = errors.New("bad routes")
	if _, err := ListSubagentProfiles(values); err == nil || !strings.Contains(err.Error(), "bad routes") {
		t.Fatalf("ListSubagentProfiles() error = %v, want route parse error", err)
	}
}

func TestResolveSubagentRoute(t *testing.T) {
	values := subagentTestValues()
	values.Profiles["backup"] = ProfileConfig{Provider: "openai", APIKey: "sk-backup", Model: "gpt-backup"}
	values.Routes.MainLoop = RoutePolicyConfig{FallbackProfiles: []string{"backup", "fast"}}

	route, err := ResolveSubagentRoute(values, "fast")
	if err != nil {
		t.Fatalf("ResolveSubagentRoute(fast) error = %v", err)
	}
	if route.Profile != "fast" || route.ClientConfig.Provider != "anthropic" || route.ClientConfig.Model != "claude-fast" {
		t.Fatalf("route = profile %q provider %q model %q", route.Profile, route.ClientConfig.Provider, route.ClientConfig.Model)
	}
	if route.Purpose != RoutePurposeMainLoop {
		t.Fatalf("route purpose = %q, want main_loop", route.Purpose)
	}
	if len(route.Fallbacks) != 1 || route.Fallbacks[0].Profile != "backup" {
		t.Fatalf("fallbacks = %#v, want main_loop fallbacks without the selected profile", route.Fallbacks)
	}

	cases := []struct {
		profile string
		wantErr string
	}{
		{profile: "missing", wantErr: `missing profile "missing"`},
		{profile: "painter", wantErr: "text ability"},
		{profile: "judge", wantErr: "typesafe"},
		{profile: "broken", wantErr: "request_timeout"},
	}
	for _, tc := range cases {
		t.Run(tc.profile, func(t *testing.T) {
			_, err := ResolveSubagentRoute(values, tc.profile)
			if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("ResolveSubagentRoute(%q) error = %v, want %q", tc.profile, err, tc.wantErr)
			}
		})
	}
}

func TestResolveSubagentRouteUsesProfileReasoningEffort(t *testing.T) {
	values := subagentTestValues()
	values.ReasoningEffortRaw = "xhigh"
	fast := values.Profiles["fast"]
	fast.ReasoningEffortRaw = "low"
	values.Profiles["fast"] = fast
	route, err := ResolveSubagentRoute(values, "fast")
	if err != nil {
		t.Fatalf("ResolveSubagentRoute(fast) error = %v", err)
	}
	if route.Values.ReasoningEffortRaw != "low" {
		t.Fatalf("reasoning effort = %q, want the profile's low", route.Values.ReasoningEffortRaw)
	}
}
