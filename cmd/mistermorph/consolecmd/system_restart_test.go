package consolecmd

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/internal/processrestart"
)

func TestHandleSystemRestart(t *testing.T) {
	post := func(s *server, body string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		s.handleSystemRestart(rec, httptest.NewRequest(http.MethodPost, "/api/system/restart", strings.NewReader(body)))
		return rec
	}

	rec := httptest.NewRecorder()
	(&server{}).handleSystemRestart(rec, httptest.NewRequest(http.MethodGet, "/api/system/restart", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET status = %d", rec.Code)
	}
	if rec := post(&server{}, `{}`); rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("not serving: status = %d", rec.Code)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s := &server{stopServing: cancel}
	if rec := post(s, `{}`); rec.Code != http.StatusAccepted || !strings.Contains(rec.Body.String(), `"restarting":true`) {
		t.Fatalf("restart: status = %d, body = %s", rec.Code, rec.Body.String())
	}
	select {
	case <-ctx.Done():
	case <-time.After(2 * time.Second):
		t.Fatal("serving was not stopped")
	}
	if !processrestart.Requested() {
		t.Fatal("restart was not requested")
	}
}
