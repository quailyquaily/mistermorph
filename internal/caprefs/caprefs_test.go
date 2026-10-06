package caprefs

import (
	"reflect"
	"testing"
)

func TestNames(t *testing.T) {
	tests := []struct {
		name string
		text string
		want []string
	}{
		{name: "empty", text: "plain text", want: nil},
		{name: "single", text: "use $bash now", want: []string{"bash"}},
		{name: "dedupe case insensitive", text: "$bash and $BASH", want: []string{"bash"}},
		{name: "preserve first spelling and order", text: "$One, $two, then $ONE", want: []string{"One", "two"}},
		{name: "tool chars", text: "$image_generate $my.skill-name", want: []string{"image_generate", "my.skill-name"}},
		{name: "money ignored", text: "budget is $100", want: nil},
		{name: "env var parsed as candidate", text: "env $OPENAI_API_KEY", want: []string{"OPENAI_API_KEY"}},
		{name: "embedded word ignored", text: "foo$bar", want: nil},
		{name: "punctuation colon", text: "$bash: run tests", want: []string{"bash"}},
		{name: "colon has no special syntax", text: "$tool:bash", want: []string{"tool"}},
		{name: "sentence full stop is not part of the name", text: "then call $skill_install.", want: []string{"skill_install"}},
		{name: "trailing dots and dashes trimmed", text: "use $my.skill-name... or $bash-", want: []string{"my.skill-name", "bash"}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := Names(tc.text); !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("Names() = %#v, want %#v", got, tc.want)
			}
		})
	}
}

func TestRefsKeepRawAndTrimmedNames(t *testing.T) {
	got := Refs("see $mcp_github-work. then $mcp_github- and $MCP_GITHUB-WORK. again")
	want := []Ref{
		{Raw: "mcp_github-work.", Name: "mcp_github-work"},
		{Raw: "mcp_github-", Name: "mcp_github"},
	}
	if len(got) != len(want) {
		t.Fatalf("Refs() = %#v, want %#v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("Refs()[%d] = %#v, want %#v", i, got[i], want[i])
		}
	}
	if names := Names("$mcp_github- and $mcp_github"); len(names) != 1 || names[0] != "mcp_github" {
		t.Fatalf("Names() = %v, want the trimmed name once", names)
	}
}
