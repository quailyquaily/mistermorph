package shellenv

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// InjectedEnvSource is a shell tool that says which variables it injects into a command now. The
// bash and PowerShell tools are ones; the coder tool asks the registered one, so a coder run and
// a shell command of the same task get the same variables.
type InjectedEnvSource interface {
	ShellInjectedEnvVars() []InjectedEnvVar
}

// ConfigReader reads the settings a coder environment is made of.
type ConfigReader interface {
	Get(string) any
	GetStringSlice(string) []string
}

// CoderEnv builds the environment the runtime starts Codex, Claude Code and the Antigravity CLI
// (agy) in, and finds them in it: the shell tool's environment (BashEnv; PowerShellEnv on Windows) and nothing else of the
// runtime's, with PATH in this order:
//
//  1. PathExtra (tools.coder.path_extra),
//  2. ShellPathExtra (tools.bash.path_extra),
//  3. the runtime's PATH (the bash tool's fallback when it is empty),
//  4. only when PathExtra is empty, the CLIs' default install locations that exist and are not
//     listed already.
//
// It is built again for each run, so injected variables are the ones of that moment. The zero
// value is the bash tool's environment without settings.
type CoderEnv struct {
	// PathExtra is tools.coder.path_extra.
	PathExtra []string
	// ShellPathExtra is tools.bash.path_extra.
	ShellPathExtra []string
	// Injected gives the injected variables (tools.bash.injected_env_vars;
	// tools.powershell.injected_env_vars on Windows) when an environment is built; nil gives none.
	Injected func() []InjectedEnvVar
	// DefaultDirs gives the default install locations; nil means DefaultCoderInstallDirs. Tests
	// set it so that they never find the machine's own CLIs.
	DefaultDirs func() []string
}

// CoderShellToolName is the shell tool whose environment the coder gets on this system.
func CoderShellToolName() string {
	if runtime.GOOS == "windows" {
		return "powershell"
	}
	return "bash"
}

// CoderEnvFromConfig reads a coder environment's settings. The injected variables are kept as
// configured and resolved each time an environment is built.
func CoderEnvFromConfig(r ConfigReader) CoderEnv {
	if r == nil {
		return CoderEnv{}
	}
	rawInjected := r.Get("tools." + CoderShellToolName() + ".injected_env_vars")
	return CoderEnv{
		PathExtra:      append([]string(nil), r.GetStringSlice("tools.coder.path_extra")...),
		ShellPathExtra: append([]string(nil), r.GetStringSlice("tools.bash.path_extra")...),
		Injected:       func() []InjectedEnvVar { return InjectedEnvVarsFromConfig(rawInjected) },
	}
}

// WithInjectedFrom returns the environment with the injected variables of a shell tool, read
// when an environment is built.
func (c CoderEnv) WithInjectedFrom(source InjectedEnvSource) CoderEnv {
	if source != nil {
		c.Injected = source.ShellInjectedEnvVars
	}
	return c
}

// Env builds the environment.
func (c CoderEnv) Env() []string {
	return c.env(runtime.GOOS)
}

func (c CoderEnv) env(goos string) []string {
	var injected []InjectedEnvVar
	if c.Injected != nil {
		injected = c.Injected()
	}
	var env []string
	if goos == "windows" {
		env = PowerShellEnv(injected, c.ShellPathExtra)
	} else {
		env = BashEnv(injected, c.ShellPathExtra)
	}
	// BashEnv puts PATH first.
	dirs := filepath.SplitList(strings.TrimPrefix(env[0], "PATH="))
	if extra := CleanPathExtra(c.PathExtra); len(extra) > 0 {
		dirs = append(extra, dirs...)
	} else {
		var defaults []string
		if c.DefaultDirs != nil {
			defaults = c.DefaultDirs()
		} else {
			defaults = DefaultCoderInstallDirs(goos, os.Getenv)
		}
		for _, dir := range defaults {
			dir = strings.TrimSpace(dir)
			if dir == "" {
				continue
			}
			if info, err := os.Stat(dir); err != nil || !info.IsDir() {
				continue
			}
			dirs = append(dirs, dir)
		}
	}
	env[0] = "PATH=" + strings.Join(uniquePathDirs(dirs, goos), string(os.PathListSeparator))
	return env
}

// uniquePathDirs keeps the first of each directory.
func uniquePathDirs(dirs []string, goos string) []string {
	out := make([]string, 0, len(dirs))
	seen := make(map[string]bool, len(dirs))
	for _, dir := range dirs {
		key := dir
		if key != "" {
			key = filepath.Clean(key)
		}
		if goos == "windows" {
			key = strings.ToLower(key)
		}
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, dir)
	}
	return out
}

// DefaultCoderInstallDirs are the directories the installers of Claude Code, Codex and the
// Antigravity CLI put the CLIs in (https://claude.ai/install.sh,
// https://chatgpt.com/codex/install.sh and their .ps1, https://antigravity.google/cli/install.sh,
// checked 2026-11-15; agy's Windows directory is from its docs), and Homebrew's prefixes. getenv
// gives the home directories.
func DefaultCoderInstallDirs(goos string, getenv func(string) string) []string {
	if goos == "windows" {
		var dirs []string
		if profile := strings.TrimSpace(getenv("USERPROFILE")); profile != "" {
			dirs = append(dirs, filepath.Join(profile, ".local", "bin")) // Claude Code
		}
		if local := strings.TrimSpace(getenv("LOCALAPPDATA")); local != "" {
			dirs = append(dirs, filepath.Join(local, "Programs", "OpenAI", "Codex", "bin")) // Codex
			dirs = append(dirs, filepath.Join(local, "agy", "bin"))                         // Antigravity CLI
		}
		return dirs
	}
	var dirs []string
	if home := strings.TrimSpace(getenv("HOME")); home != "" {
		dirs = append(dirs, filepath.Join(home, ".local", "bin")) // the three installers
	}
	return append(dirs, "/opt/homebrew/bin", "/usr/local/bin", "/home/linuxbrew/.linuxbrew/bin")
}

// Command finds a CLI by name in the environment's PATH, never in the current directory, and
// returns it with the environment to start it in. A command given with a directory is returned
// as it is.
func (c CoderEnv) Command(name string) (string, []string, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return "", nil, fmt.Errorf("coder command is empty")
	}
	env := c.Env()
	if strings.ContainsAny(name, `/\`) {
		return name, env, nil
	}
	values := map[string]string{}
	for _, entry := range env {
		if key, value, ok := strings.Cut(entry, "="); ok {
			values[strings.ToUpper(key)] = value
		}
	}
	names := executableNames(name, runtime.GOOS, values["PATHEXT"])
	for _, dir := range filepath.SplitList(values["PATH"]) {
		// Like exec.LookPath, never resolve to a binary in the current directory.
		if dir = strings.TrimSpace(dir); !filepath.IsAbs(dir) {
			continue
		}
		for _, candidate := range names {
			path := filepath.Join(dir, candidate)
			info, err := os.Stat(path)
			if err != nil || !info.Mode().IsRegular() {
				continue
			}
			if runtime.GOOS == "windows" || info.Mode().Perm()&0o111 != 0 {
				return path, env, nil
			}
		}
	}
	return "", nil, fmt.Errorf("%s executable not found in PATH", name)
}

func executableNames(command, goos, pathExt string) []string {
	if goos != "windows" || strings.Contains(filepath.Base(command), ".") {
		return []string{command}
	}
	if strings.TrimSpace(pathExt) == "" {
		pathExt = ".COM;.EXE;.BAT;.CMD"
	}
	// The name without an extension comes last: beside an npm install's codex.cmd it is a shell script.
	var out []string
	for _, ext := range strings.Split(pathExt, ";") {
		ext = strings.TrimSpace(ext)
		if ext == "" {
			continue
		}
		if !strings.HasPrefix(ext, ".") {
			ext = "." + ext
		}
		out = append(out, command+ext)
	}
	return append(out, command)
}
