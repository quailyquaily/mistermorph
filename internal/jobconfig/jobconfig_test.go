package jobconfig

import (
	"testing"

	"github.com/spf13/viper"
)

func TestToolEnabledPrefersJobManageAndFallsBackToTodoUpdate(t *testing.T) {
	tests := []struct {
		name   string
		values map[string]any
		want   bool
	}{
		{name: "default on", values: map[string]any{}, want: true},
		{name: "legacy off", values: map[string]any{LegacyEnabledKey: false}, want: false},
		{name: "legacy on", values: map[string]any{LegacyEnabledKey: true}, want: true},
		{name: "canonical off", values: map[string]any{EnabledKey: false}, want: false},
		{name: "canonical off beats legacy on", values: map[string]any{EnabledKey: false, LegacyEnabledKey: true}, want: false},
		{name: "canonical on beats legacy off", values: map[string]any{EnabledKey: true, LegacyEnabledKey: false}, want: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			v := viper.New()
			// The defaults as configdefaults sets them: only the legacy switch has one.
			v.SetDefault(LegacyEnabledKey, true)
			for key, value := range tt.values {
				v.Set(key, value)
			}
			if got := ToolEnabled(v); got != tt.want {
				t.Fatalf("ToolEnabled = %v, want %v", got, tt.want)
			}
		})
	}
	if ToolEnabled(nil) {
		t.Fatal("nil reader enabled the tool")
	}
}

func TestCanonicalToolName(t *testing.T) {
	for in, want := range map[string]string{"todo_update": "job_manage", " TODO_UPDATE ": "job_manage", "job_manage": "job_manage", "todo_list": "todo_list"} {
		if got := CanonicalToolName(in); got != want {
			t.Fatalf("CanonicalToolName(%q) = %q, want %q", in, got, want)
		}
	}
}
