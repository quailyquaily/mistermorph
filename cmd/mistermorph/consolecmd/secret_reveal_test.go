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

func revealTestServer(t *testing.T, password string) *server {
	t.Helper()
	configPath := filepath.Join(t.TempDir(), "config.yaml")
	config := `llm:
  api_key: "plain-key"
  profiles:
    backup:
      api_key: "${REVEAL_TEST_KEY}"
telegram:
  bot_token: ""
console:
  password: "hunter2"
`
	if err := os.WriteFile(configPath, []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}
	srv := &server{cfg: serveConfig{configPath: configPath, password: password}, limiter: newLoginLimiter()}
	if password != "" {
		verifier, err := newPasswordVerifier(password, "")
		if err != nil {
			t.Fatal(err)
		}
		srv.password = verifier
	}
	return srv
}

func reveal(srv *server, body string) (int, string) {
	req := httptest.NewRequest(http.MethodPost, "/api/secrets/reveal", strings.NewReader(body))
	rec := httptest.NewRecorder()
	srv.handleSecretReveal(rec, req)
	var payload struct {
		Value string `json:"value"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &payload)
	return rec.Code, payload.Value
}

func TestSecretRevealResolvesStoredSecrets(t *testing.T) {
	t.Setenv("REVEAL_TEST_KEY", "from-env")
	srv := revealTestServer(t, "")
	for _, tc := range []struct {
		name, body string
		status     int
		value      string
	}{
		{"plain text", `{"path":"llm.api_key"}`, 200, "plain-key"},
		{"env reference in a profile", `{"path":"llm.profiles.backup.api_key"}`, 200, "from-env"},
		{"unset", `{"path":"telegram.bot_token"}`, 404, ""},
		{"never the console password", `{"path":"console.password"}`, 400, ""},
		{"not a secret", `{"path":"llm.model"}`, 400, ""},
		{"not a profile secret", `{"path":"llm.profiles.backup.model"}`, 400, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			status, value := reveal(srv, tc.body)
			if status != tc.status || value != tc.value {
				t.Fatalf("reveal = %d %q, want %d %q", status, value, tc.status, tc.value)
			}
		})
	}
}

func TestSecretRevealAsksForThePassword(t *testing.T) {
	srv := revealTestServer(t, "secret")
	srv.limiter.delayMin, srv.limiter.delayMax = 0, 0
	if status, _ := reveal(srv, `{"path":"llm.api_key"}`); status != http.StatusForbidden {
		t.Fatalf("without password: status = %d, want 403", status)
	}
	if status, _ := reveal(srv, `{"path":"llm.api_key","password":"wrong"}`); status != http.StatusForbidden {
		t.Fatalf("wrong password: status = %d, want 403", status)
	}
	if status, value := reveal(srv, `{"path":"llm.api_key","password":"secret"}`); status != 200 || value != "plain-key" {
		t.Fatalf("right password: reveal = %d %q", status, value)
	}
}
