package agent

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"testing"

	"github.com/quailyquaily/mistermorph/internal/shellenv"
	"github.com/quailyquaily/mistermorph/tools"
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

// childEnv reads what `env` wrote, without what the shell itself adds.
func childEnv(t *testing.T, path string) []string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		key, _, _ := strings.Cut(line, "=")
		switch key {
		case "PWD", "OLDPWD", "SHLVL", "_":
			continue
		}
		out = append(out, line)
	}
	sort.Strings(out)
	return out
}

func sortedEnv(env []string) []string {
	out := append([]string(nil), env...)
	sort.Strings(out)
	return out
}

// A headless coder run gets the environment the bash tool gives a command, and nothing else of
// the runtime's: a secret does not reach the CLI; an injected variable and a tools.bash.path_extra
// directory do. The CLI is found in a default install location, which comes last in PATH.
func TestCoderRunGetsTheBashToolsEnvironment(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake shell executable uses /bin/sh")
	}
	root := t.TempDir()
	defaultDir := filepath.Join(root, "home", ".local", "bin")
	bashDir := filepath.Join(root, "bash")
	for _, dir := range []string{defaultDir, bashDir} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	envFile := filepath.Join(root, "env")
	helperFile := filepath.Join(root, "helper")
	writeFakeCoderExecutable(t, bashDir, "mm-bash-helper", "printf helper-ok\n")
	writeFakeCoderExecutable(t, defaultDir, "codex", "cat >/dev/null\nenv > '"+envFile+"'\nmm-bash-helper > '"+helperFile+"'\n")

	t.Setenv("PATH", "/usr/bin:/bin")
	t.Setenv("HOME", filepath.Join(root, "home"))
	t.Setenv("TERM", "dumb")
	t.Setenv("SERVICE_SECRET", "do-not-leak")
	t.Setenv("HTTPS_PROXY", "http://proxy.invalid")
	t.Setenv("ANTHROPIC_API_KEY", "do-not-leak-either")
	t.Setenv("CODEX_HOME", filepath.Join(root, "codex-home"))

	bash := &fakeShellTool{name: shellenv.CoderShellToolName(), injected: []shellenv.InjectedEnvVar{{Name: "CODEX_HOME", Value: filepath.Join(root, "codex-home")}, {Name: "TASK_VAR", Value: "first"}}}
	reg := tools.NewRegistry()
	if err := reg.Register(bash); err != nil {
		t.Fatal(err)
	}
	coderEnv := shellenv.CoderEnv{
		ShellPathExtra: []string{bashDir},
		// What the settings give; the registered bash tool's variables are the ones used.
		Injected: func() []shellenv.InjectedEnvVar {
			return []shellenv.InjectedEnvVar{{Name: "FROM_SETTINGS", Value: "1"}}
		},
		DefaultDirs: func() []string { return []string{defaultDir, filepath.Join(root, "missing")} },
	}
	run := func(reg *tools.Registry) []string {
		t.Helper()
		engine := New(nil, reg, Config{}, DefaultPromptSpec(), WithEngineToolsConfig(EngineToolsConfig{CoderEnabled: true, CoderEnv: coderEnv}))
		tool, ok := engine.registry.Get(coderToolName)
		if !ok {
			t.Fatal("coder is not registered")
		}
		_ = os.Remove(envFile)
		if _, err := tool.Execute(context.Background(), map[string]any{"coder": "codex", "task": "t", "cwd": root}); err != nil {
			t.Fatal(err)
		}
		return childEnv(t, envFile)
	}

	got := run(reg)
	want := shellenv.BashEnv(bash.injected, []string{bashDir})
	if want[0] != "PATH="+bashDir+":/usr/bin:/bin" {
		t.Fatalf("bash PATH = %q", want[0])
	}
	want[0] += ":" + defaultDir
	if strings.Join(got, "\n") != strings.Join(sortedEnv(want), "\n") {
		t.Fatalf("coder env:\n%s\nbash env, with the default install location:\n%s", strings.Join(got, "\n"), strings.Join(sortedEnv(want), "\n"))
	}
	joined := "\n" + strings.Join(got, "\n") + "\n"
	for _, leak := range []string{"SERVICE_SECRET", "do-not-leak", "HTTPS_PROXY", "ANTHROPIC_API_KEY", "FROM_SETTINGS"} {
		if strings.Contains(joined, leak) {
			t.Fatalf("%s reached the CLI:\n%s", leak, joined)
		}
	}
	for _, kept := range []string{"\nTASK_VAR=first\n", "\nCODEX_HOME=" + filepath.Join(root, "codex-home") + "\n", "\nTERM=dumb\n", "\nHOME=" + filepath.Join(root, "home") + "\n"} {
		if !strings.Contains(joined, kept) {
			t.Fatalf("the CLI's environment lacks %q:\n%s", kept, joined)
		}
	}
	if data, err := os.ReadFile(helperFile); err != nil || string(data) != "helper-ok" {
		t.Fatalf("a tools.bash.path_extra tool did not run inside the coder: %q, %v", data, err)
	}

	// The variables are the bash tool's at the moment of the run.
	bash.injected[1].Value = "second"
	if joined := "\n" + strings.Join(run(reg), "\n") + "\n"; !strings.Contains(joined, "\nTASK_VAR=second\n") {
		t.Fatalf("the second run did not get the variable's new value:\n%s", joined)
	}
	// Without a bash tool (tools.bash.enabled: false) the settings' variables are used.
	joined = "\n" + strings.Join(run(tools.NewRegistry()), "\n") + "\n"
	if !strings.Contains(joined, "\nFROM_SETTINGS=1\n") || strings.Contains(joined, "TASK_VAR") || strings.Contains(joined, "do-not-leak") {
		t.Fatalf("env without a bash tool:\n%s", joined)
	}
}

// A terminal session is handed the same environment and the CLI found in it.
func TestCoderTerminalRequestGetsTheCoderEnvironment(t *testing.T) {
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
			RunTerminal: func(_ context.Context, req CoderRequest) (string, error) {
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
		t.Fatalf("terminal env = %v\nwant %v", got.Env, want)
	}
	joined := "\n" + strings.Join(got.Env, "\n") + "\n"
	if strings.Contains(joined, "do-not-leak") || !strings.Contains(joined, "\nCLAUDE_CONFIG_DIR="+filepath.Join(root, "claude-config")+"\n") {
		t.Fatalf("terminal env:\n%s", joined)
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
func TestCoderRunFailsWithoutTheCLI(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("unix PATH")
	}
	t.Setenv("PATH", t.TempDir())
	_, err := runCoderCLI(context.Background(), CoderRequest{
		Backend: coderBackendCodex, Task: "x", CWD: t.TempDir(),
		CoderEnv: shellenv.CoderEnv{DefaultDirs: func() []string { return nil }},
	}, nil)
	if err == nil || !strings.Contains(err.Error(), "codex executable not found in PATH") {
		t.Fatalf("error = %v, want codex not found", err)
	}
}
