package builtin

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/quailyquaily/mistermorph/internal/elevate"
	"github.com/quailyquaily/mistermorph/internal/pathroots"
	"github.com/quailyquaily/mistermorph/internal/shellenv"
)

type PowerShellTool struct {
	Enabled         bool
	DefaultTimeout  time.Duration
	MaxOutputBytes  int
	Roots           pathroots.PathRoots
	DenyPaths       []string
	DenyTokens      []string
	InjectedEnvVars []shellenv.InjectedEnvVar
	// Elevation lets a command run as administrator after the user approves the UAC prompt
	// (tools.powershell.elevation).
	Elevation elevate.Config
}

func NewPowerShellTool(enabled bool, defaultTimeout time.Duration, maxOutputBytes int, roots pathroots.PathRoots) *PowerShellTool {
	if defaultTimeout <= 0 {
		defaultTimeout = time.Minute
	}
	if maxOutputBytes <= 0 {
		maxOutputBytes = 256 * 1024
	}
	return &PowerShellTool{
		Enabled:        enabled,
		DefaultTimeout: defaultTimeout,
		MaxOutputBytes: maxOutputBytes,
		Roots:          pathroots.New(roots.WorkspaceDir, roots.FileCacheDir, roots.FileStateDir),
	}
}

func (t *PowerShellTool) Name() string { return "powershell" }

func (t *PowerShellTool) Description() string {
	return "Runs a PowerShell command and returns stdout/stderr. " +
		"For the `cmd` and `cwd`, supports path aliases workspace_dir, file_cache_dir, and file_state_dir. When workspace_dir is attached, powershell defaults to cwd=workspace_dir."
}

func (t *PowerShellTool) ParameterSchema() string {
	s := map[string]any{
		"type": "object",
		"properties": map[string]any{
			"cmd": map[string]any{
				"type":        "string",
				"description": "PowerShell command to execute.",
			},
			"cwd": map[string]any{
				"type":        "string",
				"description": "Optional working directory.",
			},
			"timeout_seconds": map[string]any{
				"type":        "number",
				"description": "Optional timeout in seconds.",
			},
		},
		"required": []string{"cmd"},
	}
	if t.elevationOffered() {
		s["properties"].(map[string]any)["elevated"] = map[string]any{
			"type":        "boolean",
			"description": elevatedParamDescription + " Output arrives when the command ends.",
		}
	}
	b, _ := json.MarshalIndent(s, "", "  ")
	return string(b)
}

func (t *PowerShellTool) Execute(ctx context.Context, params map[string]any) (string, error) {
	if !t.Enabled {
		return "", fmt.Errorf("powershell tool is disabled (enable via config: tools.powershell.enabled=true)")
	}
	if elevated, _ := asBool(params["elevated"]); elevated {
		inv, err := prepareShellInvocation(ctx, params, t.commonConfig(), t.runnerSpec())
		if err != nil {
			return "", err
		}
		return t.executeElevated(ctx, inv)
	}
	return executeShellCommand(ctx, params, t.commonConfig(), t.runnerSpec())
}

// elevationOffered reports whether powershell offers elevated commands: on Windows, through UAC,
// when tools.powershell.elevation allows it. Linux and macOS elevate through the bash tool.
func (t *PowerShellTool) elevationOffered() bool {
	return runtime.GOOS == "windows" && elevate.Check(t.Elevation) == nil
}

// executeElevated runs a command in a powershell started with -Verb RunAs, which shows the UAC
// prompt; the elevated process writes its output to a file this one reads back (elevate.RunAsScript).
func (t *PowerShellTool) executeElevated(ctx context.Context, inv shellInvocation) (string, error) {
	if runtime.GOOS != "windows" {
		return "", fmt.Errorf("powershell runs elevated commands on Windows only; use the bash tool with elevated: true")
	}
	if err := elevate.Check(t.Elevation); err != nil {
		return "", fmt.Errorf("cannot ask for administrator rights here: %v. Ask the user to run the command themselves: %s", err, inv.Command)
	}
	var nonce [8]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return "", err
	}
	outPath := filepath.Join(os.TempDir(), "mistermorph-elevated-"+hex.EncodeToString(nonce[:])+".log")
	defer os.Remove(outPath)
	command := inv.Command
	inv.Command = elevate.RunAsScript(command, inv.CWD, outPath)
	// The user has this long to answer the UAC prompt, on top of the command's own time.
	inv.Timeout += t.Elevation.Approval()
	return runElevated(ctx, t.Name(), command, t.commonConfig(), t.runnerSpec(), inv)
}

func (t *PowerShellTool) commonConfig() shellToolCommon {
	return shellToolCommon{
		ToolName:        t.Name(),
		DefaultTimeout:  t.DefaultTimeout,
		MaxOutputBytes:  t.MaxOutputBytes,
		Roots:           t.Roots,
		DenyPaths:       append([]string(nil), t.DenyPaths...),
		DenyTokens:      append([]string(nil), t.DenyTokens...),
		InjectedEnvVars: shellenv.CloneInjectedEnvVars(t.InjectedEnvVars),
	}
}

func (t *PowerShellTool) runnerSpec() shellRunnerSpec {
	return shellRunnerSpec{
		Program:         "powershell",
		ArgsPrefix:      []string{"-NoProfile", "-Command"},
		BuildEnv:        powershellToolEnv,
		TokenBoundary:   isPowerShellBoundaryByte,
		MatchDeniedPath: powershellCommandDenied,
		TimeoutExitCode: 0,
	}
}

func powershellToolEnv(injected []shellenv.InjectedEnvVar) []string {
	env := bashToolEnvWithPathExtra(injected, nil)
	seen := make(map[string]bool, len(env))
	for _, e := range env {
		if i := strings.Index(e, "="); i > 0 {
			seen[strings.ToUpper(e[:i])] = true
		}
	}
	for _, key := range []string{
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
	} {
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

func powershellCommandDenied(cmdStr string, denyPaths []string) (string, bool) {
	cmdStr = normalizePowerShellToken(cmdStr)
	if cmdStr == "" || len(denyPaths) == 0 {
		return "", false
	}
	for _, raw := range denyPaths {
		normalized := normalizePowerShellToken(raw)
		if normalized == "" {
			continue
		}
		if containsTokenBoundaryWithBoundary(cmdStr, normalized, isPowerShellBoundaryByte) {
			return raw, true
		}
		if base := path.Base(normalized); base != "." && base != "/" && containsTokenBoundaryWithBoundary(cmdStr, base, isPowerShellBoundaryByte) {
			return base, true
		}
	}
	return "", false
}

func normalizePowerShellToken(raw string) string {
	value := strings.TrimSpace(raw)
	if value == "" {
		return ""
	}
	value = strings.ReplaceAll(value, "\\", "/")
	value = strings.ToLower(value)
	return path.Clean(value)
}
