package agent

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/quailyquaily/mistermorph/internal/shellenv"
)

// fakeShellTool stands in for the registered bash tool: it says which variables it injects.
type fakeShellTool struct {
	name     string
	injected []shellenv.InjectedEnvVar
}

func (t *fakeShellTool) Name() string            { return t.name }
func (t *fakeShellTool) Description() string     { return "shell" }
func (t *fakeShellTool) ParameterSchema() string { return "{}" }
func (t *fakeShellTool) Execute(context.Context, map[string]any) (string, error) {
	return "", nil
}
func (t *fakeShellTool) ShellInjectedEnvVars() []shellenv.InjectedEnvVar {
	return shellenv.CloneInjectedEnvVars(t.injected)
}

func TestCoderSessionRequestGetsTheCoderEnvironment(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake shell executable uses /bin/sh")
	}
	root := t.TempDir()
	coderDir := filepath.Join(root, "coder")
	defaultDir := filepath.Join(root, "default")
	for _, dir := range []string{coderDir, defaultDir} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	writeFakeCoderExecutable(t, coderDir, "claude", "exit 0\n")
	writeFakeCoderExecutable(t, defaultDir, "codex", "exit 0\n")
	t.Setenv("PATH", "/usr/bin:/bin")
	t.Setenv("SERVICE_SECRET", "do-not-leak")
	t.Setenv("CLAUDE_CONFIG_DIR", filepath.Join(root, "claude-config"))

	injected := func() []shellenv.InjectedEnvVar {
		return shellenv.InjectedEnvVarsFromConfig([]any{"CLAUDE_CONFIG_DIR"})
	}
	var got CoderRequest
	newTool := func(env shellenv.CoderEnv) *coderTool {
		env.Injected = injected
		env.DefaultDirs = func() []string { return []string{defaultDir} }
		return newCoderTool(coderToolDeps{
			Runner: &execDirectSubtaskRunner{},
			Env:    env,
			RunSessions: func(_ context.Context, req CoderRequest) (string, error) {
				got = req
				return "ok", nil
			},
		})
	}

	withExtra := shellenv.CoderEnv{PathExtra: []string{coderDir}, ShellPathExtra: []string{"/bash/extra"}}
	if _, err := newTool(withExtra).Execute(context.Background(), map[string]any{"coder": "claude", "task": "t", "cwd": root}); err != nil {
		t.Fatal(err)
	}
	if got.Command != filepath.Join(coderDir, "claude") {
		t.Fatalf("command = %q", got.Command)
	}
	want := shellenv.BashEnv(injected(), []string{"/bash/extra"})
	want[0] = "PATH=" + coderDir + ":/bash/extra:/usr/bin:/bin"
	if strings.Join(got.Env, "\n") != strings.Join(want, "\n") {
		t.Fatalf("session env = %v\nwant %v", got.Env, want)
	}
	joined := "\n" + strings.Join(got.Env, "\n") + "\n"
	if strings.Contains(joined, "do-not-leak") || !strings.Contains(joined, "\nCLAUDE_CONFIG_DIR="+filepath.Join(root, "claude-config")+"\n") {
		t.Fatalf("session env:\n%s", joined)
	}
	// tools.coder.path_extra is set: the default install location is not searched.
	got = CoderRequest{}
	raw, err := newTool(withExtra).Execute(context.Background(), map[string]any{"coder": "codex", "task": "t", "cwd": root})
	if got.Command != "" || !strings.Contains(raw+fmt.Sprint(err), "codex executable not found in PATH") {
		t.Fatalf("result = %s, %v (command %q), want codex not found", raw, err, got.Command)
	}
	// It is empty: the CLI is found there.
	got = CoderRequest{}
	if _, err := newTool(shellenv.CoderEnv{}).Execute(context.Background(), map[string]any{"coder": "codex", "task": "t", "cwd": root}); err != nil {
		t.Fatal(err)
	}
	if got.Command != filepath.Join(defaultDir, "codex") || got.Env[0] != "PATH=/usr/bin:/bin:"+defaultDir {
		t.Fatalf("command = %q, %s", got.Command, got.Env[0])
	}
}

// A CLI that is nowhere fails the run; nothing falls back to the runtime's own environment.
