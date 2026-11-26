package builtin

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"

	"github.com/quailyquaily/mistermorph/guard"
)

// DesktopProxyRequiredEnv is set to "1" by the desktop app for the backend it starts while an
// explicit network proxy is running. It is a marker, not a config key: with it, url_fetch sends a
// request to a destination that is not loopback through the proxy of the environment, or refuses
// it. It never connects to such a destination itself, and it relaxes no guard or auth profile
// setting.
const DesktopProxyRequiredEnv = "MISTER_MORPH_DESKTOP_PROXY_REQUIRED"

// requiredProxyRoute is the route url_fetch must take while a proxy is required. The zero value
// follows the process's proxy environment; tests set the fields.
type requiredProxyRoute struct {
	// proxy picks the proxy of a request (http.ProxyFromEnvironment when nil).
	proxy func(*http.Request) (*url.URL, error)
	// dial opens the connections the transport is allowed to make: to the proxy, and to loopback
	// destinations (the transport's own dialer when nil).
	dial func(ctx context.Context, network, address string) (net.Conn, error)
}

func requiredProxyRouteFromEnv() *requiredProxyRoute {
	if strings.TrimSpace(os.Getenv(DesktopProxyRequiredEnv)) != "1" {
		return nil
	}
	return &requiredProxyRoute{}
}

// requiredProxyRefusal is a request refused by policy before anything was sent for it.
type requiredProxyRefusal struct {
	message string
}

func (e *requiredProxyRefusal) Error() string { return e.message }

func refuseRequiredProxy(format string, args ...any) error {
	return &requiredProxyRefusal{message: fmt.Sprintf(format, args...)}
}

// requiredProxyPolicy decides, for the first request and every redirect hop, whether it may go
// through the required proxy. The guard's and the auth profile's settings are read as they are
// without the marker; here they can only refuse.
type requiredProxyPolicy struct {
	route   requiredProxyRoute
	guardOn bool
	guard   guard.NetworkPolicy
	// profileID is the auth profile of the request, empty without one.
	profileID          string
	profileAllowsProxy bool

	mu      sync.Mutex
	proxies map[string]bool
	last    *url.URL
}

// isLoopbackDestination reports the hosts Go never sends to a proxy: `localhost` and loopback
// addresses. For them url_fetch behaves as without the marker.
func isLoopbackDestination(host string) bool {
	host = strings.ToLower(strings.TrimSpace(host))
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// proxyFor is the transport's Proxy function: the proxy of the request, none for a loopback
// destination, or the refusal.
func (p *requiredProxyPolicy) proxyFor(req *http.Request) (*url.URL, error) {
	if req == nil || req.URL == nil {
		return nil, refuseRequiredProxy("the desktop app requires a network proxy: request has no url")
	}
	host := req.URL.Hostname()
	if isLoopbackDestination(host) {
		return nil, nil
	}
	if p.guardOn && !p.guard.AllowProxy {
		return nil, refuseRequiredProxy(
			"the desktop app requires a network proxy, and guard.network.url_fetch.allow_proxy is false: url_fetch may not use a proxy, and does not connect directly",
		)
	}
	if p.profileID != "" && !p.profileAllowsProxy {
		return nil, refuseRequiredProxy(
			"the desktop app requires a network proxy, and auth profile %q has allow_proxy false: url_fetch may not use a proxy with it, and does not connect directly",
			p.profileID,
		)
	}
	if p.guardOn && p.guard.DenyPrivateIPs {
		ip := net.ParseIP(strings.TrimSpace(host))
		if ip == nil {
			return nil, refuseRequiredProxy(
				"the desktop app requires a network proxy, and guard.network.url_fetch.deny_private_ips is true: the proxy would resolve host name %q, so its address cannot be checked",
				host,
			)
		}
		if reason := p.guard.IPDenyReason(ip); reason != "" {
			return nil, refuseRequiredProxy("url is not allowed by guard: %s", reason)
		}
	}
	pick := p.route.proxy
	if pick == nil {
		pick = http.ProxyFromEnvironment
	}
	proxy, err := pick(req)
	if err != nil {
		return nil, refuseRequiredProxy("the desktop app requires a network proxy, and the proxy settings are invalid")
	}
	if proxy == nil || strings.TrimSpace(proxy.Host) == "" {
		return nil, refuseRequiredProxy("the desktop app requires a network proxy, and none is set for %q: url_fetch does not connect directly", host)
	}
	p.mu.Lock()
	if p.proxies == nil {
		p.proxies = map[string]bool{}
	}
	p.proxies[proxyDialAddress(proxy)] = true
	p.last = proxy
	p.mu.Unlock()
	return proxy, nil
}

// check runs the policy for one URL without sending anything.
func (p *requiredProxyPolicy) check(u *url.URL) error {
	_, err := p.proxyFor(&http.Request{URL: u})
	return err
}

// proxyDialAddress is the address the transport dials to reach a proxy.
func proxyDialAddress(proxy *url.URL) string {
	port := proxy.Port()
	if port == "" {
		switch strings.ToLower(proxy.Scheme) {
		case "https":
			port = "443"
		case "socks5", "socks5h":
			port = "1080"
		default:
			port = "80"
		}
	}
	return net.JoinHostPort(strings.ToLower(proxy.Hostname()), port)
}

func normalizeDialAddress(address string) (string, string) {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return "", ""
	}
	host = strings.ToLower(host)
	return host, net.JoinHostPort(host, port)
}

// apply gives the client a transport that takes the required route: its proxy is never removed,
// and its dialer opens connections to the proxy and to loopback destinations only.
func (p *requiredProxyPolicy) apply(client *http.Client) error {
	if client == nil {
		return fmt.Errorf("http client is required")
	}
	var transport *http.Transport
	switch current := client.Transport.(type) {
	case nil:
		transport = cloneDefaultTransport()
	case *http.Transport:
		if current == nil {
			transport = cloneDefaultTransport()
		} else {
			transport = current.Clone()
		}
	default:
		return fmt.Errorf("the desktop app requires a network proxy: url_fetch needs an HTTP transport to use it")
	}
	baseDial := p.route.dial
	if baseDial == nil {
		baseDial = transport.DialContext
	}
	if baseDial == nil {
		baseDial = (&net.Dialer{}).DialContext
	}
	loopbackDial := baseDial
	if p.guardOn && p.guard.DenyPrivateIPs {
		// Unchanged for loopback destinations: the address check of the guard.
		loopbackDial = networkPolicyDialContext(baseDial, net.DefaultResolver.LookupIPAddr, p.guard)
	}
	transport.Proxy = p.proxyFor
	transport.DialTLS = nil
	transport.DialTLSContext = nil
	transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		host, normalized := normalizeDialAddress(address)
		p.mu.Lock()
		toProxy := normalized != "" && p.proxies[normalized]
		p.mu.Unlock()
		if toProxy {
			return baseDial(ctx, network, address)
		}
		if isLoopbackDestination(host) {
			return loopbackDial(ctx, network, address)
		}
		return nil, refuseRequiredProxy("the desktop app requires a network proxy: url_fetch does not connect directly to %q", host)
	}
	client.Transport = transport
	return nil
}

// requestError is the error of a request that was allowed and did not get through. It names the
// proxy by type, host and port, and never by its URL, which may hold a password.
func (p *requiredProxyPolicy) requestError(err error) error {
	if err == nil {
		return nil
	}
	var refusal *requiredProxyRefusal
	if errors.As(err, &refusal) {
		return refusal
	}
	p.mu.Lock()
	proxy := p.last
	p.mu.Unlock()
	if proxy == nil {
		// A loopback destination: nothing went to the proxy.
		return err
	}
	return fmt.Errorf(
		"request through the required network proxy (%s %s) failed: %s",
		proxyTypeName(proxy), proxyDialAddress(proxy), scrubProxyCredentials(err.Error(), proxy),
	)
}

func proxyTypeName(proxy *url.URL) string {
	switch strings.ToLower(proxy.Scheme) {
	case "socks5", "socks5h":
		return "SOCKS5"
	case "https":
		return "HTTPS"
	default:
		return "HTTP"
	}
}

// scrubProxyCredentials removes the proxy's user info from a message, in the forms a URL or an
// error can carry it.
func scrubProxyCredentials(message string, proxy *url.URL) string {
	if proxy == nil || proxy.User == nil {
		return message
	}
	const mask = "[redacted]"
	if encoded := proxy.User.String(); encoded != "" {
		message = strings.ReplaceAll(message, encoded+"@", mask+"@")
	}
	password, _ := proxy.User.Password()
	for _, secret := range []string{password, url.QueryEscape(password), url.PathEscape(password)} {
		if secret != "" {
			message = strings.ReplaceAll(message, secret, mask)
		}
	}
	return message
}
