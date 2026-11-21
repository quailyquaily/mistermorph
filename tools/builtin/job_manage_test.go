package builtin

import (
	"context"
	"errors"
	"path/filepath"
	"reflect"
	"testing"

	cronstore "github.com/quailyquaily/mistermorph/internal/cron"
)

func TestJobManageIsTheToolNameAndTodoUpdateStillReachesIt(t *testing.T) {
	tool := NewJobManageTool(true, "", "")
	if tool.Name() != "job_manage" {
		t.Fatalf("Name() = %q", tool.Name())
	}
	// A call by the earlier name (an old prompt, a skill, history) runs the same tool.
	cronPath := filepath.Join(t.TempDir(), "cron.yaml")
	legacy := newTodoDispatchNamed(t, cronPath, "todo_update")
	added := legacy.mustCall(`{"action":"add_recurring","title":"Report","content":"Send the report","cron":"0 9 * * 1"}`)
	id := added["task"].(map[string]any)["id"].(string)
	if !cronstore.IsGeneratedJobID(id) {
		t.Fatalf("id = %q", id)
	}
	got := legacy.mustCall(`{"action":"get","id":"` + id + `"}`)
	if got["action"] != "get" || got["task"].(map[string]any)["title"] != "Report" {
		t.Fatalf("get by the earlier name = %v", got)
	}
}

func TestJobManageGetUpdateDeleteByStableID(t *testing.T) {
	d := newTodoDispatch(t)
	store := cronstore.NewStore(d.cronPath)
	off := false
	// A legacy job (an ID an earlier version made) next to a new one.
	if _, err := store.AddRecurring(cronstore.Task{ID: "cron-legacy", Title: "Legacy", Cron: "0 8 * * *", Content: "old",
		BashEnv: []cronstore.BashEnvRef{{Name: "TOKEN", Value: todoSyntheticSecret}}}); err != nil {
		t.Fatal(err)
	}
	if err := store.Write(cronstore.File{Tasks: append(mustTasks(t, store), cronstore.Task{ID: "task-2", Enabled: &off, At: "2030-01-02 09:00", Content: "second"})}); err != nil {
		t.Fatal(err)
	}
	added := d.mustCall(`{"action":"add_once","title":"New","content":"third","at":"2030-02-03 10:00"}`)
	newID := added["task"].(map[string]any)["id"].(string)
	if !cronstore.IsGeneratedJobID(newID) || added["warnings"] != nil {
		t.Fatalf("add = %v", added)
	}

	// get: every field but the bash_env values, with the job's state.
	got := d.mustCall(`{"action":"get","id":"cron-legacy"}`)
	job := got["task"].(map[string]any)
	if job["id"] != "cron-legacy" || job["content"] != "old" || job["enabled"] != true || job["bash_env"] != nil ||
		!reflect.DeepEqual(job["bash_env_names"], []any{"TOKEN"}) || got["task_count"] != float64(3) {
		t.Fatalf("get = %v", got)
	}
	if job := d.mustCall(`{"action":"get","id":"task-2"}`)["task"].(map[string]any); job["enabled"] != false {
		t.Fatalf("disabled job = %v", job)
	}
	if _, err := d.call(context.Background(), `{"action":"get","id":"job-missing"}`); !errors.Is(err, cronstore.ErrTaskNotFound) {
		t.Fatalf("get of a missing id: %v", err)
	}
	if _, err := d.call(context.Background(), `{"action":"get"}`); err == nil {
		t.Fatal("get without an id worked")
	}

	// update: in place, same id, same position, nothing else changed.
	before := mustTasks(t, store)
	d.mustCall(`{"action":"update","id":"` + newID + `","content":"third, edited"}`)
	d.mustCall(`{"action":"update","id":"cron-legacy","cron":"0 7 * * *"}`)
	after := mustTasks(t, store)
	if len(after) != 3 || after[0].ID != "cron-legacy" || after[1].ID != "task-2" || after[2].ID != newID {
		t.Fatalf("ids/order after update = %+v", after)
	}
	before[0].Cron = "0 7 * * *"
	before[0].Triggers[0].Cron = "0 7 * * *" // the job's schedule trigger, which cron mirrors
	before[2].Content = "third, edited"
	if !reflect.DeepEqual(after, before) {
		t.Fatalf("update changed more than its fields:\n%#v\nwant\n%#v", after, before)
	}

	// delete by id.
	deleted := d.mustCall(`{"action":"delete","id":"task-2"}`)
	if deleted["deleted"].(map[string]any)["id"] != "task-2" || deleted["task_count"] != float64(2) {
		t.Fatalf("delete = %v", deleted)
	}
	if _, ok, _ := store.FindByID("task-2"); ok {
		t.Fatal("deleted job still stored")
	}
}

func mustTasks(t *testing.T, store *cronstore.Store) []cronstore.Task {
	t.Helper()
	tasks, err := store.Tasks(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	return tasks
}
