package configsettings

import (
	"path/filepath"
	"strings"

	"github.com/quailyquaily/mistermorph/internal/configstore"
)

// SourceStateFolder is file_state_dir of a config kept in agent.db: the folder agent.db is in,
// settled (by --state-dir, MISTER_MORPH_FILE_STATE_DIR or the default) before the config is read.
const SourceStateFolder Source = "state_folder"

// ApplyStateFolder shows file_state_dir, when the config at configPath is in agent.db, as the
// folder agent.db is in, and not editable there: agent.db does not keep it (configstore refuses a
// save that changes it).
func ApplyStateFolder(view *ViewPayload, configPath string) {
	if view == nil || !configstore.IsDBConfigPath(configPath) {
		return
	}
	stateDir := filepath.Dir(filepath.Clean(strings.TrimSpace(configPath)))
	for _, key := range configstore.BootstrapKeys {
		state, ok := view.FieldStates[key]
		if !ok {
			continue
		}
		state.Source = SourceStateFolder
		state.Editable = false
		state.EnvName = ""
		view.FieldStates[key] = state
		if view.Values != nil {
			view.Values[key] = stateDir
		}
	}
}

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
