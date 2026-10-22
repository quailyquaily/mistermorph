package taskruntime

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"

	"github.com/quailyquaily/mistermorph/agent"
)

func TestWithInsightNotification(t *testing.T) {
	t.Run("sends each insight in order and forwards every event", func(t *testing.T) {
		var forwarded []string
		base := agent.WithEventSinkContext(context.Background(), agent.EventSinkFunc(func(_ context.Context, event agent.Event) {
			forwarded = append(forwarded, event.Kind)
		}))
		type sent struct {
			seq  int
			text string
		}
		var got []sent
		ctx := WithInsightNotification(base, slog.New(slog.NewTextHandler(io.Discard, nil)), 3, func(_ context.Context, seq int, text string) error {
			got = append(got, sent{seq, text})
			return errors.New("send failed")
		})

		agent.EmitEvent(ctx, nil, agent.Event{Kind: agent.EventKindToolStart})
		agent.EmitEvent(ctx, nil, agent.Event{Kind: agent.EventKindInsight, Text: " first "})
		agent.EmitEvent(ctx, nil, agent.Event{Kind: agent.EventKindInsight, Text: "  "})
		agent.EmitEvent(ctx, nil, agent.Event{Kind: agent.EventKindInsight, Text: "second"})

		if len(forwarded) != 4 {
			t.Fatalf("forwarded = %v, want all 4 events", forwarded)
		}
		if len(got) != 2 || got[0] != (sent{1, "first"}) || got[1] != (sent{2, "second"}) {
			t.Fatalf("sent = %+v", got)
		}
		if limit := insightLimitFromContext(ctx); limit != 3 {
			t.Fatalf("limit = %d, want 3", limit)
		}
	})

	t.Run("no notify or no limit leaves insights off", func(t *testing.T) {
		notify := func(context.Context, int, string) error { return nil }
		for name, ctx := range map[string]context.Context{
			"nil notify": WithInsightNotification(context.Background(), nil, 3, nil),
			"zero limit": WithInsightNotification(context.Background(), nil, 0, notify),
		} {
			if limit := insightLimitFromContext(ctx); limit != 0 {
				t.Fatalf("%s: limit = %d, want 0", name, limit)
			}
			if _, ok := agent.EventSinkFromContext(ctx); ok {
				t.Fatalf("%s: sink installed", name)
			}
		}
	})
}
