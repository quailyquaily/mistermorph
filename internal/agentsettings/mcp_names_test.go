package agentsettings

import (
	"fmt"
	"strings"
	"testing"
)

func TestNormalizeMCPServersRejectsInvalidNames(t *testing.T) {
	for _, enabled := range []bool{false, true} {
		for _, name := range []string{"github work", " github", "github ", "github.work", "1github", "中文"} {
			t.Run(fmt.Sprintf("enabled=%v/name=%q", enabled, name), func(t *testing.T) {
				_, err := normalizeMCPServers([]MCPServerSettings{{Name: name, Enable: enabled, Type: "http", URL: "https://example.com/mcp"}})
				if err == nil || !strings.Contains(err.Error(), "name") {
					t.Fatalf("normalizeMCPServers() error = %v, want invalid name", err)
				}
			})
		}
	}
}

func TestNormalizeMCPServersAllowsDisabledServerWithoutTransportDetails(t *testing.T) {
	servers, err := normalizeMCPServers([]MCPServerSettings{{Name: "GitHub-work_2", Enable: false}})
	if err != nil {
		t.Fatal(err)
	}
	if len(servers) != 1 || servers[0].Name != "GitHub-work_2" {
		t.Fatalf("servers = %+v, want unchanged name", servers)
	}
}
