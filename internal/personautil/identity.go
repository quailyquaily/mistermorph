package personautil

import (
	"context"
	"strings"

	"github.com/quailyquaily/mistermorph/internal/personastore"
	"github.com/quailyquaily/mistermorph/internal/statepaths"
	"gopkg.in/yaml.v3"
)

const IdentityFilename = statepaths.IdentityFilename

// LoadAgentName is the identity's name in agent.db in stateDir, or "" without one.
func LoadAgentName(stateDir string) string {
	return personastore.LoadAgentName(context.Background(), stateDir)
}

func parseIdentityNameFromYAML(raw string) string {
	var profile struct {
		Name string `yaml:"name"`
	}
	if err := yaml.Unmarshal([]byte(raw), &profile); err != nil {
		return ""
	}
	return cleanIdentityNameValue(profile.Name)
}

func cleanIdentityNameValue(raw string) string {
	value := strings.TrimSpace(raw)
	value = strings.Trim(value, "*_`")
	if value == "" {
		return ""
	}
	switch strings.ToLower(value) {
	case "(pick one)", "pick one":
		return ""
	default:
		return value
	}
}
