package mcphost

import (
	"strings"

	"github.com/quailyquaily/mistermorph/internal/caprefs"
)

// ReferencePrefix starts a reference to an MCP server: $mcp_<name>.
const ReferencePrefix = "mcp_"

// ReferencedServers returns the enabled servers that text references with $mcp_<name>, once
// each, in order. Names match ignoring case, and a name as written is tried before its trailing
// punctuation is trimmed, so $mcp_github- finds a server named "github-". consumed holds the
// lower-cased names a skill already took; a skill takes precedence over a server.
func ReferencedServers(text string, configs []ServerConfig, consumed map[string]bool) []ServerConfig {
	refs := caprefs.Refs(text)
	if len(refs) == 0 || len(configs) == 0 {
		return nil
	}
	enabled := make(map[string]ServerConfig, len(configs))
	for _, cfg := range configs {
		if cfg.Enable {
			enabled[strings.ToLower(cfg.Name)] = cfg
		}
	}
	var out []ServerConfig
	added := make(map[string]bool)
	for _, ref := range refs {
		for _, candidate := range []string{ref.Raw, ref.Name} {
			key := strings.ToLower(candidate)
			if !strings.HasPrefix(key, ReferencePrefix) {
				continue
			}
			if consumed[key] {
				break
			}
			cfg, ok := enabled[strings.TrimPrefix(key, ReferencePrefix)]
			if !ok {
				continue
			}
			if serverKey := strings.ToLower(cfg.Name); !added[serverKey] {
				added[serverKey] = true
				out = append(out, cfg)
			}
			break
		}
	}
	return out
}
