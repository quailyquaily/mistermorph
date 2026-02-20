package guard

import (
	"strings"
	"testing"
)

func TestSummarizeActionRedacted_ToolDetails(t *testing.T) {
	g := New(Config{}, nil, nil)

	cases := []struct {
		name       string
		action     Action
		wantParts  []string
		notContain []string
	}{
		{
			name: "read_file_path",
			action: Action{
				Type:     ActionToolCallPre,
				ToolName: "read_file",
				ToolParams: map[string]any{
					"path": "/tmp/audit.log",
				},
			},
			wantParts: []string{"tool=read_file", "path=\"/tmp/audit.log\""},
		},
		{
			name: "web_search_query",
			action: Action{
				Type:     ActionToolCallPre,
				ToolName: "web_search",
				ToolParams: map[string]any{
					"q": "site:example.com release note",
				},
			},
			wantParts: []string{"tool=web_search", "q=\"site:example.com release note\""},
		},
		{
			name: "url_fetch_url_redacts_sensitive_query",
			action: Action{
				Type:     ActionToolCallPre,
				ToolName: "url_fetch",
				ToolParams: map[string]any{
					"url":    "https://example.com/api?token=abcdef1234567890&lang=en",
					"method": "get",
				},
			},
			wantParts:  []string{"tool=url_fetch", "method=GET", "url=https://example.com/api?lang=en&token=%5Bredacted%5D"},
			notContain: []string{"abcdef1234567890"},
		},
		{
			name: "bash_cmd_redaction",
			action: Action{
				Type:     ActionToolCallPost,
				ToolName: "bash",
				ToolParams: map[string]any{
					"cmd": "curl -H 'Authorization: Bearer secret_token_1234567890' https://example.com",
				},
			},
			wantParts:  []string{"tool=bash", "cmd=\"curl -H 'Authorization: Bearer [redacted]' https://example.com\""},
			notContain: []string{"secret_token_1234567890"},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := g.summarizeActionRedacted(tc.action)
			for _, want := range tc.wantParts {
				if !strings.Contains(got, want) {
					t.Fatalf("summary missing %q: %s", want, got)
				}
			}
			for _, deny := range tc.notContain {
				if deny == "" {
					continue
				}
				if strings.Contains(got, deny) {
					t.Fatalf("summary leaked %q: %s", deny, got)
				}
			}
		})
	}
}
