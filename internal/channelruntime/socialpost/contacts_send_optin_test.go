package socialpost

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/internal/channelruntime/depsutil"
	"github.com/quailyquaily/mistermorph/internal/channelruntime/runtimetest"
	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
)

// A public mention on Bluesky or X gets contacts_send only from $contacts_send, also with tool
// search on, and never reaches the post's author. The mention goes through Run, as the Bluesky and
// X runtimes start it.
func TestPublicThreadKeepsContactsSendOptIn(t *testing.T) {
	for _, tc := range []struct{ channel, authorID, authorContactID string }{
		{channel: "bluesky", authorID: "did:plc:stranger", authorContactID: "bluesky_user:did:plc:stranger"},
		{channel: "x", authorID: "4242", authorContactID: "x_user:4242"},
	} {
		t.Run(tc.channel, func(t *testing.T) {
			runtimetest.CheckPublicThreadContactsSendOptIn(t, func(t testing.TB, deps depsutil.CommonDependencies, text string) error {
				return answerMention(t, deps, tc.channel, Post{ID: "post-1", ThreadID: "root-1", AuthorID: tc.authorID, AuthorHandle: "stranger", Text: text, CreatedAt: time.Now()})
			}, tc.authorContactID)
		})
	}
}

// answerMention runs channel's mention runtime on deps until it has finished the task for p.
func answerMention(t testing.TB, deps depsutil.CommonDependencies, channel string, p Post) error {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	source := newFakeSource()
	tasks := daemonruntime.NewMemoryStore(16)
	done := make(chan error, 1)
	go func() {
		done <- Run(ctx, deps, Options{Channel: channel, Source: source, FileCacheDir: t.TempDir(), TaskStore: tasks})
	}()
	defer func() {
		cancel()
		<-done
	}()
	source.posts <- p
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		select {
		case err := <-done:
			done <- err
			return fmt.Errorf("runtime stopped: %v", err)
		default:
		}
		for _, task := range tasks.List(daemonruntime.TaskListOptions{}) {
			switch task.Status {
			case daemonruntime.TaskDone:
				return nil
			case daemonruntime.TaskFailed:
				return fmt.Errorf("task failed: %s", task.Error)
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	return fmt.Errorf("timed out waiting for the task")
}
