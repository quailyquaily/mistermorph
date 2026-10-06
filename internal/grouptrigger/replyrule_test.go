package grouptrigger

import (
	"context"
	"strings"
	"testing"

	"github.com/quailyquaily/mistermorph/internal/replyrule"
)

func TestJudgmentsShareTheReplyRule(t *testing.T) {
	system, _, err := RenderAddressingPrompts("persona", "👍", map[string]any{"text": "hi"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(system, replyrule.Text) {
		t.Fatalf("group check prompt lacks the shared reply rule:\n%s", system)
	}

	client := &evaluationStub{result: lightweightResult("text", "emoji_0")}
	if _, err := DecideLightweight(context.Background(), LightweightOptions{Client: client, Emojis: []string{"👍"}}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(client.calls[0].Questions["reply"].Instructions, replyrule.Text) {
		t.Fatalf("pre-check prompt lacks the shared reply rule:\n%s", client.calls[0].Questions["reply"].Instructions)
	}
}
