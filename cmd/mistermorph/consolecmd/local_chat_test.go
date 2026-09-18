package consolecmd

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
	"github.com/quailyquaily/mistermorph/internal/localconsole"
)

func TestLocalChatConnectionWithoutConfiguredToken(t *testing.T) {
	// The local endpoint uses its own token and forwards to the current runtime
	// token, including after a config reload rotates that token.
	s, runtime := newConsoleRuntimeMountTestServer("/", "")
	runtime.authToken = "generation-one"
	runtime.handler = daemonruntime.NewHandler(daemonruntime.RoutesOptions{Mode: "console", AuthToken: runtime.authToken, HealthEnabled: true})
	s.cfg.stateDir = t.TempDir()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	cleanup, err := s.startLocalChatEndpoint(ctx, cancel, "http://127.0.0.1:9080/")
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	c, found, err := localconsole.Load(s.cfg.stateDir)
	if err != nil || !found || c.Token == "" {
		t.Fatalf("local connection missing: found=%v err=%v", found, err)
	}
	request := func(token, path string) int {
		t.Helper()
		req, _ := http.NewRequest(http.MethodGet, c.URL+path, nil)
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		return resp.StatusCode
	}
	if got := request("", "/health"); got != http.StatusUnauthorized {
		t.Fatalf("unauthenticated local endpoint = %d", got)
	}
	if got := request(c.Token, "/health"); got != http.StatusOK {
		t.Fatalf("authenticated local endpoint = %d", got)
	}
	runtime.handlerMu.Lock()
	runtime.authToken = "generation-two"
	runtime.handler = daemonruntime.NewHandler(daemonruntime.RoutesOptions{Mode: "console", AuthToken: runtime.authToken, HealthEnabled: true})
	runtime.handlerMu.Unlock()
	if got := request(c.Token, "/overview"); got != http.StatusOK {
		t.Fatalf("connection after token rotation = %d", got)
	}
	if strings.TrimSpace(runtime.currentConfigReader().GetString("server.auth_token")) != "" {
		t.Fatal("local connection modified the configured public API token")
	}
	if err := localconsole.Stop(context.Background(), s.cfg.stateDir); err != nil {
		t.Fatal(err)
	}
	if ctx.Err() == nil {
		t.Fatal("console stop did not cancel the service")
	}
}
