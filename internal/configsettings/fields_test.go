package configsettings

import (
	"slices"
	"testing"

	"github.com/quailyquaily/mistermorph/agent"
)

func TestPublicFieldSetsHaveUniquePathsAndApplyModes(t *testing.T) {
	seen := map[string]string{}
	sets := []struct {
		name   string
		fields []Field
	}{
		{name: "agent", fields: AgentFields()},
		{name: "console", fields: ConsoleFields()},
		{name: "system", fields: SystemFields()},
	}
	for _, set := range sets {
		for _, field := range set.fields {
			if previous, exists := seen[field.Path]; exists {
				t.Fatalf("field %q is present in %s and %s", field.Path, previous, set.name)
			}
			seen[field.Path] = set.name
			if field.ApplyMode == "" {
				t.Fatalf("field %q has no apply mode", field.Path)
			}
		}
	}

	for _, path := range []string{
		"llm.cache_ttl",
		"llm.routes.main_loop",
		"llm.routes.decision",
		"llm.routes.addressing",
		"max_steps",
		"tools.bash.timeout",
		"telegram.record_untriggered",
		"heartbeat.interval",
		"server.auth_token",
		"logging.level",
		"workspace_dir",
		"file_cache.max_total_bytes",
		"tasks.persistence_targets",
		"bus.max_inflight",
	} {
		if _, exists := seen[path]; !exists {
			t.Errorf("public field %q is not registered", path)
		}
	}
}

// The registry's agent name sets are the ones the runtime names workers from.
func TestAgentNameSetFieldMatchesTheRuntimeSets(t *testing.T) {
	for _, field := range AgentFields() {
		if field.Path == "tools.agent_name_set" {
			if !slices.Equal(field.Enum, agent.WorkerNameSets()) || field.Kind != KindString {
				t.Fatalf("field = %+v, want the sets %v", field, agent.WorkerNameSets())
			}
			return
		}
	}
	t.Fatal("tools.agent_name_set is not registered")
}
