package mcphost

import (
	"strings"
	"testing"
)

func TestServerConfigValidateName(t *testing.T) {
	for _, name := range []string{"a", "GitHub", "github-work", "github_work2"} {
		t.Run(name, func(t *testing.T) {
			cfg := ServerConfig{Name: name, Type: "http", URL: "https://example.com/mcp"}
			if err := cfg.Validate(); err != nil {
				t.Fatalf("Validate() error = %v", err)
			}
		})
	}
	for _, name := range []string{"", " ", "github work", " github", "github ", "github\twork", "github\n", "github\u00a0work", "github.work", "github/work", "github:work", "$github", "1github", "_github", "-github", "中文", "gíthub"} {
		t.Run(name, func(t *testing.T) {
			cfg := ServerConfig{Name: name, Type: "http", URL: "https://example.com/mcp"}
			if err := cfg.Validate(); err == nil || !strings.Contains(err.Error(), "name") {
				t.Fatalf("Validate() error = %v, want invalid name", err)
			}
		})
	}
}
