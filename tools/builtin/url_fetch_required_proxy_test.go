package builtin

import (
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/guard"
	"github.com/quailyquaily/mistermorph/secrets"
)

// proxyTarget is the server behind a fake proxy. It counts what reaches it, and what reached it
// without the proxy's mark.
type proxyTarget struct {
	server *httptest.Server
	hits   atomic.Int64
	direct atomic.Int64
	auth   atomic.Value
}

func newProxyTarget(t *testing.T, host string) *proxyTarget {
	t.Helper()
	target := &proxyTarget{}
	listener, err := net.Listen("tcp", net.JoinHostPort(host, "0"))
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	target.server = httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		target.hits.Add(1)
		if r.Header.Get("X-Via-Fake-Proxy") == "" {
			target.direct.Add(1)
		}
		target.auth.Store(r.Header.Get("Authorization"))
		switch r.URL.Path {
		case "/redirect-out":
			http.Redirect(w, r, "http://other.test/landed", http.StatusFound)
		case "/redirect-name":
			http.Redirect(w, r, "http://target.test/landed", http.StatusFound)
		default:
			_, _ = io.WriteString(w, "target-body "+r.URL.Path)
		}
	}))
	_ = target.server.Listener.Close()
	target.server.Listener = listener
	target.server.Start()
	t.Cleanup(target.server.Close)
	return target
}

func (p *proxyTarget) addr() string { return p.server.Listener.Addr().String() }

// dialRecord notes every address a transport dialed.
type dialRecord struct {
	mu    sync.Mutex
	addrs []string
}

func (d *dialRecord) dial(ctx context.Context, network, address string) (net.Conn, error) {
	d.mu.Lock()
	d.addrs = append(d.addrs, address)
	d.mu.Unlock()
	return (&net.Dialer{}).DialContext(ctx, network, address)
}

func (d *dialRecord) seen() []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]string{}, d.addrs...)
}

// assertOnly fails when anything but `allowed` was dialed.
func (d *dialRecord) assertOnly(t *testing.T, allowed string) {
	t.Helper()
	for _, addr := range d.seen() {
		if addr != allowed {
			t.Fatalf("dialed %q; only the proxy %q may be dialed (all: %v)", addr, allowed, d.seen())
		}
	}
}

func requiredTool(t *testing.T, proxy *url.URL, dials *dialRecord) *URLFetchTool {
	t.Helper()
	tool := NewURLFetchTool(true, 5*time.Second, 4096, "test-agent", t.TempDir())
	tool.requiredProxy = &requiredProxyRoute{
		proxy: func(*http.Request) (*url.URL, error) { return proxy, nil },
		dial:  dials.dial,
	}
	return tool
}

func TestURLFetchRequiredProxy_GuardSettings(t *testing.T) {
	cases := []struct {
		name string
		// guardOff runs without a guard policy.
		guardOff     bool
		allowProxy   bool
		denyPrivate  bool
		prefixes     []string
		url          string
		wantErr      []string
		wantBody     string
		wantAtProxy  string
		wantNoAtAll  bool
		wantRedirect bool
	}{
		{
			name:        "defaults refuse a host name",
			denyPrivate: true,
			url:         "http://target.test/page",
			wantErr:     []string{"requires a network proxy", "guard.network.url_fetch.allow_proxy"},
			wantNoAtAll: true,
		},
		{
			name:        "allow_proxy false only",
			url:         "http://target.test/page",
			wantErr:     []string{"requires a network proxy", "guard.network.url_fetch.allow_proxy is false"},
			wantNoAtAll: true,
		},
		{
			name:        "deny_private_ips true only refuses a host name",
			allowProxy:  true,
			denyPrivate: true,
			url:         "http://target.test/page",
			wantErr:     []string{"requires a network proxy", "guard.network.url_fetch.deny_private_ips is true", `"target.test"`},
			wantNoAtAll: true,
		},
		{
			name:        "deny_private_ips true refuses a private address as before",
			allowProxy:  true,
			denyPrivate: true,
			prefixes:    []string{"http://10.1.2.3/"},
			url:         "http://10.1.2.3/page",
			wantErr:     []string{"url is not allowed by guard: private_ip"},
			wantNoAtAll: true,
		},
		{
			name:        "deny_private_ips true sends an allowed address through the proxy",
			allowProxy:  true,
			denyPrivate: true,
			prefixes:    []string{"http://203.0.113.10/"},
			url:         "http://203.0.113.10/page",
			wantBody:    "target-body /page",
			wantAtProxy: "GET http://203.0.113.10/page",
		},
		{
			name:        "permitted host name goes through the proxy",
			allowProxy:  true,
			url:         "http://target.test/page",
			wantBody:    "target-body /page",
			wantAtProxy: "GET http://target.test/page",
		},
		{
			name:        "allowed prefixes still apply",
			allowProxy:  true,
			prefixes:    []string{"http://elsewhere.test/"},
			url:         "http://target.test/page",
			wantErr:     []string{"url is not allowed by guard: non_allowlisted_domain"},
			wantNoAtAll: true,
		},
		{
			name:        "without a guard the proxy is the route",
			guardOff:    true,
			url:         "http://target.test/page",
			wantBody:    "target-body /page",
			wantAtProxy: "GET http://target.test/page",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			target := newProxyTarget(t, "127.0.0.1")
			proxy := newFakeHTTPProxy(t, target.addr())
			dials := &dialRecord{}
			tool := requiredTool(t, proxy.url(nil), dials)
			ctx := context.Background()
			if !tc.guardOff {
				prefixes := tc.prefixes
				if prefixes == nil {
					prefixes = []string{"http://target.test/"}
				}
				ctx = guard.WithNetworkPolicy(ctx, guard.NetworkPolicy{
					AllowedURLPrefixes: prefixes,
					DenyPrivateIPs:     tc.denyPrivate,
					FollowRedirects:    true,
					AllowProxy:         tc.allowProxy,
				})
			}
			out, err := tool.Execute(ctx, map[string]any{"url": tc.url})
			if len(tc.wantErr) > 0 {
				if err == nil {
					t.Fatalf("Execute() = %q, want an error", out)
				}
				for _, want := range tc.wantErr {
					if !strings.Contains(err.Error(), want) {
						t.Fatalf("error = %q, want it to contain %q", err, want)
					}
				}
			} else if err != nil {
				t.Fatalf("Execute() error = %v", err)
			}
			if tc.wantBody != "" && !strings.Contains(out, tc.wantBody) {
				t.Fatalf("output = %q, want %q", out, tc.wantBody)
			}
			if tc.wantNoAtAll {
				if got := proxy.seen(); len(got) != 0 {
					t.Fatalf("the proxy received %v, want nothing", got)
				}
				if got := dials.seen(); len(got) != 0 {
					t.Fatalf("dialed %v, want no connection anywhere", got)
				}
			}
			if tc.wantAtProxy != "" {
				got := proxy.seen()
				if len(got) != 1 || got[0] != tc.wantAtProxy {
					t.Fatalf("the proxy received %v, want [%s]", got, tc.wantAtProxy)
				}
			}
			dials.assertOnly(t, proxy.addr())
			if target.direct.Load() != 0 {
				t.Fatalf("the target received %d direct requests", target.direct.Load())
			}
		})
	}
}

func TestURLFetchRequiredProxy_AuthProfile(t *testing.T) {
	binding := secrets.ToolBinding{Inject: secrets.Inject{Location: "header", Name: "Authorization", Format: "bearer"}}
	run := func(t *testing.T, profileAllowsProxy bool, rawURL string) (string, error, *fakeHTTPProxy, *dialRecord, *proxyTarget) {
		t.Helper()
		target := newProxyTarget(t, "127.0.0.1")
		proxy := newFakeHTTPProxy(t, target.addr())
		dials := &dialRecord{}
		profile := testProfileForURL(t, "p1", "http://target.test/api/", binding)
		profile.Allow.URLPrefixes = []string{"http://target.test/api/"}
		profile.Allow.AllowProxy = profileAllowsProxy
		tool := NewURLFetchToolWithAuth(true, 5*time.Second, 4096, "test-agent", t.TempDir(), &URLFetchAuth{
			AllowProfiles: map[string]bool{"p1": true},
			Profiles:      secrets.NewProfileStore(map[string]secrets.AuthProfile{"p1": profile}),
		})
		tool.requiredProxy = &requiredProxyRoute{
			proxy: func(*http.Request) (*url.URL, error) { return proxy.url(nil), nil },
			dial:  dials.dial,
		}
		// The guard permits: only the profile decides.
		ctx := guard.WithNetworkPolicy(context.Background(), guard.NetworkPolicy{
			AllowedURLPrefixes: []string{"http://target.test/"},
			FollowRedirects:    true,
			AllowProxy:         true,
		})
		out, err := tool.Execute(ctx, map[string]any{"url": rawURL, "auth_profile": "p1"})
		return out, err, proxy, dials, target
	}

	t.Run("profile allow_proxy false refuses", func(t *testing.T) {
		out, err, proxy, dials, target := run(t, false, "http://target.test/api/item")
		if err == nil {
			t.Fatalf("Execute() = %q, want an error", out)
		}
		for _, want := range []string{"requires a network proxy", `auth profile "p1"`, "allow_proxy false"} {
			if !strings.Contains(err.Error(), want) {
				t.Fatalf("error = %q, want it to contain %q", err, want)
			}
		}
		if len(proxy.seen()) != 0 || len(dials.seen()) != 0 || target.hits.Load() != 0 {
			t.Fatalf("something was sent: proxy=%v dials=%v target=%d", proxy.seen(), dials.seen(), target.hits.Load())
		}
	})

	t.Run("profile allow_proxy true goes through the proxy", func(t *testing.T) {
		out, err, proxy, dials, target := run(t, true, "http://target.test/api/item")
		if err != nil {
			t.Fatalf("Execute() error = %v", err)
		}
		if !strings.Contains(out, "target-body /api/item") {
			t.Fatalf("output = %q", out)
		}
		if got := proxy.seen(); len(got) != 1 || got[0] != "GET http://target.test/api/item" {
			t.Fatalf("the proxy received %v", got)
		}
		dials.assertOnly(t, proxy.addr())
		if got, _ := target.auth.Load().(string); got != "Bearer shh_secret" {
			t.Fatalf("the target received Authorization %q", got)
		}
		if target.direct.Load() != 0 {
			t.Fatalf("the target received a direct request")
		}
	})

	t.Run("the profile's url rules still apply", func(t *testing.T) {
		out, err, proxy, dials, _ := run(t, true, "http://target.test/other/item")
		if err == nil {
			t.Fatalf("Execute() = %q, want an error", out)
		}
		if strings.Contains(err.Error(), "network proxy") {
			t.Fatalf("error = %q, want the profile's own url rule", err)
		}
		if len(proxy.seen()) != 0 || len(dials.seen()) != 0 {
			t.Fatalf("something was sent: proxy=%v dials=%v", proxy.seen(), dials.seen())
		}
	})
}

func TestURLFetchRequiredProxy_Redirects(t *testing.T) {
	t.Run("a hop the guard forbids is refused", func(t *testing.T) {
		target := newProxyTarget(t, "127.0.0.1")
		proxy := newFakeHTTPProxy(t, target.addr())
		dials := &dialRecord{}
		tool := requiredTool(t, proxy.url(nil), dials)
		ctx := guard.WithNetworkPolicy(context.Background(), guard.NetworkPolicy{
			AllowedURLPrefixes: []string{"http://target.test/"},
			FollowRedirects:    true,
			AllowProxy:         true,
		})
		out, err := tool.Execute(ctx, map[string]any{"url": "http://target.test/redirect-out"})
		if err == nil || !strings.Contains(err.Error(), "redirect url is not allowed by guard") {
			t.Fatalf("Execute() = %q, %v; want the guard's redirect refusal", out, err)
		}
		if got := proxy.seen(); len(got) != 1 {
			t.Fatalf("the proxy received %v, want the first hop only", got)
		}
		dials.assertOnly(t, proxy.addr())
	})

	t.Run("a hop to a host name is refused while deny_private_ips is true", func(t *testing.T) {
		target := newProxyTarget(t, "127.0.0.1")
		proxy := newFakeHTTPProxy(t, target.addr())
		dials := &dialRecord{}
		tool := requiredTool(t, proxy.url(nil), dials)
		ctx := guard.WithNetworkPolicy(context.Background(), guard.NetworkPolicy{
			AllowedURLPrefixes: []string{"http://203.0.113.10/", "http://target.test/"},
			DenyPrivateIPs:     true,
			FollowRedirects:    true,
			AllowProxy:         true,
		})
		out, err := tool.Execute(ctx, map[string]any{"url": "http://203.0.113.10/redirect-name"})
		if err == nil {
			t.Fatalf("Execute() = %q, want the hop refused", out)
		}
		if got := proxy.seen(); len(got) != 1 {
			t.Fatalf("the proxy received %v, want the first hop only", got)
		}
		dials.assertOnly(t, proxy.addr())
		if target.direct.Load() != 0 {
			t.Fatalf("the target received a direct request")
		}
	})

	t.Run("the policy runs on every hop", func(t *testing.T) {
		// Without a guard nothing stops the redirect itself: the hop is checked by the route.
		policy := &requiredProxyPolicy{guardOn: true, guard: guard.NetworkPolicy{AllowProxy: true, DenyPrivateIPs: true}}
		policy.route.proxy = func(*http.Request) (*url.URL, error) { return &url.URL{Scheme: "http", Host: "127.0.0.1:9"}, nil }
		first, _ := url.Parse("http://203.0.113.10/a")
		if err := policy.check(first); err != nil {
			t.Fatalf("first hop: %v", err)
		}
		hop, _ := url.Parse("http://name.test/b")
		if err := policy.check(hop); err == nil || !strings.Contains(err.Error(), "deny_private_ips") {
			t.Fatalf("hop error = %v, want the deny_private_ips refusal", err)
		}
	})

	t.Run("without a guard a hop to another host uses the proxy", func(t *testing.T) {
		target := newProxyTarget(t, "127.0.0.1")
		proxy := newFakeHTTPProxy(t, target.addr())
		dials := &dialRecord{}
		tool := requiredTool(t, proxy.url(nil), dials)
		out, err := tool.Execute(context.Background(), map[string]any{"url": "http://target.test/redirect-out"})
		if err != nil {
			t.Fatalf("Execute() error = %v", err)
		}
		if !strings.Contains(out, "target-body /landed") {
			t.Fatalf("output = %q", out)
		}
		got := proxy.seen()
		if len(got) != 2 || got[1] != "GET http://other.test/landed" {
			t.Fatalf("the proxy received %v", got)
		}
		dials.assertOnly(t, proxy.addr())
	})
}

func TestURLFetchRequiredProxy_NeverConnectsDirect(t *testing.T) {
	user := url.UserPassword("morph", "s3cr@t:pw")
	for _, scheme := range []string{"http", "socks5"} {
		t.Run("dead "+scheme+" proxy", func(t *testing.T) {
			// A target that answers a direct connection: it must record none.
			target := newProxyTarget(t, nonLoopbackIPv4(t))
			dead := closedPort(t)
			dials := &dialRecord{}
			tool := requiredTool(t, &url.URL{Scheme: scheme, Host: dead, User: user}, dials)
			out, err := tool.Execute(context.Background(), map[string]any{"url": "http://" + target.addr() + "/page"})
			if err == nil {
				t.Fatalf("Execute() = %q, want an error", out)
			}
			wantType := "HTTP"
			if scheme == "socks5" {
				wantType = "SOCKS5"
			}
			for _, want := range []string{"required network proxy", wantType + " " + dead} {
				if !strings.Contains(err.Error(), want) {
					t.Fatalf("error = %q, want it to contain %q", err, want)
				}
			}
			for _, secret := range []string{"s3cr@t:pw", "s3cr%40t%3Apw", "morph:"} {
				if strings.Contains(err.Error(), secret) {
					t.Fatalf("error = %q holds the credential %q", err, secret)
				}
			}
			if target.hits.Load() != 0 {
				t.Fatalf("the target received %d requests without the proxy", target.hits.Load())
			}
			dials.assertOnly(t, dead)
		})
	}

	t.Run("a refusing http proxy is surfaced", func(t *testing.T) {
		target := newProxyTarget(t, nonLoopbackIPv4(t))
		proxy := newFakeHTTPProxy(t, "")
		dials := &dialRecord{}
		tool := requiredTool(t, proxy.url(nil), dials)
		out, err := tool.Execute(context.Background(), map[string]any{"url": "http://" + target.addr() + "/page"})
		if err == nil && !strings.Contains(out, "502") {
			t.Fatalf("Execute() = %q, want the proxy's 502", out)
		}
		if target.hits.Load() != 0 {
			t.Fatalf("the target received %d requests", target.hits.Load())
		}
		dials.assertOnly(t, proxy.addr())
	})

	t.Run("a refusing socks5 proxy is surfaced", func(t *testing.T) {
		target := newProxyTarget(t, nonLoopbackIPv4(t))
		proxy := newFakeSOCKS5Proxy(t, "", false)
		dials := &dialRecord{}
		tool := requiredTool(t, proxy.url(nil), dials)
		out, err := tool.Execute(context.Background(), map[string]any{"url": "http://" + target.addr() + "/page"})
		if err == nil {
			t.Fatalf("Execute() = %q, want an error", out)
		}
		if !strings.Contains(err.Error(), "SOCKS5 "+proxy.addr()) {
			t.Fatalf("error = %q, want the proxy named", err)
		}
		if target.hits.Load() != 0 {
			t.Fatalf("the target received %d requests", target.hits.Load())
		}
		dials.assertOnly(t, proxy.addr())
	})

	t.Run("a route without a proxy is refused", func(t *testing.T) {
		dials := &dialRecord{}
		tool := requiredTool(t, nil, dials)
		out, err := tool.Execute(context.Background(), map[string]any{"url": "http://target.test/page"})
		if err == nil || !strings.Contains(err.Error(), "does not connect directly") {
			t.Fatalf("Execute() = %q, %v; want a refusal", out, err)
		}
		if len(dials.seen()) != 0 {
			t.Fatalf("dialed %v", dials.seen())
		}
	})

	t.Run("the dialer refuses any other address", func(t *testing.T) {
		policy := &requiredProxyPolicy{}
		policy.route.proxy = func(*http.Request) (*url.URL, error) { return &url.URL{Scheme: "http", Host: "127.0.0.1:9"}, nil }
		client := &http.Client{}
		if err := policy.apply(client); err != nil {
			t.Fatalf("apply: %v", err)
		}
		transport := client.Transport.(*http.Transport)
		if transport.Proxy == nil {
			t.Fatalf("the transport lost its proxy")
		}
		_, err := transport.DialContext(context.Background(), "tcp", "203.0.113.10:80")
		if err == nil || !strings.Contains(err.Error(), "does not connect directly") {
			t.Fatalf("dial error = %v, want a refusal", err)
		}
		if err := policy.apply(&http.Client{Transport: roundTripFunc(nil)}); err == nil {
			t.Fatalf("a transport that cannot be routed was accepted")
		}
	})
}

func TestURLFetchRequiredProxy_SOCKS5(t *testing.T) {
	target := newProxyTarget(t, "127.0.0.1")
	proxy := newFakeSOCKS5Proxy(t, target.addr(), true)
	dials := &dialRecord{}
	tool := requiredTool(t, proxy.url(url.UserPassword("mo rph", "p@ss:w%rd")), dials)
	out, err := tool.Execute(context.Background(), map[string]any{"url": "http://name.test/page"})
	if err != nil {
		t.Fatalf("Execute() error = %v", err)
	}
	if !strings.Contains(out, "target-body /page") {
		t.Fatalf("output = %q", out)
	}
	got := proxy.seen()
	if len(got) != 1 {
		t.Fatalf("the proxy received %v", got)
	}
	want := socksRequest{AddrType: 3, Host: "name.test", Port: 80, Method: 2, User: "mo rph", Pass: "p@ss:w%rd"}
	if got[0] != want {
		t.Fatalf("the proxy received %+v, want %+v", got[0], want)
	}
	dials.assertOnly(t, proxy.addr())
}

func TestURLFetchRequiredProxy_LoopbackIsUnchanged(t *testing.T) {
	target := newProxyTarget(t, "127.0.0.1")
	proxy := newFakeHTTPProxy(t, target.addr())
	dials := &dialRecord{}
	tool := requiredTool(t, proxy.url(nil), dials)
	// allow_proxy false does not matter for a destination no proxy is used for.
	ctx := guard.WithNetworkPolicy(context.Background(), guard.NetworkPolicy{
		AllowedURLPrefixes: []string{"http://" + target.addr() + "/"},
		FollowRedirects:    true,
	})
	out, err := tool.Execute(ctx, map[string]any{"url": "http://" + target.addr() + "/page"})
	if err != nil {
		t.Fatalf("Execute() error = %v", err)
	}
	if !strings.Contains(out, "target-body /page") {
		t.Fatalf("output = %q", out)
	}
	if got := proxy.seen(); len(got) != 0 {
		t.Fatalf("the proxy received %v for a loopback destination", got)
	}

	// With deny_private_ips the loopback destination is refused as before.
	ctx = guard.WithNetworkPolicy(context.Background(), guard.NetworkPolicy{
		AllowedURLPrefixes: []string{"http://" + target.addr() + "/"},
		DenyPrivateIPs:     true,
		AllowProxy:         true,
	})
	if _, err := tool.Execute(ctx, map[string]any{"url": "http://" + target.addr() + "/page"}); err == nil ||
		!strings.Contains(err.Error(), "private_ip") {
		t.Fatalf("error = %v, want private_ip", err)
	}
}

func TestURLFetchRequiredProxy_MarkerFromEnvironment(t *testing.T) {
	target := newProxyTarget(t, "127.0.0.1")
	proxyCalls := 0
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = func(*http.Request) (*url.URL, error) {
		proxyCalls++
		return nil, nil
	}
	policy := guard.NetworkPolicy{
		AllowedURLPrefixes: []string{"http://" + target.addr() + "/", "http://target.test/"},
		DenyPrivateIPs:     false,
		AllowProxy:         false,
	}
	newTool := func() *URLFetchTool {
		tool := NewURLFetchTool(true, 5*time.Second, 4096, "test-agent", t.TempDir())
		tool.HTTPClient = &http.Client{Transport: transport}
		return tool
	}

	t.Run("without the marker nothing changes", func(t *testing.T) {
		for _, value := range []string{"", "0", "true"} {
			t.Setenv(DesktopProxyRequiredEnv, value)
			if requiredProxyRouteFromEnv() != nil {
				t.Fatalf("marker %q was read as set", value)
			}
		}
		t.Setenv(DesktopProxyRequiredEnv, "")
		proxyCalls = 0
		ctx := guard.WithNetworkPolicy(context.Background(), policy)
		out, err := newTool().Execute(ctx, map[string]any{"url": "http://" + target.addr() + "/page"})
		if err != nil || !strings.Contains(out, "target-body /page") {
			t.Fatalf("Execute() = %q, %v", out, err)
		}
		if proxyCalls != 0 {
			t.Fatalf("the proxy was consulted %d times with allow_proxy false", proxyCalls)
		}
		// deny_private_ips keeps its resolved-address check on a direct connection.
		strict := policy
		strict.DenyPrivateIPs = true
		strict.AllowedURLPrefixes = []string{"http://localtest.invalid/"}
		_, err = newTool().Execute(guard.WithNetworkPolicy(context.Background(), strict), map[string]any{"url": "http://localtest.invalid/"})
		if err == nil || strings.Contains(err.Error(), "network proxy") {
			t.Fatalf("error = %v, want the direct route's own failure", err)
		}
	})

	t.Run("with the marker a host name is refused", func(t *testing.T) {
		t.Setenv(DesktopProxyRequiredEnv, "1")
		if requiredProxyRouteFromEnv() == nil {
			t.Fatalf("the marker was not read")
		}
		ctx := guard.WithNetworkPolicy(context.Background(), policy)
		out, err := newTool().Execute(ctx, map[string]any{"url": "http://target.test/page"})
		if err == nil || !strings.Contains(err.Error(), "guard.network.url_fetch.allow_proxy") {
			t.Fatalf("Execute() = %q, %v; want the allow_proxy refusal", out, err)
		}
		if target.hits.Load() != 1 {
			t.Fatalf("target hits = %d, want only the unmarked request", target.hits.Load())
		}
	})
}
