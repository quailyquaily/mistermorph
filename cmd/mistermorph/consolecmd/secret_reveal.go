package consolecmd

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/quailyquaily/mistermorph/internal/configsettings"
	"github.com/quailyquaily/mistermorph/internal/configutil"
	"github.com/quailyquaily/mistermorph/internal/secref"
	"github.com/spf13/viper"
	"gopkg.in/yaml.v3"
)

// Revealing a stored secret: the settings APIs never send a secret to the browser, so a person who
// wants to see one asks for it here, one field at a time. When the console has a password it is
// asked for again, failures count toward the login lockout, and every reveal is logged.

// Secrets that are never revealed: the console's own credentials and the runtime's token.
var unrevealableSecretPaths = map[string]bool{
	"console.password":      true,
	"console.password_hash": true,
	"server.auth_token":     true,
}

// The secret fields of an LLM profile, under llm.profiles.<name>.
var revealableProfileSecretPath = regexp.MustCompile(`^llm\.profiles\.[A-Za-z0-9_-]+\.(api_key|bedrock\.aws_key|bedrock\.aws_secret|bedrock\.aws_session_token|cloudflare\.api_token)$`)

// revealableSecretPath reports whether path is a secret field that may be revealed: one the
// settings mark sensitive, or an LLM profile's credential.
func revealableSecretPath(path string) bool {
	if path == "" || unrevealableSecretPaths[path] {
		return false
	}
	if revealableProfileSecretPath.MatchString(path) {
		return true
	}
	for _, fields := range [][]configsettings.Field{configsettings.AgentFields(), configsettings.ConsoleFields(), configsettings.SystemFields()} {
		for _, field := range fields {
			if field.Sensitive && field.Path == path {
				return true
			}
		}
	}
	return false
}

// yamlScalarAtPath returns the scalar value at a dotted path in a YAML document.
func yamlScalarAtPath(raw []byte, path string) (string, bool) {
	var doc yaml.Node
	if err := yaml.Unmarshal(raw, &doc); err != nil || len(doc.Content) == 0 {
		return "", false
	}
	node := doc.Content[0]
	for _, key := range strings.Split(path, ".") {
		if node.Kind != yaml.MappingNode {
			return "", false
		}
		var next *yaml.Node
		for i := 0; i+1 < len(node.Content); i += 2 {
			if node.Content[i].Value == key {
				next = node.Content[i+1]
			}
		}
		if next == nil {
			return "", false
		}
		node = next
	}
	if node.Kind != yaml.ScalarNode {
		return "", false
	}
	return node.Value, true
}

func (s *server) handleSecretsInfo(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"store":             secref.OSStoreName(),
		"reveal":            strings.TrimSpace(s.cfg.configPath) != "",
		"password_required": !s.cfg.authDisabled(),
	})
}

func (s *server) handleSecretReveal(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	var req struct {
		Path     string `json:"path"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid json")
		return
	}
	path := strings.TrimSpace(req.Path)
	if !revealableSecretPath(path) {
		writeError(w, http.StatusBadRequest, "not a secret that can be revealed")
		return
	}
	ip := clientIP(r.RemoteAddr)
	if !s.cfg.authDisabled() {
		// The password again, under the login's lockout. A wrong one is 403, not 401: the session
		// itself is fine.
		now := time.Now().UTC()
		key := "console@" + ip
		if remaining, locked := s.limiter.CheckLocked(key, now); locked {
			w.Header().Set("Retry-After", strconv.Itoa(int(remaining.Seconds())+1))
			writeError(w, http.StatusTooManyRequests, "too many failed attempts")
			return
		}
		if s.password == nil || !s.password.Verify(req.Password) {
			s.limiter.RecordFailure(ip, key, now)
			time.Sleep(s.limiter.FailureDelay())
			writeError(w, http.StatusForbidden, "incorrect password")
			return
		}
		s.limiter.RecordSuccess(ip, key, now)
	}
	configPath := strings.TrimSpace(s.cfg.configPath)
	if configPath == "" {
		writeError(w, http.StatusServiceUnavailable, "no config file")
		return
	}
	raw, err := os.ReadFile(configPath)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "config file could not be read")
		return
	}
	value, ok := yamlScalarAtPath(raw, path)
	if !ok || strings.TrimSpace(value) == "" {
		writeError(w, http.StatusNotFound, "secret is not set")
		return
	}
	reader := viper.GetViper()
	if s.localRuntime != nil {
		reader = s.localRuntime.currentConfigReader()
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	result, err := secref.ResolveString(ctx, value, configutil.SecretRefSourceFromReader(reader), secref.Options{EnvMissing: secref.EnvMissingError})
	if err != nil {
		status := http.StatusServiceUnavailable
		if errors.Is(err, secref.ErrOSSecretNotFound) {
			status = http.StatusNotFound
		}
		writeError(w, status, strings.TrimSpace(err.Error()))
		return
	}
	s.logger().Info("console_secret_revealed", "path", path, "remote_ip", ip)
	writeJSON(w, http.StatusOK, map[string]any{"value": result.Value})
}
