package outputfmt

import (
	"testing"

	"github.com/quailyquaily/mistermorph/agent"
)

func TestFormatFinalOutput(t *testing.T) {
	var nilMap map[string]any
	var nilSlice []string
	for _, tc := range []struct {
		name  string
		final *agent.Final
		want  string
	}{
		{"nil final", nil, ""},
		{"missing output", &agent.Final{}, ""},
		{"nil map", &agent.Final{Output: nilMap}, ""},
		{"nil slice", &agent.Final{Output: nilSlice}, ""},
		{"empty string", &agent.Final{Output: " \n"}, ""},
		{"text", &agent.Final{Output: " answer "}, "answer"},
		{"quoted text", &agent.Final{Output: `"answer"`}, "answer"},
		{"false", &agent.Final{Output: false}, "false"},
		{"zero", &agent.Final{Output: 0}, "0"},
		{"array", &agent.Final{Output: []string{}}, "[]"},
		{"object", &agent.Final{Output: map[string]any{"value": nil}}, "{\n  \"value\": null\n}"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := FormatFinalOutput(tc.final); got != tc.want {
				t.Fatalf("FormatFinalOutput() = %q, want %q", got, tc.want)
			}
		})
	}
}
