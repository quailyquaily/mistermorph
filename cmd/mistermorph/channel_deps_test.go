package main

import (
	"context"
	"testing"

	"github.com/quailyquaily/mistermorph/internal/channelruntime/depsutil"
	"github.com/quailyquaily/mistermorph/internal/channelruntime/runtimetest"
	"github.com/quailyquaily/mistermorph/internal/configstore"
	"github.com/quailyquaily/mistermorph/internal/toolsutil"
	"github.com/spf13/viper"
)

func TestChannelCommandRuntimeSplitsRuntimeAndAwarenessRegistries(t *testing.T) {
	registryResolver := &registryRuntimeResolver{}
	registryResolver.once.Do(func() {
		registryResolver.cfg = registryConfig{
			ContactsSend: toolsutil.StaticContactsSendConfig{
				Enabled:     true,
				ContactsDir: t.TempDir(),
			},
		}
	})
	if err := registryResolver.Prepare(context.Background()); err != nil {
		t.Fatalf("Prepare() error = %v", err)
	}

	deps := newChannelCommandRuntime().Dependencies(registryResolver, &guardRuntimeResolver{})
	if deps.Registry == nil {
		t.Fatal("Registry is nil")
	}
	if deps.AwarenessRegistry == nil {
		t.Fatal("AwarenessRegistry is nil")
	}

	runtimeReg := deps.Registry()
	if _, ok := runtimeReg.Get(toolsutil.BuiltinContactsSend); ok {
		t.Fatalf("runtime registry includes %s", toolsutil.BuiltinContactsSend)
	}

	awarenessReg := deps.AwarenessRegistry()
	if _, ok := awarenessReg.Get(toolsutil.BuiltinContactsSend); !ok {
		t.Fatalf("awareness registry missing %s", toolsutil.BuiltinContactsSend)
	}
}

// The telegram and slack commands run ordinary messages with these dependencies, after
// depsutil.ApplyRuntimeConfig (buildTelegramRuntimeDeps, buildSlackRuntimeDeps).
func TestChannelCommandRuntimeOffersContactsSendThroughToolSearch(t *testing.T) {
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
			stateDir := t.TempDir()
			registryResolver := &registryRuntimeResolver{}
			registryResolver.once.Do(func() {
				registryResolver.cfg = registryConfig{
					ContactsSend: toolsutil.StaticContactsSendConfig{
						Enabled:     tc.enabled,
						ContactsDir: t.TempDir(),
						StateDir:    stateDir,
					},
				}
			})
			if err := registryResolver.Prepare(context.Background()); err != nil {
				t.Fatalf("Prepare() error = %v", err)
			}
			reader := viper.New()
			reader.Set("file_state_dir", stateDir)
			deps := depsutil.ApplyRuntimeConfig(
				newChannelCommandRuntime().Dependencies(registryResolver, &guardRuntimeResolver{}),
				toolsutil.RuntimeToolsRegisterConfig{ToolSearch: toolsutil.ToolSearchConfig{Enabled: tc.toolSearch}},
				reader,
			)
			got := runtimetest.DiscoverContactsSend(t, deps)
			got.SearchOffered = got.SearchOffered && tc.want.SearchOffered
			if got != tc.want {
				t.Fatalf("discovery = %+v, want %+v", got, tc.want)
			}
		})
	}
}

// The CLI's runtimes (run, chat, telegram, slack, ...) offer config_get and config_set through
// tool_search; their awareness registry has config_get only.
func TestChannelCommandRuntimeOffersConfigToolsThroughToolSearch(t *testing.T) {
	stateDir := t.TempDir()
	registryResolver := &registryRuntimeResolver{}
	registryResolver.once.Do(func() {
		registryResolver.cfg = registryConfig{
			ContactsSend: toolsutil.StaticContactsSendConfig{ContactsDir: t.TempDir(), StateDir: stateDir},
			Config: toolsutil.StaticConfigToolsConfig{
				GetEnabled: true,
				SetEnabled: true,
				ToolSearch: true,
				ConfigPath: configstore.DBConfigPath(stateDir),
				StateDir:   stateDir,
			},
		}
	})
	if err := registryResolver.Prepare(context.Background()); err != nil {
		t.Fatalf("Prepare() error = %v", err)
	}
	reader := viper.New()
	reader.Set("file_state_dir", stateDir)
	deps := depsutil.ApplyRuntimeConfig(
		newChannelCommandRuntime().Dependencies(registryResolver, &guardRuntimeResolver{}),
		toolsutil.RuntimeToolsRegisterConfig{ToolSearch: toolsutil.ToolSearchConfig{Enabled: true}},
		reader,
	)
	got := runtimetest.DiscoverConfigTools(t, deps)
	want := runtimetest.ConfigToolsDiscovery{SearchOffered: true, FoundGet: true, FoundSet: true, AwarenessGet: true}
	if got != want {
		t.Fatalf("discovery = %+v, want %+v", got, want)
	}
	// A run's triggered tools never add config_set, which an awareness run would then get.
	reg := registryResolver.AwarenessRegistry()
	registryResolver.RegisterTriggeredStaticTools(reg, map[string]bool{toolsutil.BuiltinAgentSend: true, toolsutil.BuiltinConfigSet: true})
	if _, ok := reg.Get(toolsutil.BuiltinConfigSet); ok {
		t.Fatal("triggered static tools added config_set")
	}
}
