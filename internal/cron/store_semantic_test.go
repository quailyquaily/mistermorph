package cron_test

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/internal/cron"
	"github.com/quailyquaily/mistermorph/internal/topiccontext"
)

// blockingResolver matches the task with id want, after the test lets it.
type blockingResolver struct {
	want    string
	entered chan struct{}
	release chan struct{}
}

func newBlockingResolver(want string) *blockingResolver {
	return &blockingResolver{want: want, entered: make(chan struct{}), release: make(chan struct{})}
}

func (r *blockingResolver) MatchTaskIndex(_ context.Context, _ string, tasks []cron.Task) (int, error) {
	close(r.entered)
	<-r.release
	for i, task := range tasks {
		if task.ID == r.want {
			return i, nil
		}
	}
	return -1, nil
}

// writeWait is how long a write may wait for the semantic delete: far less than busy_timeout, so a
// delete that holds the write lock while it waits for the model fails here, not with SQLITE_BUSY.
const writeWait = 3 * time.Second

func newSemanticStore(t *testing.T, ids ...string) (*cron.Store, string) {
	t.Helper()
	state := t.TempDir()
	store := cron.NewStore(filepath.Join(state, "cron.yaml"))
	for _, id := range ids {
		if _, err := store.AddRecurring(cron.Task{ID: id, Content: "task " + id, Cron: "0 * * * *"}); err != nil {
			t.Fatal(err)
		}
	}
	return store, state
}

// startDelete runs a semantic delete matching want and returns once the resolver is waiting.
func startDelete(t *testing.T, store *cron.Store, want string) (*blockingResolver, chan error) {
	t.Helper()
	resolver := newBlockingResolver(want)
	store.Semantics = resolver
	done := make(chan error, 1)
	go func() {
		_, err := store.Delete(context.Background(), "", "delete "+want)
		done <- err
	}()
	select {
	case <-resolver.entered:
	case err := <-done:
		t.Fatalf("Delete returned before matching: %v", err)
	}
	return resolver, done
}

// during runs fn while the resolver waits, and fails if fn has to wait for the delete.
func during(t *testing.T, resolver *blockingResolver, what string, fn func() error) {
	t.Helper()
	done := make(chan error, 1)
	start := time.Now()
	go func() { done <- fn() }()
	select {
	case err := <-done:
		if err != nil {
			t.Errorf("%s while the delete waited for the model: %v", what, err)
		}
	case <-time.After(writeWait):
		t.Errorf("%s waited %s for a semantic delete that is waiting for the model", what, writeWait)
		close(resolver.release)
		<-done
		t.Logf("%s finished after %s", what, time.Since(start))
		return
	}
	close(resolver.release)
}

func taskIDs(t *testing.T, store *cron.Store) []string {
	t.Helper()
	file, _, err := store.Read()
	if err != nil {
		t.Fatal(err)
	}
	ids := make([]string, 0, len(file.Tasks))
	for _, task := range file.Tasks {
		ids = append(ids, task.ID)
	}
	return ids
}

func sameIDs(got []string, want ...string) bool {
	if len(got) != len(want) {
		return false
	}
	for i := range got {
		if got[i] != want[i] {
			return false
		}
	}
	return true
}

// While the model picks the task to delete, other writers of agent.db go on: the topic context of
// a conversation, and the TODO list itself. The task added meanwhile is kept.
func TestSemanticDeleteDoesNotHoldTheWriteLockWhileMatching(t *testing.T) {
	store, state := newSemanticStore(t, "a", "b")
	topics := topiccontext.NewStore(filepath.Join(state, "topic_context.json"))
	if _, _, err := topics.Get("console:ft36"); err != nil {
		t.Fatal(err)
	}
	resolver, deleted := startDelete(t, store, "b")
	during(t, resolver, "a topic context save and a TODO add", func() error {
		if err := topics.UpdateFromSample(topiccontext.Scope{Runtime: "console", ConversationKey: "console:ft36"},
			topiccontext.UsageSample{InputTokens: 11, Model: "ft36"}); err != nil {
			return err
		}
		_, err := store.AddRecurring(cron.Task{ID: "c", Content: "task c", Cron: "0 * * * *"})
		return err
	})
	if err := <-deleted; err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if got := taskIDs(t, store); !sameIDs(got, "a", "c") {
		t.Fatalf("tasks = %v, want [a c]: b deleted, c added during the match kept", got)
	}
	if _, present, err := topics.Get("console:ft36"); err != nil || !present {
		t.Fatalf("topic context saved during the match: present=%v err=%v", present, err)
	}
}

// The task the model picked is deleted only if it is still the task the model saw.
func TestSemanticDeleteRevalidatesTheMatchedTask(t *testing.T) {
	cases := []struct {
		name    string
		change  func(*cron.Store) error
		wantErr bool
		want    []string
	}{
		{
			name:    "matched task deleted meanwhile",
			change:  func(s *cron.Store) error { _, err := s.DeleteByID("b"); return err },
			wantErr: true,
			want:    []string{"a", "c"},
		},
		{
			name: "matched task edited meanwhile",
			change: func(s *cron.Store) error {
				file, _, err := s.Read()
				if err != nil {
					return err
				}
				file.Tasks[1].Content = "task b, rescheduled"
				return s.Write(file)
			},
			wantErr: true,
			want:    []string{"a", "b", "c"},
		},
		{
			name:   "matched task started by the scheduler meanwhile",
			change: func(s *cron.Store) error { return s.RecordRunStart("b", time.Now()) },
			want:   []string{"a", "c"},
		},
		{
			name:   "another task deleted meanwhile",
			change: func(s *cron.Store) error { _, err := s.DeleteByID("c"); return err },
			want:   []string{"a"},
		},
		{
			name: "list reordered meanwhile",
			change: func(s *cron.Store) error {
				file, _, err := s.Read()
				if err != nil {
					return err
				}
				file.Tasks[0], file.Tasks[2] = file.Tasks[2], file.Tasks[0]
				return s.Write(file)
			},
			want: []string{"c", "a"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			store, _ := newSemanticStore(t, "a", "b", "c")
			resolver, deleted := startDelete(t, store, "b")
			during(t, resolver, "the change", func() error { return tc.change(store) })
			err := <-deleted
			if tc.wantErr {
				if !errors.Is(err, cron.ErrTaskChanged) {
					t.Fatalf("Delete error = %v, want ErrTaskChanged", err)
				}
			} else if err != nil {
				t.Fatalf("Delete: %v", err)
			}
			if got := taskIDs(t, store); !sameIDs(got, tc.want...) {
				t.Fatalf("tasks = %v, want %v", got, tc.want)
			}
		})
	}
}

// An empty list, a model that matches nothing and a model that fails change nothing.
func TestSemanticDeleteWithoutAMatch(t *testing.T) {
	store, _ := newSemanticStore(t)
	store.Semantics = newBlockingResolver("x")
	if _, err := store.Delete(context.Background(), "", "delete x"); err == nil {
		t.Fatal("deleted from an empty list")
	}

	store, _ = newSemanticStore(t, "a")
	resolver := newBlockingResolver("missing")
	close(resolver.release)
	store.Semantics = resolver
	if _, err := store.Delete(context.Background(), "", "delete missing"); err == nil {
		t.Fatal("deleted without a match")
	}
	store.Semantics = failingResolver{}
	if _, err := store.Delete(context.Background(), "", "delete a"); err == nil || err.Error() != "model failed" {
		t.Fatalf("Delete error = %v, want the model's", err)
	}
	if got := taskIDs(t, store); !sameIDs(got, "a") {
		t.Fatalf("tasks = %v, want [a]", got)
	}
}

type failingResolver struct{}

func (failingResolver) MatchTaskIndex(context.Context, string, []cron.Task) (int, error) {
	return 0, errors.New("model failed")
}
