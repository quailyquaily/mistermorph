package toolsutil

import (
	"testing"

	"github.com/quailyquaily/mistermorph/tools"
)

func TestRegisterStaticToolsConfigTools(t *testing.T) {
	on := StaticConfigToolsConfig{GetEnabled: true, SetEnabled: true, ToolSearch: true, ConfigPath: t.TempDir() + "/config.yaml"}
	cases := []struct {
		name               string
		config             StaticConfigToolsConfig
		awareness          bool
		selected, triggers map[string]bool
		wantGet, wantSet   bool
	}{
		{name: "ordinary run", config: on, wantGet: true, wantSet: true},
		{name: "awareness", config: on, awareness: true, wantGet: true},
		{name: "tool search off", config: StaticConfigToolsConfig{GetEnabled: true, SetEnabled: true, ConfigPath: on.ConfigPath}},
		{name: "no config path", config: StaticConfigToolsConfig{GetEnabled: true, SetEnabled: true, ToolSearch: true}},
		{name: "config_set off", config: StaticConfigToolsConfig{GetEnabled: true, ToolSearch: true, ConfigPath: on.ConfigPath}, wantGet: true},
		{name: "both off", config: StaticConfigToolsConfig{ToolSearch: true, ConfigPath: on.ConfigPath}},
		{name: "triggered registration", config: on, triggers: map[string]bool{BuiltinConfigSet: true, BuiltinConfigGet: true}},
		{name: "embedder selected only config_get", config: on, selected: map[string]bool{BuiltinConfigGet: true}, wantGet: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			reg := tools.NewRegistry()
			cfg := StaticRegistryConfig{Config: tc.config}
			cfg.Common.Awareness = tc.awareness
			RegisterStaticTools(reg, cfg, tc.selected, tc.triggers)
			get, hasGet := reg.Get(BuiltinConfigGet)
			set, hasSet := reg.Get(BuiltinConfigSet)
			if hasGet != tc.wantGet || hasSet != tc.wantSet {
				t.Fatalf("config_get %v, config_set %v; want %v, %v", hasGet, hasSet, tc.wantGet, tc.wantSet)
			}
			if hasGet && !tools.IsDeferred(get) || hasSet && !tools.IsDeferred(set) {
				t.Fatal("config tools must be deferred")
			}
		})
	}
}
