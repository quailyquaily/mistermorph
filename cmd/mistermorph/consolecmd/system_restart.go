package consolecmd

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
	"github.com/quailyquaily/mistermorph/internal/processrestart"
)

// restartResponseDelay lets the restart response reach the browser before the server stops.
const restartResponseDelay = 300 * time.Millisecond

type systemRestartRequest struct {
	// Force restarts even while tasks run; they are stopped as on SIGTERM.
	Force bool `json:"force"`
}

type systemRestartResponse struct {
	Restarting   bool `json:"restarting"`
	RunningTasks int  `json:"running_tasks"`
}

// handleSystemRestart restarts the Console process with the arguments and environment it started
// with: the server shuts down as on SIGTERM, then main re-executes the binary (see processrestart).
// Without force, it refuses while Console tasks are running or queued.
func (s *server) handleSystemRestart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req systemRestartRequest
	if r.Body != nil {
		_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req)
	}
	running := s.runningConsoleTasks()
	if running > 0 && !req.Force {
		writeJSON(w, http.StatusConflict, systemRestartResponse{RunningTasks: running})
		return
	}
	s.stopMu.Lock()
	stop := s.stopServing
	s.stopMu.Unlock()
	if stop == nil {
		writeError(w, http.StatusServiceUnavailable, "the console is not serving")
		return
	}
	writeJSON(w, http.StatusAccepted, systemRestartResponse{Restarting: true, RunningTasks: running})
	go func() {
		time.Sleep(restartResponseDelay)
		processrestart.Request()
		stop()
	}()
}

// runningConsoleTasks counts the Console's queued and running tasks.
func (s *server) runningConsoleTasks() int {
	if s == nil || s.localRuntime == nil || s.localRuntime.store == nil {
		return 0
	}
	count := 0
	for _, status := range []daemonruntime.TaskStatus{daemonruntime.TaskQueued, daemonruntime.TaskRunning} {
		count += len(s.localRuntime.store.List(daemonruntime.TaskListOptions{Status: status, Limit: 1000}))
	}
	return count
}
