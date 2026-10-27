package consolecmd

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"log/slog"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
	"github.com/quailyquaily/mistermorph/internal/elevate"
)

// An elevated command of a task started from the Console chat or chat asks there for the sudo
// password (docs/feat/feat_20261026_elevation_client_approval.md). The password is protected by the
// connection: HTTPS, loopback, an SSH tunnel or a VPN. tools.bash.elevation.insecure decides what
// happens on any other connection.

const (
	consoleElevationOpen     = "open"
	consoleElevationAllowed  = "allowed"
	consoleElevationDeclined = "declined"
	consoleElevationExpired  = "expired"
	consoleElevationRejected = "rejected"
)

// consoleElevation is one approval card: an elevated command waiting for the user's password, or
// how it ended.
type consoleElevation struct {
	ID       string `json:"id"`
	Command  string `json:"command"`
	Cwd      string `json:"cwd,omitempty"`
	Host     string `json:"host,omitempty"`
	Deadline int64  `json:"deadline"`
	// Attempt is 2 and up after sudo refused the password.
	Attempt int    `json:"attempt,omitempty"`
	Status  string `json:"status"`
	// Insecure is tools.bash.elevation.insecure: what an answer on a connection that is not
	// encrypted gets, "warn" or "deny".
	Insecure string `json:"insecure,omitempty"`
}

func cloneConsoleElevations(in []consoleElevation) []consoleElevation {
	if len(in) == 0 {
		return nil
	}
	return append([]consoleElevation(nil), in...)
}

// consoleTaskElevations keeps a task's approval cards and publishes each change to the chat.
type consoleTaskElevations struct {
	mu         sync.Mutex
	taskID     string
	hub        *consoleStreamHub
	elevations []consoleElevation
}

func (t *consoleTaskElevations) snapshot() []consoleElevation {
	t.mu.Lock()
	defer t.mu.Unlock()
	return cloneConsoleElevations(t.elevations)
}

func (t *consoleTaskElevations) publish() {
	if t.hub != nil {
		t.hub.PublishElevations(t.taskID, t.snapshot())
	}
}

func (t *consoleTaskElevations) add(e consoleElevation) int {
	t.mu.Lock()
	t.elevations = append(t.elevations, e)
	index := len(t.elevations) - 1
	t.mu.Unlock()
	t.publish()
	return index
}

func (t *consoleTaskElevations) settle(index int, status string) {
	t.mu.Lock()
	t.elevations[index].Status = status
	t.mu.Unlock()
	t.publish()
}

// consoleElevations holds the runtime's open approvals, across tasks.
type consoleElevations struct {
	logger *slog.Logger

	mu   sync.Mutex
	open map[string]*pendingElevation
}

type pendingElevation struct {
	taskID  string
	command string
	// answered gets how the approval ended; it holds one value.
	answered chan elevationOutcome
}

// elevationOutcome is an answered approval: allowed with the password, declined, or rejected (the
// answer could not be used) with why.
type elevationOutcome struct {
	status   string
	password string
	err      error
}

func newConsoleElevations(logger *slog.Logger) *consoleElevations {
	if logger == nil {
		logger = slog.Default()
	}
	return &consoleElevations{logger: logger, open: map[string]*pendingElevation{}}
}

// approver asks for the task's elevated commands on its approval cards.
func (e *consoleElevations) approver(insecure string, cards *consoleTaskElevations) elevate.Approver {
	host, _ := os.Hostname()
	return elevate.ApproverFunc(func(ctx context.Context, req elevate.Request) (string, error) {
		id, err := newElevationID()
		if err != nil {
			return "", err
		}
		deadline := time.Unix(req.Deadline.Unix(), 0)
		pending := &pendingElevation{taskID: cards.taskID, command: req.Command, answered: make(chan elevationOutcome, 1)}
		e.mu.Lock()
		e.open[id] = pending
		e.mu.Unlock()
		// closeOpen ends the approval for answers; it reports false when an answer took it first.
		closeOpen := func() bool {
			e.mu.Lock()
			defer e.mu.Unlock()
			if e.open[id] != pending {
				return false
			}
			delete(e.open, id)
			return true
		}
		defer closeOpen()
		attempt := req.Attempt
		if attempt <= 1 {
			attempt = 0
		}
		index := cards.add(consoleElevation{
			ID:       id,
			Command:  req.Command,
			Cwd:      req.Dir,
			Host:     host,
			Deadline: deadline.Unix(),
			Attempt:  attempt,
			Status:   consoleElevationOpen,
			Insecure: insecure,
		})
		var outcome elevationOutcome
		select {
		case outcome = <-pending.answered:
		case <-ctx.Done():
			if closeOpen() {
				cards.settle(index, consoleElevationExpired)
				return "", elevate.ErrTimedOut
			}
			// An answer took the approval as it expired; use it.
			outcome = <-pending.answered
		}
		cards.settle(index, outcome.status)
		switch outcome.status {
		case consoleElevationAllowed:
			return outcome.password, nil
		case consoleElevationDeclined:
			return "", elevate.ErrDeclined
		}
		return "", outcome.err
	})
}

// answer takes the answer to open approval req.ElevationID of task req.TaskID: a decline, or the
// password. An answer the policy refuses (deny on a connection that is not encrypted) closes the
// approval.
func (e *consoleElevations) answer(req daemonruntime.AnswerElevationRequest, denyInsecure bool) (daemonruntime.AnswerElevationResponse, error) {
	e.mu.Lock()
	pending := e.open[req.ElevationID]
	if pending != nil && pending.taskID == req.TaskID {
		delete(e.open, req.ElevationID)
	} else {
		pending = nil
	}
	e.mu.Unlock()
	if pending == nil {
		return daemonruntime.AnswerElevationResponse{}, nil
	}
	audit := []any{"task_id", req.TaskID, "elevation_id", req.ElevationID, "command", pending.command,
		"client", req.Client, "transport", req.Transport, "remote", req.Remote}
	if req.Decline {
		pending.answered <- elevationOutcome{status: consoleElevationDeclined}
		e.logger.Info("elevated_command_declined", audit...)
		return daemonruntime.AnswerElevationResponse{Accepted: true}, nil
	}
	if denyInsecure && req.Transport != daemonruntime.TransportSecure {
		err := errors.New("this connection is not encrypted, and tools.bash.elevation.insecure is deny: approve over HTTPS or an SSH tunnel")
		pending.answered <- elevationOutcome{status: consoleElevationRejected, err: err}
		e.logger.Warn("elevated_command_answer_rejected", append(audit, "reason", "insecure: deny")...)
		return daemonruntime.AnswerElevationResponse{}, daemonruntime.BadRequest(err.Error())
	}
	if req.Password == "" {
		err := errors.New("the answer carries no password")
		pending.answered <- elevationOutcome{status: consoleElevationRejected, err: err}
		e.logger.Warn("elevated_command_answer_rejected", append(audit, "reason", "no password")...)
		return daemonruntime.AnswerElevationResponse{}, daemonruntime.BadRequest(err.Error())
	}
	if req.Transport != daemonruntime.TransportSecure {
		e.logger.Warn("elevated_command_insecure_answer", audit...)
	}
	pending.answered <- elevationOutcome{status: consoleElevationAllowed, password: req.Password}
	e.logger.Info("elevated_command_approved", audit...)
	return daemonruntime.AnswerElevationResponse{Accepted: true}, nil
}

func newElevationID() (string, error) {
	raw := make([]byte, 12)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return "el_" + hex.EncodeToString(raw), nil
}

// consoleElevationInsecure is tools.bash.elevation.insecure, "warn" unless it says "deny".
func consoleElevationInsecure(value string) string {
	if strings.EqualFold(strings.TrimSpace(value), "deny") {
		return "deny"
	}
	return "warn"
}

// answerElevation answers an approval card of a running Console task.
func (r *consoleLocalRuntime) answerElevation(_ context.Context, req daemonruntime.AnswerElevationRequest) (daemonruntime.AnswerElevationResponse, error) {
	if strings.TrimSpace(req.TaskID) == "" || strings.TrimSpace(req.ElevationID) == "" {
		return daemonruntime.AnswerElevationResponse{}, daemonruntime.BadRequest("task_id and elevation_id are required")
	}
	if r == nil || r.elevations == nil {
		return daemonruntime.AnswerElevationResponse{}, nil
	}
	// The policy is read now, not when the card opened, and applies to every client: what a client
	// says it is cannot be checked.
	deny := false
	if reader := r.currentConfigReader(); reader != nil {
		deny = consoleElevationInsecure(reader.GetString("tools.bash.elevation.insecure")) == "deny"
	}
	return r.elevations.answer(req, deny)
}
