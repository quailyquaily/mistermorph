package builtin

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/quailyquaily/mistermorph/guard"
)

// These tests give a child process the environment the desktop app builds for its backend while
// an explicit proxy is running (desktop/nsh/src/proxy.rs: the eight standard names and the
// marker), and check where the core's clients connect. Go reads the proxy environment once per
// process, hence the child.

const (
	proxyChildModeEnv   = "MISTER_MORPH_TEST_PROXY_CHILD"
	proxyChildTargetEnv = "MISTER_MORPH_TEST_PROXY_TARGET"
)

// desktopProxyEnv is the backend's environment for an explicit proxy, as the desktop writes it.
func desktopProxyEnv(proxy *url.URL) []string {
	const bypass = "localhost,127.0.0.1,::1,[::1]"
	value := proxy.String()
	env := []string{
		"PATH=" + os.Getenv("PATH"),
		"HOME=" + os.Getenv("HOME"),
		DesktopProxyRequiredEnv + "=1",
		"NO_PROXY=" + bypass,
		"no_proxy=" + bypass,
	}
	for _, name := range []string{"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"} {
		env = append(env, name+"="+value)
	}
	return env
}

// runProxyChild runs the named scenario in a child with `env` and returns its result lines.
func runProxyChild(t *testing.T, mode string, env []string, target string) map[string]string {
	t.Helper()
	cmd := exec.Command(os.Args[0], "-test.run=^TestDesktopProxyEnvChild$", "-test.v")
	cmd.Env = append(env, proxyChildModeEnv+"="+mode, proxyChildTargetEnv+"="+target)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("child %s: %v\n%s", mode, err, out)
	}
	results := map[string]string{}
	for _, line := range strings.Split(string(out), "\n") {
		if rest, ok := strings.CutPrefix(strings.TrimSpace(line), "RESULT "); ok {
			if key, value, ok := strings.Cut(rest, "="); ok {
				results[key] = value
			}
		}
	}
	return results
}

func childResult(key string, value any) {
	fmt.Printf("RESULT %s=%v\n", key, value)
}

func childGet(rawURL string) string {
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get(rawURL)
	if err != nil {
		return "error: " + err.Error()
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
	return fmt.Sprintf("%d %s", resp.StatusCode, strings.TrimSpace(string(body)))
}

func childDial(rawURL string) string {
	dialer := *websocket.DefaultDialer
	dialer.HandshakeTimeout = 5 * time.Second
	conn, _, err := dialer.Dial(rawURL, nil)
	if err != nil {
		return "error: " + err.Error()
	}
	_ = conn.Close()
	return "connected"
}

// TestDesktopProxyEnvChild is the child: it does nothing unless a parent test started it.
func TestDesktopProxyEnvChild(t *testing.T) {
	mode := os.Getenv(proxyChildModeEnv)
	if mode == "" {
		t.Skip("runs as a child of the desktop proxy environment tests")
	}
	target := os.Getenv(proxyChildTargetEnv)
	switch mode {
	case "names":
		childResult("http", childGet("http://plain.invalid/page"))
		childResult("https", childGet("https://secure.invalid/page"))
		childResult("ws", childDial("ws://socket.invalid/ws"))
		childResult("wss", childDial("wss://secure-socket.invalid/ws"))
		childResult("loopback_ip", childGet("http://"+target+"/direct-ip"))
		_, port, _ := strings.Cut(target, ":")
		childResult("loopback_name", childGet("http://localhost:"+port+"/direct-name"))
		// url_fetch as the backend builds it: the marker comes from the environment.
		tool := NewURLFetchTool(true, 5*time.Second, 4096, "test-agent", os.TempDir())
		ctx := guard.WithNetworkPolicy(context.Background(), guard.NetworkPolicy{
			AllowedURLPrefixes: []string{"http://plain.invalid/"},
			DenyPrivateIPs:     true,
			FollowRedirects:    true,
			AllowProxy:         false,
		})
		_, err := tool.Execute(ctx, map[string]any{"url": "http://plain.invalid/fetch"})
		childResult("url_fetch_defaults", fmt.Sprint(err))
		ctx = guard.WithNetworkPolicy(context.Background(), guard.NetworkPolicy{
			AllowedURLPrefixes: []string{"http://plain.invalid/"},
			FollowRedirects:    true,
			AllowProxy:         true,
		})
		out, err := tool.Execute(ctx, map[string]any{"url": "http://plain.invalid/fetch"})
		childResult("url_fetch_permitted", fmt.Sprint(strings.Contains(out, "target-body /fetch"), " ", err))
	case "stream":
		client := &http.Client{Timeout: 10 * time.Second}
		began := time.Now()
		resp, err := client.Get("http://stream.invalid/stream")
		if err != nil {
			childResult("stream", "error: "+err.Error())
			return
		}
		defer resp.Body.Close()
		line, err := bufio.NewReader(resp.Body).ReadString('\n')
		childResult("stream", fmt.Sprintf("%s %v", strings.TrimSpace(line), err))
		// The server holds the stream open for seconds after the first event.
		childResult("stream_first_event_early", time.Since(began) < 2*time.Second)
	case "direct":
		childResult("http", childGet("http://"+target+"/page"))
		childResult("ws", childDial("ws://"+target+"/ws"))
	default:
		t.Fatalf("unknown mode %q", mode)
	}
}

func TestDesktopProxyEnv_HTTPProxy(t *testing.T) {
	target := newProxyTarget(t, "127.0.0.1")
	proxy := newFakeHTTPProxy(t, target.addr())
	user := url.UserPassword("mo rph@x", "p@ss:w%rd 1")
	got := runProxyChild(t, "names", desktopProxyEnv(proxy.url(user)), target.addr())

	if got["http"] != "200 target-body /page" {
		t.Fatalf("http = %q", got["http"])
	}
	if got["loopback_ip"] != "200 target-body /direct-ip" || got["loopback_name"] != "200 target-body /direct-name" {
		t.Fatalf("loopback requests = %q, %q", got["loopback_ip"], got["loopback_name"])
	}
	seen := strings.Join(proxy.seen(), "\n")
	for _, want := range []string{
		// The absolute form: the name goes to the proxy unresolved.
		"GET http://plain.invalid/page",
		"CONNECT secure.invalid:443",
		"CONNECT socket.invalid:80",
		"CONNECT secure-socket.invalid:443",
		"GET http://plain.invalid/fetch",
	} {
		if !strings.Contains(seen, want) {
			t.Fatalf("the proxy received:\n%s\nwant %q", seen, want)
		}
	}
	for _, never := range []string{"/direct-ip", "/direct-name", "127.0.0.1", "localhost"} {
		if strings.Contains(seen, never) {
			t.Fatalf("the proxy received a loopback request (%q):\n%s", never, seen)
		}
	}
	credentials := proxy.credentials()
	if len(credentials) == 0 {
		t.Fatalf("no request carried Proxy-Authorization")
	}
	for _, pair := range credentials {
		if pair != "mo rph@x:p@ss:w%rd 1" {
			t.Fatalf("Proxy-Authorization decoded to %q", pair)
		}
	}
	if !strings.Contains(got["url_fetch_defaults"], "guard.network.url_fetch.allow_proxy") {
		t.Fatalf("url_fetch under the default guard settings = %q", got["url_fetch_defaults"])
	}
	if got["url_fetch_permitted"] != "true <nil>" {
		t.Fatalf("permitted url_fetch = %q", got["url_fetch_permitted"])
	}
	if strings.Count(seen, "plain.invalid/fetch") != 1 {
		t.Fatalf("the refused url_fetch reached the proxy:\n%s", seen)
	}
}

func TestDesktopProxyEnv_CGIVariableDisablesHTTPProxy(t *testing.T) {
	// Why the desktop removes REQUEST_METHOD: with it Go refuses HTTP_PROXY.
	target := newProxyTarget(t, "127.0.0.1")
	proxy := newFakeHTTPProxy(t, target.addr())
	env := append(desktopProxyEnv(proxy.url(nil)), "REQUEST_METHOD=GET")
	got := runProxyChild(t, "names", env, target.addr())
	if !strings.HasPrefix(got["http"], "error: ") {
		t.Fatalf("http with REQUEST_METHOD = %q, want Go's refusal", got["http"])
	}
	if strings.Contains(strings.Join(proxy.seen(), "\n"), "GET http://plain.invalid/page") {
		t.Fatalf("Go used HTTP_PROXY despite REQUEST_METHOD")
	}
}

func TestDesktopProxyEnv_SOCKS5(t *testing.T) {
	target := newProxyTarget(t, "127.0.0.1")
	proxy := newFakeSOCKS5Proxy(t, target.addr(), true)
	env := desktopProxyEnv(proxy.url(url.UserPassword("mo rph@x", "p@ss:w%rd 1")))
	for _, entry := range env {
		if strings.Contains(entry, "socks5h://") {
			t.Fatalf("the backend's environment holds %q", entry)
		}
	}
	got := runProxyChild(t, "names", env, target.addr())
	if got["http"] != "200 target-body /page" {
		t.Fatalf("http = %q", got["http"])
	}
	want := map[string]uint16{"plain.invalid": 80, "secure.invalid": 443, "socket.invalid": 80, "secure-socket.invalid": 443}
	seen := proxy.seen()
	for _, request := range seen {
		if request.AddrType != 3 {
			t.Fatalf("the proxy received an address, not a name: %+v", request)
		}
		if request.Method != 2 || request.User != "mo rph@x" || request.Pass != "p@ss:w%rd 1" {
			t.Fatalf("authentication = %+v", request)
		}
		if port, ok := want[request.Host]; ok && port == request.Port {
			delete(want, request.Host)
		}
	}
	if len(want) != 0 {
		t.Fatalf("the proxy did not receive %v (got %+v)", want, seen)
	}
}

func TestDesktopProxyEnv_StreamStaysOpen(t *testing.T) {
	release := make(chan struct{})
	t.Cleanup(func() { close(release) })
	target := newProxyTarget(t, "127.0.0.1")
	target.server.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: first\n\n")
		w.(http.Flusher).Flush()
		select {
		case <-r.Context().Done():
		case <-release:
		case <-time.After(8 * time.Second):
		}
	})
	proxy := newFakeHTTPProxy(t, target.addr())
	got := runProxyChild(t, "stream", desktopProxyEnv(proxy.url(nil)), target.addr())
	if got["stream"] != "data: first <nil>" || got["stream_first_event_early"] != "true" {
		t.Fatalf("stream = %q, early = %q", got["stream"], got["stream_first_event_early"])
	}
	if seen := proxy.seen(); len(seen) != 1 || seen[0] != "GET http://stream.invalid/stream" {
		t.Fatalf("the proxy received %v", seen)
	}
}

func TestDesktopProxyEnv_NoFallback(t *testing.T) {
	cases := []struct {
		name  string
		proxy func(t *testing.T) *url.URL
	}{
		{"dead http proxy", func(t *testing.T) *url.URL { return &url.URL{Scheme: "http", Host: closedPort(t)} }},
		{"dead socks5 proxy", func(t *testing.T) *url.URL { return &url.URL{Scheme: "socks5", Host: closedPort(t)} }},
		{"refusing http proxy", func(t *testing.T) *url.URL { return newFakeHTTPProxy(t, "").url(nil) }},
		{"refusing socks5 proxy", func(t *testing.T) *url.URL { return newFakeSOCKS5Proxy(t, "", false).url(nil) }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			// The target answers a direct connection, on an address that is not loopback.
			target := newProxyTarget(t, nonLoopbackIPv4(t))
			got := runProxyChild(t, "direct", desktopProxyEnv(tc.proxy(t)), target.addr())
			if got["http"] == "" || got["ws"] == "" {
				t.Fatalf("the child reported nothing: %v", got)
			}
			if strings.HasPrefix(got["http"], "200") || got["ws"] == "connected" {
				t.Fatalf("a request got through: http=%q ws=%q", got["http"], got["ws"])
			}
			if target.hits.Load() != 0 {
				t.Fatalf("the target recorded %d connections", target.hits.Load())
			}
		})
	}
}
