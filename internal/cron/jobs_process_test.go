package cron

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
)

// TestMain lets a test run this binary as another process sharing a state folder: with
// MM_JOBS_TEST_DIR set, it opens the job store there, adds MM_JOBS_TEST_ADDS jobs (or deletes the
// job MM_JOBS_TEST_DELETE) and exits.
func TestMain(m *testing.M) {
	if dir := os.Getenv("MM_JOBS_TEST_DIR"); dir != "" {
		os.Exit(jobsTestProcess(dir))
	}
	os.Exit(m.Run())
}

func jobsTestProcess(dir string) int {
	store := NewStore(filepath.Join(dir, "cron.yaml"))
	if id := os.Getenv("MM_JOBS_TEST_DELETE"); id != "" {
		if _, err := store.DeleteByID(id); err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		return 0
	}
	adds, _ := strconv.Atoi(os.Getenv("MM_JOBS_TEST_ADDS"))
	for i := 0; i < adds; i++ {
		if _, err := store.AddRecurring(Task{Title: fmt.Sprintf("process %d job %d", os.Getpid(), i), Cron: "* * * * *", Content: "x"}); err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
	}
	return 0
}

func runJobsTestProcess(dir string, env ...string) error {
	cmd := exec.Command(os.Args[0], "-test.run=^$")
	cmd.Env = append(append(os.Environ(), "MM_JOBS_TEST_DIR="+dir), env...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%v: %s", err, out)
	}
	return nil
}

// Processes that start together on a state folder with a cron.yaml import it once between them,
// keep every job each adds, and see each other's changes.
func TestSeveralProcessesShareTheJobList(t *testing.T) {
	dir := t.TempDir()
	writeCronYAML(t, dir, legacyYAML)
	const processes, adds = 4, 5
	var wg sync.WaitGroup
	errs := make(chan error, processes)
	for i := 0; i < processes; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			errs <- runJobsTestProcess(dir, "MM_JOBS_TEST_ADDS="+strconv.Itoa(adds))
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	store := NewStore(filepath.Join(dir, "cron.yaml"))
	tasks, err := store.Tasks(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(tasks) != 3+processes*adds || !strings.HasPrefix(jobIDs(tasks), "remind-standup,weekly-report,task-3,") {
		t.Fatalf("tasks = %d: %s", len(tasks), jobIDs(tasks))
	}
	seen := map[string]bool{}
	for _, task := range tasks[3:] {
		if !IsGeneratedJobID(task.ID) || seen[task.ID] {
			t.Fatalf("job id %q", task.ID)
		}
		seen[task.ID] = true
	}
	// This process has the list open; another one deletes a job, and the next read here sees it.
	if err := runJobsTestProcess(dir, "MM_JOBS_TEST_DELETE=task-3"); err != nil {
		t.Fatal(err)
	}
	if _, ok, err := store.FindByID("task-3"); err != nil || ok {
		t.Fatalf("a job another process deleted is still listed: %v, %v", ok, err)
	}
	// And it stays deleted: cron.yaml, still there, is not read again by any process.
	if err := runJobsTestProcess(dir, "MM_JOBS_TEST_ADDS=1"); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := store.FindByID("task-3"); ok {
		t.Fatal("a deleted job came back")
	}
}
