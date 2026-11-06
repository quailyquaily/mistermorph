package awareness

import (
	"context"
	"errors"
	"log/slog"
	"testing"

	cronstore "github.com/quailyquaily/mistermorph/internal/cron"
)

func TestNotifyAwareness(t *testing.T) {
	t.Run("nil notifier", func(t *testing.T) {
		notifyAwareness(context.Background(), nil, nil, "hello")
	})

	t.Run("trim message before notify", func(t *testing.T) {
		var (
			called bool
			got    string
		)
		notifier := NotifyFunc(func(ctx context.Context, text string) error {
			_ = ctx
			called = true
			got = text
			return nil
		})
		notifyAwareness(context.Background(), notifier, nil, "  hello world  ")
		if !called {
			t.Fatalf("notifier was not called")
		}
		if got != "hello world" {
			t.Fatalf("notifier text = %q, want %q", got, "hello world")
		}
	})

	t.Run("alert messages are log only", func(t *testing.T) {
		called := false
		notifier := NotifyFunc(func(ctx context.Context, text string) error {
			_ = ctx
			_ = text
			called = true
			return nil
		})
		notifyAwareness(context.Background(), notifier, nil, "ALERT: awareness_failed (boom)")
		if called {
			t.Fatalf("notifier was called for alert message")
		}
	})

	t.Run("notifier error does not panic", func(t *testing.T) {
		notifier := NotifyFunc(func(ctx context.Context, text string) error {
			_ = ctx
			_ = text
			return errors.New("boom")
		})
		notifyAwareness(context.Background(), notifier, slog.Default(), "ping")
	})
}

func TestNotifyCronResult(t *testing.T) {
	t.Run("publishes completed console task", func(t *testing.T) {
		var got CronNotification
		notify := func(_ context.Context, notification CronNotification) error {
			got = notification
			return nil
		}
		task := cronstore.Task{
			ID:     "daily-review",
			Title:  "Daily review",
			ChatID: cronstore.ConsoleNotificationChatID,
		}

		notifyCronResult(context.Background(), notify, nil, task, true, "run-1", "  Review complete.  ", nil)

		if got.ID != "run-1" || got.Title != "Daily review" {
			t.Fatalf("unexpected notification identity: %#v", got)
		}
		if got.Body != "Review complete." || got.Trigger != "" {
			t.Fatalf("unexpected completed notification: %#v", got)
		}
	})

	t.Run("publishes failed console task", func(t *testing.T) {
		var got CronNotification
		notify := func(_ context.Context, notification CronNotification) error {
			got = notification
			return nil
		}
		task := cronstore.Task{
			ID:     "daily-review",
			ChatID: cronstore.ConsoleNotificationChatID,
		}

		notifyCronResult(context.Background(), notify, nil, task, true, "run-2", "", errors.New("route unavailable"))

		if got.Title != cronstore.DefaultTaskTitle || got.Body != "route unavailable" || got.Trigger != "" {
			t.Fatalf("unexpected failed notification: %#v", got)
		}
	})

	// The Console decides what to show; the run only says its schedule fired it.
	for _, tc := range []struct {
		name   string
		runErr error
	}{
		{"marks scheduled completed run", nil},
		{"marks scheduled failed run", errors.New("route unavailable")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var got CronNotification
			notify := func(_ context.Context, notification CronNotification) error {
				got = notification
				return nil
			}
			task := cronstore.Task{ID: "daily-review", ChatID: cronstore.ConsoleNotificationChatID}

			notifyCronResult(context.Background(), notify, nil, task, false, "run-4", "done", tc.runErr)

			if got.ID != "run-4" || got.Trigger != CronNotificationTriggerSchedule {
				t.Fatalf("unexpected scheduled notification: %#v", got)
			}
		})
	}

	t.Run("ignores external target", func(t *testing.T) {
		called := false
		notify := func(_ context.Context, _ CronNotification) error {
			called = true
			return nil
		}

		notifyCronResult(context.Background(), notify, nil, cronstore.Task{
			ID:     "external",
			ChatID: "tg:-100",
		}, false, "run-3", "done", nil)

		if called {
			t.Fatal("console notifier was called for an external chat target")
		}
	})
}
