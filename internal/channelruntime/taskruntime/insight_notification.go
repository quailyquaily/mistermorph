package taskruntime

import (
	"context"
	"log/slog"
	"strings"
	"sync"

	"github.com/quailyquaily/mistermorph/agent"
)

// How many insights a task may send: each one notifies the person, so a group chat gets fewer.
const (
	InsightLimit      = 20
	InsightLimitGroup = 8
)

// InsightLimitFor is the insight limit for a task from a group chat or not.
func InsightLimitFor(group bool) int {
	if group {
		return InsightLimitGroup
	}
	return InsightLimit
}

// InsightNotifyFunc sends an insight to the conversation a task came from. seq counts the insights
// of the task from 1, for correlation IDs.
type InsightNotifyFunc func(ctx context.Context, seq int, text string) error

type insightLimitContextKey struct{}

// WithInsightNotification lets the task's run send up to limit insights, the messages the agent
// writes to the person before its final answer, and delivers each through notify as the run emits
// it, before the run goes on. Run reads the limit from ctx to turn insights on and add their prompt.
func WithInsightNotification(ctx context.Context, logger *slog.Logger, limit int, notify InsightNotifyFunc) context.Context {
	if ctx == nil {
		ctx = context.Background()
	}
	if notify == nil || limit <= 0 {
		return ctx
	}
	if logger == nil {
		logger = slog.Default()
	}
	baseSink, _ := agent.EventSinkFromContext(ctx)
	var (
		mu  sync.Mutex
		seq int
	)
	sink := agent.EventSinkFunc(func(deliveryCtx context.Context, event agent.Event) {
		if baseSink != nil {
			baseSink.HandleEvent(deliveryCtx, event)
		}
		if strings.TrimSpace(event.Kind) != agent.EventKindInsight {
			return
		}
		text := strings.TrimSpace(event.Text)
		if text == "" {
			return
		}
		mu.Lock()
		seq++
		n := seq
		mu.Unlock()
		if err := notify(deliveryCtx, n, text); err != nil {
			logger.Warn("insight_notification_failed", "error", err.Error())
		}
	})
	ctx = context.WithValue(ctx, insightLimitContextKey{}, limit)
	return agent.WithEventSinkContext(ctx, sink)
}

func insightLimitFromContext(ctx context.Context) int {
	if ctx == nil {
		return 0
	}
	limit, _ := ctx.Value(insightLimitContextKey{}).(int)
	return limit
}
