package daemonruntime

import (
	"context"
	"crypto/tls"
	"net/http/httptest"
	"testing"
)

func TestRequestTransport(t *testing.T) {
	cases := []struct {
		name          string
		remote        string
		tls           bool
		headers       map[string]string
		ctxTransport  string
		wantTransport string
		wantRemote    string
	}{
		{name: "plain HTTP from the network", remote: "192.168.1.20:5000", wantTransport: "insecure", wantRemote: "192.168.1.20:5000"},
		{name: "TLS from the network", remote: "192.168.1.20:5000", tls: true, wantTransport: "secure", wantRemote: "192.168.1.20:5000"},
		{name: "loopback", remote: "127.0.0.1:5000", wantTransport: "secure", wantRemote: "127.0.0.1:5000"},
		{name: "IPv6 loopback", remote: "[::1]:5000", wantTransport: "secure", wantRemote: "[::1]:5000"},
		{
			name: "local TLS proxy", remote: "127.0.0.1:5000",
			headers:       map[string]string{"X-Forwarded-For": "203.0.113.9", "X-Forwarded-Proto": "https"},
			wantTransport: "secure", wantRemote: "203.0.113.9",
		},
		{
			name: "local plain proxy", remote: "127.0.0.1:5000",
			headers:       map[string]string{"X-Forwarded-For": "203.0.113.9, 10.0.0.1"},
			wantTransport: "insecure", wantRemote: "203.0.113.9",
		},
		{
			name: "relayed by a Console over the network", remote: "10.0.0.5:7000",
			headers:       map[string]string{TransportHeader: "insecure", RemoteHeader: "203.0.113.9:1234"},
			wantTransport: "insecure", wantRemote: "203.0.113.9:1234",
		},
		{name: "relayed in process", remote: "", ctxTransport: "insecure", wantTransport: "insecure", wantRemote: "203.0.113.9:1234"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest("POST", "/tasks/t/elevation", nil)
			r.RemoteAddr = tc.remote
			if tc.tls {
				r.TLS = &tls.ConnectionState{}
			}
			for key, value := range tc.headers {
				r.Header.Set(key, value)
			}
			if tc.ctxTransport != "" {
				r = r.WithContext(WithClientTransport(context.Background(), tc.ctxTransport, "203.0.113.9:1234"))
			}
			transport, remote := RequestTransport(r)
			if transport != tc.wantTransport || remote != tc.wantRemote {
				t.Fatalf("RequestTransport = %q, %q, want %q, %q", transport, remote, tc.wantTransport, tc.wantRemote)
			}
		})
	}
}
