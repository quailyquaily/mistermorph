package consolecmd

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/quailyquaily/mistermorph/internal/wechatlogin"
)

// wechatLoginTTL bounds how long an unfinished login is kept; WeChat expires the QR code sooner.
const wechatLoginTTL = 10 * time.Minute

type wechatLoginEntry struct {
	session   *wechatlogin.Session
	expiresAt time.Time
}

// wechatLoginStore holds the QR logins started from Console. The bot token never leaves the
// server: a confirmed login is saved straight to the keyring and config.
type wechatLoginStore struct {
	mu       sync.Mutex
	sessions map[string]wechatLoginEntry
	// options reach a test server instead of WeChat.
	options wechatlogin.Options
}

func newWeChatLoginStore() *wechatLoginStore {
	return &wechatLoginStore{sessions: map[string]wechatLoginEntry{}}
}

func (s *wechatLoginStore) create(session *wechatlogin.Session) (string, error) {
	id, err := randomOpaqueID()
	if err != nil {
		return "", err
	}
	now := time.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pruneLocked(now)
	s.sessions[id] = wechatLoginEntry{session: session, expiresAt: now.Add(wechatLoginTTL)}
	return id, nil
}

func (s *wechatLoginStore) get(id string) (*wechatlogin.Session, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pruneLocked(time.Now())
	entry, ok := s.sessions[strings.TrimSpace(id)]
	return entry.session, ok
}

func (s *wechatLoginStore) delete(id string) {
	s.mu.Lock()
	delete(s.sessions, strings.TrimSpace(id))
	s.mu.Unlock()
}

func (s *wechatLoginStore) pruneLocked(now time.Time) {
	for id, entry := range s.sessions {
		if !entry.expiresAt.After(now) {
			delete(s.sessions, id)
		}
	}
}

// handleWeChatLoginStart asks WeChat for a QR code. The browser renders qr_url as a QR code.
func (s *server) handleWeChatLoginStart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	session, err := wechatlogin.Start(r.Context(), s.wechatLogins.options)
	if err != nil {
		writeError(w, http.StatusBadGateway, fmt.Sprintf("wechat login: %v", err))
		return
	}
	id, err := s.wechatLogins.create(session)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create wechat login session")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":         true,
		"session_id": id,
		"qr_url":     session.Image(),
	})
}

// handleWeChatLoginPoll waits for the login's next status (a long poll of up to about 35 seconds).
// A confirmed login is saved; the config poller then restarts the WeChat runtime if it runs here.
func (s *server) handleWeChatLoginPoll(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req struct {
		SessionID  string `json:"session_id"`
		VerifyCode string `json:"verify_code"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid json")
		return
	}
	session, ok := s.wechatLogins.get(req.SessionID)
	if !ok {
		writeError(w, http.StatusNotFound, "wechat login not found or expired; start again")
		return
	}
	step, err := session.Poll(r.Context(), req.VerifyCode)
	if err != nil {
		writeError(w, http.StatusBadGateway, fmt.Sprintf("wechat login: %v", err))
		return
	}
	response := map[string]any{
		"ok":      true,
		"status":  step.Status,
		"message": step.Message,
		"done":    step.Done,
	}
	if !step.Done {
		writeJSON(w, http.StatusOK, response)
		return
	}
	s.wechatLogins.delete(req.SessionID)
	if step.Result == nil {
		writeJSON(w, http.StatusOK, response)
		return
	}
	configPath, err := resolveConsoleConfigPath()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.settingsWriteMu.Lock()
	err = wechatlogin.Save(r.Context(), configPath, s.secretStore, *step.Result)
	s.settingsWriteMu.Unlock()
	if errors.Is(err, wechatlogin.ErrKeyringUnavailable) {
		writeError(w, http.StatusServiceUnavailable, "the system keyring is not available, so the WeChat token cannot be saved; run `morph wechat login` in a terminal instead")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	response["connected"] = true
	response["bot_id"] = step.Result.BotID
	response["user_id"] = step.Result.UserID
	writeJSON(w, http.StatusOK, response)
}

// handleWeChatLogout removes the bound bot's credentials from config and the keyring.
func (s *server) handleWeChatLogout(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	configPath, err := resolveConsoleConfigPath()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.settingsWriteMu.Lock()
	err = wechatlogin.Unbind(r.Context(), configPath, s.secretStore)
	s.settingsWriteMu.Unlock()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}
