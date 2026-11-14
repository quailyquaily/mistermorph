package builtin

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/internal/pathroots"
	"github.com/quailyquaily/mistermorph/internal/pathutil"
	"github.com/quailyquaily/mistermorph/internal/shellenv"
)

type shellExecutionPayload struct {
	ExitCode        int    `json:"exit_code"`
	StdoutTruncated bool   `json:"stdout_truncated"`
	StderrTruncated bool   `json:"stderr_truncated"`
	Stdout          string `json:"stdout"`
	Stderr          string `json:"stderr"`
}

type shellToolCommon struct {
	ToolName        string
	DefaultTimeout  time.Duration
	MaxOutputBytes  int
	Roots           pathroots.PathRoots
	DenyPaths       []string
	DenyTokens      []string
	InjectedEnvVars []shellenv.InjectedEnvVar
}

type shellInvocation struct {
	Command string
	CWD     string
	Timeout time.Duration
}

type shellRunnerSpec struct {
	Program                    string
	ArgsPrefix                 []string
	BuildEnv                   func(injected []shellenv.InjectedEnvVar) []string
	TokenBoundary              func(byte) bool
	MatchDeniedPath            func(cmd string, denyPaths []string) (string, bool)
	StreamOutput               bool
	EmitChunk                  func(ctx context.Context, stream, text string)
	TimeoutExitCode            int
	ReturnObservationOnFailure bool
	// OnStart, when set, gets the pid of the started program.
	OnStart func(pid int)
}

type shellStreamWriter struct {
	stream string
	dst    *limitedBuffer
	emit   func(stream, text string)
}

func (w shellStreamWriter) Write(p []byte) (int, error) {
	n, err := w.dst.Write(p)
	if n > 0 && w.emit != nil {
		text := string(bytes.ToValidUTF8(p[:n], []byte("\n[non-utf8 output]\n")))
		if strings.TrimSpace(text) != "" {
			w.emit(w.stream, text)
		}
	}
	return n, err
}

type shellFailureKind int

const (
	shellFailureNone shellFailureKind = iota
	shellFailureExit
	shellFailureTimeout
	shellFailureExec
)

func prepareShellInvocation(ctx context.Context, params map[string]any, common shellToolCommon, spec shellRunnerSpec) (shellInvocation, error) {
	cmdStr, _ := params["cmd"].(string)
	cmdStr = strings.TrimSpace(cmdStr)
	if cmdStr == "" {
		return shellInvocation{}, fmt.Errorf("missing required param: cmd")
	}

	var err error
	cmdStr, err = expandShellPathAliases(pathroots.Resolve(ctx, common.Roots), cmdStr, spec.TokenBoundary)
	if err != nil {
		return shellInvocation{}, err
	}

	if err := validateShellCommandAllowed(cmdStr, common, spec); err != nil {
		return shellInvocation{}, err
	}

	cwd, _ := params["cwd"].(string)
	cwd, err = resolveShellCWD(ctx, common.Roots, strings.TrimSpace(cwd))
	if err != nil {
		return shellInvocation{}, err
	}

	timeout := common.DefaultTimeout
	if v, ok := params["timeout_seconds"]; ok {
		if secs, ok := asFloat64(v); ok && secs > 0 {
			timeout = time.Duration(secs * float64(time.Second))
		}
	}

	return shellInvocation{
		Command: cmdStr,
		CWD:     cwd,
		Timeout: timeout,
	}, nil
}

func validateShellCommandAllowed(cmdStr string, common shellToolCommon, spec shellRunnerSpec) error {
	if spec.MatchDeniedPath != nil {
		if offending, ok := spec.MatchDeniedPath(cmdStr, common.DenyPaths); ok {
			return fmt.Errorf("%s command references denied path %q (configure via tools.%s.deny_paths)", common.ToolName, offending, common.ToolName)
		}
	}
	if offending, ok := bashCommandDeniedTokens(cmdStr, common.DenyTokens); ok {
		return fmt.Errorf("%s command references denied token %q", common.ToolName, offending)
	}
	return nil
}

func executeShellCommand(ctx context.Context, params map[string]any, common shellToolCommon, spec shellRunnerSpec) (string, error) {
	inv, err := prepareShellInvocation(ctx, params, common, spec)
	if err != nil {
		return "", err
	}
	payload, failureKind, err := runShellCommand(ctx, common, spec, inv)
	if err != nil {
		observation := formatShellObservation(payload)
		if failureKind == shellFailureExit || spec.ReturnObservationOnFailure {
			return observation, err
		}
		return "", err
	}
	return formatShellObservation(payload), nil
}

func runShellCommand(ctx context.Context, common shellToolCommon, spec shellRunnerSpec, inv shellInvocation) (shellExecutionPayload, shellFailureKind, error) {
	runCtx, cancel := context.WithTimeout(ctx, inv.Timeout)
	defer cancel()

	args := append(append([]string(nil), spec.ArgsPrefix...), inv.Command)
	cmd := exec.CommandContext(runCtx, spec.Program, args...)
	configureShellProcess(cmd)
	if inv.CWD != "" {
		cmd.Dir = inv.CWD
	}
	if spec.BuildEnv != nil {
		cmd.Env = spec.BuildEnv(common.InjectedEnvVars)
	}

	var stdout limitedBuffer
	var stderr limitedBuffer
	stdout.Limit = common.MaxOutputBytes
	stderr.Limit = common.MaxOutputBytes
	emit := streamEmitter(spec, ctx)
	cmd.Stdout = shellStreamWriter{stream: "stdout", dst: &stdout, emit: emit}
	cmd.Stderr = shellStreamWriter{stream: "stderr", dst: &stderr, emit: emit}
	cmd.WaitDelay = 100 * time.Millisecond
	err := cmd.Start()
	if err == nil {
		agent.RecordWorkerProcess(ctx, spec.Program, cmd.Process.Pid)
		if spec.OnStart != nil {
			spec.OnStart(cmd.Process.Pid)
		}
		err = cmd.Wait()
	}
	if errors.Is(err, exec.ErrWaitDelay) {
		err = nil
	}

	exitCode := 0
	failureKind := shellFailureNone
	if err != nil {
		switch {
		case runCtx.Err() != nil:
			exitCode = spec.TimeoutExitCode
			failureKind = shellFailureTimeout
			err = fmt.Errorf("%s timed out after %s", common.ToolName, inv.Timeout)
		case isExitError(err):
			exitCode = exitCodeFromError(err)
			failureKind = shellFailureExit
		default:
			exitCode = -1
			failureKind = shellFailureExec
		}
	}

	payload := shellExecutionPayload{
		ExitCode:        exitCode,
		StdoutTruncated: stdout.Truncated,
		StderrTruncated: stderr.Truncated,
		Stdout:          string(bytes.ToValidUTF8(stdout.Bytes(), []byte("\n[non-utf8 output]\n"))),
		Stderr:          string(bytes.ToValidUTF8(stderr.Bytes(), []byte("\n[non-utf8 output]\n"))),
	}
	if err == nil {
		return payload, shellFailureNone, nil
	}
	if failureKind == shellFailureExit {
		err = fmt.Errorf("%s exited with code %d", common.ToolName, exitCode)
	}
	return payload, failureKind, err
}

func streamEmitter(spec shellRunnerSpec, ctx context.Context) func(stream, text string) {
	if !spec.StreamOutput || spec.EmitChunk == nil {
		return nil
	}
	return func(stream, text string) {
		spec.EmitChunk(ctx, stream, text)
	}
}

func resolveShellCWD(ctx context.Context, roots pathroots.PathRoots, raw string) (string, error) {
	roots = pathroots.Resolve(ctx, roots)
	raw = strings.TrimSpace(raw)
	if raw == "" {
		if workspaceDir := strings.TrimSpace(roots.WorkspaceDir); workspaceDir != "" {
			return workspaceDir, nil
		}
		return "", nil
	}
	raw = pathutil.ExpandHomePath(raw)
	alias, rest := detectPathAlias(raw)
	if alias != "" {
		return resolveAliasedPath(roots, alias, rest, false)
	}
	if filepath.IsAbs(raw) {
		return filepath.Abs(filepath.Clean(raw))
	}
	if workspaceDir := strings.TrimSpace(roots.WorkspaceDir); workspaceDir != "" {
		return filepath.Abs(filepath.Join(workspaceDir, raw))
	}
	return pathutil.ExpandHomePath(raw), nil
}

func expandShellPathAliases(roots pathroots.PathRoots, cmd string, isBoundary func(byte) bool) (string, error) {
	var err error
	cmd, err = replaceAliasTokenInCommand(cmd, "workspace_dir", strings.TrimSpace(roots.WorkspaceDir), isBoundary)
	if err != nil {
		return "", err
	}
	cmd, err = replaceAliasTokenInCommand(cmd, "file_cache_dir", strings.TrimSpace(roots.FileCacheDir), isBoundary)
	if err != nil {
		return "", err
	}
	cmd, err = replaceAliasTokenInCommand(cmd, "file_state_dir", strings.TrimSpace(roots.FileStateDir), isBoundary)
	if err != nil {
		return "", err
	}
	return cmd, nil
}

func formatShellObservation(payload shellExecutionPayload) string {
	var out strings.Builder
	fmt.Fprintf(&out, "exit_code: %d\n", payload.ExitCode)
	fmt.Fprintf(&out, "stdout_truncated: %t\n", payload.StdoutTruncated)
	fmt.Fprintf(&out, "stderr_truncated: %t\n", payload.StderrTruncated)
	out.WriteString("stdout:\n")
	out.WriteString(payload.Stdout)
	out.WriteString("\n\nstderr:\n")
	out.WriteString(payload.Stderr)
	return out.String()
}

// ShellResult is how a bash or powershell call ended and what it printed, read back from its
// observation (ParseShellObservation). Stdout and Stderr are as captured: StdoutTruncated and
// StderrTruncated report that the tool's output limit (max_output_bytes) cut the stream there.
type ShellResult struct {
	ExitCode        int
	Stdout          string
	Stderr          string
	StdoutTruncated bool
	StderrTruncated bool
}

// IsShellTool reports whether a tool is one whose observation ParseShellObservation reads.
func IsShellTool(name string) bool {
	switch strings.TrimSpace(name) {
	case "bash", "powershell":
		return true
	}
	return false
}

// ParseShellObservation reads a bash or powershell call's observation: the text
// formatShellObservation writes (and the elevation hint bash may add after it), or the result
// envelope of a command bash ran as a subtask. It reports false for anything else, such as a call
// refused before it ran or output a guard blocked.
func ParseShellObservation(observation string) (ShellResult, bool) {
	if payload, ok := parseShellSubtaskObservation(observation); ok {
		return shellResultFromPayload(payload), true
	}
	text := strings.TrimSuffix(observation, "\n\n"+sudoElevationHint)
	var payload shellExecutionPayload
	rest, ok := cutShellObservationLine(text, "exit_code: ", func(v string) (err error) {
		_, err = fmt.Sscanf(v, "%d", &payload.ExitCode)
		return err
	})
	if ok {
		rest, ok = cutShellObservationLine(rest, "stdout_truncated: ", func(v string) error {
			payload.StdoutTruncated = v == "true"
			return nil
		})
	}
	if ok {
		rest, ok = cutShellObservationLine(rest, "stderr_truncated: ", func(v string) error {
			payload.StderrTruncated = v == "true"
			return nil
		})
	}
	if !ok {
		return ShellResult{}, false
	}
	rest, ok = strings.CutPrefix(rest, "stdout:\n")
	if !ok {
		return ShellResult{}, false
	}
	// The stderr heading is the last one: what the command printed to stdout may hold the same
	// text, and stderr is the part people read for the cause.
	cut := strings.LastIndex(rest, "\n\nstderr:\n")
	if cut < 0 {
		return ShellResult{}, false
	}
	payload.Stdout = rest[:cut]
	payload.Stderr = rest[cut+len("\n\nstderr:\n"):]
	return shellResultFromPayload(payload), true
}

func cutShellObservationLine(text, prefix string, read func(string) error) (string, bool) {
	rest, ok := strings.CutPrefix(text, prefix)
	if !ok {
		return "", false
	}
	line, rest, ok := strings.Cut(rest, "\n")
	if !ok || read(strings.TrimSpace(line)) != nil {
		return "", false
	}
	return rest, true
}

func parseShellSubtaskObservation(observation string) (shellExecutionPayload, bool) {
	text := strings.TrimSpace(observation)
	if !strings.HasPrefix(text, "{") {
		return shellExecutionPayload{}, false
	}
	var envelope struct {
		OutputSchema string          `json:"output_schema"`
		Output       json.RawMessage `json:"output"`
	}
	if json.Unmarshal([]byte(text), &envelope) != nil || envelope.OutputSchema != "subtask.bash.result.v1" {
		return shellExecutionPayload{}, false
	}
	var payload struct {
		shellExecutionPayload
		ExitCode *int `json:"exit_code"`
	}
	if json.Unmarshal(envelope.Output, &payload) != nil || payload.ExitCode == nil {
		return shellExecutionPayload{}, false
	}
	payload.shellExecutionPayload.ExitCode = *payload.ExitCode
	return payload.shellExecutionPayload, true
}

func shellResultFromPayload(payload shellExecutionPayload) ShellResult {
	return ShellResult{
		ExitCode:        payload.ExitCode,
		Stdout:          payload.Stdout,
		Stderr:          payload.Stderr,
		StdoutTruncated: payload.StdoutTruncated,
		StderrTruncated: payload.StderrTruncated,
	}
}
