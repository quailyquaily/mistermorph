package consolecmd

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/internal/configdefaults"
	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
	"github.com/quailyquaily/mistermorph/internal/daemonruntime/uploadtest"
	"github.com/quailyquaily/mistermorph/internal/runtimepaths"
	"github.com/spf13/viper"
)

// Uploads through the Console's proxy (FT197): streamed to the endpoint, within the runtime's
// budgets (128 MiB a file, 129 MiB a request), a few at a time, and forwarded to a remote runtime
// within five minutes while every other call keeps its 20 seconds.

type proxyRig struct {
	server   *server
	cacheDir string
	tempDir  string
}

// newProxyRig is a Console whose endpoint `ep` is a runtime in this process (as the Console's own
// agent is), with stock settings: its uploads land in its file cache.
func newProxyRig(t *testing.T) proxyRig {
	t.Helper()
	tempDir := t.TempDir()
	t.Setenv("TMPDIR", tempDir)
	cacheDir := t.TempDir()
	settings := viper.New()
	configdefaults.Apply(settings)
	mux := http.NewServeMux()
	daemonruntime.RegisterRoutes(mux, daemonruntime.RoutesOptions{
		Mode:                "console",
		AuthToken:           "token",
		RuntimePaths:        runtimepaths.Paths{CacheDir: cacheDir},
		AgentSettingsReader: settings,
		Workspace: daemonruntime.WorkspaceRoutes{Get: func(_ context.Context, _ string) (daemonruntime.WorkspaceResolution, error) {
			return daemonruntime.WorkspaceResolution{Source: "none"}, nil
		}},
	})
	client := newInProcessRuntimeEndpointClient(func() inProcessRuntimeView {
		return inProcessRuntimeView{handler: mux, authToken: "token"}
	}, nil)
	return proxyRig{server: endpointServer(client), cacheDir: cacheDir, tempDir: tempDir}
}

func endpointServer(client runtimeEndpointClient) *server {
	return &server{endpointByRef: map[string]runtimeEndpoint{
		"ep": {Ref: "ep", Name: "Agent", URL: "http://127.0.0.1:8787", Client: client},
	}}
}

type proxied struct {
	code   int
	header http.Header
	body   map[string]any
	raw    string
	stream *uploadtest.Body
}

func postUpload(t *testing.T, s *server, parts []uploadtest.Part, mutate func(*http.Request)) proxied {
	t.Helper()
	stream := uploadtest.NewBody(parts)
	req := httptest.NewRequest(http.MethodPost, "/console/api/proxy?endpoint=ep&uri=/files/upload", stream)
	req.ContentLength = uploadtest.Length(parts)
	req.Header.Set("Content-Type", uploadtest.ContentType)
	if mutate != nil {
		mutate(req)
	}
	rec := httptest.NewRecorder()
	s.handleProxy(rec, req)
	out := proxied{code: rec.Code, header: rec.Header(), raw: rec.Body.String(), stream: stream}
	_ = json.Unmarshal(rec.Body.Bytes(), &out.body)
	return out
}

func filePart(name string, size int64) uploadtest.Part {
	return uploadtest.Part{Name: name, File: true, Size: size}
}

func (rig proxyRig) stored(t *testing.T) []string {
	t.Helper()
	entries, err := os.ReadDir(filepath.Join(rig.cacheDir, "console"))
	if err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	var names []string
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	return names
}

func (rig proxyRig) assertClean(t *testing.T) {
	t.Helper()
	if entries, _ := os.ReadDir(rig.tempDir); len(entries) != 0 {
		t.Fatalf("temporary files left: %d", len(entries))
	}
	if n := len(consoleUploadSlots); n != 0 {
		t.Fatalf("%d upload slots still held", n)
	}
}

func TestProxyUploadTakesExactly129MiBThroughBothLayersAndRefusesOneByteMore(t *testing.T) {
	rig := newProxyRig(t)
	parts := []uploadtest.Part{filePart("big.bin", daemonruntime.FileUploadMaxFileBytes), filePart("rest.bin", 0)}
	parts[1].Size = daemonruntime.FileUploadMaxRequestBytes - uploadtest.Length(parts)
	ok := postUpload(t, rig.server, parts, nil)
	if ok.code != http.StatusOK || ok.header.Get(proxyUpstreamResponseHeader) != "1" {
		t.Fatalf("exact budget: status %d %s", ok.code, ok.raw)
	}
	if ok.stream.Consumed != 135_266_304 {
		t.Fatalf("read %d", ok.stream.Consumed)
	}
	for name, sum := range ok.stream.Sums() {
		raw, err := os.ReadFile(filepath.Join(rig.cacheDir, "console", name))
		if err != nil {
			t.Fatal(err)
		}
		if got := sha256.Sum256(raw); !bytes.Equal(got[:], sum) {
			t.Fatalf("%s differs", name)
		}
	}
	rig.assertClean(t)

	over := newProxyRig(t)
	parts[1].Size++
	result := postUpload(t, over.server, parts, func(r *http.Request) { r.ContentLength = -1 })
	if result.code != http.StatusRequestEntityTooLarge || result.body["code"] != daemonruntime.UploadCodeRequestTooLarge {
		t.Fatalf("one byte over: %d %s", result.code, result.raw)
	}
	// The proxy says it as the runtime does.
	if result.body["error"] != daemonruntime.UploadRequestTooLargeMessage() || result.body["limit_bytes"] != float64(135_266_304) {
		t.Fatalf("refusal %s", result.raw)
	}
	if names := over.stored(t); len(names) != 0 {
		t.Fatalf("stored: %v", names)
	}
	over.assertClean(t)
}

func TestProxyUploadPassesAMaximumFileAndForwardsTheRuntimesPerFileRefusal(t *testing.T) {
	rig := newProxyRig(t)
	ok := postUpload(t, rig.server, []uploadtest.Part{{Name: "topic_id", Value: "topic_a"}, filePart("max.bin", 134_217_728)}, nil)
	if ok.code != http.StatusOK {
		t.Fatalf("maximum file: %d %s", ok.code, ok.raw)
	}
	rig.assertClean(t)
	over := newProxyRig(t)
	result := postUpload(t, over.server, []uploadtest.Part{filePart("over.bin", 134_217_729)}, nil)
	if result.code != http.StatusRequestEntityTooLarge || result.body["code"] != daemonruntime.UploadCodeFileTooLarge {
		t.Fatalf("one byte over: %d %s", result.code, result.raw)
	}
	if result.header.Get(proxyUpstreamResponseHeader) != "1" || !strings.Contains(result.raw, "128 MiB (134217728 bytes)") {
		t.Fatalf("refusal %s", result.raw)
	}
	over.assertClean(t)
}

func TestProxyUploadRefusesADeclaredOversizeBodyWithoutReadingIt(t *testing.T) {
	rig := newProxyRig(t)
	result := postUpload(t, rig.server, []uploadtest.Part{filePart("big.bin", 200<<20)}, nil)
	if result.code != http.StatusRequestEntityTooLarge || result.body["code"] != daemonruntime.UploadCodeRequestTooLarge || result.stream.Consumed != 0 {
		t.Fatalf("%d %s (read %d)", result.code, result.raw, result.stream.Consumed)
	}
	rig.assertClean(t)
}

// streamingStub is an endpoint that streams uploads: it notes what had been read of the
// client's body when it was handed it, then reads it (or waits for `hold`).
type streamingStub struct {
	stubRuntimeEndpointClient
	mu           sync.Mutex
	readAtHanded []int64
	stream       *uploadtest.Body
	hold         chan struct{}
	entered      chan struct{}
	err          error
	proxyCalls   int
}

func (s *streamingStub) Proxy(ctx context.Context, method, path string, body []byte, ct string) (int, []byte, error) {
	s.mu.Lock()
	s.proxyCalls++
	s.mu.Unlock()
	return s.stubRuntimeEndpointClient.Proxy(ctx, method, path, body, ct)
}

func (s *streamingStub) ProxyUpload(ctx context.Context, path string, body io.Reader, _ int64, _ string) (int, []byte, error) {
	s.mu.Lock()
	if s.stream != nil {
		s.readAtHanded = append(s.readAtHanded, s.stream.Consumed)
	}
	s.mu.Unlock()
	if s.entered != nil {
		s.entered <- struct{}{}
	}
	if s.hold != nil {
		select {
		case <-s.hold:
		case <-ctx.Done():
			return 0, nil, ctx.Err()
		}
	}
	n, err := io.Copy(io.Discard, body)
	if err != nil {
		return 0, nil, err
	}
	if s.err != nil {
		return 0, nil, s.err
	}
	return http.StatusOK, []byte(`{"files":[],"read":` + jsonInt(n) + `}`), nil
}

func jsonInt(n int64) string {
	raw, _ := json.Marshal(n)
	return string(raw)
}

func TestProxyUploadStreamsTheBodyInsteadOfBufferingIt(t *testing.T) {
	stub := &streamingStub{}
	s := endpointServer(stub)
	parts := []uploadtest.Part{filePart("big.bin", 100<<20)}
	stream := uploadtest.NewBody(parts)
	stub.stream = stream
	req := httptest.NewRequest(http.MethodPost, "/console/api/proxy?endpoint=ep&uri=/files/upload", stream)
	req.ContentLength = uploadtest.Length(parts)
	req.Header.Set("Content-Type", uploadtest.ContentType)
	rec := httptest.NewRecorder()
	s.handleProxy(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	// Handed over before a byte was read, and never as a buffered body.
	if len(stub.readAtHanded) != 1 || stub.readAtHanded[0] != 0 || stub.proxyCalls != 0 {
		t.Fatalf("read before handing over %v, buffered calls %d", stub.readAtHanded, stub.proxyCalls)
	}
	if !strings.Contains(rec.Body.String(), `"read":`+jsonInt(uploadtest.Length(parts))) {
		t.Fatalf("forwarded %s", rec.Body.String())
	}
}

func TestProxyUploadStreamsAFewAtATimeAndAsksTheNextToRetry(t *testing.T) {
	stub := &streamingStub{hold: make(chan struct{}), entered: make(chan struct{}, consoleUploadConcurrency)}
	s := endpointServer(stub)
	parts := []uploadtest.Part{filePart("a.bin", 1<<20)}
	var wg sync.WaitGroup
	codes := make(chan int, consoleUploadConcurrency)
	for i := 0; i < consoleUploadConcurrency; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			codes <- postUpload(t, s, parts, nil).code
		}()
	}
	for i := 0; i < consoleUploadConcurrency; i++ {
		<-stub.entered
	}
	busy := postUpload(t, s, parts, nil)
	if busy.code != http.StatusServiceUnavailable || busy.header.Get("Retry-After") != "5" || busy.body["code"] != daemonruntime.UploadCodeBusy {
		t.Fatalf("over the slots: %d %v %s", busy.code, busy.header, busy.raw)
	}
	if busy.stream.Consumed != 0 {
		t.Fatalf("read %d of a refused upload", busy.stream.Consumed)
	}
	close(stub.hold)
	wg.Wait()
	close(codes)
	for code := range codes {
		if code != http.StatusOK {
			t.Fatalf("held upload ended %d", code)
		}
	}
	if n := len(consoleUploadSlots); n != 0 {
		t.Fatalf("%d slots held", n)
	}
	// Every way out gives the slot back: a failing endpoint, a refused size, a cancelled client.
	stub.hold, stub.entered, stub.err = nil, nil, errors.New("agent unreachable")
	if failed := postUpload(t, s, parts, nil); failed.code != http.StatusServiceUnavailable || failed.body["code"] == daemonruntime.UploadCodeBusy {
		t.Fatalf("failing endpoint: %d %s", failed.code, failed.raw)
	}
	stub.err = nil
	_ = postUpload(t, s, []uploadtest.Part{filePart("huge.bin", 300<<20)}, nil)
	ctx, cancel := context.WithCancel(context.Background())
	stub.hold = make(chan struct{})
	stub.entered = make(chan struct{}, 1)
	done := make(chan proxied, 1)
	go func() {
		done <- postUpload(t, s, parts, func(r *http.Request) { *r = *r.WithContext(ctx) })
	}()
	<-stub.entered
	cancel()
	if out := <-done; out.code == http.StatusOK {
		t.Fatalf("cancelled upload answered %d", out.code)
	}
	if n := len(consoleUploadSlots); n != 0 {
		t.Fatalf("%d slots held after failures", n)
	}
}

/* ---------- a remote runtime ---------- */

// remoteRuntime is a runtime on another machine: it reads an upload with `read` (nil: at once)
// and answers what it read.
func remoteRuntime(t *testing.T, read func(r *http.Request) (int64, []byte, error)) (*httptest.Server, *daemonTaskClient) {
	t.Helper()
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer remote-token" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		if read == nil {
			_, _ = io.Copy(io.Discard, r.Body)
			_, _ = w.Write([]byte(`{"files":[]}`))
			return
		}
		n, sum, err := read(r)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"read": n, "sha256": sum})
	}))
	t.Cleanup(remote.Close)
	return remote, newDaemonTaskClient(remote.URL, "remote-token")
}

func TestRemoteUploadsGetFiveMinutesWhileOtherCallsKeepTwentySeconds(t *testing.T) {
	client := newDaemonTaskClient("http://127.0.0.1:1", "token")
	if client.client.Timeout != 20*time.Second || client.uploadClient.Timeout != 5*time.Minute {
		t.Fatalf("timeouts = %v / %v", client.client.Timeout, client.uploadClient.Timeout)
	}
	// The same slow runtime (an answer after 600 ms) outlasts an ordinary call's timeout but not an upload's.
	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		time.Sleep(600 * time.Millisecond)
		_, _ = w.Write([]byte(`{}`))
	}))
	defer slow.Close()
	c := newDaemonTaskClient(slow.URL, "token")
	c.client.Timeout = 300 * time.Millisecond
	c.uploadClient.Timeout = 3 * time.Second
	if _, _, err := c.Proxy(context.Background(), http.MethodGet, "/tasks", nil, ""); err == nil {
		t.Fatal("an ordinary call outlived its timeout")
	}
	if status, _, err := c.ProxyUpload(context.Background(), "/files/upload", strings.NewReader("x"), 1, "text/plain"); err != nil || status != http.StatusOK {
		t.Fatalf("upload: %d %v", status, err)
	}
}

func TestRemoteUploadStalledPastItsTimeoutEndsWithAGatewayTimeoutAndStopsTheRemoteWork(t *testing.T) {
	stopped := make(chan struct{})
	_, client := remoteRuntime(t, func(r *http.Request) (int64, []byte, error) {
		_, _ = io.Copy(io.Discard, r.Body)
		<-r.Context().Done()
		close(stopped)
		return 0, nil, r.Context().Err()
	})
	client.uploadClient.Timeout = 400 * time.Millisecond
	s := endpointServer(client)
	started := time.Now()
	result := postUpload(t, s, []uploadtest.Part{filePart("a.bin", 1<<20)}, nil)
	if result.code != http.StatusGatewayTimeout {
		t.Fatalf("stalled: %d %s", result.code, result.raw)
	}
	if elapsed := time.Since(started); elapsed > 5*time.Second {
		t.Fatalf("took %v", elapsed)
	}
	select {
	case <-stopped:
	case <-time.After(5 * time.Second):
		t.Fatal("the remote request was not cancelled")
	}
	if n := len(consoleUploadSlots); n != 0 {
		t.Fatalf("%d slots held", n)
	}
}

func TestRemoteUploadCancelledByTheClientStopsForwarding(t *testing.T) {
	gotBytes := make(chan struct{}, 1)
	stopped := make(chan struct{})
	_, client := remoteRuntime(t, func(r *http.Request) (int64, []byte, error) {
		buf := make([]byte, 1<<20)
		_, _ = io.ReadFull(r.Body, buf)
		gotBytes <- struct{}{}
		_, err := io.Copy(io.Discard, r.Body)
		close(stopped)
		return 0, nil, err
	})
	s := endpointServer(client)
	ctx, cancel := context.WithCancel(context.Background())
	// A client that sends 2 MiB, then nothing until it goes away.
	pr, pw := io.Pipe()
	go func() {
		_, _ = io.Copy(pw, uploadtest.NewBody([]uploadtest.Part{filePart("a.bin", 2<<20)}))
		<-ctx.Done()
		_ = pw.CloseWithError(context.Canceled)
	}()
	req := httptest.NewRequest(http.MethodPost, "/console/api/proxy?endpoint=ep&uri=/files/upload", pr).WithContext(ctx)
	req.ContentLength = -1
	req.Header.Set("Content-Type", uploadtest.ContentType)
	rec := httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		s.handleProxy(rec, req)
		close(done)
	}()
	<-gotBytes
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the proxy kept forwarding a cancelled upload")
	}
	select {
	case <-stopped:
	case <-time.After(5 * time.Second):
		t.Fatal("the remote kept reading")
	}
	if rec.Code == http.StatusOK || len(consoleUploadSlots) != 0 {
		t.Fatalf("status %d, slots %d", rec.Code, len(consoleUploadSlots))
	}
}

func TestRemoteRefusalsAreForwardedAsTheRemoteSaidThem(t *testing.T) {
	cases := []struct {
		name, contentType, body, want string
	}{
		// An ingress in front of the remote runtime: HTML, no limit given.
		{"html", "text/html", "<html><body><h1>413 Request Entity Too Large</h1></body></html>", "413 Request Entity Too Large"},
		// A runtime from before FT197.
		{"old runtime", "text/plain", "upload exceeds 64 MiB\n", "upload exceeds 64 MiB"},
		{"json", "application/json", `{"error":"upload request exceeds 32 MiB","code":"upload_request_too_large"}`, "32 MiB"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", tc.contentType)
				w.WriteHeader(http.StatusRequestEntityTooLarge)
				_, _ = io.WriteString(w, tc.body)
			}))
			defer remote.Close()
			result := postUpload(t, endpointServer(newDaemonTaskClient(remote.URL, "t")), []uploadtest.Part{filePart("a.bin", 65<<20)}, nil)
			if result.code != http.StatusRequestEntityTooLarge || result.header.Get(proxyUpstreamResponseHeader) != "1" {
				t.Fatalf("%d %v", result.code, result.header)
			}
			if msg, _ := result.body["error"].(string); !strings.Contains(msg, tc.want) {
				t.Fatalf("error = %q", result.raw)
			}
		})
	}
}

// A 19 MiB upload a slow link takes about 31 seconds to forward, longer than an ordinary call's
// 20 seconds, goes through with the stock client.
func TestRemoteUploadOfNineteenMiBTakingHalfAMinuteSucceedsWithTheDefaults(t *testing.T) {
	if testing.Short() {
		t.Skip("takes half a minute")
	}
	const size = 19 << 20
	const chunk = 512 << 10
	_, client := remoteRuntime(t, func(r *http.Request) (int64, []byte, error) {
		// About 31 s for the whole body: a pause before each chunk.
		pause := 31 * time.Second / time.Duration(size/chunk)
		h := sha256.New()
		var n int64
		buf := make([]byte, chunk)
		for {
			time.Sleep(pause)
			read, err := io.ReadFull(r.Body, buf)
			n += int64(read)
			h.Write(buf[:read])
			if err == io.EOF || err == io.ErrUnexpectedEOF {
				break
			}
			if err != nil {
				return n, nil, err
			}
		}
		return n, h.Sum(nil), nil
	})
	parts := []uploadtest.Part{filePart("photo.jpg", 0)}
	content, err := uploadtest.JPEG(size)
	if err != nil {
		t.Fatal(err)
	}
	parts[0].Content, parts[0].Size = content, size
	started := time.Now()
	stream := uploadtest.NewBody(parts)
	req := httptest.NewRequest(http.MethodPost, "/console/api/proxy?endpoint=ep&uri=/files/upload", stream)
	req.ContentLength = uploadtest.Length(parts)
	req.Header.Set("Content-Type", uploadtest.ContentType)
	rec := httptest.NewRecorder()
	endpointServer(client).handleProxy(rec, req)
	elapsed := time.Since(started)
	if rec.Code != http.StatusOK {
		t.Fatalf("%d %s after %v", rec.Code, rec.Body.String(), elapsed)
	}
	if elapsed < 25*time.Second || elapsed > 70*time.Second {
		t.Fatalf("forwarding took %v, not about 31 s", elapsed)
	}
	var answer struct {
		Read int64 `json:"read"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &answer)
	if answer.Read != uploadtest.Length(parts) {
		t.Fatalf("remote read %d of %d", answer.Read, uploadtest.Length(parts))
	}
	t.Logf("19 MiB JPEG: file %d bytes, request %d bytes, forwarded in %v", int64(size), uploadtest.Length(parts), elapsed.Round(time.Second))
}

// Five large uploads into the stock 512 MiB file cache: the oldest is evicted (the runtime keeps
// only the batch it is writing), and a message naming it is refused with its index, which the
// Console turns into "upload it again" on that attachment.
func TestFiveLargeUploadsEvictTheOldestAndAReferenceToItIsRefused(t *testing.T) {
	rig := newProxyRig(t)
	for i, name := range []string{"one.bin", "two.bin", "three.bin", "four.bin", "five.bin"} {
		result := postUpload(t, rig.server, []uploadtest.Part{filePart(name, 110<<20)}, nil)
		if result.code != http.StatusOK {
			t.Fatalf("upload %d: %d %s", i, result.code, result.raw)
		}
		time.Sleep(20 * time.Millisecond)
	}
	stored := strings.Join(rig.stored(t), ",")
	if strings.Contains(stored, "one.bin") || !strings.Contains(stored, "five.bin") {
		t.Fatalf("stored = %s", stored)
	}
	refs := []daemonruntime.FileReference{{DirName: "file_cache_dir", Path: "console/one.bin"}, {DirName: "file_cache_dir", Path: "console/five.bin"}}
	_, err := validateConsoleFileReferences(refs, "", rig.cacheDir)
	if err == nil || !strings.Contains(err.Error(), "file_references[0]: file does not exist") {
		t.Fatalf("validate = %v", err)
	}
	rig.assertClean(t)
}
