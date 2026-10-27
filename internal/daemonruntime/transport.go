package daemonruntime

import (
	"context"
	"net"
	"net/http"
	"strings"
)

// A Console proxies the browser's requests to its runtime, so the runtime sees the proxy's address,
// not the browser's. The proxy passes the browser's address on: on the context when the runtime is
// in the same process, in this header when it is reached over the network. Every route that reads
// it requires the runtime's bearer token, which only the Console and chat hold.
//
// Whether that connection is encrypted is not judged here: behind a TLS proxy or a VPN the runtime
// cannot tell. The client, which knows how it reached its server, warns instead.
const RemoteHeader = "X-MisterMorph-Client-Remote"

type clientRemoteKey struct{}

// WithClientRemote records on ctx the address of the client a proxy relays.
func WithClientRemote(ctx context.Context, remote string) context.Context {
	return context.WithValue(ctx, clientRemoteKey{}, remote)
}

// ClientRemoteFromContext is what WithClientRemote recorded.
func ClientRemoteFromContext(ctx context.Context) (string, bool) {
	remote, ok := ctx.Value(clientRemoteKey{}).(string)
	return remote, ok
}

// RequestRemote is the address of the client behind r, for the audit log: as a relaying Console
// passed it on, else as DirectRemote sees it.
func RequestRemote(r *http.Request) string {
	if remote, ok := ClientRemoteFromContext(r.Context()); ok {
		return remote
	}
	if relayed := strings.TrimSpace(r.Header.Get(RemoteHeader)); relayed != "" {
		return relayed
	}
	return DirectRemote(r)
}

// DirectRemote is the address of r's own peer, or the first X-Forwarded-For entry when that peer is
// a proxy on this machine.
func DirectRemote(r *http.Request) string {
	remote := strings.TrimSpace(r.RemoteAddr)
	if isLoopbackAddr(remote) {
		if forwarded := strings.TrimSpace(r.Header.Get("X-Forwarded-For")); forwarded != "" {
			first, _, _ := strings.Cut(forwarded, ",")
			return strings.TrimSpace(first)
		}
	}
	return remote
}

func isLoopbackAddr(addr string) bool {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		host = addr
	}
	ip := net.ParseIP(strings.Trim(host, "[]"))
	return ip != nil && ip.IsLoopback()
}
