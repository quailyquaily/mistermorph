package configsettings

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/quailyquaily/mistermorph/internal/configdefaults"
)

func consoleField(t *testing.T, path string) Field {
	t.Helper()
	for _, field := range ConsoleFields() {
		if field.Path == path {
			return field
		}
	}
	t.Fatalf("ConsoleFields() lacks %s", path)
	return Field{}
}

func TestTaskConcurrencyFieldsDefaultToEightAndRestartRuntime(t *testing.T) {
	paths := []string{"console.max_concurrency", "cron.max_concurrency"}
	for _, channel := range []string{"telegram", "slack", "line", "lark", "mixin", "discord", "wechat", "whatsapp", "bluesky", "x"} {
		paths = append(paths, channel+".max_concurrency")
	}
	view, err := View(nil, ConsoleFields())
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range paths {
		t.Run(path, func(t *testing.T) {
			field := consoleField(t, path)
			if field.Kind != KindInt || field.ApplyMode != ApplyRuntimeRestart || field.Min == nil || *field.Min != 1 {
				t.Fatalf("field = %+v, want int, runtime restart, min 1", field)
			}
			if got := view.Values[path]; got != 8 {
				t.Fatalf("default = %#v, want 8", got)
			}
			if state := view.FieldStates[path]; state.Source != SourceDefault || state.Explicit {
				t.Fatalf("state = %#v, want default", state)
			}
		})
	}
	if configdefaults.DefaultChannelMaxConcurrency != 8 || configdefaults.DefaultCronMaxConcurrency != 8 {
		t.Fatalf("defaults = channel %d cron %d, want 8 8", configdefaults.DefaultChannelMaxConcurrency, configdefaults.DefaultCronMaxConcurrency)
	}
}

func TestConsoleMaxConcurrencySettingValidation(t *testing.T) {
	fields := ConsoleFields()
	for _, value := range []string{"1", "2", "32"} {
		t.Run("accepts "+value, func(t *testing.T) {
			update := Update{Changes: map[string]json.RawMessage{"console.max_concurrency": json.RawMessage(value)}}
			out, err := Apply([]byte("console:\n  listen: 127.0.0.1:9080\n"), update, fields)
			if err != nil {
				t.Fatalf("Apply(%s) error = %v", value, err)
			}
			if !strings.Contains(string(out), "max_concurrency: "+value) || !strings.Contains(string(out), "listen: 127.0.0.1:9080") {
				t.Fatalf("Apply(%s) yaml:\n%s", value, out)
			}
			view, err := View(out, fields)
			if err != nil {
				t.Fatal(err)
			}
			if got := view.Values["console.max_concurrency"]; fmt.Sprint(got) != value || !view.FieldStates["console.max_concurrency"].Explicit {
				t.Fatalf("view value = %#v state = %#v, want explicit %s", got, view.FieldStates["console.max_concurrency"], value)
			}
			result := ResultForUpdate(update, fields, []string{"telegram"})
			if result.ApplyMode != ApplyRuntimeRestart || result.ApplyStatus != "pending" {
				t.Fatalf("apply result = %#v, want pending runtime restart", result)
			}
		})
	}
	for _, value := range []string{"0", "-1", `"eight"`, "1.5"} {
		t.Run("rejects "+value, func(t *testing.T) {
			update := Update{Changes: map[string]json.RawMessage{"console.max_concurrency": json.RawMessage(value)}}
			if _, err := Apply(nil, update, fields); err == nil {
				t.Fatalf("Apply(%s) error = nil", value)
			}
		})
	}
	out, err := Apply([]byte("console:\n  max_concurrency: 2\n"), Update{Reset: []string{"console.max_concurrency"}}, fields)
	if err != nil {
		t.Fatal(err)
	}
	view, err := View(out, fields)
	if err != nil {
		t.Fatal(err)
	}
	if got := view.Values["console.max_concurrency"]; got != 8 {
		t.Fatalf("reset value = %#v, want default 8", got)
	}
}
