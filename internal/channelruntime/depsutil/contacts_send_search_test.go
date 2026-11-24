package depsutil_test

import (
	"context"
	"io"
	"log/slog"
	"testing"

	"github.com/quailyquaily/mistermorph/internal/agentsettings"
	"github.com/quailyquaily/mistermorph/internal/channelruntime/depsutil"
	"github.com/quailyquaily/mistermorph/internal/channelruntime/runtimetest"
	"github.com/quailyquaily/mistermorph/internal/configdefaults"
	"github.com/quailyquaily/mistermorph/internal/configstore"
	"github.com/quailyquaily/mistermorph/internal/toolsutil"
	"github.com/spf13/viper"
)

// The Telegram, Slack and other channel runtimes build each config generation's dependencies with
// BuildGenerationDependencies, whether started from the CLI or by the Console.
func TestGenerationDependenciesOfferContactsSendThroughToolSearch(t *testing.T) {
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
			reader := viper.New()
			configdefaults.Apply(reader)
			stateDir := t.TempDir()
			reader.Set("file_state_dir", stateDir)
			reader.Set("file_cache_dir", t.TempDir())
			reader.Set("skills.enabled", false)
			reader.Set("tools.contacts_send.enabled", tc.enabled)
			reader.Set("tools.tool_search.enabled", tc.toolSearch)
			base := depsutil.CommonDependencies{
				Logger:             func() (*slog.Logger, error) { return slog.New(slog.NewTextHandler(io.Discard, nil)), nil },
				AgentSettingsOwner: agentsettings.NewFileOwner(agentsettings.FileOwnerOptions{Reader: reader}),
			}
			deps, cleanup, err := depsutil.BuildGenerationDependencies(context.Background(), base, agentsettings.NewReaderSnapshot(reader))
			if err != nil {
				t.Fatalf("BuildGenerationDependencies() error = %v", err)
			}
			defer cleanup()
			if _, ok := deps.Registry().Get(toolsutil.BuiltinContactsSend); ok {
				t.Fatal("the generation's base registry has contacts_send")
			}
			if _, ok := deps.AwarenessRegistry().Get(toolsutil.BuiltinContactsSend); ok != tc.enabled {
				t.Fatalf("awareness registry has contacts_send = %v, want %v", ok, tc.enabled)
			}
			got := runtimetest.DiscoverContactsSend(t, deps)
			got.SearchOffered = got.SearchOffered && tc.want.SearchOffered
			if got != tc.want {
				t.Fatalf("discovery = %+v, want %+v", got, tc.want)
			}
		})
	}
}

// The channel runtimes' generations offer config_get and config_set through tool_search, and their
// awareness registries never config_set.
func TestGenerationDependenciesOfferConfigToolsThroughToolSearch(t *testing.T) {
	for _, toolSearch := range []bool{true, false} {
		reader := viper.New()
		configdefaults.Apply(reader)
		stateDir := t.TempDir()
		reader.Set("file_state_dir", stateDir)
		reader.Set("file_cache_dir", t.TempDir())
		reader.Set("skills.enabled", false)
		reader.Set("config", configstore.DBConfigPath(stateDir))
		reader.Set("tools.tool_search.enabled", toolSearch)
		base := depsutil.CommonDependencies{
			Logger:             func() (*slog.Logger, error) { return slog.New(slog.NewTextHandler(io.Discard, nil)), nil },
			AgentSettingsOwner: agentsettings.NewFileOwner(agentsettings.FileOwnerOptions{Reader: reader}),
		}
		deps, cleanup, err := depsutil.BuildGenerationDependencies(context.Background(), base, agentsettings.NewReaderSnapshot(reader))
		if err != nil {
			t.Fatalf("BuildGenerationDependencies() error = %v", err)
		}
		got := runtimetest.DiscoverConfigTools(t, deps)
		cleanup()
		want := runtimetest.ConfigToolsDiscovery{SearchOffered: true, FoundGet: true, FoundSet: true, AwarenessGet: true}
		if !toolSearch {
			want = runtimetest.ConfigToolsDiscovery{}
			got.SearchOffered = false
		}
		if got != want {
			t.Fatalf("tool search %v: discovery = %+v, want %+v", toolSearch, got, want)
		}
	}
}
