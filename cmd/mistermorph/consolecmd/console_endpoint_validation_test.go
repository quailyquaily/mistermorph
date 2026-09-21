package consolecmd

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func newConsoleEndpointTestRemote(t *testing.T, token string) *httptest.Server {
	t.Helper()
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/runtime/health":
			_, _ = io.WriteString(w, `{"mode":"console","ok":true}`)
		case "/runtime/tasks":
			if token != "" && r.Header.Get("Authorization") != "Bearer "+token {
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}
			_, _ = io.WriteString(w, `{"items":[]}`)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(remote.Close)
	return remote
}

func TestConsoleEndpointConnectionValidationBeforeSave(t *testing.T) {
	for _, tc := range []struct {
		name       string
		healthCode int
		healthBody string
		tasksCode  int
		tasksBody  string
		wantSaved  bool
	}{
		{name: "valid", healthCode: 200, healthBody: `{"mode":"console"}`, tasksCode: 200, tasksBody: `{"items":[]}`, wantSaved: true},
		{name: "health failure", healthCode: 503, healthBody: "unavailable"},
		{name: "wrong URL", healthCode: 200, healthBody: "<html>Console login</html>"},
		{name: "not a runtime", healthCode: 200, healthBody: `{}`},
		{name: "invalid token", healthCode: 200, healthBody: `{"mode":"console"}`, tasksCode: 401, tasksBody: "rejected-secret-token"},
		{name: "forbidden", healthCode: 200, healthBody: `{"mode":"console"}`, tasksCode: 403},
		{name: "runtime unavailable", healthCode: 200, healthBody: `{"mode":"console"}`, tasksCode: 503},
		{name: "invalid authenticated response", healthCode: 200, healthBody: `{"mode":"console"}`, tasksCode: 200, tasksBody: "<html>Login required</html>"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv, configPath := newEndpointReloadTestServer(t)
			store := &consoleSettingsTestOSStore{}
			srv.secretStore = store
			before, _ := os.ReadFile(configPath)
			localClient := srv.endpoints[0].Client
			var authChecked atomic.Bool
			remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/runtime/health":
					w.WriteHeader(tc.healthCode)
					_, _ = io.WriteString(w, tc.healthBody)
				case "/runtime/tasks":
					authChecked.Store(r.Header.Get("Authorization") == "Bearer rejected-secret-token")
					w.WriteHeader(tc.tasksCode)
					_, _ = io.WriteString(w, tc.tasksBody)
				default:
					http.NotFound(w, r)
				}
			}))
			defer remote.Close()
			rec := putEndpointReloadSettings(t, srv, []consoleEndpointSettingsPayload{{Name: "Remote", URL: remote.URL + "/runtime", AuthToken: "rejected-secret-token"}})
			if tc.wantSaved {
				requireEndpointReloadSaved(t, rec)
				if !authChecked.Load() || len(srv.endpoints) != 2 || len(store.values) != 1 {
					t.Fatal("save did not verify authentication and apply the endpoint")
				}
				return
			}
			if rec.Code != http.StatusBadGateway {
				t.Fatalf("status = %d, want 502", rec.Code)
			}
			after, _ := os.ReadFile(configPath)
			if string(after) != string(before) || len(srv.endpoints) != 1 || srv.endpoints[0].Client != localClient || len(store.puts) != 0 {
				t.Fatal("failed connection test changed configuration, runtime, or saved secrets")
			}
			if !strings.Contains(rec.Body.String(), "Remote") || strings.Contains(rec.Body.String(), "rejected-secret-token") {
				t.Fatalf("error must identify the endpoint without exposing its token: %s", rec.Body.String())
			}
		})
	}
}

func TestConsoleEndpointConnectionValidationDetectsConfigConflict(t *testing.T) {
	srv, configPath := newEndpointReloadTestServer(t)
	const changed = "console: {}\n# changed while testing connection\n"
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := os.WriteFile(configPath, []byte(changed), 0o600); err != nil {
			t.Error(err)
		}
		_, _ = io.WriteString(w, `{"mode":"console","items":[]}`)
	}))
	defer remote.Close()
	rec := putEndpointReloadSettings(t, srv, []consoleEndpointSettingsPayload{{Name: "Remote", URL: remote.URL, AuthToken: "token"}})
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409", rec.Code)
	}
	after, _ := os.ReadFile(configPath)
	if string(after) != changed || len(srv.endpoints) != 1 {
		t.Fatal("validation overwrote a newer configuration")
	}
}

func TestConsoleEndpointConnectionFailurePreservesExistingEndpoint(t *testing.T) {
	srv, configPath := newEndpointReloadTestServer(t)
	remote := newConsoleEndpointTestRemote(t, "valid-token")
	items := []consoleEndpointSettingsPayload{{Name: "Remote", URL: remote.URL + "/runtime", AuthToken: "valid-token"}}
	requireEndpointReloadSaved(t, putEndpointReloadSettings(t, srv, items))
	before, _ := os.ReadFile(configPath)
	client := srv.endpoints[1].Client
	items[0].AuthToken = "wrong-token"
	rec := putEndpointReloadSettings(t, srv, items)
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("invalid token accepted: %d", rec.Code)
	}
	after, _ := os.ReadFile(configPath)
	if string(after) != string(before) || srv.endpoints[1].Client != client {
		t.Fatal("failed validation replaced the saved or active endpoint")
	}
	remote.Close()
	items[0].AuthToken = "valid-token"
	other := newConsoleEndpointTestRemote(t, "other-token")
	items = append(items, consoleEndpointSettingsPayload{Name: "Other", URL: other.URL + "/runtime", AuthToken: "other-token"})
	requireEndpointReloadSaved(t, putEndpointReloadSettings(t, srv, items))
	requireEndpointReloadSaved(t, putEndpointReloadSettings(t, srv, items[1:]))
}

func TestConsoleEndpointConnectionFailureUnreachableOrCanceled(t *testing.T) {
	for _, canceled := range []bool{false, true} {
		t.Run(map[bool]string{false: "unreachable", true: "canceled"}[canceled], func(t *testing.T) {
			srv, configPath := newEndpointReloadTestServer(t)
			before, _ := os.ReadFile(configPath)
			remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				<-r.Context().Done()
			}))
			defer remote.Close()
			if !canceled {
				remote.Close()
			}
			ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
			defer cancel()
			body := `{"endpoints":[{"name":"Remote","url":"` + remote.URL + `","auth_token":"token"}]}`
			rec := httptest.NewRecorder()
			srv.handleConsoleSettings(rec, httptest.NewRequest(http.MethodPut, "/api/settings/console", strings.NewReader(body)).WithContext(ctx))
			if rec.Code != http.StatusBadGateway {
				t.Fatalf("failed connection accepted: %d", rec.Code)
			}
			after, _ := os.ReadFile(configPath)
			if string(after) != string(before) || len(srv.endpoints) != 1 {
				t.Fatal("failed connection changed configuration")
			}
		})
	}
}

func TestConsoleEndpointConnectionRenameAndTokenRotationPreserveFields(t *testing.T) {
	srv, configPath := newEndpointReloadTestServer(t)
	srv.secretStore = &consoleSettingsTestOSStore{}
	remote := newConsoleEndpointTestRemote(t, "new-token")
	config := "console:\n  endpoints:\n    - name: Before\n      url: " + remote.URL + "/runtime\n      auth_token: old-token\n      future_field: keep-me\n"
	if err := os.WriteFile(configPath, []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}
	items := []consoleEndpointSettingsPayload{{OriginalName: "Before", Name: "After", URL: remote.URL + "/runtime", AuthToken: "new-token"}}
	requireEndpointReloadSaved(t, putEndpointReloadSettings(t, srv, items))
	after, _ := os.ReadFile(configPath)
	if !strings.Contains(string(after), "future_field: keep-me") || strings.Contains(string(after), "new-token") {
		t.Fatal("renaming with token rotation lost existing fields or wrote a plaintext token")
	}
}
