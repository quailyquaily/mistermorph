package consolecmd

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/internal/secref"
	"github.com/spf13/viper"
)

func newEndpointReloadTestServer(t *testing.T) (*server, string) {
	t.Helper()
	configPath := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(configPath, []byte("console: {}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	previous := viper.Get("config")
	viper.Set("config", configPath)
	t.Cleanup(func() { viper.Set("config", previous) })
	local := runtimeEndpoint{Ref: consoleLocalEndpointRef, Client: &stubRuntimeEndpointClient{
		health: runtimeEndpointHealth{Mode: "console", AvatarURL: "data:image/png;base64,bG9jYWw="},
	}}
	srv := &server{
		endpoints:     []runtimeEndpoint{local},
		endpointByRef: map[string]runtimeEndpoint{local.Ref: local},
	}
	srv.refreshEndpointHealth(context.Background())
	return srv, configPath
}

func putEndpointReloadSettings(t *testing.T, srv *server, endpoints []consoleEndpointSettingsPayload) *httptest.ResponseRecorder {
	t.Helper()
	raw, err := json.Marshal(map[string]any{"endpoints": endpoints})
	if err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	srv.handleConsoleSettings(rec, httptest.NewRequest(http.MethodPut, "/api/settings/console", strings.NewReader(string(raw))))
	return rec
}

func requireEndpointReloadSaved(t *testing.T, rec *httptest.ResponseRecorder) {
	t.Helper()
	if rec.Code != http.StatusOK {
		t.Fatalf("save status = %d: %s", rec.Code, rec.Body.String())
	}
	var payload struct {
		ApplyMode      string   `json:"apply_mode"`
		ApplyStatus    string   `json:"apply_status"`
		RestartTargets []string `json:"restart_targets"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.ApplyMode != "immediate" || payload.ApplyStatus != "applied" || len(payload.RestartTargets) != 0 {
		t.Fatalf("save did not apply immediately: %+v", payload)
	}
}

func TestConsoleEndpointReloadAddUpdateRemove(t *testing.T) {
	remote := newConsoleEndpointTestRemote(t, "")
	newRemote := newConsoleEndpointTestRemote(t, "rotated-token")
	srv, _ := newEndpointReloadTestServer(t)
	localClient := srv.endpoints[0].Client
	items := []consoleEndpointSettingsPayload{
		{Name: "Remote", URL: remote.URL + "/runtime", AuthToken: "first-token"},
		{Name: "Keep", URL: remote.URL + "/runtime", AuthToken: "keep-token"},
	}
	requireEndpointReloadSaved(t, putEndpointReloadSettings(t, srv, items))
	remoteRef := buildRuntimeEndpointRef(items[0].Name, items[0].URL)
	keepRef := buildRuntimeEndpointRef(items[1].Name, items[1].URL)
	lookup := func(ref string) runtimeEndpoint {
		t.Helper()
		ep, err := srv.resolveRuntimeEndpoint(httptest.NewRequest(http.MethodGet, "/api/proxy?endpoint="+ref, nil))
		if err != nil {
			t.Fatal(err)
		}
		return ep
	}
	firstClient := lookup(remoteRef).Client
	keepClient := lookup(keepRef).Client
	items[0].AuthToken = "rotated-token"
	items[1].AuthToken = ""
	requireEndpointReloadSaved(t, putEndpointReloadSettings(t, srv, items))
	client := lookup(remoteRef).Client.(*daemonTaskClient)
	if client == firstClient || client.authToken != "rotated-token" {
		t.Fatal("credential update did not replace the active client")
	}
	if lookup(keepRef).Client != keepClient || lookup(consoleLocalEndpointRef).Client != localClient {
		t.Fatal("saving replaced an unchanged client")
	}
	client.client.Transport = topicTitleRoundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.Header.Get("Authorization") != "Bearer rotated-token" {
			t.Error("proxy used the old token")
		}
		return &http.Response{StatusCode: http.StatusOK, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`{"ok":true}`))}, nil
	})
	rec := httptest.NewRecorder()
	srv.handleProxy(rec, httptest.NewRequest(http.MethodGet, "/api/proxy?endpoint="+remoteRef+"&uri=/tasks", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("proxy status = %d: %s", rec.Code, rec.Body.String())
	}
	items[0] = consoleEndpointSettingsPayload{OriginalName: "Remote", Name: "Renamed", URL: newRemote.URL + "/runtime"}
	requireEndpointReloadSaved(t, putEndpointReloadSettings(t, srv, items))
	if _, err := srv.resolveRuntimeEndpoint(httptest.NewRequest(http.MethodGet, "/api/proxy?endpoint="+remoteRef, nil)); err == nil {
		t.Fatal("old endpoint remains routable after rename")
	}
	renamed := lookup(buildRuntimeEndpointRef(items[0].Name, items[0].URL)).Client.(*daemonTaskClient)
	if renamed.authToken != "rotated-token" || renamed.baseURL != strings.TrimRight(items[0].URL, "/") {
		t.Fatal("rename did not retain the token and apply the new URL")
	}
	requireEndpointReloadSaved(t, putEndpointReloadSettings(t, srv, items[1:]))
	rec = httptest.NewRecorder()
	srv.handleEndpoints(rec, httptest.NewRequest(http.MethodGet, "/api/endpoints", nil))
	var listed struct {
		Items []struct {
			Ref string `json:"endpoint_ref"`
		} `json:"items"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &listed); err != nil {
		t.Fatal(err)
	}
	if len(listed.Items) != 2 || listed.Items[1].Ref != keepRef {
		t.Fatalf("stale endpoint list: %s", rec.Body.String())
	}
	requireEndpointReloadSaved(t, putEndpointReloadSettings(t, srv, []consoleEndpointSettingsPayload{}))
	if len(srv.endpoints) != 1 || srv.endpoints[0].Client != localClient || !srv.endpointStates[0].Connected {
		t.Fatal("removing all remotes changed the local endpoint or its health")
	}
	if _, err := srv.buildArtifactPreviewTicket(artifactPreviewRequest{EndpointRef: keepRef, DirName: "file_state_dir", Path: "index.html"}); err == nil {
		t.Fatal("removed endpoint still accepts preview tickets")
	}
}

func TestConsoleEndpointReloadResolvesSecretsBeforeSaving(t *testing.T) {
	remote := newConsoleEndpointTestRemote(t, "")
	srv, configPath := newEndpointReloadTestServer(t)
	t.Setenv("MORPH_TEST_ENDPOINT_TOKEN", "env-token")
	items := []consoleEndpointSettingsPayload{{Name: "Remote", URL: remote.URL + "/runtime", AuthToken: "${MORPH_TEST_ENDPOINT_TOKEN}"}}
	requireEndpointReloadSaved(t, putEndpointReloadSettings(t, srv, items))
	if srv.endpoints[1].Client.(*daemonTaskClient).authToken != "env-token" {
		t.Fatal("environment token was not resolved")
	}
	before, _ := os.ReadFile(configPath)
	oldClient := srv.endpoints[1].Client
	for _, token := range []string{"${MORPH_TEST_ENDPOINT_MISSING}", secref.OSSecretRef("b_LsX7HLzAR3OShG7YjRcw")} {
		items[0].AuthToken = token
		rec := putEndpointReloadSettings(t, srv, items)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("unresolved token accepted: %d", rec.Code)
		}
		after, _ := os.ReadFile(configPath)
		if string(after) != string(before) || srv.endpoints[1].Client != oldClient {
			t.Fatal("failed update changed the saved or active configuration")
		}
	}
}

type blockedEndpointReloadClient struct {
	*stubRuntimeEndpointClient
	stage   string
	started chan struct{}
	release chan struct{}
}

func (c *blockedEndpointReloadClient) Health(ctx context.Context) (runtimeEndpointHealth, error) {
	if c.stage == "health" {
		close(c.started)
		<-c.release
	}
	return c.stubRuntimeEndpointClient.Health(ctx)
}

func (c *blockedEndpointReloadClient) Download(ctx context.Context, path string) (runtimeEndpointDownload, error) {
	if c.stage == "avatar" {
		close(c.started)
		<-c.release
	}
	return c.stubRuntimeEndpointClient.Download(ctx, path)
}

func TestConsoleEndpointReloadDiscardsOldProbes(t *testing.T) {
	remote := newConsoleEndpointTestRemote(t, "")
	for _, stage := range []string{"health", "avatar"} {
		for _, remove := range []bool{false, true} {
			t.Run(stage+map[bool]string{false: "/replace", true: "/remove"}[remove], func(t *testing.T) {
				srv, _ := newEndpointReloadTestServer(t)
				items := []consoleEndpointSettingsPayload{{Name: "Remote", URL: remote.URL + "/runtime", AuthToken: "first-token"}}
				requireEndpointReloadSaved(t, putEndpointReloadSettings(t, srv, items))
				blocked := &blockedEndpointReloadClient{
					stubRuntimeEndpointClient: &stubRuntimeEndpointClient{
						health:         runtimeEndpointHealth{AgentName: "stale"},
						downloadStatus: http.StatusOK, downloadHeader: http.Header{"Content-Type": []string{"image/png"}}, downloadRaw: []byte("old avatar"),
					}, stage: stage, started: make(chan struct{}), release: make(chan struct{}),
				}
				srv.endpoints[1].Client = blocked
				srv.endpointStates[1].Connected = true
				finished := make(chan struct{})
				go func() {
					defer close(finished)
					if stage == "health" {
						srv.refreshEndpointHealth(context.Background())
					} else {
						srv.refreshEndpointAvatars(context.Background())
					}
				}()
				<-blocked.started
				items[0].AuthToken = "new-token"
				if remove {
					items = []consoleEndpointSettingsPayload{}
				}
				rec := putEndpointReloadSettings(t, srv, items)
				close(blocked.release)
				<-finished
				requireEndpointReloadSaved(t, rec)
				if !remove && (srv.endpointStates[1].HealthReady || srv.endpointStates[1].AvatarReady) {
					t.Fatal("old probe overwrote the replacement endpoint state")
				}
			})
		}
	}
}

func TestConsoleEndpointReloadWakesHealthWorker(t *testing.T) {
	healthSeen := make(chan struct{}, 1)
	var healthCalls atomic.Int32
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/tasks" {
			_, _ = io.WriteString(w, `{"items":[]}`)
			return
		}
		if r.URL.Path == "/health" {
			// The first call validates the save; the next must come from the worker.
			if healthCalls.Add(1) > 1 {
				select {
				case healthSeen <- struct{}{}:
				default:
				}
			}
			_, _ = io.WriteString(w, `{"mode":"console","can_submit":true}`)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer remote.Close()
	srv, _ := newEndpointReloadTestServer(t)
	ctx, cancel := context.WithCancel(context.Background())
	srv.startEndpointBackground(ctx)
	t.Cleanup(func() { cancel(); srv.endpointWorkersWG.Wait() })
	requireEndpointReloadSaved(t, putEndpointReloadSettings(t, srv, []consoleEndpointSettingsPayload{{Name: "Remote", URL: remote.URL, AuthToken: "token"}}))
	select {
	case <-healthSeen:
	case <-time.After(3 * time.Second):
		t.Fatal("new endpoint waited for the periodic health tick")
	}
}

func TestConsoleEndpointReloadConcurrentReaders(t *testing.T) {
	remote := newConsoleEndpointTestRemote(t, "")
	srv, _ := newEndpointReloadTestServer(t)
	done := make(chan struct{})
	var readers sync.WaitGroup
	for range 4 {
		readers.Add(1)
		go func() {
			defer readers.Done()
			for {
				select {
				case <-done:
					return
				default:
				}
				srv.handleEndpoints(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/api/endpoints", nil))
				_, _ = srv.resolveRuntimeEndpoint(httptest.NewRequest(http.MethodGet, "/api/proxy?endpoint="+consoleLocalEndpointRef, nil))
				_, _ = srv.buildArtifactPreviewTicket(artifactPreviewRequest{EndpointRef: consoleLocalEndpointRef, DirName: "file_state_dir", Path: "index.html"})
			}
		}()
	}
	defer func() { close(done); readers.Wait() }()
	for i := 0; i < 20; i++ {
		items := []consoleEndpointSettingsPayload{}
		if i%2 == 0 {
			items = append(items, consoleEndpointSettingsPayload{Name: "Remote", URL: remote.URL + "/runtime", AuthToken: "token"})
		}
		requireEndpointReloadSaved(t, putEndpointReloadSettings(t, srv, items))
	}
}
