package shellenv

import (
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
)

// noDefaultDirs keeps a test from looking at the machine's own install locations.
func noDefaultDirs() []string { return nil }

func envMap(t *testing.T, env []string) map[string]string {
	t.Helper()
	out := map[string]string{}
	for _, entry := range env {
		key, value, ok := strings.Cut(entry, "=")
		if !ok {
			t.Fatalf("malformed entry %q", entry)
		}
		if _, dup := out[key]; dup {
			t.Fatalf("%s is set twice in %v", key, env)
		}
		out[key] = value
	}
	return out
}

func pathList(dirs ...string) string {
	return strings.Join(dirs, string(os.PathListSeparator))
}

func writeExecutable(t *testing.T, dir, name string, mode os.FileMode) string {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"), mode); err != nil {
		t.Fatal(err)
	}
	return path
}

// The coder's environment is the bash tool's for the same settings: the allowlist, the injected
// variables and the bash tool's PATH, and nothing else of the runtime's environment.
func TestCoderEnvIsTheBashToolsEnvironment(t *testing.T) {
	t.Setenv("PATH", pathList("/runtime/bin", "/usr/bin"))
	t.Setenv("HOME", "/home/someone")
	t.Setenv("TERM", "dumb")
	t.Setenv("SERVICE_SECRET", "do-not-leak")
	t.Setenv("HTTPS_PROXY", "http://proxy.invalid")
	t.Setenv("CODEX_HOME", "/srv/codex")
	t.Setenv("ANTHROPIC_API_KEY", "do-not-leak-either")
	injected := []InjectedEnvVar{{Name: "CODEX_HOME", Value: "/srv/codex"}, {Name: "LITERAL", Value: "fixed"}, {Name: "PATH", Value: "/ignored"}}
	bashExtra := []string{" /bash/extra ", ""}

	got := CoderEnv{ShellPathExtra: bashExtra, Injected: func() []InjectedEnvVar { return injected }, DefaultDirs: noDefaultDirs}.env("linux")
	want := BashEnv(injected, bashExtra)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("coder env = %v\nbash env  = %v", got, want)
	}
	values := envMap(t, got)
	for _, key := range []string{"SERVICE_SECRET", "HTTPS_PROXY", "ANTHROPIC_API_KEY"} {
		if _, ok := values[key]; ok {
			t.Fatalf("%s reached the coder: %v", key, got)
		}
	}
	if strings.Contains(strings.Join(got, "\n"), "do-not-leak") {
		t.Fatalf("a secret reached the coder: %v", got)
	}
	for key, value := range map[string]string{
		"PATH": pathList("/bash/extra", "/runtime/bin", "/usr/bin"), "HOME": "/home/someone", "TERM": "dumb",
		"CODEX_HOME": "/srv/codex", "LITERAL": "fixed",
	} {
		if values[key] != value {
			t.Fatalf("%s = %q, want %q", key, values[key], value)
		}
	}
}

func TestCoderEnvPathOrder(t *testing.T) {
	existing := t.TempDir()
	defaults := func() []string { return []string{existing} }
	t.Run("coder extras, bash extras, runtime PATH, and no defaults", func(t *testing.T) {
		t.Setenv("PATH", pathList("/runtime/bin", "/usr/bin"))
		env := CoderEnv{PathExtra: []string{" /coder/a ", "", "/coder/b", "/coder/a"}, ShellPathExtra: []string{"/bash/extra"}, DefaultDirs: defaults}.env("linux")
		want := pathList("/coder/a", "/coder/b", "/bash/extra", "/runtime/bin", "/usr/bin")
		if got := envMap(t, env)["PATH"]; got != want {
			t.Fatalf("PATH = %q, want %q", got, want)
		}
	})
	t.Run("defaults come last when there are no coder extras", func(t *testing.T) {
		t.Setenv("PATH", pathList("/runtime/bin", "/usr/bin"))
		env := CoderEnv{ShellPathExtra: []string{"/bash/extra"}, DefaultDirs: defaults}.env("linux")
		want := pathList("/bash/extra", "/runtime/bin", "/usr/bin", existing)
		if got := envMap(t, env)["PATH"]; got != want {
			t.Fatalf("PATH = %q, want %q", got, want)
		}
	})
	t.Run("blank coder extras count as empty", func(t *testing.T) {
		t.Setenv("PATH", "/runtime/bin")
		env := CoderEnv{PathExtra: []string{"", "  "}, DefaultDirs: defaults}.env("linux")
		if got, want := envMap(t, env)["PATH"], pathList("/runtime/bin", existing); got != want {
			t.Fatalf("PATH = %q, want %q", got, want)
		}
	})
	t.Run("the bash tool's fallback stands in for an empty runtime PATH", func(t *testing.T) {
		t.Setenv("PATH", "")
		env := CoderEnv{PathExtra: []string{"/coder/a"}, ShellPathExtra: []string{"/bash/extra"}, DefaultDirs: defaults}.env("linux")
		want := pathList("/coder/a", "/bash/extra", bashFallbackPath)
		if got := envMap(t, env)["PATH"]; got != want {
			t.Fatalf("PATH = %q, want %q", got, want)
		}
		if bash := envMap(t, BashEnv(nil, []string{"/bash/extra"}))["PATH"]; bash != pathList("/bash/extra", bashFallbackPath) {
			t.Fatalf("bash PATH = %q", bash)
		}
	})
}

// Only directories that exist are appended, after PATH, and none twice.
func TestCoderEnvDefaultDirs(t *testing.T) {
	root := t.TempDir()
	inPath := filepath.Join(root, "in-path")
	fresh := filepath.Join(root, "fresh")
	file := filepath.Join(root, "a-file")
	for _, dir := range []string{inPath, fresh} {
		if err := os.Mkdir(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(file, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	missing := filepath.Join(root, "missing")
	t.Setenv("PATH", pathList("/runtime/bin", inPath))
	defaults := func() []string { return []string{inPath + "/", missing, file, fresh, "", fresh} }

	env := CoderEnv{DefaultDirs: defaults}.env("linux")
	if got, want := envMap(t, env)["PATH"], pathList("/runtime/bin", inPath, fresh); got != want {
		t.Fatalf("PATH = %q, want %q", got, want)
	}
	// With tools.coder.path_extra set, nothing is appended.
	env = CoderEnv{PathExtra: []string{"/coder/a"}, DefaultDirs: defaults}.env("linux")
	if got, want := envMap(t, env)["PATH"], pathList("/coder/a", "/runtime/bin", inPath); got != want {
		t.Fatalf("PATH = %q, want %q", got, want)
	}
}

func TestDefaultCoderInstallDirs(t *testing.T) {
	getenv := func(values map[string]string) func(string) string {
		return func(key string) string { return values[key] }
	}
	got := DefaultCoderInstallDirs("linux", getenv(map[string]string{"HOME": "/home/someone"}))
	want := []string{filepath.Join("/home/someone", ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/home/linuxbrew/.linuxbrew/bin"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("unix dirs = %v, want %v", got, want)
	}
	if got := DefaultCoderInstallDirs("darwin", getenv(nil)); !reflect.DeepEqual(got, want[1:]) {
		t.Fatalf("dirs without a home = %v, want %v", got, want[1:])
	}
	got = DefaultCoderInstallDirs("windows", getenv(map[string]string{"USERPROFILE": "profile", "LOCALAPPDATA": "local"}))
	want = []string{filepath.Join("profile", ".local", "bin"), filepath.Join("local", "Programs", "OpenAI", "Codex", "bin"), filepath.Join("local", "agy", "bin")}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("windows dirs = %v, want %v", got, want)
	}
	if got := DefaultCoderInstallDirs("windows", getenv(nil)); len(got) != 0 {
		t.Fatalf("windows dirs without a profile = %v", got)
	}
}

// The default list reads the home directory the CLI is given.
func TestCoderEnvDefaultsFollowHome(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("unix home")
	}
	home := t.TempDir()
	bin := filepath.Join(home, ".local", "bin")
	if err := os.MkdirAll(bin, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", home)
	t.Setenv("PATH", "/runtime/bin")
	dirs := filepath.SplitList(envMap(t, CoderEnv{}.Env())["PATH"])
	if len(dirs) < 2 || dirs[0] != "/runtime/bin" || dirs[1] != bin {
		t.Fatalf("PATH = %v, want /runtime/bin then %s", dirs, bin)
	}
}

// On Windows the coder gets the PowerShell tool's environment, with the coder's PATH.
func TestCoderEnvOnWindowsIsThePowerShellToolsEnvironment(t *testing.T) {
	t.Setenv("PATH", "/runtime/bin")
	t.Setenv("SERVICE_SECRET", "do-not-leak")
	kept := map[string]string{
		"USERPROFILE": "profile", "APPDATA": "roaming", "LOCALAPPDATA": "local", "SYSTEMROOT": "windows", "PATHEXT": ".EXE;.CMD",
	}
	for key, value := range kept {
		t.Setenv(key, value)
	}
	injected := []InjectedEnvVar{{Name: "HTTPS_PROXY", Value: "http://proxy.invalid"}}
	got := CoderEnv{PathExtra: []string{"/coder/a"}, ShellPathExtra: []string{"/bash/extra"}, Injected: func() []InjectedEnvVar { return injected }, DefaultDirs: noDefaultDirs}.env("windows")
	want := PowerShellEnv(injected, []string{"/bash/extra"})
	want[0] = "PATH=" + pathList("/coder/a", "/bash/extra", "/runtime/bin")
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("coder env      = %v\npowershell env = %v", got, want)
	}
	values := envMap(t, got)
	kept["HTTPS_PROXY"] = "http://proxy.invalid"
	for key, value := range kept {
		if values[key] != value {
			t.Fatalf("%s = %q, want %q", key, values[key], value)
		}
	}
	if _, ok := values["SERVICE_SECRET"]; ok {
		t.Fatalf("a secret reached the coder: %v", got)
	}
	if !reflect.DeepEqual(PowerShellEnv(injected, nil)[1:], want[1:]) {
		t.Fatal("PowerShellEnv differs beyond PATH with a path extra")
	}
}

type mapReader map[string]any

func (r mapReader) Get(key string) any { return r[key] }
func (r mapReader) GetStringSlice(key string) []string {
	out, _ := r[key].([]string)
	return out
}

// Injected variables are resolved each time an environment is built, as a name's value is then.
func TestCoderEnvFromConfigResolvesInjectedVarsWhenBuilt(t *testing.T) {
	shell := CoderShellToolName()
	env := CoderEnvFromConfig(mapReader{
		"tools.coder.path_extra":                []string{"/coder/a"},
		"tools.bash.path_extra":                 []string{"/bash/extra"},
		"tools." + shell + ".injected_env_vars": []any{"LATE_VALUE", map[string]any{"name": "LITERAL", "value": "fixed"}},
	})
	env.DefaultDirs = noDefaultDirs
	t.Setenv("PATH", "/runtime/bin")
	t.Setenv("NOT_LISTED", "do-not-leak")

	values := envMap(t, env.Env())
	if _, ok := values["LATE_VALUE"]; ok {
		t.Fatalf("an unset variable was injected: %v", values)
	}
	if values["LITERAL"] != "fixed" || values["PATH"] != pathList("/coder/a", "/bash/extra", "/runtime/bin") {
		t.Fatalf("env = %v", values)
	}
	for _, value := range []string{"first", "second"} {
		t.Setenv("LATE_VALUE", value)
		values = envMap(t, env.Env())
		if values["LATE_VALUE"] != value {
			t.Fatalf("LATE_VALUE = %q, want %q", values["LATE_VALUE"], value)
		}
		if _, ok := values["NOT_LISTED"]; ok {
			t.Fatalf("a variable that is not listed reached the coder: %v", values)
		}
	}
	if got := CoderEnvFromConfig(nil); got.PathExtra != nil || got.Injected != nil {
		t.Fatalf("nil reader = %+v", got)
	}
}

type injectedSource []InjectedEnvVar

func (s injectedSource) ShellInjectedEnvVars() []InjectedEnvVar { return s }

func TestCoderEnvWithInjectedFrom(t *testing.T) {
	t.Setenv("PATH", "/runtime/bin")
	base := CoderEnv{Injected: func() []InjectedEnvVar { return []InjectedEnvVar{{Name: "FROM_CONFIG", Value: "1"}} }, DefaultDirs: noDefaultDirs}
	values := envMap(t, base.WithInjectedFrom(injectedSource{{Name: "FROM_TOOL", Value: "2"}}).Env())
	if values["FROM_TOOL"] != "2" || values["FROM_CONFIG"] != "" {
		t.Fatalf("env = %v, want the tool's variables only", values)
	}
	if values = envMap(t, base.WithInjectedFrom(nil).Env()); values["FROM_CONFIG"] != "1" {
		t.Fatalf("env = %v, want the configured variables", values)
	}
}

func TestCoderEnvCommand(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("unix permissions")
	}
	root := t.TempDir()
	runtimeDir := filepath.Join(root, "runtime")
	bashDir := filepath.Join(root, "bash")
	coderDir := filepath.Join(root, "coder")
	defaultDir := filepath.Join(root, "home", ".local", "bin")
	for _, dir := range []string{runtimeDir, bashDir, coderDir, defaultDir} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	defaults := func() []string { return []string{defaultDir} }
	t.Setenv("PATH", runtimeDir)
	t.Setenv("SERVICE_SECRET", "do-not-leak")

	// Nowhere: the lookup fails, and does not fall back to the runtime's environment.
	if path, env, err := (CoderEnv{DefaultDirs: defaults}).Command("codex"); err == nil || env != nil || !strings.Contains(err.Error(), "codex executable not found in PATH") {
		t.Fatalf("Command() = %q, %v, %v, want not found", path, env, err)
	}
	// In a default install location only.
	inDefault := writeExecutable(t, defaultDir, "codex", 0o755)
	path, env, err := CoderEnv{DefaultDirs: defaults}.Command("codex")
	if err != nil || path != inDefault {
		t.Fatalf("Command() = %q, %v, want %s", path, err, inDefault)
	}
	values := envMap(t, env)
	if values["PATH"] != pathList(runtimeDir, defaultDir) {
		t.Fatalf("PATH = %q", values["PATH"])
	}
	if _, ok := values["SERVICE_SECRET"]; ok {
		t.Fatalf("a secret is in the command's environment: %v", env)
	}
	// With coder extras the defaults are not searched.
	if path, _, err := (CoderEnv{PathExtra: []string{coderDir}, DefaultDirs: defaults}).Command("codex"); err == nil {
		t.Fatalf("Command() = %q, want not found with tools.coder.path_extra set", path)
	}
	// A file that cannot be run and a directory of the name are passed over.
	writeExecutable(t, runtimeDir, "claude", 0o644)
	if err := os.Mkdir(filepath.Join(bashDir, "claude"), 0o755); err != nil {
		t.Fatal(err)
	}
	if path, _, err := (CoderEnv{ShellPathExtra: []string{bashDir}, DefaultDirs: defaults}).Command("claude"); err == nil {
		t.Fatalf("Command() = %q, want not found", path)
	}
	// The PATH's CLI wins over a default location's, the bash tool's extras over the PATH, the
	// coder's extras over both.
	inRuntime := writeExecutable(t, runtimeDir, "codex", 0o755)
	if path, _, err := (CoderEnv{DefaultDirs: defaults}).Command("codex"); err != nil || path != inRuntime {
		t.Fatalf("Command() = %q, %v, want %s", path, err, inRuntime)
	}
	inBash := writeExecutable(t, bashDir, "codex", 0o755)
	if path, _, err := (CoderEnv{ShellPathExtra: []string{bashDir}, DefaultDirs: defaults}).Command("codex"); err != nil || path != inBash {
		t.Fatalf("Command() = %q, %v, want %s", path, err, inBash)
	}
	inCoder := writeExecutable(t, coderDir, "codex", 0o755)
	if path, _, err := (CoderEnv{PathExtra: []string{coderDir}, ShellPathExtra: []string{bashDir}, DefaultDirs: defaults}).Command("codex"); err != nil || path != inCoder {
		t.Fatalf("Command() = %q, %v, want %s", path, err, inCoder)
	}
	// A command given with a directory is not looked up.
	if path, env, err := (CoderEnv{DefaultDirs: defaults}).Command("/elsewhere/codex"); err != nil || path != "/elsewhere/codex" || len(env) == 0 {
		t.Fatalf("Command() = %q, %v, %v", path, env, err)
	}
	if _, _, err := (CoderEnv{}).Command("  "); err == nil {
		t.Fatal("an empty command was accepted")
	}
}

// Like exec.LookPath, a CLI in the current directory is never found through a relative entry.
func TestCoderEnvCommandSkipsRelativePathEntries(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("unix permissions")
	}
	cwd := t.TempDir()
	writeExecutable(t, cwd, "codex", 0o755)
	writeExecutable(t, filepath.Join(cwd, "bin"), "codex", 0o755)
	t.Chdir(cwd)
	t.Setenv("PATH", pathList("", ".", "bin"))
	if path, _, err := (CoderEnv{PathExtra: []string{"bin"}}).Command("codex"); err == nil {
		t.Fatalf("Command() = %q, want not found", path)
	}
	abs := t.TempDir()
	want := writeExecutable(t, abs, "codex", 0o755)
	if path, _, err := (CoderEnv{PathExtra: []string{".", abs}}).Command("codex"); err != nil || path != want {
		t.Fatalf("Command() = %q, %v, want %s", path, err, want)
	}
}

func TestExecutableNames(t *testing.T) {
	if got := executableNames("codex", "linux", ".EXE"); !reflect.DeepEqual(got, []string{"codex"}) {
		t.Fatalf("unix names = %v", got)
	}
	if got, want := executableNames("codex", "windows", ".EXE; cmd;"), []string{"codex.EXE", "codex.cmd", "codex"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("windows names = %v, want %v", got, want)
	}
	if got, want := executableNames("codex", "windows", ""), []string{"codex.COM", "codex.EXE", "codex.BAT", "codex.CMD", "codex"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("windows default names = %v, want %v", got, want)
	}
	if got := executableNames("codex.exe", "windows", ".EXE"); !reflect.DeepEqual(got, []string{"codex.exe"}) {
		t.Fatalf("names with an extension = %v", got)
	}
}
