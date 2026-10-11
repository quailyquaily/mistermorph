// Package xlogin keeps the X account a login authorized in file_state_dir/auth/x.json, next to the
// other logins (codex.json, xai.json). The X runtime reads the token pair there and saves each
// rotated refresh token back.
package xlogin

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/quailyquaily/mistermorph/internal/fsstore"
	"github.com/quailyquaily/mistermorph/internal/pathutil"
	"github.com/quailyquaily/mistermorph/internal/xapi"
)

// TokenPath is where the token pair is kept.
func TokenPath(stateDir string) string {
	return filepath.Clean(filepath.Join(pathutil.ResolveStateDir(stateDir), "auth", "x.json"))
}

// Store keeps the token pair for the X client.
type Store struct{ StateDir string }

func (s Store) Load() (xapi.Token, bool) {
	var token xapi.Token
	ok, err := fsstore.ReadJSON(TokenPath(s.StateDir), &token)
	return token, ok && err == nil && token.RefreshToken != ""
}

func (s Store) Save(token xapi.Token) error {
	return fsstore.WriteJSONAtomic(TokenPath(s.StateDir), token, fsstore.FileOptions{DirPerm: 0o700, FilePerm: 0o600})
}

// Status is the account a saved login authorized; LoggedIn is false without one.
type Status struct {
	LoggedIn bool   `json:"logged_in"`
	UserID   string `json:"user_id,omitempty"`
	Username string `json:"username,omitempty"`
}

// Load reads the saved login.
func Load(stateDir string) Status {
	token, ok := Store{StateDir: stateDir}.Load()
	if !ok {
		return Status{}
	}
	return Status{LoggedIn: true, UserID: token.UserID, Username: token.Username}
}

// Save keeps a new login.
func Save(stateDir string, token xapi.Token) error {
	if err := (Store{StateDir: stateDir}).Save(token); err != nil {
		return fmt.Errorf("save the x login: %w", err)
	}
	return nil
}

// Logout forgets the login.
func Logout(stateDir string) error {
	if err := os.Remove(TokenPath(stateDir)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

// Configured reports whether the X runtime can authenticate: a saved login, or a refresh token in
// config.
func Configured(stateDir, configuredRefreshToken string) bool {
	return strings.TrimSpace(configuredRefreshToken) != "" || Load(stateDir).LoggedIn
}
