package wechatcmd

import (
	"bufio"
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/quailyquaily/mistermorph/internal/secref"
	"github.com/quailyquaily/mistermorph/internal/wechatlogin"
)

type memoryStore struct {
	mu      sync.Mutex
	secrets map[string][]byte
}

func (s *memoryStore) Get(_ context.Context, id string) ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if v, ok := s.secrets[id]; ok {
		return v, nil
	}
	return nil, secref.ErrOSSecretNotFound
}

func (s *memoryStore) Put(_ context.Context, id, _ string, value []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.secrets[id] = value
	return nil
}

func (s *memoryStore) Delete(_ context.Context, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.secrets, id)
	return nil
}

func TestLoginAsksForTheVerificationCodeAndSaves(t *testing.T) {
	polls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "get_bot_qrcode") {
			_, _ = io.WriteString(w, `{"qrcode":"Q","qrcode_img_content":"https://qr.example.test/Q"}`)
			return
		}
		polls++
		switch {
		case polls == 1:
			_, _ = io.WriteString(w, `{"status":"need_verifycode"}`)
		case r.URL.Query().Get("verify_code") == "246810":
			_, _ = io.WriteString(w, `{"status":"confirmed","bot_token":"T","ilink_bot_id":"bot@im.bot","baseurl":"https://api.example.test"}`)
		default:
			t.Errorf("poll %d without the code: %s", polls, r.URL.RawQuery)
			_, _ = io.WriteString(w, `{"status":"expired"}`)
		}
	}))
	defer server.Close()
	configPath := filepath.Join(t.TempDir(), "config.yaml")
	var out bytes.Buffer
	store := &memoryStore{secrets: map[string][]byte{}}
	err := login(context.Background(), &out, bufio.NewReader(strings.NewReader("246810\n")), configPath, store, wechatlogin.Options{BaseURL: server.URL, HTTPClient: server.Client()})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "https://qr.example.test/Q") || !strings.Contains(out.String(), "Verification code:") || !strings.Contains(out.String(), "Connected bot bot@im.bot") {
		t.Fatalf("output = %s", out.String())
	}
	raw, _ := os.ReadFile(configPath)
	if !strings.Contains(string(raw), "bot_id: bot@im.bot") || strings.Contains(string(raw), "bot_token: T") || len(store.secrets) != 1 {
		t.Fatalf("config = %s, secrets = %d", raw, len(store.secrets))
	}
}
