package daemonruntime

import (
	"context"
	"net/http/httptest"
	"testing"
)

func TestRequestRemote(t *testing.T) {
	cases := []struct {
		name      string
		remote    string
		headers   map[string]string
		ctxRemote string
		want      string
	}{
		{name: "direct from the network", remote: "192.168.1.20:5000", want: "192.168.1.20:5000"},
		{name: "loopback", remote: "127.0.0.1:5000", want: "127.0.0.1:5000"},
		{
			name: "local proxy", remote: "127.0.0.1:5000",
			headers: map[string]string{"X-Forwarded-For": "203.0.113.9, 10.0.0.1"},
			want:    "203.0.113.9",
		},
		{
			name: "forwarded header from the network is ignored", remote: "192.168.1.20:5000",
			headers: map[string]string{"X-Forwarded-For": "203.0.113.9"},
			want:    "192.168.1.20:5000",
		},
		{
			name: "relayed by a Console over the network", remote: "10.0.0.5:7000",
			headers: map[string]string{RemoteHeader: "203.0.113.9:1234"},
			want:    "203.0.113.9:1234",
		},
		{name: "relayed in process", remote: "", ctxRemote: "203.0.113.9:1234", want: "203.0.113.9:1234"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest("POST", "/tasks/t/elevation", nil)
			r.RemoteAddr = tc.remote
			for key, value := range tc.headers {
				r.Header.Set(key, value)
			}
			if tc.ctxRemote != "" {
				r = r.WithContext(WithClientRemote(context.Background(), tc.ctxRemote))
			}
			if got := RequestRemote(r); got != tc.want {
				t.Fatalf("RequestRemote = %q, want %q", got, tc.want)
			}
		})
	}
}
