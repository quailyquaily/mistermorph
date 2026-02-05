package retryutil

import (
	"context"
	"log/slog"
	"time"
)

const (
	defaultRetryDelay   = 2 * time.Second
	defaultRetryTimeout = 12 * time.Second
)

func AsyncRetry(logger *slog.Logger, name string, delay, timeout time.Duration, fn func(ctx context.Context) error) {
	if fn == nil {
		return
	}
	if delay <= 0 {
		delay = defaultRetryDelay
	}
	if timeout <= 0 {
		timeout = defaultRetryTimeout
	}
	if logger != nil {
		logger.Info(name+"_retry_scheduled", "delay", delay.String(), "timeout", timeout.String())
	}
	go func() {
		if delay > 0 {
			timer := time.NewTimer(delay)
			<-timer.C
			timer.Stop()
		}
		ctx := context.Background()
		if timeout > 0 {
			var cancel context.CancelFunc
			ctx, cancel = context.WithTimeout(ctx, timeout)
			defer cancel()
		}
		if err := fn(ctx); err != nil {
			if logger != nil {
				logger.Warn(name+"_retry_failed", "error", err.Error())
			}
			return
		}
		if logger != nil {
			logger.Info(name + "_retry_ok")
		}
	}()
}
