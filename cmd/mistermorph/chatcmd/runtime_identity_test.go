package chatcmd

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
	"github.com/quailyquaily/mistermorph/internal/elevate/seal"
)

func TestCheckRuntimeIdentityAtConnect(t *testing.T) {
	identity := testRuntimeIdentity(t, 1)
	other := testRuntimeIdentity(t, 2)
	cases := []struct {
		name       string
		base       string // the runtime's address as chat names it; the test server answers it
		pinned     string
		noIdentity bool
		input      string
		wantPinned string
		wantOut    []string
		notOut     []string
	}{
		{name: "loopback pins silently", base: "http://127.0.0.1:9080/runtime", wantPinned: identity},
		{
			name: "remote asks, yes pins", base: "https://console.example/runtime", input: "y\n", wantPinned: identity,
			wantOut: []string{seal.Fingerprint(mustDecode(t, identity)), "[y/N]", "Trusted"},
		},
		{
			name: "remote asks, no leaves it unpinned", base: "https://console.example/runtime", input: "\n",
			wantOut: []string{"[y/N]", "Not trusted"},
		},
		{name: "already pinned says nothing", base: "https://console.example/runtime", pinned: identity, wantPinned: identity, notOut: []string{"[y/N]", "WARNING"}},
		{
			name: "changed key warns and keeps the pin", base: "https://console.example/runtime", pinned: other, wantPinned: other,
			wantOut: []string{"WARNING", "--forget-runtime https://console.example/runtime"}, notOut: []string{"[y/N]"},
		},
		{name: "runtime without an identity", base: "https://console.example/runtime", noIdentity: true, notOut: []string{"[y/N]", "Cannot"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/runtime/elevation/identity" || tc.noIdentity {
					http.NotFound(w, r)
					return
				}
				_ = json.NewEncoder(w).Encode(daemonruntime.ElevationIdentity{Identity: identity, Fingerprint: "not used"})
			}))
			defer srv.Close()
			c, err := newRemoteClient(srv.URL+"/runtime", "secret")
			if err != nil {
				t.Fatal(err)
			}
			// Talk to the test server, but under the address the case names.
			target := c.base
			c.base = tc.base
			c.http.Transport = rewriteTransport{from: tc.base, to: target}
			path := filepath.Join(t.TempDir(), knownRuntimesFile)
			if tc.pinned != "" {
				if err := pinKnownRuntime(path, tc.base, tc.pinned); err != nil {
					t.Fatal(err)
				}
			}
			var out bytes.Buffer
			checkRuntimeIdentity(context.Background(), c, path, strings.NewReader(tc.input), &out)
			known, err := loadKnownRuntimes(path)
			if err != nil {
				t.Fatal(err)
			}
			if got := known[tc.base]; got != tc.wantPinned {
				t.Errorf("pinned %q, want %q", got, tc.wantPinned)
			}
			for _, want := range tc.wantOut {
				if !strings.Contains(out.String(), want) {
					t.Errorf("output lacks %q:\n%s", want, out.String())
				}
			}
			for _, unwanted := range tc.notOut {
				if strings.Contains(out.String(), unwanted) {
					t.Errorf("output has %q:\n%s", unwanted, out.String())
				}
			}
		})
	}
}

func TestReadAnswerLineLeavesTheRest(t *testing.T) {
	in := strings.NewReader("yes\nnext input")
	if got, err := readAnswerLine(in); err != nil || got != "yes" {
		t.Fatalf("readAnswerLine = %q, %v", got, err)
	}
	rest := new(bytes.Buffer)
	_, _ = rest.ReadFrom(in)
	if rest.String() != "next input" {
		t.Fatalf("left %q", rest.String())
	}
}

type rewriteTransport struct{ from, to string }

func (t rewriteTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	u := strings.Replace(r.URL.String(), t.from, t.to, 1)
	req := r.Clone(r.Context())
	parsed, err := req.URL.Parse(u)
	if err != nil {
		return nil, err
	}
	req.URL, req.Host = parsed, parsed.Host
	return http.DefaultTransport.RoundTrip(req)
}

func testRuntimeIdentity(t *testing.T, fill byte) string {
	t.Helper()
	identity, err := seal.NewIdentity(bytes.Repeat([]byte{fill}, 32))
	if err != nil {
		t.Fatal(err)
	}
	return seal.EncodePublicKey(identity.PublicKey())
}

func mustDecode(t *testing.T, identity string) []byte {
	t.Helper()
	key, err := seal.DecodePublicKey(identity)
	if err != nil {
		t.Fatal(err)
	}
	return key
}
