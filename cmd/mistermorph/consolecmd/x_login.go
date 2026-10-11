package consolecmd

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/quailyquaily/mistermorph/internal/xapi"
	"github.com/quailyquaily/mistermorph/internal/xlogin"
)

// xLoginTTL bounds how long an unfinished login listens for X's redirect.
const xLoginTTL = 10 * time.Minute

// xLoginPollWait is how long one poll waits for the person to come back from X.
const xLoginPollWait = 25 * time.Second

// xLoginStore holds the one X login started from Console. Its callback listens on the redirect URL
// registered for the X app (127.0.0.1), so the browser must run on the Console's machine.
type xLoginStore struct {
	mu        sync.Mutex
	id        string
	session   *xapi.LoginSession
	expiresAt time.Time
	// options reach a test server instead of X.
	options xapi.LoginOptions
}

func newXLoginStore() *xLoginStore { return &xLoginStore{} }

// replace starts tracking session, closing the login it replaces: only one can listen.
func (s *xLoginStore) replace(session *xapi.LoginSession) (string, error) {
	id, err := randomOpaqueID()
	if err != nil {
		return "", err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.session.Close()
	s.id, s.session, s.expiresAt = id, session, time.Now().Add(xLoginTTL)
	return id, nil
}

func (s *xLoginStore) closeCurrent() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.session.Close()
	s.id, s.session = "", nil
}

func (s *xLoginStore) get(id string) (*xapi.LoginSession, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.session != nil && !s.expiresAt.After(time.Now()) {
		s.session.Close()
		s.id, s.session = "", nil
	}
	if s.session == nil || s.id != strings.TrimSpace(id) {
		return nil, false
	}
	return s.session, true
}

func (s *xLoginStore) finish(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.id == strings.TrimSpace(id) {
		s.session.Close()
		s.id, s.session = "", nil
	}
}

// handleXLoginStart starts the OAuth login and returns the page to open.
func (s *server) handleXLoginStart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	reader := s.currentRuntimeConfigReader()
	opts := s.xLogins.options
	opts.ClientID = strings.TrimSpace(reader.GetString("x.client_id"))
	opts.ClientSecret = strings.TrimSpace(reader.GetString("x.client_secret"))
	if opts.BaseURL == "" {
		opts.BaseURL = strings.TrimSpace(reader.GetString("x.base_url"))
	}
	if opts.ClientID == "" {
		writeError(w, http.StatusBadRequest, "save the X app's client ID first")
		return
	}
	// A login still listening holds the callback port; it is replaced.
	s.xLogins.closeCurrent()
	session, err := xapi.StartLogin(opts)
	if err != nil {
		writeError(w, http.StatusConflict, fmt.Sprintf("x login: %v", err))
		return
	}
	id, err := s.xLogins.replace(session)
	if err != nil {
		session.Close()
		writeError(w, http.StatusInternalServerError, "failed to create x login session")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "session_id": id, "authorize_url": session.AuthorizeURL})
}

// handleXLoginPoll waits up to xLoginPollWait for the person to come back from X. A finished
// login is saved, and the managed runtimes restart so a running X runtime uses it.
func (s *server) handleXLoginPoll(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req struct {
		SessionID string `json:"session_id"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid json")
		return
	}
	session, ok := s.xLogins.get(req.SessionID)
	if !ok {
		writeError(w, http.StatusNotFound, "x login not found or expired; start again")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), xLoginPollWait)
	defer cancel()
	token, err := session.Wait(ctx)
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "done": false})
		return
	}
	s.xLogins.finish(req.SessionID)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "done": true, "error": err.Error()})
		return
	}
	reader := s.currentRuntimeConfigReader()
	if err := xlogin.Save(reader.GetString("file_state_dir"), token); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.reloadManagedRuntimesForLogin()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "done": true, "connected": true, "username": token.Username})
}

// handleXLogout forgets the saved X login.
func (s *server) handleXLogout(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if err := xlogin.Logout(s.currentRuntimeConfigReader().GetString("file_state_dir")); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.reloadManagedRuntimesForLogin()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// reloadManagedRuntimesForLogin restarts the managed runtimes after a login changed outside config,
// which the config poller would not notice.
func (s *server) reloadManagedRuntimesForLogin() {
	if s.managed == nil {
		return
	}
	if err := s.managed.ReloadConfig(s.currentRuntimeConfigReader()); err != nil {
		s.logger().Warn("managed_runtime_reload_after_login_failed", "error", err.Error())
	}
}
