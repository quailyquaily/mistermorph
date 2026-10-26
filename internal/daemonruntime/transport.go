package daemonruntime

import (
	"context"
	"net"
	"net/http"
	"strings"
)

// A Console proxies the browser's requests to its runtime, so the runtime sees the proxy's hop, not
// the browser's. The proxy passes how the browser's own connection was made: on the context when the
// runtime is in the same process, in these headers when it is reached over the network. Every route
// that reads them requires the runtime's bearer token, which only the Console and chat hold.
const (
	TransportHeader = "X-MisterMorph-Client-Transport"
	RemoteHeader    = "X-MisterMorph-Client-Remote"
)

const (
	TransportSecure   = "secure"
	TransportInsecure = "insecure"
)

type clientTransportKey struct{}

type clientTransport struct {
	transport string
	remote    string
}

// WithClientTransport records on ctx how the client a proxy relays reached it.
func WithClientTransport(ctx context.Context, transport, remote string) context.Context {
	return context.WithValue(ctx, clientTransportKey{}, clientTransport{transport: transport, remote: remote})
}

// ClientTransportFromContext is what WithClientTransport recorded.
func ClientTransportFromContext(ctx context.Context) (transport, remote string, ok bool) {
	relayed, ok := ctx.Value(clientTransportKey{}).(clientTransport)
	return relayed.transport, relayed.remote, ok
}

// RequestTransport reports how the client behind r reached us: TransportSecure over TLS or from
// this machine, otherwise TransportInsecure, and its address. A relayed request reports what its
// proxy passed on.
func RequestTransport(r *http.Request) (transport string, remote string) {
	if transport, remote, ok := ClientTransportFromContext(r.Context()); ok {
		return transport, remote
	}
	if relayed := strings.TrimSpace(r.Header.Get(TransportHeader)); relayed == TransportSecure || relayed == TransportInsecure {
		return relayed, strings.TrimSpace(r.Header.Get(RemoteHeader))
	}
	return DirectTransport(r)
}

// DirectTransport is how r's own connection was made: secure over TLS, from this machine, or through
// a TLS-terminating proxy on this machine (X-Forwarded-Proto: https from a loopback peer).
func DirectTransport(r *http.Request) (transport string, remote string) {
	remote = strings.TrimSpace(r.RemoteAddr)
	if r.TLS != nil {
		return TransportSecure, remote
	}
	if isLoopbackAddr(remote) {
		if forwarded := strings.TrimSpace(r.Header.Get("X-Forwarded-For")); forwarded != "" {
			// A proxy on this machine: secure only if the browser's hop was HTTPS.
			first, _, _ := strings.Cut(forwarded, ",")
			if strings.EqualFold(strings.TrimSpace(r.Header.Get("X-Forwarded-Proto")), "https") {
				return TransportSecure, strings.TrimSpace(first)
			}
			return TransportInsecure, strings.TrimSpace(first)
		}
		return TransportSecure, remote
	}
	return TransportInsecure, remote
}

func isLoopbackAddr(addr string) bool {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		host = addr
	}
	ip := net.ParseIP(strings.Trim(host, "[]"))
	return ip != nil && ip.IsLoopback()
}
