package integration

import (
	"path/filepath"
	"testing"

	"github.com/quailyquaily/mistermorph/internal/channelruntime/depsutil"
	"github.com/quailyquaily/mistermorph/internal/channelruntime/runtimetest"
	"github.com/quailyquaily/mistermorph/internal/toolsutil"
	"github.com/quailyquaily/mistermorph/tools"
)

func TestSharedDependenciesRetainCommonCapabilities(t *testing.T) {
	t.Parallel()

	cfg := DefaultConfig()
	cfg.Set("tools.write_file.enabled", false)
	cfg.Set("tasks.persistence_targets", []string{"telegram"})
	cfg.Set("tasks.rotate_max_bytes", int64(12345))
	rt := New(cfg)
	snap := rt.snapshot()
	var common depsutil.CommonDependencies = rt.sharedDependencies(snap)

	if common.ResolveLLMRouteWithProfile == nil {
		t.Fatal("ResolveLLMRouteWithProfile was dropped")
	}
	if common.CreateImageClient == nil {
		t.Fatal("CreateImageClient was dropped")
	}
	if common.AwarenessRegistry == nil {
		t.Fatal("AwarenessRegistry was dropped")
	}
	if common.RegisterTriggeredStaticTools == nil {
		t.Fatal("RegisterTriggeredStaticTools was dropped")
	}
	if err := common.Validate(); err != nil {
		t.Fatalf("common dependency validation failed: %v", err)
	}
	if common.PromptAugment == nil {
		t.Fatal("optional common behavior was dropped")
	}
	if common.RuntimePaths.StateDir == "" || len(common.TaskPersistenceTargets) != 1 || common.TaskPersistenceTargets[0] != "telegram" || common.TaskRotateMaxBytes != 12345 {
		t.Fatalf("runtime state dependencies were dropped: %#v", common)
	}
	if _, ok := common.Registry().Get(toolsutil.BuiltinContactsSend); ok {
		t.Fatal("base registry contains awareness-only contacts_send")
	}
	if _, ok := common.AwarenessRegistry().Get(toolsutil.BuiltinContactsSend); !ok {
		t.Fatal("awareness registry dropped contacts_send")
	}

	telegramDeps := rt.telegramDependencies(snap).CommonDependencies
	slackDeps := rt.slackDependencies(snap).CommonDependencies
	for name, deps := range map[string]depsutil.CommonDependencies{
		"telegram": telegramDeps,
		"slack":    slackDeps,
	} {
		if deps.ResolveLLMRouteWithProfile == nil || deps.CreateImageClient == nil || deps.AwarenessRegistry == nil || deps.RegisterTriggeredStaticTools == nil {
			t.Fatalf("%s dependencies dropped a common capability", name)
		}
		reg := tools.NewRegistry()
		deps.RegisterTriggeredStaticTools(reg, map[string]bool{toolsutil.BuiltinWriteFile: true})
		if _, ok := reg.Get(toolsutil.BuiltinWriteFile); !ok {
			t.Fatalf("%s dependencies did not register a triggered static tool", name)
		}
	}
}

// The embedding runtime's Telegram and Slack bots run ordinary messages with these dependencies.
func TestChannelDependenciesOfferContactsSendThroughToolSearch(t *testing.T) {
	cases := []struct {
		name       string
		enabled    bool
		toolSearch bool
		want       runtimetest.ContactsSendDiscovery
	}{
		{name: "enabled", enabled: true, toolSearch: true, want: runtimetest.ContactsSendDiscovery{SearchOffered: true, Found: true, VisibleAfterSearch: true}},
		{name: "disabled", enabled: false, toolSearch: true},
		{name: "tool search off", enabled: true, toolSearch: false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cfg := DefaultConfig()
			cfg.Set("file_state_dir", t.TempDir())
			cfg.Set("file_cache_dir", t.TempDir())
			cfg.Set("tools.contacts_send.enabled", tc.enabled)
			cfg.Set("tools.tool_search.enabled", tc.toolSearch)
			rt := New(cfg)
			snap := rt.snapshot()
			for name, deps := range map[string]depsutil.CommonDependencies{
				"telegram": rt.telegramDependencies(snap).CommonDependencies,
				"slack":    rt.slackDependencies(snap).CommonDependencies,
			} {
				if _, ok := deps.Registry().Get(toolsutil.BuiltinContactsSend); ok {
					t.Fatalf("%s base registry has contacts_send", name)
				}
				got := runtimetest.DiscoverContactsSend(t, deps)
				got.SearchOffered = got.SearchOffered && tc.want.SearchOffered
				if got != tc.want {
					t.Fatalf("%s discovery = %+v, want %+v", name, got, tc.want)
				}
			}
		})
	}
}

// An embedding program gets config_get and config_set only when it names its config file with
// the "config" key; its awareness registry never has config_set.
func TestChannelDependenciesOfferConfigToolsWithAConfigFile(t *testing.T) {
	for _, withConfig := range []bool{true, false} {
		cfg := DefaultConfig()
		stateDir := t.TempDir()
		cfg.Set("file_state_dir", stateDir)
		cfg.Set("file_cache_dir", t.TempDir())
		if withConfig {
			cfg.Set("config", filepath.Join(stateDir, "config.yaml"))
		}
		rt := New(cfg)
		snap := rt.snapshot()
		if reg := rt.buildAwarenessRegistry(snap.StaticRegistry, nil); reg != nil {
			if _, ok := reg.Get(toolsutil.BuiltinConfigSet); ok {
				t.Fatal("the awareness registry has config_set")
			}
		}
		deps := rt.telegramDependencies(snap).CommonDependencies
		got := runtimetest.DiscoverConfigTools(t, deps)
		want := runtimetest.ConfigToolsDiscovery{SearchOffered: true, FoundGet: true, FoundSet: true, AwarenessGet: true}
		if !withConfig {
			want = runtimetest.ConfigToolsDiscovery{}
			got.SearchOffered = false
		}
		if got != want {
			t.Fatalf("config %v: discovery = %+v, want %+v", withConfig, got, want)
		}
	}
}
