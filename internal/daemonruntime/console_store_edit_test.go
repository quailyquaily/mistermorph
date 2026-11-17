package daemonruntime

import (
	"errors"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

// An edited message replaces itself and every later task of its topic in one journal event: the
// store, a reload and another process reading the same journal all see the edited conversation,
// and a refused edit changes nothing.

type editStoreFixture struct {
	root, journal string
	store         *ConsoleFileStore
	topicID       string
	base          time.Time
}

func newEditStoreFixture(t *testing.T) *editStoreFixture {
	t.Helper()
	root := t.TempDir()
	f := &editStoreFixture{root: root, journal: filepath.Join(root, "journal"), base: time.Date(2026, 11, 17, 9, 0, 0, 0, time.UTC)}
	f.store = f.open(t, false)
	topic, err := f.store.CreateTopic("Stories")
	if err != nil {
		t.Fatal(err)
	}
	f.topicID = topic.ID
	for i, id := range []string{"t1", "t2", "t3"} {
		f.put(t, f.store, TaskInfo{ID: id, Status: TaskDone, Task: "question " + id, CreatedAt: f.base.Add(time.Duration(i) * time.Minute), TopicID: topic.ID, Result: map[string]any{"final": map[string]any{"output": "answer " + id}}})
	}
	return f
}

func (f *editStoreFixture) open(t *testing.T, shared bool) *ConsoleFileStore {
	t.Helper()
	store, err := NewConsoleFileStore(ConsoleFileStoreOptions{RootDir: f.root, Persist: true, JournalDir: f.journal, SkipRecovery: shared})
	if err != nil {
		t.Fatal(err)
	}
	return store
}

func (f *editStoreFixture) put(t *testing.T, store *ConsoleFileStore, info TaskInfo) {
	t.Helper()
	if err := store.UpsertWithTrigger(info, TaskTrigger{Source: "ui", Event: "chat_submit"}, ""); err != nil {
		t.Fatal(err)
	}
}

func (f *editStoreFixture) edit(id, text string) TaskInfo {
	return TaskInfo{ID: id, Status: TaskQueued, Task: text, CreatedAt: f.base.Add(time.Hour), TopicID: f.topicID}
}

// The topic's tasks oldest first, as "id:text".
func topicTasks(store *ConsoleFileStore, topicID string) []string {
	items := store.List(TaskListOptions{TopicID: topicID, Limit: 50})
	out := make([]string, 0, len(items))
	for i := len(items) - 1; i >= 0; i-- {
		out = append(out, items[i].ID+":"+items[i].Task)
	}
	return out
}

func TestReplaceTopicTasksEditsTheLatestAndAnEarlierMessage(t *testing.T) {
	cases := []struct {
		name, target string
		removed      []string
		want         []string
	}{
		{"latest", "t3", []string{"t3"}, []string{"t1:question t1", "t2:question t2", "n1:edited"}},
		{"earlier", "t2", []string{"t3", "t2"}, []string{"t1:question t1", "n1:edited"}},
		{"first", "t1", []string{"t3", "t2", "t1"}, []string{"n1:edited"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newEditStoreFixture(t)
			var heard []string
			f.store.onTaskUpdate = func(_, next TaskInfo, _ TaskTrigger) { heard = append(heard, next.ID) }
			removed, err := f.store.ReplaceTopicTasks(tc.target, f.edit("n1", "edited"), TaskTrigger{Source: "ui", Event: "chat_edit"})
			if err != nil {
				t.Fatalf("ReplaceTopicTasks() error = %v", err)
			}
			if !reflect.DeepEqual(removed, tc.removed) {
				t.Fatalf("removed = %v, want %v", removed, tc.removed)
			}
			if got := topicTasks(f.store, f.topicID); !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("tasks = %v, want %v", got, tc.want)
			}
			if !reflect.DeepEqual(heard, []string{"n1"}) {
				t.Fatalf("task updates heard = %v, want the new task", heard)
			}
			for _, id := range tc.removed {
				if _, ok := f.store.Get(id); ok {
					t.Fatalf("removed task %s still readable", id)
				}
				if _, ok := f.store.GetTrigger(id); ok {
					t.Fatalf("removed task %s still has a trigger", id)
				}
			}
			if trigger, _ := f.store.GetTrigger("n1"); trigger.Event != "chat_edit" {
				t.Fatalf("new task trigger = %+v", trigger)
			}
			// A reload replays the event (the startup snapshot, then the journal after it); a
			// second reload starts from the snapshot the first one wrote.
			for i := 0; i < 2; i++ {
				reloaded := f.open(t, false)
				if got := topicTasks(reloaded, f.topicID); !reflect.DeepEqual(got, tc.want) {
					t.Fatalf("reload %d tasks = %v, want %v", i+1, got, tc.want)
				}
			}
		})
	}
}

// Another process on the same journal (the chat command) catches up on its next read.
func TestReplaceTopicTasksReachesASharedReader(t *testing.T) {
	f := newEditStoreFixture(t)
	shared := f.open(t, true)
	if got := topicTasks(shared, f.topicID); len(got) != 3 {
		t.Fatalf("shared reader before = %v", got)
	}
	if _, err := f.store.ReplaceTopicTasks("t2", f.edit("n1", "edited"), TaskTrigger{}); err != nil {
		t.Fatal(err)
	}
	want := []string{"t1:question t1", "n1:edited"}
	if got := topicTasks(shared, f.topicID); !reflect.DeepEqual(got, want) {
		t.Fatalf("shared reader after = %v, want %v", got, want)
	}
	// And it can go on writing: a later message lands after the edit.
	f.put(t, shared, TaskInfo{ID: "t4", Status: TaskDone, Task: "question t4", CreatedAt: f.base.Add(2 * time.Hour), TopicID: f.topicID})
	if got := topicTasks(f.store, f.topicID); !reflect.DeepEqual(got, append(want, "t4:question t4")) {
		t.Fatalf("store after the shared write = %v", got)
	}
}

func TestReplaceTopicTasksRefusalsKeepTheConversation(t *testing.T) {
	cases := []struct {
		name  string
		setup func(t *testing.T, f *editStoreFixture) (target string, info TaskInfo)
		want  error
	}{
		{"unknown message", func(t *testing.T, f *editStoreFixture) (string, TaskInfo) {
			return "nope", f.edit("n1", "edited")
		}, ErrMessageNotFound},
		{"message of another topic", func(t *testing.T, f *editStoreFixture) (string, TaskInfo) {
			other, err := f.store.CreateTopic("Other")
			if err != nil {
				t.Fatal(err)
			}
			f.put(t, f.store, TaskInfo{ID: "o1", Status: TaskDone, Task: "elsewhere", CreatedAt: f.base, TopicID: other.ID})
			return "o1", f.edit("n1", "edited")
		}, ErrMessageNotFound},
		{"missing topic", func(t *testing.T, f *editStoreFixture) (string, TaskInfo) {
			info := f.edit("n1", "edited")
			info.TopicID = "no-such-topic"
			return "t2", info
		}, ErrTopicNotFound},
		{"deleted topic", func(t *testing.T, f *editStoreFixture) (string, TaskInfo) {
			if _, err := f.store.DeleteTopic(f.topicID); err != nil {
				t.Fatal(err)
			}
			return "t2", f.edit("n1", "edited")
		}, ErrTopicNotFound},
		{"a reply still running", func(t *testing.T, f *editStoreFixture) (string, TaskInfo) {
			f.put(t, f.store, TaskInfo{ID: "t4", Status: TaskRunning, Task: "question t4", CreatedAt: f.base.Add(10 * time.Minute), TopicID: f.topicID})
			return "t2", f.edit("n1", "edited")
		}, ErrTopicRunning},
		{"an approval waiting", func(t *testing.T, f *editStoreFixture) (string, TaskInfo) {
			if err := f.store.Update("t3", func(info *TaskInfo) { info.Status = TaskPending }); err != nil {
				t.Fatal(err)
			}
			return "t1", f.edit("n1", "edited")
		}, ErrTopicRunning},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newEditStoreFixture(t)
			target, info := tc.setup(t, f)
			before := topicTasks(f.store, f.topicID)
			if _, err := f.store.ReplaceTopicTasks(target, info, TaskTrigger{}); !errors.Is(err, tc.want) {
				t.Fatalf("ReplaceTopicTasks() error = %v, want %v", err, tc.want)
			}
			if _, ok := f.store.Get("n1"); ok {
				t.Fatal("a refused edit recorded its task")
			}
			if got := topicTasks(f.store, f.topicID); !reflect.DeepEqual(got, before) {
				t.Fatalf("tasks after refusal = %v, want %v", got, before)
			}
			if got := topicTasks(f.open(t, false), f.topicID); !reflect.DeepEqual(got, before) {
				t.Fatalf("reloaded tasks after refusal = %v, want %v", got, before)
			}
		})
	}
}

// Two edits of the same message: the second names a message the first already replaced.
func TestReplaceTopicTasksRefusesAnObsoleteTarget(t *testing.T) {
	f := newEditStoreFixture(t)
	if _, err := f.store.ReplaceTopicTasks("t2", f.edit("n1", "first edit"), TaskTrigger{}); err != nil {
		t.Fatal(err)
	}
	if err := f.store.Update("n1", func(info *TaskInfo) { info.Status = TaskDone }); err != nil {
		t.Fatal(err)
	}
	if _, err := f.store.ReplaceTopicTasks("t2", f.edit("n2", "second edit"), TaskTrigger{}); !errors.Is(err, ErrMessageNotFound) {
		t.Fatalf("second edit of t2 error = %v, want ErrMessageNotFound", err)
	}
	want := []string{"t1:question t1", "n1:first edit"}
	if got := topicTasks(f.store, f.topicID); !reflect.DeepEqual(got, want) {
		t.Fatalf("tasks = %v, want %v", got, want)
	}
	// The replacement itself can be edited again.
	if _, err := f.store.ReplaceTopicTasks("n1", f.edit("n2", "second edit"), TaskTrigger{}); err != nil {
		t.Fatal(err)
	}
	want = []string{"t1:question t1", "n2:second edit"}
	if got := topicTasks(f.open(t, false), f.topicID); !reflect.DeepEqual(got, want) {
		t.Fatalf("reloaded tasks = %v, want %v", got, want)
	}
}
