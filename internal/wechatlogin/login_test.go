package wechatlogin

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/quailyquaily/mistermorph/internal/secref"
)

type memoryStore struct {
	mu      sync.Mutex
	secrets map[string][]byte
}

func (s *memoryStore) Get(_ context.Context, id string) ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	value, ok := s.secrets[id]
	if !ok {
		return nil, secref.ErrOSSecretNotFound
	}
	return value, nil
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

func TestLoginFollowsARedirectAndSavesTheCredentials(t *testing.T) {
	var redirected *httptest.Server
	redirected = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, `{"status":"confirmed","bot_token":"T1","ilink_bot_id":"bot@im.bot","baseurl":"https://api.example.test"}`)
	}))
	defer redirected.Close()
	host := strings.TrimPrefix(redirected.URL, "https://")
	polls := 0
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "get_bot_qrcode") {
			_, _ = io.WriteString(w, `{"qrcode":"Q","qrcode_img_content":"https://qr.example.test/Q"}`)
			return
		}
		polls++
		_, _ = io.WriteString(w, `{"status":"scaned_but_redirect","redirect_host":"`+host+`"}`)
	}))
	defer origin.Close()
	session, err := Start(context.Background(), Options{BaseURL: origin.URL, HTTPClient: redirected.Client()})
	if err != nil || session.Image() != "https://qr.example.test/Q" {
		t.Fatalf("Start = %v, %v", session, err)
	}
	step, err := session.Poll(context.Background(), "")
	if err != nil || step.Status != "scaned" || step.Done {
		t.Fatalf("first poll = %+v, %v", step, err)
	}
	step, err = session.Poll(context.Background(), "")
	if err != nil || !step.Done || step.Result == nil || step.Result.BotToken != "T1" || step.Result.BaseURL != "https://api.example.test" || polls != 1 {
		t.Fatalf("second poll = %+v, %v (polls %d)", step, err, polls)
	}

	dir := t.TempDir()
	configPath := filepath.Join(dir, "config.yaml")
	oldID, _ := secref.NewOSSecretID()
	if err := os.WriteFile(configPath, []byte("wechat:\n  allowed_user_ids: [u1]\n  bot_token: \""+secref.OSSecretRef(oldID)+"\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	store := &memoryStore{secrets: map[string][]byte{oldID: []byte("old")}}
	if err := Save(context.Background(), configPath, store, *step.Result); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(configPath)
	config := string(raw)
	if !strings.Contains(config, "bot_token: ${secret:") || strings.Contains(config, "T1") || !strings.Contains(config, "bot_id: bot@im.bot") ||
		!strings.Contains(config, "base_url: https://api.example.test") || !strings.Contains(config, "allowed_user_ids") {
		t.Fatalf("config = %s", config)
	}
	if _, found := store.secrets[oldID]; found || len(store.secrets) != 1 {
		t.Fatalf("secrets = %v", store.secrets)
	}
	if err := Unbind(context.Background(), configPath, store); err != nil {
		t.Fatal(err)
	}
	raw, _ = os.ReadFile(configPath)
	if strings.Contains(string(raw), "bot_token") || strings.Contains(string(raw), "bot_id") || len(store.secrets) != 0 {
		t.Fatalf("after unbind: config=%s secrets=%v", raw, store.secrets)
	}
}

func TestSaveRefusesToWriteThePlainTokenWithoutAKeyring(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "config.yaml")
	err := Save(context.Background(), configPath, nil, Result{BotToken: "T", BotID: "b"})
	if !errors.Is(err, ErrKeyringUnavailable) {
		t.Fatalf("err = %v", err)
	}
	if _, statErr := os.Stat(configPath); !os.IsNotExist(statErr) {
		t.Fatal("the config was written")
	}
}
