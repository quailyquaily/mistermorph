package agent

import (
	"context"
	"time"
)

type taskTimeoutParentKey struct{}

// WithTaskTimeout sets the execution deadline while retaining the parent's
// cancellation signal for a partial summary after that deadline. Cancel the
// parent to stop both execution and any summary request.
func WithTaskTimeout(parent context.Context, timeout time.Duration) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.WithValue(parent, taskTimeoutParentKey{}, parent), timeout)
}
