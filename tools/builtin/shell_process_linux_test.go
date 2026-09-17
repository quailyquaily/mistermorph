//go:build linux

package builtin

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestShellCommandStartsSeparateSession(t *testing.T) {
	payload, _, err := runShellCommand(context.Background(), shellToolCommon{
		ToolName: "bash", MaxOutputBytes: 4096,
	}, shellRunnerSpec{Program: "bash", ArgsPrefix: []string{"-c"}}, shellInvocation{
		Command: `printf '%s ' "$$"; ps -o sid= -p "$$"`, Timeout: 5 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	ids := strings.Fields(payload.Stdout)
	if len(ids) != 2 {
		t.Fatalf("process and session IDs = %q", payload.Stdout)
	}
	pid, err := strconv.Atoi(ids[0])
	if err != nil || pid <= 0 || ids[0] != ids[1] {
		t.Fatalf("shell inherited the caller's session: pid=%s sid=%s", ids[0], ids[1])
	}
}

func TestShellCommandCancellationStopsPipelineChildren(t *testing.T) {
	for _, cancelTask := range []bool{false, true} {
		name := "timeout"
		if cancelTask {
			name = "task cancellation"
		}
		t.Run(name, func(t *testing.T) {
			marker := filepath.Join(t.TempDir(), "surviving-child")
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			ready := make(chan struct{}, 1)
			if cancelTask {
				go func() {
					select {
					case <-ready:
						cancel()
					case <-ctx.Done():
					}
				}()
			}
			_, _, err := runShellCommand(ctx, shellToolCommon{
				ToolName: "bash", MaxOutputBytes: 4096,
			}, shellRunnerSpec{
				Program: "bash", ArgsPrefix: []string{"-c"}, StreamOutput: true,
				EmitChunk: func(_ context.Context, _, text string) {
					if strings.Contains(text, "ready") {
						select {
						case ready <- struct{}{}:
						default:
						}
					}
				},
			}, shellInvocation{
				Command: `(printf 'ready\n'; sleep 0.5; printf survived > ` + shellQuote(marker) + `) | cat`,
				Timeout: 200 * time.Millisecond,
			})
			if err == nil {
				t.Fatal("expected canceled command to fail")
			}
			time.Sleep(700 * time.Millisecond)
			if _, err := os.Stat(marker); !os.IsNotExist(err) {
				t.Fatalf("pipeline child survived cancellation: stat error=%v", err)
			}
		})
	}
}
