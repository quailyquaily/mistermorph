package consolecmd

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSecretKeysListsEachKeyOnce(t *testing.T) {
	t.Setenv("SECRET_KEYS_TEST_KEY", "sk-env-abcdefghijklmnopqrstuvwxyz9876")
	configPath := filepath.Join(t.TempDir(), "config.yaml")
	config := `llm:
  api_key: "sk-proj-abcdefghijklmnopqrstuvwxyz1234"
  profiles:
    ears:
      api_key: "sk-proj-abcdefghijklmnopqrstuvwxyz1234"
    backup:
      api_key: "${SECRET_KEYS_TEST_KEY}"
telegram:
  bot_token: "${SECRET_KEYS_TEST_MISSING}"
console:
  password: "hunter2"
`
	if err := os.WriteFile(configPath, []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}
	srv := &server{cfg: serveConfig{configPath: configPath}, limiter: newLoginLimiter()}

	rec := httptest.NewRecorder()
	srv.handleSecretKeys(rec, httptest.NewRequest(http.MethodGet, "/api/secrets/keys", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	for _, secret := range []string{"abcdefghijklmnopqrstuvwxyz", "hunter2"} {
		if strings.Contains(body, secret) {
			t.Fatalf("response contains a secret: %s", body)
		}
	}
	var payload struct {
		Available bool               `json:"available"`
		Keys      []secretKeyPayload `json:"keys"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if !payload.Available || len(payload.Keys) != 3 {
		t.Fatalf("keys = %+v, want 3", payload.Keys)
	}
	byPath := map[string]secretKeyPayload{}
	for _, key := range payload.Keys {
		for _, path := range key.UsedBy {
			byPath[path] = key
		}
	}

	shared := byPath["llm.api_key"]
	if shared.Kind != "file" || shared.Ref != "" || shared.RevealPath != "llm.api_key" || shared.Hint != "sk-proj-…1234" {
		t.Fatalf("plain-text key = %+v", shared)
	}
	if len(shared.UsedBy) != 2 || shared.UsedBy[1] != "llm.profiles.ears.api_key" {
		t.Fatalf("plain-text key used by %v, want llm.api_key and the ears profile", shared.UsedBy)
	}

	env := byPath["llm.profiles.backup.api_key"]
	if env.Kind != "env" || env.Ref != "${SECRET_KEYS_TEST_KEY}" || env.Hint != "sk-env-…9876" || env.Unavailable {
		t.Fatalf("env key = %+v", env)
	}

	missing := byPath["telegram.bot_token"]
	if !missing.Unavailable || missing.Ref != "${SECRET_KEYS_TEST_MISSING}" {
		t.Fatalf("missing env key = %+v, want unavailable", missing)
	}
}

func TestSecretKeysWithoutAConfigFile(t *testing.T) {
	srv := &server{}
	rec := httptest.NewRecorder()
	srv.handleSecretKeys(rec, httptest.NewRequest(http.MethodGet, "/api/secrets/keys", nil))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"available":false`) {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
}
