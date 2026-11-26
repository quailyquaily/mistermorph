package shellenv

import (
	"strings"
	"testing"
)

// While the desktop app runs an explicit network proxy, the backend's environment holds the proxy
// variables (with the proxy password) and the marker. Agent commands and coder CLIs get none of
// them unless the owner lists a name in injected_env_vars.
func TestDesktopProxyVariablesAreNotPassedOn(t *testing.T) {
	const proxy = "http://morph:s3cret@127.0.0.1:7890"
	names := []string{"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"}
	for _, name := range names {
		t.Setenv(name, proxy)
	}
	t.Setenv("MISTER_MORPH_DESKTOP_PROXY_REQUIRED", "1")
	t.Setenv("PATH", pathList("/usr/bin"))

	environments := map[string][]string{
		"bash":       BashEnv(nil, nil),
		"powershell": PowerShellEnv(nil, nil),
		"coder":      CoderEnv{Injected: func() []InjectedEnvVar { return nil }, DefaultDirs: noDefaultDirs}.env("linux"),
		"coder/win":  CoderEnv{Injected: func() []InjectedEnvVar { return nil }, DefaultDirs: noDefaultDirs}.env("windows"),
	}
	for tool, env := range environments {
		joined := strings.Join(env, "\n")
		if strings.Contains(joined, "s3cret") || strings.Contains(strings.ToUpper(joined), "_PROXY") {
			t.Fatalf("%s: a proxy variable or the marker was passed on: %v", tool, env)
		}
	}

	// Listed by name, the app's values (password included) are passed.
	injected := InjectedEnvVarsFromConfig([]any{"HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"})
	for tool, env := range map[string][]string{
		"bash":  BashEnv(injected, nil),
		"coder": CoderEnv{Injected: func() []InjectedEnvVar { return injected }, DefaultDirs: noDefaultDirs}.env("linux"),
	} {
		values := envMap(t, env)
		for _, name := range []string{"HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"} {
			if values[name] != proxy {
				t.Fatalf("%s: %s = %q, want the app's value", tool, name, values[name])
			}
		}
		if _, ok := values["MISTER_MORPH_DESKTOP_PROXY_REQUIRED"]; ok {
			t.Fatalf("%s: the marker was passed on", tool)
		}
	}
}
