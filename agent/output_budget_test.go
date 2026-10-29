package agent

import (
	"testing"

	"github.com/quailyquaily/mistermorph/llm"
)

func TestMainRequestParametersMaxTokens(t *testing.T) {
	stream := func(llm.StreamEvent) error { return nil }
	for _, tt := range []struct {
		name     string
		model    string
		params   map[string]any
		onStream llm.StreamHandler
		want     int
	}{
		{"streamed Opus 5.5", "claude-opus-5-5", nil, stream, 64000},
		{"unstreamed Opus 5.5", "claude-opus-5-5", nil, nil, 16000},
		{"streamed model under the budget", "claude-haiku-4-5", nil, stream, 64000},
		{"unstreamed model under the budget", "claude-haiku-4-5", nil, nil, 16000},
		{"run sets its own", "claude-opus-5-5", map[string]any{"max_tokens": 2048}, stream, 2048},
		{"no output limit in the catalog", "gpt-6-astra", nil, stream, 0},
		{"unknown model", "some-local-model", nil, stream, 0},
	} {
		t.Run(tt.name, func(t *testing.T) {
			st := &engineLoopState{model: tt.model, extraParams: tt.params, onStream: tt.onStream}
			got := mainRequestParameters(st)
			if n := requestMaxOutputTokens(got); n != tt.want {
				t.Fatalf("max_tokens = %d, want %d (params %v)", n, tt.want, got)
			}
			if tt.params == nil && tt.want > 0 && st.extraParams != nil {
				t.Fatalf("run parameters were changed: %v", st.extraParams)
			}
		})
	}
}
