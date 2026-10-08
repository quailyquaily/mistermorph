package llmselect

import (
	"reflect"
	"testing"

	"github.com/quailyquaily/mistermorph/internal/llmutil"
)

func TestListProfilesKeepsDescriptionAndAbilities(t *testing.T) {
	values := llmutil.RuntimeValues{
		Provider:    "openai",
		Model:       "gpt-main",
		Description: "Complex analysis.",
		Profiles: map[string]llmutil.ProfileConfig{
			"painter": {Provider: "openai", Model: "gpt-image", Description: "Images.", Abilities: []string{"Image"}},
		},
	}
	profiles, err := ListProfiles(values)
	if err != nil {
		t.Fatalf("ListProfiles() error = %v", err)
	}
	if len(profiles) != 2 {
		t.Fatalf("len(profiles) = %d, want 2", len(profiles))
	}
	if profiles[0].Description != "Complex analysis." || len(profiles[0].Abilities) != 0 {
		t.Fatalf("default = %#v", profiles[0])
	}
	if profiles[1].Description != "Images." || !reflect.DeepEqual(profiles[1].Abilities, []string{"image"}) {
		t.Fatalf("painter = %#v", profiles[1])
	}
}
