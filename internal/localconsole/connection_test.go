package localconsole

import (
	"context"
	"testing"
)

func TestDiscoveryRejectsNonLoopbackEndpoints(t *testing.T) {
	for _, target := range []string{"http://example.com/runtime", "https://127.0.0.1/runtime", "http://user:pass@127.0.0.1/runtime", "http://localhost/runtime"} {
		if err := (Connection{URL: target, Token: "secret"}).Probe(context.Background()); err == nil {
			t.Fatalf("accepted unsafe discovery URL %q", target)
		}
	}
}
