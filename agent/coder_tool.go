package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/quailyquaily/mistermorph/internal/coderterm"
	"github.com/quailyquaily/mistermorph/internal/coderusage"
	"github.com/quailyquaily/mistermorph/internal/pathroots"
	"github.com/quailyquaily/mistermorph/internal/pathutil"
	"github.com/quailyquaily/mistermorph/internal/shellenv"
)

const (
	coderToolName      = "coder"
	coderBackendCodex  = "codex"
	coderBackendClaude = "claude"
	// The Antigravity CLI, Google's terminal agent.
	coderBackendAgy = coderusage.BackendAgy
)

type coderTool struct {
	deps coderToolDeps
}

// CoderRequest describes one coding task. Command and Env are resolved for an injected terminal runner.
type CoderRequest struct {
	Backend string
	Task    string
	CWD     string
	// CoderEnv builds the CLI's environment and finds the CLI in it.
	CoderEnv shellenv.CoderEnv
	LogRoot  string
	// BypassApprovals asks a terminal session to run without approval prompts or sandbox.
	BypassApprovals bool
	Command         string
	Env             []string
	// Progress reports status lines. step is a short, content-free label for what the CLI
	// is doing now, such as "running a command", or "" when it has not changed.
	Progress func(summary, text, step string)
	// Process reports the OS PID of the CLI used for this task.
	Process func(pid int)
	// Report hears, once the CLI has ended, what the run used and the quota it reported (Claude
	// Code reports one; nil otherwise). A terminal session reports what its session files record.
	// A run that failed for lack of a sign-in says so in Run.NotSignedIn.
	Report func(run coderusage.Run, quota *coderusage.Quota)
}

func newCoderTool(deps coderToolDeps) *coderTool {
	return &coderTool{deps: deps}
}

func (t *coderTool) Name() string { return coderToolName }

func (t *coderTool) Description() string {
	claude := "Claude Code runs each task non-interactively with approvals bypassed."
	if t.deps.RunTerminal != nil {
		claude = "Claude Code keeps a terminal session for this conversation and working directory, and asks the user to approve actions when needed."
		if t.deps.BypassApprovals[coderBackendClaude] {
			claude = "Claude Code keeps a terminal session and runs actions without asking the user."
		}
	}
	return "Delegate a repository coding task to local Codex, Claude Code (cc), or Antigravity (agy) when the user explicitly asks for that CLI. Codex and agy keep sessions within this run or Console conversation; only Console sessions ask approvals and questions. " + claude + " Returns a SubtaskResult envelope. " + coderUsageNote
}

// coderUsageNote tells the model what the result's usage line is for.
const coderUsageNote = "Its usage field, when present, says what the run used and how much of that coder's subscription quota is left; " +
	"when a limit is reached or nearly used up, tell the user (and when it resets) rather than retrying."

func (t *coderTool) ParameterSchema() string {
	s := map[string]any{
		"type": "object",
		"properties": map[string]any{
			"coder": map[string]any{
				"type":        "string",
				"enum":        []string{coderBackendCodex, coderBackendClaude, coderBackendAgy},
				"description": "CLI backend to run: use codex for Codex CLI; use claude for Claude Code or cc; use agy for the Antigravity CLI (Google's agy).",
			},
			"task": map[string]any{
				"type":        "string",
				"description": "Self-contained task prompt for the coding CLI. Preserve requested filenames, constraints, and expected output.",
			},
			"cwd": map[string]any{
				"type":        "string",
				"description": "Optional working directory for the coding CLI. Supports workspace_dir, file_cache_dir, and file_state_dir aliases. Omit to use the current workspace.",
			},
		},
		"required": []string{"coder", "task"},
	}
	b, _ := json.MarshalIndent(s, "", "  ")
	return string(b)
}

// coderEnv is the environment builder of a run: the configured one, with the variables the
// registered shell tool injects into a command now (a task can add its own to the bash tool).
func (t *coderTool) coderEnv() shellenv.CoderEnv {
	env := t.deps.Env
	if t.deps.LookupTool == nil {
		return env
	}
	if tool, ok := t.deps.LookupTool(shellenv.CoderShellToolName()); ok {
		if source, ok := tool.(shellenv.InjectedEnvSource); ok {
			env = env.WithInjectedFrom(source)
		}
	}
	return env
}

func (t *coderTool) Execute(ctx context.Context, params map[string]any) (string, error) {
	req, err := coderRequestFromParams(ctx, params, t.deps.Roots)
	if err != nil {
		return "", err
	}
	req.CoderEnv = t.coderEnv()
	req.BypassApprovals = t.deps.BypassApprovals[req.Backend]
	req.LogRoot = pathroots.Resolve(ctx, t.deps.Roots).FileCacheDir

	runner := t.deps.Runner
	if runner == nil {
		return "", fmt.Errorf("subtask runner unavailable")
	}
	if req.Backend != coderBackendClaude && t.deps.RunSessions == nil {
		return "", fmt.Errorf("coder sessions unavailable")
	}

	result, err := runner.RunSubtask(ctx, SubtaskRequest{
		RunFunc: func(runCtx context.Context) (*SubtaskResult, error) {
			var run coderusage.Run
			var quota *coderusage.Quota
			req.Report = func(r coderusage.Run, q *coderusage.Quota) { run, quota = r, q }
			req.Process = func(pid int) { RecordWorkerProcess(runCtx, req.Backend, pid) }
			req.Progress = func(summary, text, step string) {
				EmitEvent(runCtx, nil, Event{
					Kind: EventKindToolOutput, ToolName: coderToolName, Stream: req.Backend,
					Text: text, Summary: summary, Progress: step, Status: "running",
				})
			}
			var output string
			var runErr error
			if req.Backend == coderBackendClaude && t.deps.RunTerminal == nil {
				runCLI := t.deps.RunCLI
				if runCLI == nil {
					runCLI = runCoderCLI
				}
				output, runErr = runCLI(runCtx, req, func(text string) {
					text = strings.TrimRight(text, "\x00")
					if text != "" {
						req.Progress("", text, "")
					}
				})
			} else {
				command, env, err := req.CoderEnv.Command(req.Backend)
				runErr = err
				if err == nil {
					req.Command, req.Env = command, env
					if req.Backend == coderBackendClaude {
						output, runErr = t.deps.RunTerminal(runCtx, req)
					} else {
						output, runErr = t.deps.RunSessions(runCtx, req)
					}
				}
				if output != "" {
					req.Progress("", strings.TrimRight(output, "\n")+"\n", "")
				}
			}

			usage := t.reportUsage(runCtx, req, run, quota)
			if runErr != nil {
				out := FailedSubtaskResult("", runErr)
				out.OutputKind = SubtaskOutputKindText
				out.Output = output
				out.Usage = usage
				return out, nil
			}
			return &SubtaskResult{
				Status:     SubtaskStatusDone,
				Summary:    summarizeSubtaskText(output),
				OutputKind: SubtaskOutputKindText,
				Output:     output,
				Usage:      usage,
			}, nil
		},
	})
	if err != nil {
		if result == nil {
			result = FailedSubtaskResult("", err)
		}
	}
	if result == nil {
		result = FailedSubtaskResult("", fmt.Errorf("coder subtask returned nil result"))
	}
	b, err := json.Marshal(result)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// reportUsage records what a run used and the coder's quota, and says both in a line for the
// result and the activity: Claude Code reports its quota during the run; Codex's is read from its
// app server and the Antigravity CLI's from its /usage after the run (no quota used). A quota that
// cannot be read is left out: nothing is made up, and the run's own outcome stands. It returns ""
// when there is nothing to say.
func (t *coderTool) reportUsage(ctx context.Context, req CoderRequest, run coderusage.Run, quota *coderusage.Quota) string {
	var recorder *coderusage.Recorder
	if t.deps.Usage != nil {
		recorder = t.deps.Usage()
	}
	run.Backend = req.Backend
	recorder.RecordRun(ctx, run)
	// A run that found no sign-in has no quota to read (and the read would meet the same prompt).
	if quota == nil && req.Backend == coderBackendAgy && t.deps.ReadAgyQuota != nil && !run.NotSignedIn {
		if read, err := t.deps.ReadAgyQuota(context.WithoutCancel(ctx), req.CoderEnv); err == nil {
			quota = &read
		}
	}
	if quota != nil {
		recorder.SaveQuota(ctx, *quota)
	}
	var parts []string
	if summary := run.Summary(); summary != "" {
		parts = append(parts, req.Backend+" run: "+summary)
	}
	if quota != nil {
		if note := quota.Note(time.Now()); note != "" {
			parts = append(parts, note)
		}
	}
	text := strings.Join(parts, "; ")
	if text != "" && req.Progress != nil {
		line := "[" + req.Backend + "] usage: " + text + "\n"
		req.Progress(line, line, "")
	}
	return text
}

// readAgyQuota reads the Antigravity CLI's quota from its /usage, finding agy as the coder tool does.
func readAgyQuota(ctx context.Context, coderEnv shellenv.CoderEnv) (coderusage.Quota, error) {
	command, env, err := coderEnv.Command(coderBackendAgy)
	if err != nil {
		return coderusage.Quota{}, err
	}
	return coderusage.ReadAgyQuota(ctx, command, env)
}

func coderRequestFromParams(ctx context.Context, params map[string]any, roots pathroots.PathRoots) (CoderRequest, error) {
	backend, _ := params["coder"].(string)
	backend = strings.ToLower(strings.TrimSpace(backend))
	if backend == "" {
		return CoderRequest{}, fmt.Errorf("missing required param: coder")
	}
	if backend != coderBackendCodex && backend != coderBackendClaude && backend != coderBackendAgy {
		return CoderRequest{}, fmt.Errorf("unsupported coder: %s", backend)
	}
	task, _ := params["task"].(string)
	task = strings.TrimSpace(task)
	if task == "" {
		return CoderRequest{}, fmt.Errorf("missing required param: task")
	}
	cwd, _ := params["cwd"].(string)
	resolvedCWD, err := resolveCoderCWD(ctx, roots, cwd)
	if err != nil {
		return CoderRequest{}, err
	}
	return CoderRequest{
		Backend: backend,
		Task:    task,
		CWD:     resolvedCWD,
	}, nil
}

func resolveCoderCWD(ctx context.Context, roots pathroots.PathRoots, raw string) (string, error) {
	roots = pathroots.Resolve(ctx, roots)
	cwd := strings.TrimSpace(raw)
	if cwd == "" {
		if workspaceDir := strings.TrimSpace(roots.WorkspaceDir); workspaceDir != "" {
			cwd = workspaceDir
		} else {
			cwd = "."
		}
	}
	cwd = pathutil.ExpandHomePath(cwd)
	alias, rest := detectCoderPathAlias(cwd)
	var abs string
	var err error
	if alias != "" {
		abs, err = resolveCoderAliasedCWD(roots, alias, rest)
	} else if filepath.IsAbs(cwd) {
		abs, err = filepath.Abs(filepath.Clean(cwd))
	} else if workspaceDir := strings.TrimSpace(roots.WorkspaceDir); workspaceDir != "" {
		abs, err = filepath.Abs(filepath.Join(pathutil.ExpandHomePath(workspaceDir), cwd))
	} else {
		abs, err = filepath.Abs(cwd)
	}
	if err != nil {
		return "", fmt.Errorf("resolve coder cwd: %w", err)
	}
	info, err := os.Stat(abs)
	if err != nil {
		return "", fmt.Errorf("resolve coder cwd: %w", err)
	}
	if !info.IsDir() {
		return "", fmt.Errorf("coder cwd %q is not a directory", abs)
	}
	return abs, nil
}

func detectCoderPathAlias(userPath string) (string, string) {
	trimmed := strings.TrimLeft(userPath, "/\\")
	lower := strings.ToLower(trimmed)
	prefixes := []struct {
		alias  string
		prefix string
	}{
		{alias: "workspace_dir", prefix: "workspace_dir/"},
		{alias: "workspace_dir", prefix: "workspace_dir\\"},
		{alias: "file_cache_dir", prefix: "file_cache_dir/"},
		{alias: "file_cache_dir", prefix: "file_cache_dir\\"},
		{alias: "file_state_dir", prefix: "file_state_dir/"},
		{alias: "file_state_dir", prefix: "file_state_dir\\"},
	}
	switch lower {
	case "workspace_dir", "file_cache_dir", "file_state_dir":
		return lower, ""
	}
	for _, item := range prefixes {
		if !strings.HasPrefix(lower, item.prefix) {
			continue
		}
		return item.alias, strings.TrimLeft(trimmed[len(item.prefix):], "/\\")
	}
	return "", userPath
}

func resolveCoderAliasedCWD(roots pathroots.PathRoots, alias string, rest string) (string, error) {
	base := strings.TrimSpace(roots.BaseDir(alias))
	if base == "" {
		return "", fmt.Errorf("base dir %s is not configured", alias)
	}
	baseAbs, err := filepath.Abs(pathutil.ExpandHomePath(base))
	if err != nil {
		return "", err
	}
	rest = strings.TrimLeft(strings.TrimSpace(rest), "/\\")
	if rest == "" {
		return baseAbs, nil
	}
	candidate := filepath.Join(baseAbs, rest)
	candAbs, err := filepath.Abs(candidate)
	if err != nil {
		return "", err
	}
	if !pathutil.IsWithinDir(baseAbs, candAbs) {
		return "", fmt.Errorf("refusing to access outside allowed base dir %s", alias)
	}
	return candAbs, nil
}

func firstNonEmptyString(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

type coderCLICommand struct {
	Command string
	Args    []string
	Stdin   string
	Dir     string
}

type coderCLIRunFunc func(ctx context.Context, req CoderRequest, emit func(string)) (string, error)

const (
	coderStderrTailBytes = 4 * 1024
	coderLineMaxBytes    = 4 * 1024 * 1024
	coderOutputMaxBytes  = 64 * 1024
	coderWaitDelay       = time.Second
	coderDiagnosticsKeep = 20
)

func buildCoderCLICommand(req CoderRequest) coderCLICommand {
	switch strings.TrimSpace(req.Backend) {
	case coderBackendClaude:
		return coderCLICommand{
			Command: "claude",
			// The task goes on stdin: as an argument, a task starting with "-" reads as an option.
			Args: []string{
				"-p",
				"--output-format",
				"stream-json",
				"--verbose",
				"--include-partial-messages",
				"--no-session-persistence",
				"--dangerously-skip-permissions",
			},
			Stdin: req.Task,
			Dir:   strings.TrimSpace(req.CWD),
		}
	default:
		return coderCLICommand{}
	}
}

func runCoderCLI(ctx context.Context, req CoderRequest, emit func(string)) (output string, runErr error) {
	started := time.Now()
	// stdout and stderr can both publish progress. Serialize the consumer.
	var emitMu sync.Mutex
	publish := func(text string) {
		emitMu.Lock()
		defer emitMu.Unlock()
		if emit != nil {
			emit(text)
		}
	}
	progress := func(summary, text, step string) {
		emitMu.Lock()
		defer emitMu.Unlock()
		if req.Progress != nil {
			req.Progress(summary, text, step)
		} else if emit != nil {
			emit(text)
		}
	}
	spec := buildCoderCLICommand(req)
	if strings.TrimSpace(spec.Command) == "" {
		return "", fmt.Errorf("unsupported coder: %s", req.Backend)
	}
	commandPath, env, err := req.CoderEnv.Command(spec.Command)
	if err != nil {
		return "", err
	}
	root := strings.TrimSpace(req.LogRoot)
	if root != "" {
		root, err = filepath.Abs(filepath.Join(root, "coder"))
		if err != nil {
			return "", err
		}
		if err := os.MkdirAll(root, 0o700); err != nil {
			return "", fmt.Errorf("create coder diagnostics directory: %w", err)
		}
		// The system temporary directory has its own cleanup; file_cache_dir does not.
		pruneCoderDiagnostics(root, coderDiagnosticsKeep-1)
	}
	diagnosticDir, err := os.MkdirTemp(root, req.Backend+"-")
	if err != nil {
		return "", fmt.Errorf("create coder diagnostics directory: %w", err)
	}
	stdoutLog, err := os.OpenFile(filepath.Join(diagnosticDir, "stdout.jsonl"), os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return "", err
	}
	defer stdoutLog.Close()
	stderrLog, err := os.OpenFile(filepath.Join(diagnosticDir, "stderr.log"), os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return "", err
	}
	defer stderrLog.Close()
	if req.Backend == coderBackendClaude {
		spec.Args = append(spec.Args, "--debug-file", filepath.Join(diagnosticDir, "debug.log"))
	}
	line := fmt.Sprintf("[%s] diagnostics: %s\n", req.Backend, diagnosticDir)
	progress(line, line, "")
	collector := newCoderStreamCollector(req.Backend, publish)
	collector.progress = progress
	var stderrTail coderTailBuffer
	stderrTail.Limit = coderStderrTailBytes
	defer func() {
		line := fmt.Sprintf("[%s] process ended after %s; diagnostics: %s\n", req.Backend, time.Since(started).Round(time.Millisecond), diagnosticDir)
		progress(line, line, "")
		if runErr == nil {
			return
		}
		detail := fmt.Sprintf("%s failed after %s", req.Backend, time.Since(started).Round(time.Millisecond))
		if collector.lastActivity != "" {
			detail += "; last activity: " + collector.lastActivity
		}
		if tail := strings.TrimSpace(stderrTail.String()); tail != "" {
			detail += "; stderr: " + tail
		}
		detail += "; diagnostics: " + diagnosticDir
		runErr = fmt.Errorf("%s: %w", detail, runErr)
	}()
	cmd := exec.CommandContext(ctx, commandPath, spec.Args...)
	configureCoderProcess(cmd)
	if env != nil {
		cmd.Env = env
	}
	if spec.Dir != "" {
		cmd.Dir = spec.Dir
	}
	if spec.Stdin != "" {
		cmd.Stdin = strings.NewReader(spec.Stdin)
	}
	// exec copies the output, so Wait returns once the CLI exits and WaitDelay passes,
	// even when a process the CLI left in the background still holds the pipes.
	stdoutLines := &coderLineWriter{handle: func(line []byte) { _ = collector.ConsumeLine(line) }}
	stderrLines := &coderLineWriter{handle: func(line []byte) {

		progress(fmt.Sprintf("[%s] stderr received\n", req.Backend), fmt.Sprintf("[%s stderr] %s\n", req.Backend, line), "")
	}}
	stdoutLines.overflow = func() {
		line := fmt.Sprintf("[%s] skipped an output line over %d bytes\n", req.Backend, coderLineMaxBytes)
		progress(line, line, "")
	}
	stderrLines.overflow = stdoutLines.overflow
	cmd.Stdout = io.MultiWriter(stdoutLog, stdoutLines)
	cmd.Stderr = io.MultiWriter(stderrLog, &stderrTail, stderrLines)
	cmd.WaitDelay = coderWaitDelay

	if err := cmd.Start(); err != nil {
		return "", err
	}

	if req.Process != nil {
		req.Process(cmd.Process.Pid)
	}
	remaining := ""
	if deadline, ok := ctx.Deadline(); ok {
		remaining = fmt.Sprintf("; remaining task time: %s", time.Until(deadline).Round(time.Second))
	}
	line = fmt.Sprintf("[%s] started pid=%d%s\n", req.Backend, cmd.Process.Pid, remaining)
	progress(line, line, "")

	waitErr := cmd.Wait()
	stdoutLines.Flush()
	stderrLines.Flush()
	if req.Report != nil {
		run := collector.Run()

		run.Backend = req.Backend
		run.DurationMs = time.Since(started).Milliseconds()
		req.Report(run, collector.quota)
	}
	output = capCoderOutput(collector.Output(), diagnosticDir)
	if errors.Is(waitErr, exec.ErrWaitDelay) && ctx.Err() == nil {
		line := fmt.Sprintf("[%s] exited; stopped reading output still held by a background process\n", req.Backend)
		progress(line, line, "")
		waitErr = nil
	}
	if waitErr != nil {
		if ctx.Err() != nil {
			return output, ctx.Err()
		}

		return output, coderExitError(req.Backend, waitErr)
	}
	if errText := collector.Error(); errText != "" {
		return output, fmt.Errorf("%s failed: %s", req.Backend, errText)
	}
	return output, nil
}

type coderLineWriter struct {
	handle   func(line []byte)
	overflow func()

	buf      []byte
	skipping bool
}

func (w *coderLineWriter) Write(p []byte) (int, error) {
	n := len(p)
	for len(p) > 0 {
		i := bytes.IndexByte(p, '\n')
		if i < 0 {
			if !w.skipping {
				w.buf = append(w.buf, p...)
				if len(w.buf) > coderLineMaxBytes {
					w.buf = nil
					w.skipping = true
					if w.overflow != nil {
						w.overflow()
					}
				}
			}
			break
		}
		if !w.skipping {
			w.buf = append(w.buf, p[:i]...)
			if len(w.buf) <= coderLineMaxBytes {
				w.handle(w.buf)
			} else if w.overflow != nil {
				w.overflow()
			}
		}
		w.buf = w.buf[:0]
		w.skipping = false
		p = p[i+1:]
	}
	return n, nil
}

// Flush hands over a final line that has no trailing newline.
func (w *coderLineWriter) Flush() {
	if len(w.buf) > 0 && !w.skipping {
		w.handle(w.buf)
	}
	w.buf = nil
	w.skipping = false
}

// capCoderOutput keeps the end of an oversized result, where the CLI's conclusion usually is.
func capCoderOutput(output string, diagnosticDir string) string {
	if len(output) <= coderOutputMaxBytes {
		return output
	}
	start := len(output) - coderOutputMaxBytes
	for start < len(output) && !utf8.RuneStart(output[start]) {
		start++
	}
	return fmt.Sprintf("[%d bytes omitted; the full stream is in %s]\n", start, filepath.Join(diagnosticDir, "stdout.jsonl")) + output[start:]
}

// pruneCoderDiagnostics removes the oldest codex-*, claude-* and agy-* directories under root
// until at most keep remain.
func pruneCoderDiagnostics(root string, keep int) {
	entries, err := os.ReadDir(root)
	if err != nil {
		return
	}
	type diagDir struct {
		path    string
		modTime time.Time
	}
	var dirs []diagDir
	for _, entry := range entries {
		name := entry.Name()
		if !entry.IsDir() || !(strings.HasPrefix(name, coderBackendCodex+"-") || strings.HasPrefix(name, coderBackendClaude+"-") || strings.HasPrefix(name, coderBackendAgy+"-")) {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		dirs = append(dirs, diagDir{path: filepath.Join(root, name), modTime: info.ModTime()})
	}
	if len(dirs) <= keep {
		return
	}
	sort.Slice(dirs, func(i, j int) bool { return dirs[i].modTime.Before(dirs[j].modTime) })
	for _, dir := range dirs[:len(dirs)-keep] {
		_ = os.RemoveAll(dir.path)
	}
}

func coderExitError(backend string, err error) error {
	var exitErr *exec.ExitError
	if !errors.As(err, &exitErr) {
		return fmt.Errorf("%s: %w", backend, err)
	}
	return fmt.Errorf("%s exited with code %d", backend, exitErr.ExitCode())
}

type coderStreamCollector struct {
	backend                            string
	emit                               func(string)
	progress                           func(summary, text, step string)
	emitted                            strings.Builder
	final, errText, lastActivity, step string
	run                                coderusage.Run
	quota                              *coderusage.Quota
}

func (c *coderStreamCollector) Run() coderusage.Run { return c.run }
func newCoderStreamCollector(backend string, emit func(string)) *coderStreamCollector {
	return &coderStreamCollector{backend: backend, emit: emit}
}

func (c *coderStreamCollector) ConsumeLine(line []byte) error {
	if c == nil {
		return nil
	}
	line = bytes.TrimSpace(line)
	if len(line) == 0 {
		return nil
	}
	var payload map[string]any
	if err := json.Unmarshal(line, &payload); err != nil {

		c.addDelta(string(line) + "\n")
		return nil
	}
	c.consumeClaude(payload)
	return nil
}

func (c *coderStreamCollector) Output() string {
	if c == nil {
		return ""
	}
	if text := strings.TrimSpace(c.final); text != "" {
		return text
	}
	return strings.TrimSpace(c.emitted.String())
}

func (c *coderStreamCollector) Error() string {
	if c == nil {
		return ""
	}
	return strings.TrimSpace(c.errText)
}

func (c *coderStreamCollector) addDelta(text string) {
	if c == nil || text == "" {
		return
	}
	c.emitted.WriteString(text)
	if c.emit != nil {
		c.emit(text)
	}
}

func (c *coderStreamCollector) setAssistantText(text string) {
	text = strings.TrimSpace(text)
	if text == "" {
		return
	}
	emitted := c.emitted.String()
	if strings.HasPrefix(text, emitted) {
		c.addDelta(strings.TrimPrefix(text, emitted))
	} else if emitted == "" {
		c.addDelta(text)
	} else if !strings.Contains(emitted, text) {
		c.addDelta("\n" + text)
	}
	c.final = text
}

func (c *coderStreamCollector) consumeClaude(payload map[string]any) {
	switch strings.TrimSpace(stringField(payload, "type")) {
	case "system":
		if stringField(payload, "subtype") == "thinking_tokens" {
			return
		}
		if stringField(payload, "subtype") == "init" {
			c.step = coderStepStarting
		} else if stringField(payload, "status") == "requesting" {
			c.step = coderStepThinking
		}
		c.emitActivity("[claude] " + stringField(payload, "subtype") + " " + stringField(payload, "status"))
	case "tool_progress":
		c.step = claudeToolStep(stringField(payload, "tool_name"))
		c.emitActivity(fmt.Sprintf("[claude] %s (%s), elapsed %vs", stringField(payload, "tool_name"), stringField(payload, "tool_use_id"), payload["elapsed_time_seconds"]))
	case "stream_event":
		if event, ok := mapField(payload, "event"); ok {
			if block, ok := mapField(event, "content_block"); ok {
				switch stringField(block, "type") {
				case "tool_use":
					c.step = claudeToolStep(stringField(block, "name"))
					c.emitActivity("[claude] starting " + stringField(block, "name") + " (" + stringField(block, "id") + ")")
				case "thinking":
					c.step = coderStepThinking
					c.emitActivity("[claude] thinking")
				}
			}
		}
		if text := claudeStreamDelta(payload["event"]); text != "" {
			c.addDelta(text)
		}
	case "assistant", "user":
		if message, ok := mapField(payload, "message"); ok {
			blocks, _ := message["content"].([]any)
			for _, value := range blocks {
				block, ok := value.(map[string]any)
				if !ok {
					continue
				}
				switch stringField(block, "type") {
				case "tool_use":
					c.step = claudeToolStep(stringField(block, "name"))
					input, _ := json.Marshal(block["input"])
					c.emitActivity(fmt.Sprintf("[claude] %s (%s)", stringField(block, "name"), stringField(block, "id")), string(input))
				case "tool_result":
					status := "completed"
					if boolField(block, "is_error") {
						status = "failed"
					}
					c.step = coderStepThinking
					c.emitActivity(fmt.Sprintf("[claude] %s %s", stringField(block, "tool_use_id"), status), textFromValue(block["content"]))
				}
			}
		}
		if text := textFromValue(payload["message"]); stringField(payload, "type") == "assistant" && text != "" {
			c.setAssistantText(text)
		}
	case "rate_limit_event":
		if info, ok := mapField(payload, "rate_limit_info"); ok {
			if quota, ok := coderusage.ParseClaudeRateLimit(info, time.Now()); ok {
				c.quota = &quota
			}
		}
	case "result":
		if models, turns, ok := coderusage.ClaudeResultUsage(payload); ok {
			c.run.Models, c.run.Turns = models, turns
		}
		if text := stringField(payload, "result"); text != "" {
			c.final = text
		}
		if boolField(payload, "is_error") {
			c.errText = firstNonEmptyString(stringField(payload, "result"), stringField(payload, "error"))
			if c.errText == "" {
				errorsJSON, _ := json.Marshal(payload["errors"])
				c.errText = stringField(payload, "subtype") + ": " + string(errorsJSON)
			}
		}
	}
}

func (c *coderStreamCollector) emitActivity(summary string, details ...string) {
	// Keep progress separate from the assistant's answer and bound UI previews.
	text := summary
	if len(details) > 0 {
		text += " " + strings.Join(details, " ")
	}
	runes := []rune(strings.TrimSpace(text))
	if len(runes) > 1000 {
		runes = append(runes[:1000], []rune("…")...)
	}
	c.lastActivity = strings.TrimSpace(summary)
	if c.progress != nil {
		c.progress("\n"+c.lastActivity+"\n", "\n"+string(runes)+"\n", c.step)
	} else if c.emit != nil {
		c.emit("\n" + string(runes) + "\n")
	}
}

func claudeStreamDelta(value any) string {
	event, ok := value.(map[string]any)
	if !ok {
		return ""
	}
	if delta, ok := mapField(event, "delta"); ok {
		if text := stringField(delta, "text"); text != "" {
			return text
		}
	}
	return ""
}

func claudeToolStep(name string) string {
	switch name {
	case "":
		return ""
	case "Bash", "BashOutput", "KillShell":
		return coderStepCommand
	case "Edit", "MultiEdit", "Write", "NotebookEdit":
		return coderStepEdit
	case "Read", "Glob", "Grep", "LS":
		return coderStepRead
	case "WebFetch", "WebSearch":
		return coderStepWeb
	case "TodoWrite":
		return coderStepPlan
	case "Task", "Agent":
		return coderStepSubagent
	}
	if strings.HasPrefix(name, "mcp__") {
		return coderStepTool
	}
	return "using " + name
}

func textFromValue(value any) string {
	switch v := value.(type) {
	case string:
		return v
	case []any:
		var b strings.Builder
		for _, item := range v {
			b.WriteString(textFromValue(item))
		}
		return b.String()
	case map[string]any:
		if text := firstNonEmptyString(stringField(v, "text"), stringField(v, "output_text")); text != "" {
			return text
		}
		if content, ok := v["content"]; ok {
			return textFromValue(content)
		}
		if message, ok := v["message"]; ok {
			return textFromValue(message)
		}
	}
	return ""
}

func mapField(m map[string]any, key string) (map[string]any, bool) {
	value, ok := m[key]
	if !ok {
		return nil, false
	}
	out, ok := value.(map[string]any)
	return out, ok
}

func stringField(m map[string]any, key string) string {
	value, ok := m[key]
	if !ok {
		return ""
	}
	s, ok := value.(string)
	if !ok {
		return ""
	}
	return strings.TrimSpace(s)
}

func boolField(m map[string]any, key string) bool {
	value, ok := m[key]
	if !ok {
		return false
	}
	b, ok := value.(bool)
	return ok && b
}

type coderTailBuffer struct {
	Limit int
	buf   []byte
}

func (b *coderTailBuffer) Write(p []byte) (int, error) {
	if b == nil {
		return len(p), nil
	}
	b.buf = append(b.buf, p...)
	if b.Limit > 0 && len(b.buf) > b.Limit {
		b.buf = append([]byte(nil), b.buf[len(b.buf)-b.Limit:]...)
	}
	return len(p), nil
}

// Reset drops what was kept.
func (b *coderTailBuffer) Reset() {
	if b != nil {
		b.buf = nil
	}
}

func (b *coderTailBuffer) String() string {
	if b == nil {
		return ""
	}
	return string(bytes.ToValidUTF8(b.buf, []byte("\n[non-utf8 output]\n")))
}

const (
	coderStepStarting = "starting up"
	coderStepThinking = "thinking"
	coderStepCommand  = "running a command"
	coderStepEdit     = "editing files"
	coderStepRead     = "reading code"
	coderStepWeb      = "searching the web"
	coderStepTool     = "calling a tool"
	coderStepPlan     = "planning"
	coderStepSubagent = "running a subagent"
)

func CoderModelsFromSessionUsage(usage coderterm.Usage) []coderusage.ModelUsage {
	var models []coderusage.ModelUsage
	for _, m := range usage.Models {
		model := coderusage.ModelUsage{
			Model:                    m.Model,
			InputTokens:              m.InputTokens,
			CachedInputTokens:        m.CachedInputTokens,
			CacheCreationInputTokens: m.CacheCreationInputTokens,
			OutputTokens:             m.OutputTokens,
			ReasoningTokens:          m.ReasoningTokens,
			CacheDetails:             m.CacheCreation,
		}
		for _, response := range m.Responses {
			model.Requests = append(model.Requests, coderusage.RequestUsage{
				InputTokens:              response.InputTokens,
				CachedInputTokens:        response.CachedInputTokens,
				CacheCreationInputTokens: response.CacheCreationInputTokens,
				OutputTokens:             response.OutputTokens,
				CacheDetails:             response.CacheCreation,
				Count:                    response.Count,
			})
		}
		models = append(models, model)
	}
	return models
}
