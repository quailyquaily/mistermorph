//go:build linux

package codersessions

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/internal/proctrack"
)

// reapWithin is how soon an ended server must be gone, zombie included.
const reapWithin = 3 * time.Second

// procStat is pid's state letter ("Z" for a zombie) and parent in /proc, or "" when it is gone.
func procStat(pid int) (state string, ppid int) {
	data, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return "", 0
	}
	// pid (comm) S ppid ...: comm can hold spaces and parentheses, the state follows the last ")".
	s := string(data)
	i := strings.LastIndexByte(s, ')')
	if i < 0 {
		return "", 0
	}
	fields := strings.Fields(s[i+1:])
	if len(fields) < 2 {
		return "", 0
	}
	ppid, _ = strconv.Atoi(fields[1])
	return fields[0], ppid
}

func procState(pid int) string {
	state, _ := procStat(pid)
	return state
}

// waitGone waits until pid is gone (a zombie counts as gone if zombieOK) and returns the last
// state seen: "" when it is gone.
func waitGone(pid int, zombieOK bool, within time.Duration) string {
	deadline := time.Now().Add(within)
	for {
		state := procState(pid)
		if state == "" || (zombieOK && state == "Z") {
			return ""
		}
		if time.Now().After(deadline) {
			return state
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// helperPID is the pid the stand-in wrote to file, its command left running; it is killed when
// the test ends.
func helperPID(t *testing.T, file string) int {
	t.Helper()
	data, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = syscall.Kill(pid, syscall.SIGKILL) })
	return pid
}

// lifecycleRequest is a request whose processes are recorded, with a file for the stand-in's
// helper pid.
func lifecycleRequest(t *testing.T, backend, task string) (Request, *[]int, string) {
	t.Helper()
	req := fakeRequest(t, backend, task)
	helper := filepath.Join(t.TempDir(), "helper.pid")
	req.Env = append(req.Env, "MM_CLAUDE_HELPER="+helper, "MM_CLAUDE_LOG="+filepath.Join(t.TempDir(), "args.jsonl"))
	var mu sync.Mutex
	pids := &[]int{}
	req.Process = func(pid int) {
		mu.Lock()
		defer mu.Unlock()
		*pids = append(*pids, pid)
	}
	return req, pids, helper
}

func runOK(t *testing.T, sessions *Sessions, req Request, want string) {
	t.Helper()
	if out, err := sessions.Run(context.Background(), "chat", req); err != nil || out != want {
		t.Fatalf("out=%q err=%v", out, err)
	}
}

// A server that ends while it waits for its next task (stopped from outside, a crash, the OOM
// killer) is reaped at once, for every backend, not left a zombie until the scope's next task or
// close. The next task opens the session again in a new process.
func TestIdleServerThatEndsIsReaped(t *testing.T) {
	for _, backend := range []string{"codex", "agy", "claude", "grok"} {
		for _, sig := range []syscall.Signal{syscall.SIGTERM, syscall.SIGKILL} {
			t.Run(backend+"/"+sig.String(), func(t *testing.T) {
				var sessions Sessions
				defer sessions.Close()
				req, pids, _ := lifecycleRequest(t, backend, "ok")
				runOK(t, &sessions, req, "done")
				server := (*pids)[0]
				if err := syscall.Kill(server, sig); err != nil {
					t.Fatal(err)
				}
				if state := waitGone(server, false, reapWithin); state != "" {
					t.Fatalf("server %d is still in state %q after it ended, want reaped", server, state)
				}
				runOK(t, &sessions, req, "done")
				if len(*pids) != 2 || (*pids)[1] == server {
					t.Fatalf("pids = %v", *pids)
				}
			})
		}
	}
}

// What an idle server left running in its group goes with it, also when it holds the server's
// output open; a command that left the group to hold the output does not keep the dead server
// from being reaped or the next task from starting a new one.
func TestIdleServerExitWithCommandsLeftRunning(t *testing.T) {
	for _, task := range []string{"helper", "escape"} {
		t.Run(task, func(t *testing.T) {
			var sessions Sessions
			defer sessions.Close()
			req, pids, helperFile := lifecycleRequest(t, "claude", task)
			runOK(t, &sessions, req, "done")
			helper := helperPID(t, helperFile)
			server := (*pids)[0]
			if err := syscall.Kill(server, syscall.SIGKILL); err != nil {
				t.Fatal(err)
			}
			if state := waitGone(server, false, reapWithin); state != "" {
				t.Fatalf("server %d is still in state %q after it ended, want reaped", server, state)
			}
			if task == "helper" {
				// No longer the session's child once its server is gone: init (or a subreaper)
				// reaps it, so a zombie counts as stopped.
				if state := waitGone(helper, true, reapWithin); state != "" {
					t.Fatalf("command %d left in the server's group is still running (state %q)", helper, state)
				}
			} else if state := procState(helper); state == "" || state == "Z" {
				t.Fatalf("command %d in a session of its own was stopped (state %q)", helper, state)
			}
			req.Task = "ok"
			runOK(t, &sessions, req, "done")
			if len(*pids) != 2 || (*pids)[1] == server {
				t.Fatalf("pids = %v", *pids)
			}
		})
	}
}

// An idle server with more lines after its result than the session queues is reaped when it
// ends, though nobody reads its output until the next task.
func TestIdleServerWithAFullQueueIsReaped(t *testing.T) {
	var sessions Sessions
	defer sessions.Close()
	req, pids, _ := lifecycleRequest(t, "claude", "flood")
	runOK(t, &sessions, req, "done")
	server := (*pids)[0]
	// The lines are written: the queue is full and its reader waits.
	time.Sleep(200 * time.Millisecond)
	if err := syscall.Kill(server, syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	if state := waitGone(server, false, reapWithin); state != "" {
		t.Fatalf("server %d is still in state %q after it ended, want reaped", server, state)
	}
	req.Task = "ok"
	runOK(t, &sessions, req, "done")
}

// A server that writes its result and exits loses none of what it wrote, also when a command in a
// session of its own still holds its output open; it is reaped, and the next task reopens it.
func TestServerThatExitsAfterItsResult(t *testing.T) {
	for _, task := range []string{"bye", "bye-escaped"} {
		t.Run(task, func(t *testing.T) {
			var sessions Sessions
			defer sessions.Close()
			req, pids, helperFile := lifecycleRequest(t, "claude", task)
			var notes []string
			req.Note = func(s string) { notes = append(notes, s) }
			started := time.Now()
			runOK(t, &sessions, req, "bye")
			if took := time.Since(started); took > 5*time.Second {
				t.Fatalf("the task took %s", took)
			}
			if len(notes) != 499 || notes[0] != "step 0" || notes[498] != "step 498" {
				t.Fatalf("%d notes: %.200q", len(notes), notes)
			}
			if task == "bye-escaped" {
				helperPID(t, helperFile)
			}
			server := (*pids)[0]
			if state := waitGone(server, false, reapWithin); state != "" {
				t.Fatalf("server %d is still in state %q after it exited, want reaped", server, state)
			}
			req.Task = "ok"
			runOK(t, &sessions, req, "done")
			if len(*pids) != 2 {
				t.Fatalf("pids = %v", *pids)
			}
		})
	}
}

// A server that dies in a task while a command in a session of its own holds its output open
// ends the task with its last words, not when the task's context ends.
func TestTaskEndsWhenItsServerDiesWithItsOutputHeld(t *testing.T) {
	var sessions Sessions
	defer sessions.Close()
	req, pids, helperFile := lifecycleRequest(t, "claude", "die-escaped")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	started := time.Now()
	_, err := sessions.Run(ctx, "chat", req)
	helperPID(t, helperFile)
	if err == nil || !strings.Contains(err.Error(), "boom: out of memory") {
		t.Fatalf("err = %v", err)
	}
	if took := time.Since(started); took > 5*time.Second {
		t.Fatalf("the task took %s", took)
	}
	if state := waitGone((*pids)[0], false, reapWithin); state != "" {
		t.Fatalf("server is still in state %q after it died, want reaped", state)
	}
	req.Task = "ok"
	runOK(t, &sessions, req, "done")
}

// consoleRun runs tasks as a Console task does: in a proctrack run, the coder server recorded as
// one of its roots, so the task's process panel lists it and can stop it.
func consoleRun(t *testing.T, req *Request) (ctx context.Context, runID string) {
	t.Helper()
	ctx, owner := proctrack.Default.Begin(context.Background())
	runID = "ft160-" + strconv.Itoa(os.Getpid()) + "-" + strings.ReplaceAll(t.Name(), "/", "-")
	proctrack.Attach(ctx, runID)
	record := req.Process
	req.Process = func(pid int) {
		record(pid)
		proctrack.AddRoot(ctx, proctrack.Root{PID: pid, Kind: proctrack.KindCoder, Program: req.Backend})
	}
	t.Cleanup(func() { owner.End(false) })
	return ctx, runID
}

// The Stop button of a task's process panel (proctrack Kill, POST /tasks/{id}/processes/kill)
// on a coder server: an idle one is reaped at once with what it ran, one in a task ends the task
// (not the whole Console task's cancellation), and the next task reopens the session.
func TestConsoleStopOfACoderServer(t *testing.T) {
	t.Run("idle", func(t *testing.T) {
		var sessions Sessions
		defer sessions.Close()
		req, pids, helperFile := lifecycleRequest(t, "claude", "helper")
		ctx, runID := consoleRun(t, &req)
		if out, err := sessions.Run(ctx, "chat", req); err != nil || out != "done" {
			t.Fatalf("out=%q err=%v", out, err)
		}
		helper := helperPID(t, helperFile)
		server := (*pids)[0]
		stopped, err := proctrack.Default.Kill(runID, server)
		if err != nil {
			t.Fatal(err)
		}
		if len(stopped) != 2 || stopped[0].Proc.PID != server || stopped[0].Error != "" {
			t.Fatalf("stopped = %+v", stopped)
		}
		if state := waitGone(server, false, reapWithin); state != "" {
			t.Fatalf("server %d is still in state %q after Stop, want reaped", server, state)
		}
		if state := waitGone(helper, true, reapWithin); state != "" {
			t.Fatalf("command %d is still running (state %q)", helper, state)
		}
		req.Task = "ok"
		if out, err := sessions.Run(ctx, "chat", req); err != nil || out != "done" {
			t.Fatalf("out=%q err=%v", out, err)
		}
		starts := claudeStarts(t, envValue(req.Env, "MM_CLAUDE_LOG"))
		if len(starts) != 2 || flagValue(starts[1], "--resume") != flagValue(starts[0], "--session-id") {
			t.Fatalf("processes = %v", starts)
		}
	})
	t.Run("in a task", func(t *testing.T) {
		var sessions Sessions
		defer sessions.Close()
		req, pids, _ := lifecycleRequest(t, "claude", "wait")
		ctx, runID := consoleRun(t, &req)
		record := req.Process
		started := make(chan struct{})
		req.Process = func(pid int) { record(pid); close(started) }
		done := make(chan error, 1)
		go func() { _, err := sessions.Run(ctx, "chat", req); done <- err }()
		<-started
		server := (*pids)[0]
		if _, err := proctrack.Default.Kill(runID, server); err != nil {
			t.Fatal(err)
		}
		select {
		case err := <-done:
			if err == nil || ctx.Err() != nil {
				t.Fatalf("err = %v", err)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("the task did not end when its server was stopped")
		}
		if state := waitGone(server, false, reapWithin); state != "" {
			t.Fatalf("server %d is still in state %q after Stop, want reaped", server, state)
		}
		req.Process = record
		req.Task = "ok"
		if out, err := sessions.Run(ctx, "chat", req); err != nil || out != "done" {
			t.Fatalf("out=%q err=%v", out, err)
		}
	})
	t.Run("a command of the server", func(t *testing.T) {
		// Stopping what the server runs is not stopping the server: the session goes on.
		var sessions Sessions
		defer sessions.Close()
		req, pids, helperFile := lifecycleRequest(t, "claude", "helper")
		ctx, runID := consoleRun(t, &req)
		if out, err := sessions.Run(ctx, "chat", req); err != nil || out != "done" {
			t.Fatalf("out=%q err=%v", out, err)
		}
		helper := helperPID(t, helperFile)
		if _, err := proctrack.Default.Kill(runID, helper); err != nil {
			t.Fatal(err)
		}
		// The stand-in does not reap what it starts: a zombie counts as stopped.
		if state := waitGone(helper, true, reapWithin); state != "" {
			t.Fatalf("command %d is still in state %q after Stop", helper, state)
		}
		req.Task = "ok"
		if out, err := sessions.Run(ctx, "chat", req); err != nil || out != "done" {
			t.Fatalf("out=%q err=%v", out, err)
		}
		if len(*pids) != 2 || (*pids)[0] != (*pids)[1] || procState((*pids)[0]) == "" {
			t.Fatalf("pids = %v", *pids)
		}
	})
}

func envValue(env []string, key string) string {
	v := ""
	for _, kv := range env {
		if k, x, ok := strings.Cut(kv, "="); ok && k == key {
			v = x
		}
	}
	return v
}

// A server that ends while the session is being closed or reset, idle or in a task: every close
// returns, every server is reaped, and no goroutine is left behind.
func TestServerExitRacesClose(t *testing.T) {
	baseline := runtime.NumGoroutine()
	for i := range 12 {
		for _, backend := range []string{"codex", "claude"} {
			for _, busy := range []bool{false, true} {
				var sessions Sessions
				task := "ok"
				if busy {
					task = "wait"
				}
				req, pids, _ := lifecycleRequest(t, backend, task)
				started := make(chan struct{})
				record := req.Process
				req.Process = func(pid int) { record(pid); close(started) }
				done := make(chan error, 1)
				go func() { _, err := sessions.Run(context.Background(), "chat", req); done <- err }()
				<-started
				if !busy {
					if err := <-done; err != nil {
						t.Fatal(err)
					}
				}
				server := (*pids)[0]
				var wg sync.WaitGroup
				wg.Add(2)
				go func() {
					defer wg.Done()
					if i%2 == 0 {
						time.Sleep(time.Duration(i) * 100 * time.Microsecond)
					}
					_ = syscall.Kill(server, syscall.SIGKILL)
				}()
				go func() {
					defer wg.Done()
					if i%2 == 1 {
						time.Sleep(time.Duration(i) * 100 * time.Microsecond)
					}
					if i%3 == 0 {
						sessions.Reset("chat")
					} else {
						sessions.Close()
					}
				}()
				finished := make(chan struct{})
				go func() { wg.Wait(); close(finished) }()
				select {
				case <-finished:
				case <-time.After(10 * time.Second):
					t.Fatalf("%s busy=%v: close and exit did not both return", backend, busy)
				}
				if busy {
					select {
					case <-done:
					case <-time.After(10 * time.Second):
						t.Fatalf("%s: the task did not end", backend)
					}
				}
				sessions.Close()
				if state := waitGone(server, false, reapWithin); state != "" {
					t.Fatalf("%s busy=%v: server %d is still in state %q", backend, busy, server, state)
				}
			}
		}
	}
	deadline := time.Now().Add(5 * time.Second)
	for runtime.NumGoroutine() > baseline && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if n := runtime.NumGoroutine(); n > baseline {
		buf := make([]byte, 1<<20)
		t.Fatalf("%d goroutines, %d before:\n%s", n, baseline, buf[:runtime.Stack(buf, true)])
	}
}

// A coder process's group is signaled only while the process is not reaped: its pid, the group's
// id, is still its own then (a zombie keeps it), never another process's that got it after.
// Covered: close of a live process, an idle exit, a death and a cancellation in a task, and an
// exit racing a close.
func TestGroupSignaledOnlyBeforeReaping(t *testing.T) {
	var mu sync.Mutex
	var calls int
	var bad []string
	kill := killGroup
	killGroup = func(pgid int) error {
		state, ppid := procStat(pgid)
		mu.Lock()
		calls++
		if state == "" || ppid != os.Getpid() {
			bad = append(bad, strconv.Itoa(pgid)+" state="+state+" ppid="+strconv.Itoa(ppid))
		}
		mu.Unlock()
		return kill(pgid)
	}
	t.Cleanup(func() { killGroup = kill })

	// Close of a live, idle process.
	var sessions Sessions
	req, pids, _ := lifecycleRequest(t, "claude", "ok")
	runOK(t, &sessions, req, "done")
	sessions.Close()
	// An idle process that ends, then its session's close.
	sessions = Sessions{}
	runOK(t, &sessions, req, "done")
	_ = syscall.Kill((*pids)[1], syscall.SIGKILL)
	waitGone((*pids)[1], false, reapWithin)
	sessions.Close()
	// A process that dies in a task, and one whose task is cancelled.
	for _, task := range []string{"die", "wait"} {
		sessions = Sessions{}
		req.Task = task
		ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
		if _, err := sessions.Run(ctx, "chat", req); err == nil {
			t.Fatalf("%s: no error", task)
		}
		cancel()
		sessions.Close()
	}
	// An exit racing a close.
	for range 20 {
		sessions = Sessions{}
		req.Task = "ok"
		runOK(t, &sessions, req, "done")
		pid := (*pids)[len(*pids)-1]
		go func() { _ = syscall.Kill(pid, syscall.SIGKILL) }()
		sessions.Close()
	}
	for _, pid := range *pids {
		if state := waitGone(pid, false, reapWithin); state != "" {
			t.Fatalf("process %d is still in state %q", pid, state)
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if len(bad) > 0 {
		t.Fatalf("groups signaled after their process was reaped: %v", bad)
	}
	// Each process's group is stopped when it ends, and by its close if it was still running.
	if calls < len(*pids) {
		t.Fatalf("%d group signals for %d processes", calls, len(*pids))
	}
}

// grokCommandRequest is a request for a task of the Grok stand-in that leaves a command running
// in a session of its own, as grok starts its commands; the command's pid goes to the file.
func grokCommandRequest(t *testing.T, task string) (Request, string) {
	t.Helper()
	req := fakeRequest(t, "grok", task)
	file := filepath.Join(t.TempDir(), "helper.pid")
	req.Env = append(req.Env, "MM_GROK_HELPER="+file)
	return req, file
}

// A kill of grok's group does not reach the commands it started: they run in sessions of their
// own. grok stops them itself when it is told to cancel and when its input ends, so a cancelled
// task tells it, and a closed session ends its input and gives it grokExitGrace before the kill.
func TestGrokCommandsEndWithTheTask(t *testing.T) {
	t.Run("cancelled task", func(t *testing.T) {
		var sessions Sessions
		defer sessions.Close()
		req, file := grokCommandRequest(t, "command")
		started := make(chan struct{}, 1)
		req.Progress = func(string) {
			select {
			case started <- struct{}{}:
			default:
			}
		}
		var server int
		req.Process = func(pid int) { server = pid }
		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan error, 1)
		go func() { _, err := sessions.Run(ctx, "chat", req); done <- err }()
		<-started
		helper := helperPID(t, file)
		if state := procState(helper); state == "" || state == "Z" {
			t.Fatalf("command %d is not running (state %q)", helper, state)
		}
		cancel()
		if err := <-done; err != context.Canceled {
			t.Fatalf("err = %v", err)
		}
		if state := waitGone(helper, false, reapWithin); state != "" {
			t.Fatalf("command %d is still in state %q after the task was cancelled", helper, state)
		}
		if state := waitGone(server, false, reapWithin); state != "" {
			t.Fatalf("server %d is still in state %q after the task was cancelled", server, state)
		}
	})
	for _, how := range []string{"reset", "close"} {
		t.Run("idle session, "+how, func(t *testing.T) {
			var sessions Sessions
			defer sessions.Close()
			req, file := grokCommandRequest(t, "background")
			var server int
			req.Process = func(pid int) { server = pid }
			runOK(t, &sessions, req, "done")
			helper := helperPID(t, file)
			if state := procState(helper); state == "" || state == "Z" {
				t.Fatalf("command %d is not running (state %q)", helper, state)
			}
			if how == "reset" {
				sessions.Reset("chat")
			} else {
				sessions.Close()
			}
			if state := waitGone(helper, false, reapWithin); state != "" {
				t.Fatalf("command %d is still in state %q after the session was closed", helper, state)
			}
			if state := waitGone(server, false, reapWithin); state != "" {
				t.Fatalf("server %d is still in state %q after the session was closed", server, state)
			}
		})
	}
}
