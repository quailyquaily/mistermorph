package consolecmd

import (
	"io"
	"log/slog"
	"testing"

	"github.com/quailyquaily/mistermorph/internal/channelruntime/depsutil"
	"github.com/quailyquaily/mistermorph/internal/channelruntime/runtimetest"
	"github.com/quailyquaily/mistermorph/internal/configdefaults"
	"github.com/quailyquaily/mistermorph/internal/toolsutil"
	"github.com/spf13/viper"
)

// The Console's own chat runtime and the channel runtimes it manages (Telegram, Slack, ...) keep
// contacts_send out of an ordinary run's first request and let tool_search find it.
func TestConsoleRuntimesOfferContactsSendThroughToolSearch(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	runtimes := map[string]func(t *testing.T, reader *viper.Viper) depsutil.CommonDependencies{
		"console": func(t *testing.T, reader *viper.Viper) depsutil.CommonDependencies {
			snapshot, err := buildConsoleLocalRuntimeConfigSnapshot(logger, nil, reader)
			if err != nil {
				t.Fatalf("buildConsoleLocalRuntimeConfigSnapshot() error = %v", err)
			}
			bundle, deps, err := buildConsoleLocalRuntimeBundle(logger, nil, snapshot)
			if err != nil {
				t.Fatalf("buildConsoleLocalRuntimeBundle() error = %v", err)
			}
			t.Cleanup(func() {
				_ = bundle.taskRuntime.Close()
				if bundle.mcpHost != nil {
					_ = bundle.mcpHost.Close()
				}
			})
			return deps
		},
		"managed channel runtimes": func(t *testing.T, reader *viper.Viper) depsutil.CommonDependencies {
			deps, cleanup, err := buildManagedRuntimeDepsFromReader(logger, reader)
			if err != nil {
				t.Fatalf("buildManagedRuntimeDepsFromReader() error = %v", err)
			}
			t.Cleanup(cleanup)
			return deps
		},
	}
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
	for runtimeName, build := range runtimes {
		for _, tc := range cases {
			t.Run(runtimeName+"/"+tc.name, func(t *testing.T) {
				stateDir := t.TempDir()
				reader := viper.New()
				configdefaults.Apply(reader)
				reader.Set("file_state_dir", stateDir)
				reader.Set("file_cache_dir", t.TempDir())
				reader.Set("skills.enabled", false)
				reader.Set("llm.provider", "openai")
				reader.Set("llm.endpoint", "https://example.test/v1")
				reader.Set("llm.api_key", "test-key")
				reader.Set("llm.model", "test-model")
				reader.Set("tools.contacts_send.enabled", tc.enabled)
				reader.Set("tools.tool_search.enabled", tc.toolSearch)
				deps := build(t, reader)
				if _, ok := deps.Registry().Get(toolsutil.BuiltinContactsSend); ok {
					t.Fatal("the base registry has contacts_send")
				}
				if deps.RuntimeToolsConfig.ToolSearch.Enabled != tc.toolSearch {
					t.Fatalf("tool search = %v, want %v", deps.RuntimeToolsConfig.ToolSearch.Enabled, tc.toolSearch)
				}
				got := runtimetest.DiscoverContactsSend(t, deps)
				got.SearchOffered = got.SearchOffered && tc.want.SearchOffered
				if got != tc.want {
					t.Fatalf("discovery = %+v, want %+v", got, tc.want)
				}
			})
		}
	}
}
