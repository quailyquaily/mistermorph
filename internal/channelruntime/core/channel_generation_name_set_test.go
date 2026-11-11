package core

import (
	"testing"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/spf13/viper"
)

// Each channel runtime generation reads the agent name set from its config snapshot, so a saved
// preference reaches workers of tasks started after the change.
func TestEngineToolsConfigReadsAgentNameSet(t *testing.T) {
	fallback := &agent.EngineToolsConfig{WorkerNameSet: agent.WorkerNameSetArtists}
	for value, want := range map[string]string{"": "scientists", "musicians": "musicians", "ARTISTS": "artists", "poets": "scientists"} {
		reader := viper.New()
		if value != "" {
			reader.Set("tools.agent_name_set", value)
		}
		if got := engineToolsConfigFromReader(reader, fallback).WorkerNameSet; got != want {
			t.Fatalf("%q = %q, want %q", value, got, want)
		}
	}
}
