package configsettings

import "github.com/quailyquaily/mistermorph/internal/configstore"

// The registry's kinds label the agent.db settings rows, and a map the registry treats as one
// value (string_map, json) stays one row.
func init() {
	kinds := map[string]string{}
	for _, set := range [][]Field{AgentFields(), ConsoleFields(), SystemFields()} {
		for _, field := range set {
			kinds[field.Path] = string(field.Kind)
		}
	}
	configstore.SetFieldKinds(kinds)
}
