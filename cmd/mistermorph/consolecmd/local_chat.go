package consolecmd

import (
	"context"
	"crypto/subtle"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/quailyquaily/mistermorph/internal/localconsole"
)

// Local clients use a private loopback listener even when the public runtime
// API is disabled. Its stable token is independent of config reloads.
func (s *server) startLocalChatEndpoint(ctx context.Context, stop context.CancelFunc, webURL string) (func(), error) {
	token, err := consoleLocalRuntimeAuthToken()
	if err != nil {
		return nil, err
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got, ok := bearerToken(r)
		if !ok || subtle.ConstantTimeCompare([]byte(got), []byte(token)) != 1 {
			writeError(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		if r.URL.Path == "/shutdown" {
			if r.Method != http.MethodPost {
				w.WriteHeader(http.StatusMethodNotAllowed)
				return
			}
			w.WriteHeader(http.StatusOK)
			if flush, ok := w.(http.Flusher); ok {
				flush.Flush()
			}
			stop()
			return
		}
		if r.URL.Path == "/stream/ws" {
			s.handleRuntimeStreamWebSocket(w, r)
			return
		}
		if r.URL.Path == "/settings/agent" && r.Method == http.MethodGet {
			s.handleAgentSettings(w, r)
			return
		}
		// Snapshot the handler and its matching token together during reloads.
		s.localRuntime.handlerMu.RLock()
		current, currentToken := s.localRuntime.handler, s.localRuntime.authToken
		s.localRuntime.handlerMu.RUnlock()
		if current == nil {
			writeError(w, http.StatusServiceUnavailable, "runtime is unavailable")
			return
		}
		forward := r.Clone(r.Context())
		forward.Header.Set("Authorization", "Bearer "+currentToken)
		current.ServeHTTP(w, forward)
	})
	mux := http.NewServeMux()
	mux.Handle("/runtime/", http.StripPrefix("/runtime", handler))
	httpServer := &http.Server{Handler: mux, ReadHeaderTimeout: 10 * time.Second, BaseContext: func(net.Listener) context.Context { return ctx }}
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		_ = httpServer.Serve(ln)
	}()
	c := localconsole.Connection{URL: "http://" + ln.Addr().String() + "/runtime", Token: token, WebURL: webURL}
	if err := localconsole.Save(s.cfg.stateDir, c); err != nil {
		_ = httpServer.Close()
		<-finished
		return nil, err
	}
	return func() {
		_ = httpServer.Shutdown(context.Background())
		<-finished
		_ = os.Remove(filepath.Join(s.cfg.stateDir, "console", "runtime.json"))
	}, nil
}
