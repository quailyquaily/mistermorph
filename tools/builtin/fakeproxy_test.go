package builtin

import (
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"sync"
	"testing"
)

// fakeHTTPProxy is an HTTP proxy on loopback that records what it is asked for. Requests go to
// `target` (whatever host they name) when it is set, and are answered 502 otherwise.
type fakeHTTPProxy struct {
	listener net.Listener
	target   string

	mu       sync.Mutex
	requests []string
	auth     []string
}

func newFakeHTTPProxy(t *testing.T, target string) *fakeHTTPProxy {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	proxy := &fakeHTTPProxy{listener: listener, target: target}
	server := &http.Server{Handler: http.HandlerFunc(proxy.serve)}
	go func() { _ = server.Serve(listener) }()
	t.Cleanup(func() { _ = server.Close() })
	return proxy
}

func (p *fakeHTTPProxy) addr() string { return p.listener.Addr().String() }

func (p *fakeHTTPProxy) url(user *url.Userinfo) *url.URL {
	return &url.URL{Scheme: "http", Host: p.addr(), User: user}
}

func (p *fakeHTTPProxy) seen() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]string{}, p.requests...)
}

// credentials are the decoded `Proxy-Authorization: Basic` pairs, one per request that had one.
func (p *fakeHTTPProxy) credentials() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]string{}, p.auth...)
}

func (p *fakeHTTPProxy) serve(w http.ResponseWriter, r *http.Request) {
	p.mu.Lock()
	p.requests = append(p.requests, r.Method+" "+r.RequestURI)
	if header := r.Header.Get("Proxy-Authorization"); strings.HasPrefix(header, "Basic ") {
		if raw, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(header, "Basic ")); err == nil {
			p.auth = append(p.auth, string(raw))
		}
	}
	p.mu.Unlock()
	if p.target == "" {
		http.Error(w, "proxy refuses", http.StatusBadGateway)
		return
	}
	if r.Method == http.MethodConnect {
		upstream, err := net.Dial("tcp", p.target)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		hijacker, ok := w.(http.Hijacker)
		if !ok {
			_ = upstream.Close()
			http.Error(w, "no hijack", http.StatusInternalServerError)
			return
		}
		conn, _, err := hijacker.Hijack()
		if err != nil {
			_ = upstream.Close()
			return
		}
		_, _ = io.WriteString(conn, "HTTP/1.1 200 Connection established\r\n\r\n")
		go pipeBoth(conn, upstream)
		return
	}
	forward := &httputil.ReverseProxy{
		Director: func(out *http.Request) {
			out.URL.Scheme = "http"
			out.URL.Host = p.target
			out.Header.Set("X-Via-Fake-Proxy", "1")
			out.Header.Del("Proxy-Authorization")
		},
		FlushInterval: -1,
	}
	forward.ServeHTTP(w, r)
}

func pipeBoth(a, b net.Conn) {
	done := make(chan struct{}, 2)
	go func() { _, _ = io.Copy(a, b); done <- struct{}{} }()
	go func() { _, _ = io.Copy(b, a); done <- struct{}{} }()
	<-done
	_ = a.Close()
	_ = b.Close()
}

// socksRequest is one CONNECT a fake SOCKS5 proxy was asked for.
type socksRequest struct {
	// AddrType is the ATYP byte: 1 an IPv4 address, 3 a domain name, 4 an IPv6 address.
	AddrType byte
	Host     string
	Port     uint16
	// Method is the authentication method chosen: 0 none, 2 user name and password.
	Method byte
	User   string
	Pass   string
}

// fakeSOCKS5Proxy is a SOCKS5 proxy on loopback that records what it is asked for. Connections go
// to `target` when it is set, and are refused (reply 5) otherwise.
type fakeSOCKS5Proxy struct {
	listener net.Listener
	target   string
	needAuth bool

	mu       sync.Mutex
	requests []socksRequest
}

func newFakeSOCKS5Proxy(t *testing.T, target string, needAuth bool) *fakeSOCKS5Proxy {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	proxy := &fakeSOCKS5Proxy{listener: listener, target: target, needAuth: needAuth}
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go proxy.serve(conn)
		}
	}()
	t.Cleanup(func() { _ = listener.Close() })
	return proxy
}

func (p *fakeSOCKS5Proxy) addr() string { return p.listener.Addr().String() }

func (p *fakeSOCKS5Proxy) url(user *url.Userinfo) *url.URL {
	return &url.URL{Scheme: "socks5", Host: p.addr(), User: user}
}

func (p *fakeSOCKS5Proxy) seen() []socksRequest {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]socksRequest{}, p.requests...)
}

func (p *fakeSOCKS5Proxy) serve(conn net.Conn) {
	defer conn.Close()
	request, err := p.handshake(conn)
	if err != nil {
		return
	}
	p.mu.Lock()
	p.requests = append(p.requests, request)
	p.mu.Unlock()
	if p.target == "" {
		_, _ = conn.Write([]byte{5, 5, 0, 1, 0, 0, 0, 0, 0, 0})
		return
	}
	upstream, err := net.Dial("tcp", p.target)
	if err != nil {
		_, _ = conn.Write([]byte{5, 1, 0, 1, 0, 0, 0, 0, 0, 0})
		return
	}
	_, _ = conn.Write([]byte{5, 0, 0, 1, 0, 0, 0, 0, 0, 0})
	pipeBoth(conn, upstream)
}

func (p *fakeSOCKS5Proxy) handshake(conn net.Conn) (socksRequest, error) {
	var request socksRequest
	head := make([]byte, 2)
	if _, err := io.ReadFull(conn, head); err != nil || head[0] != 5 {
		return request, fmt.Errorf("bad greeting")
	}
	methods := make([]byte, head[1])
	if _, err := io.ReadFull(conn, methods); err != nil {
		return request, err
	}
	want := byte(0)
	if p.needAuth {
		want = 2
	}
	if !strings.Contains(string(methods), string([]byte{want})) {
		_, _ = conn.Write([]byte{5, 0xff})
		return request, fmt.Errorf("method %d not offered", want)
	}
	if _, err := conn.Write([]byte{5, want}); err != nil {
		return request, err
	}
	request.Method = want
	if want == 2 {
		if _, err := io.ReadFull(conn, head); err != nil || head[0] != 1 {
			return request, fmt.Errorf("bad auth")
		}
		user := make([]byte, head[1])
		if _, err := io.ReadFull(conn, user); err != nil {
			return request, err
		}
		size := make([]byte, 1)
		if _, err := io.ReadFull(conn, size); err != nil {
			return request, err
		}
		pass := make([]byte, size[0])
		if _, err := io.ReadFull(conn, pass); err != nil {
			return request, err
		}
		request.User, request.Pass = string(user), string(pass)
		if _, err := conn.Write([]byte{1, 0}); err != nil {
			return request, err
		}
	}
	command := make([]byte, 4)
	if _, err := io.ReadFull(conn, command); err != nil || command[0] != 5 || command[1] != 1 {
		return request, fmt.Errorf("bad request")
	}
	request.AddrType = command[3]
	switch command[3] {
	case 1, 4:
		size := 4
		if command[3] == 4 {
			size = 16
		}
		raw := make([]byte, size)
		if _, err := io.ReadFull(conn, raw); err != nil {
			return request, err
		}
		request.Host = net.IP(raw).String()
	case 3:
		size := make([]byte, 1)
		if _, err := io.ReadFull(conn, size); err != nil {
			return request, err
		}
		name := make([]byte, size[0])
		if _, err := io.ReadFull(conn, name); err != nil {
			return request, err
		}
		request.Host = string(name)
	default:
		return request, fmt.Errorf("bad address type")
	}
	port := make([]byte, 2)
	if _, err := io.ReadFull(conn, port); err != nil {
		return request, err
	}
	request.Port = binary.BigEndian.Uint16(port)
	return request, nil
}

// closedPort is a loopback address nothing listens on.
func closedPort(t *testing.T) string {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	addr := listener.Addr().String()
	_ = listener.Close()
	return addr
}

// nonLoopbackIPv4 is an address of this machine that is not loopback: a target listening on it
// answers a direct connection, which a required proxy must never make.
func nonLoopbackIPv4(t *testing.T) string {
	t.Helper()
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		t.Skipf("no interface addresses: %v", err)
	}
	for _, addr := range addrs {
		ipnet, ok := addr.(*net.IPNet)
		if !ok || ipnet.IP.IsLoopback() || ipnet.IP.To4() == nil || ipnet.IP.IsLinkLocalUnicast() {
			continue
		}
		listener, err := net.Listen("tcp", net.JoinHostPort(ipnet.IP.String(), "0"))
		if err != nil {
			continue
		}
		_ = listener.Close()
		return ipnet.IP.String()
	}
	t.Skip("this machine has no non-loopback IPv4 address to listen on")
	return ""
}
