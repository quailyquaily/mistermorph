package shellenv

import (
	"os"
	"strings"
)

// bashFallbackPath is the PATH a command gets when the runtime has none.
const bashFallbackPath = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

// bashEnvKeys are the runtime's variables a bash command keeps, besides PATH.
var bashEnvKeys = []string{
	"HOME",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"TERM",
	"TZ",
	"TMPDIR",
	"USER",
	"LOGNAME",
	"SHELL",
	"XDG_CONFIG_HOME",
	"XDG_CACHE_HOME",
	"XDG_DATA_HOME",
	"XDG_RUNTIME_DIR",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
}

// powershellEnvKeys are the runtime's variables a PowerShell command keeps on top of bash's.
var powershellEnvKeys = []string{
	"ALLUSERSPROFILE",
	"APPDATA",
	"COMMONPROGRAMFILES",
	"COMMONPROGRAMFILES(X86)",
	"COMMONPROGRAMW6432",
	"COMPUTERNAME",
	"COMSPEC",
	"DriverData",
	"HOMEDRIVE",
	"HOMEPATH",
	"LOCALAPPDATA",
	"LOGONSERVER",
	"NUMBER_OF_PROCESSORS",
	"OS",
	"PATHEXT",
	"PROCESSOR_ARCHITECTURE",
	"PROCESSOR_IDENTIFIER",
	"PROCESSOR_LEVEL",
	"PROCESSOR_REVISION",
	"PROGRAMDATA",
	"PROGRAMFILES",
	"PROGRAMFILES(X86)",
	"PROGRAMW6432",
	"PSModulePath",
	"PUBLIC",
	"SESSIONNAME",
	"SYSTEMDRIVE",
	"SYSTEMROOT",
	"TEMP",
	"TMP",
	"USERDNSDOMAIN",
	"USERDOMAIN",
	"USERDOMAIN_ROAMINGPROFILE",
	"USERNAME",
	"USERPROFILE",
	"WINDIR",
}

// BashEnv is the environment the bash tool gives a command: PATH (pathExtra in front of the
// runtime's, or of a fallback when the runtime has none), an allowlist of the runtime's variables,
// and the injected ones. Nothing else of the runtime's environment is in it. The coder's
// environment (CoderEnv) is built from it too, so the two cannot drift.
func BashEnv(injected []InjectedEnvVar, pathExtra []string) []string {
	pathValue := strings.TrimSpace(os.Getenv("PATH"))
	if pathValue == "" {
		pathValue = bashFallbackPath
	}
	if extra := CleanPathExtra(pathExtra); len(extra) > 0 {
		pathValue = strings.Join(append(extra, pathValue), string(os.PathListSeparator))
	}
	env := []string{"PATH=" + pathValue}
	seen := map[string]bool{"PATH": true}
	for _, key := range bashEnvKeys {
		seen[key] = true
		value, ok := os.LookupEnv(key)
		if !ok || strings.TrimSpace(value) == "" {
			continue
		}
		env = append(env, key+"="+value)
	}
	for _, item := range injected {
		key := NormalizeName(item.Name)
		if key == "" || seen[key] {
			continue
		}
		seen[key] = true
		env = append(env, key+"="+item.Value)
	}
	return env
}

// PowerShellEnv is the environment the PowerShell tool gives a command: BashEnv with the
// variables Windows programs need (USERPROFILE, APPDATA, LOCALAPPDATA, SystemRoot, PATHEXT, …).
func PowerShellEnv(injected []InjectedEnvVar, pathExtra []string) []string {
	env := BashEnv(injected, pathExtra)
	seen := make(map[string]bool, len(env))
	for _, e := range env {
		if i := strings.Index(e, "="); i > 0 {
			seen[strings.ToUpper(e[:i])] = true
		}
	}
	for _, key := range powershellEnvKeys {
		if seen[strings.ToUpper(key)] {
			continue
		}
		value, ok := os.LookupEnv(key)
		if !ok || strings.TrimSpace(value) == "" {
			continue
		}
		seen[strings.ToUpper(key)] = true
		env = append(env, key+"="+value)
	}
	return env
}

// CleanPathExtra trims a path_extra list and drops its empty entries.
func CleanPathExtra(in []string) []string {
	if len(in) == 0 {
		return nil
	}
	out := make([]string, 0, len(in))
	for _, item := range in {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		out = append(out, item)
	}
	return out
}
