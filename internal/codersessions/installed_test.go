package codersessions

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/internal/coderusage"
	"github.com/quailyquaily/mistermorph/internal/shellenv"
)

// Opt in: this checks the installed binary's schema without sending a model request.
func TestInstalledCodexSchema(t *testing.T) {
	if os.Getenv("MISTER_MORPH_CODEX_SCHEMA_TEST") != "1" {
		t.Skip("set MISTER_MORPH_CODEX_SCHEMA_TEST=1")
	}
	command, env, err := (shellenv.CoderEnv{}).Command("codex")
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, command, "app-server", "generate-json-schema", "--out", dir)
	cmd.Env = env
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("schema: %v: %s", err, out)
	}
	for file, methods := range map[string][]string{
		"ClientRequest.json":      {"initialize", "thread/start", "thread/resume", "turn/start", "turn/interrupt", "account/rateLimits/read"},
		"ServerRequest.json":      {"item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval", "item/tool/requestUserInput"},
		"ServerNotification.json": {"turn/completed", "item/agentMessage/delta", "thread/tokenUsage/updated"},
	} {
		data, err := os.ReadFile(filepath.Join(dir, file))
		if err != nil {
			t.Fatal(err)
		}
		for _, method := range methods {
			quoted, _ := json.Marshal(method)
			if !strings.Contains(string(data), string(quoted)) {
				t.Errorf("%s lacks %s", file, method)
			}
		}
	}
	for file, fields := range map[string][]string{"ThreadStartParams.json": {"approvalPolicy", "sandbox", "cwd"}, "ThreadTokenUsageUpdatedNotification.json": {"threadId", "tokenUsage", "last", "total", "inputTokens", "cachedInputTokens", "outputTokens"}} {
		data, err := os.ReadFile(filepath.Join(dir, "v2", file))
		if err != nil {
			t.Fatal(err)
		}
		for _, field := range fields {
			if !strings.Contains(string(data), `"`+field+`"`) {
				t.Errorf("%s lacks %s", file, field)
			}
		}
	}
}

// Opt in per backend: sends one minimal task through the same bypassed run-scoped path.
func TestInstalledCoderSession(t *testing.T) {
	backend := os.Getenv("MISTER_MORPH_CODER_SESSION_TEST")
	if backend == "" {
		t.Skip("set MISTER_MORPH_CODER_SESSION_TEST to codex or agy")
	}
	if backend != "codex" && backend != "agy" {
		t.Fatal("only codex and agy use protocol sessions")
	}
	command, env, err := (shellenv.CoderEnv{}).Command(backend)
	if err != nil {
		t.Fatal(err)
	}
	req := Request{Backend: backend, Command: command, Env: env, CWD: t.TempDir(), Task: "Reply with exactly OK. Do not use tools or change files.", BypassApprovals: true}
	var run coderusage.Run
	req.Report = func(r coderusage.Run, _ *coderusage.Quota) { run = r }
	var sessions Sessions
	defer sessions.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	out, err := sessions.Run(ctx, "run", req)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "OK") {
		t.Fatalf("unexpected answer %q", out)
	}
	if len(run.Models) == 0 || run.Models[0].InputTokens <= 0 {
		t.Fatalf("no usage: %+v", run)
	}
	t.Logf("backend=%s model=%s input=%d output=%d", backend, run.Models[0].Model, run.Models[0].InputTokens, run.Models[0].OutputTokens)
	sessions.Reset("run")
}
