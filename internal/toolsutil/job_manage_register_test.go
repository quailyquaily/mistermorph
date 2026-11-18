package toolsutil

import (
	"path/filepath"
	"testing"

	"github.com/quailyquaily/mistermorph/internal/configdefaults"
	"github.com/quailyquaily/mistermorph/tools"
	"github.com/spf13/viper"
)

func TestTodoUpdateIsTheEarlierNameOfJobManage(t *testing.T) {
	if !IsKnownBuiltinToolName("todo_update") || !IsKnownBuiltinToolName("job_manage") {
		t.Fatal("job_manage or its earlier name is unknown")
	}
	if got := CanonicalBuiltinToolName(" Todo_Update "); got != BuiltinJobManage {
		t.Fatalf("canonical = %q", got)
	}
	refs := ExplicitBuiltinToolRefs("remind me with $todo_update", nil)
	if len(refs) != 1 || !refs[BuiltinJobManage] {
		t.Fatalf("refs = %#v, want job_manage", refs)
	}
	if refs := ExplicitBuiltinToolRefs("remind me with $todo_update", map[string]bool{BuiltinJobManage: true}); len(refs) != 0 {
		t.Fatalf("consumed job_manage still triggered by its earlier name: %#v", refs)
	}
}

func TestJobManageRegistersFromTheLegacyOrCanonicalSwitch(t *testing.T) {
	state := t.TempDir()
	tests := []struct {
		name   string
		values map[string]any
		want   bool
	}{
		{name: "default", want: true},
		{name: "legacy off", values: map[string]any{"tools.todo_update.enabled": false}, want: false},
		{name: "canonical on over legacy off", values: map[string]any{"tools.todo_update.enabled": false, "tools.job_manage.enabled": true}, want: true},
		{name: "canonical off over legacy on", values: map[string]any{"tools.todo_update.enabled": true, "tools.job_manage.enabled": false}, want: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			v := viper.New()
			configdefaults.Apply(v)
			v.Set("file_state_dir", state)
			for key, value := range tt.values {
				v.Set(key, value)
			}
			cfg := LoadJobManageRegisterConfigFromReader(v)
			if cfg.Enabled != tt.want || cfg.CronPath != filepath.Join(state, "cron.yaml") {
				t.Fatalf("config = %+v, want enabled %v", cfg, tt.want)
			}
			reg := tools.NewRegistry()
			RegisterJobManageTool(reg, cfg, nil, "")
			_, ok := reg.Get(BuiltinJobManage)
			_, legacyOK := reg.Get("todo_update")
			if ok != tt.want || legacyOK != tt.want {
				t.Fatalf("registered = %v (by earlier name %v), want %v", ok, legacyOK, tt.want)
			}
		})
	}
}
