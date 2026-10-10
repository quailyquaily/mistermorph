package daemonruntime

import (
	"context"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/internal/agentlink"
	"github.com/quailyquaily/mistermorph/internal/runtimepaths"
)

func TestAgentLinkRoute(t *testing.T) {
	stateDir := t.TempDir()
	handler := NewHandler(RoutesOptions{
		Mode:         "test",
		AuthToken:    "token",
		AgentName:    "Tester",
		RuntimePaths: runtimepaths.Paths{StateDir: stateDir},
	})
	server := httptest.NewServer(handler)
	defer server.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, err := agentlink.Dial(ctx, server.URL, "wrong"); err == nil {
		t.Fatal("Dial() with a wrong token succeeded")
	}
	conn, err := agentlink.Dial(ctx, server.URL, "token")
	if err != nil {
		t.Fatalf("Dial() error = %v", err)
	}
	defer conn.Close()
	hello, err := conn.ReadFrame(ctx)
	if err != nil {
		t.Fatalf("ReadFrame() error = %v", err)
	}
	want, err := agentlink.LoadOrCreateInstanceID(stateDir)
	if err != nil {
		t.Fatal(err)
	}
	if hello.Type != agentlink.FrameHello || hello.InstanceID != want || hello.AgentName != "Tester" {
		t.Fatalf("hello = %+v, want instance %s named Tester", hello, want)
	}
}
