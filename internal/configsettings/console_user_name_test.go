package configsettings

import (
	"encoding/json"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

func TestConsoleUserNameField(t *testing.T) {
	field := consoleField(t, "console.user_name")
	if field.Kind != KindString || field.ApplyMode != ApplyImmediate || field.Sensitive || field.Normalize == nil {
		t.Fatalf("field = %+v, want a plain string applied at once with a check", field)
	}
	view, err := View(nil, ConsoleFields())
	if err != nil {
		t.Fatal(err)
	}
	if got := view.Values["console.user_name"]; got != "" {
		t.Fatalf("default = %#v, want no name", got)
	}
	if state := view.FieldStates["console.user_name"]; state.Source != SourceDefault || state.Explicit || !state.Editable {
		t.Fatalf("state = %#v, want an editable default", state)
	}
}

func TestConsoleUserNameIsNormalizedOnEverySave(t *testing.T) {
	fields := ConsoleFields()
	const prior = "console:\n  listen: 127.0.0.1:9080\n  user_name: Prior\n"
	save := func(name string) ([]byte, error) {
		raw, _ := json.Marshal(name)
		return Apply([]byte(prior), Update{Changes: map[string]json.RawMessage{"console.user_name": raw}}, fields)
	}
	for in, want := range map[string]string{
		"Lyra":                  "Lyra",
		"  Ada  Lovelace\t\n":   "Ada  Lovelace",
		" 小明 🙂 ":                "小明 🙂",
		"<b>x</b>":              "<b>x</b>",
		strings.Repeat("é", 80): strings.Repeat("é", 80),
	} {
		out, err := save(in)
		if err != nil {
			t.Fatalf("Apply(%q) error = %v", in, err)
		}
		var doc struct {
			Console struct {
				Listen   string `yaml:"listen"`
				UserName string `yaml:"user_name"`
			} `yaml:"console"`
		}
		if err := yaml.Unmarshal(out, &doc); err != nil {
			t.Fatal(err)
		}
		if doc.Console.UserName != want || doc.Console.Listen != "127.0.0.1:9080" {
			t.Fatalf("Apply(%q) saved %+v, want %q beside the other keys", in, doc.Console, want)
		}
		view, err := View(out, fields)
		if err != nil || view.Values["console.user_name"] != want {
			t.Fatalf("View after Apply(%q) = %#v, %v", in, view.Values["console.user_name"], err)
		}
	}
	for in, want := range map[string]string{
		"":                      "must not be empty",
		" \t ":                  "must not be empty",
		"a\nb":                  "one line",
		"a\x00b":                "control",
		strings.Repeat("é", 81): "at most 80",
	} {
		if out, err := save(in); err == nil || !strings.Contains(err.Error(), "console.user_name: ") || !strings.Contains(err.Error(), want) {
			t.Fatalf("Apply(%q) = %q, %v; want an error with %q", in, out, err, want)
		}
	}
	// Reset removes the saved name: the default is shown again.
	out, err := Apply([]byte(prior), Update{Reset: []string{"console.user_name"}}, fields)
	if err != nil || strings.Contains(string(out), "user_name") || !strings.Contains(string(out), "listen: 127.0.0.1:9080") {
		t.Fatalf("reset = %q, %v", out, err)
	}
}
