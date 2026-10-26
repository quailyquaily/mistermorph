package consolecmd

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
	"github.com/quailyquaily/mistermorph/internal/elevate"
	"github.com/quailyquaily/mistermorph/internal/elevate/seal"
)

// An elevated command of a task started from the Console chat or chat asks there for the sudo
// password, encrypted end to end (docs/feat/feat_20261026_elevation_client_approval.md).

const (
	consoleElevationOpen     = "open"
	consoleElevationAllowed  = "allowed"
	consoleElevationDeclined = "declined"
	consoleElevationExpired  = "expired"
	consoleElevationRejected = "rejected"
)

// elevationIdentityFile is where the runtime keeps its identity key, under file_state_dir.
const elevationIdentityFile = "elevation_identity"

// consoleElevation is one approval card: an elevated command waiting for the user's password, or
// how it ended. Offer is there only while it is open.
type consoleElevation struct {
	ID       string `json:"id"`
	Command  string `json:"command"`
	Cwd      string `json:"cwd,omitempty"`
	Host     string `json:"host,omitempty"`
	Deadline int64  `json:"deadline"`
	// Attempt is 2 and up after sudo refused the password.
	Attempt int    `json:"attempt,omitempty"`
	Status  string `json:"status"`
	// WebInsecure is tools.bash.elevation.web_insecure: what the web Console does on plain HTTP.
	WebInsecure string      `json:"web_insecure,omitempty"`
	Offer       *seal.Offer `json:"offer,omitempty"`
}

func cloneConsoleElevations(in []consoleElevation) []consoleElevation {
	if len(in) == 0 {
		return nil
	}
	out := make([]consoleElevation, len(in))
	for i, e := range in {
		out[i] = e
		if e.Offer != nil {
			offer := *e.Offer
			out[i].Offer = &offer
		}
	}
	return out
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
	t.elevations[index].Offer = nil
	t.mu.Unlock()
	t.publish()
}

// consoleElevations holds the runtime's identity and its open approvals, across tasks.
type consoleElevations struct {
	logger *slog.Logger

	identityMu   sync.Mutex
	identityPath string
	identity     *seal.Identity

	mu   sync.Mutex
	open map[string]*pendingElevation
}

type pendingElevation struct {
	taskID  string
	command string
	opener  *seal.Opener
	// answered gets how the approval ended; it holds one value.
	answered chan elevationOutcome
}

// elevationOutcome is an answered approval: allowed with the password, declined, or rejected (the
// answer could not be used) with why.
type elevationOutcome struct {
	status   string
	password []byte
	err      error
}

func newConsoleElevations(logger *slog.Logger) *consoleElevations {
	if logger == nil {
		logger = slog.Default()
	}
	return &consoleElevations{logger: logger, open: map[string]*pendingElevation{}}
}

// loadIdentity reads (or makes) the identity kept in stateDir, once per directory.
func (e *consoleElevations) loadIdentity(stateDir string) (*seal.Identity, error) {
	path := filepath.Join(stateDir, elevationIdentityFile)
	e.identityMu.Lock()
	defer e.identityMu.Unlock()
	if e.identity != nil && e.identityPath == path {
		return e.identity, nil
	}
	identity, err := seal.LoadIdentity(path)
	if err != nil {
		return nil, err
	}
	e.identity, e.identityPath = identity, path
	e.logger.Info("elevation_identity", "fingerprint", seal.Fingerprint(identity.PublicKey()), "path", path)
	return identity, nil
}

// approver asks for the task's elevated commands on its approval cards.
func (e *consoleElevations) approver(stateDir, webInsecure string, cards *consoleTaskElevations) elevate.Approver {
	host, _ := os.Hostname()
	return elevate.ApproverFunc(func(ctx context.Context, req elevate.Request) (string, error) {
		identity, err := e.loadIdentity(stateDir)
		if err != nil {
			return "", err
		}
		id, err := newElevationID()
		if err != nil {
			return "", err
		}
		deadline := time.Unix(req.Deadline.Unix(), 0)
		opener, offer, err := identity.Offer(seal.Binding{
			ElevationID: id,
			TaskID:      cards.taskID,
			Command:     req.Command,
			Dir:         req.Dir,
			Deadline:    deadline,
		})
		if err != nil {
			return "", err
		}
		defer opener.Close()
		pending := &pendingElevation{taskID: cards.taskID, command: req.Command, opener: opener, answered: make(chan elevationOutcome, 1)}
		e.mu.Lock()
		e.open[id] = pending
		e.mu.Unlock()
		defer func() {
			e.mu.Lock()
			delete(e.open, id)
			e.mu.Unlock()
		}()
		attempt := req.Attempt
		if attempt <= 1 {
			attempt = 0
		}
		index := cards.add(consoleElevation{
			ID:          id,
			Command:     req.Command,
			Cwd:         req.Dir,
			Host:        host,
			Deadline:    deadline.Unix(),
			Attempt:     attempt,
			Status:      consoleElevationOpen,
			WebInsecure: webInsecure,
			Offer:       &offer,
		})
		select {
		case outcome := <-pending.answered:
			cards.settle(index, outcome.status)
			switch outcome.status {
			case consoleElevationAllowed:
				defer clear(outcome.password)
				return string(outcome.password), nil
			case consoleElevationDeclined:
				return "", elevate.ErrDeclined
			}
			return "", outcome.err
		case <-ctx.Done():
			cards.settle(index, consoleElevationExpired)
			return "", elevate.ErrTimedOut
		}
	})
}

// answer takes the answer to open approval req.ElevationID of task req.TaskID: a decline, or the
// sealed password, opened here once. A sealed answer that does not open closes the approval.
func (e *consoleElevations) answer(req daemonruntime.AnswerElevationRequest) (daemonruntime.AnswerElevationResponse, error) {
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
		pending.opener.Close()
		pending.answered <- elevationOutcome{status: consoleElevationDeclined}
		e.logger.Info("elevated_command_declined", audit...)
		return daemonruntime.AnswerElevationResponse{Accepted: true}, nil
	}
	if req.WebDenied {
		pending.opener.Close()
		err := errors.New("this Console is not on HTTPS, and tools.bash.elevation.web_insecure is deny: approve from HTTPS, an SSH tunnel or chat")
		pending.answered <- elevationOutcome{status: consoleElevationRejected, err: err}
		e.logger.Warn("elevated_command_answer_rejected", append(audit, "reason", "web_insecure: deny")...)
		return daemonruntime.AnswerElevationResponse{}, daemonruntime.BadRequest(err.Error())
	}
	password, err := pending.opener.Open(req.Answer)
	if err != nil {
		pending.answered <- elevationOutcome{status: consoleElevationRejected, err: err}
		e.logger.Warn("elevated_command_answer_rejected", append(audit, "error", err.Error())...)
		return daemonruntime.AnswerElevationResponse{}, daemonruntime.BadRequest(err.Error())
	}
	pending.answered <- elevationOutcome{status: consoleElevationAllowed, password: password}
	e.logger.Info("elevated_command_approved", audit...)
	return daemonruntime.AnswerElevationResponse{Accepted: true}, nil
}

// identityInfo is the runtime's identity for clients to pin or show.
func (e *consoleElevations) identityInfo(stateDir string) (daemonruntime.ElevationIdentity, error) {
	identity, err := e.loadIdentity(stateDir)
	if err != nil {
		return daemonruntime.ElevationIdentity{}, err
	}
	return daemonruntime.ElevationIdentity{
		Identity:    seal.EncodePublicKey(identity.PublicKey()),
		Fingerprint: seal.Fingerprint(identity.PublicKey()),
	}, nil
}

func newElevationID() (string, error) {
	raw := make([]byte, 12)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return "el_" + hex.EncodeToString(raw), nil
}

// consoleElevationWebInsecure is tools.bash.elevation.web_insecure, "warn" unless it says "deny".
func consoleElevationWebInsecure(value string) string {
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
	if req.Client == "web" && req.Transport != "secure" {
		if reader := r.currentConfigReader(); reader != nil && consoleElevationWebInsecure(reader.GetString("tools.bash.elevation.web_insecure")) == "deny" {
			req.WebDenied = true
		}
	}
	return r.elevations.answer(req)
}

func (r *consoleLocalRuntime) elevationIdentity(context.Context) (daemonruntime.ElevationIdentity, error) {
	if r == nil || r.elevations == nil {
		return daemonruntime.ElevationIdentity{}, errors.New("elevated commands are not approved here")
	}
	return r.elevations.identityInfo(r.runtimePaths.StateDir)
}
