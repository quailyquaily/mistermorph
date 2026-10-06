package slack

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"testing"

	"github.com/quailyquaily/mistermorph/llm"
	"github.com/quailyquaily/mistermorph/tools"
	slacktools "github.com/quailyquaily/mistermorph/tools/slack"
)

type addressingRequestCapture struct {
	requests []llm.EvaluateRequest
}

func (*addressingRequestCapture) Chat(context.Context, llm.Request) (llm.Result, error) {
	panic("unexpected Chat")
}

func (c *addressingRequestCapture) Evaluate(_ context.Context, req llm.EvaluateRequest) (*llm.EvaluateResult, error) {
	c.requests = append(c.requests, req)
	return nil, llm.ErrEvaluateInvalidResponse
}

func TestAddressingEvaluationReactionAvailability(t *testing.T) {
	for _, enabled := range []bool{false, true} {
		t.Run(fmt.Sprintf("enabled=%v", enabled), func(t *testing.T) {
			client := &addressingRequestCapture{}
			var tool tools.Tool
			if enabled {
				tool = slacktools.NewReactTool(nil, "C1", "1.0", nil, []string{"thumbsup", "eyes"})
			}
			_, _, err := slackAddressingDecisionViaLLM(context.Background(), client, "judge", slackInboundEvent{Text: "Hi"}, nil, "thumbsup, eyes,thumbsup", tool)
			if !errors.Is(err, llm.ErrEvaluateInvalidResponse) || len(client.requests) != 1 {
				t.Fatalf("err=%v requests=%d", err, len(client.requests))
			}
			questions := client.requests[0].Questions
			if !enabled {
				if _, ok := questions["reply"]; ok {
					t.Fatalf("reply offered without a reaction tool: %v", questions)
				}
				return
			}
			want := map[string]any{"emoji_0": "thumbsup", "emoji_1": "eyes"}
			if got := questions["emoji"].Options; !reflect.DeepEqual(got, want) {
				t.Fatalf("emoji options=%v want %v", got, want)
			}
			if got := len(questions["reply"].Options); got != 2 {
				t.Fatalf("reply options=%d want text and emoji", got)
			}
		})
	}
}
