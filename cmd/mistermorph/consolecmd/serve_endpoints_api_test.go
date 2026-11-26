package consolecmd

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
)

type stubRuntimeEndpointClient struct {
	health    runtimeEndpointHealth
	healthErr error

	proxyStatus int
	proxyRaw    []byte
	proxyErr    error

	downloadStatus int
	downloadHeader http.Header
	downloadRaw    []byte
	downloadErr    error
	downloadCalls  int

	lastMethod       string
	lastPath         string
	lastBody         []byte
	lastDownloadPath string
}

func (s *stubRuntimeEndpointClient) Health(_ context.Context) (runtimeEndpointHealth, error) {
	return s.health, s.healthErr
}

func (s *stubRuntimeEndpointClient) Proxy(_ context.Context, method, endpointPath string, body []byte, _ string) (int, []byte, error) {
	s.lastMethod = method
	s.lastPath = endpointPath
	s.lastBody = append([]byte(nil), body...)
	return s.proxyStatus, append([]byte(nil), s.proxyRaw...), s.proxyErr
}

func (s *stubRuntimeEndpointClient) Download(_ context.Context, endpointPath string) (runtimeEndpointDownload, error) {
	s.downloadCalls++
	s.lastDownloadPath = endpointPath
	return runtimeEndpointDownload{
		Status: s.downloadStatus,
		Header: s.downloadHeader.Clone(),
		Body:   io.NopCloser(bytes.NewReader(s.downloadRaw)),
	}, s.downloadErr
}

func TestHandleEndpointsSnapshots(t *testing.T) {
	s := &server{
		endpoints: []runtimeEndpoint{
			{
				Ref:  "ep_a",
				Name: "Main",
				URL:  "http://127.0.0.1:8787",
				Client: &stubRuntimeEndpointClient{
					health: runtimeEndpointHealth{Mode: "serve", AgentName: "Morph", CanSubmit: true},
				},
			},
			{
				Ref:    "ep_b",
				Name:   "Backup",
				URL:    "http://127.0.0.1:8788",
				Client: &stubRuntimeEndpointClient{healthErr: errors.New("dial failed")},
			},
		},
	}
	s.refreshEndpointHealth(context.Background())

	req := httptest.NewRequest(http.MethodGet, "/console/api/endpoints", nil)
	rec := httptest.NewRecorder()
	s.handleEndpoints(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d (%s)", rec.Code, http.StatusOK, rec.Body.String())
	}
	var payload struct {
		Items []struct {
			Ref       string `json:"endpoint_ref"`
			Name      string `json:"name"`
			URL       string `json:"url"`
			Connected bool   `json:"connected"`
			AgentName string `json:"agent_name"`
			Mode      string `json:"mode"`
			CanSubmit bool   `json:"can_submit"`
		} `json:"items"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(payload.Items) != 2 {
		t.Fatalf("len(items) = %d, want 2", len(payload.Items))
	}
	if payload.Items[0].Ref != "ep_a" || payload.Items[0].Name != "Main" || payload.Items[0].URL != "http://127.0.0.1:8787" || !payload.Items[0].Connected || payload.Items[0].AgentName != "Morph" || payload.Items[0].Mode != "serve" || !payload.Items[0].CanSubmit {
		t.Fatalf("item[0] mismatch: %+v", payload.Items[0])
	}
	if payload.Items[1].Ref != "ep_b" || payload.Items[1].Name != "Backup" || payload.Items[1].URL != "http://127.0.0.1:8788" || payload.Items[1].Connected {
		t.Fatalf("item[1] mismatch: %+v", payload.Items[1])
	}
}

func TestHandleEndpointsReturnsEmptyAgentNameWhenHealthDoesNotProvideIt(t *testing.T) {
	client := &stubRuntimeEndpointClient{
		health: runtimeEndpointHealth{Mode: "console", CanSubmit: true},
	}
	s := &server{
		endpoints: []runtimeEndpoint{
			{
				Ref:    "ep_a",
				Name:   "Main",
				URL:    "http://127.0.0.1:8787",
				Client: client,
			},
		},
	}
	s.refreshEndpointHealth(context.Background())

	req := httptest.NewRequest(http.MethodGet, "/console/api/endpoints", nil)
	rec := httptest.NewRecorder()
	s.handleEndpoints(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d (%s)", rec.Code, http.StatusOK, rec.Body.String())
	}
	var payload struct {
		Items []struct {
			AgentName string `json:"agent_name"`
		} `json:"items"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(payload.Items) != 1 {
		t.Fatalf("len(items) = %d, want 1", len(payload.Items))
	}
	if payload.Items[0].AgentName != "" {
		t.Fatalf("item[0].AgentName = %q, want empty", payload.Items[0].AgentName)
	}
}

func TestEndpointHealthAvatarSkipsPersonaDownload(t *testing.T) {
	client := &stubRuntimeEndpointClient{
		health: runtimeEndpointHealth{
			Mode: "mixin", AgentName: "Mixin Agent", AvatarURL: "https://example.test/mixin-avatar.png",
		},
	}
	s := &server{endpoints: []runtimeEndpoint{{Ref: "ep_mixin", Client: client}}}
	s.refreshEndpointHealth(context.Background())
	s.refreshEndpointAvatars(context.Background())

	if client.downloadCalls != 0 {
		t.Fatalf("persona avatar downloads = %d, want 0", client.downloadCalls)
	}
	if got := s.endpointStates[0].AvatarURL; got != "https://example.test/mixin-avatar.png" {
		t.Fatalf("avatar url = %q", got)
	}
}

func TestHandleEndpointsIncludesPerEndpointAvatarAndInstanceID(t *testing.T) {
	s := &server{
		endpoints: []runtimeEndpoint{
			{
				Ref:  "ep_a",
				Name: "A",
				URL:  "http://127.0.0.1:8787",
				Client: &stubRuntimeEndpointClient{
					health:         runtimeEndpointHealth{Mode: "telegram", AgentName: "A", CanSubmit: true, InstanceID: "inst_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},
					downloadStatus: http.StatusOK,
					downloadHeader: http.Header{"Content-Type": []string{"image/webp"}},
					downloadRaw:    []byte("avatar-a"),
				},
			},
			{
				Ref:  "ep_b",
				Name: "B",
				URL:  "http://127.0.0.1:8788",
				Client: &stubRuntimeEndpointClient{
					health:         runtimeEndpointHealth{Mode: "slack", AgentName: "B", CanSubmit: true},
					downloadStatus: http.StatusOK,
					downloadHeader: http.Header{"Content-Type": []string{"image/webp"}},
					downloadRaw:    []byte("avatar-b"),
				},
			},
		},
	}
	s.refreshEndpointHealth(context.Background())
	s.refreshEndpointAvatars(context.Background())

	req := httptest.NewRequest(http.MethodGet, "/console/api/endpoints", nil)
	rec := httptest.NewRecorder()
	s.handleEndpoints(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d (%s)", rec.Code, http.StatusOK, rec.Body.String())
	}
	var payload struct {
		Items []struct {
			Ref        string `json:"endpoint_ref"`
			AvatarURL  string `json:"avatar_url"`
			InstanceID string `json:"instance_id"`
		} `json:"items"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(payload.Items) != 2 {
		t.Fatalf("len(items) = %d, want 2", len(payload.Items))
	}
	if payload.Items[0].Ref != "ep_a" || payload.Items[0].AvatarURL != "data:image/webp;base64,YXZhdGFyLWE=" {
		t.Fatalf("item[0] = %+v", payload.Items[0])
	}
	if payload.Items[1].Ref != "ep_b" || payload.Items[1].AvatarURL != "data:image/webp;base64,YXZhdGFyLWI=" {
		t.Fatalf("item[1] = %+v", payload.Items[1])
	}
	// The Contacts page matches Agent Link contacts to endpoints by instance ID.
	if got, want := payload.Items[0].InstanceID, "inst_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; got != want {
		t.Fatalf("item[0].instance_id = %q, want %q", got, want)
	}
	if got := payload.Items[1].InstanceID; got != "" {
		t.Fatalf("item[1].instance_id = %q, want empty", got)
	}
}

func TestRefreshEndpointAvatarsRetriesTransientFailureAndStopsAfterSuccess(t *testing.T) {
	client := &stubRuntimeEndpointClient{
		health:      runtimeEndpointHealth{Mode: "console"},
		downloadErr: errors.New("temporary download failure"),
	}
	s := &server{
		endpoints: []runtimeEndpoint{{Ref: "ep_b", Client: client}},
	}
	s.refreshEndpointHealth(context.Background())
	s.refreshEndpointAvatars(context.Background())

	if client.downloadCalls != 1 {
		t.Fatalf("download calls after transient failure = %d, want 1", client.downloadCalls)
	}
	if s.endpointStates[0].AvatarReady {
		t.Fatal("avatar marked ready after transient failure")
	}

	client.downloadErr = nil
	client.downloadStatus = http.StatusOK
	client.downloadHeader = http.Header{"Content-Type": []string{"image/webp"}}
	client.downloadRaw = []byte("avatar-b")
	s.refreshEndpointAvatars(context.Background())

	if !s.endpointStates[0].AvatarReady {
		t.Fatal("avatar not marked ready after successful retry")
	}
	if got, want := s.endpointStates[0].AvatarURL, "data:image/webp;base64,YXZhdGFyLWI="; got != want {
		t.Fatalf("avatar url = %q, want %q", got, want)
	}

	s.refreshEndpointAvatars(context.Background())
	if client.downloadCalls != 2 {
		t.Fatalf("download calls after cached success = %d, want 2", client.downloadCalls)
	}
}

func TestRefreshEndpointAvatarsDoesNotRetryMissingAvatar(t *testing.T) {
	client := &stubRuntimeEndpointClient{
		health:         runtimeEndpointHealth{Mode: "console"},
		downloadStatus: http.StatusNotFound,
	}
	s := &server{
		endpoints: []runtimeEndpoint{{Ref: "ep_b", Client: client}},
	}
	s.refreshEndpointHealth(context.Background())
	s.refreshEndpointAvatars(context.Background())
	s.refreshEndpointAvatars(context.Background())

	if client.downloadCalls != 1 {
		t.Fatalf("download calls for missing avatar = %d, want 1", client.downloadCalls)
	}
	if !s.endpointStates[0].AvatarReady || s.endpointStates[0].AvatarURL != "" {
		t.Fatalf("avatar state = %+v, want ready without URL", s.endpointStates[0])
	}
}

func TestHandleEndpointsDoesNotMapSubmitForSameInstanceReadOnlyEndpoint(t *testing.T) {
	s := &server{
		endpoints: []runtimeEndpoint{
			{
				Ref:    consoleLocalEndpointRef,
				Name:   "Console Local",
				URL:    "in-process://console-local",
				Client: &stubRuntimeEndpointClient{health: runtimeEndpointHealth{Mode: "console", CanSubmit: true, InstanceID: "inst_same"}},
			},
			{
				Ref:    "ep_main",
				Name:   "Main",
				URL:    "http://127.0.0.1:8787",
				Client: &stubRuntimeEndpointClient{health: runtimeEndpointHealth{Mode: "telegram", CanSubmit: false, InstanceID: "inst_same"}},
			},
		},
	}
	s.refreshEndpointHealth(context.Background())

	req := httptest.NewRequest(http.MethodGet, "/console/api/endpoints", nil)
	rec := httptest.NewRecorder()
	s.handleEndpoints(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d (%s)", rec.Code, http.StatusOK, rec.Body.String())
	}
	var payload struct {
		Items []struct {
			Ref               string `json:"endpoint_ref"`
			SubmitEndpointRef string `json:"submit_endpoint_ref"`
		} `json:"items"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(payload.Items) != 2 {
		t.Fatalf("len(items) = %d, want 2", len(payload.Items))
	}
	if payload.Items[1].Ref != "ep_main" {
		t.Fatalf("item[1].Ref = %q, want %q", payload.Items[1].Ref, "ep_main")
	}
	if payload.Items[1].SubmitEndpointRef != "" {
		t.Fatalf("item[1].SubmitEndpointRef = %q, want empty", payload.Items[1].SubmitEndpointRef)
	}
}

func TestHandleProxyRoutesToSelectedEndpoint(t *testing.T) {
	client := &stubRuntimeEndpointClient{
		proxyStatus: http.StatusAccepted,
		proxyRaw:    []byte(`{"ok":true}`),
	}
	s := &server{
		endpointByRef: map[string]runtimeEndpoint{
			"ep_main": {
				Ref:    "ep_main",
				Name:   "Main",
				URL:    "http://127.0.0.1:8787",
				Client: client,
			},
		},
	}

	reqBody := []byte(`{"task":"ping"}`)
	req := httptest.NewRequest(http.MethodPost, "/console/api/proxy?endpoint=ep_main&uri=/tasks?wait=true", bytes.NewReader(reqBody))
	rec := httptest.NewRecorder()
	s.handleProxy(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want %d (%s)", rec.Code, http.StatusAccepted, rec.Body.String())
	}
	if got := rec.Header().Get(proxyUpstreamResponseHeader); got != "1" {
		t.Fatalf("%s = %q, want 1", proxyUpstreamResponseHeader, got)
	}
	if client.lastMethod != http.MethodPost {
		t.Fatalf("client method = %q, want %q", client.lastMethod, http.MethodPost)
	}
	if client.lastPath != "/tasks?wait=true" {
		t.Fatalf("client path = %q, want %q", client.lastPath, "/tasks?wait=true")
	}
	if string(client.lastBody) != string(reqBody) {
		t.Fatalf("client body = %q, want %q", string(client.lastBody), string(reqBody))
	}
	var payload map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if ok, _ := payload["ok"].(bool); !ok {
		t.Fatalf("payload.ok = %#v, want true", payload["ok"])
	}
}

func TestHandleProxyForwardsMultipartUploadLargerThanLegacyLimit(t *testing.T) {
	client := &stubRuntimeEndpointClient{
		proxyStatus: http.StatusOK,
		proxyRaw:    []byte(`{"files":[]}`),
	}
	s := &server{
		endpointByRef: map[string]runtimeEndpoint{
			"ep_main": {
				Ref:    "ep_main",
				Name:   "Main",
				URL:    "http://127.0.0.1:8787",
				Client: client,
			},
		},
	}

	reqBody := bytes.Repeat([]byte("a"), 5<<20)
	req := httptest.NewRequest(http.MethodPost, "/console/api/proxy?endpoint=ep_main&uri=/files/upload", bytes.NewReader(reqBody))
	req.Header.Set("Content-Type", "multipart/form-data; boundary=test")
	rec := httptest.NewRecorder()
	s.handleProxy(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d (%s)", rec.Code, http.StatusOK, rec.Body.String())
	}
	if got := rec.Header().Get(proxyUpstreamResponseHeader); got != "1" {
		t.Fatalf("%s = %q, want 1", proxyUpstreamResponseHeader, got)
	}
	if len(client.lastBody) != len(reqBody) {
		t.Fatalf("forwarded body length = %d, want %d", len(client.lastBody), len(reqBody))
	}
}

func TestHandleProxyDownloadRoutesToSelectedEndpoint(t *testing.T) {
	client := &stubRuntimeEndpointClient{
		downloadStatus: http.StatusOK,
		downloadHeader: http.Header{
			"Content-Disposition": []string{`attachment; filename="main.go"`},
			"Content-Type":        []string{"text/plain; charset=utf-8"},
		},
		downloadRaw: []byte("package main\n"),
	}
	s := &server{
		endpointByRef: map[string]runtimeEndpoint{
			"ep_main": {
				Ref:    "ep_main",
				Name:   "Main",
				URL:    "http://127.0.0.1:8787",
				Client: client,
			},
		},
	}

	target := url.QueryEscape("/files/download?dir_name=workspace_dir&topic_id=topic_a&path=src/main.go")
	req := httptest.NewRequest(http.MethodGet, "/console/api/proxy/download?endpoint=ep_main&uri="+target, nil)
	rec := httptest.NewRecorder()
	s.handleProxyDownload(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d (%s)", rec.Code, http.StatusOK, rec.Body.String())
	}
	if client.lastDownloadPath != "/files/download?dir_name=workspace_dir&topic_id=topic_a&path=src/main.go" {
		t.Fatalf("client download path = %q", client.lastDownloadPath)
	}
	if got := rec.Header().Get("Content-Disposition"); got != `attachment; filename="main.go"` {
		t.Fatalf("Content-Disposition = %q", got)
	}
	if got := rec.Header().Get("Content-Type"); got != "text/plain; charset=utf-8" {
		t.Fatalf("Content-Type = %q", got)
	}
	if rec.Body.String() != "package main\n" {
		t.Fatalf("body = %q", rec.Body.String())
	}
}

func TestHandleProxyDownloadRoutesContactAvatar(t *testing.T) {
	client := &stubRuntimeEndpointClient{
		downloadStatus: http.StatusOK,
		downloadHeader: http.Header{
			"Content-Type":  []string{"image/png"},
			"Cache-Control": []string{"private, max-age=604800, immutable"},
			"Last-Modified": []string{"Sun, 30 Aug 2026 10:00:00 GMT"},
		},
		downloadRaw: []byte("avatar"),
	}
	s := &server{
		endpointByRef: map[string]runtimeEndpoint{
			"ep_remote": {Ref: "ep_remote", Client: client},
		},
	}

	target := url.QueryEscape("/contacts/avatar?contact_id=tg%3A123&v=42")
	req := httptest.NewRequest(http.MethodGet, "/console/api/proxy/download?endpoint=ep_remote&uri="+target, nil)
	rec := httptest.NewRecorder()
	s.handleProxyDownload(rec, req)

	if rec.Code != http.StatusOK || rec.Body.String() != "avatar" {
		t.Fatalf("avatar proxy response = %d %q", rec.Code, rec.Body.String())
	}
	if client.lastDownloadPath != "/contacts/avatar?contact_id=tg%3A123&v=42" {
		t.Fatalf("client download path = %q", client.lastDownloadPath)
	}
	if got := rec.Header().Get("Content-Type"); got != "image/png" {
		t.Fatalf("Content-Type = %q, want image/png", got)
	}
	if got := rec.Header().Get("Cache-Control"); got != "private, max-age=604800, immutable" {
		t.Fatalf("Cache-Control = %q", got)
	}
	if got := rec.Header().Get("Last-Modified"); got != "Sun, 30 Aug 2026 10:00:00 GMT" {
		t.Fatalf("Last-Modified = %q", got)
	}
}

func TestHandleProxyDownloadCachesPersonaAvatar(t *testing.T) {
	client := &stubRuntimeEndpointClient{
		downloadStatus: http.StatusOK,
		downloadHeader: http.Header{"Content-Type": []string{"image/webp"}},
		downloadRaw:    []byte("avatar-b"),
	}
	endpoint := runtimeEndpoint{Ref: "ep_b", Name: "Morph B", Client: client}
	s := &server{
		endpoints:     []runtimeEndpoint{endpoint},
		endpointByRef: map[string]runtimeEndpoint{"ep_b": endpoint},
	}

	target := url.QueryEscape("/persona/avatar")
	req := httptest.NewRequest(http.MethodGet, "/console/api/proxy/download?endpoint=ep_b&uri="+target, nil)
	rec := httptest.NewRecorder()
	s.handleProxyDownload(rec, req)

	if rec.Code != http.StatusOK || rec.Body.String() != "avatar-b" {
		t.Fatalf("avatar proxy response = %d %q", rec.Code, rec.Body.String())
	}
	s.ensureEndpointStates()
	if !s.endpointStates[0].AvatarReady {
		t.Fatal("proxied avatar not marked ready")
	}
	if got, want := s.endpointStates[0].AvatarURL, "data:image/webp;base64,YXZhdGFyLWI="; got != want {
		t.Fatalf("cached avatar url = %q, want %q", got, want)
	}
}

func TestHandleProxyUpdatesPersonaAvatarCache(t *testing.T) {
	client := &stubRuntimeEndpointClient{
		proxyStatus: http.StatusOK,
		proxyRaw:    []byte(`{"ok":true}`),
	}
	endpoint := runtimeEndpoint{Ref: "ep_b", Name: "Morph B", Client: client}
	s := &server{
		endpoints:     []runtimeEndpoint{endpoint},
		endpointByRef: map[string]runtimeEndpoint{"ep_b": endpoint},
	}

	putTarget := url.QueryEscape("/persona/avatar")
	putReq := httptest.NewRequest(http.MethodPut, "/console/api/proxy?endpoint=ep_b&uri="+putTarget, bytes.NewReader([]byte("new-avatar")))
	putReq.Header.Set("Content-Type", "image/webp")
	putRec := httptest.NewRecorder()
	s.handleProxy(putRec, putReq)

	if putRec.Code != http.StatusOK {
		t.Fatalf("avatar PUT status = %d (%s)", putRec.Code, putRec.Body.String())
	}
	s.ensureEndpointStates()
	if !s.endpointStates[0].AvatarReady || s.endpointStates[0].AvatarURL == "" {
		t.Fatalf("avatar state after PUT = %+v", s.endpointStates[0])
	}

	deleteReq := httptest.NewRequest(http.MethodDelete, "/console/api/proxy?endpoint=ep_b&uri="+putTarget, nil)
	deleteRec := httptest.NewRecorder()
	s.handleProxy(deleteRec, deleteReq)

	if deleteRec.Code != http.StatusOK {
		t.Fatalf("avatar DELETE status = %d (%s)", deleteRec.Code, deleteRec.Body.String())
	}
	if !s.endpointStates[0].AvatarReady || s.endpointStates[0].AvatarURL != "" {
		t.Fatalf("avatar state after DELETE = %+v", s.endpointStates[0])
	}
}

// Setup and Settings save an agent's settings and persona through the proxy: a save names its
// agent, and reaches that one only.
func TestHandleProxySettingsSaveReachesOnlyTheNamedEndpoint(t *testing.T) {
	clientA := &stubRuntimeEndpointClient{proxyStatus: http.StatusOK, proxyRaw: []byte(`{"ok":true}`)}
	clientB := &stubRuntimeEndpointClient{proxyStatus: http.StatusOK, proxyRaw: []byte(`{"ok":true}`)}
	endpointA := runtimeEndpoint{Ref: "ep_a", Name: "Morph A", Client: clientA}
	endpointB := runtimeEndpoint{Ref: "ep_b", Name: "Morph B", Client: clientB}
	s := &server{
		endpoints:     []runtimeEndpoint{endpointA, endpointB},
		endpointByRef: map[string]runtimeEndpoint{"ep_a": endpointA, "ep_b": endpointB},
	}

	for _, tc := range []struct {
		uri  string
		body string
	}{
		{uri: "/settings/agent", body: `{"config_revision":"rev-1","llm":{"model":"gpt-next"}}`},
		{uri: "/persona/identity", body: `{"name":"Rhea"}`},
	} {
		t.Run(tc.uri, func(t *testing.T) {
			*clientA = stubRuntimeEndpointClient{proxyStatus: http.StatusOK, proxyRaw: []byte(`{"ok":true}`)}
			*clientB = stubRuntimeEndpointClient{proxyStatus: http.StatusOK, proxyRaw: []byte(`{"ok":true}`)}
			req := httptest.NewRequest(http.MethodPut, "/console/api/proxy?endpoint=ep_b&uri="+url.QueryEscape(tc.uri), bytes.NewReader([]byte(tc.body)))
			req.Header.Set("Content-Type", "application/json")
			rec := httptest.NewRecorder()
			s.handleProxy(rec, req)

			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d (%s)", rec.Code, rec.Body.String())
			}
			if clientB.lastMethod != http.MethodPut || clientB.lastPath != tc.uri || string(clientB.lastBody) != tc.body {
				t.Fatalf("named endpoint got %s %s %q, want PUT %s %q", clientB.lastMethod, clientB.lastPath, clientB.lastBody, tc.uri, tc.body)
			}
			if clientA.lastMethod != "" || clientA.lastPath != "" || len(clientA.lastBody) != 0 {
				t.Fatalf("other endpoint was reached: %s %s %q", clientA.lastMethod, clientA.lastPath, clientA.lastBody)
			}
		})
	}

	// An agent that is not there is refused: the save does not fall back to another one.
	req := httptest.NewRequest(http.MethodPut, "/console/api/proxy?endpoint=ep_gone&uri="+url.QueryEscape("/settings/agent"), bytes.NewReader([]byte(`{}`)))
	rec := httptest.NewRecorder()
	*clientA = stubRuntimeEndpointClient{}
	*clientB = stubRuntimeEndpointClient{}
	s.handleProxy(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("unknown endpoint status = %d, want %d (%s)", rec.Code, http.StatusBadRequest, rec.Body.String())
	}
	if clientA.lastMethod != "" || clientB.lastMethod != "" {
		t.Fatalf("a save for an unknown endpoint reached one: a=%q b=%q", clientA.lastMethod, clientB.lastMethod)
	}
}

func TestHandleProxyDownloadRejectsNonFilesDownloadURI(t *testing.T) {
	client := &stubRuntimeEndpointClient{}
	s := &server{
		endpointByRef: map[string]runtimeEndpoint{
			"ep_main": {
				Ref:    "ep_main",
				Name:   "Main",
				URL:    "http://127.0.0.1:8787",
				Client: client,
			},
		},
	}

	target := url.QueryEscape("/tasks")
	req := httptest.NewRequest(http.MethodGet, "/console/api/proxy/download?endpoint=ep_main&uri="+target, nil)
	rec := httptest.NewRecorder()
	s.handleProxyDownload(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d (%s)", rec.Code, http.StatusBadRequest, rec.Body.String())
	}
	if client.lastDownloadPath != "" {
		t.Fatalf("client download path = %q, want empty", client.lastDownloadPath)
	}
}
